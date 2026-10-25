// 〔消耗提示 / 缓存说明〕——集中文案表 + 用量页说明卡
// 原则：把「总 token 变多（真花钱）」和「缓存命中率下降（单价变贵）」分开讲，
// 避免用户把两者混为一谈。所有提示文案集中在这里，改动不散落。
'use strict';

const CONSUMPTION_TIPS = {
  // ── 改提示词前缀 → 命中率一次性下降（总量不变）──
  'cache-drop': '改动了提示词前缀（人设/技能/记忆卡/模型等）短时间内缓存命中率会下降，之后会随使用自动恢复',
  'memory-compress': '压缩后缓存命中率会暂时变低，属正常现象；之后会按新内容重新建立缓存。',
  'memory-consolidate': '整理记忆会改写记忆段内容，下一轮命中率会略有下降。',
  'switch-model': '不同模型 / 渠道的缓存互不共享，切换后前几轮会按全价计算。',
  'switch-skill': '开关技能会改变提示词里的技能段，下一轮命中率会因此下降。',
  'edit-persona': '修改人设后，下一轮会重新计算完整提示词导致命中率下降。',
  'restart-anchor': '重启后会话锚点重置，头一两轮命中率低是正常现象。',
  'first-turn': '新会话第一轮没有可复用的前缀，命中率为 0 为正常现象。',

  // ── 直接让总 token 变多（真花钱）──
  'context-tier': '上下文档位越高，带上的历史越多，输入 token 也越多。',
  'image-video': '图片 / 视频按视觉模型计费，且不参与前缀缓存。',
  'web-search': '联网搜索 / 抓网页的正文按 token 计费，一次可能消耗几千 token。',
  'forward-expand': '展开合并转发 / 长语音转写，一次可能消耗几千 token。',
  'broadcast': '群发 / 主动消息每次都是新请求，没有缓存可复用。',
  'retry': '失败重试或切换到备选模型，同一次请求可能被计费两次。',
  'active-period': '活跃期持续时间越长，接话轮次越多，累计消耗越高。'
};

function consumptionTip(id) {
  return CONSUMPTION_TIPS[String(id || '')] || '';
}

function consumptionTipsEnabled() {
  try {
    const v = state?.config?.ui?.showConsumptionTips;
    return v !== false;
  } catch { return true; }
}

/** 用量页顶部的「消耗说明」折叠卡 */
function renderConsumptionTipsCard() {
  if (!consumptionTipsEnabled()) return '';
  const row = (k, v) => `<div class="ct-row"><span class="ct-k">${esc(k)}</span><span class="ct-v">${esc(v)}</span></div>`;
  return `
    <details class="consumption-tips" style="margin:10px 0 14px">
      <summary>哪些操作会增加消耗？（点击展开）</summary>
      <div class="ct-body">
        <div class="ct-sec">
          <b>一、命中率下降（总量不变，单价变贵，且会恢复）</b>
          ${row('压缩 / 整理记忆', consumptionTip('memory-compress'))}
          ${row('改人设 / 记忆卡 / 管理员规则', consumptionTip('cache-drop'))}
          ${row('开关技能或插件', consumptionTip('switch-skill'))}
          ${row('切换模型 / 渠道', consumptionTip('switch-model'))}
          ${row('重启应用 / 新会话', consumptionTip('restart-anchor') + ' ' + consumptionTip('first-turn'))}
        </div>
        <div class="ct-sec">
          <b>二、总 token 变多（真花钱）</b>
          ${row('提高上下文档位', consumptionTip('context-tier'))}
          ${row('发图片 / 视频', consumptionTip('image-video'))}
          ${row('联网搜索 / 抓网页', consumptionTip('web-search'))}
          ${row('展开合并转发 / 长语音', consumptionTip('forward-expand'))}
          ${row('群发 / 主动消息', consumptionTip('broadcast'))}
          ${row('失败重试 / 切备选模型', consumptionTip('retry'))}
          ${row('长时间活跃期', consumptionTip('active-period'))}
        </div>
        <div class="ct-sec">
          <b>三、怎么省</b>
          <div class="ct-row"><span class="ct-v">· 稳定用同一张人设卡、少改设置 → 命中率更高</span></div>
          <div class="ct-row"><span class="ct-v">· 不需要全量历史时把档位调低</span></div>
          <div class="ct-row"><span class="ct-v">· 图片/网页内容只在真正需要时调用</span></div>
          <div class="ct-row"><span class="ct-v">· 看「今日用量」里的缓存命中率判断是否异常</span></div>
        </div>
      </div>
    </details>`;
}
