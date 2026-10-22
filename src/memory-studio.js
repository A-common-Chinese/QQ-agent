// 记忆解释器（qq-memory-studio）本地桥：探测目录 / 拉起 / 反向代理 / 停止。
//
// 为什么需要这一层（而不是让前端直接调解释器）：
//   1. 用户机器上不一定装了 Node —— 解释器是纯 Node ESM 脚本，这里用 Electron
//      自带的运行时跑它（process.execPath + ELECTRON_RUN_AS_NODE=1），零安装。
//   2. 解释器把 LLM 的 API Key 存在自己的 data/config.json 里。它的 /api/config
//      必须**禁止**透传：本机任何网页都能打 127.0.0.1，透传等于把用户的 Key 读走。
//      这里只放行一组固定前缀的白名单（见 ALLOW_PREFIXES）。
//   3. 解释器不是常驻服务：随用随起，关掉控制台就该跟着退出，不能留孤儿进程。
//
// 约定：所有导出函数**都不抛异常**。失败一律返回 { ok:false, error }，
//       这样路由层永远不会 500（前端只需要看 ok 字段）。
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getConfig, ROOT, DATA_DIR } from './config.js';
import { logger } from './logger.js';

const LOG = 'memory-studio';
const DEFAULT_PORT = 7788;
const PORT_SPAN = 10;            // 端口被占时从 config.port 起顺延最多 10 个
const HEALTH_TIMEOUT_MS = 1500;  // 单次 /api/health 探测超时
const START_TIMEOUT_MS = 20000;  // 单个端口等健康检查的上限（契约值）
const START_BUDGET_MS = 30000;   // 全部端口共享的总预算，避免 10×20s 的极端等待
const STOP_TIMEOUT_MS = 5000;
const CALL_TIMEOUT_MS = 60000;   // 代理超时：/api/llm/test 会真的打一次模型接口
const TAIL_LINES = 40;           // 子进程输出保留行数（失败时拼进错误文案）

// 允许前端透传的接口（前缀白名单，按路径段匹配）。
// ⚠️ /api/config 单独禁止（解释器的 Key 与 baseURL 存在那里）。
const ALLOW_PREFIXES = [
  '/api/health',
  '/api/inspect',
  '/api/bundle/inspect',
  '/api/compress/start',
  '/api/job',
  '/api/save',
  '/api/txt/export',
  '/api/txt/import',
  '/api/llm/test'
];
const FORBIDDEN_PREFIXES = ['/api/config'];

// ── 运行期状态（模块级单例：同一进程只拉一个解释器）─────────────────────
let proc = null;          // 我们 spawn 的子进程
let procPort = null;      // 子进程监听的端口
let externalPort = null;  // 别人已经在跑的解释器（接管，不 kill）
let starting = null;      // 启动互斥：并发 start 复用同一个 Promise
let exitHookInstalled = false;

/** 取错误文案（不能依赖 error.message 一定存在） */
const errText = (error) => String(error?.message ?? error ?? '未知错误');
const sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });
const urlFor = (port) => `http://127.0.0.1:${port}`;

// ── 目录探测 ─────────────────────────────────────────────────────────────

