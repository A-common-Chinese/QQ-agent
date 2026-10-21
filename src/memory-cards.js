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
  const general = read(path.join(ROOT, 'general.json')) || { id: 'general', name: '通用卡', summary: '', facts: [] };
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
export function getGeneral() { return read(path.join(ROOT, 'general.json')); }

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
