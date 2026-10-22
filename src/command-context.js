// 指令消息在提示词里的显示方式（用户可选三档）
//
//   raw    = 原文照常进上下文（默认，保持原行为）
//   hide   = 完全不让它进上下文（列表里直接不出现）
//   describe = 换成一句自动生成的功能说明，例如：
//              [系统提示] 用户发来了「/睡觉」指令，功能是：让机器人进入禁言状态（30 分钟）
//
// 只影响"送进模型的那份文本"，存档里仍然是原文（归档页/导出不受影响）。
import { getConfig } from './config.js';

/** 当前配置里已知的指令 → 功能说明（长的优先匹配） */
export function knownCommands(cfg = getConfig()) {
  const out = [];
  const cm = cfg?.commandMute || {};
  const list = Array.isArray(cm.commands) ? cm.commands : [];
  for (const c of list) {
    const cmd = String(c?.command || '').trim();
    if (!cmd) continue;
    const dur = Math.max(0, Number(c?.durationMin) || 0);
    out.push({ cmd, note: '让机器人进入禁言状态' + (dur > 0 ? `（${dur} 分钟）` : '（永久，需要解除）') });
  }
  if (!list.length && String(cm.command || '').trim()) {
    const dur = Math.max(0, Number(cm.durationMin) || 0);
    out.push({ cmd: String(cm.command).trim(), note: '让机器人进入禁言状态' + (dur > 0 ? `（${dur} 分钟）` : '（永久）') });
  }
  const rel = String(cm.releaseCommand || '').trim();
  if (rel) out.push({ cmd: rel, note: '解除禁言，恢复正常响应档位' });
  out.push({ cmd: '/dsh', note: '要求本机 DeepSeek Harness 执行一条指令' });
  return out.sort((a, b) => b.cmd.length - a.cmd.length);
}

/** 这条文本是不是已知指令 → 返回命中的指令对象（否则 null） */
export function matchCommand(text, cfg = getConfig()) {
  const t = String(text || '');
  if (!t.startsWith('/')) return null;          // 指令都以 / 开头，快速短路
  for (const c of knownCommands(cfg)) {
    if (t.includes(c.cmd)) return c;
  }
  return null;
}

/**
 * 决定这条消息进提示词时怎么显示
 * @returns {null | {hide:true} | {replace:string}}
 */
export function commandDisplay(text, cfg = getConfig()) {
  const mode = String(cfg?.commandContext?.mode || 'raw');
  if (mode !== 'hide' && mode !== 'describe') return null;
  const hit = matchCommand(text, cfg);
  if (!hit) return null;
  if (mode === 'hide') return { hide: true };
  return { replace: `[系统提示] 用户发来了「${hit.cmd}」指令，功能是：${hit.note}` };
}
