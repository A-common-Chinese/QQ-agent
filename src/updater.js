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
      return { ...cached, current, cached: true };
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

