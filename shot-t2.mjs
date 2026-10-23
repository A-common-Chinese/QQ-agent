import WebSocket from 'ws';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9365;
const STEPS = JSON.parse(process.env.STEPS_JSON || '[]');
const PROFILE = process.env.TEMP + '\\edge-cdp-qa33';
const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE, '--window-size=1624,1005', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pageWs = null;
for (let i = 0; i < 40; i += 1) { await sleep(400); try { const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); const page = list.find((t) => t.type === 'page'); if (page) { pageWs = page.webSocketDebuggerUrl; break; } } catch { } }
const ws = new WebSocket(pageWs, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
let id = 0; const pending = new Map();
ws.on('message', (buf) => { const m = JSON.parse(String(buf)); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((resolve) => { const mid = ++id; pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params })); });
await new Promise((r) => ws.on('open', r));
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1624, height: 1005, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: process.argv[2] });
await sleep(9000);
for (const st of STEPS) { const r = await send('Runtime.evaluate', { expression: st.expr, awaitPromise: true, returnByValue: true }); if (r.result && r.result.result && r.result.result.value !== undefined) console.log('[eval]', String(r.result.result.value).slice(0,200)); await sleep(st.wait || 1500); if (st.shot) { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(st.shot, Buffer.from(shot.result.data, 'base64')); console.log('[shot]', st.shot, fs.statSync(st.shot).size); } }
ws.close(); child.kill(); setTimeout(() => process.exit(0), 400);
