// 桥的统一入口（附件化第 2 步）。
//
// 对外只暴露一个 bridges 对象；app.js 不再分别持有 /dsh 桥和附件桥。
//
// 路由顺序（与改造前保持一致）：
//   1. /dsh 主桥（群聊 @ 闸门在 dsh.requireMentionInGroup，默认要求 @）
//   2. 附件桥（/wb、/codex…；每个附件自己的 requireMentionInGroup 在 agent-bridge 内判断）
//
// 附件配置来自 dsh.attachments；为空时由 bridge-config 运行时迁移旧 agentBridges。
import { createDshBridge } from './dsh-bridge.js';
import { createAgentBridges } from './agent-bridge.js';
import { resolveAttachmentBridges } from './bridge-config.js';

export function createBridges({ getConfig, sender, log = console.log, emit = () => {} }) {
  let cfgRaw = null;
  let cfgView = null;

  /** 给 agent-bridge 的 getConfig：把解析后的附件列表塞进 agentBridges 字段。 */
  const attachmentConfig = () => {
    const raw = getConfig();
    if (raw !== cfgRaw) {
      const resolved = resolveAttachmentBridges(raw);
      cfgRaw = raw;
      cfgView = { ...raw, agentBridges: resolved.attachmentBridges };
      if (resolved.migratedFrom) {
        log(`[bridge] 附件桥配置迁移自 ${resolved.migratedFrom}（运行时，不写盘）`);
      }
    }
    return cfgView;
  };

  const dsh = createDshBridge({
    getConfig,
    sender,
    log,
    emit,
    getAttachments: () => resolveAttachmentBridges(getConfig()).attachmentBridges
  });
  const attachments = createAgentBridges({ getConfig: attachmentConfig, sender, log, emit });

  /**
   * 认领一条消息。返回 true = 已认领（调用方标已读并结束本轮）。
   * @param {string} chatKey
   * @param {object} entry 消息条目
   * @param {{ atMe?: boolean, kind?: string }} ctx 群聊 @ 判定结果
   */
  function handle(chatKey, entry, ctx = {}) {
    const cfg = getConfig();
    const dshCfg = cfg?.dsh && typeof cfg.dsh === 'object' ? cfg.dsh : {};
    const kind = String(ctx.kind || String(chatKey).split(':')[0]);
    const mentionOk = kind === 'private' || dshCfg.requireMentionInGroup === false || ctx.atMe === true;
    if (mentionOk && dsh.handle(chatKey, entry)) return true;
    return attachments.handle(chatKey, entry, { atMe: ctx.atMe === true, kind });
  }

  function abortAll() {
    try { dsh.abortAll(); } catch { /* ignore */ }
    try { attachments.abortAll(); } catch { /* ignore */ }
  }

  async function awaitIdle() {
    if (typeof attachments.awaitIdle === 'function') await attachments.awaitIdle();
  }

  return { handle, abortAll, awaitIdle, dsh, attachments, resolve: () => resolveAttachmentBridges(getConfig()) };
}
