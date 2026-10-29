// L2 判定（批量 + 多通道兜底 + 去重/采样 + 统计）
//
// 设计：
//   · 判定请求先进队列，按 batchWindowMs 攒批，一次请求判多条（降低调用数与延迟）
//   · 通道链（decision.judge.chain）按顺序尝试：失败/超时/429/JSON 解析失败 → 下一个
//   · 结果按 (chain 签名 + 文本) 缓存 dedupeMs，重复文本直接复用
//   · 采样：samplePercent < 100 时中间带消息按概率进入判定
//   · 统计：调用次数、批次数、失败、兜底、429、耗时，按天累计，供状态/面板展示
import { chatCompletion } from './llm.js';
import { currentProviders } from './providers.js';

const queue = [];
const inflight = new Map();      // chainSig -> Promise
const cache = new Map();         // key -> { at, result }
const stats = {
  day: '',
  items: 0,          // 进入判定的消息数
  batches: 0,        // 实际请求批次数
  calls: 0,          // 尝试过的通道调用次数（含兜底）
  ok: 0,
  errors: 0,
  fallbacks: 0,      // 因为失败切到下一个通道的次数
  rate429: 0,
  cacheHits: 0,
  sampledOut: 0,
  retries: 0,
  msSum: 0,
  byDay: {}
};

function todayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function touchDay() {
  const t = todayKey();
  if (stats.day === t) return;
  if (stats.day) stats.byDay[stats.day] = { items: stats.items, batches: stats.batches, calls: stats.calls, errors: stats.errors, fallbacks: stats.fallbacks, rate429: stats.rate429 };
  stats.day = t;
  stats.items = 0; stats.batches = 0; stats.calls = 0; stats.ok = 0;
  stats.errors = 0; stats.fallbacks = 0; stats.rate429 = 0;
  stats.cacheHits = 0; stats.sampledOut = 0; stats.retries = 0; stats.msSum = 0;
}

