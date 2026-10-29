// 记忆卡读写（群聊 / 个人 / 基本事实）
// 布局：
//   data/memory-cards/general.json                 通用卡
//   data/memory-cards/<chatKey 下划线>/group.json  群卡
//   data/memory-cards/persons/<QQ>.json            个人卡
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { resolveKeys, writeKeys, canonicalKey, personCanonical } from './identity-links.js';

const ROOT = path.join(DATA_DIR, 'memory-cards');
const PERSONS = path.join(ROOT, 'persons');
const MESSAGES = path.join(DATA_DIR, 'messages');
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

export function getPerson(qq) {
  const key = personCanonical(qq);
  return read(path.join(PERSONS, safeKey(key) + '.json'));
}
export function getGroup(chatKey) {
  // 通道映射：把关联会话的群卡合并成一张虚拟卡（merge/mirror 都走这里）
  const keys = resolveKeys(chatKey);
  const cards = keys.map((k) => read(path.join(dirOf(k), 'group.json'))).filter(Boolean);
  if (!cards.length) return null;
  if (cards.length === 1) return cards[0];
  const canon = canonicalKey(chatKey);
  const base = { ...(cards.find((c) => String(c.chatKey || '') === canon) || cards[0]) };
  const uniq = (arr) => [...new Set(arr.map((x) => JSON.stringify(x)))].map((x) => JSON.parse(x));
  for (const c of cards) {
    base.facts = uniq([...(base.facts || []), ...(c.facts || [])]);
    base.topics = uniq([...(base.topics || []), ...(c.topics || [])]);
    const mm = new Map();
    for (const mem of [...(base.members || []), ...(c.members || [])]) {
      const id = String(mem?.id || mem?.name || '');
      if (!id) continue;
      const cur = mm.get(id);
      mm.set(id, cur ? { ...cur, msgs: Math.max(Number(cur.msgs) || 0, Number(mem.msgs) || 0) } : mem);
    }
    base.members = [...mm.values()];
    if (!base.summary && c.summary) base.summary = c.summary;
    if ((!base.name || base.name === base.chatKey) && c.name) base.name = c.name;
  }
  return base;
}
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
  qq = personCanonical(qq);
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
  // mirror 模式：同步写到映射的另一侧
  for (const k of writeKeys(key)) {
    if (k === key) { writeAtomic(file, next); continue; }
    writeAtomic(path.join(dirOf(k), 'group.json'), { ...next, chatKey: k });
  }
  return { ok: true, card: next };
}

const PERSON_FIELDS = ['name', 'summary', 'tone', 'facts', 'prefs', 'events', 'pending', 'notes', 'impressions', 'aliases'];

/** 个人卡：不存在就建（自动生成用），存在则合并字段 */
export function upsertPerson(qq, patch = {}) {
  const id = String(personCanonical(qq) || '').trim();
  if (!id) return { ok: false, error: 'missing_qq' };
  const cur = getPerson(id) || {
    qq: id,
    name: String(patch.name || id),
    summary: '',
    tone: '',
    facts: [],
    prefs: [],
    events: [],
    pending: [],
    notes: [],
    impressions: [],
    aliases: []
  };
  const next = { ...cur, qq: id, updatedAt: new Date().toISOString() };
  for (const k of PERSON_FIELDS) if (patch && patch[k] !== undefined) next[k] = patch[k];
  writeAtomic(path.join(PERSONS, safeKey(id) + '.json'), next);
  return { ok: true, card: next, created: !getPerson(id) ? false : true };
}

/** 会话出现时先建一张空卡，保证记忆页能看到这个会话（内容由批量整理补） */
export function ensureGroupCard(chatKey, name = '') {
  const key = String(chatKey || '').trim();
  if (!key) return { ok: false, error: 'missing_chatKey' };
  const file = path.join(dirOf(key), 'group.json');
  if (read(file)) return { ok: true, existing: true };
  const card = {
    chatKey: key,
    name: String(name || key),
    summary: '',
    facts: [],
    topics: [],
    members: [],
    updatedAt: new Date().toISOString()
  };
  writeAtomic(file, card);
  return { ok: true, existing: false, card };
}

