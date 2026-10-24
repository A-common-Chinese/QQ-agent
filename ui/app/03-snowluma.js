// 〔SnowLuma 页签〕——M9 拆分第 4 段
'use strict';
// ── SnowLuma 独立页签 ──
/**
 * 只刷新日志区（不重建整个页面）。
 * SSE 每来一条新日志就调一次 —— 整页 innerHTML 重建会重绘、丢滚动、还拖帧。
 * 三个日志框各刷各的：QQ / SnowLuma / 应用。
 */
async function refreshSnowlumaLogs() {
  const box = $('#snowluma-page');
  if (!box) return;
  const slPre = box.querySelector('#sl-logs-view');
  const qqPre = box.querySelector('#qq-logs-view');
  const appPre = box.querySelector('#app-logs-view');
  if (!slPre && !qqPre && !appPre) return;   // 页面还没渲染过，等下次整页刷新
  try {
    const [logs, qqLogs, appLogsData] = await Promise.all([
      api('/api/snowluma/logs'),
      api('/api/qq-portable/logs').catch(() => ({ logs: [] })),
      api('/api/logs?limit=120').catch(() => ({ logs: [] }))
    ]);
    const fmt = (arr) => (arr || []).map((l) => {
      const t = new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false });
      return `[${t}]${l.stream === 'stderr' ? ' ⚠' : ''} ${l.text}`;
    }).join('\n') || '暂无日志';
    const setLog = (pre, text) => {
      if (!pre) return;
      // 先记贴底状态再换内容：往上翻历史时绝不把用户拽回底部
      const wasAtBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 40;
      pre.textContent = text;
      if (wasAtBottom) pre.scrollTop = pre.scrollHeight;
    };
    setLog(slPre, fmt(logs.logs));
    setLog(qqPre, fmt(qqLogs.logs));
    if (appPre) {
      const appText = (appLogsData.logs || []).map((e) => {
        const t = new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false });
        const lv = String(e.level || 'info').toUpperCase().padEnd(5);
        return `[${t}] [${lv}] [${e.module || '-'}] ${e.text}`;
      }).join('\n') || '暂无日志';
      setLog(appPre, appText);
    }
  } catch { /* 刷新失败静默，不影响主流程 */ }
}

// 整页重建节流：状态事件可能连着来（启动 QQ + SnowLuma + OneBot），
// 不节流会连续三四次 Promise.all + innerHTML 重绘。
let slFullReloadTimer = null;
function scheduleSnowlumaReload(opts = {}) {
  if (slFullReloadTimer) return;
  slFullReloadTimer = setTimeout(() => {
    slFullReloadTimer = null;
    loadSnowlumaPage({ quiet: true });
  }, 400);
}

