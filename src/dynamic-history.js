// 动态上下文条数（影子模式优先）：按群最近活跃度决定"该读多少条历史"。
// 设计要点：
//   · 分档（不是连续公式）+ 迟滞，避免每轮变 N 砸掉提示词缓存
//   · 字数预算上限：条数 × 平均长度 不超过 budgetChars
//   · shadow=true 时只记录推荐值，不改变实际行为（用于对比评估）
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const LOG_DIR = path.join(DATA_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'dynamic-history.log');
const state = new Map();   // chatKey -> { count, since }

function logRecommend(rec) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: Date.now(), ...rec }) + '\n', 'utf8');
  } catch { /* ignore */ }
}

/** 计算推荐条数：rate=最近窗口内每分钟消息数 */
export function recommendHistoryCount({ store, chatKey, cfg }) {
  const dyn = cfg?.store?.dynamicHistory || {};
  if (dyn.enabled === false) return null;
  const windowMin = Math.max(1, Number(dyn.windowMinutes) || 10);
  const hysteresisMs = Math.max(0, Number(dyn.hysteresisMinutes) || 10) * 60 * 1000;
  const minN = Math.max(5, Number(dyn.min) || 20);
  const maxN = Math.max(minN, Number(dyn.max) || 150);
  const budgetChars = Math.max(200, Number(dyn.budgetChars) || 4000);
  const buckets = Array.isArray(dyn.buckets) && dyn.buckets.length
    ? dyn.buckets
    : [{ maxRate: 3, count: 30 }, { maxRate: 8, count: 70 }, { maxRate: Infinity, count: 110 }];

  let msgs = [];
  try { msgs = store?.recent?.(chatKey, { limit: 200 }) || []; } catch { msgs = []; }
  const now = Date.now();
  const since = now - windowMin * 60 * 1000;
  const inWindow = msgs.filter((m) => Number(m?.ts || 0) >= since);
  const rate = inWindow.length / windowMin;
  const lens = inWindow.map((m) => String(m?.text || '').length).filter((n) => n > 0);
  const avgLen = lens.length ? Math.max(8, Math.round(lens.reduce((a, b) => a + b, 0) / lens.length)) : 40;

  let bucket = buckets.find((b) => rate < Number(b.maxRate)) || buckets[buckets.length - 1];
  let count = Math.max(minN, Math.min(maxN, Number(bucket.count) || 70));
  const budgetCap = Math.max(minN, Math.floor(budgetChars / avgLen));
  const capped = count > budgetCap;
  if (capped) count = Math.max(minN, budgetCap);

  // 迟滞：跨档后短时间内不变（避免抖动）
  const prev = state.get(chatKey);
  if (prev && prev.count !== count) {
    if (now - prev.since < hysteresisMs) count = prev.count;
    else state.set(chatKey, { count, since: now });
  } else if (!prev) {
    state.set(chatKey, { count, since: now });
  }

  return { rate: Math.round(rate * 100) / 100, avgLen, count, min: minN, max: maxN, capped, windowMin, budgetChars };
}

/** 把推荐值应用到 store 配置；shadow 模式只记录并返回原值 */
export function applyDynamicHistory(base, { store, chatKey, cfg }) {
  try {
    const rec = recommendHistoryCount({ store, chatKey, cfg });
    if (!rec) return base;
    const shadow = cfg?.store?.dynamicHistory?.shadow !== false;
    const actual = Number(base.historyCount) || 70;
    logRecommend({ chatKey, recommended: rec.count, actual, shadow, rate: rec.rate, avgLen: rec.avgLen, capped: rec.capped });
    if (shadow) return base;
    return { ...base, historyCount: rec.count };
  } catch { return base; }
}

/** 汇总最近 N 条记录（供数据面板）：每群推荐值分布 / 平均速率 / 预算夹紧比例 */
export function summaryDynamicHistory(limit = 500) {
  const out = { total: 0, chats: [] };
  try {
    if (!fs.existsSync(LOG_FILE)) return out;
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).slice(-Math.max(1, Math.min(5000, limit)));
    const by = new Map();
    for (const line of lines) {
      let rec = null; try { rec = JSON.parse(line); } catch { continue; }
      out.total += 1;
      const k = String(rec.chatKey || '?');
      const d = by.get(k) || { chatKey: k, n: 0, sumRec: 0, sumRate: 0, capped: 0, dist: {} };
      d.n += 1; d.sumRec += Number(rec.recommended) || 0; d.sumRate += Number(rec.rate) || 0;
      if (rec.capped) d.capped += 1;
      const r = Number(rec.recommended) || 0;
      d.dist[r] = (d.dist[r] || 0) + 1;
      by.set(k, d);
    }
    out.chats = [...by.values()].map((d) => ({
      chatKey: d.chatKey, n: d.n,
      avgRec: Math.round(d.sumRec / d.n),
      avgRate: Math.round((d.sumRate / d.n) * 100) / 100,
      cappedPct: Math.round((d.capped / d.n) * 100),
      dist: d.dist
    })).sort((a, b) => b.n - a.n);
  } catch { /* ignore */ }
  return out;
}
