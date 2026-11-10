// 通用 Agent 桥（P1）回归：真跑 spawn，不 mock 子进程。
//
// 为什么用 stub CLI 而不是等 codex 装好：
//   桥的难点全在"起进程 / 收事件 / 取答案 / 续跑 / 杀进程"这套胶水，
//   与具体是哪个 agent 关系不大。stub 走的是同一条 spawn 路径（包括 Windows 的
//   .cmd 外壳），所以这些用例能证明接线是通的；等真装 codex 再补一条真机用例即可。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-bridge-test-'));

// ⚠️ 必须在 import src 之前设：config.js 在模块加载时就把 DATA_DIR 定死了，
//    不隔离的话测试会往你真实的 data/ 里写会话记录。
process.env.QQ_AGENT_DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(process.env.QQ_AGENT_DATA_DIR, { recursive: true });

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('  OK  ', name); } else { fail += 1; console.log('  FAIL', name, extra); }
};

// ── stub CLI ──────────────────────────────────────────────────────────
const stub = path.join(TMP, 'stub-cli.mjs');
fs.writeFileSync(stub, `import fs from 'node:fs';
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
const out = at('-o');
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const task = Buffer.concat(chunks).toString('utf8').trim();
const resume = argv.includes('resume');
const sid = argv.includes('--last') ? '--last' : (resume ? at('resume') : '');
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'stub-thread-0001' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '事件流答案' } }) + '\\n');
if (out) fs.writeFileSync(out, (resume ? '续跑' : '收到') + '：' + task + (sid ? '（' + sid + '）' : ''), 'utf8');
if (argv.includes('--sleep')) await new Promise((r) => setTimeout(r, 30000));
process.exit(0);
`, 'utf8');

const { createAgentBridges, parseAgentCommand, buildArgs, extractSessionId, extractJsonlAnswer, normalizeBridge } =
  await import(pathToFileURL(path.join(ROOT, 'src', 'agent-bridge.js')).href);

// ── 纯函数 ────────────────────────────────────────────────────────────
console.log('\n[parse]');
check('普通任务', parseAgentCommand('/codex 跑测试', '/codex')?.task === '跑测试');
check('帮助', parseAgentCommand('/codex 帮助', '/codex')?.kind === 'help');
check('状态', parseAgentCommand('/codex 状态', '/codex')?.kind === 'status');
check('停', parseAgentCommand('/codex 停', '/codex')?.kind === 'stop');
check('新会话带任务', parseAgentCommand('/codex 新 重来', '/codex')?.task === '重来');
check('前面带 @', parseAgentCommand('@机器人 /codex 干活', '/codex')?.task === '干活');
check('前缀必须成词', parseAgentCommand('/codexx 干活', '/codex') === null);
check('大小写不敏感', parseAgentCommand('/CODEX 干活', '/codex')?.task === '干活');

console.log('\n[args]');
check('占位符替换', JSON.stringify(buildArgs(['exec', '-o', '{out}', '{task}'], { out: 'X', task: 'Y' })) === JSON.stringify(['exec', '-o', 'X', 'Y']));
check('缺省占位符不炸', JSON.stringify(buildArgs(['{session}'], {})) === JSON.stringify(['']));

console.log('\n[解析]');
check('抓 thread_id', extractSessionId('{"type":"thread.started","thread_id":"abc-123-def"}') === 'abc-123-def');
check('抓 session_id', extractSessionId('{"session_id":"xyz-987"}') === 'xyz-987');
check('无关行返回空', extractSessionId('{"type":"other"}') === '');
check('JSONL 取最后一条消息', extractJsonlAnswer('{"type":"item.completed","item":{"type":"agent_message","text":"一"}}\n{"type":"item.completed","item":{"type":"agent_message","text":"二"}}') === '二');
check('跳过工具事件', extractJsonlAnswer('{"type":"tool_call","text":"不该是答案"}\n{"type":"item.completed","item":{"text":"答案"}}') === '答案');

// ── 端到端 ────────────────────────────────────────────────────────────
// preset 兜底：数组是整条替换的，手改配置只写几个字段时参数模板不能丢
const fromPreset = normalizeBridge({ id: 'codex', preset: 'codex', enabled: true, allowedSenderIds: ['1001'] }, 0);
check('preset 补齐 cmd', fromPreset.cmd === 'codex');
check('preset 补齐参数模板', Array.isArray(fromPreset.newArgs) && fromPreset.newArgs.length >= 5, JSON.stringify(fromPreset.newArgs));
check('preset 补齐续跑模板', fromPreset.resumeArgs.some((x) => x === '{session}'));
check('用户字段优先于 preset', fromPreset.allowedSenderIds[0] === '1001' && fromPreset.enabled === true);
check('无 preset 时保持空白', normalizeBridge({ id: 'x', enabled: true }, 1).newArgs.length === 0);

const sent = [];
const sender = {
  sendTextBatch: async (chatKey, parts, opts) => { sent.push({ chatKey, text: parts.join(''), opts }); }
};
const logs = [];

function makeCfg(overrides = {}) {
  const bridge = {
    id: 'codex', label: 'Codex', enabled: true, prefix: '/codex',
    cmd: process.execPath,
    allowedSenderIds: ['1001'],
    sessionMode: 'per-chat', resume: 'id', taskVia: 'stdin',
    newArgs: [stub, '--json', '-o', '{out}', '-'],
    resumeArgs: [stub, 'resume', '{session}', '--json', '-o', '{out}', '-'],
    outputMode: 'last-message', showProgress: 'off',
    ...overrides
  };
  return () => ({ agentBridges: [bridge] });
}

const bridges = createAgentBridges({
  getConfig: makeCfg(),
  sender,
  log: (m) => logs.push(m),
  emit: () => {}
});