/** 有效解释器目录判据：server.mjs + src/merge.mjs 同时存在（契约）。 */
export function isStudioDir(dir) {
  const base = String(dir || '').trim();
  if (!base) return false;
  try {
    if (!fs.statSync(path.join(base, 'server.mjs')).isFile()) return false;
    if (!fs.statSync(path.join(base, 'src', 'merge.mjs')).isFile()) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * 安装根：打包后 process.resourcesPath = <安装根>/resources，其上一级才是安装根；
 * 开发/headless 态没有 resourcesPath，仓库根就当作安装根。
 */
function installRoot() {
  const resources = String(process.resourcesPath || '').trim();
  if (resources) return path.resolve(resources, '..');
  return ROOT;
}

/**
 * 候选目录（按优先级）。键名注释里写清每种形态的来路，出问题时看日志一眼能对上：
 *   1. config.memoryStudio.dir      —— 用户手填（最高优先级）
 *   2. <ROOT>/tools/memory-studio   —— 随程序目录放一份（本项目 asar:false，装出来是
 *                                      resources/app/tools/memory-studio，开发态就是仓库内）
 *   3. <安装根>/tools/memory-studio —— electron-builder extraResources 放在安装根
 *   4. <ROOT>/../../qq-memory-studio —— 开发态（契约写法；ROOT=src 时正好是仓库同级）
 *   5. <ROOT>/../qq-memory-studio   —— 开发态实际布局（本仓库旁边的 qq-memory-studio）
 *   6. <DATA_DIR>/../tools/memory-studio —— 数据目录旁边放一份（便携/免安装用户）
 */
export function studioCandidates() {
  let configured = '';
  try { configured = String(getConfig()?.memoryStudio?.dir || '').trim(); } catch { configured = ''; }
  const list = [];
  if (configured) list.push(configured);
  list.push(path.join(ROOT, 'tools', 'memory-studio'));
  list.push(path.join(installRoot(), 'tools', 'memory-studio'));
  list.push(path.resolve(ROOT, '..', '..', 'qq-memory-studio'));
  list.push(path.resolve(ROOT, '..', 'qq-memory-studio'));
  list.push(path.join(path.resolve(DATA_DIR, '..'), 'tools', 'memory-studio'));
  // 去重（安装根=仓库根、或 DATA_DIR 恰好在 ROOT 下时会产生重复项）
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const abs = path.resolve(raw);
    const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(abs);
  }
  return out;
}

// 仅供测试替换候选来源（生产路径永远用 studioCandidates）。
let candidateProvider = () => studioCandidates();

/**
 * 测试专用：替换目录探测的候选来源。传 null / 不传 = 恢复默认自动探测。
 * 与 setRuntimeConfig 同性质 —— 让"找不到解释器"这种依赖机器布局的分支可测。
 */
export function setCandidateProviderForTest(fn = null) {
  candidateProvider = typeof fn === 'function' ? fn : () => studioCandidates();
  return candidateProvider;
}

/** 按候选顺序找第一个有效目录；找不到返回 ''。 */
export function resolveStudioDir() {
  try {
    for (const dir of candidateProvider()) {
      if (isStudioDir(dir)) return path.resolve(dir);
    }
  } catch (error) {
    logger.warn(LOG, '目录探测失败：' + errText(error));
  }
  return '';
}

/** 解释器版本（读它自己的 package.json；读不到给 null）。 */
function readVersion(dir) {
  if (!dir) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const v = String(pkg?.version || '').trim();
    return v || null;
  } catch { return null; }
}

// ── 进程状态 ─────────────────────────────────────────────────────────────

function isAlive() {
  return !!proc && proc.exitCode === null && !proc.killed;
}

/** 当前生效端口：自己的子进程 > 接管的外部实例；都没有 = null。 */
function activePort() {
  if (isAlive()) return procPort;
  if (externalPort) return externalPort;
  return null;
}

/** 状态查询（同步、不联网）。三态：found=false / found但running=false / running=true。 */
export function getStatus() {
  try {
    const dir = resolveStudioDir();
    // 端口与目录解耦：解释器已经在跑时，即使目录探测暂时失败也照实报告"运行中"
    // （否则 UI 会以为没起、再点一次启动）。
    const port = activePort();
    return {
      ok: true,
      found: !!dir,
      dir,
      hasServer: !!dir && fs.existsSync(path.join(dir, 'server.mjs')),
      running: !!port,
      port,
      url: port ? urlFor(port) : null,
      version: readVersion(dir)
    };
  } catch (error) {
    return { ok: false, error: errText(error) };
  }
}

// ── 启停 ─────────────────────────────────────────────────────────────────