async function loadSnowlumaPage({ quiet = false } = {}) {
  // 正在输入时不要整页重建（SSE 状态推送 400ms 一次，重建会把输入框清空/丢焦点）
  try {
    const active = document.activeElement;
    if (quiet && active && active.closest && active.closest('#snowluma-page')
      && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) {
      return;
    }
  } catch { /* 忽略 */ }
  try {
    const [status, logs, qqLogs, appLogsData, trStatus, cfgData] = await Promise.all([
      api('/api/status'),
      api('/api/snowluma/logs'),
      api('/api/qq-portable/logs'),
      api('/api/logs?limit=120').catch(() => ({ logs: [], level: 'info' })),
      api('/api/transport/status').catch(() => null),
      api('/api/config').catch(() => null)
    ]);
    const slCfg = (cfgData && cfgData.snowluma) || {};
    const s = status;
    // P1：没装协议端时，通道选项只保留官方机器人；OneBot 卡片与进程管理都隐藏
    const slInstalled = !!(s?.snowluma?.installed || s?.snowluma?.dir);
    const box = $('#snowluma-page');
    let chan = 'onebot';
    try { chan = localStorage.getItem('qqa-sl-chan') || 'onebot'; } catch { /* 忽略 */ }
    const tr = trStatus || { active: 'onebot', qqbot: {} };
    const qb = tr.qqbot || {};
    if (!box) return;
    const running = !!(s.snowluma?.running);
    const onebotConnected = !!s.onebot?.connected;
    const dir = s.snowluma?.dir || '';
    const embedded = !!s.snowluma?.embedded;
    const pid = s.snowluma?.pid ?? null;
    const webuiUrl = s.snowluma?.webuiUrl || '';
    // 便携 QQ 状态
    const qq = s.qqPortable || {};
    const qqReady = !!qq.ready;
    const qqRunning = !!qq.running;
    const qqPid = qq.pid ?? null;
    const logText = (logs.logs || []).map((l) => {
      const t = new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false });
      return `[${t}]${l.stream === 'stderr' ? ' ⚠' : ''} ${l.text}`;
    }).join('\n') || '暂无日志';
    const qqLogText = (qqLogs.logs || []).map((l) => {
      const t = new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false });
      return `[${t}]${l.stream === 'stderr' ? ' ⚠' : ''} ${l.text}`;
    }).join('\n') || '暂无日志';
    // 应用日志（logger 的内存环形缓冲）
    const appLogs = appLogsData.logs || [];
    const appLogLevel = appLogsData.level || 'info';
    const appLogText = appLogs.map((e) => {
      const t = new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false });
      const lv = String(e.level || 'info').toUpperCase().padEnd(5);
      return `[${t}] [${lv}] [${e.module || '-'}] ${e.text}`;
    }).join('\n') || '暂无日志';

    // 整页重建前记住日志滚动位置：SSE/轮询触发的 quiet 重建会重置 DOM，
    // 不补偿的话用户往下翻日志会被弹回顶部（Kondius 实测：划两下就蹦上去）
    const oldPre = box.querySelector('#sl-logs-view');
    const prevScroll = oldPre
      ? { top: oldPre.scrollTop, atBottom: oldPre.scrollTop + oldPre.clientHeight >= oldPre.scrollHeight - 40 }
      : null;
    // 记住 QQ 接口表单里正在编辑的值与焦点（重建后原样还原）
    const EDIT_IDS = ['sl-qb-appid', 'sl-qb-secret', 'sl-qb-env', 'sl-qb-groupmode'];
    const editState = {};
    for (const id of EDIT_IDS) {
      const el = box.querySelector('#' + id);
      if (!el) continue;
      editState[id] = { value: el.value, focused: document.activeElement === el };
    }
    const oldAppPre = box.querySelector('#app-logs-view');
    const prevAppScroll = oldAppPre
      ? { top: oldAppPre.scrollTop, atBottom: oldAppPre.scrollTop + oldAppPre.clientHeight >= oldAppPre.scrollHeight - 40 }
      : null;

    box.innerHTML = `
      <div class="snowluma-page-card">
        <h2 style="display:flex;align-items:center;gap:10px">QQ 接口
          <button class="btn btn-small sl-info-btn" id="sl-interface-info" title="接入方式对比 / 能力说明">ⓘ 说明</button>
        </h2>
        <div class="sl-chan-switch">
          ${slInstalled ? `<button class="sl-chan ${chan === 'onebot' ? 'on' : ''}" data-sl-chan="onebot">OneBot（SnowLuma）</button>` : ''}
          <button class="sl-chan ${chan === 'qqbot' ? 'on' : ''}" data-sl-chan="qqbot">官方机器人（QQ 开放平台）</button>
        </div>
        <div class="hint" style="margin:-4px 0 12px">两种接入方式只能选一种（可留空另一种）；切换后需重启应用生效。点右上角「ⓘ 说明」看能力对比。</div>

        <div id="sl-qqbot-card" class="sl-qb-card ${chan === 'qqbot' ? '' : 'hidden'}">
          <h3>连接配置</h3>
            <div class="sl-qb-grid">
              <label class="field"><span>AppID</span><input id="sl-qb-appid" type="text" value="${esc(qb.appId || '')}" placeholder="在 QQ 开放平台机器人管理端查看" /></label>
              <label class="field"><span>AppSecret</span><input id="sl-qb-secret" type="password" value="" placeholder="${qb.hasAppSecret ? '已保存（留空表示不修改）' : '机器人密钥，只存在本机'}" /></label>
              <label class="field"><span>环境</span><select id="sl-qb-env">
                <option value="production"${qb.env !== 'sandbox' ? ' selected' : ''}>正式环境</option>
                <option value="sandbox"${qb.env === 'sandbox' ? ' selected' : ''}>沙箱环境</option>
              </select></label>
              <label class="field"><span>群消息模式</span><select id="sl-qb-groupmode">
                <option value="all"${qb.groupMode !== 'at' ? ' selected' : ''}>全量（需群主在手机 QQ 授权「接收全量消息」）</option>
                <option value="at"${qb.groupMode === 'at' ? ' selected' : ''}>仅被 @</option>
              </select></label>
            </div>
            <div class="sl-qb-actions">
              <button class="btn btn-small btn-primary" id="sl-qb-save">保存</button>
              <button class="btn btn-small" id="sl-qb-test">测试鉴权</button>
              <button class="btn btn-small" id="sl-qb-active">设为当前通道</button>
              <span id="sl-qb-status" class="muted" style="font-size:12px"></span>
            </div>
            <div class="sl-qb-chats-wrap">
              <div class="sl-qb-chats-head">
                <b>最近收到的会话</b>
                <span class="muted">官方给的是 openid（不是群号/QQ 号），这里直接点「加入白名单」即可</span>
              </div>
              <div id="sl-qb-chats" class="sl-qb-chats"><span class="muted">加载中…</span></div>
              <div class="hint" style="margin-top:6px">看不到内容？机器人进群后需要有人 <b>@ 它</b>（或群主授权「接收全量消息」）才会推送消息；消息到达时日志里也会打一行 <code>[qqbot] 收到 group:xxxx（昵称）：…</code>，openid 就在里面。</div>
            </div>
          <h3>运行状态</h3>
            <div class="sl-qb-head">
              <span class="dot ${(s.qqbot?.connected ? 'dot-on' : 'dot-off')}"></span>
              <strong>官方机器人</strong>
              <span class="muted">${qb.configured ? '已配置（' + esc(qb.appId || '') + '）' : '未配置'}${s.qqbot?.connected ? ' · 已连接' : ''}</span>
              <span class="muted" style="margin-left:auto">当前通道：${esc(tr.active || 'onebot')}</span>
            </div>
          </details>
          <h3>运行日志</h3>
            <div class="sl-qb-log-wrap">
              <div class="hint" style="margin-bottom:4px">官方机器人运行日志（<code>data/logs/qqbot/</code>）</div>
              <pre class="snowluma-logs-view" id="sl-qb-log" style="max-height:180px">加载中…</pre>
            </div>
          <h3>应用日志</h3>
          <div class="sl-log-block sl-app-logs">
            <div class="hint sl-log-head"><span>应用日志（最近 ${appLogs.length} 条）</span><button class="btn btn-small" id="app-logs-refresh-qb" title="重新拉取">刷新</button></div>
            <pre class="snowluma-logs-view" id="app-logs-view-qb">${esc(appLogText)}</pre>
          </div>
        </div>

        ${!slInstalled ? `
        <div class="sl-qb-card" style="margin-top:14px">
          <h3>还没有 OneBot 协议端（可选）</h3>
          <div class="hint" style="line-height:1.8">
            现在只有一个通道：<b>官方机器人（QQ 开放平台）</b>，不需要协议端，合规、无协议封号风险。<br>
            想要 OneBot 的完整玩法（全量消息 / 拍一拍 / 贴表情 / 群名片），需要自己准备一个
            <b>OneBot v11 协议端</b>（SnowLuma、NapCat、LLOneBot 任选），装好并登录 QQ 后回到这里填地址与令牌。
          </div>
          <div class="hint" style="margin-top:6px">
            本项目<b>不代管</b>协议端的安装/登录，也不随包分发第三方程序；装好后点下面「重新检测」。
          </div>
          <div style="display:flex;gap:8px;margin-top:10px">
            <button class="btn btn-small" id="sl-redetect">重新检测</button>
          </div>
        </div>` : ''}
        <div id="sl-onebot-card" class="${chan === 'onebot' && slInstalled ? '' : 'hidden'}">
          <div class="sl-onebot-sentinel"></div>
          <h3>连接配置</h3>
          <div class="sl-ob-config">
            <div class="field"><label>SnowLuma 程序目录（留空 = 自动使用项目内 snowluma/ 文件夹）</label>
              <input type="text" id="sl-ob-dir" value="${esc(slCfg.dir || '')}" /></div>
            <div class="field-row">
              <div class="field"><label>WebSocket 地址（收消息）</label><input type="text" id="sl-ob-ws" value="${esc(slCfg.wsUrl || '')}" /></div>
              <div class="field"><label>HTTP 地址（发消息）</label><input type="text" id="sl-ob-http" value="${esc(slCfg.httpUrl || '')}" /></div>
            </div>
            <div class="field-row">
              <div class="field"><label>WebSocket 令牌</label>
                <input type="password" id="sl-ob-token" value="${esc(slCfg.hasAccessToken ? '******' : '')}" placeholder="输入新令牌可替换；留空保持不变" autocomplete="new-password" /></div>
              <div class="field"><label>HTTP 令牌（与 WS 不同时填）</label>
                <input type="password" id="sl-ob-httptoken" value="${esc(slCfg.hasHttpAccessToken ? '******' : '')}" placeholder="输入新令牌可替换；留空保持不变" autocomplete="new-password" /></div>
            </div>
            <div class="checkbox-row"><input type="checkbox" id="sl-ob-autolaunch" ${slCfg.autoLaunch ? 'checked' : ''} />
              <label for="sl-ob-autolaunch">QQ Agent 启动时自动拉起 SnowLuma（未运行时）</label></div>
            <div class="checkbox-row"><input type="checkbox" id="sl-ob-autoreadtoken" ${slCfg.autoReadToken ? 'checked' : ''} />
              <label for="sl-ob-autoreadtoken">自动从本机协议端读取令牌（默认关；会读取第三方程序的账号目录，介意就别开）</label></div>
            <div style="display:flex;align-items:center;gap:8px;margin-top:10px">
              <button class="btn btn-small btn-primary" id="sl-ob-save">保存 OneBot 配置</button>
              <span class="muted" id="sl-ob-hint" style="font-size:12px"></span>
            </div>
            <div style="display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap">
              <button class="btn btn-small btn-danger" id="sl-sl-uninstall">卸载协议端</button>
              <span class="muted" id="sl-uninstall-hint" style="font-size:12px">会先停止进程，再删除协议端目录（不可恢复）</span>
            </div>
          </div>
          <h3>运行状态</h3>
          <details class="sl-adv">
            <summary>高级：本机协议端管理（可选）</summary>
        <!-- 一键启动区域（核心入口） -->
        ${!onebotConnected ? `
        <div class="quick-start-section" style="background:var(--bg);border:none;border-radius:14px;padding:16px;margin-bottom:16px;box-shadow:var(--raise-sm)">
          <div style="font-size:15px;font-weight:600;margin-bottom:8px">🚀 快速启动</div>
          <div class="muted" style="font-size:13px;margin-bottom:12px;line-height:1.6">
            ${!qqReady ? '便携 QQ 未安装，请先运行 <code>npm run setup</code>' :
              !qqRunning ? '点击下面按钮，自动完成：启动 QQ → 启动 SnowLuma → 连接 OneBot' :
              !running ? 'QQ 已运行，点击启动 SnowLuma 并连接' :
              'SnowLuma 已运行，等待 OneBot 连接…'}
          </div>
          <button class="btn btn-primary" id="quick-start-btn" style="font-size:14px;padding:10px 20px" ${!qqReady ? 'disabled' : ''}>
            ${!qqReady ? '请先运行 npm run setup' :
              !qqRunning ? '一键启动（QQ + SnowLuma）' :
              !running ? '启动 SnowLuma' :
              '等待连接…'}
          </button>
          <span id="quick-start-hint" class="muted" style="font-size:12px;margin-left:12px"></span>
        </div>` : ''}
        <!-- 便携 QQ 内核状态 -->
        <div class="snowluma-qq-section">
          <div class="snowluma-state-row">
            <span class="dot ${qqRunning ? 'dot-on' : 'dot-off'}"></span>
            <span>QQ 内核：<strong>${qqRunning ? `运行中${qqPid ? `（pid ${qqPid}）` : ''}` : (qqReady ? '未启动' : '未安装')}</strong></span>
            ${!qqReady ? '<span class="muted" style="color:var(--orange)">请先运行 npm run setup</span>' : ''}
          </div>
          ${qqReady ? `
          <div class="snowluma-state-row muted" style="font-size:12px">
            <span>目录：${esc(qq.dir || '')}</span>
          </div>` : ''}
          <div class="snowluma-actions">
            <button class="btn btn-small" id="qq-start-btn" ${!qqReady || qqRunning ? 'disabled' : ''}>${qqRunning ? '已运行' : '单独启动 QQ'}</button>
            <button class="btn btn-small btn-danger" id="qq-stop-btn" ${!qqRunning ? 'disabled' : ''}>关闭 QQ</button>
            <span id="qq-hint" class="muted" style="font-size:12px"></span>
          </div>
          ${qqLogText !== '暂无日志' ? `
          <div class="sl-log-block">
            <div class="hint sl-log-head">QQ 日志</div>
            <pre class="snowluma-logs-view" id="qq-logs-view" style="max-height:120px">${esc(qqLogText)}</pre>
          </div>` : ''}
        </div>
        <hr class="sl-sep">

        <!-- SnowLuma 状态 -->
        <div class="snowluma-qq-section">
          <div class="snowluma-state-row">
            <span class="dot ${running ? 'dot-on' : 'dot-off'}"></span>
            <span>SnowLuma：<strong>${running ? '运行中' : '未运行'}</strong></span>
            ${pid ? `<span class="muted">pid ${pid}</span>` : ''}
            <span class="muted">${embedded ? '内置模式（随 QQ Agent 退出）' : (running ? '独立模式' : '')}</span>
          </div>
          <div class="snowluma-state-row">
            <span class="dot ${onebotConnected ? 'dot-on' : 'dot-off'}"></span>
            <span>OneBot：<strong>${onebotConnected ? `已连接${s.onebot.self ? `（${s.onebot.self.nickname}）` : ''}` : '未连接'}</strong></span>
            <span class="muted">WS ${s.onebot?.error ? `：${s.onebot.error}` : ''}</span>
          </div>
          <div class="snowluma-state-row muted">
            <span>目录：${esc(dir || '（未找到项目内 snowluma/ 文件夹）')}</span>
          </div>
          <div class="snowluma-state-row">
            <span>WebUI：</span>
            ${webuiUrl
              ? `<button class="btn btn-small" id="sl-open-webui-btn" title="在浏览器中打开 SnowLuma 控制台">${esc(webuiUrl)}</button>`
              : '<span class="muted">等待 SnowLuma 启动后自动识别…</span>'}
          </div>
          <div class="snowluma-actions">
            <button class="btn btn-primary" id="sl-start-btn" ${running ? 'disabled' : ''}>${running ? '已运行' : '启动 SnowLuma'}</button>
            <button class="btn btn-danger" id="sl-stop-btn" ${running ? '' : 'disabled'}>关闭 SnowLuma</button>
            <button class="btn btn-small" id="sl-refresh-btn">刷新状态</button>
            <button class="btn btn-small" id="sl-open-folder-btn">打开文件夹</button>
            <span id="sl-hint" class="muted" style="font-size:12px"></span>
          </div>
        </div>
          <h3>运行日志</h3>
        <div class="sl-log-block">
          <div class="hint sl-log-head">运行日志（仅保留最近 500 行）</div>
          <pre class="snowluma-logs-view" id="sl-logs-view">${esc(logText)}</pre>
        </div>
          <h3>应用日志</h3>
        <!-- 应用日志：logger.js 的内存环形缓冲 + data/logs/ 落盘文件。 -->
        <div class="sl-log-block sl-app-logs">
          <div class="hint sl-log-head">
            <span>应用日志（最近 ${appLogs.length} 条，同时落盘到 data/logs/）</span>
            <label class="sl-log-level">
              <span class="muted">落盘级别</span>
              <select id="app-log-level" title="低于该级别的日志不写入磁盘">
                ${['debug', 'info', 'warn', 'error'].map((v) =>
                  `<option value="${v}" ${appLogLevel === v ? 'selected' : ''}>${v}</option>`).join('')}
              </select>
            </label>
            <button class="btn btn-small" id="app-logs-refresh-btn" title="重新拉取最近日志">刷新</button>
          </div>
          <pre class="snowluma-logs-view" id="app-logs-view">${esc(appLogText)}</pre>
        </div>
        </div>
      </div>`;

    // 还原 QQ 接口表单的输入值与焦点
    for (const [id, st] of Object.entries(editState)) {
      const el = box.querySelector('#' + id);
      if (!el) continue;
      if (st.value !== el.value && st.focused) {
        el.value = st.value;
        try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* select 不支持 */ }
        el.focus();
      } else if (st.focused) {
        el.focus();
      }
    }

    // 说明弹窗（原「与 OneBot 的区别」长文本）
    const infoBtn = box.querySelector('#sl-interface-info');
    if (infoBtn) {
      infoBtn.addEventListener('click', () => {
        const overlay = modelModalShell({
          head: 'QQ 接口：两种接入方式',
          body: `
            <div class="hint" style="font-size:13px;line-height:1.8">
              <b>OneBot（SnowLuma）</b><br>
              · 玩法最全：能收全部群消息、主动发言、拍一拍、贴表情、改群名片<br>
              · 走非官方协议，理论上有封号风险<br>
              · 需要本机运行 QQ + SnowLuma<br><br>
              <b>官方机器人（QQ 开放平台）</b><br>
              · 合规、不会被封协议号；个人主体只能加自己是群主/管理员的群<br>
              · 不能拍一拍 / 贴表情 / 改群名片 / 撤回他人消息（官方无接口）<br>
              · 群消息默认只推 @ 的；收全部消息需群主在手机 QQ 授权「接收全量消息」<br>
              · 主动发言需群主授权「主动推送消息」，配额 1000 条/群/日；被动回复 5 分钟内有效<br>
              · 文本里的 @ 是 &lt;@openid&gt;，后台会自动清理<br><br>
              <b>切换</b>：两套白名单/日志/记忆互相独立；切换通道后需重启应用生效。
            </div>`,
          foot: '<button class="btn btn-primary" id="sl-info-ok">知道了</button>'
        });
        overlay.querySelector('#sl-info-ok').addEventListener('click', () => closeModelModal(overlay));
      });
    }
    const appRefreshQb = box.querySelector('#app-logs-refresh-qb');
    if (appRefreshQb) appRefreshQb.addEventListener('click', () => loadSnowlumaPage());
    // 最近收到的官方通道会话（openid → 一键加白名单）
    const chatsBox = box.querySelector('#sl-qb-chats');
    if (chatsBox) {
      api('/api/transport/qqbot/chats').then((r) => {
        const list = (r && r.chats) || [];
        if (!list.length) {
          chatsBox.innerHTML = '<span class="muted">还没收到消息。机器人进群并有人 @ 它之后，这里会列出会话 openid。</span>';
          return;
        }
        chatsBox.innerHTML = list.map((c) => '<div class="sl-qb-chat">'
          + '<span class="sl-qb-chat-key">' + esc(c.chatKey) + '</span>'
          + '<span class="muted">' + esc(c.nickname || '') + '</span>'
          + '<button class="btn btn-small" data-sl-qb-allow data-kind="' + esc(c.kind) + '" data-id="' + esc(c.id) + '">加入白名单</button>'
          + '</div>').join('');
        chatsBox.querySelectorAll('[data-sl-qb-allow]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
              const rr = await api('/api/transport/qqbot/chats/allow', { method: 'POST', body: JSON.stringify({ kind: btn.dataset.kind, id: btn.dataset.id }) });
              btn.textContent = rr && rr.ok ? '已加入 ✓' : '失败';
            } catch { btn.textContent = '失败'; }
            btn.disabled = false;
          });
        });
      }).catch(() => { chatsBox.innerHTML = '<span class="muted">读取失败</span>'; });
    }

    // 官方机器人卡片内的运行日志（只读 data/logs/qqbot/）
    const qbLogPre = box.querySelector('#sl-qb-log');
    const fillQbLog = async () => {
      if (!qbLogPre) return;
      try {
        const r = await api('/api/logs/channel?channel=qqbot&limit=200');
        const rows = (r && r.logs) || [];
        qbLogPre.textContent = rows.length
          ? rows.map((l) => {
            const t = new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false });
            return `[${t}]${l.stream === 'stderr' ? ' ⚠' : ''} ${l.text}`;
          }).join('\n')
          : '（还没有日志）';
        qbLogPre.scrollTop = qbLogPre.scrollHeight;
      } catch (e) { qbLogPre.textContent = '读取失败：' + (e.message || e); }
    };
    fillQbLog();

    // 未安装协议端：重新检测
    const redetect = box.querySelector('#sl-redetect');
    if (redetect) redetect.addEventListener('click', () => loadSnowlumaPage());

    // P2：自动读取协议端令牌（默认关）
    const autoRead = box.querySelector('#sl-ob-autoreadtoken');
    if (autoRead) {
      autoRead.addEventListener('change', async () => {
        try {
          await api('/api/config', { method: 'PATCH', body: JSON.stringify({ snowluma: { autoReadToken: autoRead.checked } }) });
        } catch (e) {
          const hint = box.querySelector('#sl-ob-hint');
          if (hint) { hint.textContent = '保存失败：' + (e.message || e); hint.style.color = 'var(--red)'; }
        }
      });
    }

    // 卸载协议端（二次确认 → 停进程 → 删目录）
    const uninstallBtn = box.querySelector('#sl-sl-uninstall');
    if (uninstallBtn) {
      uninstallBtn.addEventListener('click', async () => {
        const hint = box.querySelector('#sl-uninstall-hint');
        const setHint = (t, c) => { if (hint) { hint.textContent = t; hint.style.color = c || ''; } };
        const first = typeof uiConfirm === 'function'
          ? await uiConfirm({ title: '卸载协议端', message: '会先停止协议端进程，然后删除它的整个目录（配置、账号数据一并删除，不可恢复）。继续？', okText: '继续' })
          : window.confirm('会停止并删除协议端目录（不可恢复），继续？');
        if (!first) return;
        const second = typeof uiConfirm === 'function'
          ? await uiConfirm({ title: '再次确认', message: '确定删除？这一步不可撤销。', okText: '删除' })
          : window.confirm('再次确认：真的要删除协议端目录？');
        if (!second) return;
        uninstallBtn.disabled = true;
        setHint('卸载中…');
        try {
          const r = await api('/api/snowluma/uninstall', { method: 'POST', body: JSON.stringify({ confirm: true }) });
          setHint(r && r.removed ? '已卸载：' + (r.dir || '') : '目录不存在，已视为未安装', 'var(--green)');
          await loadSnowlumaPage();
        } catch (e) {
          setHint('卸载失败：' + (e.message || e), 'var(--red)');
        }
        uninstallBtn.disabled = false;
      });
    }

    // OneBot 连接配置保存
    const obSave = box.querySelector('#sl-ob-save');
    if (obSave) {
      ['sl-ob-dir', 'sl-ob-ws', 'sl-ob-http', 'sl-ob-token', 'sl-ob-httptoken', 'sl-ob-autolaunch'].forEach((id) => {
        const el = box.querySelector('#' + id);
        if (el) el.addEventListener('change', () => {
          const hint = box.querySelector('#sl-ob-hint');
          if (hint) { hint.textContent = '有未保存的改动，记得点「保存 OneBot 配置」'; hint.style.color = 'var(--orange)'; }
        });
      });
      const obHint = (text, color) => {
        const el = box.querySelector('#sl-ob-hint');
        if (el) { el.textContent = text || ''; el.style.color = color || ''; }
      };
      obSave.addEventListener('click', async () => {
        obSave.disabled = true;
        const val = (id) => (box.querySelector('#' + id) || {}).value || '';
        const wsToken = val('sl-ob-token').trim();
        const httpToken = val('sl-ob-httptoken').trim();
        const payload = {
          snowluma: {
            dir: val('sl-ob-dir').trim(),
            autoLaunch: !!(box.querySelector('#sl-ob-autolaunch') || {}).checked,
            wsUrl: val('sl-ob-ws').trim(),
            httpUrl: val('sl-ob-http').trim(),
            ...(wsToken && wsToken !== '******' ? { accessToken: wsToken } : {}),
            ...(httpToken && httpToken !== '******' ? { httpAccessToken: httpToken } : {})
          }
        };
        try {
          await api('/api/config', { method: 'PATCH', body: JSON.stringify(payload) });
          obHint('已保存 ✅（地址/令牌改动需重启生效）', 'var(--green)');
          loadSnowlumaPage({ quiet: true });
        } catch (e) {
          obHint('保存失败：' + (e.message || e), 'var(--red)');
        }
        obSave.disabled = false;
      });
    }

    // 通道切换
    box.querySelectorAll('[data-sl-chan]').forEach((b) => {
      b.addEventListener('click', () => {
        try { localStorage.setItem('qqa-sl-chan', b.dataset.slChan); } catch { /* 忽略 */ }
        loadSnowlumaPage();
      });
    });
    const qbHint = (text, color) => {
      const el = box.querySelector('#sl-qb-status');
      if (el) { el.textContent = text || ''; el.style.color = color || ''; }
    };
    const qbPayload = () => ({
      appId: (box.querySelector('#sl-qb-appid') || {}).value || '',
      appSecret: (box.querySelector('#sl-qb-secret') || {}).value || '',
      env: (box.querySelector('#sl-qb-env') || {}).value || 'production',
      groupMode: (box.querySelector('#sl-qb-groupmode') || {}).value || 'all'
    });
    // 输入/下拉：改动时提示"未保存"（也让接线测试能验证它们真的有人管）
    ['sl-qb-appid', 'sl-qb-secret', 'sl-qb-env', 'sl-qb-groupmode'].forEach((id) => {
      const el = box.querySelector('#' + id);
      if (el) el.addEventListener('change', () => qbHint('有未保存的改动，记得点「保存」', 'var(--orange)'));
    });
    const qbSaveBtn = box.querySelector('#sl-qb-save');
    if (qbSaveBtn) qbSaveBtn.addEventListener('click', async () => {
      qbSaveBtn.disabled = true;
      try {
        const r = await api('/api/transport/qqbot/save', { method: 'POST', body: JSON.stringify(qbPayload()) });
        qbHint(r && r.ok ? '已保存 ✅（切换通道后重启生效）' : ('保存失败：' + (r && r.error || '未知')), r && r.ok ? 'var(--green)' : 'var(--red)');
      } catch (e) { qbHint('保存失败：' + (e.message || e), 'var(--red)'); }
      qbSaveBtn.disabled = false;
    });
    const qbTestBtn = box.querySelector('#sl-qb-test');
    if (qbTestBtn) qbTestBtn.addEventListener('click', async () => {
      qbTestBtn.disabled = true;
      qbHint('正在测试鉴权…');
      try {
        const r = await api('/api/transport/qqbot/test', { method: 'POST', body: JSON.stringify(qbPayload()) });
        if (r && r.ok) qbHint('✅ 鉴权通过（' + r.latencyMs + 'ms）：AppSecret 有效', 'var(--green)');
        else qbHint('✗ ' + ((r && r.error) || '鉴权失败'), 'var(--red)');
      } catch (e) { qbHint('✗ 测试失败：' + (e.message || e), 'var(--red)'); }
      qbTestBtn.disabled = false;
    });
    const qbActiveBtn = box.querySelector('#sl-qb-active');
    if (qbActiveBtn) qbActiveBtn.addEventListener('click', async () => {
      try {
        const r = await api('/api/transport/active', { method: 'POST', body: JSON.stringify({ active: 'qqbot' }) });
        qbHint(r && r.ok ? '已设为当前通道，重启应用后生效' : ('失败：' + ((r && r.error) || '未知')), r && r.ok ? 'var(--green)' : 'var(--red)');
      } catch (e) { qbHint('失败：' + (e.message || e), 'var(--red)'); }
    });

    // 恢复日志滚动：贴底跟随新日志；否则回到原阅读位置；首次渲染贴底
    const newPre = box.querySelector('#sl-logs-view');
    if (newPre) newPre.scrollTop = prevScroll ? (prevScroll.atBottom ? newPre.scrollHeight : prevScroll.top) : newPre.scrollHeight;
    const newAppPre = box.querySelector('#app-logs-view');
    if (newAppPre) newAppPre.scrollTop = prevAppScroll ? (prevAppScroll.atBottom ? newAppPre.scrollHeight : prevAppScroll.top) : newAppPre.scrollHeight;

    // ── 应用日志：级别切换 + 手动刷新 ──
    if (typeof enhanceConcept2UI === 'function') enhanceConcept2UI(box);
    const appLevelSel = $('#app-log-level');
    if (appLevelSel) {
      appLevelSel.addEventListener('change', async () => {
        try {
          const r = await api('/api/logs/level', { method: 'POST', body: JSON.stringify({ level: appLevelSel.value }) });
          if (r && r.level) appLevelSel.value = r.level;
          loadSnowlumaPage({ quiet: true });
        } catch (e) {
          alert(`设置日志级别失败：${e.message}`);
        }
      });
    }
    const appLogsRefreshBtn = $('#app-logs-refresh-btn');
    if (appLogsRefreshBtn) appLogsRefreshBtn.addEventListener('click', () => loadSnowlumaPage());

    // ── 一键启动按钮事件 ──
    const quickStartBtn = $('#quick-start-btn');
    if (quickStartBtn) quickStartBtn.addEventListener('click', async () => {
      const btn = $('#quick-start-btn');
      const hint = $('#quick-start-hint');
      btn.disabled = true;
      hint.textContent = '';

      try {
        // 步骤 1：启动便携 QQ（如果未运行）
        if (!qqRunning) {
          btn.textContent = '启动 QQ 中…';
          hint.textContent = '请在弹出的 QQ 窗口扫码登录';
          const r = await api('/api/qq-portable/launch', { method: 'POST', body: '{}' });
          if (!r.ok && !r.alreadyRunning) {
            hint.textContent = `QQ 启动失败：${r.error}`;
            btn.disabled = false;
            btn.textContent = '一键启动（QQ + SnowLuma）';
            return;
          }
          // 等 3 秒让 QQ 完全启动
          await new Promise((r) => setTimeout(r, 3000));
        }

        // 步骤 2：启动 SnowLuma（如果未运行）
        if (!running) {
          btn.textContent = '启动 SnowLuma 中…';
          hint.textContent = '正在启动协议端…';
          const r = await api('/api/snowluma/launch', { method: 'POST', body: '{}' });
          if (!r.ok && !r.alreadyRunning) {
            hint.textContent = `SnowLuma 启动失败：${r.error}`;
            btn.disabled = false;
            btn.textContent = '一键启动（QQ + SnowLuma）';
            return;
          }
        }

        // 步骤 3：等待 OneBot 连接
        btn.textContent = '等待 OneBot 连接…';
        hint.textContent = '首次登录可能需要几秒到几十秒';

        // 轮询检查连接状态（最多 30 秒）
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          const s = await api('/api/status');
          if (s.onebot?.connected) {
            hint.textContent = '✅ 已连接！机器人开始工作';
            btn.textContent = '已连接 ✓';
            setTimeout(() => loadSnowlumaPage({ quiet: true }), 1500);
            return;
          }
        }
        hint.textContent = '连接超时，请检查日志或手动刷新';
        btn.disabled = false;
        btn.textContent = '重试';
      } catch (e) {
        hint.textContent = `启动失败：${e.message}`;
        btn.disabled = false;
        btn.textContent = '一键启动（QQ + SnowLuma）';
      }
    });

    // ── 便携 QQ 按钮事件 ──
    const qqStartBtn = $('#qq-start-btn');
    if (qqStartBtn) qqStartBtn.addEventListener('click', async () => {
      const btn = $('#qq-start-btn');
      btn.disabled = true; btn.textContent = '启动中…';
      $('#qq-hint').textContent = '';
      try {
        const r = await api('/api/qq-portable/launch', { method: 'POST', body: '{}' });
        $('#qq-hint').textContent = r.alreadyRunning ? '便携 QQ 已在运行 ✓' : (r.ok ? '已启动，请在弹出的 QQ 窗口扫码登录' : `启动失败：${r.error}`);
      } catch (e) {
        $('#qq-hint').textContent = `启动失败：${e.message}`;
      }
      setTimeout(() => loadSnowlumaPage({ quiet: true }), 2500);
    });
    const qqStopBtn = $('#qq-stop-btn');
    if (qqStopBtn) qqStopBtn.addEventListener('click', async () => {
      const btn = $('#qq-stop-btn');
      btn.disabled = true; btn.textContent = '关闭中…';
      $('#qq-hint').textContent = '';
      try {
        const r = await api('/api/qq-portable/stop', { method: 'POST', body: '{}' });
        $('#qq-hint').textContent = r.ok ? '已请求关闭便携 QQ' : `关闭失败：${r.error}`;
      } catch (e) {
        $('#qq-hint').textContent = `关闭失败：${e.message}`;
      }
      setTimeout(() => loadSnowlumaPage({ quiet: true }), 1500);
    });

    $('#sl-start-btn').addEventListener('click', async () => {
      const btn = $('#sl-start-btn');
      btn.disabled = true; btn.textContent = '启动中…';
      $('#sl-hint').textContent = '';
      try {
        const r = await api('/api/snowluma/launch', { method: 'POST', body: '{}' });
        $('#sl-hint').textContent = r.alreadyRunning ? 'SnowLuma 已经在运行 ✓' : (r.ok ? '已启动，日志见下方。首次 QQ 登录需要几秒到几十秒。' : `启动失败：${r.error}`);
      } catch (e) {
        $('#sl-hint').textContent = `启动失败：${e.message}`;
      }
      setTimeout(() => loadSnowlumaPage({ quiet: true }), 2500);
    });
    $('#sl-stop-btn').addEventListener('click', async () => {
      const btn = $('#sl-stop-btn');
      btn.disabled = true; btn.textContent = '关闭中…';
      $('#sl-hint').textContent = '';
      try {
        await api('/api/snowluma/stop', { method: 'POST', body: '{}' });
        $('#sl-hint').textContent = '已请求关闭 SnowLuma。';
      } catch (e) {
        $('#sl-hint').textContent = `关闭失败：${e.message}`;
      }
      setTimeout(() => loadSnowlumaPage({ quiet: true }), 1500);
    });
    $('#sl-refresh-btn').addEventListener('click', () => loadSnowlumaPage());
    $('#sl-open-folder-btn').addEventListener('click', async () => {
      try { await api('/api/snowluma/open-folder', { method: 'POST', body: '{}' }); }
      catch (e) { $('#sl-hint').textContent = `失败：${e.message}`; }
    });
    const webuiBtn = $('#sl-open-webui-btn');
    if (webuiBtn) webuiBtn.addEventListener('click', async () => {
      try {
        const r = await api('/api/snowluma/open-webui', { method: 'POST', body: '{}' });
        if (!r.ok) $('#sl-hint').textContent = r.error;
      } catch (e) {
        $('#sl-hint').textContent = `打开失败：${e.message}`;
      }
    });
  } catch (e) {
    if (!quiet) console.error(e);
  }
}