console.log('\n[端到端]');
check('认领 /codex', bridges.handle('private:1001', { text: '/codex 你好', senderId: '1001', mid: 1 }, { atMe: false, kind: 'private' }) === true);
await bridges.awaitIdle();
check('拿到答案', sent.at(-1)?.text === '收到：你好', JSON.stringify(sent.at(-1)));
check('会话 id 已落盘', JSON.parse(fs.readFileSync(path.join(process.env.QQ_AGENT_DATA_DIR, 'agent-bridges.json'), 'utf8')).codex?.['private:1001']?.sessionId === 'stub-thread-0001');

sent.length = 0;
bridges.handle('private:1001', { text: '/codex 第二句', senderId: '1001', mid: 2 }, { atMe: false, kind: 'private' });
await bridges.awaitIdle();
check('第二条走续跑模板', sent.at(-1)?.text === '续跑：第二句（stub-thread-0001）', JSON.stringify(sent.at(-1)));

sent.length = 0;
bridges.handle('private:1001', { text: '/codex 新 第三句', senderId: '1001', mid: 3 }, { atMe: false, kind: 'private' });
await bridges.awaitIdle();
check('「新」丢掉上下文', sent.at(-1)?.text === '收到：第三句', JSON.stringify(sent.at(-1)));

sent.length = 0;
check('群聊没 @ 不认领', bridges.handle('group:9', { text: '/codex 干活', senderId: '1001', mid: 4 }, { atMe: false, kind: 'group' }) === false);
check('群聊 @ 了才认领', bridges.handle('group:9', { text: '@机器人 /codex 干活', senderId: '1001', mid: 5 }, { atMe: true, kind: 'group' }) === true);
await bridges.awaitIdle();
check('群里也能拿到答案', sent.at(-1)?.text === '收到：干活', JSON.stringify(sent.at(-1)));

sent.length = 0;
bridges.handle('private:2002', { text: '/codex 我是谁', senderId: '2002', mid: 6 }, { atMe: false, kind: 'private' });
await bridges.awaitIdle();
check('陌生人被白名单挡住', /白名单/.test(sent.at(-1)?.text || ''), JSON.stringify(sent.at(-1)));

sent.length = 0;
bridges.handle('private:1001', { text: '/codex 帮助', senderId: '1001', mid: 7 }, { atMe: false, kind: 'private' });
await bridges.awaitIdle();
check('帮助里有用法', /\/codex <任务>/.test(sent.at(-1)?.text || ''));

sent.length = 0;
bridges.handle('private:1001', { text: '/codex 停', senderId: '1001', mid: 8 }, { atMe: false, kind: 'private' });
await bridges.awaitIdle();
check('空闲时「停」有回应', /没有在跑/.test(sent.at(-1)?.text || ''));

// 空白名单 = 谁都不许
const noneBridges = createAgentBridges({
  getConfig: makeCfg({ allowedSenderIds: [] }),
  sender, log: () => {}, emit: () => {}
});
sent.length = 0;
noneBridges.handle('private:1001', { text: '/codex 你好', senderId: '1001', mid: 9 }, { atMe: false, kind: 'private' });
await noneBridges.awaitIdle();
check('空白名单直接拒绝', /allowedSenderIds 是空的|白名单/.test(sent.at(-1)?.text || ''), JSON.stringify(sent.at(-1)));

// 中断：起一个会睡 30 秒的 stub，再发「停」
const slowBridges = createAgentBridges({
  getConfig: makeCfg({ resume: 'none', newArgs: [stub, '--json', '--sleep', '-o', '{out}', '-'], showProgress: 'off' }),
  sender, log: () => {}, emit: () => {}
});
sent.length = 0;
slowBridges.handle('private:1001', { text: '/codex 慢活', senderId: '1001', mid: 10 }, { atMe: false, kind: 'private' });
await new Promise((r) => setTimeout(r, 600));
const stopAck = slowBridges.handle('private:1001', { text: '/codex 停', senderId: '1001', mid: 11 }, { atMe: false, kind: 'private' });
await slowBridges.awaitIdle();
check('「停」认领', stopAck === true);
check('「停」提示已发送中断', sent.some((x) => /已发送中断/.test(x.text)), JSON.stringify(sent.map((x) => x.text)));

// ── Windows：npm 装的 codex 是 .cmd，必须能起来 ────────────────────────
if (process.platform === 'win32') {
  const shim = path.join(TMP, 'stub-cli.cmd');
  fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${stub}" %*\r\n`, 'ascii');
  const cmdBridges = createAgentBridges({
    getConfig: makeCfg({ cmd: shim, resume: 'none', newArgs: ['--json', '-o', '{out}', '-'] }),
    sender, log: (m) => logs.push(m), emit: () => {}
  });
  sent.length = 0;
  cmdBridges.handle('private:1001', { text: '/codex 走cmd', senderId: '1001', mid: 12 }, { atMe: false, kind: 'private' });
  await cmdBridges.awaitIdle();
  check('.cmd 外壳能起来', sent.at(-1)?.text === '收到：走cmd', JSON.stringify(sent.at(-1)));
}

// 找不到可执行文件时不许静默
const badBridges = createAgentBridges({
  getConfig: makeCfg({ cmd: 'definitely-not-installed-xyz' }),
  sender, log: () => {}, emit: () => {}
});
sent.length = 0;
badBridges.handle('private:1001', { text: '/codex 你好', senderId: '1001', mid: 13 }, { atMe: false, kind: 'private' });
await badBridges.awaitIdle();
check('找不到 exe 会明说', /找不到可执行文件/.test(sent.at(-1)?.text || ''), JSON.stringify(sent.at(-1)));

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
