// 分层记忆（conversation-memory 插件写入的数据）只读访问层：
//   data/memory-v2/chunks/*.json   按小时切片的记忆块（含 summary / keywords）
//   data/semantic-cards/cards.json 语义卡（plan/preference/fact 等）
// 供「记忆 → 分层记忆」面板与记忆卡自动生成使用。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const CHUNK_DIR = path.join(DATA_DIR, 'memory-v2', 'chunks');
const SEMANTIC_FILE = path.join(DATA_DIR, 'semantic-cards', 'cards.json');
const CARD_DIR = path.join(DATA_DIR, 'memory-cards');

function chatSlug(chatKey) {
  return String(chatKey || '').replace(/[^a-z0-9_]/gi, '_');
}

/** 该会话最近的记忆块（新→旧） */
export function readChunks(chatKey, limit = 30) {
  const slug = chatSlug(chatKey);
  const out = [];
  try {
    for (const f of fs.readdirSync(CHUNK_DIR)) {
      if (!f.endsWith('.json')) continue;
      if (!f.includes('_' + slug + '_')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(CHUNK_DIR, f), 'utf8'));
        if (!j || String(j.chatKey || '') !== String(chatKey)) continue;
        out.push({
          id: j.id,
          when: j.when,
          dayKey: j.dayKey,
          hourKey: j.hourKey,
          title: j.title,
          summary: j.summary,
          keywords: Array.isArray(j.keywords) ? j.keywords : []
        });
      } catch { /* 单个坏文件跳过 */ }
    }
  } catch { /* 目录不存在 */ }
  out.sort((a, b) => (b.when || 0) - (a.when || 0));
  return out.slice(0, Math.max(1, limit));
}

/** 该会话的语义卡 */
export function readSemanticCards(chatKey) {
  try {
    const raw = JSON.parse(fs.readFileSync(SEMANTIC_FILE, 'utf8'));
    const cards = Array.isArray(raw?.cards) ? raw.cards : [];
    return cards.filter((c) => String(c.chatKey || '') === String(chatKey));
  } catch { return []; }
}

/** 自动生成记忆卡的冷却状态（data/memory-cards/_auto-state.json） */
const AUTO_STATE = path.join(CARD_DIR, '_auto-state.json');
export function autoState() {
  try { return JSON.parse(fs.readFileSync(AUTO_STATE, 'utf8')) || {}; } catch { return {}; }
}
export function markAutoCards(chatKey, at = Date.now()) {
  try {
    const st = autoState();
    st[String(chatKey)] = Number(at) || Date.now();
    fs.mkdirSync(CARD_DIR, { recursive: true });
    fs.writeFileSync(AUTO_STATE, JSON.stringify(st, null, 2), 'utf8');
  } catch { /* 忽略 */ }
}
export function lastAutoCardsAt(chatKey) {
  return Number(autoState()[String(chatKey)] || 0);
}
