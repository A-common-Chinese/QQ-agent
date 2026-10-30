// 语义触发分级决策（P1：只观察、只记录，不改行为）
//   L0 规则（本文件只做资格判定）
//   L1 向量相关度（embedding 检索）
//   L2 本地/指定模型判定（judge.enabled 且非 observeOnly 时才真正调用）
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, isSilentChat, ROOT } from './config.js';
import { chatCompletion } from './llm.js';
import { judgeQueued, judgeStats, resolveJudgeChain } from './decision-judge.js';
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
const skips = new Map();       // 跳过原因计数（诊断用）
const judgeDaily = new Map();
const liveDaily = new Map();    // `${chatKey}|${day}` -> 主动接话次数
const lastLiveAt = new Map();    // chatKey -> ts（主动接话间隔）  // `${chatKey}|${day}` -> 判定次数（L2 上限）
let lastEmbedError = null;     // { at, message } 最近一次 embedding 失败（余额/网络），用于退避

function skip(reason) {
  skips.set(reason, (skips.get(reason) || 0) + 1);
  return { ok: false, skipped: reason };
}

/** 纯媒体/表情消息（[图片] [表情] …）对文本语义没有意义，直接跳过 */
function isMediaOnly(text) {
  const t = String(text || '')
    .replace(/\[(图片|表情|视频|语音|文件|动画表情|闪照|戳一戳|回复|卡片|链接|位置|红包|音乐|分享)\]/g, '')
    .replace(/\s/g, '');
  return t.length < 2;
}

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
    mode: over.mode || 'inherit',
    observeSilent: over.observeSilent === true
  };
}

/** 该会话实际使用的语料口径：perChat[chatKey].corpusScope 优先，其次全局 corpus.scope */
export function corpusScopeFor(chatKey, cfg) {
  const over = (cfg.decision?.perChat || {})[chatKey] || {};
  const s = String(over.corpusScope || cfg.decision?.embedding?.corpus?.scope || 'group');
  return s === 'interest' ? 'interest' : 'group';
}

/** 组装索引语料：scope=group（群内容）或 scope=interest（人设/兴趣/技能） */
export function buildCorpus(chatKey, messages, cfg) {
  const items = [];
  const emb = (cfg.decision?.embedding) || {};
  const corpus = emb.corpus || {};

  // ── interest 口径：只看"这句话和我（人设/能力）有多相关"，不看群消息 ──
  if (corpusScopeFor(chatKey, cfg) === 'interest') {
    const persona = cfg.persona || {};
    if (persona.botName) items.push({ id: 'persona:name', kind: 'persona', text: '我是' + persona.botName });
    if (persona.roleText) items.push({ id: 'persona:role', kind: 'persona', text: '我的角色：' + persona.roleText });
    if (persona.customRules) items.push({ id: 'persona:rules', kind: 'persona', text: '我的规则：' + persona.customRules });
    const big = typeof cfg.personaDefault === 'string' ? cfg.personaDefault : '';
    for (let i = 0, n = 0; i < big.length; i += 800, n += 1) {
      const chunk = big.slice(i, i + 800).trim();
      if (chunk) items.push({ id: 'persona:chunk' + n, kind: 'persona', text: chunk });
    }
    // 技能能力描述（机器人"会聊什么"）
    try {
      const skillsDir = path.join(ROOT, 'skills');
      for (const d of fs.readdirSync(skillsDir)) {
        for (const f of ['SKILL.md', 'skill.json']) {
          const fp = path.join(skillsDir, d, f);
          if (fs.existsSync(fp)) {
            const t = fs.readFileSync(fp, 'utf8').replace(/^---[\s\S]*?---/, '').slice(0, 600).trim();
            if (t) items.push({ id: 'skill:' + d, kind: 'skill', text: '我的能力：' + t });
            break;
          }
        }
      }
    } catch { /* 无 skills 目录 */ }
    return items;
  }
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

/**
 * 观察/决策入口（不阻塞消息处理；调用方 fire-and-forget）
 * P1：observeOnly=true 时只算分 + 记录，返回 { action:'observe' }。
 */
function eff0(cfg) { return effectiveCfg('', cfg); }

export async function runDecision({ chatKey, entry, messages = [], store = null }) {
  const cfg = getConfig();
  const d = cfg.decision || {};
  const eff = effectiveCfg(chatKey, cfg);
  if (!d.enabled || eff.enabled === false) return skip('disabled');
  // 只观察「当前设置通道」的会话：避免两个通道同时配置时重复记录/口径错乱
  const active = String(cfg.transport?.active || 'onebot');
  if (active !== 'both' && channelOfChatKey(chatKey) !== active) return skip('channel-mismatch');
  if (eff.mode === 'off') return skip('perChat-off');
  if (String(chatKey).startsWith('private:')) return skip('private');
  // 静默会话默认跳过；显式配置 observeSilent=true 时允许只观察（不发消息、不调回复模型）
  if (isSilentChat(chatKey) && eff.observeSilent !== true) return skip('silent');
  if (!embeddingReady(cfg)) return skip('embedding-not-ready');

  const budget = eff.budget || {};
  const now = Date.now();
  const cooldown = Math.max(0, Number(budget.cooldownSec) || 0) * 1000;
  if (cooldown && now - (lastRunAt.get(chatKey) || 0) < cooldown) return skip('cooldown');
  const dk = chatKey + '|' + dayKey();
  const limit = Math.max(1, Number(budget.dailyLimitPerChat) || 200);
  const used = daily.get(dk) || 0;
  if (used >= limit) return skip('daily-limit');
  lastRunAt.set(chatKey, now);
  daily.set(dk, used + 1);

  // embedding 连续失败（如余额不足）时退避 60 秒，避免每条消息都打一次失败请求
  if (lastEmbedError && Date.now() - lastEmbedError.at < 60_000) return skip('embedding-backoff');

  const text = String(entry?.text || '').trim();
  if (!text) return skip('empty');
  if (isMediaOnly(text)) return skip('media-only');
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

    // 观察模式：只记分数
    if (eff.observeOnly !== false) {
      log.action = 'observe';
    } else {
      // 预览版（P2）：按分群阈值给出决策
      const low = Number(eff.thresholds?.low ?? 0.25);
      const high = Number(eff.thresholds?.high ?? 0.55);
      const sc = typeof log.score === 'number' ? log.score : null;
      const band = sc == null ? 'unknown' : sc >= high ? 'high' : sc >= low ? 'mid' : 'low';
      log.band = band;
      let decide = band === 'high';
      // 中间带：有 L2 判定就交给它，否则保守跳过（带每日上限，防失控）
      if (band === 'mid' && eff.judge?.enabled) {
        const cap = Math.max(1, Number(eff.budget?.maxJudgePerChatPerDay ?? cfg.decision?.budget?.maxJudgePerChatPerDay ?? 300));
        const jkey = chatKey + '|' + dayKey();
        const jused = judgeDaily.get(jkey) || 0;
        if (jused >= cap) {
          log.judge = { ok: false, skipped: 'judge-daily-limit' };
        } else {
          judgeDaily.set(jkey, jused + 1);
          const j = await judgeQueued({ text, recent: messages, cfg, chatKey });
          log.judge = j;
          decide = !!(j.ok && j.respond === true);
        }
      }
      log.liveReply = cfg.decision?.liveReply === true;
      if (decide && log.liveReply) log.action = 'respond';
      else log.action = decide ? 'would-respond' : 'would-skip';
      log.reason = band === 'high' ? '分数高于高阈值' : band === 'mid' ? '中间带' : band === 'low' ? '分数低于低阈值' : '无分数';
    }
  } catch (e) {
    log.error = String(e?.message ?? e);
    log.action = 'error';
    if (/embedding|402|balance/i.test(log.error)) lastEmbedError = { at: Date.now(), message: log.error.slice(0, 200) };
  }
  return addDecision(log);
}


