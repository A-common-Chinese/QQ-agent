// E2E 用的假 OneBot v11 协议端：一个 WS（事件下行）+ 一个 HTTP（动作上行）。
//
// 用途：在**不接真实 QQ** 的前提下，把一条消息灌进 QQ Agent 的 ingest 路径，
// 然后观察它真正发出去了什么。QQ Agent 的动作走 HTTP（onebot.call → httpUrl/<action>），
// 事件走 WS，所以这里必须同时提供两个端口。
//
// 用法（在 qq-agent 目录下）：
//   E2E_TASKS='["第一个任务","第二个任务"]' node dev-tools/fake-onebot-e2e.mjs
// 环境变量：E2E_WS_PORT(30501) E2E_HTTP_PORT(30500) E2E_USER_ID(10001) E2E_BOT_ID(90001)
//           E2E_TIMEOUT_MS(300000) E2E_TASKS(默认单条)

import http from 'node:http';
import { WebSocketServer } from 'ws';

const WS_PORT = Number(process.env.E2E_WS_PORT || 30501);
const HTTP_PORT = Number(process.env.E2E_HTTP_PORT || 30500);
const USER_ID = Number(process.env.E2E_USER_ID || 10001);
const BOT_ID = Number(process.env.E2E_BOT_ID || 90001);
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 300000);
const TASKS = JSON.parse(process.env.E2E_TASKS || '["用一句话回答：你是谁？"]');
/** 命令前缀：注入的消息必须带上它，否则桥不会认领（那是被测对象的行为）。 */
const PREFIX = process.env.E2E_PREFIX === undefined ? '/dsh ' : process.env.E2E_PREFIX;
/** 每个任务的答案里必须包含的子串（可选，用于把"有回话"升级成"回对了"）。 */
const EXPECTS = JSON.parse(process.env.E2E_EXPECT || '[]');
const answers = [];
const failures = [];

const outbound = [];
let socket = null;
let taskIndex = -1;
let messageSeq = 9000;
let finished = false;
const startedAt = Date.now();

function stamp() {
  return `+${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
}

function finish(code) {
  if (finished) return;
  finished = true;
  const verdict = code === 0 && failures.length === 0;
  console.log(`\n=== E2E ${verdict ? 'PASS' : 'FAIL'} ===`);
  console.log(`注入任务数 ${TASKS.length}，收到出站消息 ${outbound.length} 条，答案 ${answers.length} 条`);
  for (const [i, m] of outbound.entries()) console.log(`  [out ${i + 1}] ${m.slice(0, 200)}`);
  for (const [i, a] of answers.entries()) console.log(`  [ans ${i + 1}] ${a.slice(0, 200)}`);
  for (const f of failures) console.log(`  [!!] ${f}`);
  try { socket?.close(); } catch { /* ignore */ }
  try { wss.close(); } catch { /* ignore */ }
  try { httpServer.close(); } catch { /* ignore */ }
  setTimeout(() => process.exit(verdict ? 0 : 1), 300);
}

function segmentsToPlain(message) {
  if (typeof message === 'string') return message;
  if (!Array.isArray(message)) return '';
  return message.map((s) => (s?.type === 'text' ? String(s?.data?.text ?? '') : `[${s?.type}]`)).join('');
}

const httpServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const action = String(req.url || '').replace(/^\//, '').split('?')[0];
    let params = {};
    try { params = JSON.parse(body || '{}'); } catch { /* 空 body 也算合法 */ }

    let data = { message_id: 5000 + outbound.length };
    if (action === 'get_login_info') data = { user_id: BOT_ID, nickname: 'fake-bot' };

    if (action === 'send_private_msg' || action === 'send_group_msg') {
      const text = segmentsToPlain(params.message);
      outbound.push(text);
      console.log(`[${stamp()}] <- 机器人发出：${text.slice(0, 300)}`);
      // 回发带了引用段（replyToMessageId），在裸文本里表现为前缀 [reply]，判定前先剥掉
      const norm = text.replace(/^\[reply\]/, '');
      const isAck = norm.startsWith('⏳') || norm.startsWith('…');
      if (!isAck) {
        const expect = EXPECTS[taskIndex];
        answers.push(norm);
        if (expect && !norm.includes(expect)) failures.push(`任务#${taskIndex + 1} 期望含「${expect}」，实际：${norm.slice(0, 200)}`);
        taskIndex += 1;
        if (taskIndex >= TASKS.length) { finish(failures.length ? 1 : 0); return; }
        setTimeout(injectNext, 1200);
      }
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
  });
});

const wss = new WebSocketServer({ host: '127.0.0.1', port: WS_PORT });

function injectNext() {
  if (finished || !socket || socket.readyState !== 1) return;
  const task = TASKS[taskIndex];
  const line = `${PREFIX}${task}`;
  messageSeq += 1;
  const event = {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: messageSeq,
    user_id: USER_ID,
    self_id: BOT_ID,
    raw_message: line,
    message: [{ type: 'text', data: { text: line } }],
    sender: { user_id: USER_ID, nickname: 'tester' },
    time: Math.floor(Date.now() / 1000)
  };
  socket.send(JSON.stringify(event));
  console.log(`[${stamp()}] -> 注入消息 #${taskIndex + 1}：${line.slice(0, 200)}`);
}

wss.on('connection', (sock) => {
  socket = sock;
  console.log(`[${stamp()}] OneBot WS 已连接（bot id ${BOT_ID}）`);
  setTimeout(() => { taskIndex = 0; injectNext(); }, 2500);
});

httpServer.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`[${stamp()}] 假协议端就绪：WS ${WS_PORT} / HTTP ${HTTP_PORT}`);
});
wss.on('listening', () => {
  console.log(`[${stamp()}] WS 监听 ${WS_PORT}`);
});

setTimeout(() => { console.log(`[${stamp()}] 超时：没等到完整回答`); finish(2); }, TIMEOUT_MS);
