// 静默会话里被 @ 时的处理（两档，可开关）
//
// 背景：静默会话（store.silentChats）本来只存档、不调模型（0 token）。
// 但有人 @ 机器人时，可能是"帮我转发这个"这类请求 —— 静默把这种请求吃掉不合适。
//
// 两档：
//   档 1 = 调一次最小 API 判断：只发这一条消息 + 一句分类指令（不带人设/历史/记忆），
//          判定"是要求转发"→ 允许这一轮走正常流程（含 send_to 与转发白名单校验）；
//          不是 → 回用户指定的固定话术。
//   档 2 = 完全不调 API，任何 @ 都回固定话术。
import { getConfig, isSilentChat } from './config.js';
import { chatCompletion } from './llm.js';

const DEFAULT_REPLY = '（这个群我暂时不说话，有事私聊我）';

const CLASSIFY_SYSTEM = [
  '你是消息分类器。只输出一个词：「是」或「否」。',
  '判断用户这句话是不是在要求把某段内容 / 聊天记录 / 消息转发到另一个群或私聊。',
  '例：帮我转到X群、把这个发到Y、转告Z —— 是。',
  '例：@机器人打招呼、闲聊、提问、骂人 —— 否。'
].join('\n');

export function getSilentAtConfig() {
  const sa = getConfig()?.silentAt || {};
  return {
    enabled: sa.enabled === true,
    mode: Number(sa.mode) === 2 ? 2 : 1,
    replyText: String(sa.replyText || DEFAULT_REPLY)
  };
}

/** 这条消息是不是在 @ 机器人（atMe 为 null 的老存档退化成"文本含 @ + 机器人名"） */
function isAtMessage(entry, cfg) {
  if (!entry) return false;
  if (entry.atMe === true) return true;
  if (entry.atMe === false) return false;
  const text = String(entry.text || '');
  const botName = String(cfg?.persona?.botName || '');
  if (!text) return false;
  if (botName && text.includes('@' + botName)) return true;
  return false;
}

/** 最小上下文分类：只发这一条消息，不带人设/历史 */
export async function isForwardRequest(text, log = () => {}) {
  const t = String(text || '').trim();
  if (!t) return false;
  try {
    const r = await chatCompletion({
      messages: [
        { role: 'system', content: CLASSIFY_SYSTEM },
        { role: 'user', content: t.slice(0, 500) }
      ],
      tools: null,
      temperature: 0
    });
    const out = String(r?.message?.content ?? r?.content ?? '').trim();
    log('[silent-at] 分类输出：' + out.slice(0, 40));
    return /^(是|yes|true|y)/i.test(out);
  } catch (error) {
    // 判不了就当"不是"→ 回固定话术，绝不擅自转发
    log('[silent-at] 分类失败：' + (error?.message ?? error));
    return false;
  }
}

async function sendFixedReply(orchestrator, chatKey, text) {
  const msg = String(text || '').trim();
  if (!msg) return;
  await orchestrator.sender.sendTextBatch(chatKey, [msg], {});
}

/**
 * 静默会话被 @ 时的入口（fire-and-forget，不阻塞 ingest）
 * @returns {{ok:boolean, skipped?:string, mode?:number, replied?:boolean, forward?:boolean}}
 */
export async function maybeSilentAt({ chatKey, entry, orchestrator, log = console.log }) {
  try {
    const sa = getSilentAtConfig();
    if (!sa.enabled) return { ok: false, skipped: 'disabled' };
    if (!isSilentChat(chatKey)) return { ok: false, skipped: 'not-silent' };
    const cfg = getConfig();
    if (!String(cfg?.api?.model || '').trim()) return { ok: false, skipped: 'no-model' };
    if (!isAtMessage(entry, cfg)) return { ok: false, skipped: 'not-at' };

    // 档 2：完全不调 API
    if (sa.mode === 2) {
      await sendFixedReply(orchestrator, chatKey, sa.replyText);
      log('[silent-at] 静默会话被 @（档2）→ 已回固定话术');
      return { ok: true, mode: 2, replied: true };
    }

    // 档 1：最小上下文问一次
    const yes = await isForwardRequest(entry?.text || '', log);
    if (yes) {
      // 允许这一轮突破静默：走正常流程（模型可用 send_to，转发白名单照样校验）
      orchestrator.scheduleWake(chatKey, 0, { bypassSilent: true });
      log('[silent-at] 静默会话被 @（档1）→ 判定为转发请求，放行本轮');
      return { ok: true, mode: 1, forward: true };
    }
    await sendFixedReply(orchestrator, chatKey, sa.replyText);
    log('[silent-at] 静默会话被 @（档1）→ 不是转发请求，已回固定话术');
    return { ok: true, mode: 1, replied: true };
  } catch (error) {
    log('[silent-at] 处理失败：' + (error?.message ?? error));
    return { ok: false, error: String(error?.message ?? error) };
  }
}
