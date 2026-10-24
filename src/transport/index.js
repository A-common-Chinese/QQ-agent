// 传输层工厂：按配置创建具体通道。
//   type: 'onebot'        —— 现在的 OneBot v11（SnowLuma / NapCat / LLOneBot 都行）
//   type: 'qqbot'         —— 官方 QQ Bot（P2 实现，尚未接入）
import { OneBotTransport } from './onebot.js';

export const TRANSPORT_KINDS = ['onebot', 'qqbot'];
export const TRANSPORT_LABELS = { onebot: 'QQ 接口（OneBot / SnowLuma）', qqbot: 'QQ 官方机器人（开放平台）' };

/**
 * @param {object} opts
 * @param {'onebot'|'qqbot'} opts.type
 * @param {object} opts.client  OneBotClient（onebot 通道必填）
 */
const CACHE = new WeakMap();

/**
 * 把现有 OneBotClient 包成 transport（同一个 client 只包一次）。
 * P1.5 用它让各组件"能拿 transport 就拿、拿不到就用 onebot 现场包"，
 * 这样改造可以逐个组件推进，不需要一次性改完 app.js。
 */
export function asTransport({ client = null, transport = null } = {}) {
  if (transport && typeof transport.sendText === 'function') return transport;
  if (!client) throw new Error('asTransport 需要 client 或 transport');
  let t = CACHE.get(client);
  if (!t) { t = new OneBotTransport({ client }); CACHE.set(client, t); }
  return t;
}

export function createTransport({ type = 'onebot', client = null, config = {} } = {}) {
  if (type === 'onebot') return new OneBotTransport({ client });
  if (type === 'qqbot') {
    throw new Error('QQ 官方机器人通道尚未实现（P2）：请先在设置里继续使用 OneBot 通道');
  }
  throw new Error(`未知的传输通道：${type}`);
}

export { Transport, DEFAULT_CAPABILITIES, UnsupportedError } from './base.js';
export { OneBotTransport } from './onebot.js';
