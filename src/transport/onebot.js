// OneBot v11 适配器：把现有 OneBotClient 包成统一 Transport 接口。
// P1 只做透传，不改变任何参数/返回值 —— 改造前后的行为必须完全一致。
import { Transport } from './base.js';

export class OneBotTransport extends Transport {
  constructor({ client } = {}) {
    if (!client) throw new Error('OneBotTransport 需要 OneBotClient');
    super({
      kind: 'onebot',
      capabilities: {
        readAllMessages: true,
        canProactive: true,
        canPoke: true,
        canReact: true,
        canRecallOthers: false,
        canMute: false,
        canKick: false,
        canGroupCard: true,
        markdown: false,
        media: true,
        file: true
      }
    });
    this.client = client;
  }

  async start() { return this.client.connect(); }
  async stop() { return this.client.close(); }
  onStatus(fn) { return this.client.onStatus(fn); }

  sendText(kind, id, text, opts) { return this.client.sendText(kind, id, text, opts); }
  sendImage(kind, id, ref, opts) { return this.client.sendImage(kind, id, ref, opts); }
  sendSticker(kind, id, ref, opts) { return this.client.sendSticker(kind, id, ref, opts); }
  sendSegments(kind, id, segments) { return this.client.sendSegments(kind, id, segments); }
  sendPoke(kind, id, targetUserId) { return this.client.sendPoke(kind, id, targetUserId); }

  /** 撤回：OneBot 用 delete_msg */
  recall(kind, id, messageId) { return this.client.call('delete_msg', { message_id: messageId }); }

  msgInfo(messageId) { return this.client.getMsg(messageId); }
  groupInfo(groupId) { return this.client.getGroupInfo(groupId); }
  memberInfo(groupId, userId) { return this.client.getGroupMemberInfo(groupId, userId); }

  /** 通道专有动作兜底（upload_group_file / get_image …） */
  call(action, params = {}, timeoutMs = null) { return this.client.call(action, params, timeoutMs); }
}