function hashText(s) {
  let h = 5381;
  const str = String(s || '');
  for (let i = 0; i < str.length; i += 1) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** 把配置里的 judge 解析成通道链（兼容旧的单通道字段） */
export function resolveJudgeChain(cfg, chatKey = '') {
  const j = cfg.decision?.judge || {};
  const emb = cfg.decision?.embedding || {};
  const raw = Array.isArray(j.chain) && j.chain.length ? j.chain : [];
  let list = raw.filter((x) => x && (x.enabled !== false) && String(x.model || '').trim());
  if (!list.length && String(j.model || '').trim()) {
    list = [{ id: 'legacy', label: '默认判定', providerId: j.providerId, baseUrl: j.baseUrl, apiKey: j.apiKey, model: j.model, timeoutMs: j.timeoutMs, maxTokens: j.maxTokens, temperature: j.temperature }];
  }
  // 每群覆盖：指定用哪些通道、顺序（perChat[chatKey].judgeChainIds）
  const over = (j.perChat && j.perChat[chatKey]) || ((cfg.decision?.perChat || {})[chatKey] || {}).judgeChainIds;
  const ids = Array.isArray(over) ? over : null;
  if (ids && ids.length) {
    const byId = new Map(list.map((x) => [String(x.id), x]));
    list = ids.map((id) => byId.get(String(id))).filter(Boolean);
  }
  return list.map((x, i) => {
    let baseUrl = String(x.baseUrl || '').trim();
    let apiKey = String(x.apiKey || '').trim();
    if (x.providerId) {
      const p = currentProviders().find((y) => y && y.id === x.providerId);
      if (p) {
        if (!baseUrl) baseUrl = String(p.baseURL || '');
        if (!apiKey) apiKey = String(p.apiKey || '');
      }
    }
    if (!baseUrl) baseUrl = String(emb.baseUrl || '');
    if (!apiKey) apiKey = String(emb.apiKey || '');
    return {
      id: String(x.id || ('j' + i)),
      label: String(x.label || x.model || ('通道' + (i + 1))),
      model: String(x.model || '').trim(),
      baseUrl, apiKey,
      timeoutMs: Math.max(1000, Number(x.timeoutMs) || Number(j.timeoutMs) || 2500),
      maxTokens: Math.max(8, Number(x.maxTokens) || Number(j.maxTokens) || 128),
      temperature: Number(x.temperature ?? j.temperature) || 0
    };
  });
}

function chainSig(chain) {
  return chain.map((x) => x.id + '|' + x.model).join(',');
}

function buildPrompt(items) {
  const sys = [
    '你是 QQ 群聊里的一名群友，负责判断"这些消息值不值得我接一句"。',
    '判定标准（按重要度）：',
    '1. 有人在叫我 / 提到我 / 问问题 / 求助 → 值得接（true）',
    '2. 话题跟我的角色、能力、兴趣有关，我能自然接一句 → 值得接（true）',
    '3. 群友在聊他们自己的私事、跟我无关、我只是插嘴会打断 → 不值得（false）',
    '4. 普通群友闲聊（天气、吃饭、吐槽）也算可以接一句 → true，不要一律拒绝。',
    '只输出 JSON 数组：[{"i":序号,"respond":true|false,"confidence":0-100,"reason":"不超过20字"}, ...]',
    'i 必须与输入序号一致；每条都要有结果。'
  ].join('\n');
  const lines = [];
  items.forEach((it, idx) => {
    lines.push('【' + idx + '】');
    const recent = (it.recent || []).slice(-8).map((m) => `${m.senderName || '我'}：${String(m.text || '').slice(0, 80)}`);
    if (recent.length) lines.push('  最近：' + recent.join(' / '));
    lines.push('  待判：' + String(it.text || '').slice(0, 200));
  });
  return { sys, user: lines.join('\n') };
}

function parseBatch(raw, n) {
  let text = String(raw || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  // 容错：截取第一个 [ ... ]
  const a = text.indexOf('['); const b = text.lastIndexOf(']');
  if (a >= 0 && b > a) text = text.slice(a, b + 1);
  let arr;
  try { arr = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  const map = new Map();
  for (const x of arr) {
    const i = Number(x && x.i);
    if (Number.isFinite(i)) map.set(i, x);
  }
  return map.size ? map : null;
}

async function callChain(entries, prompt) {
  let lastErr = '';
  for (let i = 0; i < entries.length; i += 1) {
    const ep = entries[i];
    stats.calls += 1;
    const t0 = Date.now();
    try {
      const resp = await chatCompletion({
        messages: [{ role: 'system', content: prompt.sys }, { role: 'user', content: prompt.user }],
        temperature: ep.temperature,
        maxTokens: ep.maxTokens,
        ...(ep.baseUrl ? { overrides: { baseUrl: ep.baseUrl, apiKey: ep.apiKey, model: ep.model, timeoutMs: ep.timeoutMs } } : {})
      });
      const ms = Date.now() - t0;
      const raw = resp?.message?.content ?? '';
      const parsed = parseBatch(raw, 0);
      if (!parsed) { lastErr = 'bad-json'; stats.errors += 1; continue; }
      return { ok: true, parsed, ms, chainId: ep.id, model: ep.model };
    } catch (e) {
      const msg = String(e?.message ?? e);
      lastErr = msg.includes('429') ? 'rate-429' : /timeout|abort/i.test(msg) ? 'timeout' : 'error';
      if (lastErr === 'rate-429') stats.rate429 += 1;
      stats.errors += 1;
      if (i < entries.length - 1) stats.fallbacks += 1;
    }
  }
  return { ok: false, skipped: lastErr || 'judge-failed' };
}

async function retrySingle(item, chain) {
  // bad-json 兜底：单条再试一次（更简单、更窄的 prompt）
  stats.retries += 1;
  const prompt = buildPrompt([{ text: item.text, recent: item.recent }]);
  prompt.user += '\n\n只输出一个 JSON 对象，不要数组、不要解释。';
  const entries = chain.slice(0, 2);
  const res = await callChain(entries, prompt);
  if (!res.ok) return res;
  const row = res.parsed.get(0) || {};
  return { ok: true, parsed: new Map([[0, row]]), ms: res.ms, chainId: res.chainId, model: res.model };
}

async function flush(sig, items, entries) {
  const cfg = { batch: {} }; // 占位，实际参数由调用方通过 items[0] 携带
  const prompt = buildPrompt(items);
  stats.batches += 1;
  const res = await callChain(entries, prompt);
  return res;
}

/**
 * 提交一条判定请求；内部按批窗口合并。
 * 返回 { ok, respond, confidence, reason, ms, model, chainId, cached } 或 { ok:false, skipped }
 */
export function judgeQueued({ text, recent = [], cfg, chatKey = '' }) {
  touchDay();
  const j = cfg.decision?.judge || {};
  const windowMs = Math.max(200, Number(j.batchWindowMs) || 4000);
  const maxBatch = Math.max(1, Math.min(20, Number(j.maxBatch) || 8));

  // 采样
  const sample = Math.max(1, Math.min(100, Number(j.samplePercent) || 100));
  if (sample < 100 && Math.random() * 100 >= sample) {
    stats.sampledOut += 1;
    return Promise.resolve({ ok: false, skipped: 'judge-sampled-out' });
  }

  const chain = resolveJudgeChain(cfg, chatKey);
  if (!chain.length) return Promise.resolve({ ok: false, skipped: 'judge-no-model' });
  const sig = chainSig(chain);

  // 去重缓存
  const cacheKey = sig + '#' + hashText(text);
  const ttl = Math.max(0, Number(j.dedupeMs) || 0);
  const hit = cache.get(cacheKey);
  if (ttl && hit && Date.now() - hit.at < ttl) {
    stats.cacheHits += 1;
    return Promise.resolve({ ...hit.result, cached: true });
  }

  stats.items += 1;
  return new Promise((resolve) => {
    if (!inflight.has(sig)) {
      // 该链正在批处理：把请求挂到队列，由正在跑的 flush 一起带走
    }
    queue.push({ sig, chatKey, text, recent, resolve, cacheKey, ttl, windowMs, maxBatch, chain });
    schedule(sig);
  });
}

function schedule(sig) {
  const any = queue.some((x) => x.sig === sig);
  if (!any) return;
  const existing = buckets.get(sig);
  if (existing) return;
  const first = queue.find((x) => x.sig === sig);
  const windowMs = first?.windowMs || 4000;
  const timer = setTimeout(() => { buckets.delete(sig); void runBucket(sig); }, windowMs);
  buckets.set(sig, timer);
}

const buckets = new Map();

async function runBucket(sig) {
  const items = [];
  for (let i = 0; i < queue.length && items.length < 32; ) {
    if (queue[i].sig === sig) { items.push(queue[i]); queue.splice(i, 1); } else i += 1;
  }
  if (!items.length) return;
  const chain = items[0].chain;
  const maxBatch = items[0].maxBatch || 8;

  // 分批执行（超过 maxBatch 时拆分）
  for (let start = 0; start < items.length; start += maxBatch) {
    const group = items.slice(start, start + maxBatch);
    const t0 = Date.now();
    let res = await flush(sig, group.map((x) => ({ text: x.text, recent: x.recent })), chain);
    if (!res.ok && res.skipped === 'bad-json') {
      // 整批 JSON 解析失败 → 逐条重试一次
      const retried = [];
      for (const it of group) {
        const r = await retrySingle(it, chain);
        retried.push(r);
      }
      res = { ok: retried.every((r) => r.ok), parsed: new Map(retried.flatMap((r, i) => (r.ok ? [[i, r.parsed.get(0) || {}]] : []))) };
    }
    const ms = Date.now() - t0;
    stats.msSum += ms;
    group.forEach((it, idx) => {
      let out;
      if (res.ok) {
        const row = res.parsed.get(idx) || {};
        out = {
          ok: true,
          respond: row.respond === true,
          confidence: Number(row.confidence) || 0,
          reason: String(row.reason || '').slice(0, 40),
          ms,
          model: res.model,
          chainId: res.chainId
        };
        stats.ok += 1;
      } else {
        out = { ok: false, skipped: res.skipped || 'judge-failed', ms };
      }
      if (it.ttl) cache.set(it.cacheKey, { at: Date.now(), result: out });
      it.resolve(out);
    });
  }

  // 如果同链还有剩，继续调度
  if (queue.some((x) => x.sig === sig)) schedule(sig);
}

export function judgeStats() {
  touchDay();
  const avg = stats.batches ? Math.round(stats.msSum / stats.batches) : 0;
  return {
    day: stats.day,
    retries: stats.retries,
    items: stats.items,
    batches: stats.batches,
    calls: stats.calls,
    ok: stats.ok,
    errors: stats.errors,
    fallbacks: stats.fallbacks,
    rate429: stats.rate429,
    cacheHits: stats.cacheHits,
    sampledOut: stats.sampledOut,
    avgMs: avg,
    byDay: stats.byDay
  };
}
