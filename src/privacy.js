// QQ Agent（fork）侧的隐私过滤器 —— 与 dsh-qq 插件的 privacy.js 同源同规则。
//
// 为什么这里也做一层：fork 是所有 DSH 内容落到 QQ 的**唯一咽喉**
// （/api/inbound 主动推送 + 桥回传的回复都经 sender 出去），而且改这里只要重启
// QQ Agent（约 6 秒），不必重启 DSH；插件侧那层则能在模型面前直接报错，两层互为兜底。
//
//
// 目标：DSH 的内容送往**非白名单会话**时，不得携带隐私信息。
//   · 白名单会话（默认 private:85946573）—— 原样放行，一个字都不动。
//   · 其他会话（所有群、其他私聊）—— 命中即处理：
//       block 级（密钥/口令/连接串这类高置信秘密）→ **整条拒发**（fail-closed，不给模型"改一改"的余地）
//       redact 级（邮箱/手机/身份证/卡号/本机用户名·主机名/用户目录路径/IP）→ 就地打码
//     打码后如果什么都不剩，等同于拒发。
//
// 不 import 任何 DSH 包：跟 index.js 一样，插件装进 profile 后那些包不一定解析得到。

import { readFileSync, statSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { extname } from 'node:path';
import { getConfig } from './config.js';
import { logger } from './logger.js';

/** 打码占位符可以改，但别改成会让下游误以为是正常内容的样子。 */
const MASK = '[已隐去]';

/**
 * 内置规则。顺序有讲究：block 级放前面，先判死再打码。
 * re 一律带 g，因为要在同一段文本里替换所有出现。
 */
const BUILTIN_RULES = [
  // ── block 级：高置信秘密，绝不外发 ────────────────────────────────────
  { id: 'private-key', action: 'block', re: /-----BEGIN[^-]{0,40}PRIVATE KEY-----/g },
  { id: 'openai-key', action: 'block', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { id: 'anthropic-key', action: 'block', re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { id: 'github-token', action: 'block', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { id: 'google-key', action: 'block', re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { id: 'aws-key', action: 'block', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'slack-token', action: 'block', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'jwt', action: 'block', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  // password / token 赋值：等号或冒号后面跟了实际值
  { id: 'secret-assignment', action: 'block', re: /(?:\b(?:api[_-]?key|apikey|access[_-]?key|secret|client[_-]?secret|token|password|passwd|pwd)\b|密码|口令|密钥)\s*[:=：]\s*["']?[^\s"',;]{6,}/gi },
  // 带凭据的连接串
  { id: 'conn-string', action: 'block', re: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp|mssql):\/\/[^\s]+/gi },

  // ── redact 级：打码后照发 ─────────────────────────────────────────────
  { id: 'email', action: 'redact', re: /[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/g, replace: '[已隐去:邮箱]' },
  { id: 'cn-id-card', action: 'redact', re: /(?<!\d)\d{17}[\dXx](?!\d)/g, replace: '[已隐去:证件号]' },
  { id: 'bank-card', action: 'redact', re: /(?<!\d)\d{16,19}(?!\d)/g, replace: '[已隐去:卡号]' },
  { id: 'cn-mobile', action: 'redact', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g, replace: '[已隐去:手机号]' },
  { id: 'win-user-path', action: 'redact', re: /[A-Za-z]:\\Users\\[^\\\s"']+/g, replace: 'C:\\Users\\***' },
  { id: 'win-home-path', action: 'redact', re: /[A-Za-z]:\\Documents and Settings\\[^\\\s"']+/g, replace: 'C:\\Users\\***' },
  { id: 'unc-host', action: 'redact', re: /\\\\[A-Za-z0-9._-]+\\/g, replace: '\\\\***\\' },
  { id: 'ipv4', action: 'redact', re: /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g, replace: '[已隐去:IP]' }
];

/** 文本类扩展名：允许扫描文件内容找秘密（只判 block，不改写文件）。 */
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.log', '.ini', '.yml', '.yaml',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.ps1', '.psm1', '.sh', '.bat', '.cmd',
  '.xml', '.html', '.htm', '.css', '.sql', '.env', '.conf', '.cfg', '.toml', '.properties', '.pem', '.key'
]);

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 把配置里的 `85946573` / `private:85946573` 统一成 chatKey 形状。 */
export function normalizeChatKey(entry) {
  const raw = String(entry ?? '').trim();
  if (!raw) return '';
  if (/^(group|private):/.test(raw)) return raw;
  if (/^\d+$/.test(raw)) return `private:${raw}`;   // 裸 QQ 号按私聊算（最保守的解读）
  return raw;
}

export function createPrivacyFilter(options = {}) {
  const enabled = options.enabled !== false;
  const mode = options.mode === 'block' ? 'block' : 'redact';
  const blockOnSecrets = options.blockOnSecrets !== false;
  const noticeSuffix = options.noticeSuffix === true;
  const logMatches = options.logMatches !== false;
  // 命中留痕走调用方给的 logger —— 插件侧是它自己的 log()（带 [dsh-qq] 前缀），
  // QQ Agent 侧是 logger.info('privacy', …)（能落到 data/logs 里）。
  // 默认 console.log 只适合前台调试：Electron 主进程脱离控制台启动时 stdout 是丢的。
  const logLine = typeof options.logger === 'function' ? options.logger : (msg) => console.log(msg);
  const scanFileContents = options.scanFileContents !== false;
  const maxScanBytes = Math.max(0, Number(options.maxScanBytes) || 2 * 1024 * 1024);
  const allowed = new Set(
    (Array.isArray(options.allowedChats) ? options.allowedChats : ['private:85946573'])
      .map(normalizeChatKey)
      .filter(Boolean)
  );

  // 本机身份字面量（用户名 / 主机名 / 家目录）也属于隐私：出现即打码。
  const literals = [];
  for (const value of [userInfo().username, hostname(), homedir()]) {
    const text = String(value ?? '').trim();
    if (text.length >= 3) literals.push(text);
  }
  const literalRule = literals.length
    ? { id: 'local-identity', action: 'redact', re: new RegExp(literals.map(escapeRegExp).join('|'), 'gi'), replace: MASK }
    : null;

  // 配置里额外给的规则：[{ id, regex, action, replace }]；regex 是字符串，flags 默认 g
  const extraRules = [];
  for (const item of Array.isArray(options.extraPatterns) ? options.extraPatterns : []) {
    try {
      if (!item || !item.regex) continue;
      extraRules.push({
        id: String(item.id || `extra-${extraRules.length + 1}`),
        action: item.action === 'block' ? 'block' : 'redact',
        re: new RegExp(String(item.regex), String(item.flags || 'g')),
        replace: String(item.replace ?? MASK)
      });
    } catch {
      // 配错了就跳过这条，别把整个插件带崩
    }
  }

  const rules = [...extraRules, ...BUILTIN_RULES, ...(literalRule ? [literalRule] : [])];

  function scan(text) {
    const source = String(text ?? '');
    const hits = [];
    let out = source;
    let blockedBy = null;
    for (const rule of rules) {
      rule.re.lastIndex = 0;
      if (!rule.re.test(out)) continue;
      const count = (out.match(rule.re) || []).length;
      rule.re.lastIndex = 0;
      hits.push({ id: rule.id, action: rule.action, count });
      // 拒发级规则：默认（blockOnSecrets 或 mode=block）直接判死；
      // 把"密钥类拒发"关掉时**降级成打码**，而不是既不判死也不打码（那会让这个开关变成死开关）。
      const hardBlock = rule.action === 'block' && (blockOnSecrets || mode === 'block');
      if (hardBlock) {
        if (!blockedBy) blockedBy = rule.id;
        continue;
      }
      out = out.replace(rule.re, rule.replace ?? MASK);
    }
    return { hits, blockedBy, redacted: out, changed: out !== source };
  }

  /**
   * 判定一条要发往 chatKey 的文本。
   * 返回 { bypass, ok, text, hits, blockedBy, emptyAfterRedact }
   */
  function filterText(chatKey, text) {
    const key = normalizeChatKey(chatKey);
    const source = String(text ?? '');
    if (!enabled) return { bypass: true, ok: true, text: source, hits: [], blockedBy: null };
    if (allowed.has(key)) return { bypass: true, ok: true, text: source, hits: [], blockedBy: null };

    const { hits, blockedBy, redacted } = scan(source);
    const mustBlock = Boolean(blockedBy) || (mode === 'block' && hits.length > 0);

    if (mustBlock) {
      if (logMatches && hits.length) {
        logLine(`拦截 → ${key}：命中 ${hits.map((h) => `${h.id}×${h.count}`).join('、')}`);
      }
      return { bypass: false, ok: false, text: '', hits, blockedBy: blockedBy || hits[0]?.id || 'mode-block' };
    }

    const trimmed = redacted.trim();
    // 打码后只剩占位符（例如整条消息就是一个邮箱/手机号）＝没有可传达的内容，拒发比发一句
    // "[已隐去]" 更合理：否则收件人只会看到一句莫名其妙的占位符。
    const withoutMasks = trimmed
      .replace(/\[已隐去[^\]]*\]/g, '')
      .replace(/[\s，。、,.;:!?！？~～\-—_（）()【】[\]"']/g, '');
    if (hits.length && (!trimmed || !withoutMasks)) {
      if (logMatches) logLine(`拦截 → ${key}：打码后无可传达内容`);
      return { bypass: false, ok: false, text: '', hits, blockedBy: 'empty-after-redact' };
    }

    if (hits.length) {
      const summary = hits.map((h) => `${h.id}×${h.count}`).join('、');
      if (logMatches) logLine(`打码 → ${key}：${summary}`);
      const suffix = noticeSuffix ? `\n${MASK} 已隐去 ${hits.reduce((n, h) => n + h.count, 0)} 处隐私信息` : '';
      return { bypass: false, ok: true, text: redacted + suffix, hits, blockedBy: null };
    }

    return { bypass: false, ok: true, text: redacted, hits: [], blockedBy: null };
  }

  /**
   * 发文件前的检查：文件名按文本规则处理；文本类文件的内容只做 block 级扫描
   * （不改写文件本身，命中就拒发 —— 避免把带密钥的配置文件发出去）。
   */
  function filterFile(chatKey, filePath) {
    const key = normalizeChatKey(chatKey);
    if (!enabled || allowed.has(key)) {
      return { bypass: true, ok: true, safeName: '', hits: [], blockedBy: null, scanned: false };
    }
    const name = String(filePath ?? '').split(/[\\/]/).pop() || '';
    const nameResult = filterText(chatKey, name);

    let scanned = false;
    let contentBlock = null;
    if (scanFileContents && filePath) {
      const ext = extname(String(filePath)).toLowerCase();
      if (TEXT_EXTENSIONS.has(ext)) {
        try {
          const size = statSync(String(filePath)).size;
          if (size <= maxScanBytes) {
            const content = readFileSync(String(filePath), 'utf8');
            scanned = true;
            const contentScan = scan(content);
            if (contentScan.blockedBy) contentBlock = contentScan.blockedBy;
          }
        } catch {
          // 读不了就不扫内容，文件名规则仍然生效
        }
      }
    }

    if (contentBlock) {
      if (logMatches) logLine(`拦截文件 → ${key}：文件内容命中 ${contentBlock}`);
      return { bypass: false, ok: false, safeName: nameResult.text, hits: nameResult.hits, blockedBy: `file-content:${contentBlock}`, scanned };
    }
    if (!nameResult.ok) {
      return { bypass: false, ok: false, safeName: nameResult.text, hits: nameResult.hits, blockedBy: nameResult.blockedBy, scanned };
    }
    return { bypass: false, ok: true, safeName: nameResult.text, hits: nameResult.hits, blockedBy: null, scanned };
  }

  return {
    enabled,
    mode,
    allowedChats: [...allowed],
    isAllowedChat: (chatKey) => allowed.has(normalizeChatKey(chatKey)),
    filterText,
    filterFile,
    /** 给状态路由/日志看的策略摘要（不含任何秘密） */
    describe: () => ({
      enabled,
      mode,
      allowedChats: [...allowed],
      blockOnSecrets,
      noticeSuffix,
      scanFileContents,
      rules: rules.map((r) => ({ id: r.id, action: r.action }))
    })
  };
}

// ── fork 侧接入 ──────────────────────────────────────────────────────────────
// 配置来自 data/config.json 的 dsh.privacy（默认值在 src/config.js）。配置一变就重建
// 过滤器，所以设置里改完立即生效，不用重启。
let cachedKey = '';
let cachedFilter = null;

export function getPrivacyFilter() {
  const cfg = (getConfig()?.dsh?.privacy) ?? {};
  const key = JSON.stringify(cfg);
  if (!cachedFilter || key !== cachedKey) {
    // 命中留痕交给 app 自己的 logger：Electron 主进程脱离控制台启动，console.log 会丢。
    cachedFilter = createPrivacyFilter({ ...cfg, logger: (msg) => logger.info('privacy', msg) });
    cachedKey = key;
  }
  return cachedFilter;
}

/** 被拦截时替换成的提示语（本身不含任何隐私内容）。 */
export function privacyBlockedReply() {
  const cfg = (getConfig()?.dsh?.privacy) ?? {};
  return String(cfg.blockedReply || '（这条内容含不宜发往该会话的隐私信息，已被隐私过滤拦截）');
}
