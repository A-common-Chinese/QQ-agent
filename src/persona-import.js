// 人格卡导入器：把"原版人格卡"（人格市场下载的 customPersonas / 全局 roleText / 会话级 roleText）
// 拆成新结构（variant + examples + scenarios），供前端一键导入。
//
// 原版卡是 markdown（## 一、你是谁 / ## 二、群聊说话铁律 …），按标题拆小节后按关键词归类：
//   core→ 收录进 variant（本卡特有），examples→ 解析成 {user,bad,good}，场景类 → scenarios
//   AI 味黑名单类 → 丢弃（新系统统一走 personaPolicy.bannedPhrases）
export const SECTION_KIND = {
  examples: 'examples',
  banned: 'banned',
  core: 'core',
};

function splitSections(text) {
  const out = [];
  let cur = { title: '', lines: [] };
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#{1,3}\s+/.test(line) || /^[一二三四五六七八九十〇]+、/.test(line)) {
      if (cur.lines.length || cur.title) out.push(cur);
      cur = { title: line.replace(/^#+\s*/, '').trim(), lines: [] };
    } else {
      cur.lines.push(line);
    }
  }
  if (cur.lines.length || cur.title) out.push(cur);
  return out.map((s) => ({ title: s.title, text: s.lines.join('\n').trim(), chars: (s.lines.join('') + s.title).length }));
}

export function classifySection(title) {
  const t = String(title || '');
  if (!t) return 'core';                                   // (开头) 无标题 → 本卡主体
  if (/回复示例|示例|例子|对话示例/.test(t)) return 'examples';
  if (/黑名单|禁止出现|禁止说|禁用词|不要这样说话/.test(t)) return 'banned';
  if (/你是谁|定位|身份|性格|人设|最高原则|角色卡|长啥样|形象/.test(t)) return 'core';
  if (/铁律|说话方式|节奏|习惯|语气|人称/.test(t)) return 'voice';
  if (/红线|绝不会做|会做的|禁忌|边界/.test(t)) return 'boundaries';
  return 'scenario';
}

// 从示例小节里解析 {user, bad, good}
function parseExamples(sec) {
  const out = [];
  const lines = String(sec.text || '').split(/\n/).map((l) => l.trim()).filter(Boolean);
  let cur = null;
  for (const l of lines) {
    const user = /^(?:群友|用户|对方|他|她|提问)[:：]\s*(.+)$/.exec(l);
    if (user) { cur = { user: user[1].trim(), bad: '', good: '' }; out.push(cur); continue; }
    if (!cur) continue;
    const bad = /^(?:你不要|也不要|不要|错误|×|✗|✕)[:：]?\s*(.+)$/.exec(l);
    if (bad) { cur.bad = cur.bad ? cur.bad + ' / ' + bad[1].trim() : bad[1].trim(); continue; }
    const good = /^(?:你可以|或者|也叫|正确|√|✓|✔)[:：]?\s*(.+)$/.exec(l);
    if (good) { cur.good = cur.good ? cur.good + ' / ' + good[1].trim() : good[1].trim(); continue; }
  }
  return out.filter((e) => e.user && (e.good || e.bad));
}

// 从关键词里生成正则草稿
function guessTrigger(title, text) {
  const t = title.replace(/^[一二三四五六七八九十〇]+、/, '').trim();
  const words = new Set();
  // 标题里的中文词（2~6 字）作为候选
  for (const m of t.matchAll(/[\u4e00-\u9fa5]{2,6}/g)) words.add(m[0]);
  // 正文里引号包住的短词
  for (const m of String(text || '').matchAll(/["“「]([^"”」\n]{1,12})["”」]/g)) {
    const w = m[1].trim();
    if (w && w.length <= 12) words.add(w);
  }
  const list = [...words].slice(0, 8).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return list.length ? '(' + list.join('|') + ')' : '';
}

/**
 * 把一张原版人格卡（markdown 文本）解析成新结构。
 * 返回 { name, variant, examples, scenarios, sections:[{title,kind,chars}] }
 */
export function parseLegacyCard(name, text) {
  const secs = splitSections(text);
  const variantParts = [];
  const examples = [];
  const scenarios = [];
  const sections = [];
  for (const sec of secs) {
    const kind = classifySection(sec.title);
    sections.push({ title: sec.title || '(开头)', kind, chars: sec.chars });
    if (kind === 'examples') {
      const parsed = parseExamples(sec);
      if (parsed.length) examples.push(...parsed);
      else variantParts.push(sec.text);        // 解析不出来就原样留在 variant 里
      continue;
    }
    if (kind === 'banned') continue;           // 新系统统一走 personaPolicy.bannedPhrases
    // 其它一切（core/voice/boundaries/scenario）都并进 variant —— 导入以「保真」为第一优先，
    // 场景段留给用户在编辑器里自己拆（有表单，不费劲）。
    variantParts.push((sec.title ? '## ' + sec.title + '\n' : '') + sec.text);
  }
  let variant = variantParts.join('\n\n').trim();
  if (!variant && String(text || '').trim()) variant = String(text).trim();   // 无标题的纯文本卡
  return {
    name: String(name || '').trim() || '导入的人格卡',
    variant: variant.slice(0, 6000),
    examples: examples.slice(0, 8),
    scenarios: scenarios.slice(0, 8),
    sections
  };
}
