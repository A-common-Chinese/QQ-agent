// 内置 FAQ：客户端「帮助 / 问答」模块 + QQ 侧 bot-faq 技能共用一份数据。
//
// 数据源：skills/bot-faq/faq.json（随安装包分发，只读）。
// 检索：纯关键词/字面匹配（中文不依赖分词），够用且零依赖；不调用 embedding。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

const FAQ_FILE = path.join(ROOT, 'skills', 'bot-faq', 'faq.json');
let cache = null;   // { version, updatedAt, items, loadedAt }
let cacheMtime = 0;

export function loadFaq() {
  try {
    const st = fs.statSync(FAQ_FILE);
    if (cache && st.mtimeMs === cacheMtime) return cache;
    const raw = JSON.parse(fs.readFileSync(FAQ_FILE, 'utf8'));
    const items = (Array.isArray(raw.items) ? raw.items : []).filter((x) => x && x.q && x.answer);
    cache = { version: String(raw.version || ''), updatedAt: String(raw.updatedAt || ''), items, loadedAt: Date.now() };
    cacheMtime = st.mtimeMs;
    return cache;
  } catch {
    return { version: '', updatedAt: '', items: [], loadedAt: 0 };
  }
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[\s，。！？、,.!?;；:："'“”‘’()（）\-—_]/g, '');
}

/** 关键词打分：关键词命中为主，问题原文/字面重合为辅；低于阈值视为没命中 */
export function searchFaq(query, limit = 5) {
  const faq = loadFaq();
  const q = norm(query);
  if (!q) return [];
  const bigrams = (s) => {
    const out = new Set();
    for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
    return out;
  };
  const qb = bigrams(q);
  // 最长公共子串：抓「记忆不生效」vs「为什么记忆不生效」这种只差几个字的问法
  const lcs = (a, b) => {
    let best = 0;
    const prev = new Array(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i += 1) {
      const cur = new Array(b.length + 1).fill(0);
      for (let j = 1; j <= b.length; j += 1) {
        if (a[i - 1] === b[j - 1]) {
          cur[j] = prev[j - 1] + 1;
          if (cur[j] > best) best = cur[j];
        }
      }
      for (let j = 0; j <= b.length; j += 1) prev[j] = cur[j];
    }
    return best;
  };
  const scored = [];
  for (const item of faq.items) {
    let score = 0;
    for (const kw of (item.keywords || [])) {
      const k = norm(kw);
      if (k && q.includes(k)) score += 10 + Math.min(8, k.length * 1.5);
    }
    const qq = norm(item.q);
    if (qq && (q.includes(qq) || qq.includes(q))) score += 8;
    // 双字重合率：只奖励真正"问到点上"的，避免短词乱命中
    const itb = bigrams(qq);
    let hit = 0;
    for (const b of qb) if (itb.has(b)) hit += 1;
    const ratio = qb.size ? hit / qb.size : 0;
    if (ratio >= 0.4) score += Math.min(6, ratio * 8);
    const l = lcs(q, qq);
    if (l >= 4) score += 8 + Math.min(6, l);
    if (score >= 8) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, Math.min(20, limit))).map((x) => ({ ...x.item, score: Math.round(x.score * 10) / 10 }));
}

/** 用命中条目拼 FAQ 上下文（给模型看的资料） */
export function buildFaqContext(items) {
  if (!items || !items.length) return '';
  return items.map((x, i) => `### ${i + 1}. ${x.q}\n${x.answer}`).join('\n\n');
}

/** 客户端「帮助」模块的系统提示（客服腔、只用 FAQ、不闲聊） */
export function faqSystemPrompt(contextText, version) {
  return [
    '你是 QQ Agent（桌面端 QQ 机器人软件）的客服助手，语气礼貌、简洁、像人工客服。',
    '规则：',
    '1. 只能依据下面提供的《FAQ 资料》回答；资料里没有的内容，直接说「这个我这边没有记录，建议到群里问管理员」，不要猜测、不要编造。',
    '2. 不要回答与 QQ Agent 软件无关的问题；被问到时礼貌说明你只负责软件相关咨询。',
    '3. 不要透露任何密钥、内部配置、服务器路径、其他用户信息。',
    '4. 回答控制在 3~6 行，必要时用短列表；不要输出 Markdown 标题。',
    `5. 当前 FAQ 版本：${version || '未知'}；如果问题涉及版本差异，提醒以最新版本为准。`,
    '',
    '《FAQ 资料》：',
    contextText || '（没有检索到相关资料）'
  ].join('\n');
}
