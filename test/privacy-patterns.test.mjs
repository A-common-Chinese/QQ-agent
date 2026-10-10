// DSH 隐私"自定义规则"文本框 ⇄ extraPatterns 的往返测试。
// 解析器住在 ui/app/06-settings-render.js（明文 script，不是 ESM），所以这里按大括号配平
// 把函数源码抠出来在 node 里跑 —— 保证测的就是界面上那份代码。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'ui', 'app', '06-settings-render.js'), 'utf8');

function extract(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`没找到函数 ${name}`);
  let depth = 0;
  let i = source.indexOf('{', start);
  const open = i;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`函数 ${name} 大括号不配平（从 ${open} 开始）`);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const factory = new Function('esc', `${extract('formatPrivacyPatterns')}\n${extract('parsePrivacyPatterns')}\n${extract('privacyPatternsHint')}\nreturn { formatPrivacyPatterns, parsePrivacyPatterns, privacyPatternsHint };`);
const { formatPrivacyPatterns, parsePrivacyPatterns, privacyPatternsHint } = factory(esc);

let pass = 0;
const failures = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass += 1; else failures.push(`${name}\n      实际: ${a}\n      期望: ${e}`);
}

// ── 往返：format → parse 必须还原 ─────────────────────────────────────────
const original = [
  { id: '代号', regex: '夜莺计划', flags: 'gi', action: 'redact', replace: '[已隐去:代号]' },
  { id: '内部域名', regex: '.*\\.corp\\.example\\.com', flags: 'gi', action: 'block' },
  { id: '大小写敏感', regex: 'SecretCode', flags: 'g', action: 'redact', replace: '[已隐去:大小写敏感]' }
];
const text = formatPrivacyPatterns(original);
const roundTrip = parsePrivacyPatterns(text);
check('往返无错误', roundTrip.errors, []);
check('往返规则一致', roundTrip.list, original);

// ── 解析各种写法 ──────────────────────────────────────────────────────────
check('默认打码 + 忽略大小写', parsePrivacyPatterns('代号 = 夜莺计划').list,
  [{ id: '代号', regex: '夜莺计划', flags: 'gi', action: 'redact', replace: '[已隐去:代号]' }]);

check('拒发前缀（中文）', parsePrivacyPatterns('拒发: 内部域名 = .*\\.corp\\.com').list,
  [{ id: '内部域名', regex: '.*\\.corp\\.com', flags: 'gi', action: 'block' }]);

check('block 前缀（英文）', parsePrivacyPatterns('block: k = SECRET').list,
  [{ id: 'k', regex: 'SECRET', flags: 'gi', action: 'block' }]);

check('第三段是 flags', parsePrivacyPatterns('名 = Code = g').list,
  [{ id: '名', regex: 'Code', flags: 'g', action: 'redact', replace: '[已隐去:名]' }]);

check('正则里带 = 不会被拆坏', parsePrivacyPatterns('名 = token=([a-z]+)').list,
  [{ id: '名', regex: 'token=([a-z]+)', flags: 'gi', action: 'redact', replace: '[已隐去:名]' }]);

check('没写名字 → 自动编号', parsePrivacyPatterns('张三').list,
  [{ id: 'custom-1', regex: '张三', flags: 'gi', action: 'redact', replace: '[已隐去:custom-1]' }]);

// ── 注释 / 空行 / 错误 ────────────────────────────────────────────────────
const mixed = parsePrivacyPatterns('\n# 这是注释\n代号 = 夜莺计划\n\n   \n');
check('忽略注释与空行', [mixed.list.length, mixed.errors.length], [1, 0]);

const bad = parsePrivacyPatterns('好的 = 正常\n坏的 = ([unclosed\n只有名字 =\n');
check('非法行进 errors 不进行为', [bad.list.length, bad.errors.length], [1, 2]);
check('errors 里带行号', [bad.errors[0].startsWith('第 2 行'), bad.errors[1].startsWith('第 3 行')], [true, true]);

// ── 提示文案 ──────────────────────────────────────────────────────────────
check('空规则提示', privacyPatternsHint([]), '留空 = 不使用自定义规则。');
check('提示里带条数与动作', privacyPatternsHint(original), '✓ 识别到 3 条规则：代号(打码)、内部域名(拒发)、大小写敏感(打码)');

// ── 生成的规则能被真正的过滤器吃下（privacy.js 的 extraPatterns 契约）─────
const { createPrivacyFilter } = await import('../src/privacy.js');
const filter = createPrivacyFilter({ allowedChats: ['private:85946573'], extraPatterns: parsePrivacyPatterns(text).list });
const hit = filter.filterText('private:000001', '关于夜莺计划 和 SECRETCODE 的事');
check('自定义规则生效（打码）', [hit.ok, hit.text], [true, '关于[已隐去:代号] 和 SECRETCODE 的事']);
const blocked = filter.filterText('private:000001', '访问 .corp.example.com 看看');
check('自定义规则生效（拒发）', [blocked.ok, blocked.blockedBy], [false, '内部域名']);

console.log(`\n通过 ${pass} 项`);
if (failures.length) {
  console.log(`\n失败 ${failures.length} 项：`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('全部通过 ✅');
