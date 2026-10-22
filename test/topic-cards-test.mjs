// 话题卡（topic）读写 + REST + 注入格式测试。
//
// 背景（项目 A 待办）：控制台以前只有「数据与注入」，没有话题卡的编辑界面。
// 这次补了 src/memory-cards.js 的 topic CRUD、src/routes.js 的话题卡 REST 端点、
// 以及「记忆 → 本会话」子页签里的编辑区。本测试锁住四条关键行为：
//
//   1. 文件名 ↔ id 的映射**复用 memory-bundle.js 的同一套**（先按 id 扫存量文件，
//      命中就覆盖它）。直接用 id 拼文件名会写出 topic_topic_group_... 这种
//      重复文件 —— 这张卡的列表/注入都会出现两份。
//   2. 字段白名单：只有 title/body/summary/keywords/updatedAt 能改，id/chatKey 不可改。
//   3. REST 端点齐全：list/get/create/update/delete + 400/404 守卫。
//   4. 注入侧字段格式（title/body/summary/keywords）真的能被 memory-cards-prompt
//      读出来：命中关键词拉全文、未命中进标题索引、summary 供随机闪回。
//
// 数据目录一律隔离到临时目录（QQ_AGENT_DATA_DIR），绝不碰真实 data/。
//
// 运行：node test/topic-cards-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    const extra = await fn();
    pass++;
    console.log(`  OK    ${name}${typeof extra === 'string' && extra ? ` —— ${extra}` : ''}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL  ${name}\n        -> ${e?.message ?? e}`);
  }
}

// ── 数据目录隔离（必须早于 import src/*）──────────────────────────────────
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-topic-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
const CARD_ROOT = path.join(dataDir, 'memory-cards');
const topicDir = (chatKey) => path.join(CARD_ROOT, String(chatKey).replace(/[:\\/]/g, '_'));
const topicFiles = (chatKey) => {
  try { return fs.readdirSync(topicDir(chatKey)).filter((f) => /^topic_.*\.json$/.test(f) && !f.includes('.deleted')); }
  catch { return []; }
};

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

const mc = await import('../src/memory-cards.js');
const bundle = await import('../src/memory-bundle.js');
const prompt = await import('../src/memory-cards-prompt.js');

const KEY = 'group:123';
let firstId = '';

console.log(`\n=== 1. 模块级 topic CRUD（${dataDir}）===`);

await check('createTopic：字段归一化 + 落到历史命名（不会写出 topic_topic_… 双前缀）', () => {
  const r = mc.createTopic(KEY, {
    title: '  周末爬山  ',
    summary: ' 约了老王去爬香山 ',
    body: '周六早上八点北宫门集合，带上水和防晒。',
    keywords: '爬山, 周末  爬山，'
  });
  assert.equal(r.ok, true, `createTopic 失败：${r.error}`);
  const card = r.card;
  assert.match(String(card.id), /^topic:group:123:fact-/, `id 格式不对：${card.id}`);
  assert.equal(card.chatKey, KEY);
  assert.equal(card.title, '周末爬山');
  assert.equal(card.summary, '约了老王去爬香山');
  assert.deepEqual(card.keywords, ['爬山', '周末'], `关键词应去重归一：${JSON.stringify(card.keywords)}`);
  assert.ok(Number.isFinite(Date.parse(card.updatedAt)), 'updatedAt 应是 ISO 时间');
  const files = topicFiles(KEY);
  assert.equal(files.length, 1, `应只写 1 个文件，实际：${files.join(', ')}`);
  assert.ok(!files[0].startsWith('topic_topic_'), `文件名不应带双前缀：${files[0]}`);
  assert.match(files[0], /^topic_group_123_fact-/, `应沿用历史命名：${files[0]}`);
  const disk = JSON.parse(fs.readFileSync(path.join(topicDir(KEY), files[0]), 'utf8'));
  assert.equal(disk.id, card.id, '落盘 id 应与返回一致');
  firstId = card.id;
  return `${card.id} → ${files[0]}`;
});

