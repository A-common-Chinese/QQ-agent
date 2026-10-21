// 人设黑名单出站过滤器（决策：mode = filter / both 时生效；只删短语，不做整句解析）
// 调用点：模型回复的发送路径（tools.js 的 send_message / send_to）。
// 只处理"人设会话的模型输出"，不碰 DSH 中继、系统通知、市场消息。
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, DATA_DIR } from './config.js';

let cache = { key: '', re: null };

function buildRegex(phrases) {
  const list = phrases.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim());
  if (!list.length) return null;
  const key = list.join('\u0001');
  if (cache.key === key) return cache.re;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 长短语优先，避免"首先"先吃掉"综上所述"这种重叠
  const parts = list.sort((a, b) => b.length - a.length).map(esc);
  const re = new RegExp(parts.join('|'), 'g');
  cache = { key, re };
  return re;
}

function cleanup(text) {
  return String(text)
    .replace(/[，,、]{2,}/g, '，')
    .replace(/^[，,、。．.！!？?；;：:\s]+/, '')
    .replace(/[，,、]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function logHits(text, hits) {
  try {
    const line = JSON.stringify({ at: new Date().toISOString(), hits, before: String(text).slice(0, 120) }) + '\n';
    fs.appendFileSync(path.join(DATA_DIR, 'banned-phrase-hits.log'), line, 'utf8');
  } catch { /* 日志失败不影响发送 */ }
}

/**
 * 过滤模型输出里命中的黑名单短语（strip 模式）。
 * 返回过滤后的文本；未启用/未命中时原样返回。
 */
export function applyBannedFilter(text) {
  try {
    if (typeof text !== 'string' || !text) return text;
    const policy = getConfig()?.personaPolicy || {};
    const mode = String(policy.bannedPhraseMode || 'prompt');
    if (mode !== 'filter' && mode !== 'both') return text;      // 默认 prompt 模式：不动输出
    const of = policy.outboundFilter || {};
    if (of.enabled === false) return text;
    const phrases = Array.isArray(policy.bannedPhrases) ? policy.bannedPhrases : [];
    const re = buildRegex(phrases);
    if (!re) return text;
    const hits = [];
    const out = text.replace(re, (m) => { hits.push(m); return ''; });
    if (!hits.length) return text;
    if (of.log !== false) logHits(text, hits);
    const cleaned = cleanup(out);
    return cleaned || '';                                       // 全被删光 → 空串（调用方丢弃）
  } catch {
    return text;
  }
}

/** 只判断是否会命中（给 UI/日志用） */
export function scanBannedPhrases(text) {
  try {
    const policy = getConfig()?.personaPolicy || {};
    const re = buildRegex(Array.isArray(policy.bannedPhrases) ? policy.bannedPhrases : []);
    if (!re || typeof text !== 'string') return [];
    return text.match(re) || [];
  } catch { return []; }
}
