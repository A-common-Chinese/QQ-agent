// 记忆解释器桥（src/memory-studio.js）回归测试
//
// 覆盖点（全部离线，不联网、不碰真实 data/）：
//   1. 目录探测：配置优先 / 候选顺序 / 无效回退 / 找不到（三态）
//   2. getStatus 三态：未找到 → 已找到未运行 → 运行中（端口+url+version）
//   3. startStudio：幂等、端口被占用时顺延（config.port ~ +9）
//   4. callStudio：白名单转发（含 query）、上游 404 照实转发、拒绝 /api/config、
//      路径归一化绕过（../、绝对 URL、路径段边界）一律拒绝
//   5. stopStudio：子进程真的死了（/api/health 连不上 + pid 不在）、重复 stop 幂等
//   6. /api/memory-bundle/json 的数据来源：buildBundle + bundleStats 的口径
//   7. 静态接线：routes.js 的 5 条路由、app.js 的 deps / 退出清理、config.js 默认值
//
// 假解释器：临时目录里现写一个只有 server.mjs + src/merge.mjs 的最小 HTTP 服务
// （与真解释器同构：/api/health、/api/inspect、/api/compress/start、/api/job/:id）。
//
// 运行：node test/memory-studio-bridge-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ⚠️ 必须在 import 任何 src/ 模块之前定好数据目录：
//    config.js 的 DATA_DIR / CONFIG_FILE 在模块加载时就定型了，晚一步就会读写真实 data/。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-ms-bridge-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  memoryStudio: { enabled: true, dir: '', port: 0 }
}), 'utf8');

const studio = await import('../src/memory-studio.js');
const { getConfig, updateConfig } = await import('../src/config.js');
const { buildBundle, bundleStats } = await import('../src/memory-bundle.js');

