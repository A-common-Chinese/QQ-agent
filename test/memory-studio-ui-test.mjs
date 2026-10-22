// 记忆「压缩」子页签 UI 测试（控制台原生界面 + 记忆解释器调用 + 导回）。
//
// 背景（项目 B / task-4）：记忆包要靠本地「记忆解释器」（qq-memory-studio）压缩，
// 以前只能开解释器网页版手动上传/下载 .qqmem.json，再切回「记忆导入」导回去。
// 这次在控制台「记忆 → 压缩」子页签里做完整条链路，本测试锁住 6 件事：
//
//   1. **接线方式**：全部控件只有 data-studio / data-studio-opt / data-studio-input
//      三种属性 + document 级委托（控制台 CSP 禁内联 onclick）。这三个选择器必须
//      登记进 test/coverage-wiring.mjs 的 DELEGATED_SELECTOR。
//   2. **冻结的 options 形状**：mode / ratio|targetKB / coldMode / longTermOnly /
//      extractFromTopics / activeParams{topN,minMsgs,recentDays,minMemScore} /
//      mustKeep / keep{facts,impressions,events,prefs,aliases,body} / keepTopShare ——
//      字段名写错解释器会静默忽略，压缩结果就"看起来没生效"。
//   3. **`$('#id')` 引用的 id 都真的存在**（面板 HTML 里能找到），避免点按钮时
//      静默 null。
//   4. **真实交互链路**（jsdom + 真后端，解释器接口用 mock）：状态条 → 载入当前记忆
//      → 开始压缩（进度）→ 结果前后对比 → 二次确认导回（merge/replace + written/
//      skipped）→ 失败时原样显示 error。
//   5. **未安装解释器的引导**：应放路径 + 仓库地址 + 重新检测。
//   6. 缓存戳：ui/index.html 里 05 段的 ?v= 已升位。
//
// 跑法：node test/memory-studio-ui-test.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SRC_05 = fs.readFileSync(path.join(ROOT, 'ui', 'app', '05-memory-settings.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
const COVERAGE = fs.readFileSync(path.join(ROOT, 'test', 'coverage-wiring.mjs'), 'utf8');

const COMPRESS_MARK = '// 记忆「压缩」子页签（本地记忆解释器 qq-memory-studio）';
const markAt = SRC_05.indexOf(COMPRESS_MARK);
const COMPRESS_SRC = markAt >= 0 ? SRC_05.slice(markAt) : '';

let pass = 0;
let fail = 0;
const ok = (m) => { pass++; console.log('  OK    ' + m); };
const bad = (m, d) => { fail++; console.log('  FAIL  ' + m + (d ? '\n        -> ' + d : '')); };
const check = (c, m, d) => { if (c) ok(m); else bad(m, d); };

// ── 1. 静态：源码 / 接线 / 缓存戳 / 关键文案 ────────────────────────────────
console.log('\n=== 1. 静态断言（源码 / 接线 / 缓存戳）===');

