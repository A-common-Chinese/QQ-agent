// 进程单实例锁：确保同一数据目录下只有一个 QQ Agent 核心在跑。
//
// 为什么需要（Electron 的 requestSingleInstanceLock 管不到的场景）：
//   - Electron 桌面端 + `npm run server` headless 同时启动 → 两份核心
//   - 双击 .bat 又手动 node src/server.js → 两份核心
//   两份核心会双份连 SnowLuma、双份处理群消息 → 群里看到重复回复。
//
// 原理：在数据目录放一个 qq-agent.lock 文件，内容 = JSON {pid, startMs, name}。
//   启动时若锁文件存在，且核对后确认"就是同一个 QQ Agent 进程还活着" → 判定已有实例，拒绝启动；
//   否则（进程已死 / PID 被系统复用给了别的程序）→ 判定为残留锁，抢占后继续启动。
//   正常退出 / 被 kill 时删除锁文件。
//
// ⚠️ 为什么不能只看 PID（2026-10-16 事故根因）：
//   PID 会被操作系统复用。旧实例被强杀（或系统重启）后锁文件残留在磁盘上，
//   而那个 PID 很快被别的程序占用（本例是 QwenWorkCN.exe 拿到了 26788），
//   于是 `process.kill(pid, 0)` 永远返回"活着"，QQ Agent 再也起不来，
//   而且自己永远不会自愈（同一个错误在 10-11 / 10-12 / 10-16 各发生过一次）。
//   因此 PID 存活只是**第一层**判断，还要核对映像名与启动时间；任一不符即判为残留锁。
//
// 历史：本文件 2026-10-16 先在安装目录打了补丁（原文件备份 instance-lock.js.bak-dsh-20261016），
// 2026-10-22 已回灌到源码仓库成为唯一真源 —— 否则下次「安装并重启」会把补丁覆盖掉，
// 10-16 那个"PID 被复用 → 再也起不来"的事故就会重现。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DATA_DIR } from './config.js';

const LOCK_FILE = path.join(DATA_DIR, 'qq-agent.lock');

/** 本进程的启动时刻（墙钟毫秒）与映像名，写入锁文件供下一个进程核对。 */
const SELF_START_MS = Date.now() - Math.round(process.uptime() * 1000);
const SELF_NAME = path.basename(process.execPath || '');
/** 启动时间的容差：同一进程两次取值的抖动足够小，超过它即认为是另一个进程。 */
const START_MS_TOLERANCE = 3000;

/** 进程是否还活着（Windows / POSIX 通用：signal 0 不杀进程，只探测）。 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 进程存在但无权发信号（别的用户），也算活着
    return error?.code === 'EPERM';
  }
}

/** 读取锁文件；兼容旧的"纯 PID"格式。读不出 / 格式坏 / 没有有效 PID → null（当残留锁处理）。 */
function readLock() {
  let raw = '';
  try {
    raw = String(fs.readFileSync(LOCK_FILE, 'utf8')).trim();
  } catch {
    return null;
  }
  if (!raw) return null;
  // 旧格式：整个文件就是一个 PID
  if (/^\d+$/.test(raw)) return { pid: Number(raw), startMs: null, name: '' };
  try {
    const obj = JSON.parse(raw);
    const pid = Number(obj?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const startMs = Number(obj?.startMs);
    return {
      pid,
      startMs: Number.isFinite(startMs) && startMs > 0 ? startMs : null,
      name: typeof obj?.name === 'string' ? obj.name : '',
    };
  } catch {
    return null;
  }
}

/**
 * 向系统询问 pid 的映像名与启动时间。
 * 查不到（非 Windows / 进程刚退出 / PowerShell 不可用）→ 返回 null，
 * 由调用方按"无法判定"保守处理（沿用旧的 PID 存活判断）。
 */
function probeProcess(pid) {
  if (process.platform !== 'win32') return null;
  try {
    // Ticks(1970-01-01T00:00:00Z) = 621355968000000000，避开时区解析坑
    const script = [
      '$ErrorActionPreference = "SilentlyContinue";',
      `$p = Get-Process -Id ${pid};`,
      'if ($p) {',
      '  $ms = 0;',
      '  try { $ms = [int64](($p.StartTime.ToUniversalTime().Ticks - 621355968000000000) / 10000) } catch { $ms = 0 }',
      '  [pscustomobject]@{ name = [string]$p.ProcessName; startMs = $ms } | ConvertTo-Json -Compress',
      '}',
    ].join(' ');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000,
    });
    if (r.error || r.status !== 0 || !r.stdout) return null;
    const obj = JSON.parse(String(r.stdout).trim());
    const startMs = Number(obj?.startMs);
    return {
      name: String(obj?.name || ''),
      startMs: Number.isFinite(startMs) && startMs > 0 ? startMs : null,
    };
  } catch {
    return null;
  }
}

