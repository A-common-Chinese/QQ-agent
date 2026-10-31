// 消息存档保留策略：超过 N 天的消息从 data/messages/*.json 里删掉。
// 注意：**只清消息存档**，不碰记忆卡（记忆卡存的是已经过滤/概括过的印象，不是原始数据）。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';
import { appendAudit } from './audit.js';

const MESSAGES = path.join(DATA_DIR, 'messages');

/** 清理超过 retentionDays 的消息；返回 { files, removed, kept } */
export function purgeOldMessages(retentionDays) {
  const days = Math.max(1, Number(retentionDays) || 7);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  // 媒体引用单独更短保留（默认 24h）：图片/文件/语音只留最近一天，之后清空 url
  let mediaHours = 24;
  try { mediaHours = Number(getConfig().privacy?.mediaRetentionHours ?? 24); } catch { /* ignore */ }
  const mediaCutoff = Date.now() - Math.max(1, mediaHours) * 60 * 60 * 1000;
  let files = 0; let removed = 0; let kept = 0;
  try {
    if (!fs.existsSync(MESSAGES)) return { files: 0, removed: 0, kept: 0 };
    for (const f of fs.readdirSync(MESSAGES)) {
      if (!f.endsWith('.json')) continue;
      const p = path.join(MESSAGES, f);
      const st = JSON.parse(fs.readFileSync(p, 'utf8'));
      const list = Array.isArray(st.messages) ? st.messages : [];
      const next = list.filter((m) => Number(m?.ts || 0) >= cutoff);
      for (const m of next) {
        if (Array.isArray(m.media) && m.media.length && Number(m.ts || 0) < mediaCutoff) m.media = [];
      }
      const drop = list.length - next.length;
      if (!drop) { kept += list.length; continue; }
      st.messages = next;
      const tmp = p + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(st, null, 1), 'utf8');
      fs.renameSync(tmp, p);
      files += 1; removed += drop; kept += next.length;
    }
    if (removed) appendAudit('messages-purge', { retentionDays: days, files, removed, kept });
  } catch (error) {
    appendAudit('messages-purge-failed', { error: String(error?.message || error) });
  }
  return { files, removed, kept };
}

/** 按当前配置执行（供 app.js 定时器调用） */
export function purgeOldMessagesByConfig() {
  try {
    const cfg = getConfig() || {};
    const days = Number(cfg.storage?.messageRetentionDays ?? 7);
    if (!(days > 0)) return { files: 0, removed: 0, kept: 0 };
    return purgeOldMessages(days);
  } catch { return { files: 0, removed: 0, kept: 0 }; }
}
