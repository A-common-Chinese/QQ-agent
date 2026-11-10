// bot-faq 技能回归：重点防「工具返回 undefined」——执行器契约是 { content, isError }
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) { pass += 1; console.log('  OK  ', name); } else { fail += 1; console.log('  FAIL', name); }
};

const mod = await import(pathToFileURL(path.join(ROOT, 'skills', 'bot-faq', 'index.js')).href);

// 假 api：捕获工具定义
let captured = null;
const api = {
  config: () => ({ maxResults: 4 }),
  log: () => {},
  warn: () => {},
  registerTool: (def) => { captured = def; }
};
mod.setup(api);

check('注册了 faq_search 工具', !!captured && captured.id === 'faq_search');
check('有 execute', typeof captured?.execute === 'function');

const r = await captured.execute({ chatKey: 'group:1' }, { query: '怎么安装', limit: 3 });
check('返回对象', r && typeof r === 'object');
check('content 是字符串（不是 undefined）', typeof r.content === 'string' && r.content.length > 2);
check('isError=false', r.isError === false);
let parsed = null;
try { parsed = JSON.parse(r.content); } catch { /* ignore */ }
check('content 可解析 JSON', !!parsed);
check('命中安装类条目', !!parsed && (parsed.items || []).some((x) => x.id === 'install'));
check('带 FAQ 版本号', !!parsed && !!parsed.version);

const empty = await captured.execute({}, { query: '完全不相关的问题xyz' });
check('无命中时也返回 content', typeof empty.content === 'string' && empty.content.includes('没有匹配'));
check('无命中 isError=false', empty.isError === false);

const all = JSON.parse(fs.readFileSync(path.join(ROOT, 'skills', 'bot-faq', 'faq.json'), 'utf8'));
check('FAQ 条目 >= 40', (all.items || []).length >= 40);
check('每条都有 q/keywords/answer', (all.items || []).every((x) => x.id && x.q && Array.isArray(x.keywords) && x.answer));
check('id 不重复', new Set((all.items || []).map((x) => x.id)).size === (all.items || []).length);

// 检索质量：问法 → 期望命中的条目 id
const cases = [
  ['怎么安装这个软件', 'install'],
  ['收不收费', 'free'],
  ['为什么机器人不理人', 'whitelist'],
  ['记忆不生效怎么办', 'memory-not-working'],
  ['怎么省token', 'save-tokens'],
  ['活跃期怎么调', 'active-period-tuning'],
  ['群里发 dsh 没反应', 'dsh-group-mention'],
  ['faq 问答在哪', 'faq-module'],
  ['换电脑怎么迁移数据', 'migrate-computer'],
  ['同群多个机器人会冲突吗', 'multi-bot'],
  ['插件怎么装', 'plugins-skills'],
  ['自动更新怎么工作', 'update-how'],
  ['怎么接入已有的 dsh 会话', 'dsh-use']
];
for (const [q, want] of cases) {
  const r = await captured.execute({}, { query: q, limit: 4 });
  let items = [];
  try { items = JSON.parse(r.content).items || []; } catch { /* ignore */ }
  const ids = items.map((x) => x.id);
  check(`检索「${q}」命中 ${want}`, ids.includes(want));
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