/** 群/私聊卡：不存在就建（自动生成用），存在则合并字段 */
export function upsertGroup(chatKey, patch = {}) {
  const key = String(chatKey || '').trim();
  if (!key) return { ok: false, error: 'missing_chatKey' };
  const file = path.join(dirOf(key), 'group.json');
  const cur = read(file) || {
    chatKey: key,
    name: String(patch.name || key),
    summary: '',
    facts: [],
    topics: [],
    members: []
  };
  const next = { ...cur, chatKey: key, updatedAt: new Date().toISOString() };
  for (const k of ['name', 'summary', 'facts', 'topics', 'members']) {
    if (patch && patch[k] !== undefined) next[k] = patch[k];
  }
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
  const file = path.join(PERSONS, safeKey(personCanonical(qq)) + '.json');
  // 幂等：不存在也算成功（避免重复点击/双事件导致删成功后又报 404）
  if (!fs.existsSync(file)) return { ok: true, removed: false };
  fs.renameSync(file, file + '.deleted-' + Date.now());
  return { ok: true, removed: true };
}

/**
 * 批量清理个人卡
 * mode: 'no-content'（没有任何事实/印象等实质内容，只剩名称与概述）
 *      | 'empty'（连名称/概述/语气都空）
 *      | 'stale'（updatedAt 早于 olderThanDays 天）
 * qqs: 显式指定要删的号（优先级最高）
 */
/** 扫一遍消息存档，统计每个 QQ 的发言数（群聊 / 私聊分开），60 秒缓存 */
let archiveCache = null;
export function archivePersonCounts({ maxAgeMs = 60000 } = {}) {
  if (archiveCache && Date.now() - archiveCache.at < maxAgeMs) return archiveCache.map;
  const map = new Map();
  try {
    for (const f of fs.readdirSync(MESSAGES)) {
      if (!f.endsWith('.json')) continue;
      let data;
      try { data = JSON.parse(fs.readFileSync(path.join(MESSAGES, f), 'utf8')); } catch { continue; }
      const chatKey = String(data.chatKey || f.replace(/\.json$/, '').replace('_', ':'));
      const isGroup = chatKey.startsWith('group:');
      for (const m of (data.messages || [])) {
        const uid = String(m.senderId ?? m.sender_id ?? '').trim();
        if (!uid) continue;
        const rec = map.get(uid) || { group: 0, private: 0, total: 0 };
        if (isGroup) rec.group += 1; else rec.private += 1;
        rec.total += 1;
        map.set(uid, rec);
      }
    }
  } catch { /* 存档读不到就退化为卡片统计 */ }
  archiveCache = { at: Date.now(), map };
  return map;
}

