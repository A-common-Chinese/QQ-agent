// 〔启动 loading 壳 / 就绪体检 / 状态栏〕——M9 拆分第 2 段
'use strict';
// ── 状态栏 ──
async function refreshStatus() {
  try {
    state.status = await api('/api/status');
    const s = state.status;
    const dot = $('#onebot-dot');
    const label = $('#onebot-label');
    dot.className = 'dot ' + (s.onebot.connected ? 'dot-on' : (s.onebot.everConnected ? 'dot-wait' : 'dot-off'));
    // 未连接时展示后端诊断（2026-09-19）：区分「SnowLuma 没起 / 没登录账号 / 令牌不匹配」，
    // 不再让用户面对一句干巴巴的"未连接"猜原因。
    const qbSt = s.qqbot || {};
    const qbActive = qbSt.connected === true && (qbSt.active === 'qqbot' || s.onebot.connected !== true);
    if (qbActive) {
      label.textContent = `开放平台 已连接${qbSt.selfNickname ? `（${qbSt.selfNickname}）` : ''}`;
      dot.className = 'dot dot-on';
    } else {
      label.textContent = s.onebot.connected
        ? `OneBot 已连接${s.onebot.self ? `（${s.onebot.self.nickname}）` : ''}`
        : (s.onebot.diagnosis || 'OneBot 未连接');
    }
    label.title = s.onebot.connected ? '' : (s.onebot.error || '');
    $('#model-label').textContent = `模型：${s.orchestrator.model || '未设置'}`;
    const u = s.usage;
    // 成本：官方价匹配得上就显示；匹配不上（中转站常见）只显示 token，不显示误导性的 ¥0
    const c = s.cost;
    const costTxt = c && c.cost > 0 ? ` · ¥${c.cost.toFixed(3)}` : '';
    const rate = s.cacheHitRate;
    const rateTxt = rate > 0 ? ` · 缓存 ${Math.round(rate * 100)}%` : '';
    $('#usage-label').textContent = `今日：${u.runs} 次运行 · ${fmtTokens(u.totalTokens)}${rateTxt}${costTxt}`;
    $('#search-count-label').textContent = `搜索：${s.webSearchCount ?? u.webSearchCount ?? 0} 次`;
    state.paused = s.paused;
    state.pauseReason = s.pauseReason;
    state.dataDir = s.dataDir || '';
    $('#pause-btn').textContent = state.paused ? '恢复' : '暂停';
    renderBanner();
    updateReadinessDots(s);
  } catch (e) { /* 忽略瞬时错误 */ }
}

/**
 * 未就绪时在控制台顶部显示「就绪度体检卡」，就绪后自动隐藏。
 * 配置还没加载完时不弹，避免闪一下。
 */
function mountHealthCard() {
  const wrap = document.getElementById('health-card-wrap');
  if (!wrap) return;
  let ready = true;
  try {
    if (!state.config) ready = true;
    else ready = assessReadiness(state.config, state.status).ready;
  } catch { ready = true; }
  if (ready) {
    if (!wrap.classList.contains('hidden')) {
      wrap.classList.add('hidden');
      wrap.innerHTML = '';
    }
    return;
  }
  try {
    wrap.innerHTML = renderHealthCard();
    wrap.classList.remove('hidden');
    const tBtn = wrap.querySelector('#test-api-btn');
    const tOut = wrap.querySelector('#test-api-result');
    if (tBtn) {
      tBtn.addEventListener('click', async () => {
        if (tBtn.disabled) return;
        const idle = tBtn.textContent;
        tBtn.disabled = true;
        tBtn.textContent = '测试中…';
        if (tOut) tOut.textContent = '';
        try {
          const cfg = state.config || {};
          const r = await api('/api/providers/test-chat', {
            method: 'POST',
            body: JSON.stringify({ baseUrl: String(cfg.api?.baseUrl || '').trim(), apiKey: '', model: String(cfg.api?.model || '').trim() })
          });
          const res = (r && r.result) || {};
          if (tOut) tOut.textContent = res.ok
            ? '✓ 测试通过（' + res.latencyMs + 'ms）：' + (res.note || '请求成功')
            : '✗ 测试失败：' + (res.note || '未知错误');
        } catch (e) {
          if (tOut) tOut.textContent = '测试失败：' + (e?.message || e);
        }
        tBtn.disabled = false;
        tBtn.textContent = idle;
      });
    }
    wrap.querySelectorAll('.hc-fix-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.target;
        if (t === 'snowluma') { switchTab('snowluma'); return; }
        switchTab('settings');
        const sec = t === 'settings-allow' ? 'allow' : 'api';
        state.settingsSection = sec;
        try { if (typeof renderSettingsSidebar === 'function') renderSettingsSidebar(); } catch { /* 忽略 */ }
        try { if (typeof renderSettings === 'function') renderSettings(); } catch { /* 忽略 */ }
      });
    });
  } catch { /* 渲染失败不影响主界面 */ }
}