await check('listTopics / getTopic：能按 id 读回，chatKey 自动补齐', () => {
  const list = mc.listTopics(KEY);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, firstId);
  assert.equal(list[0].chatKey, KEY);
  const one = mc.getTopic(KEY, firstId);
  assert.ok(one, 'getTopic 应命中');
  assert.equal(one.title, '周末爬山');
  assert.equal(mc.getTopic(KEY, 'topic:group:123:不存在的'), null);
  assert.equal(mc.getTopic('badkey', firstId), null, '非法 chatKey 应返回 null');
});

await check('updateTopic：字段白名单（id/chatKey/未知字段被忽略）+ 原子写', () => {
  const before = mc.getTopic(KEY, firstId);
  const r = mc.updateTopic(KEY, firstId, {
    title: '周末爬山（改）',
    summary: '改过的摘要',
    body: '改过的正文',
    keywords: ['爬山', '香山'],
    id: 'topic:group:123:hacked',
    chatKey: 'group:999',
    evil: 'should-not-save'
  });
  assert.equal(r.ok, true);
  assert.equal(r.card.id, firstId, 'id 不允许被改');
  assert.equal(r.card.chatKey, KEY, 'chatKey 不允许被改');
  assert.equal(r.card.evil, undefined, '白名单外字段不应落盘');
  assert.equal(r.card.title, '周末爬山（改）');
  assert.deepEqual(r.card.keywords, ['爬山', '香山']);
  assert.ok(Date.parse(r.card.updatedAt) >= Date.parse(before.updatedAt), 'updatedAt 应刷新');
  const files = topicFiles(KEY);
  assert.equal(files.length, 1, `更新不应产生第二个文件：${files.join(', ')}`);
  const disk = JSON.parse(fs.readFileSync(path.join(topicDir(KEY), files[0]), 'utf8'));
  assert.equal(disk.title, '周末爬山（改）');
  assert.equal(disk.id, firstId);
  return `${files[0]}（仍是 1 个文件）`;
});

await check('历史遗留文件（topic_group_777_fact-legacy.json）：编辑时覆盖原文件，不新建重复文件', () => {
  const dir = topicDir('group:777');
  fs.mkdirSync(dir, { recursive: true });
  const legacyId = 'topic:group:777:fact-legacy';
  const legacyFile = path.join(dir, 'topic_group_777_fact-legacy.json');
  fs.writeFileSync(legacyFile, JSON.stringify({
    id: legacyId, title: '老话题', summary: '老摘要', body: '老正文', keywords: ['老'], updatedAt: '2026-01-01T00:00:00.000Z'
  }, null, 1), 'utf8');
  const r = mc.updateTopic('group:777', legacyId, { title: '老话题（改）' });
  assert.equal(r.ok, true, `更新历史文件失败：${r.error}`);
  const files = topicFiles('group:777');
  assert.equal(files.length, 1, `不应写出重复文件，实际：${files.join(', ')}`);
  assert.equal(files[0], 'topic_group_777_fact-legacy.json', '应复用历史文件名');
  assert.equal(JSON.parse(fs.readFileSync(legacyFile, 'utf8')).title, '老话题（改）');
  return '复用 topic_group_777_fact-legacy.json';
});

