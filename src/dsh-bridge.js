// DSH 桥：把 QQ 里的 “/dsh <任务>” 命令交给本机 DeepSeek Harness 的 headless 一次性任务执行，
// 再把最终答案原样发回 QQ。
//
// 设计要点（都与本机实测事实绑定，改动前先读）：
//   1. **不经大模型**：命中前缀的消息不进 orchestrator 的触发判定，所以不花 QQ Agent 的
//      模型额度、也不受"响应档位/概率"影响。这是与"写个 skill 工具"最关键的区别。
//   2. **不 spawn dsh.cmd**：Node 拒绝 spawn `.cmd`（EINVAL），而且 dsh 不在 PATH 上。
//      这里照抄 dsh.cmd 的做法：用 ELECTRON_RUN_AS_NODE=1 直接拉起 DeepSeek Harness.exe，
//      后面跟 app.asar 里的 cli.js。
//   3. **必须带 --patch overlay**：headless profile 默认模型路由是 deepseek-official
//      （要 DEEPSEEK_API_KEY），换成 deepseek-account 才吃本机已登录的账号。
//   4. **--json** 事件流：session（拿到会话 id，用于下次续跑）/ tool_call（进度）/
//      final（最终答案）。
//   5. **会话延续**：`--session-id` 会校验记录的工作目录，目录变了或会话不存在时会失败，
//      所以失败且本轮没有答案时，清掉记录用新会话重试一次。
//
// 本模块只做"跑 + 回发"，不认识 QQ 的消息结构；触发与鉴权在 app.js 的 ingest 里。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR, ROOT } from './config.js';

/** 本机 DeepSeek Harness 的默认入口（可用 config.dsh.exePath 覆盖）。 */
const DEFAULT_EXE = 'C:\\Users\\noapi\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe';
/** 与 exe 同级的 asar 内 CLI 入口（dsh.cmd 里那一行是唯一样本）。 */
const CLI_REL = ['resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'];
const DEFAULT_PREFIX = '/dsh';
const STATE_BASENAME = 'dsh-sessions.json';
const STDERR_TAIL_CHARS = 1500;

/** 会话记录落盘路径（放在 DATA_DIR 下，跟随 PROFILE / QQ_AGENT_DATA_DIR）。 */
function stateFile() {
  return path.join(DATA_DIR, STATE_BASENAME);
}

