// OpenAI 兼容 embedding 客户端（语义触发用）
// 支持：远程（硅基流动/智谱/OpenAI/中转站）与本地（Ollama / LM Studio / llama.cpp 的 /v1）
import { getConfig } from './config.js';
import { currentProviders } from './providers.js';

function joinUrl(base, path) {
  let b = String(base || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  if (/\/v1$/i.test(b)) return b + path;
  if (/\/v1\//i.test(b)) return b.replace(/\/v1\/.*$/i, '/v1') + path;
  return b + '/v1' + path;
}

export function resolveEmbedding(cfg = getConfig()) {
  const e = cfg.decision?.embedding || {};
  let baseUrl = String(e.baseUrl || '').trim();
  let apiKey = String(e.apiKey || '').trim();
  if ((!baseUrl || !apiKey) && e.providerId) {
    try {
      const p = currentProviders().find((x) => x && x.id === e.providerId);
      if (p) {
        if (!baseUrl && p.baseURL) baseUrl = String(p.baseURL).trim();
        if (!apiKey && p.apiKey) apiKey = String(p.apiKey).trim();
      }
    } catch { /* 忽略 */ }
  }
  return {
    baseUrl: joinUrl(baseUrl, '/embeddings'),
    apiKey,
    model: String(e.model || '').trim(),
    dims: Number(e.dims) || 0,
    timeoutMs: Math.max(1000, Number(e.timeoutMs) || 8000),
    batchSize: Math.max(1, Number(e.batchSize) || 32)
  };
}

export function embeddingReady(cfg = getConfig()) {
  const r = resolveEmbedding(cfg);
  return !!(r.baseUrl && r.model);
}

/** 批量取向量；返回 { vectors, dims, model } */
export async function embedTexts(texts, { cfg = getConfig(), signal = null } = {}) {
  const r = resolveEmbedding(cfg);
  if (!r.baseUrl || !r.model) throw new Error('embedding 未配置（需要 baseUrl + model）');
  const list = (texts || []).map((t) => String(t == null ? '' : t).slice(0, 4000));
  if (!list.length) return { vectors: [], dims: r.dims || 0, model: r.model };
  const out = [];
  for (let i = 0; i < list.length; i += r.batchSize) {
    const batch = list.slice(i, i + r.batchSize);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), r.timeoutMs);
    if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true });
    try {
      const res = await fetch(r.baseUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(r.apiKey ? { authorization: 'Bearer ' + r.apiKey } : {})
        },
        body: JSON.stringify({ model: r.model, input: batch }),
        signal: ctl.signal
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`embedding HTTP ${res.status}: ${text.slice(0, 160)}`);
      const data = JSON.parse(text);
      const arr = Array.isArray(data?.data) ? data.data : [];
      if (!arr.length) throw new Error('embedding 返回空 data');
      arr
        .sort((a, b) => Number(a.index || 0) - Number(b.index || 0))
        .forEach((row) => {
          const v = Array.isArray(row?.embedding) ? row.embedding : [];
          out.push(Float32Array.from(v));
        });
    } finally {
      clearTimeout(timer);
    }
  }
  const dims = out[0] ? out[0].length : 0;
  if (r.dims && dims && dims !== r.dims) {
    throw new Error(`embedding 维度不匹配：配置 ${r.dims}，实际 ${dims}`);
  }
  return { vectors: out, dims, model: r.model };
}
