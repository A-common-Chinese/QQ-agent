// pre-save（预记录）：在上下文溢出之前，把增量消息先提炼成候选，等下次整理再合并。
//
// 为什么需要它：
//   整理是低频的（默认 6 小时 + 印象阈值），但群消息是高频的。整理时每个人只
//   取样最近 40 条发言（旧逻辑），上午说的事到晚上早被挤出窗口 —— 消息还在盘上，
//   却再也提炼不到。pre-save 每 N 条就把这段"固化"下来，保证每条消息最多被跳过
//   N 条，而不是被 40 条的窗口吞掉。
//
// 设计约束（别踩）：
//   1. **不注入提示词**：候选只入库，不进上下文 —— 保持 prompt cache 稳定。
//   2. **append-only + 独立水位**：每个成员一条水位线，合并失败可重放，不丢。
//   3. **超上限要记账**：maxPending 挤掉旧候选时累加 dropped，不能静默丢。
//
// 存储：
//   data/memory/pre-cards/<chatKey>.state.json   { members: {uid: lastMsgId}, lastAt, pending, dropped }
//   data/memory/pre-cards/<chatKey>.jsonl        一行一条候选
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';

const DIR = path.join(DATA_DIR, 'memory', 'pre-cards');
const safe = (chatKey) => String(chatKey || '').replace(/[:\\/]/g, '_') || 'unknown';
const stateFile = (chatKey) => path.join(DIR, `${safe(chatKey)}.state.json`);
const cardsFile = (chatKey) => path.join(DIR, `${safe(chatKey)}.jsonl`);

/** 配置读取（带默认值与下限，避免设置页填 0 把链路关死）。 */
export function preSaveConfig(raw = null) {
  const c = raw || getConfig().memory?.preSave || {};
  return {
    enabled: c.enabled !== false,
    everyMessages: Math.max(10, Number(c.everyMessages) || 80),
    idleMinutes: Math.max(0, Number(c.idleMinutes) || 10),
    maxPending: Math.max(20, Number(c.maxPending) || 500),
    maxMembersPerRun: Math.max(1, Number(c.maxMembersPerRun) || 8),
    maxMsgsPerMember: Math.max(10, Number(c.maxMsgsPerMember) || 60),
    minMsgsPerMember: Math.max(1, Number(c.minMsgsPerMember) || 3),
    prompt: String(c.prompt || '').trim()
  };
}

export function readState(chatKey) {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(chatKey), 'utf8'));
    return {
      members: raw?.members && typeof raw.members === 'object' ? raw.members : {},
      lastAt: Number(raw?.lastAt) || 0,
      pending: Number(raw?.pending) || 0,
      dropped: Number(raw?.dropped) || 0
    };
  } catch {
    return { members: {}, lastAt: 0, pending: 0, dropped: 0 };
  }
}

