// 记忆导出 / 导入（自描述的 .qqmem 包）
//
// 为什么自带「解析式」：QQ 号可能被封、要换号；上下文也可能爆。这个包要能脱离
// 当前版本被读懂 —— 所以文件里除了数据，还写明：来自哪、每条的字段含义、
// 时间字段是什么格式、冲突时怎么合并。导入方（本程序或以后的版本）按 schema 解。
//
// 文件结构：
//   magic / bundleVersion  身份与版本
//   generator              谁导出的（程序版本 + 时间）
//   source                 来自哪（人设名、涉及的会话）
//   schema                 解析式：各段的键、字段类型、时间格式、合并规则
//   payload                数据本体（general / group / person / topic 四类卡）
//   counts                 数量摘要（导入方先看这个再决定要不要解 payload）
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { redactText } from './safe-mode.js';

const ROOT = path.join(DATA_DIR, 'memory-cards');
const MAGIC = 'qq-agent-memory-bundle';
export const BUNDLE_VERSION = 1;

/** 从目录名 / meta / id 里还原 chatKey（group_759694210 → group:759694210） */
export function deriveChatKey(raw, card = null) {
  const fromMeta = String(card?.meta?.chatKey || card?.meta?.chat || '').trim();
  if (/^(group|private):\d+$/.test(fromMeta)) return fromMeta;
  let t = String(raw ?? '').trim();
  const dirLike = /^(group|private)_(\d+)$/.exec(t);
  if (dirLike) return dirLike[1] + ':' + dirLike[2];
  const keyLike = /^(group|private):(\d+)$/.exec(t);
  if (keyLike) return keyLike[0];
  const idLike = /^topic:(group|private):(\d+):/.exec(t);
  if (idLike) return idLike[1] + ':' + idLike[2];
  const idPlain = /^(group|private):(\d+)/.exec(t);
  if (idPlain) return idPlain[1] + ':' + idPlain[2];
  return '';
}

/** 组卡/话题卡：文件里通常没有 chatKey，导出时补上（导入方据此落位） */
function withChatKey(card, raw) {
  if (!card || typeof card !== 'object') return card;
  if (card.chatKey) return card;
  const k = deriveChatKey(raw, card) || deriveChatKey(card.id, card);
  return k ? { ...card, chatKey: k } : card;
}

const ALL_SECTIONS = ['generals', 'groups', 'persons', 'topics'];

/** 一张卡最合适的"时间"：updatedAt → lastActiveAt → createdAt */
export function cardTs(card) {
  for (const f of ['updatedAt', 'lastActiveAt', 'createdAt', 'lastSeen']) {
    const t = Date.parse(String(card?.[f] || ''));
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

/** 归一化栏目选择：{generals:false, persons:true} → Set；不传 = 全选 */
export function normalizeSections(input) {
  const set = new Set();
  if (!input || typeof input !== 'object') { for (const k of ALL_SECTIONS) set.add(k); return set; }
  for (const k of ALL_SECTIONS) if (input[k] !== false) set.add(k);
  return set;
}

const toMs = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};

/** 按时间范围筛卡（since/until 都可空） */
export function filterByTime(cards, { since = null, until = null } = {}) {
  const s = toMs(since);
  const u = toMs(until);
  if (s === null && u === null) return cards;
  return cards.filter((c) => {
    const t = cardTs(c);
    if (!t) return false;                 // 没时间的卡在时间筛选下视为不命中
    if (s !== null && t < s) return false;
    if (u !== null && t > u) return false;
    return true;
  });
}

/** 递归把卡里所有字符串过一遍脱敏（导出时用） */
export function redactCard(card) {
  const walk = (v) => {
    if (typeof v === 'string') return redactText(v, { force: true }).text;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, val] of Object.entries(v)) o[k] = walk(val);
      return o;
    }
    return v;
  };
  return walk(card);
}

const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
};
const readDirJson = (dir) => {
  let out = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json') || f.includes('.deleted')) continue;
      const j = readJson(path.join(dir, f));
      if (j) out.push(j);
    }
  } catch { /* ignore */ }
  return out;
};

