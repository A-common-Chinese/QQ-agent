// 语义触发分级决策（P1：只观察、只记录，不改行为）
//   L0 规则（本文件只做资格判定）
//   L1 向量相关度（embedding 检索）
//   L2 本地/指定模型判定（judge.enabled 且非 observeOnly 时才真正调用）
import { getConfig, isSilentChat } from './config.js';
import { chatCompletion } from './llm.js';
import { currentProviders } from './providers.js';
import { readChunks, readSemanticCards } from './memory-layers.js';
import { ensureIndex, scoreText, indexStatus } from './vector-store.js';
import { embeddingReady } from './embeddings.js';
import { addDecision } from './decision-log.js';

const lastRunAt = new Map();   // chatKey -> ts（冷却）

/** 会话属于哪个通道：openid 形态（含 a-f 或长度≥20）→ qqbot；纯数字 → onebot */
export function channelOfChatKey(chatKey) {
  const id = String(chatKey || '').split(':')[1] || '';
  if (!id) return '';
  if (/[a-f]/i.test(id) || id.length >= 20) return 'qqbot';
  return 'onebot';
}
const daily = new Map();       // `${chatKey}|${day}` -> count

function dayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

/** 合并 perChat 覆盖 */
export function effectiveCfg(chatKey, cfg = getConfig()) {
  const base = cfg.decision || {};
  const over = (base.perChat && base.perChat[chatKey]) || {};
  return {
    enabled: over.enabled !== undefined ? over.enabled : base.enabled,
    observeOnly: over.observeOnly !== undefined ? over.observeOnly : base.observeOnly,
    embedding: base.embedding || {},
    thresholds: { ...(base.thresholds || {}), ...(over.thresholds || {}) },
    budget: { ...(base.budget || {}), ...(over.budget || {}) },
    judge: { ...(base.judge || {}), ...(over.judge || {}) },
    mode: over.mode || 'inherit'
  };
}

/** 组装索引语料：语义卡 + 小时摘要 + 最近消息 */
export function buildCorpus(chatKey, messages, cfg) {
  const items = [];
  const emb = (cfg.decision?.embedding) || {};
  const corpus = emb.corpus || {};
  if (corpus.semanticCards !== false) {
    for (const c of readSemanticCards(chatKey)) {
      if (c.title || c.detail) items.push({ id: 'card:' + c.key, kind: 'semantic-card', text: String(c.title || '') + ' ' + String(c.detail || '') });
    }
  }
  if (corpus.hourlySummaries !== false) {
    for (const ch of readChunks(chatKey, 40)) {
      if (ch.summary) items.push({ id: 'chunk:' + ch.id, kind: 'hourly', text: String(ch.summary) });
    }
  }
  const n = Math.max(0, Number(corpus.recentMessages) || 0);
  for (const m of (messages || []).slice(-n)) {
    const t = String(m.text || '').trim();
    if (t) items.push({ id: 'msg:' + (m.id ?? m.mid ?? t.slice(0, 20)), kind: 'message', text: (m.senderName ? m.senderName + '：' : '') + t });
  }
  return items;
}

function pickJudgeEndpoint(cfg) {
  const j = cfg.decision?.judge || {};
  let baseUrl = '';
  let apiKey = '';
  if (j.providerId) {
    const p = currentProviders().find((x) => x && x.id === j.providerId);
    if (p) { baseUrl = p.baseURL || ''; apiKey = p.apiKey || ''; }
  }
  return { model: String(j.model || '').trim(), baseUrl, apiKey, timeoutMs: Number(j.timeoutMs) || 1500, maxTokens: Number(j.maxTokens) || 64, temperature: Number(j.temperature) || 0 };
}