export function writeState(chatKey, next) {
  fs.mkdirSync(DIR, { recursive: true });
  const file = stateFile(chatKey);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

export function readCandidates(chatKey) {
  try {
    return fs.readFileSync(cardsFile(chatKey), 'utf8')
      .split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function writeAll(chatKey, items) {
  fs.mkdirSync(DIR, { recursive: true });
  const file = cardsFile(chatKey);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, items.map((x) => JSON.stringify(x)).join('\n') + (items.length ? '\n' : ''), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 追加候选，并按 maxPending 淘汰最旧的。
 * 返回 { added, dropped }：dropped > 0 说明超上限了，必须上报（不能静默丢）。
 */
export function appendCandidates(chatKey, items, { maxPending = 500 } = {}) {
  if (!Array.isArray(items) || !items.length) return { added: 0, dropped: 0 };
  const all = readCandidates(chatKey).concat(items);
  const overflow = Math.max(0, all.length - maxPending);
  const kept = overflow ? all.slice(overflow) : all;
  writeAll(chatKey, kept);
  const st = readState(chatKey);
  writeState(chatKey, { ...st, pending: kept.length, dropped: st.dropped + overflow });
  return { added: items.length, dropped: overflow };
}

/** 取某成员的候选（按时间正序，最多 limit 条）。 */
export function candidatesFor(chatKey, userId, limit = 20) {
  const uid = String(userId || '');
  return readCandidates(chatKey)
    .filter((c) => String(c.userId || '') === uid)
    .slice(0, Math.max(1, limit));
}

/** 合并成功后按 id 删除已消费的候选；失败时不要调用。 */
export function consumeCandidates(chatKey, ids) {
  const set = new Set((ids || []).map(String));
  if (!set.size) return 0;
  const all = readCandidates(chatKey);
  const kept = all.filter((c) => !set.has(String(c.id)));
  const removed = all.length - kept.length;
  if (!removed) return 0;
  writeAll(chatKey, kept);
  const st = readState(chatKey);
  writeState(chatKey, { ...st, pending: kept.length });
  return removed;
}

export function pendingCount(chatKey) {
  return readCandidates(chatKey).length;
}

/**
 * 判断这一轮要不要提炼（纯函数，便于测试）。
 *
 * 触发条件（二选一）：
 *   count —— 未处理增量总数 ≥ everyMessages（正常节奏）
 *   idle  —— 还有没合并的候选，且距上次提炼 ≥ idleMinutes（收尾，避免攒着不落盘）
 *
 * 返回每个成员待处理的增量消息（已按 minMsgsPerMember 过滤、按量排序、按
 * maxMembersPerRun 截断）。水位按成员独立推进，被截断的成员下轮继续，不会漏。
 */
export function planRefine(messages, state, cfg, now = Date.now()) {
  const list = Array.isArray(messages) ? messages : [];
  const members = state?.members || {};
  const byUser = new Map();
  for (const m of list) {
    if (!m || m.self) continue;
    const uid = String(m.senderId || '').trim();
    if (!uid) continue;
    const id = Number(m.id) || 0;
    const since = Number(members[uid]) || 0;
    if (id <= since) continue;
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push(m);
  }

  const total = [...byUser.values()].reduce((n, arr) => n + arr.length, 0);
  const pending = Number(state?.pending) || 0;
  const idleDue = pending > 0 && cfg.idleMinutes > 0
    && now - (Number(state?.lastAt) || 0) >= cfg.idleMinutes * 60000;

  let reason = '';
  if (total >= cfg.everyMessages) reason = 'count';
  else if (idleDue) reason = 'idle';
  if (!reason) return { run: false, reason: 'none', total, groups: [] };

  const groups = [...byUser.entries()]
    .filter(([, arr]) => arr.length >= cfg.minMsgsPerMember)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, cfg.maxMembersPerRun)
    .map(([userId, arr]) => ({
      userId,
      // 只取最近 maxMsgsPerMember 条；水位推进到这批的最大 id
      messages: arr.slice(-cfg.maxMsgsPerMember),
      maxId: arr.reduce((mx, m) => Math.max(mx, Number(m.id) || 0), 0),
      name: String(arr[arr.length - 1]?.senderName || '').trim()
    }));

  if (!groups.length) return { run: false, reason: 'none', total, groups: [] };
  return { run: true, reason, total, groups };
}

/** 推进一批成员的水位（只在提炼成功写入候选后调用）。 */
export function advanceWatermarks(chatKey, entries) {
  const st = readState(chatKey);
  const members = { ...st.members };
  for (const e of entries || []) {
    const uid = String(e.userId || '');
    const id = Number(e.maxId) || 0;
    if (!uid || id <= 0) continue;
    members[uid] = Math.max(Number(members[uid]) || 0, id);
  }
  writeState(chatKey, { ...st, members, lastAt: Date.now(), pending: pendingCount(chatKey) });
}

/** 提炼用的提示词（可在设置里覆盖，方便调试）。 */
export function buildRefinePrompt({ name, userId, messages, cfg }) {
  const body = messages
    .map((m) => String(m.text || '').replace(/\s+/g, ' ').slice(0, 180))
    .filter(Boolean)
    .join('\n');
  const system = cfg.prompt || [
    '你是聊天机器人的预记录模块，负责在长对话被截断前先把"以后用得上"的信息固化下来。',
    '只输出严格 JSON：{"facts":["…"]}，不要 Markdown，不要解释。',
    '只记稳定特征与明确事实（身份、长期偏好、雷点、正在做的事），不记一次性闲聊、不脑补。',
    '每条不超过 60 字，最多 3 条；没有值得记的就输出 {"facts":[]}。'
  ].join('\n');
  const user = [
    `群友：${name || '(无昵称)'}（QQ ${userId}）`,
    '以下是这段时间的发言，请提炼：',
    body || '（没有内容）'
  ].join('\n');
  return { system, user };
}

/**
 * 整理时选素材来源（A 方案，避免同一段消息被 pre-save 和整理各处理一次）：
 *   新建 + 有候选 → 只用候选（原文仅取几条校准语气）
 *   其余          → 读原文（增量取样；pre-save 关闭/老数据时行为不变）
 */
export function chooseSource({ isNew, candidateCount }) {
  const candidateOnly = isNew === true && Number(candidateCount) > 0;
  return { candidateOnly, mode: candidateOnly ? 'candidates' : 'messages' };
}
