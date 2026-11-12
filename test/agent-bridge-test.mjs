// 通用 Agent 桥（P1）回归：真跑 spawn，不 mock 子进程。
//
// 为什么用 stub CLI 而不是等 codex 装好：
//   桥的难点全在"起进程 / 收事件 / 取答案 / 续跑 / 杀进程"这套胶水，
//   与具体是哪个 agent 关系不大。stub 走的是同一条 spawn 路径（包括 Windows 的
//   .cmd 外壳），所以这些用例能证明接线是通的；等真装 codex 再补一条真机用例即可。
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
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

const { createAgentBridges, parseAgentCommand, buildArgs, extractSessionId, extractJsonlAnswer, normalizeBridge, projectSlug, nowStamp, extractFileMarks, resolveOutgoing, explainFailure, patchDisciplineWarning, countPatchFiles, probeBridgeSync, portInUse, quotaHint, isGitDirty } =
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
// 模型 / 对话（WorkBuddy 专用命令，2026-11-11 加）
check('模型列表', parseAgentCommand('/wb 模型', '/wb')?.kind === 'model');
check('切模型', parseAgentCommand('/wb 模型 glm-5.3', '/wb')?.task === 'glm-5.3');
check('对话列表', parseAgentCommand('/wb 对话', '/wb')?.kind === 'sessions');
check('按序号切会话', parseAgentCommand('/wb 对话 2', '/wb')?.kind === 'use' && parseAgentCommand('/wb 对话 2', '/wb')?.task === '2');
check('按 id 切会话', parseAgentCommand('/wb 对话 01a1c8ea-c337', '/wb')?.task === '01a1c8ea-c337');

console.log('\n[args]');
check('占位符替换', JSON.stringify(buildArgs(['exec', '-o', '{out}', '{task}'], { out: 'X', task: 'Y' })) === JSON.stringify(['exec', '-o', 'X', 'Y']));
check('缺省占位符不炸', JSON.stringify(buildArgs(['{session}'], {})) === JSON.stringify(['']));
check('端口占位符', JSON.stringify(buildArgs(['--port', '{port}'], { port: 61250 })) === JSON.stringify(['--port', '61250']));

console.log('\n[解析]');
check('抓 thread_id', extractSessionId('{"type":"thread.started","thread_id":"abc-123-def"}') === 'abc-123-def');
check('抓 session_id', extractSessionId('{"session_id":"xyz-987"}') === 'xyz-987');
check('无关行返回空', extractSessionId('{"type":"other"}') === '');
check('JSONL 取最后一条消息', extractJsonlAnswer('{"type":"item.completed","item":{"type":"agent_message","text":"一"}}\n{"type":"item.completed","item":{"type":"agent_message","text":"二"}}') === '二');
check('跳过工具事件', extractJsonlAnswer('{"type":"tool_call","text":"不该是答案"}\n{"type":"item.completed","item":{"text":"答案"}}') === '答案');
// codebuddy --output-format stream-json 的真实形状（2026-11-11 实测）：
// assistant 行带 message.content[]，最后一行是 {type:'result', result:'...'}
const cbStream = [
  '{"type":"assistant","session_id":"01a1c8e5-777b-762e-9735-842e3262772f","message":{"content":[{"type":"thinking","thinking":"思考"}]}}',
  '{"type":"assistant","session_id":"01a1c8e5-777b-762e-9735-842e3262772f","message":{"content":[{"type":"text","text":"收到"}]}}',
  '{"type":"result","subtype":"success","result":"收到","session_id":"01a1c8e5-777b-762e-9735-842e3262772f"}'
].join('\n');
check('codebuddy 流取答案', extractJsonlAnswer(cbStream) === '收到');
check('codebuddy 流取会话 id', extractSessionId(cbStream.split('\n')[0]) === '01a1c8e5-777b-762e-9735-842e3262772f');

