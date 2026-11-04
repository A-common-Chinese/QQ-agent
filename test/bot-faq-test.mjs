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
check('FAQ 条目 >= 30', (all.items || []).length >= 30);
check('每条都有 q/keywords/answer', (all.items || []).every((x) => x.id && x.q && Array.isArray(x.keywords) && x.answer));

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
