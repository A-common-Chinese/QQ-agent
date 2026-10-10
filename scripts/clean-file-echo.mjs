// 清理"自己上传的文件被协议端回灌成对方消息"这种假条目。
//
// 背景：私聊/群上传文件成功后，协议端会额外推一条 message 事件，却把发送者标成对方。
// src/app.js 的 ingest 已经挡掉**新的**回显，但历史存档里可能已经躺着这种假条目，
// 它们仍在模型最近上下文窗口里（默认 80 条），会让模型以为"对方发了文件"。
//
// 判定（三条同时成立，和 ingest 的过滤同口径）：
//   ① !self 且文本以 "[文件" 开头
//   ② 同一会话里存在一条 self 条目，其 "[文件：xxx]" 的文件名被这条文本包含
//   ③ 两条时间差 ≤ --window（默认 120 秒）
//
// 用法（在仓库根目录，DSH 自带 node 即可）：
//   node scripts/clean-file-echo.mjs --chat private:85946573            # 只预览
//   node scripts/clean-file-echo.mjs --chat private:85946573 --apply    # 真删
//   node scripts/clean-file-echo.mjs --all --apply                      # 扫全部会话
// 可选：--data-dir <dir>（默认 QQ_AGENT_DATA_DIR 或 <repo>/data）、--port <控制台端口>
//
// ⚠️ 应用正在跑时**必须**走它的 HTTP 接口删除（否则内存态会在下次写入时把文件改回去）；
//    接口不可达时才退化成直接改文件，并提示重启。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = (name) => args.includes('--' + name);

const DATA_DIR = flag('data-dir') || process.env.QQ_AGENT_DATA_DIR || path.join(ROOT, 'data');
const WINDOW_MS = Math.max(1000, Number(flag('window', '120000')) || 120000);
const APPLY = has('apply');
const ALL = has('all');
const CHAT = flag('chat');

if (!ALL && !CHAT) {
  console.log('用法：node scripts/clean-file-echo.mjs --chat private:85946573 [--apply] | --all [--apply]');
  process.exit(1);
}

const messagesDir = path.join(DATA_DIR, 'messages');
if (!fs.existsSync(messagesDir)) {
  console.log('找不到消息目录：' + messagesDir);
  process.exit(1);
}

/** 端口：显式 --port > 该数据目录 config.json 里的 server.port > 3310 */
function resolvePort() {
  const explicit = Number(flag('port'));
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
    const p = Number(cfg?.server?.port);
    if (Number.isFinite(p) && p > 0) return p;
  } catch { /* 用默认 */ }
  return 3310;
}

function readArchive(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const list = Array.isArray(raw) ? raw : (raw.messages || raw.entries || []);
  return { raw, list, isArray: Array.isArray(raw) };
}

function writeArchive(file, raw, list, isArray) {
  const json = isArray ? list : { ...raw, messages: list };
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n', 'utf8');
}

const isFileText = (t) => /^\[文件/.test(String(t ?? '').trim());
/** 从我们自己写的 "[文件：xxx]" 里取文件名 */
function selfFileName(text) {
  const m = String(text ?? '').trim().match(/^\[文件：(.+)\]$/);
  return m ? m[1].trim() : '';
}

function findEchoes(list) {
  const selfFiles = list.filter((m) => m?.self && isFileText(m.text) && selfFileName(m.text));
  const echoes = [];
  for (const m of list) {
    if (!m || m.self || !isFileText(m.text)) continue;
    const hit = selfFiles.find((s) => Math.abs(Number(s.ts) - Number(m.ts)) <= WINDOW_MS
      && String(m.text).includes(selfFileName(s.text)));
    if (hit) echoes.push({ entry: m, matchedSelf: hit });
  }
  return echoes;
}

const targets = [];
if (ALL) {
  for (const name of fs.readdirSync(messagesDir)) {
    if (!name.endsWith('.json')) continue;
    const m = name.replace(/\.json$/, '').match(/^(group|private)_(\d+)$/);
    if (m) targets.push({ chatKey: `${m[1]}:${m[2]}`, file: path.join(messagesDir, name) });
  }
} else {
  const m = String(CHAT).match(/^(group|private):(\d+)$/);
  if (!m) {
    console.log('--chat 必须是 group:<群号> 或 private:<QQ号>');
    process.exit(1);
  }
  targets.push({ chatKey: `${m[1]}:${m[2]}`, file: path.join(messagesDir, `${m[1]}_${m[2]}.json`) });
}

const port = resolvePort();
let apiOk = false;
try {
  const r = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(3000) });
  apiOk = r.ok;
} catch { apiOk = false; }
console.log(`数据目录：${DATA_DIR}`);
console.log(`控制台 ${port}：${apiOk ? '可达（走接口删除，内存态同步）' : '不可达（将直接改文件，删完请重启 QQ Agent）'}`);
console.log(APPLY ? '模式：真删' : '模式：预览（加 --apply 才真删）');

let totalFound = 0;
let totalRemoved = 0;
for (const t of targets) {
  if (!fs.existsSync(t.file)) continue;
  const { raw, list, isArray } = readArchive(t.file);
  const echoes = findEchoes(list);
  if (!echoes.length) continue;
  totalFound += echoes.length;
  console.log(`\n[${t.chatKey}] 命中 ${echoes.length} 条假条目：`);
  for (const e of echoes) {
    console.log(`  id=${e.entry.id} ts=${new Date(e.entry.ts).toLocaleString()} from=${e.entry.senderName} text=${String(e.entry.text).slice(0, 40)}`
      + `  ← 对应自己发的 "${selfFileName(e.matchedSelf.text)}"（相隔 ${Math.round((e.entry.ts - e.matchedSelf.ts) / 1000)}s）`);
  }

  if (!APPLY) continue;

  // 备份
  const backup = `${t.file}.bak-fileecho-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(t.file, backup);
  console.log('  已备份 → ' + backup);

  const ids = echoes.map((e) => Number(e.entry.id)).filter((n) => Number.isFinite(n));
  if (apiOk && ids.length) {
    const r = await fetch(`http://127.0.0.1:${port}/api/chats/${t.chatKey.replace(':', '_')}/delete-messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids })
    });
    const body = await r.json().catch(() => ({}));
    console.log(`  接口删除 http=${r.status} ${JSON.stringify(body)}`);
    totalRemoved += ids.length;
  } else {
    const keep = list.filter((m) => !echoes.some((e) => e.entry === m));
    writeArchive(t.file, raw, keep, isArray);
    console.log(`  直接改文件：${list.length} → ${keep.length} 条（⚠️ 应用在跑的话请重启，否则内存态会覆盖回去）`);
    totalRemoved += list.length - keep.length;
  }
}

console.log(`\n合计命中 ${totalFound} 条${APPLY ? `，已删除 ${totalRemoved} 条` : '（预览，未改动）'}`);