/** 映像名比较（忽略大小写与 .exe 后缀）；任一侧缺信息时不下"不同"的结论。 */
function sameImage(a, b) {
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\.exe$/, '');
  if (!norm(a) || !norm(b)) return true;
  return norm(a) === norm(b);
}

/**
 * 锁里记录的那个进程，是否真的是"活着的 QQ Agent"。
 * 三层判断：1) PID 存活  2) 映像名一致  3) 启动时间一致。
 * 宁可误判为残留锁（可自愈、最多双开一次）也不要永远拒绝启动（完全起不来）。
 */
function lockHoldsLiveInstance(lock) {
  if (!lock || !lock.pid) return false;
  if (!pidAlive(lock.pid)) return false;
  const probe = probeProcess(lock.pid);
  if (!probe) return true; // 问不到系统信息 → 保守当作活着（保持旧行为）
  // 判据一（不依赖锁文件格式，旧格式的锁也适用）：
  //   写锁的进程必然"先启动、后写锁"。若持有者的启动时间晚于锁文件的写入时间，
  //   它就不可能是写这把锁的进程 —— PID 被复用了。容差 2 秒用于文件时间戳精度。
  let lockMtimeMs = 0;
  try { lockMtimeMs = fs.statSync(LOCK_FILE).mtimeMs; } catch { lockMtimeMs = 0; }
  if (probe.startMs && lockMtimeMs && probe.startMs > lockMtimeMs + 2000) return false;
  // 判据二：映像名不一致 → PID 被别的程序（如 QwenWorkCN.exe）复用了
  if (!sameImage(lock.name, probe.name)) return false;
  // 判据三：启动时间与锁里记录的不符 → 同号不同进程（映像名恰好相同）
  if (lock.startMs && probe.startMs && Math.abs(probe.startMs - lock.startMs) > START_MS_TOLERANCE) {
    return false;
  }
  return true;
}

/**
 * 尝试获取单实例锁。
 *
 * 用 `wx`（O_CREAT|O_EXCL）原子创建锁文件：文件已存在则创建失败，
 * 这是唯一能真正防"两个进程同时通过检查、都以为自己拿到锁"的机制。
 * 存在时再核对 PID + 映像名 + 启动时间，判断是活锁（拒绝）还是残留锁（删除后重试一次）。
 *
 * @returns {{ ok: boolean, reason?: string, existingPid?: number }}
 */
export function acquireInstanceLock() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch { /* 忽略，下面写文件会再试 */ }

  const payload = JSON.stringify({ pid: process.pid, startMs: SELF_START_MS, name: SELF_NAME });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // wx：仅当文件不存在时创建，已存在则抛 EEXIST —— 原子操作，无竞态窗口
      fs.writeFileSync(LOCK_FILE, payload, { flag: 'wx' });
      return { ok: true };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        return { ok: false, reason: `无法写入实例锁文件：${error?.message ?? error}` };
      }
      // 锁文件已存在：核对持有者是否真的是活着的 QQ Agent
      const existing = readLock();
      if (existing && existing.pid !== process.pid && lockHoldsLiveInstance(existing)) {
        return { ok: false, reason: `已有 QQ Agent 实例在运行（PID ${existing.pid}）`, existingPid: existing.pid };
      }
      // 残留锁（进程已死 / PID 被复用 / 锁是自己上次异常留下的）：删掉，下一轮用 wx 重新抢
      try { fs.unlinkSync(LOCK_FILE); } catch { /* 删不掉则下一轮 wx 仍 EEXIST，最终报错 */ }
    }
  }
  return { ok: false, reason: '实例锁被占用且无法清除（可能有实例正在启动）' };
}

/** 释放单实例锁（正常退出时调用）。 */
export function releaseInstanceLock() {
  try {
    // 只删自己的锁：万一锁被新实例抢走了，不能误删
    const lock = readLock();
    if (lock && lock.pid === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch { /* 文件不存在/读不出都无所谓 */ }
}

/** 注册退出时自动释放锁（SIGINT/SIGTERM/正常 exit）。 */
export function registerLockCleanup() {
  const cleanup = () => releaseInstanceLock();
  // 锁的**唯一**释放时机是 'exit' 钩子：SIGINT 时立即释放会让优雅退出
  //（server.js 的 await app.stop()，可能数秒）期间新实例抢先拿锁、
  // 与旧实例短暂并存（双核心 = 群里重复回复）。交给 exit 钩子则天然
  // 排在进程真正结束之后，无竞态窗口。
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      // ⚠️ 不做任何事：不退出、不提前释放锁 —— 优雅退出 handler
      //   （server.js / electron）紧随其后执行，最终 process.exit 触发
      //   上面的 'exit' 钩子释放锁。
      // 保险丝：若 30 秒内没有别的 handler 退出进程（异常场景，优雅退出
      // 挂死），强制退出 —— 用非零码，让外层（守护脚本）能识别异常退出。
      const fuse = setTimeout(() => process.exit(1), 30000);
      fuse.unref?.();
    });
  }
}