/** 解析式：告诉导入方每一段怎么读 */
function buildSchema() {
  return {
    description: 'QQ Agent 记忆包。sections 描述各段数据结构与主键；timestamps 说明时间字段格式；merge 说明导入时的默认合并规则。',
    encoding: 'utf-8',
    sections: {
      generals: {
        kind: 'card[]',
        key: 'id',
        note: '通用卡（跨群全局记忆）；scope=global 的那张是默认',
        fields: {
          id: 'string', name: 'string', scope: 'global|normal',
          summary: 'string', facts: '[{key,value}]', prefs: '[string]', updatedAt: 'timestamp'
        }
      },
      groups: {
        kind: 'card[]',
        key: 'chatKey',
        note: '群聊/私聊卡；一个会话一张',
        fields: {
          chatKey: 'string(group:123|private:456) —— 导出时从目录名补全', name: 'string', summary: 'string',
          facts: '[{key,value}]', prefs: '[string]', notes: '[string]',
          members: '[{id,name,msgs}]', updatedAt: 'timestamp'
        }
      },
      persons: {
        kind: 'card[]',
        key: 'qq',
        note: '个人卡；按 QQ 号为主键（改昵称/不同群不同昵称都不影响）',
        fields: {
          qq: 'string', name: 'string', aliases: '[string]', summary: 'string', tone: 'string',
          facts: '[{key,value}]', prefs: '[string]', events: '[string]', pending: '[string]',
          groups: '[{chatKey,name,msgs,lastSeen,kind}]',
          impressions: '{general:[string], byChat:{chatKey:[string]}}',
          impressionScope: 'auto|all|model', updatedAt: 'timestamp'
        }
      },
      topics: {
        kind: 'card[]',
        key: 'id',
        note: '话题卡；归属于某个会话（chatKey）',
        fields: {
          id: 'string', chatKey: 'string', title: 'string', summary: 'string',
          keywords: '[string]', updatedAt: 'timestamp'
        }
      }
    },
    timestamps: { field: 'updatedAt', format: 'ISO-8601', note: '缺失视为最旧' },
    impressions: {
      layers: ['general', 'byChat'],
      byChatKey: 'chatKey',
      note: '个人卡的三层印象：通用 + 按会话分组；导入时按 key 合并，数组去重'
    },
    merge: {
      defaultMode: 'merge',
      conflict: 'updatedAt 较新的一方胜；缺失时间按最旧处理',
      coverage: ['generals.id', 'groups.chatKey', 'persons.qq', 'topics.id']
    }
  };
}