// ── 端到端 ────────────────────────────────────────────────────────────
// preset 兜底：数组是整条替换的，手改配置只写几个字段时参数模板不能丢
const fromPreset = normalizeBridge({ id: 'codex', preset: 'codex', enabled: true, allowedSenderIds: ['1001'] }, 0);
check('preset 补齐 cmd', fromPreset.cmd === 'codex');
check('preset 补齐参数模板', Array.isArray(fromPreset.newArgs) && fromPreset.newArgs.length >= 5, JSON.stringify(fromPreset.newArgs));
check('preset 补齐续跑模板', fromPreset.resumeArgs.some((x) => x === '{session}'));
check('用户字段优先于 preset', fromPreset.allowedSenderIds[0] === '1001' && fromPreset.enabled === true);
check('无 preset 时保持空白', normalizeBridge({ id: 'x', enabled: true }, 1).newArgs.length === 0);
check('preset 带时间注入开关', normalizeBridge({ id: 'w', preset: 'codebuddy' }, 0).injectTime === true);
check('preset 带 -y（否则 headless 下 Bash 被拒）', normalizeBridge({ id: 'w', preset: 'codebuddy' }, 0).newArgs.includes('-y'));
check('续跑模板也带 -y', normalizeBridge({ id: 'w', preset: 'codebuddy' }, 0).resumeArgs.includes('-y'));
check('时间戳格式', nowStamp(new Date('2026-11-11T13:05:00')) === '2026-11-11 13:05（周三）', nowStamp(new Date('2026-11-11T13:05:00')));

const sent = [];
const fileSends = [];
const sender = {
  sendTextBatch: async (chatKey, parts, opts) => { sent.push({ chatKey, text: parts.join(''), opts }); },
  sendFile: async (chatKey, file, opts) => { fileSends.push({ chatKey, path: file?.path, name: opts?.name }); return { name: opts?.name }; }
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

// ── 模型 / 对话（WorkBuddy 专用）──────────────────────────────────────
{
  const projRoot = path.join(TMP, 'sessions');
  const slug = projectSlug(TMP);
  const projDir = path.join(projRoot, slug);
  fs.mkdirSync(projDir, { recursive: true });
  const mkSession = (id, text, ageMs, { project = slug, cwd = '' } = {}) => {
    const dir = path.join(projRoot, project);
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(f, JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text }], sessionId: id, cwd }) + '\n', 'utf8');
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(f, t, t);
  };
  // 两个在"桥自己的工作目录"里（测试题），一个在别的项目里（模拟用户真正在用的会话）
  mkSession('aaaaaaaa-1111-2222-3333-444444444444', '第一句测试', 60_000, { cwd: TMP });
  mkSession('bbbbbbbb-1111-2222-3333-444444444444', '第二句测试', 1_000, { cwd: TMP });
  mkSession('cccccccc-1111-2222-3333-444444444444', 'WtHud 的会话', 0, { project: 'c-Users-noapi-WtHud', cwd: 'C:\\Users\\noapi\\WtHud' });

  const uiBridges = createAgentBridges({
    getConfig: makeCfg({ prefix: '/wb', resume: 'none', sessionsRoot: projRoot, workdir: TMP, models: ['hy4-free', 'glm-5.3'] }),
    sender, log: () => {}, emit: () => {}
  });

  sent.length = 0;
  uiBridges.handle('private:1001', { text: '/wb 对话', senderId: '1001', mid: 20 }, { atMe: false, kind: 'private' });
  await uiBridges.awaitIdle();
  const listText = sent.at(-1)?.text || '';
  check('对话列表：三条都在（跨项目）', /第一句测试/.test(listText) && /第二句测试/.test(listText) && /WtHud 的会话/.test(listText), listText.slice(0, 200));
  check('对话列表：最近的在前面', listText.indexOf('WtHud 的会话') < listText.indexOf('第二句测试'));
  check('对话列表：标注所属目录', /\[WtHud\]/.test(listText), listText.slice(0, 200));

  sent.length = 0;
  uiBridges.handle('private:1001', { text: '/wb 对话 3', senderId: '1001', mid: 21 }, { atMe: false, kind: 'private' });
  await uiBridges.awaitIdle();
  check('按序号切到较早那个', /已切到会话/.test(sent.at(-1)?.text || ''), sent.at(-1)?.text);
  check('会话 id 已落盘', JSON.parse(fs.readFileSync(path.join(process.env.QQ_AGENT_DATA_DIR, 'agent-bridges.json'), 'utf8')).codex?.['private:1001']?.sessionId === 'aaaaaaaa-1111-2222-3333-444444444444');

  // 关键词筛：先给候选，不直接切
  sent.length = 0;
  uiBridges.handle('private:1001', { text: '/wb 对话 WtHud', senderId: '1001', mid: 25 }, { atMe: false, kind: 'private' });
  await uiBridges.awaitIdle();
  check('关键词能筛出目标', /匹配「WtHud」/.test(sent.at(-1)?.text || '') && /WtHud 的会话/.test(sent.at(-1)?.text || ''), sent.at(-1)?.text);

  // 切到别的项目的会话：工作目录要跟着切
  sent.length = 0;
  uiBridges.handle('private:1001', { text: '/wb 对话 cccccccc', senderId: '1001', mid: 26 }, { atMe: false, kind: 'private' });
  await uiBridges.awaitIdle();
  const st2 = JSON.parse(fs.readFileSync(path.join(process.env.QQ_AGENT_DATA_DIR, 'agent-bridges.json'), 'utf8')).codex?.['private:1001'];
  check('跨项目切换：会话已落盘', st2?.sessionId === 'cccccccc-1111-2222-3333-444444444444', JSON.stringify(st2));
  check('跨项目切换：工作目录跟着切', st2?.workdir === 'C:\\Users\\noapi\\WtHud', JSON.stringify(st2));

  sent.length = 0;
  uiBridges.handle('private:1001', { text: '/wb 模型', senderId: '1001', mid: 22 }, { atMe: false, kind: 'private' });
  await uiBridges.awaitIdle();
  check('模型清单列出', /hy4-free/.test(sent.at(-1)?.text || '') && /glm-5\.3/.test(sent.at(-1)?.text || ''));

  sent.length = 0;
  uiBridges.handle('private:1001', { text: '/wb 模型 2', senderId: '1001', mid: 23 }, { atMe: false, kind: 'private' });
  await uiBridges.awaitIdle();
  check('按序号切模型', /已切到 glm-5\.3/.test(sent.at(-1)?.text || ''), sent.at(-1)?.text);
  check('模型已落盘', JSON.parse(fs.readFileSync(path.join(process.env.QQ_AGENT_DATA_DIR, 'agent-bridges.json'), 'utf8')).codex?.['private:1001']?.model === 'glm-5.3');

  sent.length = 0;
  uiBridges.handle('private:1001', { text: '/wb 模型 不存在的', senderId: '1001', mid: 24 }, { atMe: false, kind: 'private' });
  await uiBridges.awaitIdle();
  check('不存在的模型被拒', /没有这个模型/.test(sent.at(-1)?.text || ''));

  // 「新会话」只清会话与目录，模型选择要留着（否则每次开新会话都得重选模型）
  sent.length = 0;
  uiBridges.handle('private:1001', { text: '/wb 新', senderId: '1001', mid: 27 }, { atMe: false, kind: 'private' });
  await uiBridges.awaitIdle();
  const stAfterNew = JSON.parse(fs.readFileSync(path.join(process.env.QQ_AGENT_DATA_DIR, 'agent-bridges.json'), 'utf8')).codex?.['private:1001'];
  check('新会话清掉 sessionId', !stAfterNew?.sessionId, JSON.stringify(stAfterNew));
  check('新会话保留模型选择', stAfterNew?.model === 'glm-5.3', JSON.stringify(stAfterNew));
  check('新会话清掉目录覆盖', !stAfterNew?.workdir, JSON.stringify(stAfterNew));
}