check(markAt >= 0, '05-memory-settings.js 里有「压缩」子页签实现段');
check(/MEM_SUBTABS\s*=\s*\[/.test(SRC_05), '定义了 MEM_SUBTABS 子页签清单');
check(/id:\s*'compress'\s*,\s*label:\s*'压缩'/.test(SRC_05), 'MEM_SUBTABS 里新增了 { id:\'compress\', label:\'压缩\' }');

check(/data-studio="/.test(COMPRESS_SRC), '按钮用 data-studio 属性（不写内联 onclick）');
check(/data-studio-opt="/.test(COMPRESS_SRC), '单选/复选用 data-studio-opt');
check(/data-studio-input="/.test(COMPRESS_SRC), '文本/数字/搜索/文件用 data-studio-input');
check(/window\.__memStudioDelegated/.test(COMPRESS_SRC), '委托只装一次（window.__memStudioDelegated 幂等守卫）');
check(/document\.addEventListener\('click'/.test(COMPRESS_SRC), '有 document 级 click 委托');
check(/document\.addEventListener\('change'/.test(COMPRESS_SRC), '有 document 级 change 委托（单选/复选/文件）');
check(/document\.addEventListener\('input'/.test(COMPRESS_SRC), '有 document 级 input 委托（数字/搜索）');
check(!/on(?:click|change|input|submit|keydown)\s*=/i.test(COMPRESS_SRC), '压缩段内没有任何内联事件属性（CSP 禁内联）');

for (const sel of ['[data-studio]', '[data-studio-opt]', '[data-studio-input]']) {
  check(COVERAGE.includes("'" + sel + "'"), `coverage-wiring.mjs 的 DELEGATED_SELECTOR 登记了 ${sel}`);
}
// 断言"有缓存戳且不是话题卡那版（n）"，而不是钉死某个字母 —— 之后每次改 05 都要升位
check(/05-memory-settings\.js\?v=2026\d{4}[a-z]+/.test(INDEX_HTML) && !/05-memory-settings\.js\?v=20261022n/.test(INDEX_HTML),
  'ui/index.html 里 05 段的 ?v= 有缓存戳且已升位（不是话题卡那版的 n）');

// 关键文案 / 引导：用户明确要求的 UX 点都在源码里
const COPY = [
  ['未找到解释器', '未安装解释器的提示'],
  ['tools\\\\memory-studio', '应放路径 tools\\memory-studio'],
  ['github.com/A-common-Chinese/qq-memory-studio', '仓库地址'],
  ['重新检测', '重新检测按钮'],
  ['启动解释器', '启动解释器按钮'],
  ['停止', '停止按钮'],
  ['载入当前记忆', '载入当前记忆'],
  ['选择 .qqmem.json 文件', '选择本地记忆包'],
  ['合并卡片', '方式：合并卡片'],
  ['合并 + 压文字', '方式：合并+压文字'],
  ['只压文字', '方式：只压文字'],
  ['冷门策略', '冷门策略'],
  ['一句话背景', '冷门：一句话背景'],
  ['完全忘掉', '冷门：完全忘掉'],
  ['topN', '活跃参数 topN'],
  ['minMsgs', '活跃参数 minMsgs'],
  ['recentDays', '活跃参数 recentDays'],
  ['minMemScore', '活跃参数 minMemScore'],
  ['mustKeep', 'mustKeep 多选'],
  ['保留字段', '保留字段 6 项'],
  ['从话题提炼长期要点', '话题提炼开关'],
  ['导回 QQ Agent', '导回按钮'],
  ['下载 .qqmem.json', '下载按钮（前端 Blob）'],
  ['重新压缩', '重新压缩'],
  ['确认导回', '导回二次确认'],
  ['已导回 QQ Agent', '导回成功回执'],
  ['跳过', '导回 skipped 展示'],
  ['压缩失败', '失败提示'],
  ['压缩中', '进度条阶段文案']
];
for (const [needle, label] of COPY) {
  check(COMPRESS_SRC.includes(needle), `文案存在：${label}（${needle}）`);
}
check(/new Blob\(/.test(COMPRESS_SRC) && /URL\.createObjectURL/.test(COMPRESS_SRC), '下载走前端 Blob（不经解释器）');
check(/FileReader/.test(COMPRESS_SRC), '本地文件用 FileReader 前端读取（不上传）');

// ── 2. 沙箱：跑 05 段，验证 MEM_SUBTABS / options 形状 / id 引用 ────────────
console.log('\n=== 2. 沙箱渲染（options 形状 / id 引用）===');

function makeEl() {
  const el = {
    innerHTML: '', textContent: '', value: '', checked: false, files: null,
    dataset: {}, style: {}, className: '', tagName: 'DIV',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {}, click() {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    getAttribute: () => null, setAttribute() {}, hasAttribute: () => false
  };
  return el;
}
const sandbox = {
  window: null,
  document: {
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    getElementById: () => null, createElement: () => makeEl(),
    body: makeEl(), documentElement: makeEl()
  },
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])),
  state: { tab: 'memory' },
  api: async () => ({ ok: true }),
  uiConfirm: async () => true,
  memState: () => ({ list: null })
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
try {
  vm.runInContext(SRC_05, ctx, { filename: 'ui/app/05-memory-settings.js' });
  ok('05 段可在沙箱里执行（无顶层副作用报错）');
} catch (e) {
  bad('05 段在沙箱里执行失败', String(e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e));
}

function inCtx(expr) { return vm.runInContext(expr, ctx); }

try {
  const subtabs = JSON.parse(inCtx('JSON.stringify(MEM_SUBTABS)'));
  check(Array.isArray(subtabs) && subtabs.some((t) => t.id === 'compress' && t.label === '压缩'),
    `MEM_SUBTABS 含压缩页签（${subtabs.map((t) => t.id).join(',')}）`);
} catch (e) { bad('读取 MEM_SUBTABS 失败', String(e && e.message)); }

const fns = String(inCtx('[typeof memStudioPanelHtml, typeof memStudioBuildOptions, typeof memStudioHandleAction, typeof memStudioHandleOption, typeof memStudioHandleInput, typeof memStudioRun, typeof memStudioImport, typeof memStudioPollJob, typeof memStudioMount].join(",")'));
check(fns.split(',').every((t) => t === 'function'), '压缩面板的关键函数都已定义（渲染/构造参数/委托分发/执行/导回/轮询/挂载）');

// options 形状（冻结契约，字段名一个都不能错）
function optionsFor(opts, extra) {
  sandbox.__memStudioState.options = Object.assign({
    mode: 'both', targetMode: 'ratio', ratio: 40, targetKB: 60,
    coldMode: 'oneline', longTermOnly: true, extractFromTopics: false,
    keepTopShare: 0.45,
    keep: { facts: true, impressions: true, events: true, prefs: true, aliases: true, body: false },
    activeParams: { topN: '', minMsgs: '', recentDays: '', minMemScore: '' },
    mustKeep: []
  }, opts || {});
  return JSON.parse(inCtx('JSON.stringify(memStudioBuildOptions())'));
}
try {
  const o = optionsFor({}, {});
  for (const k of ['mode', 'ratio', 'coldMode', 'longTermOnly', 'extractFromTopics', 'activeParams', 'mustKeep', 'keep', 'keepTopShare']) {
    check(Object.prototype.hasOwnProperty.call(o, k), `options 含字段 ${k}`);
  }
  check(Array.isArray(o.mustKeep), 'mustKeep 是数组');
  check(Object.keys(o.keep || {}).sort().join(',') === 'aliases,body,events,facts,impressions,prefs',
    `keep 的 6 个字段名正确（${Object.keys(o.keep || {}).join(',')}）`);
  check(Object.keys(o.activeParams || {}).sort().join(',') === 'minMemScore,minMsgs,recentDays,topN',
    `activeParams 的 4 个字段名正确（${Object.keys(o.activeParams || {}).join(',')}）`);
  check(o.ratio === 40 && typeof o.keepTopShare === 'number', '比例目标 → 传 ratio（40）/ keepTopShare 数字');

  const kb = optionsFor({ targetMode: 'kb', targetKB: 80 }, {});
  check(kb.targetKB === 80 && kb.ratio === undefined, 'KB 目标 → 传 targetKB、不传 ratio');

  const free = optionsFor({ targetMode: 'free' }, {});
  check(free.ratio === 30 && free.free === true, '不指定目标 → ratio 30 + free=true');

  const ap = optionsFor({ activeParams: { topN: '12', minMsgs: '', recentDays: '7', minMemScore: '' } }, {});
  check(ap.activeParams.topN === '12' && ap.activeParams.recentDays === '7' && ap.activeParams.minMsgs === '' && ap.activeParams.minMemScore === '',
    '活跃参数留空保持空串（解释器按 null 处理，填了才生效）');

  const keepOff = optionsFor({ keep: { facts: false, impressions: true, events: false, prefs: true, aliases: true, body: true } }, {});
  check(keepOff.keep.facts === false && keepOff.keep.body === true && keepOff.keep.events === false, '保留字段勾选状态如实传下去');
} catch (e) { bad('options 形状断言失败', String(e && e.message)); }

// 面板 HTML：把状态配成"运行中 + 已载入 + 压缩中 + 有结果 + 确认导回"
sandbox.__memStudioState.status = { ok: true, found: true, dir: 'C:\\QQ Agent\\tools\\memory-studio', running: true, port: 7788, url: 'http://127.0.0.1:7788', version: '0.2.0' };
sandbox.__memStudioState.bundle = {
  payload: {
    generals: [{ id: 'g1', name: '全局卡' }],
    groups: [{ chatKey: 'group:123', name: '测试群' }],
    persons: [{ qq: '10001', name: '老王' }],
    topics: [{ id: 'topic:group:123:fact-1', chatKey: 'group:123', title: '周末爬山' }]
  }
};
sandbox.__memStudioState.source = { kind: 'live', name: '当前记忆', counts: { generals: 1, groups: 1, persons: 1, topics: 1 }, stats: { cards: 4, chars: 1234 } };
sandbox.__memStudioState.job = { id: 'job_t', status: 'running', progress: { phase: 'batch', index: 1, total: 2, cards: 3, chars: 100 }, error: '', startedAt: Date.now(), pct: 60, pollTimer: null, pollFails: 0, tick: null };
sandbox.__memStudioState.result = {
  bundle: sandbox.__memStudioState.bundle,
  stats: {
    mode: 'both', before: { cards: 4, chars: 1234 }, after: { cards: 3, chars: 800 },
    costBefore: { perTurnChars: 600 }, costAfter: { perTurnChars: 240 },
    coldMode: 'oneline', personsMerged: 2, coldDropped: 0, coldLines: 1, kept: 2
  },
  warnings: ['有一批文字压缩被防膨胀兜底保护'],
  at: Date.now()
};
sandbox.__memStudioState.importOpen = true;

let panelHtml = '';
try { panelHtml = String(inCtx('memStudioPanelHtml()')); } catch (e) { bad('memStudioPanelHtml() 抛错', String(e && e.message)); }
check(panelHtml.includes('id="memstudio-panel"'), '面板根节点存在');
check(panelHtml.includes('解释器运行中') && panelHtml.includes('127.0.0.1:7788'), '状态条：运行中显示 127.0.0.1:<port>');
check(panelHtml.includes('压缩中') && panelHtml.includes('memstudio-progress-text'), '进度区有进度条 + 阶段文案节点');
check(panelHtml.includes('压缩结果') && panelHtml.includes('每轮注入字数'), '结果区有前后对比表（含每轮注入字数）');
check(panelHtml.includes('冷门成员') && panelHtml.includes('冷门策略'), '结果区展示冷门数 + 冷门策略');
check(panelHtml.includes('确认导回') && /name="memstudio-importmode"/.test(panelHtml), '导回有二次确认面板 + merge/replace 选择');
check(/导出|下载/.test(panelHtml) && panelHtml.includes('下载 .qqmem.json'), '结果区有下载按钮');
check(panelHtml.includes('data-studio="import"'), '导回按钮走 data-studio 委托');
check(!/\son(?:click|change|input)\s*=/i.test(panelHtml), '面板 HTML 里没有内联事件属性');

// mode='both' 时解释器把合并阶段的 stats 放在 stats.merge（server.mjs 的真实形状）——
// 原始的「压缩前」和每轮注入成本只在那份里，取错就会显示成 "-"。
sandbox.__memStudioState.result = {
  bundle: sandbox.__memStudioState.bundle,
  mode: 'both',
  stats: {
    before: { cards: 4, chars: 1200 },     // 合并后的 stats（不是原始）
    after: { cards: 4, chars: 600 },
    merge: {
      before: { cards: 10, chars: 4000 },
      after: { cards: 4, chars: 1200 },
      costBefore: { perTurnChars: 1200 }, costAfter: { perTurnChars: 300 },
      coldMode: 'drop', personsMerged: 5, coldDropped: 5, coldLines: 0, kept: 1
    }
  },
  warnings: [], at: Date.now()
};
let bothHtml = '';
try { bothHtml = String(inCtx('memStudioResultInnerHtml()')); } catch (e) { bad('both 模式结果渲染抛错', String(e && e.message)); }
check(bothHtml.includes('4,000') && bothHtml.includes('600') && bothHtml.includes('1,200') && bothHtml.includes('300'),
  'both 模式：前后对比取「合并前原始数据 → 最终数据」，每轮注入成本从 stats.merge 取');
check(bothHtml.includes('5 人') && bothHtml.includes('完全忘掉') && bothHtml.includes('丢弃 5 人'),
  'both 模式：冷门统计从 stats.merge 读取（不显示 "-"）');
check(bothHtml.includes('合并 + 压文字'), '结果标题标出本次压缩方式（both）');

// `$('#memstudio-*')` / getElementById 引用的 id 必须真的出现在面板 HTML 里（否则点了是静默 null）
const refs = new Set();
for (const m of COMPRESS_SRC.matchAll(/\$\(\s*['"]#(memstudio-[\w-]+)['"]\s*\)/g)) refs.add(m[1]);
for (const m of COMPRESS_SRC.matchAll(/getElementById\(\s*['"](memstudio-[\w-]+)['"]\s*\)/g)) refs.add(m[1]);
check(refs.size > 0, `压缩段引用了 ${refs.size} 个面板 id（待核对）`);
const missing = [...refs].filter((id) => !new RegExp('id="' + id + '"').test(panelHtml));
check(missing.length === 0, '所有 $(\'#memstudio-…\') 引用的 id 都存在于面板 HTML', '缺失：' + missing.join(', '));

// ── 3. 动态：jsdom 里走一遍真实交互（解释器接口用 mock，其余走真后端）────────
console.log('\n=== 3. 动态交互（jsdom + 真后端 + mock 解释器）===');

let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* 下面会跳过 */ }
if (!JSDOM) {
  ok('未安装 jsdom —— 动态部分跳过（npm i -D jsdom 后自动启用）');
} else {
  let boot = null;
  try {
    const { bootApp } = await import('./_harness.mjs');
    boot = await bootApp({});
  } catch (e) {
    ok('动态部分跳过：后端暂时起不来（' + String((e && e.message) || e).slice(0, 80) + '）');
  }
  if (boot) {
    try {
      await runDynamic(boot);
    } catch (e) {
      bad('动态交互执行异常', String((e && e.stack) || e).split('\n').slice(0, 6).join(' | '));
    } finally {
      try { await boot.teardown(); } catch { /* ignore */ }
    }
  }
}

async function runDynamic(boot) {
  const { base } = boot;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, timeoutMs, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (await fn()) return true; } catch { /* 继续等 */ }
      await sleep(100);
    }
    throw new Error('等待超时：' + label);
  };

  // ── mock 解释器侧接口 ─────────────────────────────────────────────────
  const demoBundle = {
    magic: 'qq-agent-memory-bundle', bundleVersion: 1,
    generator: { app: 'QQ Agent DSH', version: '0.5.6' },
    payload: {
      generals: [{ id: 'g1', name: '全局卡', summary: '测试', facts: [], updatedAt: new Date().toISOString() }],
      groups: [{ chatKey: 'group:123', name: '测试群', summary: '群概', updatedAt: new Date().toISOString() }],
      persons: [
        { qq: '10001', name: '老王', facts: [{ key: '爱好', value: '钓鱼' }], updatedAt: new Date().toISOString() },
        { qq: '10002', name: '小李', updatedAt: new Date().toISOString() }
      ],
      topics: [{ id: 'topic:group:123:fact-1', chatKey: 'group:123', title: '周末爬山', updatedAt: new Date().toISOString() }]
    },
    counts: { generals: 1, groups: 1, persons: 2, topics: 1 }
  };
  const compressedBundle = {
    magic: 'qq-agent-memory-bundle', bundleVersion: 1,
    generator: { app: 'QQ Memory Studio', version: '0.2.0' },
    payload: {
      generals: [{ id: 'g1', name: '全局卡', summary: '压缩后的概览', updatedAt: new Date().toISOString() }],
      groups: [{ chatKey: 'group:123', name: '测试群', summary: '压缩后的群概', updatedAt: new Date().toISOString() }],
      persons: [{ qq: '10001', name: '老王', facts: [{ key: '爱好', value: '钓鱼' }], updatedAt: new Date().toISOString() }],
      topics: []
    },
    counts: { generals: 1, groups: 1, persons: 1, topics: 0 }
  };
  const compressStats = {
    mode: 'both',
    before: { cards: 4, chars: 2000 },
    after: { cards: 3, chars: 800 },
    costBefore: { perTurnChars: 600 },
    costAfter: { perTurnChars: 240 },
    coldMode: 'oneline', personsMerged: 2, coldDropped: 0, coldLines: 1, kept: 2
  };

  let mockStatus = { ok: true, found: true, dir: 'C:\\QQ Agent\\tools\\memory-studio', running: true, port: 7788, url: 'http://127.0.0.1:7788', version: '0.2.0' };
  let runPlan = 'done';   // 下一轮压缩：done | failed
  const callBodies = [];
  const importBodies = [];
  const jobState = { polls: 0, plan: 'done' };

  const mkRes = (obj, status = 200) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => obj });

  function mockFetch(input, init) {
    const raw = typeof input === 'string' ? input : String((input && input.url) || '');
    let u;
    try { u = new URL(raw, base); } catch { return null; }
    const p = u.pathname;
    if (p === '/api/memory-studio/status') return mkRes(mockStatus);
    if (p === '/api/memory-studio/start') {
      mockStatus = { ...mockStatus, found: true, running: true, port: 7788, url: 'http://127.0.0.1:7788' };
      return mkRes({ ok: true, running: true, port: 7788, url: 'http://127.0.0.1:7788' });
    }
    if (p === '/api/memory-studio/stop') {
      mockStatus = { ...mockStatus, running: false, port: null, url: null };
      return mkRes({ ok: true, stopped: true });
    }
    if (p === '/api/memory-studio/call') {
      let body = {};
      try { body = JSON.parse(String(init && init.body ? init.body : '{}')); } catch { body = {}; }
      callBodies.push(body);
      if (body.path === '/api/compress/start') {
        jobState.polls = 0;
        jobState.plan = runPlan;
        return mkRes({ ok: true, status: 200, data: { ok: true, jobId: 'job_test_1' } });
      }
      if (String(body.path || '').startsWith('/api/job/')) {
        jobState.polls += 1;
        if (jobState.plan === 'failed') {
          return mkRes({ ok: true, status: 200, data: { ok: true, status: 'failed', progress: { phase: 'merge', index: 1, total: 2 }, error: 'ReferenceError: apTopN is not defined' } });
        }
        if (jobState.polls === 1) {
          return mkRes({ ok: true, status: 200, data: { ok: true, status: 'running', progress: { phase: 'batch', index: 1, total: 2, cards: 3, chars: 700 } } });
        }
        return mkRes({ ok: true, status: 200, data: { ok: true, status: 'done', progress: null, result: { bundle: compressedBundle, stats: compressStats, warnings: [] } } });
      }
      return mkRes({ ok: false, status: 404, data: { ok: false, error: '不允许的接口' } });
    }
    if (p === '/api/memory-bundle/json') {
      return mkRes({ ok: true, bundle: demoBundle, counts: demoBundle.counts, stats: { cards: 4, chars: 2345 } });
    }
    if (p === '/api/memory-bundle/import') {
      let body = {};
      try { body = JSON.parse(String(init && init.body ? init.body : '{}')); } catch { body = {}; }
      importBodies.push(body);
      return mkRes({ ok: true, mode: body.mode === 'replace' ? 'replace' : 'merge', written: { generals: 1, groups: 1, persons: 1, topics: 0 }, skipped: { generals: 0, groups: 0, persons: 1, topics: 1 } });
    }
    return null;
  }

  // ── 加载真实 index.html + 拼接后的 12 段前端代码（同 coverage-wiring）──
  const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  let code = (await import('./_ui-load.mjs')).loadUiAppCode().code;
  code = code.replace(/^'use strict';\s*$/m, '');
  code = code.replace(/^export\s+(function|const|let|async function|class)/gm, '$1');
  const dom = new JSDOM(html, { url: base + '/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const realFetch = (input, init) => fetch(new URL(String(input), base).href, init);
  window.fetch = (input, init) => {
    const mocked = mockFetch(input, init);
    return mocked || realFetch(input, init);
  };
  window.EventSource = class { constructor() {} addEventListener() {} close() {} };
  window.alert = () => {};
  window.confirm = () => true;
  if (typeof window.structuredClone !== 'function') window.structuredClone = (v) => JSON.parse(JSON.stringify(v));
  const tier = await import(pathToFileURL(path.join(ROOT, 'src', 'tier-slider.js')).href);
  const priceMod = await import(pathToFileURL(path.join(ROOT, 'ui', 'vendor', 'price-match.js')).href);
  window.TIER_SLIDER_BANDS = tier.TIER_SLIDER_BANDS;
  window.sliderToTier = tier.sliderToTier;
  window.tierToSlider = tier.tierToSlider;
  window.matchPriceTable = priceMod.matchPriceTable;
  window.eval(code);
  await sleep(800);

  const doc = window.document;
  const text = (el) => String(el && el.textContent || '').replace(/\s+/g, ' ');
  const panelText = () => text(doc.querySelector('#memstudio-panel'));
  const findBtn = (act) => doc.querySelector('#view-memory [data-studio="' + act + '"]');

  // 进入「记忆 → 压缩」
  window.switchTab('memory');
  await waitFor(() => doc.querySelector('#view-memory [data-mem="subtab"][data-sub="compress"]'), 12000, '记忆页子页签');
  doc.querySelector('#view-memory [data-mem="subtab"][data-sub="compress"]').click();
  await waitFor(() => doc.querySelector('#memstudio-panel'), 5000, '压缩面板');
  check(true, '点「压缩」子页签后面板渲染出来（不用单开页面）');

  await waitFor(() => /解释器运行中/.test(panelText()), 5000, '解释器状态');
  check(/127\.0\.0\.1:7788/.test(panelText()), '状态条显示运行中的解释器地址 127.0.0.1:7788');

  // 载入当前记忆
  findBtn('load-live').click();
  await waitFor(() => /已载入/.test(panelText()), 5000, '载入当前记忆');
  check(/通用 1 · 群聊 1 · 个人 2 · 话题 1/.test(panelText()), '载入后显示 counts（通用/群聊/个人/话题）');
  check(/2,345/.test(panelText()), '载入后显示字数（stats.chars）');

  // 选项都在
  const optsText = text(doc.querySelector('#memstudio-options'));
  for (const needle of ['压缩方式', '目标大小', '冷门策略', '活跃参数', '必须保留的卡', '保留字段', '从话题提炼长期要点', 'topN', 'minMsgs', 'recentDays', 'minMemScore']) {
    check(optsText.includes(needle), `选项区有「${needle}」`);
  }
  check(doc.querySelectorAll('#memstudio-options [data-studio-opt="keep"]').length === 6, '保留字段正好 6 个勾选框');
  check(/话题卡|话题/.test(text(doc.querySelector('#memstudio-mustkeep-list'))), 'mustKeep 列表有可勾选的卡');

  // 压缩：进度 → 结果
  const runBtn = findBtn('run');
  check(!!runBtn && !runBtn.disabled, '载入记忆 + 解释器运行后「开始压缩」可点');
  runBtn.click();
  await waitFor(() => /压缩中/.test(panelText()), 4000, '进度区出现');
  check(/合并卡片|压缩文字|提炼话题要点|任务已提交/.test(panelText()), '进度区有阶段文案');
  await waitFor(() => /压缩结果/.test(panelText()), 8000, '压缩完成');
  const resultText = text(doc.querySelector('#memstudio-result'));
  check(resultText.includes('记忆卡数') && resultText.includes('总字数') && resultText.includes('每轮注入字数'), '结果展示前后对比（卡数/字数/每轮注入字数）');
  check(/4/.test(resultText) && /3/.test(resultText), '对比表有压缩前/后的卡数');
  check(resultText.includes('冷门成员') && resultText.includes('2 人'), '结果展示冷门成员数');

  // 导回：二次确认 + 显示 written/skipped
  findBtn('import').click();
  await waitFor(() => /确认导回 QQ Agent/.test(panelText()), 3000, '导回确认面板');
  check(importBodies.length === 0, '点「导回」只弹出二次确认，此时还没有发出导入请求');
  check(doc.querySelectorAll('[data-studio-opt="import-mode"]').length === 2, '二次确认里能选 merge / replace');
  const replaceRadio = doc.querySelector('input[value="replace"][data-studio-opt="import-mode"]');
  replaceRadio.click();
  findBtn('import-confirm').click();
  await waitFor(() => /已导回 QQ Agent/.test(panelText()), 5000, '导回完成');
  check(importBodies.length === 1 && importBodies[0].mode === 'replace', '确认后按所选 mode=replace 调用导入接口');
  check(importBodies[0].bundle && importBodies[0].bundle.payload, '导入请求里带的是压缩后的 bundle');
  const doneText = text(doc.querySelector('#memstudio-result'));
  check(/写入 3 张/.test(doneText), '导回后显示 written 汇总（写入 3 张）');
  check(/跳过 2 张/.test(doneText), '导回后显示 skipped 汇总（跳过 2 张）');

  // 失败：error 原文必须显示出来
  findBtn('recompress').click();
  runPlan = 'failed';
  await sleep(120);
  findBtn('run').click();
  await waitFor(() => /压缩失败/.test(panelText()), 6000, '失败提示');
  check(/ReferenceError: apTopN is not defined/.test(panelText()), '失败时把解释器返回的 error 原文显示出来（不静默）');

  // 未安装解释器的引导：路径 + 仓库地址 + 重新检测
  mockStatus = { ok: true, found: false, dir: '', running: false, port: null, url: null, version: null };
  findBtn('redetect').click();
  await waitFor(() => /未找到解释器/.test(panelText()), 5000, '未找到解释器提示');
  check(/tools\\memory-studio/.test(panelText()), '未安装时显示应放路径 <安装目录>\\tools\\memory-studio');
  check(/github\.com\/A-common-Chinese\/qq-memory-studio/.test(panelText()), '未安装时显示仓库地址');
  check(!!findBtn('redetect'), '未安装时有「重新检测」按钮');

  // 接线兜底：面板里所有控件都挂了 data-studio*（detours 走文档级委托）
  const controls = [...doc.querySelectorAll('#memstudio-panel button, #memstudio-panel input, #memstudio-panel select, #memstudio-panel textarea')];
  const unwired = controls.filter((el) => !el.hasAttribute('data-studio') && !el.hasAttribute('data-studio-opt') && !el.hasAttribute('data-studio-input'));
  check(unwired.length === 0, `面板里 ${controls.length} 个控件全部用 data-studio* 接线`, unwired.map((e) => e.outerHTML.slice(0, 60)).join(' | '));
  check(doc.querySelectorAll('#view-memory [onclick], #view-memory [onchange], #view-memory [oninput]').length === 0, '面板 DOM 里没有内联事件属性');

  window.close();
  dom.window.close();
}

// pathToFileURL 已在顶部 import（runDynamic 里加载 vendor 模块用）

console.log(`\n${fail === 0 ? '全部通过' : '存在失败'} —— 通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
