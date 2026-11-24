// 人格卡「共用部分」保存回归：
//   1. 卡片编辑器的 useShared / useSharedCore / useSharedVoice 必须能落盘（之前 PUT/POST 忽略）
//   2. ④ 共用段保存（PUT /api/persona-shared）后 GET 必须读到新内容，并同步到当前预设
//   3. 预设的覆盖保存（PUT /api/persona-shared/presets/:id）必须真的改掉对应预设
// 真实 HTTP + 隔离数据目录，不碰用户正在跑的实例。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-persona-shared-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const freePort = () => new Promise((resolve) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
});

let pass = 0;
let fail = 0;
const check = async (name, fn) => {
  try { const extra = await fn(); pass++; console.log(`  OK    ${name}${extra ? ` —— ${extra}` : ''}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        -> ${e?.message ?? e}`); }
};

const port = await freePort();
const dead = await freePort();
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  server: { port, token: '' },
  update: { enabled: false, checkOnStartup: false },
  telemetry: { enabled: false },
  backup: { enabled: false },
  snowluma: { autoLaunch: false, wsUrl: `ws://127.0.0.1:${dead}/`, httpUrl: `http://127.0.0.1:${dead}` },
  skills: { 'qq-presence': { enabled: false } }
}), 'utf8');

const { createApp } = await import('../src/app.js');
const app = createApp({ log: () => {} });
const realPort = await app.start();
const BASE = `http://127.0.0.1:${realPort}`;
const req = (method, p, body) => new Promise((resolve, reject) => {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const u = new URL(p, BASE);
  const r = http.request({
    host: u.hostname, port: u.port, path: u.pathname + u.search, method,
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
  }, (res) => {
    let text = '';
    res.on('data', (c) => { text += c; });
    res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(text) }); } catch { resolve({ status: res.statusCode, body: text }); } });
  });
  r.on('error', reject);
  if (payload) r.write(payload);
  r.end();
});

let cardId = '';
let presetId = '';

await check('新建人格卡时三个共用开关都能落盘', async () => {
  const r = await req('POST', '/api/personas', {
    name: '共用开关测试卡', variant: '卡正文',
    useShared: true, useSharedCore: false, useSharedVoice: false
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  cardId = r.body.persona.id;
  const list = await req('GET', '/api/personas');
  const card = list.body.personas.find((x) => x.id === cardId);
  assert.equal(card.useShared, true);
  assert.equal(card.useSharedCore, false, 'useSharedCore 应为 false');
  assert.equal(card.useSharedVoice, false, 'useSharedVoice 应为 false');
  return cardId;
});

await check('编辑人格卡时共用开关能改（不再被忽略）', async () => {
  const r = await req('PUT', `/api/personas/${encodeURIComponent(cardId)}`, {
    useShared: true, useSharedCore: true, useSharedVoice: false
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const list = await req('GET', '/api/personas');
  const card = list.body.personas.find((x) => x.id === cardId);
  assert.equal(card.useSharedCore, true);
  assert.equal(card.useSharedVoice, false);
});

await check('④ 共用段保存后 GET 立即读到新内容', async () => {
  const r = await req('PUT', '/api/persona-shared', { core: '身份C', voice: '说话V' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const got = await req('GET', '/api/persona-shared');
  assert.equal(got.body.shared.core, '身份C');
  assert.equal(got.body.shared.voice, '说话V');
  const presets = got.body.presets;
  const active = presets.items.find((x) => x.id === presets.activeId);
  assert.ok(active, '应存在当前使用的预设');
  assert.equal(active.core, '身份C', '当前使用预设应同步 core');
  assert.equal(active.voice, '说话V', '当前使用预设应同步 voice');
});

await check('预设「覆盖保存」真的改掉对应预设', async () => {
  const created = await req('POST', '/api/persona-shared/presets', {
    name: '第二份', core: 'C2', voice: 'V2', activate: false
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  presetId = created.body.item.id;
  const saved = await req('PUT', `/api/persona-shared/presets/${encodeURIComponent(presetId)}`, {
    name: '第二份（改）', core: 'C2b', voice: 'V2b'
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const got = await req('GET', '/api/persona-shared');
  const hit = got.body.presets.items.find((x) => x.id === presetId);
  assert.equal(hit.name, '第二份（改）');
  assert.equal(hit.core, 'C2b');
  assert.equal(hit.voice, 'V2b');
  // 非当前使用的预设被覆盖时，生效中的共享内容不应被改
  assert.equal(got.body.shared.core, '身份C');
  return presetId;
});

try { await app.stop(); } catch { /* ignore */ }
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n${'='.repeat(60)}`);
console.log(fail ? `人格卡共用保存：通过 ${pass}，失败 ${fail}` : `人格卡共用保存：全部通过 ✅（${pass} 项）`);
process.exit(fail ? 1 : 0);
