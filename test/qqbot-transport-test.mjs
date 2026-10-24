// QQ 官方机器人适配器（P2）单测：不联网，fetch 用假的；WS 不启动。
import assert from 'node:assert/strict';
import { QqBotTransport, parseChatKey, toChatKey } from '../src/transport/qqbot.js';
import { createTransport } from '../src/transport/index.js';

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['ok', name]); }
  catch (e) { results.push(['fail', name, e]); }
};

function fakeFetch(log) {
  return async (url, opts = {}) => {
    log.push([url, opts.method || 'GET', opts.body ? JSON.parse(opts.body) : null]);
    if (url.includes('getAppAccessToken')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok-1', expires_in: 7200 }), text: async () => '' };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'msg-9' }), json: async () => ({ id: 'msg-9' }) };
  };
}

const acc = { name: '测试机器人', appId: '1905933932', appSecret: 's3cr3t', env: 'production', groupMode: 'all' };

await check('能力位：全量模式可读全部消息、无拍一拍', async () => {
  const t = new QqBotTransport({ account: acc, fetchImpl: fakeFetch([]) });
  assert.equal(t.kind, 'qqbot');
  assert.equal(t.can('readAllMessages'), true);
  assert.equal(t.can('canPoke'), false);
  assert.equal(t.can('markdown'), true);
});
await check('能力位：groupMode=at 时不能读全部消息', async () => {
  const t = new QqBotTransport({ account: { ...acc, groupMode: 'at' }, fetchImpl: fakeFetch([]) });
  assert.equal(t.can('readAllMessages'), false);
});
await check('chatKey 命名空间', async () => {
  assert.equal(toChatKey('group', 'G1'), 'qqbot:group:G1');
  assert.deepEqual(parseChatKey('qqbot:group:G1'), { kind: 'group', id: 'G1' });
  assert.deepEqual(parseChatKey('qqbot:private:U1'), { kind: 'private', id: 'U1' });
  assert.equal(parseChatKey('group:123'), null);
});
await check('AccessToken 缓存（只取一次）', async () => {
  const log = [];
  const t = new QqBotTransport({ account: acc, fetchImpl: fakeFetch(log) });
  assert.equal(await t.token(), 'tok-1');
  assert.equal(await t.token(), 'tok-1');
  assert.equal(log.filter(([u]) => u.includes('getAppAccessToken')).length, 1);
});
await check('未配置 AppID/Secret 时报错', async () => {
  const t = new QqBotTransport({ account: { appId: '', appSecret: '' }, fetchImpl: fakeFetch([]) });
  await assert.rejects(() => t.token(), /未配置 AppID/);
});
await check('发群消息：msg_type=0、无 msg_id 时不带 seq', async () => {
  const log = [];
  const t = new QqBotTransport({ account: acc, fetchImpl: fakeFetch(log) });
  await t.sendText('group', 'G1', 'hello');
  const send = log.find(([u]) => u.includes('/v2/groups/G1/messages'));
  assert.ok(send, '应该调用群消息接口');
  assert.deepEqual(send[2], { content: 'hello', msg_type: 0 });
});
await check('被动回复：msg_seq 递增', async () => {
  const log = [];
  const t = new QqBotTransport({ account: acc, fetchImpl: fakeFetch(log) });
  await t.sendText('group', 'G1', 'a', { replyToMessageId: 'ROBOT1_x' });
  await t.sendText('group', 'G1', 'b', { replyToMessageId: 'ROBOT1_x' });
  const sends = log.filter(([u]) => u.includes('/messages')).filter(([, m]) => m === 'POST');
  assert.equal(sends[0][2].msg_id, 'ROBOT1_x');
  assert.equal(sends[0][2].msg_seq, 1);
  assert.equal(sends[1][2].msg_seq, 2);
});
await check('单聊走 /v2/users/…', async () => {
  const log = [];
  const t = new QqBotTransport({ account: acc, fetchImpl: fakeFetch(log) });
  await t.sendText('private', 'U1', 'hi');
  assert.ok(log.some(([u]) => u.includes('/v2/users/U1/messages')));
});
await check('撤回走 DELETE', async () => {
  const log = [];
  const t = new QqBotTransport({ account: acc, fetchImpl: fakeFetch(log) });
  await t.recall('group', 'G1', 'M1');
  const del = log.find(([, m]) => m === 'DELETE');
  assert.ok(del[0].includes('/v2/groups/G1/messages/M1'));
});
await check('事件归一化：@消息 / 全量消息 / 单聊', async () => {
  const t = new QqBotTransport({ account: acc, fetchImpl: fakeFetch([]) });
  const at = t.normalizeEvent('GROUP_AT_MESSAGE_CREATE', { id: 'M1', content: 'hi', group_openid: 'G1', author: { member_openid: 'U1', username: '小明', member_role: 'member' } });
  assert.equal(at.kind, 'group');
  assert.equal(at.chatKey, 'qqbot:group:G1');
  assert.equal(at.atMe, true);
  assert.equal(at.userId, 'U1');
  assert.equal(at.text, 'hi');
  const all = t.normalizeEvent('GROUP_MESSAGE_CREATE', { id: 'M2', content: 'x', group_openid: 'G1', author: { member_openid: 'U2', username: '小红' } });
  assert.equal(all.atMe, false);
  const c2c = t.normalizeEvent('C2C_MESSAGE_CREATE', { id: 'M3', content: 'yo', author: { user_openid: 'U9', username: 'A' } });
  assert.equal(c2c.kind, 'private');
  assert.equal(c2c.chatKey, 'qqbot:private:U9');
});
await check('工厂：未填 AppID 时明确报错；填了则返回 qqbot 适配器', async () => {
  assert.throws(() => createTransport({ type: 'qqbot', config: { qqbot: { accounts: [{ appId: '' }] } } }), /未配置/);
  const t = createTransport({ type: 'qqbot', config: { qqbot: { accounts: [acc] } } });
  assert.equal(t.kind, 'qqbot');
});

const failed = results.filter(([s]) => s === 'fail');
for (const [s, name, err] of results) console.log(s === 'ok' ? '✓' : '✗', name, s === 'ok' ? '' : '-- ' + (err?.message || err));
console.log('QQ 官方通道：' + (results.length - failed.length) + '/' + results.length + ' 通过');
if (failed.length) process.exit(1);