async function judgeWithModel(text, recent, cfg) {
  const ep = pickJudgeEndpoint(cfg);
  if (!ep.model) return { ok: false, skipped: 'judge-no-model' };
  const sys = '你是"该不该接话"的判定器。只输出 JSON：{"respond":true|false,"confidence":0-100,"reason":"不超过20字"}';
  const user = ['群聊最近消息：', ...(recent || []).slice(-12).map((m) => `${m.senderName || '我'}：${String(m.text || '').slice(0, 120)}`), '', '待判定消息：', String(text || '').slice(0, 400)].join('\n');
  const resp = await chatCompletion({
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    temperature: ep.temperature,
    maxTokens: ep.maxTokens,
    ...(ep.baseUrl ? { overrides: { baseUrl: ep.baseUrl, apiKey: ep.apiKey, model: ep.model, timeoutMs: ep.timeoutMs } } : {})
  });
  const raw = String(resp?.message?.content ?? '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '');
  try { return { ok: true, ...JSON.parse(raw) }; } catch { return { ok: false, skipped: 'judge-bad-json', raw: raw.slice(0, 120) }; }
}

/**
 * 观察/决策入口（不阻塞消息处理；调用方 fire-and-forget）
 * P1：observeOnly=true 时只算分 + 记录，返回 { action:'observe' }。
 */
export async function runDecision({ chatKey, entry, messages = [], store = null }) {
  const cfg = getConfig();
  const d = cfg.decision || {};
  const eff = effectiveCfg(chatKey, cfg);
  if (!d.enabled || eff.enabled === false) return { ok: false, skipped: 'disabled' };
  // 只观察「当前设置通道」的会话：避免两个通道同时配置时重复记录/口径错乱
  const active = String(cfg.transport?.active || 'onebot');
  if (active !== 'both' && channelOfChatKey(chatKey) !== active) {
    return { ok: false, skipped: 'channel-mismatch' };
  }
  if (eff.mode === 'off') return { ok: false, skipped: 'perChat-off' };
  if (String(chatKey).startsWith('private:')) return { ok: false, skipped: 'private' };
  if (isSilentChat(chatKey)) return { ok: false, skipped: 'silent' };
  if (!embeddingReady(cfg)) return { ok: false, skipped: 'embedding-not-ready' };

  const budget = eff.budget || {};
  const now = Date.now();
  const cooldown = Math.max(0, Number(budget.cooldownSec) || 0) * 1000;
  if (cooldown && now - (lastRunAt.get(chatKey) || 0) < cooldown) return { ok: false, skipped: 'cooldown' };
  const dk = chatKey + '|' + dayKey();
  const limit = Math.max(1, Number(budget.dailyLimitPerChat) || 200);
  const used = daily.get(dk) || 0;
  if (used >= limit) return { ok: false, skipped: 'daily-limit' };
  lastRunAt.set(chatKey, now);
  daily.set(dk, used + 1);

  const text = String(entry?.text || '').trim();
  const t0 = Date.now();
  const log = { chatKey, text: text.slice(0, 200), observeOnly: eff.observeOnly !== false };
  try {
    const items = buildCorpus(chatKey, messages, cfg);
    await ensureIndex(chatKey, items, cfg);
    const s = await scoreText(chatKey, text, cfg);
    log.score = s.ok ? Number(s.score.toFixed(4)) : null;
    log.top = (s.top || []).slice(0, 3).map((x) => ({ kind: x.kind, score: Number(x.score.toFixed(3)), text: String(x.text).slice(0, 60) }));
    log.low = effectiveCfg(chatKey, cfg).thresholds.low;
    log.high = effectiveCfg(chatKey, cfg).thresholds.high;
    log.highHit = typeof log.score === 'number' && log.score >= Number(log.high || 1);
    log.tookMs = Date.now() - t0;
    log.skipped = s.ok ? '' : s.skipped;

    // P2 才会用分数改决策；P1 只在 observeOnly=false 且阈值命中时才可能进 L2
    if (!eff.observeOnly && log.highHit && eff.judge?.enabled) {
      const j = await judgeWithModel(text, messages, cfg);
      log.judge = j;
      log.action = j.ok && j.respond ? 'respond' : 'skip';
    } else {
      log.action = eff.observeOnly ? 'observe' : (log.highHit ? 'would-respond' : 'would-skip');
    }
  } catch (e) {
    log.error = String(e?.message ?? e);
    log.action = 'error';
  }
  return addDecision(log);
}

export function decisionStatus(chatKey = '') {
  return { index: chatKey ? indexStatus(chatKey) : null, cooldowns: [...lastRunAt.entries()].length };
}
