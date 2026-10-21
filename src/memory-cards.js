// 记忆卡读写（群聊 / 个人 / 基本事实）
// 布局：
//   data/memory-cards/general.json                 通用卡
//   data/memory-cards/<chatKey 下划线>/group.json  群卡
//   data/memory-cards/persons/<QQ>.json            个人卡
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const ROOT = path.join(DATA_DIR, 'memory-cards');
const PERSONS = path.join(ROOT, 'persons');
const read = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const dirOf = (chatKey) => path.join(ROOT, String(chatKey || '').replace(/[:\\/]/g, '_'));
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
const safeKey = (k) => String(k || '').replace(/[^\w:-]/g, '_');

function ensure(p) { fs.mkdirSync(p, { recursive: true }); }
function writeAtomic(file, data) {
  ensure(path.dirname(file));
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

export function listCards() {
  const general = getGeneral() || { id: 'general', name: '通用卡', summary: '', facts: [] };
  const groups = [];
  const persons = [];
  try {
    for (const d of fs.readdirSync(ROOT)) {
      const p = path.join(ROOT, d);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (!st.isDirectory()) continue;
      if (d === 'persons') {
        for (const f of fs.readdirSync(p).filter((x) => x.endsWith('.json'))) {
          const c = read(path.join(p, f));
          if (c) persons.push({ qq: c.qq || f.replace(/\.json$/, ''), name: c.name || '', summary: c.summary || '', groups: (c.groups || []).length, notes: (c.notes || []).length, facts: (c.facts || []).length, updatedAt: c.updatedAt || '' });
        }
      } else {
        const g = read(path.join(p, 'group.json'));
        if (g) groups.push({ chatKey: g.chatKey || g.id || d.replace(/^group_/, 'group:').replace(/^private_/, 'private:'), name: g.name || '', summary: g.summary || '', members: (g.members || []).length, facts: (g.facts || []).length, updatedAt: g.updatedAt || '' });
      }
    }
  } catch { /* ignore */ }
  persons.sort((a, b) => (b.groups || 0) - (a.groups || 0) || String(a.name).localeCompare(String(b.name), 'zh'));
  groups.sort((a, b) => String(a.chatKey).localeCompare(String(b.chatKey)));
  return { general, groups, persons };
}

export function getPerson(qq) { return read(path.join(PERSONS, safeKey(qq) + '.json')); }
export function getGroup(chatKey) { return read(path.join(dirOf(chatKey), 'group.json')); }
export function getGeneral() {
  // 迁移后：优先取 generals/ 里的全局卡；没有再回退老的单文件
  try {
    const all = listGenerals();
    const g = all.find((x) => x.scope === 'global') || all[0];
    if (g) return g;
  } catch { /* ignore */ }
  return read(path.join(ROOT, 'general.json'));
}

export function updatePerson(qq, patch) {
  const cur = getPerson(qq);
  if (!cur) return { ok: false, error: 'not_found' };
  const allowed = ['name', 'summary', 'tone', 'facts', 'prefs', 'events', 'pending', 'notes', 'impressions', 'aliases'];
  const next = { ...cur, updatedAt: new Date().toISOString() };
  for (const k of allowed) if (patch && patch[k] !== undefined) next[k] = patch[k];
  writeAtomic(path.join(PERSONS, safeKey(qq) + '.json'), next);
  return { ok: true, card: next };
}

export function updateGroup(chatKey, patch) {
  const file = path.join(dirOf(chatKey), 'group.json');
  const cur = read(file);
  if (!cur) return { ok: false, error: 'not_found' };
  const allowed = ['name', 'summary', 'facts', 'topics', 'members'];
  const next = { ...cur, updatedAt: new Date().toISOString() };
  for (const k of allowed) if (patch && patch[k] !== undefined) next[k] = patch[k];
  writeAtomic(file, next);
  return { ok: true, card: next };
}

export function updateGeneral(patch) {
  const file = path.join(ROOT, 'general.json');
  const cur = read(file) || { id: 'general', name: '通用卡' };
  const allowed = ['name', 'summary', 'facts', 'prefs', 'impressionScope'];
  const next = { ...cur, updatedAt: new Date().toISOString() };
  for (const k of allowed) if (patch && patch[k] !== undefined) next[k] = patch[k];
  writeAtomic(file, next);
  return { ok: true, card: next };
}

export function deletePerson(qq) {
  const file = path.join(PERSONS, safeKey(qq) + '.json');
  if (!fs.existsSync(file)) return { ok: false, error: 'not_found' };
  fs.renameSync(file, file + '.deleted-' + Date.now());
  return { ok: true };
}

export function stats() {
  const { general, groups, persons } = listCards();
  return {
    general: !!general,
    groups: groups.length,
    persons: persons.length,
    root: ROOT
  };
}

// ── 多张通用卡 ────────────────────────────────────────────────
const GENERALS = path.join(ROOT, 'generals');
const safeGid = (id) => String(id || '').replace(/[^\w-]/g, '_');

export function listGenerals() {
  const out = [];
  try {
    for (const f of fs.readdirSync(GENERALS)) {
      if (!f.endsWith('.json') || f.includes('.deleted')) continue;
      const c = read(path.join(GENERALS, f));
      if (c && c.id) out.push(c);
    }
  } catch { /* ignore */ }
  // 全局默认排最前
  out.sort((a, b) => (b.scope === 'global' ? 1 : 0) - (a.scope === 'global' ? 1 : 0));
  return out;
}

export function getGeneralById(id) {
  return read(path.join(GENERALS, safeGid(id) + '.json'));
}

export function createGeneral(patch = {}) {
  const id = 'g_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5);
  const card = {
    id,
    name: String(patch.name || '新通用卡'),
    scope: 'normal',
    summary: String(patch.summary || ''),
    facts: Array.isArray(patch.facts) ? patch.facts : [],
    prefs: Array.isArray(patch.prefs) ? patch.prefs : [],
    updatedAt: new Date().toISOString()
  };
  writeAtomic(path.join(GENERALS, id + '.json'), card);
  return { ok: true, card };
}

export function updateGeneralById(id, patch = {}) {
  const cur = getGeneralById(id);
  if (!cur) return { ok: false, error: 'not_found' };
  const allowed = ['name', 'summary', 'facts', 'prefs', 'scope'];
  const next = { ...cur, updatedAt: new Date().toISOString() };
  for (const k of allowed) if (patch[k] !== undefined) next[k] = patch[k];
  // 设为全局时，其它卡自动降级
  if (next.scope === 'global') {
    for (const g of listGenerals()) {
      if (g.id !== next.id && g.scope === 'global') {
        const f2 = path.join(GENERALS, safeGid(g.id) + '.json');
        writeAtomic(f2, { ...g, scope: 'normal', updatedAt: new Date().toISOString() });
      }
    }
  }
  writeAtomic(path.join(GENERALS, safeGid(id) + '.json'), next);
  return { ok: true, card: next };
}

export function deleteGeneral(id) {
  const cur = getGeneralById(id);
  if (!cur) return { ok: false, error: 'not_found' };
  if (cur.scope === 'global') return { ok: false, error: 'global_protected' };
  const file = path.join(GENERALS, safeGid(id) + '.json');
  fs.renameSync(file, file + '.deleted-' + Date.now());
  return { ok: true };
}

/** 按会话解析该用哪张通用卡：persona.generalCardId → 全局默认 */
export function resolveGeneralForChat(chatKey, cfg = null) {
  const c = cfg || (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8')); } catch { return {}; } })();
  const pid = String(c?.personaByChat?.[String(chatKey || '')]?.personaId || '');
  let wanted = '';
  if (pid) {
    const persona = (Array.isArray(c?.personas) ? c.personas : []).find((p) => p && p.id === pid);
    if (persona?.generalCardId) wanted = String(persona.generalCardId);
  }
  if (wanted) {
    const hit = getGeneralById(wanted);
    if (hit) return hit;
  }
  const all = listGenerals();
  return all.find((g) => g.scope === 'global') || all[0] || null;
}

export function statsGenerals() {
  const all = listGenerals();
  return { count: all.length, globalId: (all.find((g) => g.scope === 'global') || {}).id || '' };
}