/**
 * 顶栏通道胶囊 + 4 个就绪点（按当前通道换语义与配色）
 *   · OneBot 通道（蓝）：QQ 内核 / SnowLuma / OneBot 已连接 / 白名单
 *   · 官方通道（绿）：凭据有效 / WS 已连接 / 已收到群消息 / 白名单(openid)
 */
function updateReadinessDots(s) {
  // 顶栏可能在没打开过设置页时刷新：config 还没加载就先拉一次，否则白名单/模型判定全是 false
  if (!state.config) {
    api('/api/config').then((c) => { state.config = c || {}; updateReadinessDots(state.status || s); }).catch(() => {});
  }
  const cfg = state.config || {};
  const active = String(s?.qqbot?.active || 'onebot');
  const useQb = active === 'qqbot';
  const qb = s?.qqbot || {};
  const ob = s?.onebot || {};

  const allowQ = (cfg.allowQqbot?.groups || []).length + (cfg.allowQqbot?.private || []).length;
  const allowO = (cfg.allow?.groups || []).length + (cfg.allow?.private || []).length;
  const allowOk = (useQb ? allowQ : allowO) > 0 || cfg.allowAllWhenEmpty === true;
  const modelOk = !!String(cfg.api?.model || '').trim();
  const cfgQb = cfg.transport?.qqbot || {};
  const qbRecv = Number(qb.received || 0) || (cfgQb.lastRecvAt ? 1 : 0);

  const labels = useQb
    ? [['凭据有效', qb.configured === true], ['WS 已连接', qb.connected === true],
       ['已收到群消息（群授权）', qbRecv > 0], ['白名单（openid）', allowOk]]
    : [['QQ 内核运行', !!(s?.qqPortable?.running)], ['SnowLuma 运行', !!(s?.snowluma?.running)],
       ['OneBot 已连接', ob.connected === true], ['白名单', allowOk]];

  const chip = document.getElementById('channel-chip');
  if (chip) {
    chip.classList.toggle('is-qqbot', useQb);
    chip.classList.toggle('is-onebot', !useQb);
  }
  const labelEl = document.getElementById('chip-label');
  if (labelEl) {
    labelEl.textContent = useQb
      ? `开放平台 · ${qb.selfNickname || (qb.configured ? '机器人' : '未配置')}`
      : `OneBot · ${ob.self?.nickname || (ob.connected ? '已连接' : '未连接')}`;
  }

  const dots = $$('#readiness-dots .rdot');
  if (dots.length === 4) {
    dots.forEach((d, i) => {
      const [t, ok] = labels[i] || ['', false];
      d.className = 'rdot' + (ok ? ' on' : '');
      d.title = t + (ok ? '：就绪' : '：未就绪');
    });
  }

  window.__chipState = { active, useQb, labels, qb, ob, allowOk, allowQ, allowO, modelOk, qbRecv, status: s };
  renderStatusMenu(s);
  try { mountHealthCard(); } catch { /* 忽略 */ }
}

