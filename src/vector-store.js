// 会话级向量索引（P1）
// 布局：data/embeddings/<chatKey 下划线>/meta.json + vectors.f32（Float32 连续存储）
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { embedTexts, embeddingReady } from './embeddings.js';

const ROOT = path.join(DATA_DIR, 'embeddings');
const VERSION = 1;

function dirOf(chatKey) {
  return path.join(ROOT, String(chatKey || 'none').replace(/[^a-z0-9_]/gi, '_'));
}
function hashText(t) {
  let h = 5381;
  const s = String(t || '');
  for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
function readMeta(chatKey) {
  try { return JSON.parse(fs.readFileSync(path.join(dirOf(chatKey), 'meta.json'), 'utf8')); } catch { return null; }
}
function readVectors(chatKey, dims, count) {
  try {
    const buf = fs.readFileSync(path.join(dirOf(chatKey), 'vectors.f32'));
    const arr = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + count * dims * 4));
    return arr;
  } catch { return null; }
}
function writeAll(chatKey, meta, vectors) {
  const dir = dirOf(chatKey);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ ...meta, version: VERSION, updatedAt: Date.now() }, null, 2));
  fs.writeFileSync(path.join(dir, 'vectors.f32'), Buffer.from(vectors.buffer));
}

export function indexStatus(chatKey) {
  const m = readMeta(chatKey);
  if (!m) return { indexed: false, count: 0 };
  return { indexed: true, count: (m.items || []).length, model: m.model, dims: m.dims, updatedAt: m.updatedAt };
}

/** 用一组语料重建索引（模型/维度变了也走这里） */
export async function rebuildIndex(chatKey, items, cfg) {
  const clean = (items || []).filter((x) => x && x.text).slice(0, 2000);
  if (!clean.length) { writeAll(chatKey, { model: '', dims: 0, items: [] }, new Float32Array(0)); return { count: 0 }; }
  const { vectors, dims, model } = await embedTexts(clean.map((x) => x.text), { cfg });
  const flat = new Float32Array(vectors.length * dims);
  vectors.forEach((v, i) => flat.set(v.subarray(0, dims), i * dims));
  writeAll(chatKey, { model, dims, scope: String(cfg.decision?.embedding?.corpus?.scope || 'group'), items: clean.map((x) => ({ id: x.id, kind: x.kind, text: String(x.text).slice(0, 400), hash: hashText(x.text) })) }, flat);
  return { count: clean.length, dims, model };
}

/** 增量补索引：只补新语料；模型/维度变化时全量重建 */
export async function ensureIndex(chatKey, items, cfg) {
  if (!embeddingReady(cfg)) return { ok: false, skipped: 'embedding-not-ready' };
  const { model } = { model: String(cfg.decision?.embedding?.model || '') };
  const meta = readMeta(chatKey);
  const scope = String(cfg.decision?.embedding?.corpus?.scope || 'group');
  const clean = (items || []).filter((x) => x && x.text);
  if (!meta || meta.model !== model || !meta.dims || meta.scope !== scope) {
    const r = await rebuildIndex(chatKey, clean, cfg);
    return { ok: true, rebuilt: true, ...r };
  }
  const have = new Set((meta.items || []).map((x) => x.id));
  const add = clean.filter((x) => !have.has(x.id));
  if (!add.length) return { ok: true, rebuilt: false, added: 0 };
  const { vectors, dims } = await embedTexts(add.map((x) => x.text), { cfg });
  const oldFlat = readVectors(chatKey, meta.dims, (meta.items || []).length) || new Float32Array(0);
  const flat = new Float32Array(oldFlat.length + vectors.length * dims);
  flat.set(oldFlat, 0);
  vectors.forEach((v, i) => flat.set(v.subarray(0, dims), oldFlat.length + i * dims));
  writeAll(chatKey, { model: meta.model, dims: meta.dims, scope: meta.scope, items: [...(meta.items || []), ...add.map((x) => ({ id: x.id, kind: x.kind, text: String(x.text).slice(0, 400), hash: hashText(x.text) }))] }, flat);
  return { ok: true, rebuilt: false, added: add.length };
}

/** 对一条文本打分：返回最高相似度与 topK */
export async function scoreText(chatKey, text, cfg, { topK = 5 } = {}) {
  if (!embeddingReady(cfg)) return { ok: false, skipped: 'embedding-not-ready' };
  const meta = readMeta(chatKey);
  if (!meta || !meta.dims || !(meta.items || []).length) return { ok: false, skipped: 'no-index' };
  const { vectors } = await embedTexts([text], { cfg });
  const q = vectors[0];
  if (!q || q.length !== meta.dims) return { ok: false, skipped: 'dim-mismatch' };
  const flat = readVectors(chatKey, meta.dims, meta.items.length);
  if (!flat) return { ok: false, skipped: 'vectors-missing' };
  const normQ = Math.hypot(...q) || 1;
  const scored = meta.items.map((it, i) => {
    let dot = 0; let norm = 0;
    for (let d = 0; d < meta.dims; d += 1) {
      const v = flat[i * meta.dims + d];
      dot += v * q[d];
      norm += v * v;
    }
    return { id: it.id, kind: it.kind, text: it.text, score: dot / (Math.sqrt(norm) * normQ || 1) };
  });
  scored.sort((a, b) => b.score - a.score);
  return { ok: true, score: scored[0]?.score || 0, top: scored.slice(0, topK), dims: meta.dims, count: meta.items.length };
}
