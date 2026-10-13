// 回溯迁移：把"修复前存下的老长消息"也压成摘要
//
// 背景：DSH 结果只留摘要进提示词是 2026-10-13 18:28 才上线的。在那之前存进存档的长消息
// 没有 promptText 字段，只能被 store.maxPromptChars（默认 2000）兜底截断 —— 也就是说
// 一份 1091 字的旧报告会整段留在上下文里，直到它滑出 80 条历史窗口。
//
// 本脚本给这些"self 且没有 promptText"的老长消息补一个 promptText（摘要），
// 效果等同新版行为：QQ 里的原文不动，只是进提示词时换成摘要。
//
// 用法：
//   node scripts/trim-long-self-messages.mjs --data "<QQ Agent>/data" [--min 300] [--chars 200] [--apply]
// 默认 dry-run（只报告会改什么），带 --apply 才写盘（每个文件先备份 .bak-<时间戳>）。
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const getArg = (name, dflt = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const DATA = getArg('--data');
const MIN = Number(getArg('--min', 300));
const CHARS = Number(getArg('--chars', 200));
const APPLY = args.includes('--apply');

if (!DATA) { console.log('用法: node scripts/trim-long-self-messages.mjs --data "<data 目录>" [--min 300] [--chars 200] [--apply]'); process.exit(1); }

const dir = path.join(DATA, 'messages');
if (!fs.existsSync(dir)) { console.log('找不到 ' + dir); process.exit(1); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const digestOf = (text) => {
  const full = String(text ?? '');
  const head = full.slice(0, CHARS).replace(/\s+/g, ' ').trim();
  return `[历史长消息（共 ${full.length} 字，原文已直接发到会话，此处只是摘要）] ${head}${full.length > CHARS ? '…' : ''}`;
};

let files = 0; let touched = 0; let saved = 0;
for (const name of fs.readdirSync(dir)) {
  if (!name.endsWith('.json')) continue;
  files += 1;
  const p = path.join(dir, name);
  const raw = fs.readFileSync(p, 'utf8');
  const json = JSON.parse(raw);
  const list = Array.isArray(json) ? json : (json.messages || []);
  const targets = list.filter((m) => m && m.self === true && !m.promptText && String(m.text || '').length > MIN);
  if (!targets.length) continue;
  touched += 1;
  console.log(`\n${name}：${targets.length} 条待处理`);
  for (const m of targets) {
    const before = String(m.text).length;
    const after = digestOf(m.text).length;
    console.log(`  ${new Date(m.ts || 0).toLocaleString('sv-SE').slice(5, 16)}  ${before} 字 → 进提示词 ${after} 字（QQ 里原文不动）`);
    if (APPLY) m.promptText = digestOf(m.text);
    saved += before - after;
  }
  if (APPLY) {
    const bak = `${p}.bak-${stamp}`;
    fs.copyFileSync(p, bak);
    fs.writeFileSync(p, JSON.stringify(json, null, 2), 'utf8');
    console.log('  已写盘（备份 ' + path.basename(bak) + '）');
  }
}

console.log(`\n扫描 ${files} 个会话文件，命中 ${touched} 个文件；预计省下 ${saved} 字/轮提示词。`);
console.log(APPLY ? '（已应用）' : '（dry-run：加 --apply 才真正写盘）');
