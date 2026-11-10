#!/usr/bin/env node
// 假 agent（stub）：模拟 `codex exec` 的最小行为，用来验证 /agent 桥接链路。
//
// 为什么需要它：桥的难点在"起进程 / 收事件 / 取答案 / 续跑 / 杀进程"，
// 与背后是哪个 agent 关系不大。没有真实 provider 时，用这个 stub 就能把整条
// 链路在真机上跑通；等有 Key 再把配置换成真 CLI，桥本身不用改。
//
// 支持的参数（刻意做成与 codex 同形）：
//   --json              输出 JSONL 事件（thread.started / item.completed）
//   -o, --output-last-message <file>   最终答复写入文件
//   resume <id> | --last               续跑（把 id 回显在答复里，便于肉眼确认）
//   --sleep             干完活再挂 30 秒（用来测「/agent 停」能不能杀掉）
//   -                   任务正文从 stdin 读（codex 的写法）
//
// 退出码：0 成功；2 没给任务。
import fs from 'node:fs';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : '';
};
const has = (name) => argv.includes(name);

const outFile = flag('-o') || flag('--output-last-message');
const isJson = has('--json');
const resumeAt = argv.indexOf('resume');
const resumeId = resumeAt >= 0 ? (argv[resumeAt + 1] || '') : '';
const useLast = has('--last');

// 任务正文：优先 stdin（与 codex 的 `-` 一致），没有就从 argv 里挑第一个不像参数的
let task = '';
if (has('-')) {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  task = Buffer.concat(chunks).toString('utf8').trim();
}
if (!task) task = argv.filter((a) => !a.startsWith('-') && a !== resumeId).pop() || '';
if (!task) {
  process.stderr.write('stub-agent: 没有收到任务（用 stdin 或最后一个参数传）\n');
  process.exit(2);
}

const sessionId = useLast ? 'stub-last-session' : (resumeId || `stub-${crypto.randomBytes(4).toString('hex')}`);
const started = Date.now();

const emit = (obj) => {
  if (isJson) process.stdout.write(`${JSON.stringify(obj)}\n`);
};

// 事件流：与 codex 的 --json 同形（thread.started 带 thread_id，供桥记会话）
emit({ type: 'thread.started', thread_id: sessionId });
emit({ type: 'item.completed', item: { type: 'tool_call', name: 'shell', text: '（假动作）读取工作目录' } });

const cwd = process.cwd();
const answer = [
  `[stub] 收到任务：${task}`,
  `会话：${sessionId}${resumeId || useLast ? '（续跑）' : '（新会话）'}`,
  `工作目录：${cwd}`,
  `耗时：${((Date.now() - started) / 1000).toFixed(2)}s`,
  '',
  '这是一条来自假 agent 的回复，用来验证 /agent 桥：前缀认领、白名单、回传、续跑。'
].join('\n');

emit({ type: 'item.completed', item: { type: 'agent_message', text: answer } });
if (!isJson) process.stdout.write(`${answer}\n`);
if (outFile) fs.writeFileSync(outFile, answer, 'utf8');

if (has('--sleep')) await new Promise((r) => setTimeout(r, 30000));
process.exit(0);