/** 读出当前全部记忆卡 */
export function collectCards() {
  const generals = readDirJson(path.join(ROOT, 'generals'));
  const persons = readDirJson(path.join(ROOT, 'persons'));
  const groups = [];
  const topics = [];
  let chats = [];
  try { chats = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { chats = []; }
  for (const d of chats) {
    if (d === 'persons' || d === 'generals') continue;
    const dir = path.join(ROOT, d);
    const g = readJson(path.join(dir, 'group.json'));
    // 群卡文件里没有 chatKey —— 从目录名还原后一起导出，否则导入方无法落位
    if (g) groups.push(withChatKey(g, d));
    for (const f of (() => { try { return fs.readdirSync(dir); } catch { return []; } })()) {
      if (/^topic_.*\.json$/.test(f)) {
        const t = readJson(path.join(dir, f));
        if (t) topics.push(withChatKey(t, d));
      }
    }
  }
  return { generals, groups, persons, topics };
}

/** 组装一个记忆包（不落盘） */
export function buildBundle({ appVersion = '', botName = '', sections = null, since = null, until = null, redact = false } = {}) {
  const want = normalizeSections(sections);
  const raw = collectCards();
  const pick = (list) => filterByTime(Array.isArray(list) ? list : [], { since, until });
  let generals = want.has('generals') ? pick(raw.generals) : [];
  let groups = want.has('groups') ? pick(raw.groups) : [];
  let persons = want.has('persons') ? pick(raw.persons) : [];
  let topics = want.has('topics') ? pick(raw.topics) : [];
  if (redact) {
    generals = generals.map(redactCard);
    groups = groups.map(redactCard);
    persons = persons.map(redactCard);
    topics = topics.map(redactCard);
  }
  const opts = {
    sections: [...want],
    since: since || null,
    until: until || null,
    redacted: !!redact
  };
  // 会话清单：导入方据此知道这些记忆属于哪些群/私聊
  const chatSet = new Map();
  for (const g of groups) if (g.chatKey) chatSet.set(g.chatKey, { chatKey: g.chatKey, name: g.name || '', kind: String(g.chatKey).split(':')[0] });
  for (const p of persons) {
    for (const g of (p.groups || [])) {
      if (g?.chatKey && !chatSet.has(g.chatKey)) chatSet.set(g.chatKey, { chatKey: g.chatKey, name: g.name || '', kind: String(g.chatKey).split(':')[0] });
    }
  }
  return {
    magic: MAGIC,
    bundleVersion: BUNDLE_VERSION,
    generator: { app: 'QQ Agent DSH', version: String(appVersion || ''), exportedAt: new Date().toISOString() },
    source: { persona: String(botName || ''), chats: [...chatSet.values()] },
    schema: buildSchema(),
    options: opts,
    payload: { generals, groups, persons, topics },
    counts: { generals: generals.length, groups: groups.length, persons: persons.length, topics: topics.length }
  };
}

/** 校验一个包能不能导入 */
export function validateBundle(obj) {
  const errors = [];
  const warnings = [];
  if (!obj || typeof obj !== 'object') return { ok: false, errors: ['不是合法的 JSON 对象'], warnings };
  if (obj.magic !== MAGIC) errors.push('文件标识不匹配（不是 QQ Agent 记忆包）');
  const v = Number(obj.bundleVersion);
  if (!Number.isFinite(v)) errors.push('缺少 bundleVersion');
  else if (v > BUNDLE_VERSION) errors.push(`包版本 ${v} 高于本程序支持的 ${BUNDLE_VERSION}（请升级程序）`);
  if (!obj.payload || typeof obj.payload !== 'object') errors.push('缺少 payload');
  else {
    for (const k of ['generals', 'groups', 'persons', 'topics']) {
      if (obj.payload[k] !== undefined && !Array.isArray(obj.payload[k])) errors.push(`payload.${k} 应该是数组`);
    }
  }
  if (!obj.schema) warnings.push('包里没有 schema（解析式），按内置规则解析');
  return { ok: errors.length === 0, errors, warnings };
}

const tsOf = (card) => {
  const t = Date.parse(String(card?.updatedAt || ''));
  return Number.isFinite(t) ? t : 0;
};

/** 预览导入：数量 + 冲突（不写盘） */
export function previewImport(obj, { sections = null, since = null, until = null } = {}) {
  const v = validateBundle(obj);
  if (!v.ok) return { ok: false, ...v };
  const want = normalizeSections(sections);
  const cur = collectCards();
  const plan = {};
  for (const [section, keyField] of [['generals', 'id'], ['groups', 'chatKey'], ['persons', 'qq'], ['topics', 'id']]) {
    if (!want.has(section)) { plan[section] = { incoming: 0, add: 0, update: 0, same: 0, older: 0, skippedByFilter: true }; continue; }
    const incoming = filterByTime(Array.isArray(obj.payload[section]) ? obj.payload[section] : [], { since, until });
    const existed = new Map((cur[section] || []).map((c) => [String(c[keyField] ?? ''), c]));
    let add = 0, update = 0, same = 0, older = 0;
    for (const card of incoming) {
      const key = String(card?.[keyField] ?? '');
      if (!key) continue;
      const old = existed.get(key);
      if (!old) { add += 1; continue; }
      const nt = tsOf(card), ot = tsOf(old);
      if (nt > ot) update += 1;
      else if (nt === ot) same += 1;
      else older += 1;
    }
    plan[section] = { incoming: incoming.length, add, update, same, older };
  }
  return { ok: true, warnings: v.warnings, plan, counts: obj.counts || null, generator: obj.generator || null, source: obj.source || null };
}

/** 执行导入。mode: merge（默认，时间新的覆盖）/ replace（用包里的覆盖同 key，多的保留） */
export function applyImport(obj, { mode = 'merge', sections = null, since = null, until = null } = {}) {
  const v = validateBundle(obj);
  if (!v.ok) return { ok: false, ...v };
  const want = normalizeSections(sections);
  const payload = {};
  for (const k of ALL_SECTIONS) {
    payload[k] = want.has(k)
      ? filterByTime(Array.isArray(obj.payload?.[k]) ? obj.payload[k] : [], { since, until })
      : [];
  }
  const filteredOut = {};
  for (const k of ALL_SECTIONS) filteredOut[k] = (Array.isArray(obj.payload?.[k]) ? obj.payload[k].length : 0) - payload[k].length;
  const written = { generals: 0, groups: 0, persons: 0, topics: 0 };
  const skipped = { generals: 0, groups: 0, persons: 0, topics: 0 };

  const writeGeneral = (card) => {
    const file = path.join(ROOT, 'generals', String(card.id).replace(/[^\w-]/g, '_') + '.json');
    const old = readJson(file);
    if (old && mode === 'merge' && tsOf(card) <= tsOf(old)) { skipped.generals += 1; return; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(card, null, 1), 'utf8');
    written.generals += 1;
  };
  const personFile = (qq) => path.join(ROOT, 'persons', String(qq).replace(/[^\w-]/g, '_') + '.json');
  const writePerson = (card) => {
    const file = personFile(card.qq);
    const old = readJson(file);
    if (old && mode === 'merge' && tsOf(card) <= tsOf(old)) { skipped.persons += 1; return; }
    const merged = old && mode === 'merge' ? mergePerson(old, card) : card;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(merged, null, 1), 'utf8');
    written.persons += 1;
  };
  const chatDir = (chatKey) => path.join(ROOT, String(chatKey).replace(':', '_'));
  const writeGroup = (card) => {
    const dir = chatDir(card.chatKey);
    const file = path.join(dir, 'group.json');
    const old = readJson(file);
    if (old && mode === 'merge' && tsOf(card) <= tsOf(old)) { skipped.groups += 1; return; }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(card, null, 1), 'utf8');
    written.groups += 1;
  };
  const writeTopic = (card) => {
    const dir = chatDir(card.chatKey || 'unknown:0');
    // ⚠️ 话题文件名与 id 的映射不是简单 sanitize（历史文件叫 topic_group_123_fact-...，
    // id 却是 topic:group:123:fact-...）；直接按 id 生成会写出**重复文件**。
    // 所以先按 id 扫一遍现有文件，命中就覆盖它，没命中才新建。
    let target = '';
    let existing = null;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!/^topic_.*\.json$/.test(f) || f.includes('.deleted')) continue;
        const j = readJson(path.join(dir, f));
        if (j && String(j.id) === String(card.id)) { target = path.join(dir, f); existing = j; break; }
      }
    } catch { /* 目录不存在 */ }
    if (existing && mode === 'merge' && tsOf(card) <= tsOf(existing)) { skipped.topics += 1; return; }
    if (!target) target = path.join(dir, 'topic_' + String(card.id).replace(/[^\w-]/g, '_') + '.json');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(target, JSON.stringify(card, null, 1), 'utf8');
    written.topics += 1;
  };

  for (const card of (payload.generals || [])) if (card?.id) writeGeneral(card);
  for (const card of (payload.persons || [])) if (card?.qq) writePerson(card);
  for (const raw of (payload.groups || [])) {
    const card = raw?.chatKey ? raw : { ...raw, chatKey: deriveChatKey(raw?.id, raw) };
    if (card?.chatKey) writeGroup(card);
  }
  for (const raw of (payload.topics || [])) {
    const card = raw?.chatKey ? raw : { ...raw, chatKey: deriveChatKey(raw?.id, raw) };
    if (card?.id && card?.chatKey) writeTopic(card);
  }

  return { ok: true, written, skipped, mode, filteredOut: (filteredOut.generals + filteredOut.groups + filteredOut.persons + filteredOut.topics), sections: [...want], since: since || null, until: until || null };
}

