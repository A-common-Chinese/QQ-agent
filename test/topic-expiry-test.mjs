// 话题卡过期行为：再次提及不能续命、到期要真删（不是只在注入时过滤）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-topic-expiry-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const mc = await import('../src/memory-cards.js');
const tc = await import('../src/topic-cards.js');
const KEY = 'group:9001';

await check('新建 day 话题：expiresAt ≈ 24 小时后', () => {
  const r = tc.upsertTopicCard(KEY, { title: '周末爬山', term: 'day', summary: '约爬山', keywords: ['爬山', '周末'] });
  assert.equal(r.ok, true);
  const card = mc.getTopic(KEY, r.id);
  const delta = card.expiresAt - Date.now();
  assert.ok(Math.abs(delta - 24 * 3600 * 1000) < 5000, `expiresAt 偏差过大：${delta}`);
  return `${r.id} term=${card.term}`;
});

await check('再次提及（同期限）不续命：expiresAt 保持不变', () => {
  const before = mc.listTopics(KEY).find((t) => t.title === '周末爬山');
  const r = tc.upsertTopicCard(KEY, { title: '周末爬山', term: 'day', summary: '又聊了一次', keywords: ['爬山', '周末'] });
  assert.equal(r.action, 'updated');
  assert.equal(r.extended, false, '同期限不应视为延长');
  const after = mc.getTopic(KEY, r.id);
  assert.equal(after.expiresAt, before.expiresAt, `expiresAt 被改了：${before.expiresAt} → ${after.expiresAt}`);
  assert.equal(after.term, 'day');
  return `expiresAt 保持 ${after.expiresAt}`;
});

await check('期限升级才延长：day → week', () => {
  const before = mc.listTopics(KEY).find((t) => t.title === '周末爬山');
  const r = tc.upsertTopicCard(KEY, { title: '周末爬山', term: 'week', summary: '变成长期话题', keywords: ['爬山', '周末'] });
  assert.equal(r.action, 'updated');
  assert.equal(r.extended, true);
  const after = mc.getTopic(KEY, r.id);
  assert.equal(after.term, 'week');
  assert.ok(after.expiresAt > before.expiresAt, '升级后到期时间应更晚');
  return `term=${after.term}`;
});

await check('到期卡：pruneExpiredTopics 真删（移到 .deleted）', () => {
  const r = mc.createTopic('group:9002', { title: '已经过去的话题', term: 'day', expiresAt: Date.now() - 1000 });
  assert.equal(r.ok, true);
  const removed = tc.pruneExpiredTopics('group:9002');
  assert.equal(removed, 1);
  assert.equal(mc.listTopics('group:9002').length, 0, '列表里不应再有这张卡');
  const dir = path.join(dataDir, 'memory-cards', 'group_9002');
  const deleted = fs.readdirSync(dir).filter((f) => f.includes('.deleted'));
  assert.ok(deleted.length >= 1, '应留下 .deleted 备份');
  return deleted[0];
});

await check('未到期卡不会被误删', () => {
  const r = mc.createTopic('group:9002', { title: '还没到期的', term: 'week' });
  assert.equal(tc.pruneExpiredTopics('group:9002'), 0);
  assert.ok(mc.getTopic('group:9002', r.card.id), '未到期卡应还在');
});

await check('pruneAllExpiredTopics：跨会话清理（已过期 2 张）', () => {
  mc.createTopic('group:9101', { title: '过期 A', term: 'day', expiresAt: Date.now() - 5000 });
  mc.createTopic('private:9102', { title: '过期 B', term: 'halfday', expiresAt: Date.now() - 5000 });
  mc.createTopic('group:9101', { title: '未过期 C', term: 'day' });
  const r = tc.pruneAllExpiredTopics();
  assert.ok(r.removed >= 2, `应至少清理 2 张，实际 ${r.removed}`);
  assert.ok(r.chats >= 2, `应涉及至少 2 个会话，实际 ${r.chats}`);
  return `removed=${r.removed} chats=${r.chats}`;
});

try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n${'='.repeat(60)}`);
console.log(fail ? `话题卡过期：通过 ${pass}，失败 ${fail}` : `话题卡过期：全部通过 ✅（${pass} 项）`);
process.exit(fail ? 1 : 0);