const pass = [];
const fail = [];
async function check(name, fn) {
  try { await fn(); pass.push(name); console.log(`  ✓ ${name}`); }
  catch (error) { fail.push({ name, error }); console.error(`  ✗ ${name}\n      ${error.message}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(fn, timeoutMs = 6000, label = 'condition') {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await fn()) return true; } catch { /* 继续等 */ }
    await sleep(60);
  }
  throw new Error(`等待超时：${label}`);
}

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
});
const canBind = (port) => new Promise((resolve) => {
  const srv = net.createServer();
  srv.once('error', () => resolve(false));
  srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
});
const isPidAlive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
};
const healthOk = async (port) => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) return false;
    const data = await res.json();
    return data?.ok === true;
  } catch { return false; }
};

// ── 造一个假解释器（临时目录）───────────────────────────────────────────
const FAKE_SERVER = `// 假记忆解释器：只为桥测试提供同构接口
import http from 'node:http';
const PORT = Number(process.env.PORT || 7788);
const jobs = new Map();
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  if (p === '/api/health') return send(res, 200, { ok: true, version: '9.9.9', pid: process.pid });
  if (p === '/api/inspect') return send(res, 200, { ok: true, inspect: true, query: url.search });
  if (p === '/api/bundle/inspect') return send(res, 200, { ok: true, counts: { generals: 1 } });
  if (p === '/api/compress/start') { jobs.set('job_1', { status: 'running' }); return send(res, 200, { ok: true, jobId: 'job_1' }); }
  if (p.startsWith('/api/job/')) {
    const job = jobs.get(p.slice('/api/job/'.length));
    return job ? send(res, 200, { ok: true, status: job.status }) : send(res, 404, { ok: false, error: '任务不存在' });
  }
  if (p === '/api/config') return send(res, 200, { ok: true, config: { api: { apiKey: 'SHOULD-NEVER-LEAK' } } });
  return send(res, 404, { ok: false, error: '未知接口' });
}).listen(PORT, '127.0.0.1');
`;

const studioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-ms-fake-'));
fs.writeFileSync(path.join(studioDir, 'server.mjs'), FAKE_SERVER, 'utf8');
fs.mkdirSync(path.join(studioDir, 'src'), { recursive: true });
fs.writeFileSync(path.join(studioDir, 'src', 'merge.mjs'), '// 假 merge（目录有效性判据只要求文件存在）\n', 'utf8');
fs.writeFileSync(path.join(studioDir, 'package.json'), JSON.stringify({ name: 'fake-memory-studio', version: '9.9.9' }), 'utf8');

const bogusDir = path.join(os.tmpdir(), 'qq-agent-ms-no-such-dir-' + Date.now());
let occupier = null;

console.log('\n=== 1. 目录探测 ===');

await check('isStudioDir：server.mjs + src/merge.mjs 同时存在才算有效', () => {
  assert.equal(studio.isStudioDir(studioDir), true);
  assert.equal(studio.isStudioDir(bogusDir), false);
  assert.equal(studio.isStudioDir(dataDir), false, '普通数据目录不应被判为解释器目录');
});

await check('候选顺序：config.memoryStudio.dir 第一，其后是安装根/开发态/数据目录候选', () => {
  updateConfig({ memoryStudio: { dir: studioDir } });
  const list = studio.studioCandidates();
  assert.equal(list[0], path.resolve(studioDir), '配置目录必须排第一');
  const mustHave = [
    path.join(ROOT, 'tools', 'memory-studio'),
    path.join(process.resourcesPath ? path.resolve(process.resourcesPath, '..') : ROOT, 'tools', 'memory-studio'),
    path.resolve(ROOT, '..', '..', 'qq-memory-studio'),
    path.resolve(ROOT, '..', 'qq-memory-studio'),
    path.join(path.resolve(dataDir, '..'), 'tools', 'memory-studio')
  ];
  for (const item of mustHave) {
    const idx = list.indexOf(item);
    assert.ok(idx > 0, `候选里缺少 ${item}`);
  }
  // 顺序：安装根 → ROOT/../.. → ROOT/.. → DATA_DIR/..
  const order = mustHave.map((item) => list.indexOf(item));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), `候选顺序不对：${JSON.stringify(order)}`);
});

await check('配置优先：配置目录有效时直接命中（不走回退）', () => {
  updateConfig({ memoryStudio: { dir: studioDir } });
  assert.equal(studio.resolveStudioDir(), path.resolve(studioDir));
});

await check('无效回退：配置目录不存在 → 跳过它（本机有真解释器就回退到真目录）', () => {
  updateConfig({ memoryStudio: { dir: bogusDir } });
  const found = studio.resolveStudioDir();
  assert.notEqual(found, path.resolve(bogusDir), '不应把不存在的配置目录当成结果');
  if (found) assert.equal(studio.isStudioDir(found), true, `回退结果不是有效目录：${found}`);
});

await check('找不到：候选全无效 → resolveStudioDir 返回空、getStatus.found=false', () => {
  studio.setCandidateProviderForTest(() => [bogusDir, path.join(bogusDir, 'nested')]);
  try {
    assert.equal(studio.resolveStudioDir(), '');
    const st = studio.getStatus();
    assert.equal(st.ok, true);
    assert.equal(st.found, false);
    assert.equal(st.dir, '');
    assert.equal(st.hasServer, false);
    assert.equal(st.running, false);
    assert.equal(st.port, null);
    assert.equal(st.url, null);
    assert.equal(st.version, null);
  } finally {
    studio.setCandidateProviderForTest(null);
  }
});

console.log('\n=== 2. status 三态 + start 幂等 ===');

const basePort = await freePort();
studio.setCandidateProviderForTest(() => [studioDir]);
updateConfig({ memoryStudio: { dir: studioDir, port: basePort } });

await check('状态一态：已找到但未运行（port/url 为 null、版本读自解释器 package.json）', () => {
  const st = studio.getStatus();
  assert.equal(st.found, true);
  assert.equal(st.dir, path.resolve(studioDir));
  assert.equal(st.hasServer, true);
  assert.equal(st.running, false);
  assert.equal(st.port, null);
  assert.equal(st.url, null);
  assert.equal(st.version, '9.9.9');
});

let runningPort = null;
let studioPid = null;
await check('startStudio：拉起假解释器并等到 /api/health 就绪', async () => {
  const r = await studio.startStudio({ port: basePort });
  assert.equal(r.ok, true, `启动失败：${r.error}`);
  assert.equal(r.running, true);
  assert.equal(typeof r.port, 'number');
  assert.equal(r.url, `http://127.0.0.1:${r.port}`);
  runningPort = r.port;
  assert.equal(await healthOk(r.port), true, '健康检查应通过');
});