check('额度受限能识别并给建议', /换一个模型/.test(quotaHint('429 您的使用量已超出频率限制，将在 2026-11-12 12:35:56 UTC+8 重置', '/wb')));
check('额度提示带重置时间', /2026-11-12/.test(quotaHint('您的使用量已超出频率限制，将在 2026-11-12 12:35:56 UTC+8 重置')));
check('正常回答不误报', quotaHint('我把文件改好了') === '');

// ── P0：工作树检查必须异步（不允许阻塞事件循环）─────────────
{
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-nogit-'));
  check('非 git 目录按无改动', (await isGitDirty(plain)) === false);

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-git-'));
  const { execFileSync } = await import('node:child_process');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  check('干净仓库 → 无改动', (await isGitDirty(repo)) === false);
  fs.writeFileSync(path.join(repo, 'dirty.txt'), 'x');
  check('有未跟踪文件 → 有改动', (await isGitDirty(repo)) === true);

  // 事件循环不被堵：并发 5 次检查应当很快完成（同步版会串行堵住）
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 5 }, () => isGitDirty(repo)));
  check('5 次并发检查在 3s 内完成', Date.now() - t0 < 3000, String(Date.now() - t0));
}

// ── 状态写入：原子性 / 无残留 ────────────────────────────────
{
  const dataDir = process.env.QQ_AGENT_DATA_DIR;
  const statePath = path.join(dataDir, 'agent-bridges.json');
  // 前面多轮测试已经写过若干次状态；这里检查文件仍可解析、且没留下 .tmp
  const raw = fs.readFileSync(statePath, 'utf8');
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* 下面断言会失败 */ }
  check('状态文件是完整 JSON', parsed !== null && typeof parsed === 'object');
  const leftovers = fs.readdirSync(dataDir).filter((n) => n.includes('agent-bridges') && n.endsWith('.tmp'));
  check('写入后没有残留 .tmp', leftovers.length === 0, JSON.stringify(leftovers));

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check('新桥测试已进 npm test', String(pkg.scripts?.test || '').includes('agent-bridge-test.mjs'));
  check('有单独跑桥测试的入口', String(pkg.scripts?.['test:bridge'] || '').includes('agent-bridge-test.mjs'));
}

