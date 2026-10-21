// 自动备份：把关键数据 + 用户装的插件/技能 复制到备份目录，按份数保留
//
// 设计：
//   · 数据类：config.json / memory / memory-cards / memory-v2 / semantic-cards /
//             messages / sessions / presence.json / dsh-sessions.json
//   · 资源类：resources/app 下的 plugins / skills（snowluma 太大且可重新下载，默认不备）
//   · 落点：backup.dir（默认 D:\QQ-Agent-Backups\auto）下的 <时间戳>/
//   · 保留：backup.keep 份（默认 7），超出自动删最旧的
//   · 时机：启动 30 秒后一次 + 每 backup.everyHours 小时一次
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT, getConfig } from './config.js';

const DATA_ITEMS = [
  'config.json',
  'memory',
  'memory-cards',
  'memory-v2',
  'semantic-cards',
  'messages',
  'sessions',
  'presence.json',
  'presence.log',
  'dsh-sessions.json'
];
const RESOURCE_ITEMS = ['plugins', 'skills'];

const DEFAULT_DIR = 'D:/QQ-Agent-Backups/auto';

function cfgBackup() {
  try { return getConfig()?.backup || {}; } catch { return {}; }
}
function rootDir() {
  const c = cfgBackup();
  return String(c.dir || DEFAULT_DIR).replace(/[\\/]+$/, '');
}
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function dirSize(dir) {
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
function copyInto(srcRoot, dstRoot, name) {
  const src = path.join(srcRoot, name);
  if (!fs.existsSync(src)) return false;
  const dst = path.join(dstRoot, name);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true, force: true });
  return true;
}
/** 只保留最近 keep 份 */
function prune(root, keep) {
  let dirs = [];
  try {
    dirs = fs.readdirSync(root)
      .filter((n) => /^\d{4}-\d{2}-\d{2}_\d{6}$/.test(n))
      .map((n) => path.join(root, n))
      .filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } })
      .sort();
  } catch { return 0; }
  const extra = dirs.slice(0, Math.max(0, dirs.length - keep));
  let removed = 0;
  for (const d of extra) {
    try { fs.rmSync(d, { recursive: true, force: true }); removed += 1; } catch { /* ignore */ }
  }
  return removed;
}

/**
 * 执行一次备份
 * @returns {{ok:boolean, dir?:string, items?:number, bytes?:number, pruned?:number, error?:string}}
 */
export function runBackup({ reason = 'auto', log = () => {} } = {}) {
  const c = cfgBackup();
  if (c.enabled === false) return { ok: false, error: 'backup disabled' };
  try {
    const root = rootDir();
    const dir = path.join(root, stamp());
    fs.mkdirSync(dir, { recursive: true });
    const copied = [];
    for (const name of DATA_ITEMS) {
      if (c.includeMessages === false && (name === 'messages' || name === 'sessions')) continue;
      if (copyInto(DATA_DIR, path.join(dir, 'data'), name)) copied.push('data/' + name);
    }
    if (c.includeResources !== false) {
      for (const name of RESOURCE_ITEMS) {
        if (copyInto(ROOT, path.join(dir, 'app'), name)) copied.push('app/' + name);
      }
    }
    const bytes = dirSize(dir);
    let version = '';
    try { version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || ''; } catch { version = ''; }
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      at: new Date().toISOString(), reason, version, items: copied, bytes
    }, null, 1), 'utf8');
    const pruned = prune(root, Math.max(1, Number(c.keep) || 7));
    log(`[backup] 完成：${dir}（${copied.length} 项 / ${(bytes / 1048576).toFixed(1)} MB）${pruned ? `，清理 ${pruned} 份旧备份` : ''}`);
    return { ok: true, dir, items: copied.length, bytes, pruned };
  } catch (error) {
    log('[backup] 失败：' + (error?.message || error));
    return { ok: false, error: String(error?.message || error) };
  }
}

/** 列出已有备份（新的在前） */
export function listBackups() {
  const root = rootDir();
  let dirs = [];
  try {
    dirs = fs.readdirSync(root).filter((n) => /^\d{4}-\d{2}-\d{2}_\d{6}$/.test(n)).sort().reverse();
  } catch { return []; }
  return dirs.map((n) => {
    const p = path.join(root, n);
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(path.join(p, 'manifest.json'), 'utf8')); } catch { /* ignore */ }
    return { name: n, path: p, bytes: manifest?.bytes || dirSize(p), version: manifest?.version || '', reason: manifest?.reason || '' };
  });
}

let timer = null;
/** 启动自动备份：启动 30 秒后一次，之后每 everyHours 小时一次 */
export function startAutoBackup(log = console.log) {
  const c = cfgBackup();
  if (c.enabled === false) { log('[backup] 已关闭（backup.enabled=false）'); return; }
  const hours = Math.max(1, Number(c.everyHours) || 12);
  const first = setTimeout(() => {
    try { runBackup({ reason: 'startup', log }); } catch { /* ignore */ }
    if (timer) clearInterval(timer);
    timer = setInterval(() => { try { runBackup({ reason: 'interval', log }); } catch { /* ignore */ } }, hours * 3600 * 1000);
    timer.unref?.();
  }, 30 * 1000);
  first.unref?.();
  log(`[backup] 已启用：每 ${hours} 小时一次，保留 ${Math.max(1, Number(c.keep) || 7)} 份，位置 ${rootDir()}`);
}

export function stopAutoBackup() {
  if (timer) { clearInterval(timer); timer = null; }
}