/** merge 模式下的个人卡合并：字段取新的，数组去重合并，三层印象按 key 合并 */
function mergePerson(old, incoming) {
  const out = { ...old, ...incoming };
  const uniq = (a) => [...new Set((a || []).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))))];
  for (const f of ['aliases', 'prefs', 'events', 'pending', 'notes']) {
    if (Array.isArray(old[f]) || Array.isArray(incoming[f])) out[f] = uniq([...(old[f] || []), ...(incoming[f] || [])]);
  }
  const gi = incoming.impressions || {};
  const go = old.impressions || {};
  out.impressions = {
    ...go, ...gi,
    general: uniq([...(go.general || []), ...(gi.general || [])]),
    byChat: (() => {
      const keys = new Set([...Object.keys(go.byChat || {}), ...Object.keys(gi.byChat || {})]);
      const res = {};
      for (const k of keys) res[k] = uniq([...((go.byChat || {})[k] || []), ...((gi.byChat || {})[k] || [])]);
      return res;
    })()
  };
  out.updatedAt = new Date().toISOString();
  return out;
}

/** 导出到 data/exports/ 并返回内容 */
export function exportToFile({ appVersion = '', botName = '', pretty = true, sections = null, since = null, until = null, redact = false } = {}) {
  const bundle = buildBundle({ appVersion, botName, sections, since, until, redact });
  const dir = path.join(DATA_DIR, 'exports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `memories-${stamp}.qqmem.json`;
  const file = path.join(dir, name);
  const text = JSON.stringify(bundle, null, pretty ? 1 : 0);
  fs.writeFileSync(file, text, 'utf8');
  return { ok: true, name, path: file, text, bytes: Buffer.byteLength(text), counts: bundle.counts, options: bundle.options };
}