// ── 启动自检 ────────────────────────────────────────────────
{
  const okBridge = normalizeBridge({ id: 'h', cmd: process.execPath, workdir: TMP });
  check('自检：可执行文件通过', probeBridgeSync(okBridge).find((c) => c.name === '可执行文件').ok);
  check('自检：工作目录通过', probeBridgeSync(okBridge).find((c) => c.name === '工作目录').ok);
  const badExe = normalizeBridge({ id: 'h', cmd: 'definitely-not-a-cmd-xyz', workdir: TMP });
  check('自检：缺可执行文件报错', !probeBridgeSync(badExe).find((c) => c.name === '可执行文件').ok);
  const badDir = normalizeBridge({ id: 'h', cmd: process.execPath, workdir: path.join(TMP, 'nope-dir') });
  check('自检：目录缺失报错', !probeBridgeSync(badDir).find((c) => c.name === '工作目录').ok);
  const pd = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-health-'));
  const withPatch = normalizeBridge({ id: 'h', cmd: process.execPath, workdir: TMP, patchDir: path.join(pd, 'missing') });
  check('自检：patch 目录缺失报错', !probeBridgeSync(withPatch).find((c) => c.name === 'patch 目录').ok);
  const withPatchOk = normalizeBridge({ id: 'h', cmd: process.execPath, workdir: TMP, patchDir: pd });
  check('自检：patch 目录存在通过', probeBridgeSync(withPatchOk).find((c) => c.name === 'patch 目录').ok);

  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const busyPort = srv.address().port;
  check('端口探测：占用中能识别', (await portInUse(busyPort)) === true);
  await new Promise((r) => srv.close(r));
  check('端口探测：0 视为不检查', (await portInUse(0)) === false);
}

// ── 失败诊断 / 交接留痕检查 ──────────────────────────────────
check('诊断：未登录', explainFailure({ stderr: 'Authentication required. Please use /login command to sign in' }).some((t) => /未登录/.test(t)));
check('诊断：端口占用带端口号', explainFailure({ stderr: 'Error: listen EADDRINUSE: address already in use 127.0.0.1:60212' }).some((t) => /60212/.test(t)));
check('诊断：缺运行时', explainFailure({ stderr: 'app-launch-failed\nmissing_runtime' }).some((t) => /DOTNET_ROOT/.test(t)));
check('诊断：认不出就不猜', explainFailure({ stderr: 'some random error' }).length === 0);
check('诊断：ENOENT', explainFailure({ spawnError: 'spawn codebuddy ENOENT' }).some((t) => /\.cmd/.test(t)));
check('留痕：有改动无 patch 会提醒', /没有新增 patch/.test(patchDisciplineWarning({ dirty: true, newPatches: 0, patchDir: 'D:////x////.ai////patches' })));
check('留痕：产出了 patch 不提醒', patchDisciplineWarning({ dirty: true, newPatches: 1 }) === '');
check('留痕：没改动不提醒', patchDisciplineWarning({ dirty: false, newPatches: 0 }) === '');
{
  const pd = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-patches-'));
  fs.writeFileSync(path.join(pd, 'a.patch'), 'x');
  fs.writeFileSync(path.join(pd, 'b.txt'), 'x');
  check('countPatchFiles 只数 .patch', countPatchFiles(pd) === 1, String(countPatchFiles(pd)));
  check('countPatchFiles 空目录安全', countPatchFiles(path.join(pd, 'nope')) === 0);
}

