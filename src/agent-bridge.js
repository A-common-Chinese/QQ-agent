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
import { spawn, execFileSync } from 'node:child_process';
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
  // 模型：`/wb 模型` 列表、`/wb 模型 <id>` 切换（只影响这条桥，不动 CLI 全局配置）
  if (/^(?:模型|model)$/i.test(rest)) return { kind: 'model', task: '' };
  const setModel = /^(?:模型|model)\s+(\S{1,40})$/i.exec(rest);
  if (setModel) return { kind: 'setmodel', task: setModel[1] };
  // 对话：`/wb 对话` 列出最近会话、`/wb 对话 <序号|id>` 切过去
  if (/^(?:对话|会话|sessions?|列表)$/i.test(rest)) return { kind: 'sessions', task: '' };
  const use = /^(?:对话|会话|use)\s+(\S{1,64})$/i.exec(rest);
  if (use) return { kind: 'use', task: use[1] };
  // 发文件：`/wb 文件 <路径>`（路径可含空格，取冒号后全部）
  const sendFile = /^(?:文件|file)\s+(.+)$/i.exec(rest);
  if (sendFile) return { kind: 'file', task: sendFile[1].trim() };
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
    .replace(/\{cwd\}/g, String(vars.cwd ?? ''))
    .replace(/\{port\}/g, String(vars.port ?? '')));
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
  // 'result' 是 codebuddy/部分 CLI 的最终答案字段（stream-json 的最后一行）
  for (const key of ['text', 'content', 'message', 'last_agent_message', 'answer', 'output', 'result']) {
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
  // ⚠️ 顺序很重要：先按 PATHEXT 找 .exe/.cmd/.bat，最后才找**无扩展名**的文件。
  // npm 全局同时放了两个 shim：`codebuddy`（Unix 的 #!/usr/bin/env node 脚本）和
  // `codebuddy.cmd`（Windows 批处理）。先命中无扩展名那个的话，spawn 会报 ENOENT
  // （Windows 不会把无扩展名文件当可执行），实测踩过（2026-11-11）。
  const names = [];
  for (const e of exts) names.push(raw + e.toLowerCase());
  for (const e of exts) names.push(raw + e.toUpperCase());
  names.push(raw);
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
  },
  // WorkBuddy 自带/独立版的 CodeBuddy CLI（npm i -g @tencent-ai/codebuddy-code）
  // 实测要点（2026-11-11）：
  //   · 必须显式 --port：不带会和 WorkBuddy 桌面抢端口（EADDRINUSE 127.0.0.1:60212）
  //   · 任务走 stdin：-p 不带 prompt 时读标准输入，避免 .cmd 外壳把 & | < > 当命令解析
  //   · 输出用 stream-json：逐行 JSON，含 session_id，末行 {type:'result', result:'...'}
  codebuddy: {
    label: 'WorkBuddy',
    prefix: '/wb',
    cmd: 'codebuddy',
    taskVia: 'stdin',
    resume: 'id',
    port: 61250,
    // headless 下 Bash 要审批（通常被拦），模型拿不到系统时间 → 由桥注入
    injectTime: true,
    // 发文件：答案里写 [[file: 路径]] 或发 `/wb 文件 <路径>`，桥会校验后上传
    sendFiles: true,
    maxFileBytes: 100 * 1024 * 1024,
    // 会话存档根目录（用于 `/wb 对话`）；~ 会展开成用户目录
    sessionsRoot: '~/.codebuddy/projects',
    // `/wb 模型` 列出来的清单（--model 可选值，见 codebuddy --help）
    models: [
      'hy4-free', 'hy4-preview', 'hy3', 'hy3-x',
      'deepseek-v4.1-flash', 'deepseek-v4-pro',
      'glm-5.3', 'glm-5.3-flash', 'glm-5.2',
      'kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed', 'kimi-k3-2',
      'minimax-m3.1-flash', 'step-5-preview', 'mimo-v2.6-pro'
    ],
    // ⚠️ 只给 -y，**不要同时给 --permission-mode acceptEdits**：实测（2026-11-11）
    //    -y 会把模式设成 bypassPermissions，而 --permission-mode acceptEdits 会把它按回去，
    //    结果 Bash 仍要审批、在 headless 下被直接拒。三种组合实测结论：
    //      -y                          → Bash 可跑（echo hi 成功）
    //      -y --tools "Read,Edit,Bash" → Bash 可跑
    //      -y --permission-mode acceptEdits → Bash 被拒（就是这个坑）
    // 风险边界：工具仍限 Read,Edit,Bash，目录仍锁 workdir；HIGH/CRITICAL 风险操作仍会被拦。
    newArgs: ['-p', '--output-format', 'stream-json', '--port', '{port}', '-y',
      '--tools', 'Read,Edit,Bash'],
    resumeArgs: ['-p', '--output-format', 'stream-json', '--port', '{port}', '--resume', '{session}', '-y',
      '--tools', 'Read,Edit,Bash'],
    outputMode: 'jsonl'
  }
};

