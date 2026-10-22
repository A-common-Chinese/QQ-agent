// 自动更新（期 1：检查 → 提示 → 下载；不自动安装）
//
// 源的可选项：
//   github  —— 读本 fork 的 GitHub Releases（默认）。只读 API，低频（默认 12 小时），风控风险极低。
//   server  —— 兼容旧行为：读作者服务器的 version.json（只给版本号与链接）。
//
// 为什么不用 electron-updater：它跑 NSIS 安装包会把 resources/app 整体替换，
// 从而冲掉用户手放的 plugins/、skills/、snowluma/（协议端运行时）。期 2 会做
// 「备份用户目录 → 只覆盖程序文件 → 恢复」的安全更新器；期 1 只负责把安装包下下来。
//
// 数据落盘：
//   <DATA_DIR>/update-check.json   最近一次检查结果（带 checkedAt，用于 12 小时节流）
//   <DATA_DIR>/updates/<version>/  下载好的安装包
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { DATA_DIR, getConfig, ROOT } from './config.js';

const STATE_FILE = path.join(DATA_DIR, 'update-check.json');
const DOWNLOAD_DIR = path.join(DATA_DIR, 'updates');

// 下载镜像：实测直连 GitHub 约 25 KB/s（78 MB 要 50 分钟），
// gh-proxy.com / ghfast.top 约 160~200 KB/s（7~8 分钟）。
// 顺序即优先级；可在 config.update.mirrors 覆盖。
const DEFAULT_MIRRORS = ['https://gh-proxy.com', 'https://ghfast.top'];
const DEFAULT_REPO = 'A-common-Chinese/QQ-agent';
const FALLBACK_INFO_URL = 'https://kondius.cn/qq-agent/version.json';