await check('状态二态：运行中（running=true、port=url 端口）', async () => {
  const st = studio.getStatus();
  assert.equal(st.running, true);
  assert.equal(st.port, runningPort);
  assert.equal(st.url, `http://127.0.0.1:${runningPort}`);
});

await check('startStudio 幂等：再调一次不新起进程（alreadyRunning + 端口不变）', async () => {
  const before = await studio.callStudio({ path: '/api/health' });
  studioPid = before.data?.pid;
  assert.ok(studioPid, '应能从 /api/health 拿到解释器 pid');
  const r = await studio.startStudio();
  assert.equal(r.ok, true);
  assert.equal(r.alreadyRunning, true);
  assert.equal(r.port, runningPort);
  const after = await studio.callStudio({ path: '/api/health' });
  assert.equal(after.data?.pid, studioPid, 'pid 变了说明又起了一个解释器');
});

await check('stopStudio：子进程真的没了（/api/health 连不上 + pid 不在）', async () => {
  const r = await studio.stopStudio();
  assert.equal(r.ok, true);
  assert.equal(r.stopped, true);
  await waitUntil(async () => !(await healthOk(runningPort)), 6000, '端口不再响应 /api/health');
  await waitUntil(() => !isPidAlive(studioPid), 6000, '解释器 pid 已退出');
});

await check('stopStudio 幂等：没有在跑时返回 stopped=false 且不报错', async () => {
  const r = await studio.stopStudio();
  assert.equal(r.ok, true);
  assert.equal(r.stopped, false);
});

await check('状态三态回到未运行：running=false、port=null', () => {
  const st = studio.getStatus();
  assert.equal(st.found, true);
  assert.equal(st.running, false);
  assert.equal(st.port, null);
  assert.equal(st.url, null);
});

await check('memoryStudio.enabled=false：startStudio 直接拒绝（不 spawn）', async () => {
  updateConfig({ memoryStudio: { enabled: false } });
  try {
    const r = await studio.startStudio({ port: basePort });
    assert.equal(r.ok, false);
    assert.match(String(r.error), /关闭/);
    assert.equal(studio.getStatus().running, false);
  } finally {
    updateConfig({ memoryStudio: { enabled: true } });
  }
});

console.log('\n=== 3. 端口被占用时顺延 ===');

await check('端口被别的服务占着（不是解释器）→ 自动顺延到下一个端口', async () => {
  // 找一对相邻端口：p 我们自己占住（返回 503，不是解释器），p+1 空着
  let occupiedPort = 0;
  for (let i = 0; i < 30; i += 1) {
    const candidate = await freePort();
    if (candidate > 65535 - 12) continue;
    if (await canBind(candidate + 1)) { occupiedPort = candidate; break; }
  }
  assert.ok(occupiedPort, '找不到可用的相邻端口对');
  occupier = http.createServer((req, res) => { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('busy'); });
  await new Promise((resolve) => occupier.listen(occupiedPort, '127.0.0.1', resolve));
  updateConfig({ memoryStudio: { dir: studioDir, port: occupiedPort } });
  const r = await studio.startStudio();
  assert.equal(r.ok, true, `应顺延成功：${r.error}`);
  assert.equal(r.port, occupiedPort + 1, `应顺延到 ${occupiedPort + 1}，实际 ${r.port}`);
  runningPort = r.port;
  assert.equal(await healthOk(runningPort), true);
  await studio.stopStudio();
  await new Promise((resolve) => occupier.close(resolve));
  occupier = null;
});

console.log('\n=== 4. 代理白名单 ===');

