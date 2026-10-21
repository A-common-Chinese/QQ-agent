// 人格切换感知（确定性插件）
//
// 目标：模型能意识到「自己刚被换了人格」，并在需要时产生反应。
// 反应内容由用户在插件设置里填写（noticeText）——留空 = 完全不注入，交给模型现有提示词自行判断。
//
// 实现（零模型调用、零核心改动）：
//   ① before-context：每轮组装提示词前，读 data/config.json 里的 personaByChat，
//      和上次记录比对；变了就写一条 data/persona-switch-log.json，并登记"待注入提示"。
//   ② promptSections：提示词组装过程中被调用，有待注入提示且 noticeText 非空时，
//      返回一段动态片段（注入到系统提示的技能区，priority 95）。
//
// 只读 config.json（按 mtime 缓存），不写它 —— 人格数据归核心/控制台管。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let getCfg = () => ({});
let apiRef = null;

// ── 找数据目录（优先 env；安装版/便携版两种布局都试）──────────────
let dataDirCache = '';
function dataDir() {
  if (dataDirCache) return dataDirCache;
  const cands = [
    process.env.QQ_AGENT_DATA_DIR,
    path.resolve(HERE, '../../../../data'), // <安装根>/data（安装版）
    path.resolve(HERE, '../../../data'),    // <app>/data（便携版/开发）
  ].filter(Boolean);
  for (const d of cands) {
    try { if (fs.existsSync(path.join(d, 'config.json'))) { dataDirCache = d; return d; } } catch { /* ignore */ }
  }
  dataDirCache = cands[0] || '';
  return dataDirCache;
}

// ── 读 app 配置（mtime 缓存，避免每轮都解析 200KB）──────────────────
const cfgCache = { file: '', mtime: 0, data: null };
function appConfig() {
  const file = path.join(dataDir(), 'config.json');
  try {
    const st = fs.statSync(file);
    if (cfgCache.file === file && cfgCache.mtime === st.mtimeMs && cfgCache.data) return cfgCache.data;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    Object.assign(cfgCache, { file, mtime: st.mtimeMs, data });
    return data;
  } catch {
    return cfgCache.data || null;
  }
}

function cardName(cfg, id) {
  if (!id) return '';
  const list = Array.isArray(cfg?.personas) ? cfg.personas : [];
  const hit = list.find((p) => p && p.id === id);
  return hit ? String(hit.name || id) : String(id);
}
function currentPersonaId(cfg, chatKey) {
  return String(cfg?.personaByChat?.[chatKey]?.personaId || '');
}

// ── 状态（内存）──────────────────────────────────────────────────
const lastSeen = new Map();   // chatKey -> personaId（'' = 未分配/静默）
const pending = new Map();    // chatKey -> { at, from, to, until }

function appendLog(rec) {
  try {
    const file = path.join(dataDir(), 'persona-switch-log.json');
    let list = [];
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(raw)) list = raw;
      else if (Array.isArray(raw?.entries)) list = raw.entries;
    } catch { /* 首次 */ }
    list.push(rec);
    if (list.length > 200) list = list.slice(-200);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: list }, null, 1), 'utf8');
    fs.renameSync(tmp, file);
  } catch { /* 日志失败不影响主流程 */ }
}

export function setup(api) {
  apiRef = api;
  try { if (typeof api?.config === 'function') getCfg = api.config; } catch { /* ignore */ }
}

// ① 每轮组装提示词之前：检测人格是否被切换
export const hooks = {
  'before-context': (ctx) => {
    try {
      const c = getCfg() || {};
      if (c.enabled === false) return;
      const chatKey = String(ctx?.chatKey || '');
      if (!chatKey) return;
      const scope = String(c.applyTo || 'all');
      if (scope === 'groups' && !chatKey.startsWith('group:')) return;
      if (scope === 'private' && !chatKey.startsWith('private:')) return;

      const cfg = appConfig();
      if (!cfg) return;
      const pid = currentPersonaId(cfg, chatKey);
      const seen = lastSeen.has(chatKey) ? lastSeen.get(chatKey) : undefined;

      // 首次见到该会话：按 triggerOnFirstAssign 决定是否算切换
      if (seen === undefined) {
        lastSeen.set(chatKey, pid);
        if (!c.triggerOnFirstAssign || !pid) return;
      } else if (seen === pid) {
        return; // 没变
      }

      const fromId = seen === undefined ? '' : seen;
      const from = cardName(cfg, fromId);
      const to = cardName(cfg, pid);
      const rec = { at: Date.now(), chatKey, fromId, toId: pid, from, to };
      appendLog(rec);
      const until = c.oneShot === false ? Date.now() + Math.max(1, Number(c.persistMinutes) || 0) * 60000 : 0;
      pending.set(chatKey, { ...rec, until });
      lastSeen.set(chatKey, pid);
      try { apiRef?.log?.(`人格切换 ${chatKey}：${from || '(无)'} → ${to || '(无)'}（${pid ? '已排队提示' : '未分配→静默'}）`); } catch { /* ignore */ }
    } catch { /* 钩子永远不能影响主流程 */ }
  }
};

// ② 提示词组装期间：有待注入提示且 noticeText 非空时，返回一段动态片段
export const promptSections = (context) => {
  try {
    const c = getCfg() || {};
    if (c.enabled === false) return [];
    const text = String(c.noticeText || '').trim();
    if (!text) return [];                 // 空 = 不注入（交给模型现有提示词）
    const chatKey = String(context?.chatKey || '');
    if (!chatKey) return [];
    const p = pending.get(chatKey);
    if (!p) return [];
    if (p.until && Date.now() > p.until) { pending.delete(chatKey); return []; }

    const when = new Date(p.at).toLocaleString('zh-CN', { hour12: false });
    const withNames = c.showSourceName !== false;
    const head = withNames
      ? `你在 ${when} 从「${p.from || '(无)'}」切换到了「${p.to || '(无)'}」。`
      : `你在 ${when} 被切换了人格。`;
    const content = `【人格切换】${head}\n${text}\n（这条提示只出现一次，之后按你现在的设定继续。）`;

    if (c.oneShot !== false) pending.delete(chatKey); // 只提示一次
    return [{ id: 'persona-switch-notice', title: '人格切换', content, priority: 95 }];
  } catch {
    return [];
  }
};

export function dispose() {
  lastSeen.clear();
  pending.clear();
}