// ── 发文件：标记抠取 / 路径闸 / 直发命令 ─────────────────────
{
  fs.writeFileSync(path.join(TMP, 'sample.txt'), 'hello-file', 'utf8');

  const m = extractFileMarks('改好了 [[file: dist/a.zip]] 顺带 [[file:dist/a.zip]] 重复');
  check('文件标记被抠出', !/\[\[file/.test(m.body), m.body);
  check('文件标记去重', m.paths.length === 1 && m.paths[0] === 'dist/a.zip', JSON.stringify(m.paths));

  check('目录内放行', !resolveOutgoing('sample.txt', { workdir: TMP, maxFileBytes: 0 }).error);
  check('相对越界拒绝', !!resolveOutgoing('..\\..\\secret.txt', { workdir: TMP, maxFileBytes: 0 }).error);
  check('绝对路径越界拒绝', !!resolveOutgoing('C:\\Windows\\win.ini', { workdir: TMP, maxFileBytes: 0 }).error);
  check('超上限拒绝', !!resolveOutgoing('sample.txt', { workdir: TMP, maxFileBytes: 2 }).error);
  check('文件命令解析', parseAgentCommand('/wb 文件 dist/a.zip', '/wb')?.kind === 'file'
    && parseAgentCommand('/wb 文件 dist/a.zip', '/wb')?.task === 'dist/a.zip');

  const fileBridges = createAgentBridges({
    getConfig: makeCfg({ prefix: '/wb', workdir: TMP, sendFiles: true }),
    sender, log: () => {}, emit: () => {}
  });

  sent.length = 0; fileSends.length = 0;
  fileBridges.handle('private:1001', { text: '/wb 帮我打包 [[file: sample.txt]]', senderId: '1001', mid: 30 }, { atMe: false, kind: 'private' });
  await fileBridges.awaitIdle();
  check('答案里带标记会自动发文件', fileSends.length === 1 && fileSends[0].path.endsWith('sample.txt'), JSON.stringify(fileSends));
  check('回发正文去掉标记', !/\[\[file/.test(sent.at(-1)?.text || ''), sent.at(-1)?.text);

  sent.length = 0; fileSends.length = 0;
  fileBridges.handle('private:1001', { text: '/wb 文件 ..\\..\\secret.txt', senderId: '1001', mid: 31 }, { atMe: false, kind: 'private' });
  await fileBridges.awaitIdle();
  check('越界直发被拒', fileSends.length === 0 && /不在允许的目录内/.test(sent.at(-1)?.text || ''), sent.at(-1)?.text);

  // 额外允许目录（fileRoots）：patch 放在 workdir 之外也能发
  // 必须建在 workdir **外面**，否则默认就在允许范围内，测不出 fileRoots 的作用
  const extraRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-extra-'));
  fs.writeFileSync(path.join(extraRoot, 'p.patch'), 'diff --git a b', 'utf8');
  check('额外目录默认不放行', !!resolveOutgoing(path.join(extraRoot, 'p.patch'), { workdir: TMP, maxFileBytes: 0 }).error);
  check('配置 fileRoots 后放行', !resolveOutgoing(path.join(extraRoot, 'p.patch'), { workdir: TMP, fileRoots: [extraRoot], maxFileBytes: 0 }).error);

  // allowAnyFile：全盘放行（临时开关），但仍不允许目录、仍查大小
  check('默认拒绝全盘路径', !!resolveOutgoing(path.join(extraRoot, 'p.patch'), { workdir: TMP, maxFileBytes: 0 }).error);
  check('allowAnyFile 放行全盘路径', !resolveOutgoing(path.join(extraRoot, 'p.patch'), { workdir: TMP, allowAnyFile: true, maxFileBytes: 0 }).error);
  check('allowAnyFile 仍拒绝目录', !!resolveOutgoing(extraRoot, { workdir: TMP, allowAnyFile: true, maxFileBytes: 0 }).error);

  sent.length = 0; fileSends.length = 0;
  fileBridges.handle('private:1001', { text: '/wb 文件 sample.txt', senderId: '1001', mid: 32 }, { atMe: false, kind: 'private' });
  await fileBridges.awaitIdle();
  check('直发合法文件', fileSends.length === 1 && /已发送 sample\.txt/.test(sent.at(-1)?.text || ''), sent.at(-1)?.text);
}

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