await check('导入侧（memory-bundle.applyImport）写过的 topic 也能被 updateTopic 命中同一文件', () => {
  const importedId = 'topic:group:999:fact-imported';
  const r = bundle.applyImport({
    magic: 'qq-agent-memory-bundle',
    bundleVersion: 1,
    payload: {
      topics: [{
        id: importedId, chatKey: 'group:999', title: '导入的话题', summary: '导入摘要',
        body: '导入正文', keywords: ['导入'], updatedAt: '2026-02-02T00:00:00.000Z'
      }]
    }
  }, { sections: { generals: false, groups: false, persons: false, topics: true } });
  assert.equal(r.ok, true, `导入失败：${(r.errors || []).join('; ')}`);
  assert.equal(topicFiles('group:999').length, 1);
  const upd = mc.updateTopic('group:999', importedId, { title: '导入的话题（改）' });
  assert.equal(upd.ok, true, `更新导入卡失败：${upd.error}`);
  assert.equal(topicFiles('group:999').length, 1, '更新导入卡不应产生第二个文件');
  return 'applyImport → updateTopic 同文件';
});

await check('守卫：非法 chatKey / 不存在的卡', () => {
  assert.equal(mc.createTopic('hack/../x', { title: 'x' }).ok, false);
  assert.equal(mc.createTopic('group:123', { id: firstId, title: '重复 id' }).error, 'exists');
  assert.equal(mc.updateTopic('group:123', 'topic:group:123:nope', { title: 'x' }).error, 'not_found');
  assert.equal(mc.deleteTopic('group:123', 'topic:group:123:nope').error, 'not_found');
});

console.log('\n=== 2. 注入侧字段格式（memory-cards-prompt）===');

await check('关键词命中：title/body 进【相关话题】；未命中进【其它话题】标题索引', () => {
  // 再建一张不会被命中的卡，验证标题索引
  const r2 = mc.createTopic(KEY, {
    title: '公司团建', summary: '下月团建投票', body: '候选：漂流 / 烧烤', keywords: ['团建']
  });
  assert.equal(r2.ok, true);
  const block = prompt.buildMemoryCardsBlock({
    chatKey: KEY,
    triggerEntries: [{ senderId: '111', text: '周末去爬山吗？' }],
    pastMessages: [],
    cfg: { enabled: true, maxChars: 1500, flashbackCount: 0 }
  });
  assert.ok(block.includes('【相关话题】'), `应出现相关话题段：\n${block}`);
  assert.ok(block.includes('周末爬山（改）'), '命中卡标题应出现');
  assert.ok(block.includes('改过的正文'), '命中卡正文应出现');
  assert.ok(block.includes('【其它话题】'), `应出现标题索引：\n${block}`);
  assert.ok(block.includes('公司团建'), '未命中卡应出现在标题索引');
  assert.ok(!/【其它话题】[^\n]*改过的正文/.test(block), '未命中卡不应注入正文');
  return `${block.length} 字符`;
});

await check('summary 供随机闪回（flashbackCount=1 时出现【偶然想起】）', () => {
  const block = prompt.buildMemoryCardsBlock({
    chatKey: KEY,
    triggerEntries: [{ senderId: '111', text: '今天天气不错' }],   // 两个关键词都不命中
    pastMessages: [],
    cfg: { enabled: true, maxChars: 1500, flashbackCount: 1 }
  });
  assert.ok(block.includes('【偶然想起】'), `应出现偶然想起段：\n${block}`);
  assert.ok(block.includes('下月团建投票') || block.includes('改过的摘要'), '闪回应带 summary');
});

console.log('\n=== 3. REST 端点（真实 HTTP，隔离数据目录）===');

const port = await freePort();
// 再取一个"空闲但不监听"的端口给 OneBot：本测试绝不能连上用户正在跑的
// SnowLuma（3001）—— 那个服务属于用户真实的机器人，测试连上去/退出时改在线状态
// 都会干扰它。指向死端口后，启动/停止时的 presence 钩子只会得到 ECONNREFUSED。
const deadOneBotPort = await freePort();
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  server: { port, token: '' },
  // 测试不联网、不拉起 SnowLuma、不写 D:/QQ-Agent-Backups
  update: { enabled: false, checkOnStartup: false },
  telemetry: { enabled: false },
  backup: { enabled: false },
  snowluma: {
    autoLaunch: false,
    wsUrl: `ws://127.0.0.1:${deadOneBotPort}/`,
    httpUrl: `http://127.0.0.1:${deadOneBotPort}`
  },
  // 在线状态守卫会在 app.stop() 时把 QQ 设成「请勿打扰」—— 测试里必须禁掉
  skills: { 'qq-presence': { enabled: false } }
}), 'utf8');

