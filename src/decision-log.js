// 语义触发决策日志：内存环形 500 条 + data/logs/decision.log（JSONL）
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'logs', 'decision.log');
const ring = [];
const MAX = 500;

// 启动时从落盘文件回填最近记录（否则重启后面板一片空白）
try {
  const raw = fs.readFileSync(FILE, 'utf8').trim().split('\n').slice(-MAX);
  for (const line of raw) {
    try {
      const e = JSON.parse(line);
      if (e && e.chatKey) ring.push(e);
    } catch { /* 跳过坏行 */ }
  }
} catch { /* 文件不存在 */ }

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

export function queryDecisions({ chatKey = '', minScore = null, maxScore = null, limit = 200 } = {}) {
  const n = Math.max(1, Math.min(MAX, Number(limit) || 200));
  return ring
    .filter((e) => (!chatKey || e.chatKey === chatKey))
    .filter((e) => (minScore == null || (typeof e.score === 'number' && e.score >= Number(minScore))))
    .filter((e) => (maxScore == null || (typeof e.score === 'number' && e.score <= Number(maxScore))))
    .slice(-n);
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
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
  // 直方图：0.0–1.0，每 0.1 一档
  const histogram = new Array(10).fill(0);
  for (const e of ring) {
    if (typeof e.score !== 'number') continue;
    const b = Math.min(9, Math.max(0, Math.floor(e.score * 10)));
    histogram[b] += 1;
  }
  const chats = [...byChat.values()].map((c) => {
    const scores = ring.filter((e) => e.chatKey === c.chatKey && typeof e.score === 'number').map((e) => e.score).sort((a, b) => a - b);
    return {
      ...c,
      avg: c.count ? c.sum / c.count : 0,
      p50: percentile(scores, 50),
      p75: percentile(scores, 75),
      p90: percentile(scores, 90),
      max: scores.length ? scores[scores.length - 1] : 0
    };
  }).sort((a, b) => b.count - a.count).slice(0, 30);
  return { total: ring.length, scored, errors, histogram, chats };
}