/**
 * CLI 把会话按"工作目录"分目录存：C:\Users\noapi → c-Users-noapi。
 * 规则（实测自 ~/.codebuddy/projects）：盘符转小写，其余部分的分隔符换成 -。
 */
export function projectSlug(workdir) {
  const abs = path.resolve(String(workdir || ROOT));
  const drive = (abs.match(/^[A-Za-z]:/) || [''])[0];
  const rest = abs.slice(drive.length).replace(/[\\/]+/g, '-');
  return `${drive ? drive[0].toLowerCase() : ''}${rest}`.replace(/^-+|-+$/g, '');
}

const FILE_MARK_RE = /\[\[\s*file\s*[:：]\s*([^\]\n]+?)\s*\]\]/gi;

/** 数一下 patch 目录里有多少 .patch（用于判断本轮有没有产出交接产物） */
export function countPatchFiles(dir) {
  if (!dir) return 0;
  try { return fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.patch')).length; } catch { return 0; }
}

/** 工作树是否有改动（非 git 目录/命令失败都按"无改动"处理，不打扰用户） */
export function isGitDirty(dir) {
  if (!dir) return false;
  try {
    const out = execFileSync('git', ['-C', String(dir), 'status', '--porcelain'], { encoding: 'utf8', timeout: 5000 });
    return out.trim().length > 0;
  } catch { return false; }
}

/**
 * 把 CLI 的原始报错翻译成人话建议。
 * 依据是今天真实踩过的坑（端口占用 / PATH 扩展名 / 未登录 / 缺 .NET 运行时），
 * 不猜：只在能确定特征时给建议，认不出就返回空数组。
 */
export function explainFailure({ spawnError, stderr, stdout } = {}) {
  const text = `${spawnError || ''}\n${stderr || ''}\n${stdout || ''}`;
  const tips = [];
  if (spawnError && /ENOENT/i.test(String(spawnError))) {
    tips.push('找不到可执行文件：Windows 上 npm 全局装的命令通常是 .cmd，检查 PATH 或改用绝对路径（桥已按扩展名优先查找）');
  }
  const auth = /Authentication required|Please use \/login|not logged in/i.test(text);
  if (auth) {
    tips.push('CLI 未登录：先在终端跑一次 `codebuddy`，进交互界面后输入 /login 完成授权（登录态不跨用户/跨服务进程共享）');
  }
  const port = text.match(/EADDRINUSE[^\n]*?:(\d+)/i) || text.match(/address already in use[^\n]*?:(\d+)/i);
  if (port) {
    tips.push(`端口 ${port[1]} 被占用（常见是被桌面版占着）：把桥配置里的 port 改成别的值，例如 ${Number(port[1]) + 1}`);
  }
  if (/app-launch-failed|missing_runtime|You must install \.NET|framework.*not found/i.test(text)) {
    tips.push('缺 .NET 运行时：运行前先设 DOTNET_ROOT 指向随项目带的 .dotnet 目录，并把它加进 PATH');
  }
  if (/not recognized as an internal|不是内部或外部命令|command not found/i.test(text)) {
    tips.push('命令不存在：检查 bridge.cmd 是否写错，或这个程序没装/不在 PATH');
  }
  if (!tips.length && /exit 2\b/.test(String(stderr || '')) && /任务|task/i.test(text)) {
    tips.push('CLI 没收到任务正文：确认 taskVia 与 CLI 的参数约定一致（stdin 还是末尾参数）');
  }
  return tips;
}

/**
 * 交接一致性检查：工作树有改动、但 patch 目录没有新增文件 → 说明「改了没留痕」。
 * 纯函数，方便单测；IO 由调用方做。
 */
export function patchDisciplineWarning({ dirty, newPatches, patchDir } = {}) {
  if (!dirty) return '';
  const n = Number(newPatches) || 0;
  if (n > 0) return '';
  return `⚠️ 本任务改了工作树，但 ${patchDir || 'patch 目录'} 里没有新增 patch —— 交接时会缺依据；`
    + '要么补一份 `git diff`，要么在副本里提交。';
}

/**
 * 从答案里抠出 `[[file: 路径]]` 标记。
 * 返回清理后的正文 + 去重后的路径列表（最多取前 3 个由调用方决定）。
 */
export function extractFileMarks(text) {
  const paths = [];
  const body = String(text || '').replace(FILE_MARK_RE, (_m, raw) => {
    const p = String(raw || '').trim().replace(/^["'`]|["'`]$/g, '');
    if (p) paths.push(p);
    return '';
  });
  return {
    body: body.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
    paths: [...new Set(paths)]
  };
}

/**
 * 校验要发出去的文件：必须在允许的目录内（防 ../ 穿越）、是普通文件、不超上限。
 * 允许目录 = workdir + 额外 fileRoots（例如放 patch 的 .ai 目录）。
 * 只做结构校验；内容隐私扫描按当前需求暂不做（白名单只有本人时风险可控）。
 */
export function resolveOutgoing(fileRef, { workdir, fileRoots, maxFileBytes, allowAnyFile } = {}) {
  const raw = String(fileRef || '').trim();
  if (!raw) return { error: '路径为空' };
  const roots = [workdir, ...(Array.isArray(fileRoots) ? fileRoots : [])]
    .filter(Boolean)
    .map((r) => path.resolve(String(r)));
  const uniq = [...new Set(roots.map((r) => r.toLowerCase()))].map((lower) => roots.find((r) => r.toLowerCase() === lower));
  const base = uniq[0] || path.resolve(ROOT);
  const abs = path.resolve(base, raw);
  // allowAnyFile：今天临时放开（用户明确要求"全权限"）。仍保留 isFile 与大小校验。
  if (allowAnyFile !== true) {
    const inside = uniq.some((root) => abs.toLowerCase() === root.toLowerCase()
      || abs.toLowerCase().startsWith(root.toLowerCase() + path.sep));
    if (!inside) {
      return { error: `不在允许的目录内（允许：${uniq.join('；') || base}）` };
    }
  }
  let st;
  try { st = fs.statSync(abs); } catch { return { error: `读不到文件：${abs}` }; }
  if (!st.isFile()) return { error: `不是普通文件（目录/设备）：${abs}` };
  const max = Math.max(0, Number(maxFileBytes) || 0);
  if (max > 0 && st.size > max) {
    return { error: `文件过大 ${(st.size / 1048576).toFixed(1)}MB，上限 ${(max / 1048576).toFixed(0)}MB` };
  }
  return { path: abs, size: st.size, name: path.basename(abs) };
}

/** 本地时间戳，注入任务正文用：2026-11-11 13:05（周三） */
export function nowStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}（周${week}）`;
}

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
    // 给任务正文前面加一行【当前时间】：headless 下 Bash 往往要审批（无人应答=被拦），
    // 模型拿不到系统时间，留痕/日志只能写 HH:MM 占位。由桥注入最省事。
    injectTime: b.injectTime === true,
    // 有些 CLI（CodeBuddy）必须显式指定 HTTP 端口，不带会和桌面版抢默认端口
    port: Math.max(0, Number(b.port) || 0),
    // 可选模型清单（`/wb 模型` 列出来的就是它）；空 = 不支持选择
    models: Array.isArray(b.models) ? b.models.map(String).filter(Boolean) : [],
    // 发文件：答案里出现 [[file: 路径]] 就把文件发到 QQ；也可用 `/wb 文件 <路径>` 直发。
    // 默认只对 codebuddy preset 打开（其他 CLI 的输出格式没验证过）。
    sendFiles: b.sendFiles === true || (b.sendFiles === undefined && String(b.preset || '') === 'codebuddy'),
    maxFileBytes: Math.max(0, Number(b.maxFileBytes) || 100 * 1024 * 1024),
    maxFilesPerReply: Math.max(1, Number(b.maxFilesPerReply) || 3),
    // 除 workdir 之外还允许发文件的目录（例如放 patch 的 .ai 目录）
    fileRoots: Array.isArray(b.fileRoots) ? b.fileRoots.map(String).filter(Boolean) : [],
    // 全盘允许发文件（跳过目录校验，仍查 isFile 与大小）。临时放开用，默认关。
    allowAnyFile: b.allowAnyFile === true,
    // 交接一致性检查用的 patch 目录：任务改了工作树却没新增 patch 时，回复里提醒
    patchDir: String(b.patchDir || ''),
    // 会话存档根目录（CodeBuddy: ~/.codebuddy/projects）；空 = 不支持列会话
    sessionsRoot: String(b.sessionsRoot || ''),
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

  function writeSession(bridge, skey, patch) {
    if (!skey) return;
    const all = loadState();
    if (!all[bridge.id]) all[bridge.id] = {};
    const prev = all[bridge.id][skey] || {};
    const next = typeof patch === 'string' ? { sessionId: patch } : (patch || {});
    all[bridge.id][skey] = { ...prev, ...next, updatedAt: Date.now() };
    saveState(all);
  }

  /**
   * 列出**所有项目**下的历史会话（按最近活动倒序）。
   *
   * ⚠️ 只扫桥自己的工作目录是不够的（2026-11-11 被指出）：用户真正在用的会话
   *    （QQ Agent 那几个、WtHud 等）在别的项目目录里，按时间排序就会被本目录的
   *    测试会话挤出去。所以这里跨项目扫，并带上每条会话自己的 cwd —— 切过去时
   *    要连工作目录一起切，否则 --resume 会在错误的目录里续跑。
   */
  function listSessions(bridge, limit = 12) {
    const root = String(bridge.sessionsRoot || '').replace(/^~(?=$|[\\/])/, os.homedir());
    if (!root) return [];
    let projects = [];
    try {
      projects = fs.readdirSync(root).filter((n) => {
        try { return fs.statSync(path.join(root, n)).isDirectory(); } catch { return false; }
      });
    } catch { return []; }

    // 先只 stat（便宜），排完序再读标题，避免把全库文件都读一遍
    const files = [];
    for (const proj of projects) {
      const dir = path.join(root, proj);
      let names = [];
      try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch { continue; }
      for (const name of names) {
        const full = path.join(dir, name);
        let st; try { st = fs.statSync(full); } catch { continue; }
        files.push({ id: name.replace(/\.jsonl$/, ''), mtime: st.mtimeMs, project: proj, full });
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);

    // 每个项目保底取最近 2 条：只按全局时间排的话，某个目录里刚跑的一堆测试会话
    // 会把别的项目（用户真正在用的）整片挤掉 —— 2026-11-11 就是这个问题。
    const used = new Map();
    const picked = [];
    for (const f of files) {
      const n = used.get(f.project) || 0;
      if (n >= 2) continue;
      used.set(f.project, n + 1);
      picked.push(f);
      if (picked.length >= Math.max(1, limit)) break;
    }
    picked.sort((a, b) => b.mtime - a.mtime);

    const items = picked.map((f) => {
      let title = '';
      let cwd = '';
      try {
        const head = fs.readFileSync(f.full, 'utf8').split(/\r?\n/, 3).find((l) => l.trim());
        const first = JSON.parse(head);
        cwd = String(first?.cwd || '');
        const text = Array.isArray(first?.content) ? first.content.map((c) => c?.text || '').join('') : '';
        title = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 24);
      } catch { /* 标题/cwd 读不出来不影响列表 */ }
      // 项目目录名对用户不直观，展示 cwd 的最后一段
      const label = cwd ? path.basename(cwd.replace(/[\\/]+$/, '')) || f.project : f.project;
      return { id: f.id, mtime: f.mtime, title, cwd, project: f.project, label };
    });
    return { items, total: files.length };
  }

  /** 跑一次。resolve 出来永远不抛错：让调用方能决定回发什么。 */
  function runOnce(bridge, { task, sessionId, outFile, onLine, onSpawn, model, workdir }) {
    return new Promise((resolve) => {
      const res = resolveExec(bridge.cmd);
      if (!res) {
        resolve({ spawnError: `找不到可执行文件：${bridge.cmd || '(未配置)'}（检查 PATH 或改填绝对路径）` });
        return;
      }
      // 会话切到别的项目时，workdir 跟着切（--resume 会校验工作目录）
      const wantDir = String(workdir || bridge.workdir || '').trim();
      const cwd = wantDir && fs.existsSync(wantDir) ? wantDir : ROOT;
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
      let args = buildArgs(template, { task, out: outFile, session: resolvedSession, cwd, port: bridge.port || '' });
      // 手动选的模型：只在本次调用追加 --model，不写 CLI 的全局配置（不影响你桌面端）
      if (model) args.push('--model', String(model));
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
      bridge.models.length ? `${bridge.prefix} 模型 [名字]  看/切换模型（只影响这条桥）` : '',
      bridge.sessionsRoot ? `${bridge.prefix} 对话 [序号|id]  看历史会话 / 切过去接着聊` : '',
      bridge.sendFiles ? `${bridge.prefix} 文件 <路径>  直接把本机文件发到 QQ（限工作目录内）` : '',
      bridge.sendFiles ? `发文件也可以让 agent 自己在回复里写 [[file: 相对路径]]，桥会自动上传` : '',
      `${bridge.prefix} 停          中断正在执行的任务`,
      `${bridge.prefix} 帮助        这条说明`,
      bridge.resume === 'none' ? '当前配置不保留上下文（resume=none）' : `续跑方式：${bridge.resume === 'last' ? '接着最近一次会话（--last）' : '按会话 id 续跑'}`
    ].filter(Boolean).join('\n');
  }

  function statusText(bridge, chatKey, skey) {
    const key = `${bridge.id}\u0000${chatKey}`;
    const run = running.get(key);
    const rec = readSession(bridge, skey);
    return [
      `${bridge.label} 桥：${run ? `有任务在跑（${Math.round((Date.now() - run.startedAt) / 1000)}s）` : '空闲'}`,
      `可执行：${bridge.cmd}${resolveExec(bridge.cmd) ? '' : '（⚠️ 找不到）'}`,
      `目录：${rec?.workdir || bridge.workdir || ROOT}`,
      `会话：${rec?.sessionId || '(还没建)'}`,
      `模型：${rec?.model || '(默认)'}`,
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

        // ── 模型：列表 / 切换（存进本会话状态，只影响这条桥）──────────────
        if (parsed.kind === 'model' || parsed.kind === 'setmodel') {
          if (!bridge.models.length) { await reply(chatKey, `${bridge.label} 没有配置可选模型清单（config 里加 models: [] 才能选）。`, replyTo); return; }
          const rec = readSession(bridge, skey);
          const current = rec?.model || '(默认)';
          if (parsed.kind === 'model') {
            const lines = bridge.models.map((m, i) => `${i + 1}. ${m}${m === rec?.model ? '  ← 当前' : ''}`);
            await reply(chatKey, [
              `【${bridge.label} 可选模型】当前：${current}`,
              ...lines,
              `切换：${bridge.prefix} 模型 <名字>（只影响这条桥，不改桌面端设置）`
            ].join('\n'), replyTo);
            return;
          }
          const want = String(task || '').trim();
          // 允许用序号选，省得打长名字
          const byIndex = /^\d{1,2}$/.test(want) ? bridge.models[Number(want) - 1] : null;
          const picked = byIndex || bridge.models.find((m) => m.toLowerCase() === want.toLowerCase());
          if (!picked) {
            await reply(chatKey, `没有这个模型：${want}\n发「${bridge.prefix} 模型」看清单。`, replyTo);
            return;
          }
          writeSession(bridge, skey, { model: picked });
          await reply(chatKey, `已切到 ${picked}。下一条任务生效。`, replyTo);
          return;
        }

        // ── 对话：列出历史会话（跨项目） / 切过去 / 按关键词筛 ──────────
        if (parsed.kind === 'sessions' || parsed.kind === 'use') {
          if (!bridge.sessionsRoot) { await reply(chatKey, `${bridge.label} 没有配置会话目录（config 里加 sessionsRoot）。`, replyTo); return; }
          const rec = readSession(bridge, skey);
          // 跨项目扫，多取一些，切到别的项目的会话时工作目录也要跟着切
          const { items: all, total } = listSessions(bridge, 12);
          if (!all.length) { await reply(chatKey, '（还没有历史会话）', replyTo); return; }

          const fmtLine = (s, i) => {
            const when = new Date(s.mtime).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
            const mark = (s.id === rec?.sessionId) ? '  ← 当前' : '';
            return `${i + 1}. ${s.id.slice(0, 8)}  ${when}  [${s.label}]  ${s.title || '(无标题)'}${mark}`;
          };

          const want = String(parsed.task || '').trim();
          const isIndex = /^\d{1,2}$/.test(want);
          const byIndex = isIndex ? all[Number(want) - 1] : null;
          const byId = want ? (all.find((s) => s.id === want) || all.find((s) => s.id.startsWith(want))) : null;

          // 既不是序号也不是 id → 当关键词筛（省得翻十几条找自己那个）
          if (parsed.kind === 'use' && want && !byIndex && !byId) {
            // 关键词要在**全库**里搜，不能只搜当前展示的那 12 条
            const { items: everything } = listSessions(bridge, 200);
            const hit = everything.filter((s) => `${s.title} ${s.label} ${s.id}`.toLowerCase().includes(want.toLowerCase())).slice(0, 10);
            if (!hit.length) { await reply(chatKey, `没有匹配「${want}」的会话。发「${bridge.prefix} 对话」看全部。`, replyTo); return; }
            await reply(chatKey, [
              `【匹配「${want}」的会话】${hit.length} 个`,
              ...hit.map((s, i) => fmtLine(s, i)),
              `切换：${bridge.prefix} 对话 <id 前 8 位>（序号只对上面这份列表有效）`
            ].join('\n'), replyTo);
            return;
          }

          if (parsed.kind === 'sessions') {
            const list = all.slice(0, 12);
            await reply(chatKey, [
              `【${bridge.label} 最近会话】共 ${total} 个，显示 ${list.length} 个（每个项目保底 2 条）`,
              ...list.map((s, i) => fmtLine(s, i)),
              `切换：${bridge.prefix} 对话 <序号或 id>　筛：${bridge.prefix} 对话 <关键词>`,
              `开新的：${bridge.prefix} 新（回到默认目录 ${bridge.workdir || ROOT}）`
            ].join('\n'), replyTo);
            return;
          }

          const picked = byIndex || byId;
          if (!picked) {
            await reply(chatKey, `没找到这个会话：${want}\n发「${bridge.prefix} 对话」看列表。`, replyTo);
            return;
          }
          // 会话属于哪个目录，就在哪个目录续跑：--resume 会校验 cwd
          const patch = { sessionId: picked.id };
          if (picked.cwd) patch.workdir = picked.cwd;
          writeSession(bridge, skey, patch);
          await reply(chatKey, [
            `已切到会话 ${picked.id.slice(0, 8)}${picked.title ? `（${picked.title}）` : ''}`,
            picked.cwd ? `工作目录：${picked.cwd}` : '',
            '下一条任务接着它聊。'
          ].filter(Boolean).join('\n'), replyTo);
          return;
        }

        // ── 直发文件：`/wb 文件 <路径>`（不跑 agent）──────────────────
        if (parsed.kind === 'file') {
          if (!bridge.sendFiles) { await reply(chatKey, `${bridge.label} 桥没开发文件发送。`, replyTo); return; }
          const picked = resolveOutgoing(parsed.task, bridge);
          if (picked.error) { await reply(chatKey, `⛔ 没发：${picked.error}`, replyTo); return; }
          try {
            await sender.sendFile(chatKey, { path: picked.path }, { name: picked.name });
            await reply(chatKey, `已发送 ${picked.name}（${(picked.size / 1048576).toFixed(1)}MB）`, replyTo);
          } catch (e) {
            await reply(chatKey, `❌ 发送失败：${e?.message ?? e}`, replyTo);
          }
          return;
        }

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
            if (all[bridge.id]) {
              // 只清「会话 + 工作目录」，**保留模型选择**：换新会话不该顺手把模型也重置
              const keepModel = all[bridge.id][skey]?.model;
              if (keepModel) all[bridge.id][skey] = { model: keepModel, updatedAt: Date.now() };
              else delete all[bridge.id][skey];
              saveState(all);
            }
          }
          if (!task) { await reply(chatKey, '已重置会话（模型选择保留），下一条重新开。', replyTo); return; }
        }

        if (!task) { await reply(chatKey, `用法：${bridge.prefix} <任务>（发「${bridge.prefix} 帮助」看全部）`, replyTo); return; }

        const outFile = path.join(os.tmpdir(), `qq-agent-bridge-${process.pid}-${Date.now()}.txt`);
        const rec = readSession(bridge, skey);
        const sessionId = parsed.kind === 'new' ? '' : (rec?.sessionId || '');
        const startedAt = Date.now();
        // 交接一致性检查：跑之前的 patch 数量 + 有效工作目录
        const effDir = rec?.workdir || bridge.workdir || ROOT;
        const patchBefore = countPatchFiles(bridge.patchDir);

        // 先给个"收到"，否则一次十分钟的任务在前几分钟里完全没有反馈
        const showAck = bridge.showProgress === 'all' || (bridge.showProgress === 'private' && kind === 'private');
        if (showAck) await reply(chatKey, `⏳ 已交给 ${bridge.label}，执行中…（发「${bridge.prefix} 停」可中断）`, replyTo);

        const holder = { child: null, killed: false, startedAt };
        // 先占位再 spawn：并发进来的第二条会被"上一个还在跑"挡住
        running.set(key, holder);
        let newSession = '';
        const result = await runOnce(bridge, {
          task: bridge.injectTime ? `【当前时间】${nowStamp()}\n\n${task}` : task,
          sessionId,
          model: rec?.model || '',
          workdir: rec?.workdir || '',
          outFile,
          onSpawn: (child) => { holder.child = child; },
          onLine: (line) => { const id = extractSessionId(line); if (id) newSession = id; }
        });
        running.delete(key);

        if (result.spawnError) {
          try { fs.rmSync(outFile, { force: true }); } catch { /* ignore */ }
          const tips = explainFailure({ spawnError: result.spawnError });
          await reply(chatKey, [`❌ ${bridge.label} 启动失败：${result.spawnError}`,
            tips.length ? `\n可能原因：\n- ${tips.join('\n- ')}` : ''].filter(Boolean).join(''), replyTo);
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

          // 发文件：把正文里的 [[file: 路径]] 抠出来，逐个校验后上传。
          // 失败原因挂在正文末尾，绝不静默丢（项目纪律：任何失败都要如实告知）。
          let body = answer;
          const notes = [];
          if (bridge.sendFiles) {
            const marks = extractFileMarks(answer);
            body = marks.body;
            const list = marks.paths.slice(0, bridge.maxFilesPerReply);
            if (marks.paths.length > list.length) {
              notes.push(`（另有 ${marks.paths.length - list.length} 个文件未发：单条最多 ${bridge.maxFilesPerReply} 个）`);
            }
            for (const raw of list) {
              const picked = resolveOutgoing(raw, bridge);
              if (picked.error) { notes.push(`⚠️ 未发送「${raw}」：${picked.error}`); continue; }
              try {
                await sender.sendFile(chatKey, { path: picked.path }, { name: picked.name });
              } catch (e) {
                notes.push(`⚠️ 发送失败「${picked.name}」：${e?.message ?? e}`);
              }
            }
          }

          // 交接一致性：改了工作树却没产出 patch，就在回复里提醒（比靠模型自觉可靠）
          if (bridge.patchDir && !result.killed) {
            const warn = patchDisciplineWarning({
              dirty: isGitDirty(effDir),
              newPatches: countPatchFiles(bridge.patchDir) - patchBefore,
              patchDir: bridge.patchDir
            });
            if (warn) notes.push(warn);
          }

          const text = [head + body, notes.join('\n'), tail].filter((x) => String(x || '').trim()).join('\n');
          if (text) await reply(chatKey, text, replyTo, { promptText: digest(body || answer, bridge.resultPromptChars) });
          if (!result.killed) log(`[bridge] ${bridge.id} 完成，${cost}s，来源=${from}`);
          return;
        }

        // 没有答案就如实说，不许静默丢弃
        const stderrTail = String(result.stderr || '').trim().slice(-STDERR_TAIL);
        const tips = explainFailure({ stderr: result.stderr, stdout: result.stdout });
        await reply(chatKey, [
          `❌ ${bridge.label} 没有返回内容（exit ${result.code}，耗时 ${cost}s）`,
          result.killed ? '（已按超时中断）' : '',
          stderrTail ? `错误输出末尾：\n${stderrTail}` : '（没有 stderr 输出，检查命令参数与登录态）',
          tips.length ? `可能原因：\n- ${tips.join('\n- ')}` : ''
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
