// 通道身份映射：群号（OneBot）↔ openid（官方机器人）
//   A 模式 merge ：读合并（读两边、写各自）
//   C 模式 mirror：镜像写入（绑定时起新数据写两份，不合并历史）
// 只依赖 config，避免与 memory / memory-cards 形成循环引用。
import { getConfig, updateConfig } from './config.js';

const MODES = new Set(['merge', 'mirror']);

export function listLinks() {
  const raw = getConfig().identityLinks;
  return Array.isArray(raw) ? raw.filter((x) => x && x.onebotKey && x.qqbotKey) : [];
}

export function listHistory() {
  const raw = getConfig().identityLinksHistory;
  return Array.isArray(raw) ? raw : [];
}

export function flowFor(chatKey) {
  const key = String(chatKey || '').trim();
  if (!key) return null;
  return listLinks().find((l) => l.onebotKey === key || l.qqbotKey === key) || null;
}

/** 该会话的「逻辑主键」（群号 / QQ 号那一侧） */
export function canonicalKey(chatKey) {
  const link = flowFor(chatKey);
  return link ? link.onebotKey : String(chatKey || '');
}

/** 读取时要查哪些物理 key */
export function resolveKeys(chatKey) {
  const key = String(chatKey || '').trim();
  const link = flowFor(key);
  if (!link) return key ? [key] : [];
  // merge = 读两边；mirror = 数据已镜像，读自己即可（但补上主键兜底）
  if (link.mode === 'mirror') return [key, link.onebotKey === key ? link.qqbotKey : link.onebotKey];
  return [link.onebotKey, link.qqbotKey];
}

/** 写入要写到哪些 key（mirror 模式写两份；merge 模式只写自己） */
export function writeKeys(chatKey) {
  const key = String(chatKey || '').trim();
  const link = flowFor(key);
  if (!link) return key ? [key] : [];
  if (link.mode !== 'mirror') return [key];
  return [link.onebotKey, link.qqbotKey];
}

function pickKey(raw) {
  const k = String(raw || '').trim();
  if (!k) return '';
  if (!/^(group|private):[0-9A-Za-z_]+$/.test(k)) return '';
  return k;
}

export function addLink({ onebotKey, qqbotKey, note = '', mode = 'merge' }) {
  const a = pickKey(onebotKey);
  const b = pickKey(qqbotKey);
  if (!a || !b) return { ok: false, error: '两个 key 都必须形如 group:xxx / private:xxx' };
  if (a === b) return { ok: false, error: '两边不能是同一个会话' };
  if (!a.startsWith('group:') !== !b.startsWith('group:')) return { ok: false, error: '群对群、私聊对私聊，不能混绑' };
  const links = listLinks();
  if (links.some((l) => l.onebotKey === a || l.qqbotKey === a || l.onebotKey === b || l.qqbotKey === b)) {
    return { ok: false, error: '其中一边已经绑定过了，请先解绑' };
  }
  const link = { id: 'lk' + Date.now().toString(36), onebotKey: a, qqbotKey: b, note: String(note || '').slice(0, 40), mode: MODES.has(mode) ? mode : 'merge', linkedAt: Date.now() };
  updateConfig({ identityLinks: { __replace__: [...links, link] } });
  return { ok: true, link };
}

export function setLinkMode(id, mode) {
  if (!MODES.has(mode)) return { ok: false, error: '未知模式' };
  const links = listLinks();
  const i = links.findIndex((l) => l.id === id);
  if (i < 0) return { ok: false, error: '没有这个映射' };
  links[i] = { ...links[i], mode };
  updateConfig({ identityLinks: { __replace__: links } });
  return { ok: true, link: links[i] };
}

/** 解绑：仅停合并（默认），或把共享期数据复制到两侧（copy=true，仅 merge 模式有意义） */
export function unlink(id, { copy = false } = {}) {
  const links = listLinks();
  const link = links.find((l) => l.id === id);
  if (!link) return { ok: false, error: '没有这个映射' };
  const history = listHistory();
  const tomb = { ...link, unlinkedAt: Date.now(), copied: !!copy };
  updateConfig({
    identityLinks: { __replace__: links.filter((l) => l.id !== id) },
    identityLinksHistory: { __replace__: [...history, tomb].slice(-50) }
  });
  return { ok: true, link, historyItem: tomb };
}

/** 撤销解绑：7 天内有效，仅恢复链接（数据未迁移，零风险） */
export function restore(id) {
  const history = listHistory();
  const item = history.find((h) => h.id === id);
  if (!item) return { ok: false, error: '历史里没有这条' };
  if (Date.now() - Number(item.unlinkedAt || 0) > 7 * 24 * 60 * 60 * 1000) return { ok: false, error: '超过 7 天，不能撤销' };
  const links = listLinks();
  if (links.some((l) => l.onebotKey === item.onebotKey || l.qqbotKey === item.qqbotKey || l.onebotKey === item.qqbotKey || l.qqbotKey === item.onebotKey)) {
    return { ok: false, error: '其中一边已被重新绑定' };
  }
  const { unlinkedAt, copied, ...rest } = item;
  updateConfig({
    identityLinks: { __replace__: [...links, rest] },
    identityLinksHistory: { __replace__: history.filter((h) => h.id !== id) }
  });
  return { ok: true, link: rest };
}