await check('重新拉起解释器（后续代理测试用）', async () => {
  const p = await freePort();
  const r = await studio.startStudio({ port: p });
  assert.equal(r.ok, true, r.error);
  runningPort = r.port;
});

await check('callStudio 正常转发：GET /api/inspect 带 query 原样透传', async () => {
  const r = await studio.callStudio({ path: '/api/inspect?since=2026-01-01' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.inspect, true);
  assert.equal(r.data.query, '?since=2026-01-01');
});

await check('callStudio 正常转发：POST /api/compress/start → 拿 jobId，再轮询 /api/job/:id', async () => {
  const started = await studio.callStudio({
    path: '/api/compress/start', method: 'POST',
    body: { bundle: { magic: 'qq-agent-memory-bundle', bundleVersion: 1 }, options: { mode: 'text' } }
  });
  assert.equal(started.ok, true, started.error);
  assert.equal(started.status, 200);
  assert.equal(started.data.jobId, 'job_1');
  const job = await studio.callStudio({ path: '/api/job/job_1' });
  assert.equal(job.ok, true, job.error);
  assert.equal(job.data.status, 'running');
});

await check('callStudio 拒绝 /api/config（原样返回冻结文案，不带数据）', async () => {
  const r = await studio.callStudio({ path: '/api/config' });
  assert.deepEqual(r, { ok: false, error: '不允许的接口' });
  assert.equal(JSON.stringify(r).includes('SHOULD-NEVER-LEAK'), false, '响应里不得出现解释器的 Key');
});

await check('callStudio 拒绝绕过写法：../ 归一化、绝对 URL、协议相对、路径段边界、非白名单', async () => {
  const attempts = [
    '/api/health/../config',        // 归一化后是 /api/config
    '/api/../api/config',
    'http://127.0.0.1:7788/api/config',
    '//evil.example.com/api/health',
    '/api/healthx',                 // 前缀相似但不是同一路径段
    '/api/jobx/1',
    '/api/echo',                    // 假解释器有，但不在白名单
    '/download/whatever',           // 不以 /api/ 开头
    ''                              // 空
  ];
  for (const attempt of attempts) {
    const r = await studio.callStudio({ path: attempt });
    assert.equal(r.ok, false, `应拒绝：${attempt}`);
    assert.ok(r.error, `拒绝时应给错误文案：${attempt}`);
  }
});

await check('callStudio 未运行时的失败是 { ok:false, error }（不抛到调用方）', async () => {
  await studio.stopStudio();
  const r = await studio.callStudio({ path: '/api/health' });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /未运行/);
});

console.log('\n=== 5. 记忆包数据（/api/memory-bundle/json 的来源）===');

await check('buildBundle + bundleStats：四类卡 counts 与 cards/chars 口径正确', async () => {
  const cardsRoot = path.join(dataDir, 'memory-cards');
  fs.mkdirSync(path.join(cardsRoot, 'generals'), { recursive: true });
  fs.mkdirSync(path.join(cardsRoot, 'persons'), { recursive: true });
  fs.mkdirSync(path.join(cardsRoot, 'group_456'), { recursive: true });
  fs.writeFileSync(path.join(cardsRoot, 'generals', 'g1.json'), JSON.stringify({ id: 'g1', name: '通用', summary: '一二三' }), 'utf8');
  fs.writeFileSync(path.join(cardsRoot, 'persons', 'p1.json'), JSON.stringify({ qq: '123', name: '张三', summary: '喜欢猫' }), 'utf8');
  fs.writeFileSync(path.join(cardsRoot, 'group_456', 'group.json'), JSON.stringify({ name: '覆盖群', summary: '群摘要' }), 'utf8');
  fs.writeFileSync(path.join(cardsRoot, 'group_456', 'topic_group_456_fact-1.json'), JSON.stringify({
    id: 'topic:group:456:fact-1', title: '话题标题', summary: '话题摘要'
  }), 'utf8');

  const bundle = buildBundle({ appVersion: '9.9.9', botName: '覆盖Bot' });
  assert.equal(bundle.magic, 'qq-agent-memory-bundle');
  assert.deepEqual(bundle.counts, { generals: 1, groups: 1, persons: 1, topics: 1 });
  const stats = bundleStats(bundle);
  assert.equal(stats.cards, 4, 'cards 应是四类卡总数');
  assert.ok(stats.chars > 0, 'chars 应是卡片文本总字数');
  assert.equal(stats.approxTokens, Math.round(stats.chars / 1.6));

  // sections 过滤（对应路由的 ?sections=persons）
  const onlyPersons = buildBundle({ sections: { generals: false, groups: false, persons: true, topics: false } });
  assert.deepEqual(onlyPersons.counts, { generals: 0, groups: 0, persons: 1, topics: 0 });

  // since/until 过滤（对应路由的 ?since=&until=）
  const future = buildBundle({ since: '2999-01-01T00:00:00Z' });
  assert.deepEqual(future.counts, { generals: 0, groups: 0, persons: 0, topics: 0 }, '未来时间点应筛掉全部卡');
});

