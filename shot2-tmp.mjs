// CDP 截图：node shot.mjs <url> <out.png> [jsExpr] [waitMs]
import WebSocket from 'ws';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9334;
const URL = process.argv[2] || 'http://127.0.0.1:3210/';
const OUT = process.argv[3];
const EXPR = process.argv[4] || '';
const WAIT = Number(process.argv[5] || 9000);
const PROFILE = process.env.TEMP + '\\edge-cdp-qa2';

const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`, '--window-size=1440,900', 'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pageWs = null;
for (let i = 0; i < 40; i += 1) {
  await sleep(400);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page) { pageWs = page.webSocketDebuggerUrl; break; }
  } catch { /* 等 */ }
}
if (!pageWs) { console.error('CDP 没起来'); child.kill(); process.exit(1); }

const ws = new WebSocket(pageWs, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
let id = 0;
const pending = new Map();
ws.on('message', (buf) => {
  const msg = JSON.parse(String(buf));
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const mid = ++id;
  pending.set(mid, resolve);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
await new Promise((r) => ws.on('open', r));
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: URL });
await sleep(WAIT);
if (EXPR) {
  const r = await send('Runtime.evaluate', { expression: EXPR, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) console.error('js error:', JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  await sleep(2500);
}
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
if (!shot.result?.data) { console.error('截图失败'); child.kill(); process.exit(1); }
fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
const state = await send('Runtime.evaluate', { expression: 'JSON.stringify({tab:window.state&&state.tab,theme:document.documentElement.dataset.theme,subnav:(document.getElementById("subnav")||{}).innerText})', returnByValue: true });
console.log('saved', OUT, fs.statSync(OUT).size, 'bytes');
console.log('state:', state.result?.result?.value);
ws.close();
child.kill();
setTimeout(() => process.exit(0), 400);
