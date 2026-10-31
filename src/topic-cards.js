// 话题卡自动生成（与个人卡「约定」同思路）：
//   · 模型判断每张话题的期限：short(短期) / long(长期) / permanent(永久)
//   · 去重：标题归一化后相同 → 更新；关键词重叠 ≥2 也视为同一话题
//   · 上限：每个会话最多 maxPerChat 张；超限时优先淘汰「已过期 → 短期最旧 → 最久未更新」
import { listTopics, createTopic, updateTopic, deleteTopic } from './memory-cards.js';
import { getConfig } from './config.js';

const TERMS = ['short', 'long', 'permanent'];

function termOf(v) {
  const t = String(v || '').toLowerCase();
  return TERMS.includes(t) ? t : 'long';
}

function normTitle(s) {
  return String(s || '').toLowerCase().replace(/[\s·:：,，。.!！?？"'“”‘’()（）\-—_]/g, '');
}

function kwOf(list) {
  return (Array.isArray(list) ? list : []).map((x) => String(x || '').trim().toLowerCase()).filter(Boolean);
}

/** 找同话题：标题相同，或关键词有 2 个以上重合 */
function findSimilar(topics, title, keywords) {
  const nt = normTitle(title);
  const kws = new Set(kwOf(keywords));
  for (const t of topics) {
    if (nt && normTitle(t.title) === nt) return t;
    const overlap = kwOf(t.keywords).filter((k) => kws.has(k)).length;
    if (kws.size >= 2 && overlap >= 2) return t;
  }
  return null;
}

/** 超出上限时挑一张最该淘汰的（返回 null = 不用淘汰） */
function pickVictim(topics, maxPerChat, now = Date.now()) {
  if (topics.length < maxPerChat) return null;
  const expired = topics.filter((t) => t.expiresAt && t.expiresAt > 0 && t.expiresAt < now);
  const pool = expired.length ? expired : topics.filter((t) => t.term === 'short');
  const candidates = pool.length ? pool : topics;
  return candidates.slice().sort((a, b) => (Number(a.updatedAt ? Date.parse(a.updatedAt) : 0) || 0) - (Number(b.updatedAt ? Date.parse(b.updatedAt) : 0) || 0))[0] || null;
}

/**
 * 写入/更新一张话题卡。
 * @returns {{ok:boolean, action:'created'|'updated'|'skipped'|'evicted', id?:string, reason?:string}}
 */
export function upsertTopicCard(chatKey, item = {}) {
  const cfg = getConfig()?.memoryCards?.topics || {};
  const title = String(item.title || '').trim().slice(0, 80);
  if (!chatKey || !title) return { ok: false, action: 'skipped', reason: 'no-title' };
  const maxPerChat = Math.max(1, Number(cfg.maxPerChat) || 20);
  let topics = listTopics(chatKey);
  const patch = {
    title,
    summary: String(item.summary || '').slice(0, 200),
    body: String(item.body || '').slice(0, 2000),
    keywords: Array.isArray(item.keywords) ? item.keywords.slice(0, 8) : [],
    term: termOf(item.term)
  };
  const same = findSimilar(topics, title, patch.keywords);
  if (same) {
    // 期限取更"长寿"的那个，避免长期话题被一次短期更新降级
    const rank = { short: 0, long: 1, permanent: 2 };
    const term = rank[termOf(patch.term)] >= rank[termOf(same.term)] ? patch.term : same.term;
    const r = updateTopic(chatKey, same.id, { ...patch, term });
    return { ok: !!r.ok, action: 'updated', id: same.id, term };
  }
  if (topics.length >= maxPerChat) {
    const victim = pickVictim(topics, maxPerChat);
    if (victim) { try { deleteTopic(chatKey, victim.id); } catch { /* ignore */ } }
    topics = listTopics(chatKey);
  }
  const r = createTopic(chatKey, patch);
  return { ok: !!r.ok, action: 'created', id: r.card?.id, term: patch.term };
}

/** 清理该会话里已过期的话题（permanent 不清） */
export function pruneExpiredTopics(chatKey, now = Date.now()) {
  let removed = 0;
  for (const t of listTopics(chatKey)) {
    if (t.expiresAt && t.expiresAt > 0 && t.expiresAt < now) {
      try { if (deleteTopic(chatKey, t.id).ok) removed += 1; } catch { /* ignore */ }
    }
  }
  return removed;
}
