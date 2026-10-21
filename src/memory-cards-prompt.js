// 记忆卡注入：按需把「通用卡 / 群卡 / 在场成员卡 / 话题卡」拼成一段提示词
//
// 规则（按用户定稿）：
//   · 通用卡：每轮都带
//   · 群卡：只在本会话带
//   · 成员卡：最近 20 条出现过的人 + 被点名的人（可开关），且只带 summary + 该会话的印象
//   · 话题卡：模式 2b —— 关键词命中拉全文，未命中只给标题索引，再随机闪回 2~3 张 summary
//   · 预算：总 ≤ maxChars（默认 1500 字），超出按优先级截断
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const ROOT = path.join(DATA_DIR, 'memory-cards');
const PERSONS = path.join(ROOT, 'persons');
const read = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
const dirOf = (chatKey) => path.join(ROOT, String(chatKey || '').replace(/[:\\/]/g, '_'));
const safeQq = (qq) => String(qq || '').replace(/[^\d]/g, '');

function readJsonDir(dir, prefix) {
  const out = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith(prefix) || !f.endsWith('.json')) continue;
      const c = read(path.join(dir, f));
      if (c) out.push(c);
    }
  } catch { /* ignore */ }
  return out;
}

/**
 * 组装记忆卡提示段落
 * @param {object} opts
 *  chatKey        当前会话
 *  triggerEntries 本轮触发消息
 *  pastMessages   已读窗口消息（用来判定"在场"）
 *  cfg            记忆卡配置（memoryCards 段）
 * @returns {string} 空串表示不带
 */
export function buildMemoryCardsBlock({ chatKey, triggerEntries = [], pastMessages = [], cfg = {} }) {
  if (cfg.enabled === false) return '';
  const maxChars = Math.max(200, Number(cfg.maxChars) || 1500);
  const maxPersons = Math.max(1, Number(cfg.maxPersonCount) || 6);
  const windowSize = Math.max(5, Number(cfg.presentWindow) || 20);
  const flashback = Math.max(0, Number(cfg.flashbackCount) || 2);
  const scope = String(cfg.impressionScope || 'auto');   // auto | all | model

  const parts = [];
  let used = 0;
  const tryPush = (text, cost) => {
    if (!text) return false;
    const c = cost ?? text.length;
    if (used + c > maxChars) return false;
    parts.push(text);
    used += c;
    return true;
  };

  // ① 通用卡（永远第一优先）
  const general = read(path.join(ROOT, 'general.json'));
  if (general) {
    const facts = (general.facts || []).slice(0, 6).map((f) => f.key + '：' + f.value).join('；');
    tryPush('【通用】' + clip(general.summary || '', 80) + (facts ? '\n' + facts : ''), 0);
  }

  // ② 群卡 / 会话卡（仅当前会话）
  const group = read(path.join(dirOf(chatKey), 'group.json'));
  if (group) {
    const facts = (group.facts || []).filter((f) => f.value && !/待补/.test(String(f.value))).slice(0, 4)
      .map((f) => f.key + '：' + f.value).join('；');
    tryPush('【本会话】' + clip(group.summary || '', 100) + (facts ? '\n' + facts : ''), 0);
  }

  // ③ 在场成员（最近 windowSize 条出现过的人 + 被点名的人）
  const present = new Set();
  const useWindow = cfg.presenceWindow !== false;
  const useMention = cfg.presenceMention !== false;
  const scan = [...(triggerEntries || []), ...(useWindow ? (pastMessages || []).slice(-windowSize) : [])];
  for (const m of scan) {
    if (!m || m.self) continue;
    if (m.senderId) present.add(String(m.senderId));
    if (useMention) {
      for (const n of (m.atNames || [])) { /* @ 名单由上层翻译成 QQ 时才有意义，这里仅占位 */ void n; }
      if (m.atMe) { /* 被 @ 的是机器人自己，不增加成员 */ }
    }
  }
  // 被点名的成员：从消息文本里找名字（用个人卡的 name/aliases 反查）
  const allPersons = readJsonDir(PERSONS, '');
  const byQq = new Map(allPersons.map((p) => [String(p.qq), p]));
  if (useMention) {
    const textAll = scan.map((m) => String(m.text || '')).join('\n');
    if (textAll.trim()) {
      for (const p of allPersons) {
        if (present.has(String(p.qq))) continue;
        const names = [p.name, ...(p.aliases || [])].filter((x) => x && x.length >= 2);
        if (names.some((n) => textAll.includes(n))) present.add(String(p.qq));
      }
    }
  }
  const persons = [...present].map((qq) => byQq.get(qq)).filter(Boolean).slice(0, maxPersons);
  if (persons.length) {
    const lines = [];
    for (const p of persons) {
      // 印象按 impressionScope 取：auto=通用+本会话 / all=通用+所有 / model=只给通用
      const imp = p.impressions || {};
      const chatNotes = imp.byChat?.[chatKey] || [];
      const allNotes = Object.values(imp.byChat || {}).flat();
      let notes = [];
      if (scope === 'all') notes = allNotes;
      else if (scope === 'model') notes = [];
      else notes = chatNotes.length ? chatNotes : [];
      const one = notes[0] || imp.general || p.summary || '';
      if (one) lines.push('· ' + (p.name || p.qq) + '：' + clip(one, 70));
    }
    if (lines.length) tryPush('【在场】\n' + lines.join('\n'), 0);
  }

  // ④ 话题卡：关键词命中拉全文 + 标题索引 + 随机闪回
  const topics = readJsonDir(dirOf(chatKey), 'topic_');
  if (topics.length) {
    const textAll = scan.map((m) => String(m.text || '')).join('\n');
    const hit = [];
    const rest = [];
    for (const t of topics) {
      const kws = (t.keywords || []).filter(Boolean);
      const matched = kws.some((k) => textAll.includes(k));
      (matched ? hit : rest).push(t);
    }
    if (hit.length) {
      const lines = hit.slice(0, 2).map((t) => '· ' + t.title + '：' + clip(t.body || t.summary || '', 160));
      tryPush('【相关话题】\n' + lines.join('\n'), 0);
    }
    const titles = rest.slice(0, 8).map((t) => t.title).filter(Boolean);
    if (titles.length) tryPush('【其它话题】' + titles.join(' / ') + '（需要细节可以问）', 0);
    if (flashback > 0) {
      const pool = rest.filter((t) => t.summary).sort(() => Math.random() - 0.5).slice(0, flashback);
      if (pool.length) tryPush('【偶然想起】\n' + pool.map((t) => '· ' + t.title + '：' + clip(t.summary, 60)).join('\n'), 0);
    }
  }

  if (!parts.length) return '';
  return '【记忆卡】\n' + parts.join('\n');
}
