/**
 * QQ 官方机器人适配器（P2 骨架）
 *
 * 与 OneBot 的差异（详见 doc/qqbot-feasibility-2026-10.md）：
 *   · 鉴权：AppID + AppSecret → AccessToken（2h，需缓存/刷新）
 *   · 地址：api.bot.qq.com；WS 网关先 GET /gateway/bot 拿 url
 *   · 会话：group_openid / user_openid（不是群号/QQ 号）
 *   · 回复：被动消息必须带 msg_id，且同一 msg_id 的 msg_seq 要递增
 *   · 事件：GROUP_AT_MESSAGE_CREATE / GROUP_MESSAGE_CREATE（全量，需群主授权）/ C2C_MESSAGE_CREATE
 *
 * 说明：本版先落"鉴权 + 发消息 + 撤回 + 事件归一化"，WS 网关含心跳/resume 骨架；
 * 真实联调要等部署者填入自己机器人的 AppID/AppSecret（绝不写死在代码里）。
 */
import WebSocket from 'ws';
import { Transport } from './base.js';

const API = 'https://api.bot.qq.com';
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const INTENT_GROUP_AND_C2C = 1 << 25;

export function toChatKey(kind, id) { return `qqbot:${kind}:${id}`; }

export function parseChatKey(chatKey) {
  const s = String(chatKey || '');
  const m = /^qqbot:(group|private):(.+)$/.exec(s);
  return m ? { kind: m[1], id: m[2] } : null;
}

export class QqBotTransport extends Transport {
  constructor({ account = {}, intents = 0, fetchImpl = null, WebSocketImpl = null, log = () => {} } = {}) {
    const mode = String(account.groupMode || 'all').toLowerCase();
    super({
      kind: 'qqbot',
      capabilities: {
        readAllMessages: mode !== 'at',   // 全量模式需群主在手机 QQ 里授权
        canProactive: true,
        canPoke: false,                   // 官方无拍一拍接口
        canReact: false,
        canRecallOthers: false,
        canMute: false,
        canKick: false,
        canGroupCard: false,
        markdown: true,
        media: true,
        file: true
      }
    });
    this.account = account;
    this.intents = Number(intents) || INTENT_GROUP_AND_C2C;
    this._fetch = fetchImpl || globalThis.fetch;
    this._WS = WebSocketImpl || WebSocket;
    this._log = log;
    this._token = '';
    this._tokenExp = 0;
    this._seq = new Map();      // msg_id -> msg_seq
    this._statusFns = [];
    this._messageFns = [];
    this._ws = null;
    this._heartbeat = null;
    this._lastSeq = 0;
  }

  get selfId() { return this.account?.botId || ''; }
  get selfNickname() { return this.account?.name || ''; }
  get connected() { return !!this._ws && this._ws.readyState === 1; }

  onStatus(fn) { if (typeof fn === 'function') this._statusFns.push(fn); }
  onMessage(fn) { if (typeof fn === 'function') this._messageFns.push(fn); }
  _emitStatus(patch) { for (const fn of this._statusFns) { try { fn(patch); } catch { /* 忽略 */ } } }
  _emitMessage(evt) { for (const fn of this._messageFns) { try { fn(evt); } catch { /* 忽略 */ } } }

