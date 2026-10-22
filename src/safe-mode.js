// 安全模式：写入本地存档前，把密码 / 账号 / 电话等敏感信息替换成占位符。
//
// 两档：
//   第一档 = 全部拦（内置规则，替换成 [电话号码] / [密码] / [银行卡] 这类占位符）
//   第二档 = 用户自己定（只按用户写的规则拦，替换词随便改）
//
// 设计取舍：过滤发生在**写入存档之前**（store.appendIncoming 里），所以存档里
// 只有占位符 —— 模型读到的"已读信息"、归档页、导出都是脱敏后的版本，原文不进磁盘。
import { getConfig } from './config.js';

// 第一档内置规则。顺序有讲究：长的先跑（身份证 18 位不能被"银行卡 16~19 位"先吃掉）。
const BUILTIN = [
  { name: '身份证', re: /(?<!\d)\d{17}[\dXx](?!\d)/g },
  { name: '银行卡', re: /(?<!\d)\d{16,19}(?!\d)/g },
  { name: '电话号码', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { name: '邮箱', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { name: '验证码', re: /(验证码|校验码|动态码|验证代码)\s*[:：=]?\s*\d{4,8}/g },
  { name: '密码', re: /(密码|口令|password|passwd|pwd)\s*[:：=]?\s*[^\s，,。；;、]{4,}/gi },
  { name: '账号', re: /(账号|帐号|账户|用户名|account|username)\s*[:：=]?\s*[^\s，,。；;、]{3,}/gi },
  { name: '地址', re: /(地址|住址|收货地址)\s*[:：=]?\s*[^\s，,。；;、]{6,}/g }
];

/** 自定义规则文本 → 规则数组。每行格式：名称 | 正则 | 替换词（后两个可省） */
export function parseCustomRules(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    const parts = line.split('|').map((x) => x.trim());
    const name = parts[0] || '敏感信息';
    const source = parts[1] || '';
    const replacement = parts[2] || ('[' + name + ']');
    if (!source) continue;
    try {
      new RegExp(source);                    // 先校验，非法正则不让存
      out.push({ name, source, replacement });
    } catch { /* 跳过非法规则 */ }
  }
  return out;
}

export function getSafeModeConfig() {
  const cfg = getConfig() || {};
  const sm = cfg.safeMode || {};
  return {
    enabled: sm.enabled !== false,           // 默认开
    level: Number(sm.level) === 2 ? 2 : 1,   // 默认第一档
    customText: String(sm.customText || ''),
    custom: parseCustomRules(sm.customText)
  };
}

/**
 * 脱敏一段文本。
 * @returns {{text:string, hits:string[], enabled:boolean, level:number}}
 */
export function redactText(text, { force = false } = {}) {
  const raw = String(text ?? '');
  const sm = getSafeModeConfig();
  // force：导出记忆包时用户主动要求脱敏，即使安全模式是关的也执行
  if (!raw) return { text: raw, hits: [], enabled: sm.enabled, level: sm.level };
  if (!sm.enabled && !force) return { text: raw, hits: [], enabled: sm.enabled, level: sm.level };
  const hits = [];
  let out = raw;
  const rules = sm.level === 2
    ? sm.custom.map((r) => ({ name: r.name, replacement: r.replacement, re: new RegExp(r.source, 'g') }))
    : BUILTIN.map((r) => ({ name: r.name, replacement: '[' + r.name + ']', re: r.re }));
  for (const r of rules) {
    try {
      out = out.replace(r.re, () => { hits.push(r.name); return r.replacement; });
    } catch { /* 单条规则出错不影响其它规则 */ }
  }
  return { text: out, hits, enabled: true, level: sm.level };
}

/** 存档专用入口：任何异常都退回原文，不能因为过滤把消息弄丢 */
export function redactForArchive(text) {
  try {
    return redactText(text).text;
  } catch {
    return String(text ?? '');
  }
}
