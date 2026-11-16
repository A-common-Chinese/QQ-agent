// Agent 桥「附件化」配置解析（第 1 步：只做接线与迁移，不改执行逻辑）。
//
// 目标结构：
//   dsh                        主桥（/dsh，headless 或 plugin）
//   dsh.attachments[]          附件桥（/wb、/codex…），共用主桥的白名单/隐私/状态策略
//
// 向后兼容：
//   · 旧 config.agentBridges[] 仍可读：dsh.attachments 为空时在运行时迁移，不写盘
//   · 附件未写的字段（allowedSenderIds / requireMentionInGroup / …）仍用自身默认值；
//     "继承主桥"留到第 2 步做，这里只保证现有行为不变
import { normalizeBridge } from './agent-bridge.js';

/**
 * 解析当前生效的附件桥列表。
 * @param {object} config 完整配置（getConfig() 的返回值）
 * @returns {{ attachmentBridges: object[], migratedFrom: string|null, dshPrefix: string }}
 */
export function resolveAttachmentBridges(config = {}) {
  const cfg = config && typeof config === 'object' ? config : {};
  const dsh = cfg.dsh && typeof cfg.dsh === 'object' ? cfg.dsh : {};
  const explicit = Array.isArray(dsh.attachments) ? dsh.attachments : [];
  const legacy = Array.isArray(cfg.agentBridges) ? cfg.agentBridges : [];
  const useExplicit = explicit.length > 0;
  const source = useExplicit ? explicit : legacy;
  const migratedFrom = useExplicit ? null : (legacy.length ? 'agentBridges' : null);
  const dshPrefix = String(dsh.prefix || '/dsh').trim() || '/dsh';

  const seen = new Map([[dshPrefix.toLowerCase(), 'dsh 主桥']]);
  const list = [];
  for (let i = 0; i < source.length; i += 1) {
    const raw = source[i];
    const b = normalizeBridge(raw, i);
    let disabledReason = '';
    const prefix = String(b.prefix || '');
    if (!prefix.startsWith('/')) {
      disabledReason = '前缀必须以 / 开头';
    } else if (seen.has(prefix.toLowerCase())) {
      disabledReason = `前缀 ${prefix} 与「${seen.get(prefix.toLowerCase())}」冲突`;
    }
    if (!disabledReason) seen.set(prefix.toLowerCase(), b.label || b.id);
    list.push({
      ...b,
      // 冲突时即使配了 enabled 也不生效，但保留原值方便 UI 显示
      enabled: b.enabled === true && !disabledReason,
      disabledReason,
      source: useExplicit ? 'dsh.attachments' : 'agentBridges'
    });
  }
  return { attachmentBridges: list, migratedFrom, dshPrefix };
}

/** 只返回启用的附件（agent-bridge 执行时用）。 */
export function enabledAttachmentBridges(config = {}) {
  return resolveAttachmentBridges(config).attachmentBridges.filter((b) => b.enabled);
}
