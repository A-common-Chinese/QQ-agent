// 通用 Agent 桥（P1）：把「/<prefix> <任务>」交给本机任意支持"一次性调用"的 agent CLI。
//
// 为什么不改造 dsh-bridge.js：
//   dsh-bridge.js 里 708 行有近一半是 DSH 私有（exe 路径 / asar 内 cli.js / overlay /
//   `--json` 事件名 / `__dsh-qq` 会话接口）。把它拆成 core + adapter 要同时改 6 个调用点，
//   而 P1 的目标是"先让第二个 agent 接通"。所以这里做成**平行模块**：/dsh 一行不动 = 零回归。
//   P2 再把两边共用的壳（白名单 / 隐私闸门 / 超时 / 回发）抽到 bridge-core.js。
//
// 一个适配器要满足的三件事（也就是本模块的契约）：
//   1. 一条命令 + 参数就能跑完一个任务（codex exec / claude -p / gemini -p …）
//   2. 最终答案拿得到：落文件（-o）、JSONL 事件、或 stdout 尾巴
//   3. 可选：能按 session id 续跑；不能续就把 resume 设成 none
//
// 安全默认（与 dsh 桥一致，别改松）：
//   · allowedSenderIds 为空 = 谁都不响应
//   · 群聊必须 @ 本机器人才认领（requireMentionInGroup）
//   · 回发前统一过隐私闸门（src/privacy.js），密钥类直接拒发
//   · 任务正文默认走 stdin（taskVia='stdin'），不进 argv → 不会被当成命令行注入
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { getPrivacyFilter, privacyBlockedReply } from './privacy.js';
import { DATA_DIR, ROOT } from './config.js';

const STATE_BASENAME = 'agent-bridges.json';
const STDOUT_CAP = 2 * 1024 * 1024;   // 事件流上限，防止异常进程把内存吃爆
const STDERR_TAIL = 1500;
const DEFAULT_PREFIX = '/agent';

/** 会话 id 探测：兼容 codex 的 thread_id、其它 CLI 的 session_id / sessionId */
const SESSION_ID_RE = /"(?:thread_id|session_id|sessionId)"\s*:\s*"([0-9A-Za-z_-]{6,})"/;

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
    // 存不下会话 id 只影响"下次能不能续跑"，不影响本轮
    console.warn('[bridge] 会话记录写入失败:', error?.message ?? error);
  }
}

/**
 * 去掉消息开头的 @ 段。群里下命令通常是「@机器人 /codex 跑测试」，
 * segmentsToText 会把 @ 渲染成文本，前缀匹配前必须剥掉。
 * （与 dsh-bridge 同一套规则，刻意保持行为一致）
 */
