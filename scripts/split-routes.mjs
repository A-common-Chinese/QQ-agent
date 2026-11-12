#!/usr/bin/env node
// 一次性生成器：把 routes.js 的 27 个域拆到 src/routes/*.js。
// 不手工改路由体，只做「切段 + 包裹 + 按原顺序展开」，行为不变。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('src');
const FILE = path.join(ROOT, 'routes.js');
const src = fs.readFileSync(FILE, 'utf8');
const lines = src.split('\n');

// ── 1. 找域标记 ────────────────────────────────────────────
const marks = [];
lines.forEach((l, i) => { if (/^    \/\/ ── /.test(l)) marks.push(i); });
const tail = lines.findIndex((l, i) => i > marks.at(-1) && l.trim() === '];');
if (tail < 0) throw new Error('找不到 return [ ... ]; 的结尾');

const sections = marks.map((start, k) => ({
  start,
  end: (k + 1 < marks.length ? marks[k + 1] : tail) - 1,
  title: lines[start].trim().replace(/^\/\/ ── /, '').replace(/[\s─]+$/, '')
}));

// ── 2. 域名分组（按标题关键词）─────────────────────────────
const GROUP = [
  ['system', ['状态 / 数据目录 / 重置', '体检 / 引导', '配置', '自动备份', '版本 / 更新', '日志系统']],
  ['models', ['成本看板', '价格表', '多提供商模型目录', '视觉能力', '自定义搜索提供商', '连通性测试']],
  ['qq', ['SnowLuma 进程管理', '便携 QQ 进程管理', '接入方式', '模型 / 会话 / 存档', '群成员 / 会话控制', '验证码请求转发']],
  ['memory', ['人设模板', '人格卡', '通用卡', '记忆卡', '话题卡', '记忆解释器', '记忆', '存档消息']],
  ['skills', ['Skill 管理']]
];

const used = new Set();
const assigned = new Map();
const titleFor = new Map();   // GROUP 里写的短名 → 实际完整标题
for (const [mod, titles] of GROUP) {
  for (const t of titles) {
    const s = sections.find((x) => x.title === t)
      || sections.find((x) => !assigned.has(x.title) && x.title.includes(t));
    if (!s) throw new Error(`没找到域：${t}`);
    if (assigned.has(s.title)) throw new Error(`域重复：${t}`);
    assigned.set(s.title, mod);
    used.add(s.title);
    titleFor.set(`${mod}\u0000${t}`, s.title);
  }
}
const missing = sections.filter((s) => !used.has(s.title));
if (missing.length) throw new Error('有域未分组：' + missing.map((s) => s.title).join(' / '));

// ── 3. 收集「可以从 C 里解构」的名字 ────────────────────────
const destructureStart = lines.findIndex((l, i) => i > 80 && l.trim() === 'const {');
const destructureEnd = lines.findIndex((l, i) => i > destructureStart && l.trim() === '} = deps;');
const depsBlock = lines.slice(destructureStart + 1, destructureEnd).join('\n');
const depNames = [...depsBlock.matchAll(/([A-Za-z_$][\w$]*)\s*(?:,|$)/gm)].map((m) => m[1]);

// 解析导入名：必须支持**跨行** import（routes.js 里多行命名导入很常见，
// 只扫单行会漏掉 priceFeedStatus 这类名字，导致模块里 ReferenceError）
const importNames = [];
const importText = [];
{
  let buf = '';
  for (const l of lines) {
    if (/^import\s/.test(l)) { buf = l; }
    else if (buf) { buf += '\n' + l; }
    else continue;
    if (/from\s+'[^']+';?\s*$/.test(l)) { importText.push(buf); buf = ''; }
  }
}
for (const block of importText) {
  const named = block.match(/\{([\s\S]*?)\}\s*from/);
  if (named) {
    for (const part of named[1].split(',')) {
      const n = part.trim().replace(/\/\/.*$/, '').trim().split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(n)) importNames.push(n);
    }
  } else {
    const def = block.match(/^import\s+([A-Za-z_$][\w$]*)\s+from/);
    if (def) importNames.push(def[1]);
  }
}

const helperNames = ['conn', 'copyAfterUnlink', 'bodyOf', 'skillRuntimeContext', 'parseSectionsQuery'];
const master = [...new Set([...depNames, ...importNames, ...helperNames, 'deps'])];

// ── 4. 生成模块 ────────────────────────────────────────────
const outDir = path.join(ROOT, 'routes');
fs.mkdirSync(outDir, { recursive: true });

