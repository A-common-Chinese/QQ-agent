/**
 * bot-faq —— 软件说明书（内置 FAQ）
 *
 * 为什么是技能不是插件：
 *   "这个问题是不是在问软件本身、要不要查、查完怎么用自己的口吻说" 都是判断题，只能由模型做。
 *   技能只负责：注册 faq_search 工具 + 一段提示词，让模型知道"遇到软件问题先查这个"。
 *
 * 数据源：同目录 faq.json（随包分发）；只读，不联网、不写文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FAQ_FILE = path.join(DIR, 'faq.json');

let api = null;
let faq = { version: '', items: [] };
let mtime = 0;

function load() {
  try {
    const st = fs.statSync(FAQ_FILE);
    if (mtime === st.mtimeMs && faq.items.length) return faq;
    const raw = JSON.parse(fs.readFileSync(FAQ_FILE, 'utf8'));
    faq = { version: String(raw.version || ''), items: Array.isArray(raw.items) ? raw.items.filter((x) => x && x.q && x.answer) : [] };
    mtime = st.mtimeMs;
  } catch (error) {
    api?.warn?.('FAQ 读取失败：%s', error?.message || error);
  }
  return faq;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[\s，。！？、,.!?;；:："'“”‘’()（）\-—_]/g, '');

function search(query, limit) {
  const q = norm(query);
  if (!q) return [];
  const bigrams = (s) => {
    const out = new Set();
    for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
    return out;
  };
  const qb = bigrams(q);
  const lcs = (a, b) => {
    let best = 0;
    let prev = new Array(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i += 1) {
      const cur = new Array(b.length + 1).fill(0);
      for (let j = 1; j <= b.length; j += 1) {
        if (a[i - 1] === b[j - 1]) {
          cur[j] = prev[j - 1] + 1;
          if (cur[j] > best) best = cur[j];
        }
      }
      prev = cur;
    }
    return best;
  };
  const out = [];
  for (const item of load().items) {
    let score = 0;
    for (const kw of (item.keywords || [])) {
      const k = norm(kw);
      if (k && q.includes(k)) score += 10 + Math.min(8, k.length * 1.5);
    }
    const qq = norm(item.q);
    if (qq && (q.includes(qq) || qq.includes(q))) score += 8;
    const itb = bigrams(qq);
    let hit = 0;
    for (const b of qb) if (itb.has(b)) hit += 1;
    const ratio = qb.size ? hit / qb.size : 0;
    if (ratio >= 0.4) score += Math.min(6, ratio * 8);
    const l = lcs(q, qq);
    if (l >= 4) score += 8 + Math.min(6, l);
    if (score >= 8) out.push({ item, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, Math.max(1, Math.min(10, limit))).map((x) => x.item);
}

export function setup(a) {
  api = a;
  a.registerTool({
    id: 'faq_search',
    name: '查软件说明',
    description: '查询本软件（QQ Agent 桌面端）的内置 FAQ：安装、更新、接入、功能、记忆、成本、隐私、排障等。有人问关于软件本身的问题时先用它；查不到就直说不知道。',
    category: 'knowledge',
    icon: '📖',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查的问题或关键词（如"怎么安装""为什么没更新""记忆卡"）' },
        limit: { type: 'number', description: '最多几条，默认 4' }
      },
      required: ['query']
    },
    async execute(ctx, args) {
      // ⚠️ 工具契约是返回 { content: string, isError: boolean }（见 src/tool-registry.js）。
      // 直接返回普通对象会被执行器当成"没有 content" → 模型看到 undefined（历史上出过这个 bug）。
      const ok = (obj) => ({ content: JSON.stringify(obj), isError: false });
      const limit = Math.max(1, Math.min(10, Number(args?.limit) || Number(a.config()?.maxResults) || 4));
      const items = search(String(args?.query || ''), limit + 2);
      if (!items.length) {
        return ok({ ok: true, note: 'FAQ 里没有匹配的条目。不要编造，直接说不知道并建议问管理员。', version: load().version });
      }
      return ok({
        ok: true,
        version: load().version,
        items: items.slice(0, limit).map((x) => ({ id: x.id, q: x.q, answer: x.answer, tags: x.tags || [] })),
        note: '只依据这些条目回答；条目没覆盖的部分不要补充。'
      });
    }
  });
  a.log?.('已加载：内置 FAQ v%s（%d 条）', load().version, load().items.length);
}

export function dispose() {
  api = null;
}
