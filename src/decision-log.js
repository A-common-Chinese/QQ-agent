// 语义触发决策日志：内存环形 500 条 + data/logs/decision.log（JSONL）
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'logs', 'decision.log');
const ring = [];
const MAX = 500;

export function addDecision(entry) {
  const e = { ...entry, at: Number(entry?.at) || Date.now() };
  ring.push(e);
  if (ring.length > MAX) ring.shift();
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.appendFileSync(FILE, JSON.stringify(e) + '\n', 'utf8');
  } catch { /* 忽略 */ }
  return e;
}

export function listDecisions(limit = 100) {
  const n = Math.max(1, Math.min(MAX, Number(limit) || 100));
  return ring.slice(-n);
}

export function decisionStats() {
  const byChat = new Map();
  let scored = 0;
  let errors = 0;
  for (const e of ring) {
    const k = e.chatKey || '';
    const cur = byChat.get(k) || { chatKey: k, count: 0, max: 0, sum: 0, hitHigh: 0 };
    cur.count += 1;
    if (typeof e.score === 'number') { cur.sum += e.score; cur.max = Math.max(cur.max, e.score); scored += 1; }
    if (e.highHit) cur.hitHigh += 1;
    byChat.set(k, cur);
  }
  if (errors) { /* 预留 */ }
  return {
    total: ring.length,
    scored,
    errors,
    chats: [...byChat.values()].map((c) => ({ ...c, avg: c.count ? c.sum / c.count : 0 })).sort((a, b) => b.count - a.count).slice(0, 30)
  };
}