// 用固定英文键，方便主文件按顺序展开
const KEYS = {
  '状态 / 数据目录 / 重置': 'status',
  '体检 / 引导': 'health',
  '配置': 'config',
  '自动备份': 'backup',
  '版本 / 更新': 'update',
  '日志系统': 'logs',
  '成本看板': 'cost',
  '价格表': 'prices',
  '多提供商模型目录': 'providers',
  '视觉能力': 'vision',
  '自定义搜索提供商': 'search',
  '连通性测试': 'connTest',
  'SnowLuma 进程管理': 'snowluma',
  '便携 QQ 进程管理': 'portableQQ',
  '接入方式（QQ 接口：OneBot / 官方机器人）': 'transport',
  '模型 / 会话 / 存档': 'modelSession',
  '群成员 / 会话控制': 'members',
  '验证码请求转发（2026-09-26）': 'captcha',
  '人设模板': 'personaTemplates',
  '人格卡（人设系统重构）': 'personaCards',
  '通用卡（多张 + 人设卡挂靠）': 'genericCards',
  '记忆卡（群聊 / 个人 / 基本事实）': 'memoryCards',
  '话题卡（控制台「记忆 → 本会话」子页签）': 'topics',
  '记忆解释器（本地 qq-memory-studio 桥）': 'memoryStudio',
  '记忆': 'memory',
  '存档消息': 'archive',
  'Skill 管理': 'skills'
};

const orderList = sections.map((s) => {
  const mod = assigned.get(s.title);
  const key = KEYS[s.title];
  if (!mod) throw new Error('未分组的域：' + s.title);
  if (!key) throw new Error('缺 key：' + s.title);
  return { mod, key };
});

for (const [mod, titles] of GROUP) {
  const blocks = [];
  for (const t of titles) {
    const full = titleFor.get(`${mod}\u0000${t}`);
    const s = sections.find((x) => x.title === full);
    const key = KEYS[s.title];
    // 路由体里有 await import('./xxx.js')，搬到子目录后要上移一层
    const body = lines.slice(s.start, s.end + 1).map((l) => l.replace(/import\('\.\//g, "import('../"));
    blocks.push(`    ${key}: [\n${body.join('\n')}\n    ],`);
  }
  const allText = blocks.join('\n');
  // 用宽松边界（允许前面是 . 或 spread 的 ...），误判只会多解构一个名字，无害；
  // 过严会漏掉 `...priceFeedStatus()` 这种写法（拆分时踩过）。
  const needed = master.filter((n) => new RegExp(`(?<![\\w$])${n.replace(/\$/g, '\\$')}(?![\\w$])`).test(allText));
  const header = `// ${mod} 域路由（从 routes.js 拆出，路由体原样保留）。
// 依赖统一从 C 取：C = { ...deps, ...导入的函数, 局部辅助函数 }。
export function ${mod}Routes(C) {
  const {
${needed.map((n) => `    ${n}`).join(',\n')}
  } = C;

  return {
${blocks.join('\n')}
  };
}
`;
  fs.writeFileSync(path.join(outDir, `${mod}.js`), header, 'utf8');
  console.log(`生成 routes/${mod}.js  (${blocks.length} 段, 解构 ${needed.length} 个名字)`);
}

// ── 5. 改写 routes.js ──────────────────────────────────────
const retIdx = lines.findIndex((l, i) => i > 80 && l.trim() === 'return [');
const lastImport = lines.reduce((acc, l, i) => (l.startsWith('import ') ? i : acc), 0);
const top = lines.slice(0, lastImport + 1);
const head = lines.slice(lastImport + 1, retIdx);
// 去掉原 return [ 与 ]; 之间的内容
const tailLines = lines.slice(tail + 1); // `];` 之后（通常是 `}`）
const mods = [...new Set(orderList.map((o) => o.mod))];

const imports = mods.map((m) => `import { ${m}Routes } from './routes/${m}.js';`).join('\n');
const calls = mods.map((m) => `  const ${m.toUpperCase()} = ${m}Routes(C);`).join('\n');
const spread = orderList.map((o) => `    ...${o.mod.toUpperCase()}.${o.key},`).join('\n');

const newFile = [
  ...top,
  imports,
  '',
  ...head,
  '  // 依赖 + 本文件里的辅助函数，一次性交给各域模块（它们各自解构需要的部分）',
  '  const C = {',
  '    deps,          // 路由体里有直接 deps.xxx() 的写法，必须带上原对象',
  '    ...deps,',
  '    conn, copyAfterUnlink, bodyOf, skillRuntimeContext, parseSectionsQuery,',
  `    ${master.filter((n) => importNames.includes(n)).join(', ')}`,
  '  };',
  '',
  calls,
  '',
  '  // 顺序与拆分前完全一致（路由按声明顺序匹配，不能按域重排）',
  '  return [',
  spread,
  '  ];',
  ...tailLines
].join('\n');

fs.writeFileSync(FILE, newFile, 'utf8');
console.log('routes.js 已改写，段数：' + orderList.length);