const { createApp } = await import('../src/app.js');
const app = createApp({ log: () => {} });
let base = '';
try {
  const realPort = await app.start();
  base = `http://127.0.0.1:${realPort}`;
} catch (e) {
  console.log(`  FAIL  启动测试服务失败：${e?.message ?? e}`);
  fail++;
}

const req = (method, p, body) => new Promise((resolve, reject) => {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const u = new URL(p, base);
  const r = http.request({
    host: u.hostname, port: u.port, path: u.pathname + u.search, method,
    headers: { 'content-type': 'application/json', 'x-console-token': '' }
  }, (res) => {
    let text = '';
    res.on('data', (c) => { text += c; });
    res.on('end', () => {
      let data = null;
      try { data = JSON.parse(text); } catch { /* 非 JSON */ }
      resolve({ status: res.statusCode, data, text });
    });
  });
  r.on('error', reject);
  if (payload) r.write(payload);
  r.end();
});

if (base) {
  const apiKey = 'group:321';
  let restId = '';

  await check('POST /api/memory-cards/topics：新建成功且返回 card', async () => {
    const r = await req('POST', '/api/memory-cards/topics', {
      chatKey: apiKey, title: '接口话题', summary: '接口摘要', body: '接口正文', keywords: ['接口', '测试']
    });
    assert.equal(r.status, 200, `HTTP ${r.status}: ${r.text}`);
    assert.equal(r.data.ok, true);
    assert.match(String(r.data.card.id), /^topic:group:321:fact-/);
    assert.deepEqual(r.data.card.keywords, ['接口', '测试']);
    restId = r.data.card.id;
    return r.data.card.id;
  });

  await check('GET /api/memory-cards/topics?chatKey=…：列出 1 张', async () => {
    const r = await req('GET', `/api/memory-cards/topics?chatKey=${encodeURIComponent(apiKey)}`);
    assert.equal(r.status, 200);
    assert.equal(r.data.topics.length, 1);
    assert.equal(r.data.topics[0].id, restId);
  });

  await check('GET /api/memory-cards/topics/:id：单张读取', async () => {
    const r = await req('GET', `/api/memory-cards/topics/${encodeURIComponent(restId)}?chatKey=${encodeURIComponent(apiKey)}`);
    assert.equal(r.status, 200, `HTTP ${r.status}: ${r.text}`);
    assert.equal(r.data.card.title, '接口话题');
  });

  await check('PUT /api/memory-cards/topics/:id：更新标题/正文并回到列表', async () => {
    const r = await req('PUT', `/api/memory-cards/topics/${encodeURIComponent(restId)}`, {
      chatKey: apiKey, title: '接口话题（改）', body: '接口正文（改）'
    });
    assert.equal(r.status, 200, `HTTP ${r.status}: ${r.text}`);
    assert.equal(r.data.card.title, '接口话题（改）');
    const list = await req('GET', `/api/memory-cards/topics?chatKey=${encodeURIComponent(apiKey)}`);
    assert.equal(list.data.topics[0].title, '接口话题（改）');
  });

  await check('守卫：400（缺 chatKey / 非法 chatKey）+ 404（不存在 id）', async () => {
    const noKey = await req('GET', '/api/memory-cards/topics');
    assert.equal(noKey.status, 400, `缺 chatKey 应 400，实际 ${noKey.status}`);
    const badKey = await req('POST', '/api/memory-cards/topics', { chatKey: 'not-a-chat', title: 'x' });
    assert.equal(badKey.status, 400, `非法 chatKey 应 400，实际 ${badKey.status}`);
    const missing = await req('GET', `/api/memory-cards/topics/${encodeURIComponent('topic:group:321:nope')}?chatKey=${encodeURIComponent(apiKey)}`);
    assert.equal(missing.status, 404, `不存在 id 应 404，实际 ${missing.status}`);
  });

  await check('DELETE /api/memory-cards/topics/:id：删除后列表为空（文件改名为 .deleted 备份）', async () => {
    const before = topicFiles(apiKey).length;
    const r = await req('DELETE', `/api/memory-cards/topics/${encodeURIComponent(restId)}?chatKey=${encodeURIComponent(apiKey)}`);
    assert.equal(r.status, 200, `HTTP ${r.status}: ${r.text}`);
    const list = await req('GET', `/api/memory-cards/topics?chatKey=${encodeURIComponent(apiKey)}`);
    assert.equal(list.data.topics.length, 0);
    assert.equal(topicFiles(apiKey).length, before - 1);
    const backups = fs.readdirSync(topicDir(apiKey)).filter((f) => f.includes('.deleted-'));
    assert.equal(backups.length, 1, '删除应留 .deleted 备份而不是真删');
    return backups[0];
  });

  await check('没碰 /api/update/*（本任务禁区，只确认话题卡路由插在记忆卡区）', async () => {
    // 只做静态确认：新路由在 /api/memory-cards/person 之后、/api/personas 之前
    const src = fs.readFileSync(path.join(ROOT, 'src', 'routes.js'), 'utf8');
    const at = src.indexOf("'/api/memory-cards/topics'");
    const person = src.indexOf("method: 'DELETE', pattern: /^\\/api\\/memory-cards\\/person\\/(\\d+)$/");
    const personas = src.indexOf("'/api/personas'");
    assert.ok(at > 0 && person > 0 && personas > 0);
    assert.ok(at > person && at < personas, '话题卡路由应落在记忆卡路由区，不要挪到别处');
  });
}