export function prunePersons({ mode = 'no-content', olderThanDays = 30, maxMsgs = 1, scope = 'group', dryRun = true, qqs = [] } = {}) {
  ensure(PERSONS);
  const files = fs.readdirSync(PERSONS).filter((f) => f.endsWith('.json'));
  const arr = (v) => (Array.isArray(v) ? v : []);
  const str = (v) => String(v || '').trim();
  const wanted = new Set((qqs || []).map((x) => String(x)));
  const cut = Date.now() - Math.max(1, Number(olderThanDays) || 30) * 24 * 3600 * 1000;
  const matched = [];
  for (const f of files) {
    const full = path.join(PERSONS, f);
    const c = read(full);
    if (!c) continue;
    const qq = String(c.qq || f.replace(/\.json$/, ''));
    if (wanted.size) {
      if (wanted.has(qq)) matched.push({ qq, name: str(c.name), file: full });
      continue;
    }
    // impressions 可能是对象 { general, byChat }
    const imp = c.impressions;
    let impCount = 0;
    if (Array.isArray(imp)) impCount = imp.length;
    else if (imp && typeof imp === 'object') {
      const g = str(imp.general);
      if (g && g.indexOf('暂无') < 0) impCount += 1;
      const by = imp.byChat;
      if (by && typeof by === 'object') impCount += Object.values(by).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
    }
    const hasData = arr(c.facts).length || arr(c.prefs).length || arr(c.preferences).length
      || arr(c.events).length || arr(c.pending).length || impCount
      || arr(c.notes).length || arr(c.groupImpressions).length || arr(c.privateImpressions).length
      || str(c.tone) || str(c.generalImpression);
    const archive = archivePersonCounts();
    const ac = archive.get(qq);
    const cardGroupMsgs = arr(c.groups).reduce((n, g) => n + (String(g && g.chatKey || '').startsWith('group:') ? (Number(g && g.msgs) || 0) : 0), 0);
    const cardTotalMsgs = arr(c.groups).reduce((n, g) => n + (Number(g && g.msgs) || 0), 0);
    const groupMsgs = ac ? ac.group : cardGroupMsgs;
    const totalMsgs = ac ? ac.total : cardTotalMsgs;
    const usedMsgs = scope === 'all' ? totalMsgs : groupMsgs;
    if (mode === 'empty') {
      if (!hasData && !str(c.summary) && !str(c.name)) matched.push({ qq, name: str(c.name), file: full });
    } else if (mode === 'stale') {
      if (Number(c.updatedAt || 0) < cut) matched.push({ qq, name: str(c.name), file: full });
    } else if (mode === 'low-activity') {
      if (usedMsgs <= Math.max(0, Number(maxMsgs) || 0)) matched.push({ qq, name: str(c.name), file: full, groupMsgs, totalMsgs });
    } else if (!hasData) {
      // no-content：只剩名称/概述
      matched.push({ qq, name: str(c.name), file: full, groupMsgs, totalMsgs });
    }
  }
  const out = {
    count: matched.length, dryRun: !!dryRun, deleted: [], scope,
    sample: matched.slice(0, 20).map((x) => ({ qq: x.qq, name: x.name, group: x.groupMsgs, total: x.totalMsgs }))
  };
  if (!dryRun) {
    for (const m of matched) {
      try { fs.renameSync(m.file, m.file + '.deleted-' + Date.now()); out.deleted.push(m.qq); } catch { /* 忽略 */ }
    }
    out.count = out.deleted.length;
  }
  return out;
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

// ── 话题卡（data/memory-cards/<chatKey 下划线>/topic_*.json）──────────────
//
// 一张话题卡长这样（注入侧读的就是这几个字段，见 memory-cards-prompt.js:122-143）：
//   { id: 'topic:group:123:fact-xxx', chatKey: 'group:123',
//     title: '周末爬山', summary: '一句话概览', body: '详细正文',
//     keywords: ['爬山', '周末'], updatedAt: 'ISO-8601' }
//
// ⚠️ 文件名与 id 的映射**不是**简单 sanitize：历史文件叫
//    topic_group_123_fact-xxx.json，而文件里的 id 是 topic:group:123:fact-xxx。
//    直接按 id 拼文件名会得到 topic_topic_group_123_fact-xxx.json —— 同一张卡
//    写出第二个文件，列表/注入都会看到重复卡。这里与 memory-bundle.js 的
//    writeTopic 用同一套映射：**先按 id 扫一遍现有文件，命中就复用那个文件名；
//    没命中才新建**（新建用历史命名：去掉 topic: 前缀后 sanitize）。
const TOPIC_FILE_RE = /^topic_.*\.json$/;
const TOPIC_ALLOWED = ['title', 'body', 'summary', 'keywords', 'updatedAt'];
const isChatKey = (k) => /^(group|private):\d+$/.test(String(k || ''));
const timeOf = (v) => {
  const t = Date.parse(String(v || ''));
  return Number.isFinite(t) ? t : 0;
};

/** 关键词归一化：数组或字符串 → 去空、去重、限长 */
function normalizeKeywords(v) {
  const list = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[,，、\s]+/);
  const out = [];
  for (const raw of list) {
    const k = String(raw || '').trim();
    if (k && !out.includes(k)) out.push(k.slice(0, 30));
    if (out.length >= 40) break;
  }
  return out;
}

/** 读出某个会话目录下的全部话题卡文件（{ file, card }） */
function readTopicFiles(chatKey) {
  const dir = dirOf(chatKey);
  const out = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!TOPIC_FILE_RE.test(f) || f.includes('.deleted')) continue;
      const card = read(path.join(dir, f));
      if (card && card.id) out.push({ file: path.join(dir, f), card });
    }
  } catch { /* 目录不存在 = 没有话题卡 */ }
  return out;
}

/**
 * 话题卡 id → 落盘文件路径（复用同一映射，见上方注释）。
 * 存量文件按 id 命中优先；否则按历史命名新建。
 */
