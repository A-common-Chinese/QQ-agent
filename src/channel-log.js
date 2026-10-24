/**
 * 通道日志：SnowLuma 与官方机器人分开存、分开看。
 *   落盘：data/logs/<channel>/<channel>-YYYY-MM-DD.log
 *   内存：每个通道最近 400 行（页面直接读，无需翻文件）
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const CHANNELS = ['snowluma', 'qqbot'];
const RINGS = new Map();
const MAX = 400;

function dirOf(channel) {
  const safe = CHANNELS.includes(channel) ? channel : 'snowluma';
  return path.join(DATA_DIR, 'logs', safe);
}

function fileOf(channel) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return path.join(dirOf(channel), `${channel === 'qqbot' ? 'qqbot' : 'snowluma'}-${day}.log`);
}

export function channelLog(channel, text, stream = 'stdout') {
  const line = String(text ?? '').replace(/\r?\n$/, '');
  if (!line) return;
  const ch = CHANNELS.includes(channel) ? channel : 'snowluma';
  let ring = RINGS.get(ch);
  if (!ring) { ring = []; RINGS.set(ch, ring); }
  const at = Date.now();
  ring.push({ at, stream, text: line });
  if (ring.length > MAX) ring.splice(0, ring.length - MAX);
  try {
    const t = new Date(at);
    const ts = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
    fs.mkdirSync(dirOf(ch), { recursive: true });
    fs.appendFileSync(fileOf(ch), `[${ts}]${stream === 'stderr' ? ' ⚠' : ''} ${line}\n`, 'utf8');
  } catch { /* 写盘失败不影响运行 */ }
}

export function channelLogs(channel, limit = 200) {
  const ring = RINGS.get(CHANNELS.includes(channel) ? channel : 'snowluma') || [];
  return ring.slice(-limit);
}

export function channelLogPath(channel) { return fileOf(channel); }