// ── 语义版本比较 ──────────────────────────────────────────────────
export function compareSemver(a, b) {
  const norm = (v) => String(v || '').trim().replace(/^v/i, '').split(/[.+-]/).map((x) => Number(x) || 0);
  const x = norm(a);
  const y = norm(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

export function parseTag(tag) {
  return String(tag || '').trim().replace(/^v/i, '');
}

// ── 配置读取 ─────────────────────────────────────────────────────
function updateCfg() {
  const c = getConfig()?.update || {};
  return {
    enabled: c.enabled !== false,
    source: c.source === 'server' ? 'server' : 'github',
    githubRepo: String(c.githubRepo || '').trim() || DEFAULT_REPO,
    intervalHours: Math.max(1, Number(c.intervalHours) || 12),
    autoDownload: c.autoDownload === true,
    checkOnStartup: c.checkOnStartup !== false,
  };
}

function readState() {
  try {
    const t = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function writeState(value) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch { /* 状态写不进去不该影响主流程 */ }
}

// ── 选安装包资产 ─────────────────────────────────────────────────
function pickInstallerAsset(assets) {
  const list = Array.isArray(assets) ? assets : [];
  const byName = (re) => list.find((a) => re.test(String(a?.name || '')));
  return (
    byName(/Setup.*\.exe$/i) ||
    byName(/\.exe$/i) ||
    byName(/\.msi$/i) ||
    null
  );
}

// ── 检查更新 ─────────────────────────────────────────────────────
/**
 * @param {{force?: boolean, current?: string}} opts
 * @returns {Promise<{ok:boolean, current:string, latest?:string, hasUpdate?:boolean,
 *   url?:string, notes?:string, asset?:object|null, cached?:boolean, error?:string}>}
 */
export async function checkForUpdate(opts = {}) {
  const cfg = updateCfg();
  const current = String(opts.current || '').trim();
  if (!cfg.enabled) return { ok: false, current, error: '自动更新已在设置里关闭' };

  const cached = readState();
  if (!opts.force && cached && cached.ok && cached.latest) {
    const ageMin = (Date.now() - (Number(cached.checkedAt) || 0)) / 60000;
    if (ageMin < cfg.intervalHours * 60) {
      // ⚠️ 不能直接 { ...cached }：缓存里的 hasUpdate 是按**当时**的 current 算出来的。
      // 用户升级完（current 追平 latest）后，缓存里还留着 hasUpdate=true，
      // 结果 0.5.7 仍提示"有新版本 0.5.7"（2026-10-22 实测）。
      // 所以缓存命中也要按当前版本重算；current 未知时才退回缓存值。
      const hasUpdate = current ? compareSemver(cached.latest, current) > 0 : !!cached.hasUpdate;
      return { ...cached, current, hasUpdate, cached: true };
    }
  }

  try {
    if (cfg.source === 'server') {
      const r = await fetch(FALLBACK_INFO_URL, { signal: AbortSignal.timeout(8000), cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const info = await r.json();
      const latest = String(info.version || '');
      if (!latest) throw new Error('version.json 缺少 version 字段');
      const out = {
        ok: true,
        source: 'server',
        current,
        latest,
        hasUpdate: compareSemver(latest, current) > 0,
        url: String(info.url || 'https://kondius.cn/qq-agent'),
        notes: String(info.notes || ''),
        asset: null,
        checkedAt: Date.now(),
      };
      writeState(out);
      return out;
    }

    // github：读本 fork 的最新 Release（只读、低频）
    const api = `https://api.github.com/repos/${cfg.githubRepo}/releases/latest`;
    const r = await fetch(api, {
      signal: AbortSignal.timeout(10000),
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'qq-agent-updater' },
      cache: 'no-store',
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}${r.status === 404 ? '（还没有发布 Release）' : ''}`);
    const rel = await r.json();
    const latest = parseTag(rel.tag_name || rel.name);
    if (!latest) throw new Error('Release 里没有 tag_name');
    const asset = pickInstallerAsset(rel.assets);
    const out = {
      ok: true,
      source: 'github',
      repo: cfg.githubRepo,
      current,
      latest,
      hasUpdate: compareSemver(latest, current) > 0,
      url: String(rel.html_url || `https://github.com/${cfg.githubRepo}/releases`),
      notes: String(rel.body || '').slice(0, 4000),
      publishedAt: String(rel.published_at || ''),
      asset: asset
        ? {
            name: String(asset.name || ''),
            size: Number(asset.size) || 0,
            digest: String(asset.digest || ''),
            url: String(asset.browser_download_url || ''),
            downloadCount: Number(asset.download_count) || 0,
          }
        : null,
      checkedAt: Date.now(),
    };
    writeState(out);
    return out;
  } catch (error) {
    const out = { ok: false, current, error: String(error?.message ?? error), checkedAt: Date.now() };
    // 失败也写状态，避免每分钟重试打网络
    writeState({ ...out, ok: false });
    return out;
  }
}

// ── 下载（流式，带进度；防重复并发）─────────────────────────────────
const download = {
  active: false,
  version: '',
  name: '',
  received: 0,
  total: 0,
  percent: 0,
  state: 'idle', // idle | downloading | done | error
  error: '',
  path: '',
  sha256: '',
  startedAt: 0,
  finishedAt: 0,
};

export function getDownloadState() {
  return { ...download };
}

/** 校验 GitHub 资产 digest（形如 "sha256:abcd..."）；没有则不校验。 */
function digestOf(text) {
  const m = /^sha256:([0-9a-f]{64})$/i.exec(String(text || '').trim());
  return m ? m[1].toLowerCase() : '';
}

export async function downloadUpdate(assetInfo, version) {
  if (download.active) return { ok: false, error: '已有下载在进行', state: getDownloadState() };
  const asset = assetInfo || {};
  const rawUrl = String(asset.url || '').trim();
  const name = String(asset.name || 'QQ-Agent-DSH-Setup.exe').replace(/[\\/:*?"<>|]/g, '_');
  if (!rawUrl) return { ok: false, error: '没有可下载的资产' };

  const dir = path.join(DOWNLOAD_DIR, String(version || 'latest').replace(/[\\/:*?"<>|]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, name);
  const partPath = outPath + '.part';

  Object.assign(download, {
    active: true, version: String(version || ''), name, received: 0, total: Number(asset.size) || 0,
    percent: 0, state: 'downloading', error: '', path: outPath, sha256: '', startedAt: Date.now(), finishedAt: 0,
  });

  // 后台跑，接口立刻返回，前端轮询 /api/update/status
  (async () => {
    try {
      // 候选地址：直连 → 各镜像（镜像就是把原始 URL 拼在前面）
      let mirrors = DEFAULT_MIRRORS;
      try {
        const cfgMirrors = getConfig()?.update?.mirrors;
        if (Array.isArray(cfgMirrors) && cfgMirrors.length) mirrors = cfgMirrors.map(String);
      } catch { /* ignore */ }
      // 镜像优先（实测 160~200 KB/s），直连兜底（实测 25 KB/s，全程 50 分钟）
      const candidates = [];
      for (const m of mirrors) {
        const base = String(m || '').trim().replace(/\/+$/, '');
        if (base) candidates.push(base + '/' + rawUrl);
      }
      candidates.push(rawUrl);

      let lastError = null;
      for (const url of candidates) {
        if (!download.active) break;
        try {
          // 断点续传：已有 .part 就带 Range 从末尾接着下
          let existing = 0;
          try { existing = fs.statSync(partPath).size; } catch { existing = 0; }
          const headers = { 'user-agent': 'qq-agent-updater' };
          if (existing > 0) headers.range = 'bytes=' + existing + '-';
          const r = await fetch(url, { signal: AbortSignal.timeout(30 * 60 * 1000), headers });
          if (!r.ok && r.status !== 206) throw new Error(`HTTP ${r.status}`);
          const isResume = r.status === 206 && existing > 0;
          const len = Number(r.headers.get('content-length')) || 0;
          download.total = isResume ? existing + len : (len || download.total);
          download.received = isResume ? existing : 0;
          const fh = await fs.promises.open(partPath, isResume ? 'a' : 'w');
          try {
            const reader = r.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!value) continue;
              await fh.write(Buffer.from(value));
              download.received += value.length;
              download.percent = download.total ? Math.min(100, Math.round((download.received / download.total) * 100)) : 0;
            }
          } finally {
            await fh.close();
          }
          lastError = null;
          break;   // 这一路成功
        } catch (error) {
          lastError = error;
          // 换下一个镜像（.part 保留，下一路继续续传）
        }
      }
      if (lastError) throw lastError;

      // 全部下完：重读文件算 sha256（续传时无法边下边算）
      const hash = crypto.createHash('sha256');
      await new Promise((resolve, reject) => {
        const st = fs.createReadStream(partPath);
        st.on('data', (chunk) => hash.update(chunk));
        st.on('error', reject);
        st.on('end', resolve);
      });
      fs.renameSync(partPath, outPath);
      download.sha256 = hash.digest('hex');
      const expect = digestOf(asset.digest);
      if (expect && expect !== download.sha256) {
        throw new Error(`sha256 校验失败（期望 ${expect.slice(0, 12)}…，实际 ${download.sha256.slice(0, 12)}…）`);
      }
      download.state = 'done';
      download.percent = 100;
      download.finishedAt = Date.now();
    } catch (error) {
      download.state = 'error';
      download.error = String(error?.message ?? error);
      download.finishedAt = Date.now();
      // 失败时保留 .part，下次可续传；不再无条件删除
    } finally {
      download.active = false;
    }
  })();

  return { ok: true, state: getDownloadState() };
}

// ── 启动后检查（供 app.js 调用）────────────────────────────────────
/** 目录占用字节数（不存在返回 0） */
function dirBytes(dir) {
  let total = 0;
  const walk = (d) => {
    let list = [];
    try { list = fs.readdirSync(d); } catch { return; }
    for (const name of list) {
      const p = path.join(d, name);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else total += st.size;
    }
  };
  walk(dir);
  return total;
}

/** 某个目录所在盘的可用字节 */
function freeBytesOf(dir) {
  try {
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch { return 0; }
}

const USER_DIRS = ['plugins', 'skills', 'snowluma'];   // 安装包会覆盖 resources/app，这三样必须备份
// data/ 下不参与备份的：updates（各版本安装包本体，一个几十 MB）、electron-user-data（Chromium 缓存）
export const DATA_SKIP = new Set(['updates', 'electron-user-data']);
// 安装根目录下同样要跟着升级走的目录：tools/ 放的是用户自己装的东西
// （典型是「记忆解释器」<安装目录>\tools\memory-studio，里面还有它的 data/config.json）。
// 不备份的话，一次升级就会把它连配置一起删掉。
const ROOT_KEEP_DIRS = ['tools'];

/**
 * 找安装目录里"能启动"的 exe。
 * ⚠️ 不能硬编码 "QQ Agent.exe"：本机装的是 DSH 版（productName=QQ Agent DSH，
 * exe 叫 QQ Agent DSH.exe），跟 Release 产物的产品名不一致。硬编码的后果是
 * 装完既不杀进程、也不重启（2026-10 实测：点「安装并重启」后机器人直接消失）。
 * 优先级：当前进程的 exe → 常见产品名 → 目录里所有 QQ Agent*.exe。
 */
export function findRunnableExe(installDir) {
  const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  const out = [];
  const push = (p) => { if (p && !out.includes(p)) out.push(p); };
  try {
    const cur = path.resolve(process.execPath);
    if (path.dirname(cur).toLowerCase() === path.resolve(installDir).toLowerCase() && isFile(cur)) push(cur);
  } catch { /* ignore */ }
  for (const name of ['QQ Agent DSH.exe', 'QQ Agent.exe']) {
    const p = path.join(installDir, name);
    if (isFile(p)) push(p);
  }
  try {
    for (const f of fs.readdirSync(installDir)) {
      if (!/\.exe$/i.test(f)) continue;
      if (/uninstall|卸载/i.test(f)) continue;
      if (!/qq\s*agent/i.test(f)) continue;
      push(path.join(installDir, f));
    }
  } catch { /* ignore */ }
  return out[0] || '';
}

/** 目录占用字节数（跳过顶层指定子目录，口径与 copyTree 一致，用于算空间） */
function dirBytesSkip(dir, skip) {
  let total = 0;
  let list = [];
  try { list = fs.readdirSync(dir); } catch { return 0; }
  for (const name of list) {
    if (skip && skip.has(name)) continue;
    const p = path.join(dir, name);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) total += dirBytesSkip(p, null);
    else total += st.size;
  }
  return total;
}

/**
 * 递归复制（可跳过顶层某些子目录）。
 *
 * ⚠️ 为什么不用 `fs.cpSync` + `filter`：它在 Node 20（Electron 33 自带）和 Node 24 上
 * 行为不一致 —— 同一份 filter 在 Node 24 能正确排除，在 Node 20 里却把 `updates/`
 * （78.9 MB 安装包）与 `electron-user-data/`（15.9 MB 缓存）原样拷了过去（实测两次）。
 * 升级助手跑在 Electron 的 Node 20 上，所以这里自己走一遍 readdir，行为完全可控：
 * 只跳过**顶层**命中 skip 的目录/文件，其余原样递归复制。
 */
export function copyTree(src, dst, skip = DATA_SKIP) {
  if (!fs.existsSync(src)) return false;
  const walk = (s, d, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(s, { withFileTypes: true }); } catch { return; }
    try { fs.mkdirSync(d, { recursive: true }); } catch { /* 目标建不出来，下面逐文件会再失败 */ }
    for (const entry of entries) {
      if (depth === 0 && skip && skip.has(entry.name)) continue;
      const from = path.join(s, entry.name);
      const to = path.join(d, entry.name);
      if (entry.isDirectory()) walk(from, to, depth + 1);
      else if (entry.isFile()) {
        try { fs.copyFileSync(from, to); } catch { /* 单个文件失败不拖垮整个备份 */ }
      }
      // 符号链接/设备文件一律跳过（备份不需要它们）
    }
  };
  walk(src, dst, 0);
  return true;
}

/** PowerShell 单引号字面量（路径里出现 ' 也不会炸） */
function psStr(value) {
  return "'" + String(value == null ? '' : value).replace(/'/g, "''") + "'";
}

/**
 * 写还原脚本。
 * ⚠️ 必须带 UTF-8 BOM：Windows PowerShell 5.1 读 .ps1 默认按 ANSI，
 * 中文注释/字符串会被解成乱码，进而把引号吃掉 → 整个脚本语法错误（实测踩过）。
 */
export function writeInstallScript(file, script) {
  fs.writeFileSync(file, '\uFEFF' + script, 'utf8');
  return file;
}

/**
 * 生成还原脚本（纯函数，便于离线自测）：
 *   等应用退出（按 **真实** exe 名） → 静默安装到 **原目录**（NSIS /D）→ 等新版本落位
 *   → 还原 resources/app 下的 plugins/skills/snowluma + 安装根目录的 data/ 与 tools/
 *   → 启动应用（安装失败也要把旧版拉起来，不能让机器人就这么没了）
 * @returns {{script:string, logPath:string}}
 */
export function buildInstallScript({
  installerPath, version, installDir, appDir, dataDir, runExe, backupDir,
  rootDirs = ROOT_KEEP_DIRS, stamp = Date.now()
}) {
  const nl = '\r\n';
  const logPath = path.join(backupDir, 'install.log');
  const exeName = runExe ? path.basename(runExe) : 'QQ Agent.exe';
  const lines = [
    '# 由 QQ Agent 更新器生成：等应用退出 → 静默安装 → 还原用户目录 → 重启',
    "$ErrorActionPreference = 'Continue'",
    '$log = ' + psStr(logPath),
    'function L([string]$m) { try { ((Get-Date).ToString("yyyy-MM-dd HH:mm:ss") + " " + $m) | Add-Content -LiteralPath $log -Encoding UTF8 } catch {} }',
    'L "=== 开始安装 v' + String(version).replace(/"/g, '') + '（stamp=' + stamp + '） ==="',
    'L ("安装目录: " + ' + psStr(installDir) + ')',
    'L ("目标程序: " + ' + psStr(runExe || '（未找到，安装后重新扫描）') + ')',
    'Start-Sleep -Seconds 2',
    '',
    '# ① 关掉正在运行的实例：按真实 exe 名，等它真的退出（否则安装器会被"文件占用"卡住）',
    '$exeName = ' + psStr(exeName),
    '$procName = [IO.Path]::GetFileNameWithoutExtension($exeName)',
    'for ($i = 0; $i -lt 20; $i++) {',
    '  $alive = @(Get-Process -Name $procName -ErrorAction SilentlyContinue)',
    '  if ($alive.Count -eq 0) { break }',
    '  L ("结束进程 " + $procName + "：" + $alive.Count + " 个")',
    '  & taskkill.exe /IM $exeName /T /F 2>$null | Out-Null',
    '  Start-Sleep -Seconds 1',
    '}',
    'if (@(Get-Process -Name $procName -ErrorAction SilentlyContinue).Count -gt 0) { L "⚠ 进程仍未退出，继续尝试安装" }',
    'Start-Sleep -Seconds 1',
    '',
    '# ② 静默安装到原目录。NSIS 的 /D 必须是最后一个参数，且**不能加引号**（含空格也不能）',
    '$installer = ' + psStr(installerPath),
    '$pkgPath = Join-Path ' + psStr(installDir) + ' "resources\\app\\package.json"',
    '$before = ""',
    'try { $before = (Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch {}',
    'L ("安装前版本: " + $before)',
    'if (-not (Test-Path -LiteralPath $installer)) {',
    '  L "✗ 安装包不存在：$installer"',
    '} else {',
    '  $argStr = "/S /D=" + ' + psStr(installDir),
    '  L ("执行: " + $installer + " " + $argStr)',
    '  try { $p = Start-Process -FilePath $installer -ArgumentList $argStr -Wait -PassThru -ErrorAction Stop; L ("安装器退出码: " + $p.ExitCode) }',
    '  catch { L ("✗ 安装器启动失败: " + $_.Exception.Message) }',
    '}',
    '',
    '# ③ 等新版本落位（最长 90 秒）：package.json 的 version 变成目标版本',
    '$want = ' + psStr(String(version)),
    '$landed = $false',
    'for ($i = 0; $i -lt 45; $i++) {',
    '  $v = ""',
    '  try { $v = (Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch {}',
    '  if ($v -and $v -eq $want) { $landed = $true; L ("已落位: v" + $v); break }',
    '  Start-Sleep -Seconds 2',
    '}',
    'if (-not $landed) { L ("⚠ 90 秒内没等到 v" + $want + "，当前 package.json 版本: " + $v + "（继续还原并重启旧版）") }',
    '',
    '# ④ 还原用户目录（安装器可能整目录删过，包括 data/ 与 tools/）',
    '$appDir = ' + psStr(appDir),
    '$dataDir = ' + psStr(dataDir),
    '$installDir = ' + psStr(installDir),
    '$backup = ' + psStr(backupDir),
    '$robolog = { param($src, $dst)',
    '  if (-not (Test-Path -LiteralPath $src)) { return }',
    '  New-Item -ItemType Directory -Force -Path $dst | Out-Null',
    '  & robocopy.exe $src $dst /E /R:0 /W:0 /NFL /NDL /NJH /NJS /NP 2>$null | Out-Null',
    '  L ("还原 " + $src + " -> " + $dst + "（robocopy=" + $LASTEXITCODE + "）")',
    '}',
    'foreach ($d in @("plugins","skills","snowluma")) { & $robolog (Join-Path $backup $d) (Join-Path $appDir $d) }',
    '& $robolog (Join-Path $backup "data") $dataDir',
    'foreach ($d in @(' + rootDirs.map((d) => '"' + String(d).replace(/"/g, '') + '"').join(',') + ')) { & $robolog (Join-Path $backup $d) (Join-Path $installDir $d) }',
    '',
    '# ⑤ 启动应用：优先原来的 exe；它若被新版替换掉就扫目录里最新的 QQ Agent*.exe',
    '$run = ' + psStr(runExe),
    'if (-not $run -or -not (Test-Path -LiteralPath $run)) {',
    '  $cand = @(Get-ChildItem -LiteralPath ' + psStr(installDir) + ' -Filter "*.exe" -ErrorAction SilentlyContinue |',
    '    Where-Object { $_.Name -match "QQ Agent" -and $_.Name -notmatch "Uninstall|卸载" } | Sort-Object LastWriteTime -Descending)',
    '  if ($cand.Count -gt 0) { $run = $cand[0].FullName; L ("重新定位可执行文件: " + $run) }',
    '}',
    'if ($run -and (Test-Path -LiteralPath $run)) {',
    '  try { Start-Process -FilePath $run; L ("已启动: " + $run) }',
    '  catch { L ("✗ 启动失败: " + $_.Exception.Message) }',
    '} else {',
    '  L "✗ 找不到可启动的程序，需要手动启动"',
    '}',
    'L "=== 结束 ==="',
    ''
  ];
  return { script: lines.join(nl), logPath };
}

/**
 * 生成"启动安装助手"的两个小文件（**实测必需**）：
 *
 * 为什么不直接 spawn：
 *   1. `spawn('powershell.exe', [...], { detached: true, stdio: 'ignore' })` 在本机
 *      （Electron 33 / Node 20）只拿到一个 pid，powershell **一句都不执行**，
 *      脚本永远不会跑（进程列表里也看不到）。cmd.exe 同姿势却正常 —— 是 powershell 特有的坑。
 *   2. 就算能起来，助手如果是应用的子进程，脚本里的 `taskkill /T`（按进程树杀）
 *      会把它自己一起杀掉，安装做到一半就断。
 *
 * 所以改用：**WMI 创建 wscript → 隐藏运行 powershell**。
 *   - 父进程变成 WmiPrvSE.exe，不在应用的进程树里 → `/T` 连坐不到它
 *   - WScript.Shell.Run(..., 0, False) 是 Windows 上隐藏启动控制台程序的标准姿势
 *
 * @returns {{vbs:string, launchPs:string}}
 */
export function buildLauncherFiles({ restoreScript, backupDir }) {
  const vbs = path.join(backupDir, 'restore.vbs');
  // ⚠️ VBS 必须是纯 ASCII：WScript 按 ANSI 读，注释里的中文会把文件搞成乱码。
  const vbsLines = [
    "' generated by QQ Agent updater: launch restore.ps1 hidden (0 = hidden, False = don't wait)",
    'Set sh = CreateObject("WScript.Shell")',
    'sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""' + restoreScript + '""", 0, False',
    ''
  ];
  const ascii = vbsLines.join('\r\n');
  if (/[^\x00-\x7F]/.test(ascii)) throw new Error('安装/备份路径含非 ASCII 字符，隐藏启动器不支持（VBS 只能 ANSI）');
  fs.writeFileSync(vbs, ascii, 'ascii');

  const launchPs = path.join(backupDir, 'launch.ps1');
  const cmdLine = 'wscript.exe "' + vbs + '"';
  const psLines = [
    '# 由 QQ Agent 更新器生成：经 WMI 创建 wscript，使助手进程的父进程变成 WmiPrvSE（脱离应用进程树）',
    '$cmd = ' + psStr(cmdLine),
    '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }',
    'if ($r.ReturnValue -ne 0) { Write-Error ("WMI Create 失败: " + $r.ReturnValue); exit 1 }',
    'exit 0',
    ''
  ];
  writeInstallScript(launchPs, psLines.join('\r\n'));
  return { vbs, launchPs };
}

/**
 * 安装更新：
 *  1) plugins / skills / snowluma + data/（不含 updates、electron-user-data）备份到临时目录
 *  2) 检查临时盘空间（备份 + 安装包 + 200MB 余量），不够且没 force → 返回 needSpace 交给界面询问
 *  3) 安装包**另拷一份到临时目录**（原路径在 data/updates 里，旧卸载器会连它一起删）
 *  4) 写还原脚本并脱离进程拉起：等应用退出 → 静默安装到原目录 → 还原 → 启动应用
 *
 * `source` 只为离线自测而留：{ path, version, total }，不传就用下载器的当前状态。
 */
export async function installUpdate({ force = false, dryRun = false, log = () => {}, source = null } = {}) {
  const st = source || getDownloadState();
  if (!st || !st.path || !fs.existsSync(st.path)) return { ok: false, error: '还没有下载完成的安装包' };
  if (!source && st.state !== 'done') return { ok: false, error: '安装包还没下载完（state=' + st.state + '）' };

  const version = String(st.version || 'latest');
  const appDir = ROOT;
  const installDir = path.resolve(ROOT, '..', '..');
  const dataDir = DATA_DIR;
  const runExe = findRunnableExe(installDir);
  const backupDir = path.join(os.tmpdir(), 'qq-agent-update-' + version);

  const userBytes = USER_DIRS.reduce((sum, d) => sum + dirBytesSkip(path.join(appDir, d), null), 0);
  const rootBytes = ROOT_KEEP_DIRS.reduce((sum, d) => sum + dirBytesSkip(path.join(installDir, d), null), 0);
  const backupBytes = userBytes + rootBytes + dirBytesSkip(dataDir, DATA_SKIP);
  const installBytes = Number(st.total) || 0;
  const free = freeBytesOf(os.tmpdir());
  const need = backupBytes + installBytes + 200 * 1024 * 1024;
  const info = {
    freeBytes: free, needBytes: need, backupBytes, installBytes, backupDir,
    installDir, appDir, dataDir, runExe, rootDirs: ROOT_KEEP_DIRS
  };

  if (free > 0 && free < need && !force) {
    log('[update] 空间不足：需要 ' + (need / 1048576).toFixed(0) + ' MB，可用 ' + (free / 1048576).toFixed(0) + ' MB');
    return { ok: false, needSpace: true, ...info };
  }

  // 安装包另拷一份到临时目录：data/updates 里的原件会被旧卸载器连同 $INSTDIR 一起删掉
  fs.mkdirSync(backupDir, { recursive: true });
  const installerCopy = path.join(backupDir, 'setup.exe');

  const { script, logPath } = buildInstallScript({
    installerPath: installerCopy, version, installDir, appDir, dataDir, runExe, backupDir
  });
  const restoreScript = path.join(backupDir, 'restore.ps1');
  writeInstallScript(restoreScript, script);
  const plan = { ...info, installerCopy, restoreScript, logPath, version };

  if (dryRun) return { ok: true, dryRun: true, ...plan };

  try {
    fs.copyFileSync(st.path, installerCopy);
  } catch (error) {
    return { ok: false, error: '复制安装包失败：' + (error?.message ?? error) };
  }

  // 备份：resources/app 下的用户目录 + 安装根目录的 data/ 与 tools/
  const copied = [];
  for (const d of USER_DIRS) {
    const src = path.join(appDir, d);
    if (!fs.existsSync(src)) continue;
    try {
      copyTree(src, path.join(backupDir, d));
      copied.push(d);
    } catch (error) { log('[update] 备份 ' + d + ' 失败：' + (error?.message ?? error)); }
  }
  let dataCopied = false;
  try {
    if (fs.existsSync(dataDir)) { copyTree(dataDir, path.join(backupDir, 'data')); dataCopied = true; }
  } catch (error) { log('[update] 备份 data 失败：' + (error?.message ?? error)); }
  const rootCopied = [];
  for (const d of ROOT_KEEP_DIRS) {
    const src = path.join(installDir, d);
    if (!fs.existsSync(src)) continue;
    try {
      copyTree(src, path.join(backupDir, d));
      rootCopied.push(d);
    } catch (error) { log('[update] 备份 ' + d + ' 失败：' + (error?.message ?? error)); }
  }
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify({
    at: new Date().toISOString(), version, installer: st.path, installerCopy,
    dirs: copied, rootDirs: rootCopied, dataCopied, appDir, installDir, dataDir, runExe, logPath
  }, null, 1), 'utf8');

  // 生成「隐藏启动器 + WMI 拉起」并在杀掉应用**之前**确认助手真的开始写日志 ——
  // 否则一旦助手没起来，应用被杀了就没人装、也没人把机器人拉回来（这是老的"点一下就消失"）。
  let launchers;
  try {
    launchers = buildLauncherFiles({ restoreScript, backupDir });
  } catch (error) {
    return { ok: false, error: '生成安装启动器失败：' + (error?.message ?? error), backupDir, restoreScript };
  }

  // 清掉旧的 install.log，否则会误判"助手已启动"
  try { fs.rmSync(logPath, { force: true }); } catch { /* ignore */ }

  let launchError = '';
  try {
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launchers.launchPs
    ], { timeout: 25000, windowsHide: true, stdio: 'ignore' });
  } catch (error) {
    launchError = String(error?.message ?? error);
  }
  let started = false;
  for (let i = 0; i < 48; i += 1) {
    if (fs.existsSync(logPath)) { started = true; break; }
    await new Promise((resolve) => { const t = setTimeout(resolve, 250); t.unref?.(); });
  }
  if (!started) {
    log('[update] 安装助手没启动：' + (launchError || 'install.log 未生成'));
    return {
      ok: false, error: '安装助手没能启动（install.log 未生成）：' + (launchError || '未知原因')
        + '。应用没有退出，可以重试；日志：' + logPath,
      backupDir, restoreScript, logPath, vbs: launchers.vbs, launchPs: launchers.launchPs
    };
  }

  log('[update] 安装助手已启动：备份在 ' + backupDir + '，日志 ' + logPath);
  return {
    ok: true, backupDir, restoreScript, vbs: launchers.vbs, launchPs: launchers.launchPs,
    dirs: copied, rootDirs: rootCopied, dataCopied, logPath, version,
    installer: st.path, installerCopy, installDir, appDir, dataDir, runExe
  };
}

/** 清理临时备份（用户选择取消安装时调用） */
export function cleanUpdateTemp() {
  const base = os.tmpdir();
  let removed = 0;
  try {
    for (const name of fs.readdirSync(base)) {
      if (!name.startsWith('qq-agent-update-')) continue;
      try { fs.rmSync(path.join(base, name), { recursive: true, force: true }); removed += 1; } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return { ok: true, removed };
}

export async function checkOnStartup(current, { onFound } = {}) {
  const cfg = updateCfg();
  if (!cfg.enabled || !cfg.checkOnStartup) return null;
  const info = await checkForUpdate({ current });
  if (info?.ok && info.hasUpdate && typeof onFound === 'function') {
    try { onFound(info); } catch { /* ignore */ }
  }
  return info;
}

// ── 自启动检查（模块被 import 后自动排一次，8 秒后执行）──────────
// app.js 会 import 本模块 → 应用起来 8 秒后自动检查一次（配置里可关）。
// 命中新版本且 autoDownload=true 时自动开始下载（阶段 1：只下载，不安装）。
export function localVersionFromPackage() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return String(pkg.version || '');
  } catch {
    return '';
  }
}

export function startAutoCheck({ delayMs = 8000, onFound } = {}) {
  if (process.env.QQ_AGENT_NO_AUTOCHECK === '1') return;
  const cfg = updateCfg();
  if (!cfg.enabled || !cfg.checkOnStartup) return;
  setTimeout(async () => {
    try {
      const current = localVersionFromPackage();
      const info = await checkForUpdate({ current });
      if (!info?.ok || !info.hasUpdate) return;
      try { if (typeof onFound === 'function') onFound(info); } catch { /* ignore */ }
      if (cfg.autoDownload && info.asset?.url) {
        await downloadUpdate(info.asset, info.latest);
      }
    } catch { /* 自动检查永远不能影响主流程 */ }
  }, Math.max(1000, Number(delayMs) || 8000)).unref?.();
}

// 模块加载即排一次（不需要 app.js 额外接线）
startAutoCheck();