function stripLeadingAt(text) {
  let out = String(text ?? '').trim();
  for (let i = 0; i < 2; i += 1) {
    const next = out.replace(/^(?:\[@[^\]\n]{0,64}\]|@[^\s]{1,64})\s*/u, '');
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * 解析「/prefix 子命令」。纯函数，便于离线测试。
 * @returns {null | {kind:'run'|'new'|'stop'|'status'|'help', task:string}}
 */
export function parseAgentCommand(text, prefix = DEFAULT_PREFIX) {
  const p = String(prefix || DEFAULT_PREFIX).trim() || DEFAULT_PREFIX;
  const body = stripLeadingAt(text);
  if (!body.toLowerCase().startsWith(p.toLowerCase())) return null;
  const after = body.slice(p.length);
  // 前缀必须成词：`/codexx` 不算
  if (after && !/^\s/.test(after)) return null;
  const rest = after.trim();
  if (!rest) return { kind: 'help', task: '' };
  if (/^(帮助|help|命令|用法)$/i.test(rest)) return { kind: 'help', task: '' };
  if (/^(状态|status)$/i.test(rest)) return { kind: 'status', task: '' };
  if (/^(停|停止|取消|stop|abort|cancel)$/i.test(rest)) return { kind: 'stop', task: '' };
  const fresh = /^(?:新|新会话|new|reset)(?:\s+([\s\S]*))?$/i.exec(rest);
  if (fresh) return { kind: 'new', task: (fresh[1] || '').trim() };
  return { kind: 'run', task: rest };
}

/**
 * 参数模板替换。占位符：
 *   {task} 任务正文（taskVia='arg' 时才用）
 *   {out}  最终答案要写入的临时文件
 *   {session} 续跑时替换成会话 id；resume='last' 时替换成 --last
 *   {cwd}  工作目录
 * 返回新数组，不改原模板。
 */
export function buildArgs(template, vars = {}) {
  const list = Array.isArray(template) ? template : [];
  return list.map((raw) => String(raw)
    .replace(/\{task\}/g, String(vars.task ?? ''))
    .replace(/\{out\}/g, String(vars.out ?? ''))
    .replace(/\{session\}/g, String(vars.session ?? ''))
    .replace(/\{cwd\}/g, String(vars.cwd ?? '')));
}

/** 从一行 JSONL 里抠会话 id（codex 的 thread.started 事件带 thread_id） */
export function extractSessionId(line) {
  const m = SESSION_ID_RE.exec(String(line ?? ''));
  return m ? m[1] : '';
}

/** 递归找一段"像助手最终回复"的文本；认不出就返回空串 */
function textOf(node, depth = 0) {
  if (depth > 4 || node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) {
    const parts = node.map((x) => textOf(x, depth + 1)).filter(Boolean);
    return parts.join('');
  }
  if (typeof node !== 'object') return '';
  for (const key of ['text', 'content', 'message', 'last_agent_message', 'answer', 'output']) {
    const v = node[key];
    if (typeof v === 'string' && v.trim()) return v;
    if (v && typeof v === 'object') {
      const s = textOf(v, depth + 1);
      if (s.trim()) return s;
    }
  }
  if (node.item) return textOf(node.item, depth + 1);
  return '';
}

/**
 * 从 JSONL 事件流里取最后一条"有内容"的助手消息。
 * ⚠️ 各家事件格式不统一，这里只做**尽力而为**的解析；所以默认输出模式是
 *    last-message（落文件），只有拿不到文件时才会退到这条路径。
 */
export function extractJsonlAnswer(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/);
  let best = '';
  for (const line of lines) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    let obj;
    try { obj = JSON.parse(t); } catch { continue; }
    const type = String(obj?.type || obj?.msg?.type || '').toLowerCase();
    // 明确不是"助手发言"的事件跳过，避免把工具 stdout / 推理过程当答案
    if (/tool|command|exec|patch|diff|error|reasoning/.test(type)) continue;
    const text = textOf(obj).trim();
    if (text) best = text;
  }
  return best;
}

/**
 * 解析可执行文件。Windows 上 npm 全局装的 CLI 是 codex.cmd，
 * 而 Node 拒绝直接 spawn .cmd（EINVAL），所以要么找到 .exe，要么明确标记走 cmd 外壳。
 */
function resolveExec(cmd) {
  const raw = String(cmd || '').trim();
  if (!raw) return null;
  if (/[\\/]/.test(raw)) {
    try {
      if (fs.statSync(raw).isFile()) return { file: raw, viaCmd: /\.(cmd|bat)$/i.test(raw) };
    } catch { /* 不存在，继续按 PATH 找 */ }
    return null;
  }
  const exts = String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
  const names = [raw];
  for (const e of exts) names.push(raw + e.toLowerCase());
  for (const e of exts) names.push(raw + e.toUpperCase());
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const p = path.join(dir, name);
      try {
        if (fs.statSync(p).isFile()) return { file: p, viaCmd: /\.(cmd|bat)$/i.test(p) };
      } catch { /* 下一个 */ }
    }
  }
  return null;
}

/** cmd.exe 里给参数加引号（参数都是我们自己生成的 flag/路径/会话 id，不含用户正文） */
function quoteForCmd(s) {
  const v = String(s ?? '').replace(/"/g, '""').replace(/[\r\n]/g, ' ');
  return `"${v}"`;
}

/** Windows 上 child.kill() 杀不掉子进程树，超时必须整棵树带走。 */
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => {});
      killer.unref?.();
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch { /* 杀不掉也比不杀好 */ }
}