function loadState() {
  try {
    const raw = fs.readFileSync(stateFile(), 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveState(state) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(stateFile(), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch (error) {
    // 存不下会话 id 只影响"下次能否续跑"，不该影响本轮任务
    console.warn('[dsh] 会话记录写入失败:', error?.message ?? error);
  }
}

/**
 * 去掉消息开头的 @ 段：群里下命令通常是「@机器人 /dsh 跑测试」，
 * segmentsToText 会把 @ 渲染成文本，前缀匹配前必须剥掉。
 */
function stripLeadingAt(text) {
  let out = String(text ?? '').trim();
  for (let i = 0; i < 2; i++) {
    const next = out.replace(/^(?:\[@[^\]\n]{0,64}\]|@[^\s]{1,64})\s*/u, '');
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * 解析 `/dsh` 命令。
 * @returns {null | { kind: 'run'|'new'|'stop'|'status'|'help', task: string }}
 */
export function parseDshCommand(text, prefix = DEFAULT_PREFIX) {
  const p = String(prefix || DEFAULT_PREFIX).trim() || DEFAULT_PREFIX;
  const body = stripLeadingAt(text);
  if (!body.toLowerCase().startsWith(p.toLowerCase())) return null;
  const after = body.slice(p.length);
  // 前缀必须成词：`/dshx` 不算
  if (after && !/^\s/.test(after)) return null;
  const rest = after.trim();
  if (!rest) return { kind: 'help', task: '' };
  if (/^(帮助|help|命令|用法)$/i.test(rest)) return { kind: 'help', task: '' };
  if (/^(状态|status)$/i.test(rest)) return { kind: 'status', task: '' };
  if (/^(停|停止|取消|stop|abort|cancel)$/i.test(rest)) return { kind: 'stop', task: '' };
  const fresh = rest.match(/^(?:新会话|new)\b\s*([\s\S]*)$/i);
  if (fresh) return { kind: 'new', task: fresh[1].trim() };
  return { kind: 'run', task: rest };
}

function helpText(prefix) {
  return [
    `【DSH 桥】把任务交给本机 DeepSeek Harness 执行`,
    `${prefix} <任务>       在当前会话里执行（会记住上下文，可连续追问）`,
    `${prefix} 新会话 <任务>  丢掉上下文，开一条新会话`,
    `${prefix} 状态         看当前会话 id / 是否在跑`,
    `${prefix} 停           终止正在跑的任务`,
    `${prefix} 帮助         这条说明`
  ].join('\n');
}

/** 取一条 tool_call 事件里可读的工具名（字段名不确定，逐个兜底）。 */
function toolNameOf(event) {
  const candidates = [event?.name, event?.toolName, event?.tool, event?.call?.name, event?.data?.name];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return '工具';
}

export function createDshBridge({ getConfig, sender, log = console.log, emit = () => {} }) {
  /** chatKey -> { child, startedAt, task, progressSent, lastProgressAt, aborted } */
  const running = new Map();

  const readCfg = () => {
    const c = getConfig()?.dsh;
    return c && typeof c === 'object' ? c : {};
  };

  function resolvePaths() {
    const c = readCfg();
    const exe = String(c.exePath || '').trim() || DEFAULT_EXE;
    return {
      exe,
      cli: path.join(path.dirname(exe), ...CLI_REL),
      overlay: String(c.overlayPath || '').trim() || path.join(ROOT, 'dsh-model-overlay.yml'),
      cwd: String(c.workdir || '').trim() || ROOT
    };
  }

  async function reply(chatKey, text, replyToMessageId = null) {
    try {
      // skipDedupe：命令通道的两次任务完全可能给出同一句话（都回 "OK"），
      // 不能被"防模型复读"的 8 秒去重窗口吞掉 —— 那是静默丢消息。
      await sender.sendTextBatch(chatKey, [String(text ?? '')], { replyToMessageId, skipDedupe: true });
      emit('chat-update', chatKey);
    } catch (error) {
      log(`[dsh] 回发失败：${error?.message ?? error}`);
    }
  }

  /** Windows 上 child.kill() 杀不掉子进程树，任务超时必须整棵树带走。 */
  function killTree(pid) {
    if (!pid) return;
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => {});
      killer.unref?.();
    } catch {
      /* 退化成只杀父进程也比重试好 */
    }
  }

  /**
   * 跑一次 headless。返回 { sessionId, answer, code, stderr, killed, spawnError }。
   * 这里刻意不抛错：调用方要么回发答案、要么回发失败原因，不允许静默丢弃。
   */
  function runOnce({ chatKey, task, sessionId, onProgress }) {
    const c = readCfg();
    const { exe, cli, overlay, cwd } = resolvePaths();
    const timeoutMs = Math.max(10_000, Number(c.timeoutMs) || 900_000);

    return new Promise((resolve) => {
      if (!fs.existsSync(exe)) {
        resolve({ spawnError: `找不到 DSH 入口：${exe}（改 config.dsh.exePath）` });
        return;
      }
      // ⚠️ 不要在这里断言 cli.js 存在：它在 app.asar **归档内部**，
      // 只有 Electron 的 Node（asar 补丁过的 fs）才看得见；QQ Agent 跑在普通 Node 下，
      // existsSync 必然返回 false。真实存在性交给子进程去证伪（它的 stderr 会说明）。
      if (!fs.existsSync(cli)) {
        log(`[dsh] 提示：${cli} 在普通 Node 下看不到（asar 内部），交给子进程执行`);
      }
      if (!fs.existsSync(overlay)) {
        resolve({ spawnError: `找不到模型 overlay：${overlay}（见仓库根 dsh-model-overlay.yml）` });
        return;
      }

      const args = ['--expose-internals', cli, 'headless', '--patch', overlay, '--json'];
      if (sessionId) args.push('--session-id', String(sessionId));
      const extra = Array.isArray(c.extraArgs) ? c.extraArgs.map(String) : [];
      args.push(...extra, String(task));

      let child;
      try {
        const permissionMode = String(c.permissionMode || '').trim();
        child = spawn(exe, args, {
          cwd,
          // ELECTRON_RUN_AS_NODE 必须显式给：这个变量只保证在 dsh.cmd 里存在，
          // 从别处拉起时不能依赖环境里恰好有它。
          // DSH_PERMISSION_MODE 只在显式配置时才传：默认让 DSH 用自己的
          // workspace-write + ask（headless 无应答者 → 需要审批的操作失败关闭）。
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            ...(permissionMode ? { DSH_PERMISSION_MODE: permissionMode } : {})
          },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (error) {
        resolve({ spawnError: `拉起 DSH 失败：${error?.message ?? error}` });
        return;
      }

      const rec = { child, startedAt: Date.now(), task, progressSent: 0, lastProgressAt: 0, aborted: false };
      running.set(chatKey, rec);

      let answer = null;
      let lastSessionId = sessionId ? String(sessionId) : null;
      let stderr = '';
      let stdoutBuf = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid);
      }, timeoutMs);
      timer.unref?.();

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdoutBuf += chunk;
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() ?? '';
        for (const line of lines) {
          const s = line.trim();
          if (!s) continue;
          let ev;
          try { ev = JSON.parse(s); } catch { continue; }
          if (ev?.type === 'session' && ev.sessionId) lastSessionId = String(ev.sessionId);
          else if (ev?.type === 'final' && typeof ev.text === 'string') answer = ev.text;
          else if (ev?.type === 'error') {
            const msg = typeof ev.message === 'string' ? ev.message : JSON.stringify(ev);
            stderr += `\n${msg}`;
          } else if (ev?.type === 'tool_call' && typeof onProgress === 'function') {
            onProgress(toolNameOf(ev));
          }
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        if (stderr.length > STDERR_TAIL_CHARS * 4) stderr = stderr.slice(-STDERR_TAIL_CHARS * 2);
      });

      const finish = (code, spawnError) => {
        clearTimeout(timer);
        // 只有还是自己那次记录时才删，避免"重试的新进程"被旧进程的 close 清掉
        if (running.get(chatKey) === rec) running.delete(chatKey);
        resolve({
          sessionId: lastSessionId,
          answer,
          code,
          stderr: stderr.slice(-STDERR_TAIL_CHARS).trim(),
          killed: rec.aborted,
          timedOut,
          spawnError
        });
      };

      child.on('error', (error) => finish(null, `DSH 进程错误：${error?.message ?? error}`));
      child.on('close', (code) => finish(code));
    });
  }

  /** 进度提示：只在私聊（默认）或全部会话里发，且限频、限量。 */
  function maybeProgress(chatKey, kind, toolName) {
    const c = readCfg();
    const mode = String(c.showProgress || 'private');
    if (mode === 'off') return;
    if (mode === 'private' && kind !== 'private') return;
    const rec = running.get(chatKey);
    if (!rec) return;
    const max = Math.max(0, Number(c.maxProgress) || 6);
    if (rec.progressSent >= max) return;
    const gap = Math.max(0, Number(c.progressMinGapMs) || 8000);
    const now = Date.now();
    if (now - rec.lastProgressAt < gap) return;
    rec.lastProgressAt = now;
    rec.progressSent += 1;
    void reply(chatKey, `… 正在执行：${toolName}`);
  }

  function sessionKeyFor(chatKey) {
    const mode = String(readCfg().sessionMode || 'per-chat');
    if (mode === 'none') return null;
    return mode === 'global' ? '__global__' : chatKey;
  }

  /** 处理一条消息。返回 true = 这条消息被桥认领（调用方不要再交给编排器）。 */
  function handle(chatKey, entry = null) {
    const c = readCfg();
    if (c.enabled !== true) return false;
    const parsed = parseDshCommand(entry?.text, String(c.prefix || DEFAULT_PREFIX));
    if (!parsed) return false;

    const kind = String(chatKey).split(':')[0];
    const senderId = String(entry?.senderId ?? '');
    const replyTo = entry?.mid ?? null;

    (async () => {
      try {
        const allow = Array.isArray(c.allowedSenderIds) ? c.allowedSenderIds.map(String) : [];
        if (!allow.length) {
          await reply(chatKey, '⛔ DSH 桥已启用，但 config.dsh.allowedSenderIds 是空的 —— 先在里面填上允许下指令的 QQ 号。', replyTo);
          return;
        }
        if (!allow.includes(senderId)) {
          await reply(chatKey, '⛔ 你没有在 DSH 桥的白名单里。', replyTo);
          return;
        }

        if (parsed.kind === 'help') {
          await reply(chatKey, helpText(String(c.prefix || DEFAULT_PREFIX)), replyTo);
          return;
        }

        const skey = sessionKeyFor(chatKey);
        const state = skey ? loadState() : {};
        const record = skey ? (state[skey] || {}) : {};

        if (parsed.kind === 'status') {
          const busy = running.has(chatKey);
          await reply(chatKey, [
            `DSH 桥：${busy ? '有任务在跑' : '空闲'}`,
            `会话：${record.sessionId || '(还没建)'}`,
            `目录：${resolvePaths().cwd}`,
            `上次：${record.updatedAt ? new Date(record.updatedAt).toLocaleString() : '(无)'}`
          ].join('\n'), replyTo);
          return;
        }

        if (parsed.kind === 'stop') {
          const rec = running.get(chatKey);
          if (!rec) {
            await reply(chatKey, '当前没有在跑的任务。', replyTo);
            return;
          }
          rec.aborted = true;
          killTree(rec.child?.pid);
          await reply(chatKey, '⏹ 已终止。', replyTo);
          return;
        }

        const maxConcurrent = Math.max(1, Number(c.maxConcurrent) || 1);
        if (running.has(chatKey)) {
          await reply(chatKey, `⚠️ 这个会话上一条任务还在跑，等它结束或发「${String(c.prefix || DEFAULT_PREFIX)} 停」。`, replyTo);
          return;
        }
        if (running.size >= maxConcurrent) {
          await reply(chatKey, '⚠️ 同时执行的 DSH 任务已达上限，稍后再试。', replyTo);
          return;
        }

        const task = parsed.task;
        if (!task) {
          await reply(chatKey, helpText(String(c.prefix || DEFAULT_PREFIX)), replyTo);
          return;
        }

        const startedAt = Date.now();
        await reply(chatKey, `⏳ 已交给 DSH：${task.length > 60 ? `${task.slice(0, 60)}…` : task}`, replyTo);

        let sessionId = parsed.kind === 'new' ? null : (record.sessionId || null);
        const onProgress = (toolName) => maybeProgress(chatKey, kind, toolName);
        let result = await runOnce({ chatKey, task, sessionId, onProgress });

        // 会话续接失败（会话不存在 / 记录的目录和现在不一致）→ 清记录、开新会话重试一次
        const failed = result.spawnError || result.killed || result.timedOut || result.code !== 0 || !result.answer;
        if (failed && sessionId && !result.killed && !result.timedOut) {
          log(`[dsh] 续接会话失败（${result.code}），改用新会话重试一次`);
          if (skey) {
            delete state[skey];
            saveState(state);
          }
          sessionId = null;
          result = await runOnce({ chatKey, task, sessionId, onProgress });
        }

        if (skey && result.sessionId) {
          state[skey] = { sessionId: result.sessionId, updatedAt: Date.now(), cwd: resolvePaths().cwd };
          saveState(state);
        }

        const took = ((Date.now() - startedAt) / 1000).toFixed(1);
        if (result.killed) {
          await reply(chatKey, `⏹ 任务已终止（${took}s）。`);
          return;
        }
        if (result.timedOut) {
          await reply(chatKey, `⏱ 任务超时（${took}s）已被终止。可调大 config.dsh.timeoutMs。`);
          return;
        }
        if (result.spawnError) {
          await reply(chatKey, `❌ ${result.spawnError}`);
          return;
        }
        if (typeof result.answer === 'string' && result.answer.trim()) {
          const max = Number(c.maxReplyChars) || 0;
          const text = max > 0 && result.answer.length > max
            ? `${result.answer.slice(0, max)}\n…（已截断，共 ${result.answer.length} 字）`
            : result.answer;
          await reply(chatKey, `${String(c.replyPrefix || '')}${text}`);
          return;
        }
        const tail = result.stderr ? `\n${result.stderr.slice(-400)}` : '';
        await reply(chatKey, `❌ DSH 没给出答案（退出码 ${result.code}，${took}s）。${tail}`);
      } catch (error) {
        log(`[dsh] 处理命令出错：${error?.message ?? error}`);
        await reply(chatKey, `❌ DSH 桥内部错误：${error?.message ?? error}`);
      }
    })();

    return true;
  }

  function abortAll() {
    for (const [chatKey, rec] of running) {
      rec.aborted = true;
      killTree(rec.child?.pid);
      log(`[dsh] 退出中，终止 ${chatKey} 的任务`);
    }
    running.clear();
  }

  return { handle, abortAll, parseDshCommand };
}