/** 状态菜单：接入 / 今日用量 / 就绪检查 / 快捷操作 */
function renderStatusMenu(s) {
  const box = document.getElementById('status-menu');
  if (!box || box.classList.contains('hidden')) return;
  const st = window.__chipState || {};
  const qb = st.qb || {};
  const ob = st.ob || {};
  const useQb = !!st.useQb;
  const u = (s && s.usage) || {};
  const c = (s && s.cost) || {};
  const rate = Number((s && s.cacheHitRate) || 0);
  const searchN = (s && (s.webSearchCount ?? u.webSearchCount)) || 0;
  const ok = (b) => (b ? '<span class="sm-ok">✓</span>' : '<span class="sm-bad">✗</span>');

  const row = (k, v) => `<div class="sm-row"><span>${esc(k)}</span><b>${esc(String(v))}</b></div>`;
  const dotList = (st.labels || []).map(([t, b]) => `<div class="sm-row"><span>${esc(t)}</span>${ok(b)}</div>`).join('');

  box.innerHTML = `
    <div class="sm-sec">
      <h4>接入状态</h4>
      ${row('当前通道', useQb ? '官方机器人（开放平台）' : 'OneBot（SnowLuma）')}
      ${useQb
        ? row('机器人', qb.selfNickname || (qb.configured ? '（已配置）' : '未配置')) + row('WS', qb.connected ? '已连接' : (qb.error || '未连接'))
        : row('账号', ob.self?.nickname || '—') + row('OneBot', ob.connected ? '已连接' : (ob.diagnosis || '未连接'))}
      ${row('白名单', useQb ? `${st.allowQ || 0} 个（openid）` : `${st.allowO || 0} 个`)}
    </div>
    <div class="sm-sec">
      <h4>今日用量</h4>
      ${row('运行次数', `${u.runs || 0} 次`)}
      ${row('Token', fmtTokens(u.totalTokens || 0))}
      ${row('缓存命中', rate > 0 ? `${Math.round(rate * 100)}%` : '—')}
      ${row('花费', c && c.cost > 0 ? `¥${c.cost.toFixed(3)}` : '—')}
      ${row('联网搜索', `${searchN} 次`)}
    </div>
    <div class="sm-sec">
      <h4>就绪检查</h4>
      ${dotList}
    </div>
    <div class="sm-sec">
      <h4>快捷操作</h4>
      <div class="sm-act">
        <button class="btn btn-small" data-sm="qq">QQ 接口</button>
        <button class="btn btn-small" data-sm="settings">设置</button>
        <button class="btn btn-small" data-sm="pause">${state.paused ? '恢复运行' : '暂停运行'}</button>
      </div>
    </div>`;
  box.querySelectorAll('[data-sm]').forEach((b) => {
    b.addEventListener('click', async () => {
      const act = b.dataset.sm;
      closeStatusMenu();
      if (act === 'qq') { switchTab('snowluma'); return; }
      if (act === 'settings') { switchTab('settings'); return; }
      if (act === 'pause') {
        const btn = document.getElementById('pause-btn');
        if (btn) btn.click();
      }
    });
  });
}

function closeStatusMenu() {
  const box = document.getElementById('status-menu');
  if (box) box.classList.add('hidden');
}