/** 触发批记分（observeTriggered）：被 @/关键词/档位命中时也打一个分，仅用于对照观察 */
export async function runDecisionTriggered({ chatKey, entry, messages = [], reason = '' }) {
  const cfg = getConfig();
  const d = cfg.decision || {};
  if (!d.enabled || !d.observeTriggered) return { ok: false, skipped: 'triggered-off' };
  const active = String(cfg.transport?.active || 'onebot');
  if (active !== 'both' && channelOfChatKey(chatKey) !== active) return { ok: false, skipped: 'channel-mismatch' };
  if (String(chatKey).startsWith('private:')) return { ok: false, skipped: 'private' };
  if (isSilentChat(chatKey)) return { ok: false, skipped: 'silent' };
  if (!embeddingReady(cfg)) return { ok: false, skipped: 'embedding-not-ready' };
  const text = String(entry?.text || '').trim();
  if (!text) return { ok: false, skipped: 'empty' };
  if (isMediaOnly(text)) return { ok: false, skipped: 'media-only' };
  const t0 = Date.now();
  const log = { chatKey, text: text.slice(0, 200), observeOnly: true, triggered: true, tierReason: String(reason || '').slice(0, 60) };
  try {
    await ensureIndex(chatKey, buildCorpus(chatKey, messages, cfg), cfg);
    const s = await scoreText(chatKey, text, cfg);
    log.score = s.ok ? Number(s.score.toFixed(4)) : null;
    log.top = (s.top || []).slice(0, 3).map((x) => ({ kind: x.kind, score: Number(x.score.toFixed(3)), text: String(x.text).slice(0, 60) }));
    log.low = Number((eff0(cfg).thresholds || {}).low);
    log.high = Number((eff0(cfg).thresholds || {}).high);
    log.highHit = typeof log.score === 'number' && log.score >= Number(log.high || 1);
    log.tookMs = Date.now() - t0;
    log.skipped = s.ok ? '' : s.skipped;
    log.action = 'triggered-batch';
  } catch (e) {
    log.error = String(e?.message ?? e);
    log.action = 'error';
    if (/embedding|402|balance/i.test(log.error)) lastEmbedError = { at: Date.now(), message: log.error.slice(0, 200) };
  }
  return addDecision(log);
}

/** 主动接话安全阀：每群每日上限 + 最小间隔；通过才消耗一次配额 */
export function tryConsumeLive(chatKey, cfg) {
  const d = cfg.decision || {};
  const pc = (d.perChat || {})[chatKey] || {};
  const max = Math.max(1, Number(pc.maxLivePerDay ?? d.liveMaxPerDay ?? 5));
  const gap = Math.max(0, Number(pc.minLiveIntervalMs ?? d.liveMinIntervalMs ?? 600000));
  const key = chatKey + '|' + dayKey();
  const used = liveDaily.get(key) || 0;
  if (used >= max) return { ok: false, reason: 'live-daily-limit', used, max };
  const last = lastLiveAt.get(chatKey) || 0;
  if (gap && Date.now() - last < gap) return { ok: false, reason: 'live-interval', used, max };
  liveDaily.set(key, used + 1);
  lastLiveAt.set(chatKey, Date.now());
  return { ok: true, used: used + 1, max };
}

export function decisionStatus(chatKey = '') {
  return {
    index: chatKey ? indexStatus(chatKey) : null,
    cooldowns: [...lastRunAt.entries()].length,
    skips: Object.fromEntries(skips),
    judge: judgeStats(),
    lastError: lastEmbedError
  };
}
