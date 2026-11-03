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

/** 关键词打分：命中关键词按长度加权，问题原文按公共字符比例加分 */
export function searchFaq(query, limit = 5) {
  const faq = loadFaq();
  const q = norm(query);
  if (!q) return [];
  const scored = [];
  for (const item of faq.items) {
    let score = 0;
    for (const kw of (item.keywords || [])) {
      const k = norm(kw);
      if (k && q.includes(k)) score += 5 + Math.min(6, k.length);
    }
    const qq = norm(item.q);
    if (qq && (q.includes(qq) || qq.includes(q))) score += 4;
    // 公共字符比例（只算中文/字母，防止短问题乱命中）
    let common = 0;
    const set = new Set([...qq]);
    for (const ch of new Set([...q])) if (set.has(ch)) common += 1;
    if (common >= 3) score += Math.min(3, common / 3);
    if (score > 0) scored.push({ item, score });
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
