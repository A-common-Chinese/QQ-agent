// 传输层统一接口（P1：只抽接口与 OneBot 适配器，行为与改造前一致）
//
// 为什么要有这一层：现在所有 QQ 能力都直连 OneBot（HTTP/WS）。官方 QQ Bot 是另一套
// 协议（AppID/Secret → AccessToken → WS 网关 + HTTP API，openid/msg_id/msg_seq），
// 两者在"收消息 / 发消息 / 撤回 / 拍一拍 / 群成员"上语义相近但字段不同。
//
// 抽象方式：
//   · 事件：适配器把各自协议**归一化**成 { type: 'message' | 'notice' | 'status' } 再交给上层
//   · 动作：上层只调 transport.sendText / sendImage / recall / poke ...，不关心是哪套协议
//   · 能力：transport.capabilities 声明"这套协议能不能做到"，UI 与提示词据此降级
//
// ⚠️ P1 阶段：只有 onebot 适配器，且 SendQueue 已改为走 transport；行为与之前完全一致。

/** 统一能力位。false 表示该通道做不到，上层要降级（禁用工具/改提示词/灰掉入口）。 */
export const DEFAULT_CAPABILITIES = Object.freeze({
  readAllMessages: true,   // 能否收到群里所有消息（官方需群主授权"全量模式"）
  canProactive: true,      // 能否主动发言（官方需群主授权"主动推送"）
  canPoke: true,           // 拍一拍
  canReact: true,          // 贴表情回应
  canRecallOthers: false,  // 撤回他人消息（需要管理员）
  canMute: false,          // 禁言
  canKick: false,          // 踢人
  canGroupCard: false,     // 改群名片 / 改资料
  markdown: false,         // 富文本（官方 Markdown）
  media: true,             // 图片/语音/视频
  file: true               // 文件上传
});

/** 通道能力不足时统一抛这个错，上层可以据此给模型/用户一句人话。 */
export class UnsupportedError extends Error {
  constructor(capability, detail = '') {
    super(`当前通道不支持该能力（${capability}）${detail ? '：' + detail : ''}`);
    this.name = 'UnsupportedError';
    this.capability = capability;
  }
}

/**
 * 传输层基类：子类实现自己的协议，但对外只暴露这套方法。
 * 具体方法签名见 src/transport/onebot.js 的实现（等价契约）。
 */
export class Transport {
  constructor({ kind = 'unknown', capabilities = {} } = {}) {
    this.kind = kind;
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...capabilities };
  }

  /** 是否有某能力 */
  can(name) { return this.capabilities[name] === true; }

  // ── 身份 / 状态（子类覆盖；默认空值，避免上层到处判空） ──
  get selfId() { return ''; }
  get selfNickname() { return ''; }
  get connected() { return false; }

  /** 开 / 关连接 */
  async start() { /* 子类实现 */ }
  async stop() { /* 子类实现 */ }

  /** 状态回调（连接/断开/重连） */
  onStatus() { /* 子类实现 */ }

  // ── 动作：子类必须实现 ──
  async sendText() { throw new UnsupportedError('sendText'); }
  async sendImage() { throw new UnsupportedError('sendImage'); }
  async sendSticker() { throw new UnsupportedError('sendSticker'); }
  async sendSegments() { throw new UnsupportedError('sendSegments'); }
  async sendPoke() { throw new UnsupportedError('canPoke'); }
  async recall() { throw new UnsupportedError('recall'); }
  async memberInfo() { throw new UnsupportedError('memberInfo'); }
  async groupInfo() { throw new UnsupportedError('groupInfo'); }
  async msgInfo() { throw new UnsupportedError('msgInfo'); }
  /** 兜底：通道专有动作（例如 OneBot 的 upload_group_file） */
  async call() { throw new UnsupportedError('call'); }
}