console.log('\n=== 6. 静态接线检查 ===');

await check('routes.js：5 条路由都在「记忆解释器」段（不落在 /api/update/* 或话题卡段）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'routes.js'), 'utf8');
  const patterns = [
    "'/api/memory-studio/status'",
    "'/api/memory-studio/start'",
    "'/api/memory-studio/stop'",
    "'/api/memory-studio/call'",
    "'/api/memory-bundle/json'"
  ];
  const idx = patterns.map((p) => src.indexOf(p));
  for (let i = 0; i < patterns.length; i += 1) assert.ok(idx[i] > 0, `routes.js 缺少 ${patterns[i]}`);
  const afterImport = src.indexOf("'/api/memory-bundle/import'");
  const beforeMute = src.indexOf("'/api/command-mute'");
  assert.ok(idx[4] > afterImport && idx[0] > idx[4] && idx[4] < beforeMute, '新路由应插在记忆包段之后、指令禁言段之前');
  for (let i = 1; i < 4; i += 1) assert.ok(idx[i] > idx[0] && idx[i] < beforeMute, '记忆解释器路由顺序不对');
});

await check('app.js：memory-studio 四件套进 createRoutes deps，退出时 stopStudio + disposeStudio', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
  const depsLine = src.split('\n').find((line) => line.includes('memoryStudioStatus'));
  assert.ok(depsLine, 'createRoutes deps 缺少 memoryStudioStatus');
  for (const name of ['memoryStudioStatus', 'memoryStudioStart', 'memoryStudioStop', 'memoryStudioCall']) {
    assert.ok(depsLine.includes(name), `createRoutes deps 缺少 ${name}`);
  }
  assert.ok(/await memoryStudioStop\(\)/.test(src), 'stop() 里缺少 memoryStudioStop()');
  assert.ok(/memoryStudioDispose\(\)/.test(src), 'createApp 里缺少 disposeStudio() 注册退出清理');
});

await check('config.js：memoryStudio 默认值 = { enabled:true, dir:"", port:7788 }', async () => {
  const { DEFAULT_CONFIG } = await import('../src/config.js');
  assert.deepEqual(DEFAULT_CONFIG.memoryStudio, { enabled: true, dir: '', port: 7788 });
});

await check('工具函数无副作用：getStatus 连续调用不改变状态（同步、不联网）', () => {
  const a = studio.getStatus();
  const b = studio.getStatus();
  assert.deepEqual(a, b);
});

// ── 收尾 ────────────────────────────────────────────────────────────────
studio.setCandidateProviderForTest(null);
try { await studio.stopStudio(); } catch { /* ignore */ }
try { if (occupier) await new Promise((resolve) => occupier.close(resolve)); } catch { /* ignore */ }
try { fs.rmSync(studioDir, { recursive: true, force: true }); } catch { /* ignore */ }
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n记忆解释器桥：通过 ${pass.length}，失败 ${fail.length}`);
if (fail.length) {
  console.log('失败项：');
  for (const item of fail) console.log(`  - ${item.name}\n      ${item.error.message}`);
}
process.exit(fail.length ? 1 : 0);