console.log('\n=== 4. 前端接线静态检查 ===');

await check('05-memory-settings.js：话题卡控件只用 data-topic（无内联 onclick）', () => {
  const ui = fs.readFileSync(path.join(ROOT, 'ui', 'app', '05-memory-settings.js'), 'utf8');
  assert.ok(ui.includes('data-topic="new"') && ui.includes('data-topic="save"') && ui.includes('data-topic="del"'), '缺少 data-topic 控件');
  assert.ok(ui.includes("closest('#view-memory [data-topic]')"), '缺少 document 级委托');
  assert.ok(!/<[^>]*\sonclick\s*=/.test(ui), '出现了内联 onclick 属性（CSP 会拦）');
});

await check('coverage-wiring.mjs 的 DELEGATED_SELECTOR 已登记 [data-topic]', () => {
  const t = fs.readFileSync(path.join(ROOT, 'test', 'coverage-wiring.mjs'), 'utf8');
  assert.ok(t.includes("'[data-topic]'"), 'DELEGATED_SELECTOR 缺少 [data-topic] —— 接线测试会判"未接线"');
});

await check('ui/index.html：05-memory-settings.js 的 ?v= 已升一档（浏览器缓存）', () => {
  const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  const m = /05-memory-settings\.js\?v=([\w]+)/.exec(html);
  assert.ok(m, 'index.html 里 05-memory-settings.js 缺少 ?v= 缓存后缀');
  assert.notEqual(m[1], '20261022n', '改过 05 之后 ?v= 必须升一档，否则用户看到旧脚本');
  return `?v=${m[1]}`;
});

// ── 收尾 ────────────────────────────────────────────────────────────────
try { if (base) await app.stop(); } catch { /* ignore */ }
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n${'='.repeat(64)}`);
console.log(fail ? `话题卡：通过 ${pass}，失败 ${fail}` : `话题卡：全部通过 ✅（${pass} 项）`);
process.exit(fail ? 1 : 0);
