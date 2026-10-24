/**
 * DSH 远程执行（dsh-agent）—— QQ 侧模型的工具，配套 dsh-qq 插件。
 *
 * 作用：让模型能主动"在本机跑一件事"（读日志、跑测试、整理文件…），
 *      而不是只有用户手动发 `/dsh <指令>` 才能触发。
 *
 * 安全默认（全部为"关/最保守"）：
 *   · 开关 = 技能页里的"启用/禁用"（禁用后工具直接从模型列表消失，不用另一层开关）
 *   · scope=whitelist     只在 bot 本来就会回话的会话里可用（非白名单消息不会进模型）
 *   · permissionMode=read-only   默认只读，写操作必须用户显式改设置
 *   · maxPerHour=3        每会话每小时最多 3 次
 *   · timeoutSec=25       单次最多等 25s，超时如实告诉模型"可能还在跑"
 *
 * 与 /dsh 命令的关系：命令走 dsh-bridge（确定性、不花模型 token）；
 * 本技能是"模型自己判断要不要调"，两条通道并存、互不影响。
 */
const DEFAULTS = {
  scope: 'whitelist',
  permissionMode: 'read-only',
  maxPerHour: 3,
  timeoutSec: 25,
  bridgeUrl: 'http://127.0.0.1:19387/__dsh-qq/message',
  bridgeToken: ''
};

const WINDOW_MS = 60 * 60 * 1000;
const calls = new Map(); // chatKey -> number[]（最近一小时的调用时间戳）

function pickNum(v, fallback, min, max) {
  const n = Number(v);
  const base = Number.isFinite(n) ? n : fallback;
  return Math.min(max, Math.max(min, base));
}

function recent(chatKey) {
  const now = Date.now();
  const arr = (calls.get(chatKey) || []).filter((t) => now - t < WINDOW_MS);
  calls.set(chatKey, arr);
  return arr;
}

export function setup(api) {
  const cfgOf = () => ({ ...DEFAULTS, ...(api.config() || {}) });

  api.registerTool({
    id: 'dsh_task',
    name: 'DSH 远程执行',
    description: [
      '在本机 DeepSeek Harness 上执行一个任务（读文件/查日志/跑命令/改代码等），返回结果摘要。',
      '只在用户明确要求"在这台电脑上做某事"时调用；闲聊、查资料、算数不要用它。',
      '任务描述要写清目标、路径、验收标准；一次只做一件事。'
    ].join(''),
    category: 'system',   // 工具分类（技能分类仍为 utility，两套命名空间不同）
    icon: '🖥️',
    defaultEnabled: true,
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '要交给本机 DSH 执行的任务，含目标/路径/验收标准' },
        wait_seconds: { type: 'number', description: '最多等待多少秒（默认 25，最大 120）' }
      },
      required: ['task'],
      additionalProperties: false
    },
    execute: async (ctx, args) => {
      const cfg = cfgOf();
      const scope = String(cfg.scope || 'whitelist');
      if (scope === 'private' && ctx.kind !== 'private') {
        return { content: '（该技能只允许在私聊里使用）', isError: true };
      }
      // 官方版的工具上下文不一定有 proactive：undefined 时不拦（档位退化为不限制），
      // 明确 true（模型主动开话题/补话）或 mentioned===false 才判定为“没被叫到”。
      const proactive = ctx.proactive === true || (ctx.proactive === undefined && ctx.mentioned === false);
      if (scope === 'mention' && proactive) {
        return { content: '（该技能只允许在被点名时使用）', isError: true };
      }
      const chatKey = String(ctx.chatKey || (ctx.kind && ctx.chatId ? `${ctx.kind}:${ctx.chatId}` : 'unknown'));
      const task = String(args?.task ?? '').trim();
      if (!task) return { content: '任务为空：请提供 task', isError: true };

      const limit = pickNum(cfg.maxPerHour, 3, 0, 999);
      const used = recent(chatKey);
      if (limit > 0 && used.length >= limit) {
        return { content: `（本会话这一小时已调用 ${used.length} 次，达到上限 ${limit}；稍后再试或让用户改设置）`, isError: true };
      }
      used.push(Date.now());

      const waitSec = pickNum(args?.wait_seconds, pickNum(cfg.timeoutSec, 25, 5, 120), 5, 120);
      const url = String(cfg.bridgeUrl || DEFAULTS.bridgeUrl);
      const token = String(cfg.bridgeToken || '');
      const headers = { 'content-type': 'application/json' };
      if (token) headers['x-dsh-qq-token'] = token;

      // 交给 DSH 的文本加一层"你是谁、要什么"的包装，避免它把这句当成聊天
      const text = [
        '【来自 QQ 群的工具调用】你不是在跟人聊天，而是被执行端调用。',
        '完成任务后，用不超过 800 字回复：做了什么、结果/关键输出、失败原因（如果有）。',
        '',
        '任务：',
        task
      ].join('\n');

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), waitSec * 1000);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            chatKey,
            text,
            permissionPreset: String(cfg.permissionMode || '').trim()
          }),
          signal: ctrl.signal
        });
        const raw = await res.text();
        let data = null;
        try { data = JSON.parse(raw); } catch { /* 非 JSON 就按文本处理 */ }
        if (!res.ok || !data || data.ok === false) {
          const detail = String((data && data.error) || raw || '').slice(0, 400);
          api.log(`[dsh-agent] ❌ ${chatKey} HTTP ${res.status} ${detail}`);
          return { content: `DSH 调用失败（HTTP ${res.status}）：${detail}`, isError: true };
        }
        const reply = String(data.reply || '').trim();
        api.log(`[dsh-agent] ✅ ${chatKey} ${data.elapsedMs ?? '?'}ms · 第 ${data.turns ?? '?'} 轮 · 权限=${cfg.permissionMode}`);
        if (!reply) return { content: '（DSH 执行完了，但没有返回文本；可能需要看它自己的日志）' };
        return { content: reply.slice(0, 1200) };
      } catch (error) {
        if (error && error.name === 'AbortError') {
          api.log(`[dsh-agent] ⏱ ${chatKey} 等待 ${waitSec}s 超时（任务可能仍在后台执行）`);
          return { content: `DSH 还没跑完（超过 ${waitSec} 秒）。任务可能仍在后台执行，过一会儿可以再问它结果。` };
        }
        api.log(`[dsh-agent] ❌ ${chatKey} ${error && error.message ? error.message : error}`);
        return { content: `DSH 调用异常：${error && error.message ? error.message : error}`, isError: true };
      } finally {
        clearTimeout(timer);
      }
    }
  });
}