function bindChannelChip() {
  const chip = document.getElementById('channel-chip');
  const caret = document.getElementById('status-menu-btn');
  if (chip && !chip.__bound) {
    chip.__bound = true;
    chip.addEventListener('click', (e) => {
      if (e.target.closest('#status-menu-btn')) return;
      switchTab('snowluma');
    });
  }
  if (caret && !caret.__bound) {
    caret.__bound = true;
    caret.addEventListener('click', (e) => {
      e.stopPropagation();
      const box = document.getElementById('status-menu');
      if (!box) return;
      const willOpen = box.classList.contains('hidden');
      box.classList.toggle('hidden', !willOpen);
      if (willOpen) renderStatusMenu(state.status);
    });
  }
  if (!window.__statusMenuOutsideBound && typeof document.addEventListener === 'function') {
    window.__statusMenuOutsideBound = true;
    document.addEventListener('click', (e) => {
      const box = document.getElementById('status-menu');
      if (!box || box.classList.contains('hidden')) return;
      if (e.target.closest('#status-menu') || e.target.closest('#status-menu-btn')) return;
      closeStatusMenu();
    });
  }
}
try { bindChannelChip(); } catch { /* 忽略 */ }

// 就绪圆点点击跳转
$$('#readiness-dots .rdot').forEach((dot) => {
  dot.addEventListener('click', () => {
    const target = dot.dataset.target;
    if (target === 'snowluma') switchTab('snowluma');
    else if (target === 'settings') switchTab('settings');
  });
});

function fmtTokens(n) {
  n = Number(n) || 0;
  return n >= 10000 ? `${(n / 1000).toFixed(1)}k tok` : `${n} tok`;
}

$('#pause-btn').addEventListener('click', async () => {
  if (state.paused) {
    await resumePause({ skipBacklog: false });
  } else {
    await api('/api/pause', { method: 'POST', body: JSON.stringify({ paused: true }) });
    refreshStatus();
  }
});

// ── 会话渲染合批 ──
// 运行中的会话 SSE 事件非常密：每轮"正在思考…"开/关两次 + 每个工具调用一次。
// 曾经来一条事件就全量重建一次会话列表 + 会话详情（含大提示词的 esc/innerHTML），
// 主线程被反复长阻塞，详情内容反而"更新缓慢"、还伴随滚动跳动。
// 现在：patch 立即进 state（数据不延迟），渲染合并到短定时器一次；
// 窗口内的多次事件只渲染最终状态（中间的 activity 翻转根本不必上屏）。
//
// ⚠️ 用 setTimeout 而不是 requestAnimationFrame：
//    窗口被遮挡/最小化时 Chromium 会完全停发 rAF，渲染全部积压到切回前台
//    才一次性出现 —— 用户看到的就是"不手动刷新就不更新"。
//    setTimeout 在后台页面仍会执行（最多被节流到 1s），远比不执行强。
const pendingSessionDetail = new Map();   // sessionId -> 合并后的 patch
let sessionRenderScheduled = false;

function scheduleSessionRender() {
  if (sessionRenderScheduled) return;
  sessionRenderScheduled = true;
  setTimeout(() => {
    sessionRenderScheduled = false;
    if (state.tab === 'sessions') renderSessionList();
    const id = state.currentSessionId;
    const patch = id ? pendingSessionDetail.get(id) : null;
    pendingSessionDetail.clear();
    if (patch && state.tab === 'sessions') {
      // 详情用事件里的消息流渲染：HTTP 详情（systemPrompt 等）打底，SSE patch 覆盖动态字段。
      // sent/finishReason 等收尾字段 patch 优先 —— 它们走 SSE 实时推，HTTP 详情里的是旧值。
      renderSessionDetail({
        ...(state.sessionDetail || {}),
        ...patch,
        triggerSummary: patch.triggerSummary ?? state.sessionDetail?.triggerSummary ?? '',
        systemPrompt: state.sessionDetail?.systemPrompt ?? '',
        userPrompt: state.sessionDetail?.userPrompt ?? '',
        sent: patch.sent ?? state.sessionDetail?.sent ?? [],
        error: patch.error !== undefined ? patch.error : (state.sessionDetail?.error ?? null),
        finishReason: patch.finishReason ?? state.sessionDetail?.finishReason ?? null,
        endedAt: patch.endedAt ?? state.sessionDetail?.endedAt ?? null
      });
    }
  }, 80);
}