function findTopicFile(chatKey, id) {
  const wanted = String(id || '');
  for (const { file, card } of readTopicFiles(chatKey)) {
    if (String(card.id) === wanted) return file;
  }
  const clean = wanted.replace(/^topic:/, '').replace(/[^\w-]/g, '_');
  return path.join(dirOf(chatKey), 'topic_' + clean + '.json');
}

/** 该会话的全部话题卡（按 updatedAt 倒序；chatKey 缺省补上，方便界面/导出使用） */
export function listTopics(chatKey) {
  if (!isChatKey(chatKey)) return [];
  const list = readTopicFiles(chatKey).map(({ card }) => ({ ...card, chatKey: card.chatKey || String(chatKey) }));
  list.sort((a, b) => timeOf(b.updatedAt) - timeOf(a.updatedAt) || String(a.title || '').localeCompare(String(b.title || ''), 'zh'));
  return list;
}

/** 按 id 取一张话题卡（找不到返回 null） */
export function getTopic(chatKey, id) {
  if (!isChatKey(chatKey) || !id) return null;
  const wanted = String(id);
  for (const { card } of readTopicFiles(chatKey)) {
    if (String(card.id) === wanted) return { ...card, chatKey: card.chatKey || String(chatKey) };
  }
  return null;
}

/** 新建话题卡（字段白名单 title/body/summary/keywords；原子写） */
export function createTopic(chatKey, patch = {}) {
  if (!isChatKey(chatKey)) return { ok: false, error: 'bad_chatkey' };
  const key = String(chatKey);
  const wanted = String(patch.id || '').trim();
  let id = wanted || 'topic:' + key + ':fact-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  if (!id.startsWith('topic:')) id = 'topic:' + id;
  id = id.replace(/[^\w:-]/g, '_');            // id 只允许 \w : -，避免奇怪字符进路径
  if (getTopic(key, id)) return { ok: false, error: 'exists', id };
  const now = new Date().toISOString();
  const card = {
    id,
    chatKey: key,
    title: String(patch.title || '').trim().slice(0, 80) || '未命名话题',
    summary: String(patch.summary || '').trim().slice(0, 200),
    body: String(patch.body || '').trim(),
    keywords: normalizeKeywords(patch.keywords),
    createdAt: now,
    updatedAt: Number.isFinite(Date.parse(String(patch.updatedAt || ''))) ? new Date(patch.updatedAt).toISOString() : now
  };
  writeAtomic(findTopicFile(key, id), card);
  return { ok: true, card };
}

/** 更新话题卡（id / chatKey 不可改；写回**同一个**存量文件，不产生重复文件） */
export function updateTopic(chatKey, id, patch = {}) {
  if (!isChatKey(chatKey) || !id) return { ok: false, error: 'not_found' };
  const key = String(chatKey);
  const wanted = String(id);
  const file = findTopicFile(key, wanted);
  const cur = read(file);
  if (!cur || String(cur.id) !== wanted) return { ok: false, error: 'not_found' };
  const next = { ...cur };
  for (const k of TOPIC_ALLOWED) if (patch && patch[k] !== undefined) next[k] = patch[k];
  next.id = cur.id;
  next.chatKey = cur.chatKey || key;
  next.title = String(next.title || '').trim().slice(0, 80) || '未命名话题';
  next.summary = String(next.summary || '').trim().slice(0, 200);
  next.body = String(next.body || '');
  next.keywords = normalizeKeywords(next.keywords);
  const ts = Date.parse(String((patch && patch.updatedAt) || ''));
  next.updatedAt = Number.isFinite(ts) ? new Date(ts).toISOString() : new Date().toISOString();
  writeAtomic(file, next);
  return { ok: true, card: next };
}

/** 删除话题卡：和现有 deletePerson 一致，重命名为 .deleted 备份而不是真删 */
export function deleteTopic(chatKey, id) {
  if (!isChatKey(chatKey) || !id) return { ok: false, error: 'not_found' };
  const file = findTopicFile(chatKey, String(id));
  const cur = read(file);
  if (!cur || String(cur.id) !== String(id)) return { ok: false, error: 'not_found' };
  fs.renameSync(file, file + '.deleted-' + Date.now());
  return { ok: true };
}
