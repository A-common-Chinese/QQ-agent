#!/usr/bin/env node
// pre-save 的纯逻辑与存储测试（不连模型、不连 QQ）
// 重点守三件事：水位不重复不漏、超上限必须记账、合并只删已消费的。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = path.join(os.tmpdir(), `qq-agent-premem-${process.pid}`);
fs.rmSync(TMP, { recursive: true, force: true });
process.env.QQ_AGENT_DATA_DIR = TMP;

const m = await import('../src/pre-memory.js');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

const CHAT = 'group:999';
const cfg = m.preSaveConfig({ everyMessages: 10, idleMinutes: 10, maxPending: 50, maxMembersPerRun: 2, maxMsgsPerMember: 10, minMsgsPerMember: 3 });
const msg = (id, uid, text = 'x') => ({ id, senderId: String(uid), senderName: `u${uid}`, text, self: false });

// 1. 默认值与下限
{
  const d = m.preSaveConfig({});
  check('默认 80 条触发', d.everyMessages === 80 && d.enabled === true);
  check('填 5 会被抬到下限 10', m.preSaveConfig({ everyMessages: 5 }).everyMessages === 10);
}

// 2. 条数触发
{
  const msgs = Array.from({ length: 12 }, (_, i) => msg(i + 1, 111));
  const plan = m.planRefine(msgs, { members: {}, pending: 0, lastAt: Date.now() }, cfg);
  check('累计 12 条触发（阈值 10）', plan.run && plan.reason === 'count', plan.reason);
  check('分组按人聚合', plan.groups.length === 1 && plan.groups[0].userId === '111');
  check('只喂最近 maxMsgsPerMember 条', plan.groups[0].messages.length === 10, String(plan.groups[0].messages.length));
  check('水位取该批最大 id', plan.groups[0].maxId === 12);
}

// 3. 水位生效：已读过的消息不再计入
{
  const msgs = Array.from({ length: 12 }, (_, i) => msg(i + 1, 111));
  const plan = m.planRefine(msgs, { members: { 111: 10 }, pending: 0, lastAt: Date.now() }, cfg);
  check('已读 1~10 后只剩 2 条 → 不触发', plan.run === false && plan.total === 2, JSON.stringify(plan));
}

// 4. 空闲触发（有未合并候选时）
{
  const msgs = [msg(1, 111), msg(2, 111), msg(3, 111)];
  const plan = m.planRefine(msgs, { members: {}, pending: 4, lastAt: Date.now() - 11 * 60000 }, cfg);
  check('空闲 11 分钟且有候选 → idle 触发', plan.run && plan.reason === 'idle', plan.reason);
}

// 5. 人数太少不提炼
{
  const msgs = [msg(1, 111), msg(2, 111)];
  const plan = m.planRefine(msgs, { members: {}, pending: 0, lastAt: 0 }, { ...cfg, everyMessages: 2 });
  check('不足 minMsgsPerMember(3) 不建组', plan.run === false, JSON.stringify(plan));
}

// 6. 单次人数上限
{
  const msgs = [];
  for (let u = 1; u <= 4; u++) for (let i = 0; i < 3; i++) msgs.push(msg(u * 100 + i + 1, u));
  const plan = m.planRefine(msgs, { members: {}, pending: 0, lastAt: 0 }, { ...cfg, everyMessages: 10 });
  check('单次最多 maxMembersPerRun 人', plan.run && plan.groups.length === 2, String(plan.groups.length));
}

// 7. 候选写入 + 超上限淘汰并记账
{
  const items = Array.from({ length: 7 }, (_, i) => ({ id: `c${i}`, userId: '111', facts: [`f${i}`] }));
  const r = m.appendCandidates(CHAT, items, { maxPending: 5 });
  check('写入 7 条、上限 5 → 淘汰 2', r.added === 7 && r.dropped === 2, JSON.stringify(r));
  const st = m.readState(CHAT);
  check('pending/dropped 记账正确', st.pending === 5 && st.dropped === 2, JSON.stringify(st));
  const kept = m.readCandidates(CHAT).map((c) => c.id);
  check('淘汰的是最旧的（保留 c2..c6）', kept.join(',') === 'c2,c3,c4,c5,c6', kept.join(','));
}

// 8. 按成员取用 + 只删已消费
{
  m.appendCandidates(CHAT, [{ id: 'x1', userId: '222', facts: ['a'] }], { maxPending: 99 });
  const forOne = m.candidatesFor(CHAT, '222', 10);
  check('按 userId 过滤', forOne.length === 1 && forOne[0].id === 'x1');
  const removed = m.consumeCandidates(CHAT, ['x1']);
  check('消费指定 id', removed === 1 && m.candidatesFor(CHAT, '222', 10).length === 0);
  check('没消费的不受影响', m.pendingCount(CHAT) === 5, String(m.pendingCount(CHAT)));
}

// 9. 水位推进（只前进，不倒退）
{
  m.advanceWatermarks(CHAT, [{ userId: '111', maxId: 20 }]);
  m.advanceWatermarks(CHAT, [{ userId: '111', maxId: 12 }]);
  check('水位单调递增', Number(m.readState(CHAT).members['111']) === 20, JSON.stringify(m.readState(CHAT).members));
}

// 10. 自定义提示词覆盖
{
  const p = m.buildRefinePrompt({ name: '甲', userId: '1', messages: [msg(1, 1, '我下周去成都')], cfg: { ...cfg, prompt: '自定义：只输出 JSON' } });
  check('自定义提示词生效', p.system.includes('自定义'));
  const p2 = m.buildRefinePrompt({ name: '甲', userId: '1', messages: [msg(1, 1, '我下周去成都')], cfg });
  check('内置提示词包含发言原文', p2.user.includes('我下周去成都') && p2.system.includes('JSON'));
}


// 11. 素材来源（A 方案）
{
  const a = m.chooseSource({ isNew: true, candidateCount: 3 });
  check('新建+有候选 → 只用候选', a.candidateOnly === true && a.mode === 'candidates');
  const b = m.chooseSource({ isNew: true, candidateCount: 0 });
  check('新建+无候选 → 读原文', b.candidateOnly === false && b.mode === 'messages');
  const c = m.chooseSource({ isNew: false, candidateCount: 5 });
  check('已有印象 → 走合并模式（不读原文）', c.candidateOnly === false);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