/**
 * 预设：给"手改 config.json 只写两三个字段"的场景兜底。
 * 为什么需要：config.agentBridges 是数组，loadConfig 的 deepMerge 对数组是**整条替换**
 * （见 src/config.js 的 deepMerge），所以用户在 data/config.json 里只写
 * `{ id, preset, enabled, allowedSenderIds }` 时，默认配置里的参数模板会被整条覆盖掉 ——
 * 桥会以"没有配置参数模板"报错。写 preset 就能把命令/参数/输出模式补齐。
 */
export const PRESETS = {
  codex: {
    label: 'Codex',
    prefix: '/codex',
    cmd: 'codex',
    taskVia: 'stdin',
    resume: 'id',
    newArgs: ['exec', '--json', '--skip-git-repo-check', '-o', '{out}', '-'],
    resumeArgs: ['exec', 'resume', '{session}', '--json', '--skip-git-repo-check', '-o', '{out}', '-'],
    outputMode: 'last-message'
  }
};

/** 把适配器配置补齐默认值（配置里只写关心的字段即可） */
export function normalizeBridge(raw, index) {
  const rawObj = raw && typeof raw === 'object' ? raw : {};
  const preset = PRESETS[String(rawObj.preset || '')] || {};
  const b = { ...preset };
  for (const [k, v] of Object.entries(rawObj)) if (v !== undefined) b[k] = v;
  const sessionMode = ['per-chat', 'global', 'none'].includes(b.sessionMode) ? b.sessionMode : 'per-chat';
  const resume = ['id', 'last', 'none'].includes(b.resume) ? b.resume : 'id';
  return {
    id: String(b.id || `bridge${index + 1}`),
    label: String(b.label || b.id || `桥${index + 1}`),
    enabled: b.enabled === true,
    kind: 'cli',
    prefix: String(b.prefix || '').trim() || DEFAULT_PREFIX,
    cmd: String(b.cmd || '').trim(),
    workdir: String(b.workdir || '').trim(),
    allowedSenderIds: Array.isArray(b.allowedSenderIds) ? b.allowedSenderIds.map(String) : [],
    requireMentionInGroup: b.requireMentionInGroup !== false,
    timeoutMs: Math.max(10_000, Number(b.timeoutMs) || 600_000),
    sessionMode,
    resume,
    taskVia: b.taskVia === 'arg' ? 'arg' : 'stdin',
    newArgs: Array.isArray(b.newArgs) ? b.newArgs.map(String) : [],
    resumeArgs: Array.isArray(b.resumeArgs) ? b.resumeArgs.map(String) : [],
    outputMode: ['last-message', 'jsonl', 'text'].includes(b.outputMode) ? b.outputMode : 'last-message',
    resultPromptChars: Math.max(0, Number(b.resultPromptChars ?? 200)),
    showProgress: ['off', 'private', 'all'].includes(b.showProgress) ? b.showProgress : 'private',
    replyPrefix: String(b.replyPrefix || ''),
    env: b.env && typeof b.env === 'object' ? b.env : null
  };
}