/** 端口是否已被占用（能连上就算占用；不看对面是谁）。 */
function portInUse(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (value) => { try { socket.destroy(); } catch { /* ignore */ } resolve(value); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** 极简 JSON 请求（用全局 fetch；Electron 33 / Node ≥18 都有）。失败返回 {ok:false}。 */
async function httpJson(url, { method = 'GET', body, timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => { try { controller.abort(); } catch { /* ignore */ } }, timeoutMs);
  timer.unref?.();
  try {
    const init = { method, signal: controller.signal, headers: {} };
    if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
      init.headers['content-type'] = 'application/json';
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const res = await fetch(url, init);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { ok: true, status: res.status, data };
  } catch (error) {
    return { ok: false, status: 0, data: null, error: errText(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** /api/health 是否是"记忆解释器"（不是随便一个占端口的服务）。 */
async function healthOk(port, timeoutMs = HEALTH_TIMEOUT_MS) {
  const r = await httpJson(`${urlFor(port)}/api/health`, { timeoutMs });
  if (!r.ok || r.status !== 200) return false;
  return !!r.data && typeof r.data === 'object' && r.data.ok !== false;
}

/** 解释器把配置存 <studio>/data/；只读位置（Program Files / asar 解包）时改指到 QQ Agent 的 data/。 */
function isWritableDir(dir) {
  try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; }
}

function buildEnv(port, dir) {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(port) };
  if (!isWritableDir(dir)) env.MEMORY_STUDIO_DATA = path.join(DATA_DIR, 'memory-studio');
  return env;
}

function killChild(child) {
  if (!child) return;
  try { child.kill(); } catch { /* ignore */ }
  // Windows 下 kill() 就是 TerminateProcess，不需要补刀；其他平台留 SIGKILL 兜底
  if (process.platform !== 'win32') {
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 2000);
    t.unref?.();
  }
}

/**
 * 在指定端口拉起解释器并等它健康。失败不抛：
 *   { ok:false, error }（换下一个端口由调用方决定）
 */
async function trySpawn(dir, port, deadline) {
  let child;
  try {
    child = spawn(process.execPath, ['server.mjs'], {
      cwd: dir,
      env: buildEnv(port, dir),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    return { ok: false, fatal: true, error: `无法拉起解释器进程：${errText(error)}` };
  }

  const tail = [];
  const collect = (stream, tag) => {
    if (!stream) return;
    stream.on('data', (buf) => {
      for (const line of String(buf).split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        tail.push(t);
        if (tail.length > TAIL_LINES) tail.shift();
        logger.debug(LOG, `[${tag}] ${t}`);
      }
    });
    stream.on('error', () => { /* 管道错误忽略，退出码会反映真实结果 */ });
  };
  collect(child.stdout, 'out');
  collect(child.stderr, 'err');

  let exited = false;
  let spawnError = '';
  child.once('error', (error) => { spawnError = errText(error); });
  child.once('exit', (code, signal) => {
    exited = true;
    logger.info(LOG, `解释器子进程退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`);
    // 只有"当前登记的就是它"才清状态，避免误清刚拉起来的新进程
    if (proc === child) { proc = null; procPort = null; }
  });

  const healthDeadline = Math.min(Date.now() + START_TIMEOUT_MS, deadline);
  while (Date.now() < healthDeadline) {
    if (exited || spawnError) break;
    if (await healthOk(port)) {
      proc = child;
      procPort = port;
      logger.info(LOG, `记忆解释器已启动：${urlFor(port)}（pid=${child.pid ?? '?'}，目录 ${dir}）`);
      return { ok: true, running: true, port, url: urlFor(port) };
    }
    await sleep(250);
  }

  killChild(child);
  const why = spawnError
    || (exited
      ? `进程启动后立即退出${tail.length ? `：${tail.slice(-3).join(' | ')}` : ''}`
      : `等待 /api/health 超时（${Math.round(START_TIMEOUT_MS / 1000)}s）`);
  return { ok: false, error: `端口 ${port} 启动失败：${why}` };
}

async function doStart(requestedPort, dir) {
  const wanted = Number(requestedPort);
  let base = Number.isFinite(wanted) && wanted > 0 && wanted <= 65535
    ? Math.trunc(wanted)
    : Number(getConfig()?.memoryStudio?.port);
  if (!Number.isFinite(base) || base <= 0 || base > 65535) base = DEFAULT_PORT;

  const deadline = Date.now() + START_BUDGET_MS;
  let lastError = '';
  for (let i = 0; i < PORT_SPAN; i++) {
    const port = base + i;
    if (port > 65535) break;
    if (await portInUse(port)) {
      // 已经是解释器（用户手动开过 / 上一个实例没关干净）→ 接管，不再起第二个
      if (await healthOk(port)) {
        externalPort = port;
        logger.info(LOG, `接管已运行的解释器：${urlFor(port)}`);
        return { ok: true, running: true, port, url: urlFor(port), alreadyRunning: true, external: true };
      }
      // 被别的服务占着 → 顺延
      logger.debug(LOG, `端口 ${port} 已被其他程序占用，顺延到 ${port + 1}`);
      continue;
    }
    if (Date.now() >= deadline) { lastError = '启动超时（多个端口都未能就绪）'; break; }
    const result = await trySpawn(dir, port, deadline);
    if (result.ok) return result;
    lastError = result.error || lastError;
    if (result.fatal) break;
  }
  return { ok: false, running: false, port: null, url: null, error: lastError || '无法启动记忆解释器' };
}

/**
 * 拉起解释器。幂等：已在运行（自己拉的 / 已接管的）直接返回原状态。
 * @param {{ port?: number }} [options]
 * @returns {Promise<{ok:boolean, running:boolean, port:number|null, url:string|null, error?:string}>}
 */
export async function startStudio({ port } = {}) {
  try {
    if (isAlive()) {
      const p = activePort();
      return { ok: true, running: true, port: p, url: p ? urlFor(p) : null, alreadyRunning: true };
    }
    if (externalPort) {
      // 外部实例可能已经关了：探一下再决定是复用还是重新拉起
      if (await healthOk(externalPort)) {
        return { ok: true, running: true, port: externalPort, url: urlFor(externalPort), alreadyRunning: true, external: true };
      }
      externalPort = null;
    }
    if (starting) return await starting;
    if (getConfig()?.memoryStudio?.enabled === false) {
      return { ok: false, running: false, port: null, url: null, error: '记忆解释器已在设置里关闭（memoryStudio.enabled=false）' };
    }
    const dir = resolveStudioDir();
    if (!dir) {
      return {
        ok: false, running: false, port: null, url: null,
        error: '找不到记忆解释器目录：请把 qq-memory-studio 放到 tools/memory-studio，或在设置里填写解释器目录'
      };
    }
    const task = doStart(port, dir);
    starting = task;
    try { return await task; } finally { starting = null; }
  } catch (error) {
    return { ok: false, running: false, port: null, url: null, error: `启动失败：${errText(error)}` };
  }
}

/**
 * 停止解释器。
 * 只结束**本进程拉起**的子进程；接管来的外部实例只解除登记（不去 kill 用户的独立窗口）。
 * @returns {Promise<{ok:boolean, stopped:boolean, error?:string}>}
 */
export async function stopStudio() {
  try {
    if (externalPort) {
      externalPort = null;
      logger.info(LOG, '解除对已运行解释器的接管（不结束非本进程拉起的服务）');
      return { ok: true, stopped: false };
    }
    const child = proc;
    if (!child) return { ok: true, stopped: false };
    const alreadyExited = child.exitCode !== null;
    const port = procPort;
    proc = null;
    procPort = null;
    let exitPromise = null;
    if (!alreadyExited) {
      exitPromise = new Promise((resolve) => child.once('exit', () => resolve(true)));
      killChild(child);
    }
    if (exitPromise) await Promise.race([exitPromise, sleep(STOP_TIMEOUT_MS)]);
    logger.info(LOG, `记忆解释器已停止${port ? `（原端口 ${port}）` : ''}`);
    return { ok: true, stopped: !alreadyExited };
  } catch (error) {
    // 状态已经据实清理过，这里仍按失败返回但不抛
    return { ok: false, stopped: false, error: `停止失败：${errText(error)}` };
  }
}

// ── 反向代理（白名单）────────────────────────────────────────────────────

/**
 * 校验前端想透传的 path。
 * 返回 { ok:true, path }（path 已归一化，含 query）或 { ok:false, error }。
 */
export function resolveCallPath(rawPath) {
  const raw = String(rawPath ?? '').trim();
  if (!raw) return { ok: false, error: '缺少 path' };
  // 绝对 URL（http://… / file://…）一律拒绝：只允许相对本机解释器的路径
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return { ok: false, error: '不允许的接口' };
  let url;
  try {
    url = new URL(raw, urlFor(DEFAULT_PORT));
  } catch {
    return { ok: false, error: '不允许的接口' };
  }
  // 归一化后必须仍是本机（挡住 //evil.com/... 这类协议相对写法）
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return { ok: false, error: '不允许的接口' };
  const pathname = url.pathname;
  if (!pathname.startsWith('/api/')) return { ok: false, error: '不允许的接口' };
  // ⚠️ 解释器的 /api/config 存着 LLM API Key 与 baseURL —— 显式禁止（先判黑名单）
  if (FORBIDDEN_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return { ok: false, error: '不允许的接口' };
  }
  const allowed = ALLOW_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'));
  if (!allowed) return { ok: false, error: '不允许的接口' };
  return { ok: true, path: pathname + url.search };
}

/**
 * 调用解释器接口（白名单内）。
 * @param {{ path: string, method?: string, body?: any }} options
 * @returns {Promise<{ok:boolean, status:number|null, data:any, error?:string}>}
 */
export async function callStudio({ path: rawPath, method = 'GET', body } = {}) {
  try {
    const verdict = resolveCallPath(rawPath);
    if (!verdict.ok) return { ok: false, error: verdict.error };
    const port = activePort();
    if (!port) return { ok: false, status: null, data: null, error: '记忆解释器未运行，请先启动' };
    const verb = String(method || 'GET').toUpperCase();
    const r = await httpJson(`${urlFor(port)}${verdict.path}`, { method: verb, body, timeoutMs: CALL_TIMEOUT_MS });
    if (!r.ok) return { ok: false, status: null, data: null, error: `调用记忆解释器失败：${r.error}` };
    // 上游业务失败（例如 404 任务不存在）也照实转发：ok=true + 真实 status，前端自己判
    return { ok: true, status: r.status, data: r.data };
  } catch (error) {
    return { ok: false, status: null, data: null, error: `调用失败：${errText(error)}` };
  }
}

// ── 退出清理 ─────────────────────────────────────────────────────────────

/**
 * 注册进程退出钩子（幂等）：控制台被直接关掉 / 崩溃时也不给用户留一个孤儿解释器。
 * 正常退出路径走 app.js stop() → stopStudio()，这里只是兜底。
 */
export function disposeStudio() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    if (proc) {
      try { proc.kill(); } catch { /* ignore */ }
      proc = null;
      procPort = null;
    }
  });
}