  /** 取 AccessToken（缓存到过期前 60 秒） */
  async token() {
    const now = Date.now();
    if (this._token && now < this._tokenExp - 60000) return this._token;
    const appId = String(this.account.appId || '').trim();
    const secret = String(this.account.appSecret || '').trim();
    if (!appId || !secret) throw new Error('QQ 机器人未配置 AppID / AppSecret');
    const r = await this._fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret: secret })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error(`获取 AccessToken 失败（HTTP ${r.status}）：${j.message || j.error || '未知错误'}`);
    this._token = String(j.access_token);
    this._tokenExp = now + (Number(j.expires_in) || 7200) * 1000;
    return this._token;
  }

  async _api(method, path, body = null) {
    const token = await this.token();
    const res = await this._fetch(API + path, {
      method,
      headers: { authorization: `QQBot ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* 非 JSON */ }
    if (!res.ok) throw new Error(`QQ 机器人接口失败（HTTP ${res.status}）：${(data && (data.message || data.error)) || text.slice(0, 200)}`);
    return data || {};
  }

  /** 发消息：kind = group | private，id = group_openid / user_openid */
  async sendText(kind, id, text, { replyToMessageId = null } = {}) {
    const content = String(text ?? '');
    if (!content) return {};
    const msgId = replyToMessageId ? String(replyToMessageId) : '';
    const seq = msgId ? (this._seq.get(msgId) || 0) + 1 : 0;
    if (msgId) this._seq.set(msgId, seq);
    const body = { content, msg_type: 0 };
    if (msgId) { body.msg_id = msgId; body.msg_seq = seq; }
    const path = kind === 'group' ? `/v2/groups/${encodeURIComponent(id)}/messages` : `/v2/users/${encodeURIComponent(id)}/messages`;
    return this._api('POST', path, body);
  }

  async recall(kind, id, messageId) {
    const path = kind === 'group'
      ? `/v2/groups/${encodeURIComponent(id)}/messages/${encodeURIComponent(String(messageId))}`
      : `/v2/users/${encodeURIComponent(id)}/messages/${encodeURIComponent(String(messageId))}`;
    return this._api('DELETE', path);
  }

  // 官方通道暂不支持：拍一拍 / 表情回应 / 群名片
  async sendPoke() { throw new (await import('./base.js')).UnsupportedError('canPoke', '官方机器人没有拍一拍接口'); }

  /** 事件归一化：内部统一成 OneBot 类似形状，上层不用改 */
  normalizeEvent(t, d) {
    const author = d?.author || {};
    const group = t === 'GROUP_AT_MESSAGE_CREATE' || t === 'GROUP_MESSAGE_CREATE';
    const kind = group ? 'group' : 'private';
    const id = group ? String(d.group_openid || '') : String(author.user_openid || author.id || '');
    const chatKey = toChatKey(kind, id);
    return {
      type: 'message',
      kind,
      chatId: id,
      chatKey,
      messageId: String(d.id || ''),
      userId: String(author.member_openid || author.user_openid || author.id || ''),
      nickname: String(author.username || ''),
      role: String(author.member_role || ''),
      text: String(d.content || ''),
      mentions: Array.isArray(d.mentions) ? d.mentions : [],
      atMe: t === 'GROUP_AT_MESSAGE_CREATE',
      timestamp: d.timestamp || '',
      raw: d
    };
  }

  /** 连 WS 网关（骨架：identify + 心跳 + resume） */
  async start() {
    const gw = await this._api('GET', '/gateway/bot');
    const url = gw?.url;
    if (!url) throw new Error('没有拿到 WS 网关地址');
    await new Promise((resolve, reject) => {
      const ws = new this._WS(url);
      this._ws = ws;
      const token = this._token;
      ws.on('open', () => {
        ws.send(JSON.stringify({ op: 2, d: { token: `QQBot ${token}`, intents: this.intents, shard: [0, 1], properties: {} } }));
        this._emitStatus({ connected: true });
        resolve();
      });
      ws.on('message', (buf) => {
        let pkt = null;
        try { pkt = JSON.parse(String(buf)); } catch { return; }
        if (pkt.s) this._lastSeq = pkt.s;
        if (pkt.op === 10) {
          const interval = Number(pkt.d?.heartbeat_interval) || 30000;
          clearInterval(this._heartbeat);
          this._heartbeat = setInterval(() => {
            try { ws.send(JSON.stringify({ op: 1, d: this._lastSeq })); } catch { /* 忽略 */ }
          }, interval);
          this._heartbeat.unref?.();
          return;
        }
        if (pkt.op === 0 && pkt.t) {
          if (pkt.t === 'GROUP_AT_MESSAGE_CREATE' || pkt.t === 'GROUP_MESSAGE_CREATE' || pkt.t === 'C2C_MESSAGE_CREATE') {
            this._emitMessage(this.normalizeEvent(pkt.t, pkt.d));
          }
        }
      });
      ws.on('error', (e) => { this._emitStatus({ connected: false, error: String(e?.message || e) }); reject(e); });
      ws.on('close', () => { clearInterval(this._heartbeat); this._emitStatus({ connected: false }); });
    });
  }

  async stop() {
    clearInterval(this._heartbeat);
    try { this._ws?.close(); } catch { /* 忽略 */ }
    this._ws = null;
  }
}