export function createAgentBridges({ getConfig, sender, log = console.log, emit = () => {} }) {
  /** key = `${bridgeId}\u0000${chatKey}` → { startedAt, child, killed } */
  const running = new Map();
  const pending = new Set();
  let warnedPrefix = new Set();

  const readBridges = () => {
    const list = getConfig()?.agentBridges;
    const arr = Array.isArray(list) ? list : [];
    return arr.map(normalizeBridge).filter((b) => b.enabled && b.cmd);
  };

  /** 回发：与 dsh 桥同一套闸门（隐私过滤 + 跳过去重 + 只把摘要喂进提示词） */
  async function reply(chatKey, text, replyToMessageId, extra = {}) {
    try {
      const gate = getPrivacyFilter().filterText(chatKey, text);
      const out = gate.ok ? gate.text : privacyBlockedReply();
      if (!gate.bypass && !gate.ok) {
        log(`[privacy] 拦截 → ${chatKey}（命中 ${gate.blockedBy}），已替换为提示语`);
      } else if (!gate.bypass && gate.hits.length) {
        log(`[privacy] 打码 → ${chatKey}：${gate.hits.map((h) => `${h.id}×${h.count}`).join('、')}`);
      }
      // 两次任务完全可能给出同一句话（都回 "OK"），不能被 8 秒去重窗口吞掉
      await sender.sendTextBatch(chatKey, [out], { replyToMessageId, skipDedupe: true, promptText: extra.promptText ?? null });
      emit('chat-update', chatKey);
    } catch (error) {
      log(`[bridge] 回发失败：${error?.message ?? error}`);
    }
  }

  /** 结果进提示词只留摘要（正文仍然全文发 QQ） */
  function digest(text, limit) {
    const full = String(text ?? '');
    if (limit === 0) return `[Agent 执行结果已直接发到本会话（${full.length} 字），未进上下文]`;
    const head = full.slice(0, limit).replace(/\s+/g, ' ').trim();
    return `[Agent 执行结果已直接发到本会话（共 ${full.length} 字，此处只是摘要）] ${head}${full.length > limit ? '…' : ''}`;
  }

  function sessionKeyFor(bridge, chatKey) {
    if (bridge.sessionMode === 'none') return null;
    return bridge.sessionMode === 'global' ? '__global__' : chatKey;
  }

  function readSession(bridge, skey) {
    if (!skey) return null;
    const all = loadState();
    return all?.[bridge.id]?.[skey] || null;
  }

  function writeSession(bridge, skey, sessionId) {
    if (!skey || !sessionId) return;
    const all = loadState();
    if (!all[bridge.id]) all[bridge.id] = {};
    all[bridge.id][skey] = { sessionId, updatedAt: Date.now() };
    saveState(all);
  }

  /** 跑一次。resolve 出来永远不抛错：让调用方能决定回发什么。 */
  function runOnce(bridge, { task, sessionId, outFile, onLine, onSpawn }) {
    return new Promise((resolve) => {
      const res = resolveExec(bridge.cmd);
      if (!res) {
        resolve({ spawnError: `找不到可执行文件：${bridge.cmd || '(未配置)'}（检查 PATH 或改填绝对路径）` });
        return;
      }
      const cwd = bridge.workdir && fs.existsSync(bridge.workdir) ? bridge.workdir : ROOT;
      // resume='last' 时第一次跑必须用新会话模板：--last 会接上"该目录里最近一次会话"，
      // 那很可能是你自己手动跑的 codex，不该被一条 QQ 消息续上。
      const resumeNow = bridge.resume === 'id'
        ? !!sessionId
        : (bridge.resume === 'last' ? !!sessionId : false);
      const resolvedSession = bridge.resume === 'last' ? '--last' : (sessionId || '');
      const template = resumeNow ? bridge.resumeArgs : bridge.newArgs;
      if (!template.length) {
        resolve({ spawnError: `桥 ${bridge.id} 没有配置参数模板（newArgs / resumeArgs）` });
        return;
      }
      let args = buildArgs(template, { task, out: outFile, session: resolvedSession, cwd });
      if (bridge.taskVia === 'arg' && !args.includes(task)) args.push(task);

      let file = res.file;
      let verbatim = false;
      if (res.viaCmd) {
        // .cmd/.bat：必须借 cmd.exe。实测（Windows 11 / Node 22）只有这一种写法能跑：
        //   参数 = ['/d','/s','/c', '""C:\\path\\codex.cmd" "--json" "-o" "..." "-""']
        // 即**外层再包一层双引号** —— cmd /s 会剥掉最外一层，剩下才是真正的命令；
        // 少这层会把 "C:\a b\codex.cmd" 连同后面的引号一起当成一个路径（报"文件名语法不正确"）。
        // windowsVerbatimArguments 让 Node 不要自作主张再转义一遍。
        file = process.env.ComSpec || 'cmd.exe';
        const inner = [quoteForCmd(res.file), ...args.map(quoteForCmd)].join(' ');
        args = ['/d', '/s', '/c', `"${inner}"`];
        verbatim = true;
      }

      let child;
      try {
        child = spawn(file, args, {
          cwd,
          windowsHide: true,
          windowsVerbatimArguments: verbatim,
          env: { ...process.env, ...(bridge.env || {}) }
        });
      } catch (error) {
        resolve({ spawnError: String(error?.message ?? error) });
        return;
      }
      // 把真实子进程交回调用方：/桥 停 与退出清理都靠这个 pid 杀进程树
      if (onSpawn) { try { onSpawn(child); } catch { /* ignore */ } }

      let stdout = '';
      let stdoutTruncated = false;
      let stderr = '';
      let killed = false;
      let spawnError = '';

      const timer = setTimeout(() => {
        killed = true;
        killTree(child.pid);
      }, bridge.timeoutMs);

      child.on('error', (error) => { spawnError = String(error?.message ?? error); });
      child.stdout?.on('data', (buf) => {
        if (stdout.length >= STDOUT_CAP) { stdoutTruncated = true; return; }
        const chunk = buf.toString('utf8');
        stdout += chunk;
        if (onLine) for (const line of chunk.split(/\r?\n/)) if (line.trim()) onLine(line);
      });
      child.stderr?.on('data', (buf) => {
        stderr += buf.toString('utf8');
        if (stderr.length > STDERR_TAIL * 4) stderr = stderr.slice(-STDERR_TAIL);
      });

      // 任务正文走 stdin：不进 argv，既避开命令行长度限制也避开注入
      if (bridge.taskVia === 'stdin') {
        try {
          child.stdin?.write(String(task));
          child.stdin?.end();
        } catch { /* 进程已经退出时写 stdin 会抛，忽略即可 */ }
      } else {
        try { child.stdin?.end(); } catch { /* ignore */ }
      }

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          code: typeof code === 'number' ? code : -1,
          stdout,
          stdoutTruncated,
          stderr,
          killed,
          spawnError,
          outFile
        });
      });
    });
  }

  /** 按 outputMode 取答案；拿不到就退化到下一档，并在返回里说明来源 */
  function pickAnswer(bridge, result) {
    const mode = bridge.outputMode;
    let answer = '';
    let from = '';
    if (mode === 'last-message') {
      try {
        const t = fs.readFileSync(result.outFile, 'utf8').replace(/^\uFEFF/, '').trim();
        if (t) { answer = t; from = 'file'; }
      } catch { /* 文件没生成，往下退 */ }
    }
    if (!answer && mode !== 'text') {
      const t = extractJsonlAnswer(result.stdout);
      if (t) { answer = t; from = 'jsonl'; }
    }
    if (!answer) {
      const t = String(result.stdout || '').trim();
      if (t) {
        // 纯文本兜底必须显式标注截断，不能静默少报
        const cap = 4000;
        answer = t.length > cap ? `${t.slice(-cap)}\n（以上为输出末尾 ${cap} 字，完整内容更长，已截断）` : t;
        from = 'stdout';
      }
    }
    return { answer, from };
  }

  function helpText(bridge) {
    return [
      `【${bridge.label} 桥】把任务交给本机 ${bridge.cmd} 执行，不经过大模型`,
      `${bridge.prefix} <任务>      在当前会话里执行（可连续追问）`,
      `${bridge.prefix} 新 [任务]   丢掉上下文开新会话；不带任务 = 只重置`,
      `${bridge.prefix} 状态        看会话 id / 工作目录 / 是否在跑`,
      `${bridge.prefix} 停          中断正在执行的任务`,
      `${bridge.prefix} 帮助        这条说明`,
      bridge.resume === 'none' ? '当前配置不保留上下文（resume=none）' : `续跑方式：${bridge.resume === 'last' ? '接着最近一次会话（--last）' : '按会话 id 续跑'}`
    ].join('\n');
  }

  function statusText(bridge, chatKey, skey) {
    const key = `${bridge.id}\u0000${chatKey}`;
    const run = running.get(key);
    const rec = readSession(bridge, skey);
    return [
      `${bridge.label} 桥：${run ? `有任务在跑（${Math.round((Date.now() - run.startedAt) / 1000)}s）` : '空闲'}`,
      `可执行：${bridge.cmd}${resolveExec(bridge.cmd) ? '' : '（⚠️ 找不到）'}`,
      `目录：${bridge.workdir || ROOT}`,
      `会话：${rec?.sessionId || '(还没建)'}`,
      `超时：${Math.round(bridge.timeoutMs / 1000)}s`,
      `上次：${rec?.updatedAt ? new Date(rec.updatedAt).toLocaleString() : '(无)'}`
    ].join('\n');
  }

  /**
   * 处理一条消息。返回 true = 这条被桥认领（调用方不要再交给编排器）。
   * opts.atMe：群里是否 @ 了本机器人（未 @ 且要求 @ 时返回 false，交给模型）。
   */
  function handle(chatKey, entry = null, opts = {}) {
    const bridges = readBridges();
    if (!bridges.length) return false;
    const text = entry?.text ?? '';

    let bridge = null;
    let parsed = null;
    for (const b of bridges) {
      const p = parseAgentCommand(text, b.prefix);
      if (p) { bridge = b; parsed = p; break; }
    }
    if (!bridge || !parsed) return false;

    const kind = String(opts.kind || chatKey).split(':')[0];
    if (kind === 'group' && bridge.requireMentionInGroup && opts.atMe !== true) return false;

    // 前缀撞车：只提示一次，否则每次消息都刷日志
    const dup = bridges.filter((b) => b !== bridge && b.prefix.toLowerCase() === bridge.prefix.toLowerCase());
    if (dup.length && !warnedPrefix.has(bridge.prefix)) {
      warnedPrefix.add(bridge.prefix);
      log(`[bridge] 前缀冲突：${bridge.id} 与 ${dup.map((d) => d.id).join('、')} 都用 ${bridge.prefix}，只有第一条生效`);
    }

    const senderId = String(entry?.senderId ?? '');
    const replyTo = entry?.mid ?? null;
    const task = String(parsed.task || '');
    const key = `${bridge.id}\u0000${chatKey}`;
    const skey = sessionKeyFor(bridge, chatKey);

    const job = (async () => {
      try {
        if (!bridge.allowedSenderIds.length) {
          await reply(chatKey, `⛔ ${bridge.label} 桥已启用，但 allowedSenderIds 是空的 —— 先在设置里填上允许下指令的 QQ 号。`, replyTo);
          return;
        }
        if (!bridge.allowedSenderIds.includes(senderId)) {
          await reply(chatKey, `⛔ 你没有在 ${bridge.label} 桥的白名单里。`, replyTo);
          return;
        }

        if (parsed.kind === 'help') { await reply(chatKey, helpText(bridge), replyTo); return; }
        if (parsed.kind === 'status') { await reply(chatKey, statusText(bridge, chatKey, skey), replyTo); return; }

        if (parsed.kind === 'stop') {
          const run = running.get(key);
          if (!run) { await reply(chatKey, '（当前没有在跑的任务）', replyTo); return; }
          run.killed = true;
          killTree(run.child?.pid);
          await reply(chatKey, '已发送中断。', replyTo);
          return;
        }

        if (running.has(key)) {
          await reply(chatKey, `⏳ 上一个任务还在跑（${Math.round((Date.now() - running.get(key).startedAt) / 1000)}s）。要么等，要么发「${bridge.prefix} 停」。`, replyTo);
          return;
        }

        if (parsed.kind === 'new') {
          if (skey) {
            const all = loadState();
            if (all[bridge.id]) { delete all[bridge.id][skey]; saveState(all); }
          }
          if (!task) { await reply(chatKey, '已重置会话，下一条重新开。', replyTo); return; }
        }

        if (!task) { await reply(chatKey, `用法：${bridge.prefix} <任务>（发「${bridge.prefix} 帮助」看全部）`, replyTo); return; }

        const outFile = path.join(os.tmpdir(), `qq-agent-bridge-${process.pid}-${Date.now()}.txt`);
        const rec = readSession(bridge, skey);
        const sessionId = parsed.kind === 'new' ? '' : (rec?.sessionId || '');
        const startedAt = Date.now();

        // 先给个"收到"，否则一次十分钟的任务在前几分钟里完全没有反馈
        const showAck = bridge.showProgress === 'all' || (bridge.showProgress === 'private' && kind === 'private');
        if (showAck) await reply(chatKey, `⏳ 已交给 ${bridge.label}，执行中…（发「${bridge.prefix} 停」可中断）`, replyTo);

        const holder = { child: null, killed: false, startedAt };
        // 先占位再 spawn：并发进来的第二条会被"上一个还在跑"挡住
        running.set(key, holder);
        let newSession = '';
        const result = await runOnce(bridge, {
          task,
          sessionId,
          outFile,
          onSpawn: (child) => { holder.child = child; },
          onLine: (line) => { const id = extractSessionId(line); if (id) newSession = id; }
        });
        running.delete(key);

        if (result.spawnError) {
          try { fs.rmSync(outFile, { force: true }); } catch { /* ignore */ }
          await reply(chatKey, `❌ ${bridge.label} 启动失败：${result.spawnError}`, replyTo);
          return;
        }
        if (bridge.resume === 'id' && newSession) writeSession(bridge, skey, newSession);
        // resume='last' 不自带 id：跑成功一次就记个占位，下一条才会走 --last 模板
        else if (bridge.resume === 'last' && result.code === 0) writeSession(bridge, skey, '--last');

        // ⚠️ 先取答案再删临时文件 —— 反过来会把 last-message 模式的文件删掉，
        //    于是永远退到 jsonl 兜底（实测踩过，表现为"答案能出但来源不对"）。
        const { answer, from } = pickAnswer(bridge, result);
        try { fs.rmSync(outFile, { force: true }); } catch { /* ignore */ }
        const cost = ((Date.now() - startedAt) / 1000).toFixed(1);
        if (answer) {
          const head = bridge.replyPrefix || '';
          // 截断必须显式告知（项目纪律）：超时中断、事件流超上限，都要写进回发内容
          const tail = (result.killed ? `\n（已超时中断，耗时 ${cost}s，以上是中断前的输出）` : '')
            + (result.stdoutTruncated ? '\n（事件流超过 2MB 已截断，以上为读到的部分）' : '');
          await reply(chatKey, head + answer + tail, replyTo, { promptText: digest(answer, bridge.resultPromptChars) });
          if (!result.killed) log(`[bridge] ${bridge.id} 完成，${cost}s，来源=${from}`);
          return;
        }

        // 没有答案就如实说，不许静默丢弃
        const stderrTail = String(result.stderr || '').trim().slice(-STDERR_TAIL);
        await reply(chatKey, [
          `❌ ${bridge.label} 没有返回内容（exit ${result.code}，耗时 ${cost}s）`,
          result.killed ? '（已按超时中断）' : '',
          stderrTail ? `错误输出末尾：\n${stderrTail}` : '（没有 stderr 输出，检查命令参数与登录态）'
        ].filter(Boolean).join('\n'), replyTo);
      } catch (error) {
        log(`[bridge] ${bridge.id} 执行异常：${error?.message ?? error}`);
        await reply(chatKey, `❌ ${bridge.label} 执行异常：${error?.message ?? error}`, replyTo);
      }
    })();

    pending.add(job);
    job.finally(() => pending.delete(job)).catch(() => {});
    return true;
  }

  /** 等所有在跑的任务收尾（测试与优雅退出用） */
  async function awaitIdle() {
    while (pending.size) await Promise.allSettled([...pending]);
  }

  /** 退出时把子进程树一起带走，别留孤儿 */
  function abortAll() {
    for (const [, run] of running) {
      run.killed = true;
      killTree(run.child?.pid);
    }
    running.clear();
  }

  return { handle, abortAll, awaitIdle, parseAgentCommand };
}
