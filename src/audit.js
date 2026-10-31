// 操作审计：把与隐私相关的关键操作写到本地日志（data/logs/audit.log，JSONL）。
// 目的不是"防篡改"，而是让"谁在什么时候关过滤/清数据/导出"有据可查。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const DIR = path.join(DATA_DIR, 'logs');
const FILE = path.join(DIR, 'audit.log');

export function appendAudit(action, detail = {}) {
  try {
    if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
    const line = JSON.stringify({ ts: Date.now(), action: String(action), detail }) + '\n';
    fs.appendFileSync(FILE, line, 'utf8');
    return true;
  } catch { return false; }
}

export function readAudit(limit = 200) {
  try {
    const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-Math.max(1, Math.min(2000, limit))).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
  } catch { return []; }
}
