// 传输层（P1）单测：接口契约 + OneBot 适配器映射。不连真实 QQ，全部用假 client。
import assert from 'node:assert/strict';
import { createTransport, TRANSPORT_KINDS } from '../src/transport/index.js';
import { Transport, UnsupportedError, DEFAULT_CAPABILITIES } from '../src/transport/base.js';

const calls = [];
function fakeClient() {
  return {
    connect: async () => { calls.push(['connect']); },
    close: () => { calls.push(['close']); },
    onStatus: (fn) => { calls.push(['onStatus']); return fn; },
    sendText: async (...a) => { calls.push(['sendText', ...a]); return { message_id: 1 }; },
    sendImage: async (...a) => { calls.push(['sendImage', ...a]); return { message_id: 2 }; },
    sendSticker: async (...a) => { calls.push(['sendSticker', ...a]); return { message_id: 3 }; },
    sendSegments: async (...a) => { calls.push(['sendSegments', ...a]); return { message_id: 4 }; },
    sendPoke: async (...a) => { calls.push(['sendPoke', ...a]); return {}; },
    call: async (...a) => { calls.push(['call', ...a]); return {}; },
    getMsg: async (id) => { calls.push(['getMsg', id]); return { message_id: id }; },
    getGroupInfo: async (id) => { calls.push(['getGroupInfo', id]); return { group_id: id }; },
    getGroupMemberInfo: async (g, u) => { calls.push(['getGroupMemberInfo', g, u]); return { user_id: u }; }
  };
}

const results = [];
const check = (name, fn) => {
  try { fn(); results.push(['ok', name]); }
  catch (e) { results.push(['fail', name, e]); }
};
const checkAsync = async (name, fn) => {
  try { await fn(); results.push(['ok', name]); }
  catch (e) { results.push(['fail', name, e]); }
};

const client = fakeClient();
const t = createTransport({ type: 'onebot', client });

check('kind = onebot', () => assert.equal(t.kind, 'onebot'));
check('能力位：全量消息/主动/拍一拍/文件', () => {
  assert.equal(t.can('readAllMessages'), true);
  assert.equal(t.can('canProactive'), true);
  assert.equal(t.can('canPoke'), true);
  assert.equal(t.can('markFile' in t.capabilities ? 'markFile' : 'file'), true);
  assert.equal(t.can('canMute'), false);
});
check('能力位缺省来自 DEFAULT_CAPABILITIES', () => assert.equal(typeof DEFAULT_CAPABILITIES.canPoke, 'boolean'));
check('未知通道抛错', () => assert.throws(() => createTransport({ type: 'nope', client }), /未知的传输通道/));
check('qqbot 通道明确未实现', () => assert.throws(() => createTransport({ type: 'qqbot', client }), /尚未实现|P2/));
check('TRANSPORT_KINDS 含两种通道', () => assert.deepEqual(TRANSPORT_KINDS, ['onebot', 'qqbot']));

await checkAsync('sendText 透传参数', async () => {
  await t.sendText('group', '123', 'hi', { replyToMessageId: 9, atUserId: 7 });
  const c = calls.find((x) => x[0] === 'sendText');
  assert.deepEqual(c.slice(1), ['group', '123', 'hi', { replyToMessageId: 9, atUserId: 7 }]);
});
await checkAsync('sendImage/sendSticker/sendSegments/sendPoke 透传', async () => {
  await t.sendImage('private', '1', 'file://x.png');
  await t.sendSticker('group', '2', 'http://x.webp');
  await t.sendSegments('group', '3', [{ type: 'text', data: { text: 'a' } }]);
  await t.sendPoke('group', '4', '555');
  assert.deepEqual(calls.find((x) => x[0] === 'sendImage').slice(1), ['private', '1', 'file://x.png', undefined]);
  assert.deepEqual(calls.find((x) => x[0] === 'sendSticker').slice(1), ['group', '2', 'http://x.webp', undefined]);
  assert.equal(calls.find((x) => x[0] === 'sendSegments').length, 4);
  assert.deepEqual(calls.find((x) => x[0] === 'sendPoke').slice(1), ['group', '4', '555']);
});
await checkAsync('recall → delete_msg', async () => {
  await t.recall('group', '123', 42);
  const c = calls.filter((x) => x[0] === 'call').pop();
  assert.deepEqual(c.slice(1), ['delete_msg', { message_id: 42 }]);
});
await checkAsync('memberInfo / groupInfo / msgInfo 映射', async () => {
  await t.memberInfo('g1', 'u1');
  await t.groupInfo('g1');
  await t.msgInfo(77);
  assert.deepEqual(calls.find((x) => x[0] === 'getGroupMemberInfo').slice(1), ['g1', 'u1']);
  assert.deepEqual(calls.find((x) => x[0] === 'getGroupInfo').slice(1), ['g1']);
  assert.deepEqual(calls.find((x) => x[0] === 'getMsg').slice(1), [77]);
});
await checkAsync('call 兜底透传', async () => {
  await t.call('upload_group_file', { group_id: 1 }, 5000);
  const c = calls.filter((x) => x[0] === 'call').pop();
  assert.deepEqual(c.slice(1), ['upload_group_file', { group_id: 1 }, 5000]);
});
check('基类未实现的方法抛 UnsupportedError', async () => {
  const base = new Transport({ kind: 'x' });
  await assert.rejects(() => base.sendPoke(), (e) => e instanceof UnsupportedError && e.capability === 'canPoke');
});

const failed = results.filter(([s]) => s === 'fail');
for (const [s, name, err] of results) {
  if (s === 'ok') console.log('✓', name);
  else console.log('✗', name, '--', err?.message || err);
}
console.log('传输层：' + (results.length - failed.length) + '/' + results.length + ' 通过');
if (failed.length) process.exit(1);
