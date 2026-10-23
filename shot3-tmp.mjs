import WebSocket from 'ws';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9335;
const URL = process.argv[2];
const OUT = process.argv[3];
const STEPS = JSON.parse(process.env.STEPS_JSON || '[]');   // [{expr, wait}]
const PROFILE = process.env.TEMP + '\\edge-cdp-qa3';

const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + PROFILE, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pageWs = null;
for (let i = 0; i < 40; i += 1) {
  await sleep(400);
  try {
    const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
    const page = list.find((t) => t.type === 'page');
    if (page) { pageWs = page.webSocketDebuggerUrl; break; }
  } catch { /* 等 */ }
}
if (!pageWs) { console.error('CDP 没起来'); child.kill(); process.exit(1); }
const ws = new WebSocket(pageWs, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
let id = 0; const pending = new Map();
ws.on('message', (buf) => { const m = JSON.parse(String(buf)); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((resolve) => { const mid = ++id; pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params })); });
await new Promise((r) => ws.on('open', r));
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: URL });
await sleep(9000);
for (const st of STEPS) {
  const r = await send('Runtime.evaluate', { expression: st.expr, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) console.error('js error:', JSON.stringify(r.result.exceptionDetails).slice(0, 260));
  if (r.result && r.result.result && r.result.result.value !== undefined) console.log('eval:', JSON.stringify(r.result.result.value).slice(0, 400));
  await sleep(st.wait || 1500);
}
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
const st2 = await send('Runtime.evaluate', { expression: 'JSON.stringify({theme:document.documentElement.dataset.theme, chart:(document.querySelector("[data-uc-chart].on")||{}).getAttribute?document.querySelector("[data-uc-chart].on").getAttribute("data-uc-chart"):null, charts:document.querySelectorAll("[data-uc-chart]").length, plot:!!document.querySelector(".uc-plot svg"), fab:!!document.getElementById("fab-btn")})', returnByValue: true });
console.log('saved', OUT, fs.statSync(OUT).size);
console.log('state:', st2.result && st2.result.result && st2.result.result.value);
ws.close(); child.kill(); setTimeout(() => process.exit(0), 400);
