// 〔设置渲染 / 模型目录 / 技能插件页〕——M9 拆分第 7 段
'use strict';
// ── 模型目录（多提供商；面板式选择 + 图片输入能力徽标） ──
function visionBadge(providerId, model) {
  const r = (state.visionResults || {})[`${providerId}|||${model}`];
  const src = r?.source === 'docs' ? '官方资料' : (r?.source === 'probe' ? '在线探测' : '');
  const show = state.config?.ui?.showVision !== false;
  const t = (cls, text) => `<span class="vbadge ${cls}" style="${show ? '' : 'display:none'}" title="${esc((src ? `【${src}】` : '') + (r?.note || ''))}">${text}</span>`;
  if (!r) return t('unk', '未检测');
  if (r.verdict === 'vision') return t('ok', '支持图片输入');
  if (r.verdict === 'no-vision') return t('no', '不支持图片输入');
  return t('unk', '无法判定');
}

/** 左右开关（.switch）：设置页统一勾选形态。 */
function switchHtml(id, checked, label, extra = '') {
  return `<label class="switch"${extra ? ` ${extra}` : ''}>
    <input type="checkbox" id="${id}" ${checked ? 'checked' : ''} />
    <span class="track"><span class="thumb"></span></span>
    <span>${label}</span>
  </label>`;
}

// ── 两栏悬停下拉：左供应商 / 右模型 ──
function visionVerdictOf(providerId, model) {
  return (state.visionResults || {})[`${providerId}|||${model}`]?.verdict;
}

// 说明：这里曾经有一个 bindModelDdDismiss()，目标是 #model-dd / #model-pick-btn，
// 但真正的模型选择控件 id 是 #cfg-model-pick / #cfg-model（记忆页是 #cfg-mem-model-pick），
// 那两个 id 全项目从未被创建过 —— 函数也从未被调用，属于纯死代码，已删除。
// 若将来需要一个"点击外部/Esc 收起目录"的通用行为，请在 modelModalShell 里统一实现。




/* ── DSH 隐私过滤：自定义规则的多行文本 ⇄ config.dsh.privacy.extraPatterns ──
   界面格式（一行一条）：
     名字 = 正则             默认「打码」、忽略大小写
     拒发: 名字 = 正则        命中就整条拒发
     名字 = 正则 = g         第三段是 flags（比如要区分大小写）
     # 开头 / 空行            忽略
   正则写错的行会被跳过并在输入框下面标红，不会把整份设置的保存卡住。 */
function formatPrivacyPatterns(list) {
  if (!Array.isArray(list) || !list.length) return '';
  return list.map((r) => {
    const action = r?.action === 'block' ? '拒发: ' : '';
    const id = String(r?.id || 'custom');
    const regex = String(r?.regex || '');
    const flags = String(r?.flags || 'gi');
    return `${action}${id} = ${regex} = ${flags}`;
  }).join('\n');
}

function parsePrivacyPatterns(text) {
  const list = [];
  const errors = [];
  String(text || '').split(/\r?\n/).forEach((rawLine, idx) => {
    const line = String(rawLine || '').trim();
    if (!line || line.startsWith('#')) return;
    const lineNo = idx + 1;
    let action = 'redact';
    let body = line;
    const m = line.match(/^(打码|拒发|redact|block)\s*[:：]\s*(.+)$/i);
    if (m) {
      action = /^(拒发|block)$/i.test(m[1]) ? 'block' : 'redact';
      body = m[2].trim();
    }
    const parts = body.split('=').map((s) => s.trim());
    let id = '';
    let regex = '';
    let flags = 'gi';
    if (parts.length === 1) {
      regex = parts[0];
    } else {
      id = parts[0];
      regex = parts.slice(1).join('=');
      // 只有「正好三段」且第三段长得像 flags 时才当 flags —— 正则里带 = 也不会被拆坏
      if (parts.length === 3 && /^[gimsuy]{1,6}$/.test(parts[2])) {
        regex = parts[1];
        flags = parts[2];
      }
    }
    if (!regex) {
      errors.push(`第 ${lineNo} 行：只写了名字，没有正则`);
      return;
    }
    if (!id) id = `custom-${list.length + 1}`;
    try {
      new RegExp(regex, flags);
    } catch (e) {
      errors.push(`第 ${lineNo} 行：正则不合法（${e.message}）`);
      return;
    }
    const rule = { id, regex, flags, action };
    if (action === 'redact') rule.replace = `[已隐去:${id}]`;
    list.push(rule);
  });
  return { list, errors };
}

function privacyPatternsHint(list) {
  const items = Array.isArray(list) ? list : [];
  if (!items.length) return '留空 = 不使用自定义规则。';
  return '✓ 识别到 ' + items.length + ' 条规则：'
    + items.map((r) => esc(String(r?.id || '') + (r?.action === 'block' ? '(拒发)' : '(打码)'))).join('、');
}

function renderSettingsSidebar() {
  const s = state.status;
  const sidebar = $('#settings-sidebar');
  if (!sidebar) return;
  const menu = [
    ['api', '模型 API'],
    ['search', '搜索服务'],
    ['memory', '记忆'],
    ['persona', '人设'],
    ['allow', '聊天白名单'],
    ['chat', '聊天设置'],
    ['desktop', '桌面端'],
    ['onebot', 'OneBot（SnowLuma）'],
    ['tools', '工具与技能']
  ];
  sidebar.innerHTML = `
    <div class="settings-runstate">
      <div class="rs-title">机器人运行状态</div>
      <div class="rs-row"><span class="dot ${s?.onebot?.connected ? 'dot-on' : 'dot-off'}"></span><span>${s?.onebot?.connected ? '运行中' : '未就绪'}</span></div>
      <div class="rs-row muted">${state.paused ? '⏸ 已暂停' : (s?.orchestrator?.model ? `模型：${esc(s.orchestrator.model)}` : '模型：未设置')}</div>
    </div>
    <div class="settings-menu">
      ${menu.map(([id, label]) => `<button class="settings-menu-item ${state.settingsSection === id ? 'active' : ''}" data-section="${id}">${label}${id === 'desktop' && (typeof updateAvailable !== 'undefined' && updateAvailable) ? '<span class="update-dot" title="发现新版本"></span>' : ''}</button>`).join('')}
      <button class="settings-menu-item egg-hot" id="qrcode-egg-btn">！？群群？！</button>
    </div>`;
  // 群二维码彩蛋：点一下弹出，再点屏幕任意位置关闭
  // 图片 onerror 兜底：group-qrcode.jpg 正常随 ui/ 分发，
  // 万一分发包缺了这张图，显示一句说明而不是一个裂图图标。
  sidebar.querySelector('#qrcode-egg-btn')?.addEventListener('click', () => {
    const ov = document.createElement('div');
    ov.className = 'qrcode-egg-overlay';
    ov.innerHTML = '<img src="group-qrcode.jpg" alt="群二维码" '
      + 'onerror="this.remove(); this.parentElement?.insertAdjacentText(\'afterbegin\', \'二维码图片缺失：请把 group-qrcode.jpg 放到 ui/ 目录下\')" />';
    const close = () => closeAnimatedOverlay(ov);
    ov.addEventListener('click', close);
    document.body.appendChild(ov);
  });
  sidebar.querySelectorAll('.settings-menu-item').forEach((el) => {
    el.addEventListener('click', () => {
      // 切区块 = 整页表单重建：先把防抖窗口内挂起的保存发出，
      // 否则刚输入的内容直接被重渲染吹掉（与切页签同一条防线）。
      flushSettingsSaves();
      state.settingsSection = el.dataset.section;
      renderSettingsSidebar();
      renderSettings();
      // 切设置分区 = 整页表单重建：新内容淡入（对齐 concept2 的 pane 切换）
      uiEnter($('#settings-form'));
    });
  });
}

function renderSettings() {
  // 渲染守卫：自动保存进行中（表单正在被读取 / state.config 即将被覆盖）时
  // 不允许重建表单 DOM —— 会吹掉用户正在输入的未保存内容。
  // 拦下的请求由 endSettingsGuard() 在保存完成后补放。
  if (settingsGuard.pending > 0) {
    settingsGuard.needRerender = true;
    return;
  }
  // 焦点保护（2026-09-19 修"文本框偶发点不进/失焦"）：守卫只护住"保存进行中"的
  // 窗口，但守卫之外仍有一批异步重渲染（群名补底 / 视觉扫描完成 / 技能开关保存 /
  // 守卫补放的延迟渲染）会在用户打字途中重建 innerHTML —— 焦点、光标位置、
  // 未落盘的输入值全部被吹掉。这里在重建前后做"焦点与选区快照恢复"：
  //   ① 记下正在聚焦的输入框 id + 光标位置 + 当前值；
  //   ② 重建后按 id 找回元素，把值写回（渲染用的是 state.config，可能还没
  //      带上防抖窗口内的输入），恢复焦点与光标。
  const box = $('#settings-form');
  // 滚动位置保持：innerHTML 重建会把阅读位置弹回顶部（也是一次大滚动跳转，
  // 会加剧深滚动下的合成错位）。重建后原样恢复。
  const prevScrollTop = box ? box.scrollTop : 0;
  const focusSnap = (() => {
    const el = document.activeElement;
    if (!box || !el || el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT') return null;
    if (el.type === 'checkbox' || el.type === 'radio' || !box.contains(el)) return null;
    return {
      id: el.id,
      selStart: el.selectionStart ?? null,
      selEnd: el.selectionEnd ?? null,
      value: el.value
    };
  })();
  const c = state.config;
  renderSettingsSidebar();
  try {
    box.innerHTML = `
    ${renderSettingsSection(c)}`;
    // 先折叠收纳再绑事件：autoFold 会搬 DOM，但节点上的监听会跟着节点走；
    // 挂在 #settings-form 上的委托不受影响。放后面绑定则能找到最终结构。
    if (typeof enhanceConcept2UI === 'function') enhanceConcept2UI(box);
    bindSettingsEvents(c);
    if (box && prevScrollTop) box.scrollTop = prevScrollTop;
  } catch (err) {
    // 单个设置区渲染失败不能让整页空白 —— 显示错误占位，其余页签仍可用
    console.error('[settings] 渲染失败:', err);
    box.innerHTML = `<div class="empty-hint">设置页渲染失败：${esc(err?.message || err)}<br />可切换其它页签，或刷新后重试。</div>`;
    return;
  }
  if (focusSnap?.id) {
    const back = box.querySelector('#' + focusSnap.id);
    if (back && (back.tagName === 'INPUT' || back.tagName === 'TEXTAREA')) {
      try {
        back.value = focusSnap.value;   // 覆盖渲染值：防抖窗口内的输入不被回滚
        if (focusSnap.selStart != null) back.setSelectionRange(focusSnap.selStart, focusSnap.selEnd ?? focusSnap.selStart);
        back.focus({ preventScroll: true });
      } catch { /* 恢复失败不致命 */ }
    }
  }
  // 群名补底（一次性）：分群按钮/活跃设置下拉第一次渲染时 state.chats 可能还没到
  // （switchTab 只在列表为空时才拉）。这里发现为空就补拉，到达后重渲染一次。
  if (!(state.chats || []).length && !renderSettings.__chatsFetch) {
    renderSettings.__chatsFetch = true;
    api('/api/chats').then((d) => {
      if ((d.chats || []).length && state.tab === 'settings') renderSettings();
    }).catch(() => {}).finally(() => { renderSettings.__chatsFetch = false; });
  }
  // 设置页渲染完自动回填「有新版本」详情（启动时的检查早于页面渲染，DOM 当时还不存在）
  try {
    if (typeof showUpdateDetail === 'function' && state.webUpdateInfo !== false) {
      const info = state.updateInfo;
      if (info && info.hasUpdate) {
        setTimeout(() => {
          if (state.tab === 'settings') {
            const box = document.getElementById('update-detail');
            if (box && box.style.display === 'none') showUpdateDetail(info);
          }
        }, 60);
      }
    }
  } catch (e) { /* ignore */ }

}

function renderSettingsSection(c) {
  const sec = state.settingsSection || 'api';
  const sections = {
    api: () => renderApiSection(c),
    search: () => renderSearchSection(c),
    memory: () => renderMemorySettingsSection(c),
    persona: () => renderPersonaSectionV2(c),
    allow: () => renderAllowSection(c),
    chat: () => renderChatSection(c),
    desktop: () => renderDesktopSection(c),
    onebot: () => renderOnebotSection(c),
    tools: () => renderToolsSection(c)
  };
  const render = sections[sec] || sections.api;
  return `
    ${render()}`;
}
function renderApiSection(c) {
  const currentProvider = (state.providers || []).find((p) => p.id === c.api.provider);
  const currentModelDisplay = (currentProvider?.modelNames || {})[c.api.model] || c.api.model;
  // 专用模型的显示名：跨提供商选择时也能读出目录名（找不到就显示裸 id）
  const displayOf = (modelId) => {
    const m = String(modelId || '').trim();
    if (!m) return '';
    for (const p of (state.providers || [])) {
      if ((p.modelNames || {})[m]) return `${p.modelNames[m]}`;
    }
    return m;
  };
  const visionModelDisplay = displayOf(c.api.visionModel);
  const videoModelDisplay = displayOf(c.api.videoModel);
  const sc = (typeof setCard === 'function') ? setCard : (o) => `<div class="setcard">${o.body}</div>`;
  return `
    <h3 id="settings-api">模型 API</h3>
    <p class="setsub">选渠道、配降级、算成本 —— 常用项内联，低频项点开折叠卡</p>
    ${sc({
      id: 'card-api-model',
      icon: '🔑',
      title: '模型与渠道',
      sub: '提供商 / 模型 / BaseURL',
      val: esc(c.api.model || '未选模型'),
      open: true,
      body: `
    <div class="field">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="open-model-config-btn">⚙ 模型配置</button>
        <button class="btn" id="open-model-manage-btn">🗂 模型管理</button>
      </div>
      <div class="hint" id="provider-hint" style="margin-top:6px">${currentProvider ? `当前：${esc(currentProvider.displayName)} · ${esc(c.api.model || '未选模型')} @ ${esc(currentProvider.baseURL)}${currentProvider.hasKey ? ' · 已保存 API Key（不显示）' : ' · 未保存 API Key'}` : '尚未选择模型'}</div>
      <div class="hint" id="model-vision-hint" style="margin-top:6px"></div>
      <input type="hidden" id="cfg-provider" value="${esc(c.api.provider || '')}" />
      <input type="hidden" id="cfg-model" value="${esc(c.api.model || '')}" />
      <input type="hidden" id="cfg-baseurl-value" value="${esc(c.api.baseUrl)}" />
    </div>`
    })}
    ${sc({
      id: 'card-api-fallback',
      icon: '🔄',
      gray: true,
      title: '备选模型（故障自动降级）',
      sub: '主模型失败后按顺序重试 · 留空不启用',
      body: `
    <div id="fallback-model-rows"></div>
    <div style="display:flex;gap:8px;margin-top:6px">
      <button class="btn btn-small" id="add-fallback-row-btn">＋ 添加备选模型</button>
    </div>`
    })}
    ${sc({
      id: 'card-api-price',
      icon: '💰',
      gray: true,
      title: '成本核算',
      sub: '官方价表 / 当前单价 / 批量自定义',
      body: `
    <div class="checkbox-row">${switchHtml('cfg-useofficialprice', c.api.useOfficialPrice !== false, '用内置官方价格表估算（按模型 id 自动匹配；走中转站请关掉）')}</div>

    <div class="field" style="margin-top:6px"><label>远程价格表</label>
      <div style="display:flex;align-items:center;gap:8px">
        <span class="muted">官网统一价格表</span>
        <button class="btn btn-small" id="price-feed-refresh-btn" title="从官网拉取最新价格表">拉取价格表</button>
      </div>
      <div class="hint" id="price-feed-status" style="margin-top:4px"></div>
    </div>

    <div class="price-card" id="model-price-card">
      <div class="pc-head">
        <span class="pc-title">当前模型单价</span>
        <span class="pc-model" id="pc-model">${esc(c.api.model || '（未选择模型）')}</span>
      </div>
      <div class="pc-rows">
        <div class="pc-row"><span class="pc-label">输入</span>
          <input type="number" id="cfg-price-in" step="0.01" min="0" value="0" /><span class="pc-unit">元/百万</span></div>
        <div class="pc-row"><span class="pc-label">输出</span>
          <input type="number" id="cfg-price-out" step="0.01" min="0" value="0" /><span class="pc-unit">元/百万</span></div>
        <div class="pc-row"><span class="pc-label">缓存命中</span>
          <input type="number" id="cfg-price-cached" step="0.01" min="0" value="0" /><span class="pc-unit">元/百万</span></div>
      </div>
      <div class="pc-note" id="pc-note"></div>
    </div>

    <div style="display:flex;gap:8px;margin:8px 0">
      <button class="btn btn-small" id="batch-price-btn">批量自定义价格编辑</button>
      <span class="muted" style="font-size:12px;align-self:center">为多个模型分别设定单价</span>
    </div>`
    })}`;
}


function renderSearchSection(c) {
  // 每个提供方区块的初始显隐都要跟当前 provider 一致
  const prov = String(c.webSearch?.provider || 'bing');
  // 自定义搜索提供商列表（可多个），用于动态生成下拉框选项
  const customProvs = Array.isArray(c.webSearch?.providers) ? c.webSearch.providers : [];
  return `
    <h3 id="settings-search">搜索服务</h3>
    <div class="hint" style="margin-bottom:12px">
      当前提供方：${prov === 'bing' ? 'Bing 网页解析' : prov === 'deepseek' ? 'DeepSeek 原生搜索' : prov === 'zhipu' ? '智谱 Web Search' : prov === 'bocha' ? '博查 AI Search' : prov === 'baidu' ? '百度千帆 AI Search' : prov === 'metaso' ? '秘塔 AI 搜索' : '自定义'}
      ${(() => {
        // 当前提供方已保存的 Key 状态（与模型 API 页同款提示口径）
        const keyState = {
          deepseek: c.webSearch?.deepseek?.hasApiKey,
          zhipu: c.webSearch?.zhipu?.hasApiKey,
          bocha: c.webSearch?.bocha?.hasApiKey,
          baidu: c.webSearch?.baidu?.hasApiKey,
          metaso: c.webSearch?.metaso?.hasApiKey
        }[prov];
        if (prov === 'bing') return ' · 无需 API Key';
        if (prov?.startsWith('custom:')) return '';
        return keyState ? ' · 已保存 API Key（不显示）' : ' · 未保存 API Key';
      })()}
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-websearch" ${c.webSearch?.enabled !== false ? 'checked' : ''} />
      <label for="cfg-websearch">联网搜索：启用 web_search / web_fetch 工具</label></div>
    <div class="field"><label>搜索提供方</label>
      <select id="cfg-searchprovider">
        <option value="bing" ${prov === 'bing' ? 'selected' : ''}>Bing 网页解析</option>
        <option value="deepseek" ${prov === 'deepseek' ? 'selected' : ''}>DeepSeek 原生搜索</option>
        <option value="zhipu" ${prov === 'zhipu' ? 'selected' : ''}>智谱 Web Search</option>
        <option value="bocha" ${prov === 'bocha' ? 'selected' : ''}>博查 AI Search</option>
        <option value="baidu" ${prov === 'baidu' ? 'selected' : ''}>百度千帆 AI Search</option>
        <option value="metaso" ${prov === 'metaso' ? 'selected' : ''}>秘塔 AI 搜索</option>
        ${customProvs.map((p) => `<option value="custom:${esc(p.id)}" ${prov === `custom:${p.id}` ? 'selected' : ''}>${esc(p.name || p.baseUrl)}（自定义 · ${p.type === 'bing' ? '网页解析' : 'JSON 接口'}）</option>`).join('')}
      </select></div>
    <div class="field" id="custom-provider-manage" style="${prov.startsWith('custom:') ? '' : 'display:none'}">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        <button class="btn btn-small" id="test-search-provider-btn">测试这个搜索服务</button>
        <button class="btn btn-small btn-danger" id="del-search-provider-btn">删除这个搜索服务</button>
        <span id="search-provider-action-hint" class="muted" style="font-size:12px"></span>
      </div>
      <label>API Key${(() => {
        const cp = customProvs.find((p) => `custom:${p.id}` === prov);
        return cp?.hasApiKey ? '（已保存，可查看/替换/清除）' : '（未保存；多数自建服务留空即可）';
      })()}</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-custom-sp-key" value="${esc(customProvs.find((p) => `custom:${p.id}` === prov)?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-custom-sp-key-toggle" type="button">显示</button>
        <button class="btn btn-small btn-danger" id="cfg-custom-sp-key-clear" type="button" title="清除已保存的 API Key（留空保存并不会清除，必须点这个按钮）">清除密钥</button>
      </div>
    </div>
    <div class="field" id="bing-search-fields" style="${prov === 'bing' ? '' : 'display:none'}"><label>搜索地址（高级：可替换为兼容 Bing 结果格式的引擎）</label><input type="text" id="cfg-searchurl" value="${esc(c.webSearch?.searchUrl || 'https://cn.bing.com/search')}" /></div>
    <div class="field-row" id="deepseek-search-fields" style="${prov === 'deepseek' ? '' : 'display:none'}">
      <div class="field"><label>DeepSeek 搜索 API Key（留空用环境变量 DEEPSEEK_API_KEY）</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-ds-searchkey" value="${esc(c.webSearch?.deepseek?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-ds-searchkey-toggle" type="button">显示</button>
          <button class="btn btn-small btn-danger" id="cfg-ds-searchkey-clear" type="button" title="清除已保存的 API Key（留空保存并不会清除，必须点这个按钮）">清除密钥</button>
        </div></div>
      <div class="field"><label>模型</label><input type="text" id="cfg-ds-searchmodel" value="${esc(c.webSearch?.deepseek?.model || 'deepseek-v4-flash')}" /></div>
    </div>
    <div class="field-row" id="zhipu-search-fields" style="${prov === 'zhipu' ? '' : 'display:none'}">
      <div class="field"><label>智谱 API Key（留空用环境变量 ZHIPU_API_KEY）</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-zhipu-key" value="${esc(c.webSearch?.zhipu?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-zhipu-key-toggle" type="button">显示</button>
          <button class="btn btn-small btn-danger" id="cfg-zhipu-key-clear" type="button" title="清除已保存的 API Key（留空保存并不会清除，必须点这个按钮）">清除密钥</button>
        </div></div>
      <div class="field"><label>搜索引擎</label>
        <select id="cfg-zhipu-engine">
          <option value="search_std" ${c.webSearch?.zhipu?.engine === 'search_std' ? 'selected' : ''}>基础版 ¥0.01/次</option>
          <option value="search_pro" ${c.webSearch?.zhipu?.engine === 'search_pro' ? 'selected' : ''}>高级版 ¥0.03/次</option>
          <option value="search_pro_sogou" ${c.webSearch?.zhipu?.engine === 'search_pro_sogou' ? 'selected' : ''}>搜狗版 ¥0.05/次</option>
          <option value="search_pro_quark" ${c.webSearch?.zhipu?.engine === 'search_pro_quark' ? 'selected' : ''}>夸克版 ¥0.05/次</option>
        </select></div>
    </div>
    <div class="field" id="bocha-search-fields" style="${prov === 'bocha' ? '' : 'display:none'}">
      <label>博查 API Key</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-bocha-key" value="${esc(c.webSearch?.bocha?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-bocha-key-toggle" type="button">显示</button>
        <button class="btn btn-small btn-danger" id="cfg-bocha-key-clear" type="button" title="清除已保存的 API Key（留空保存并不会清除，必须点这个按钮）">清除密钥</button>
      </div></div>
    <div class="field" id="baidu-search-fields" style="${prov === 'baidu' ? '' : 'display:none'}">
      <label>百度千帆 API Key（留空用环境变量 BAIDU_SEARCH_API_KEY）</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-baidu-key" value="${esc(c.webSearch?.baidu?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-baidu-key-toggle" type="button">显示</button>
        <button class="btn btn-small btn-danger" id="cfg-baidu-key-clear" type="button" title="清除已保存的 API Key（留空保存并不会清除，必须点这个按钮）">清除密钥</button>
      </div></div>
    <div class="field" id="metaso-search-fields" style="${prov === 'metaso' ? '' : 'display:none'}">
      <label>秘塔 API Key（可选，留空用官方免费额度 / 环境变量 METASO_API_KEY）</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-metaso-key" value="${esc(c.webSearch?.metaso?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-metaso-key-toggle" type="button">显示</button>
        <button class="btn btn-small btn-danger" id="cfg-metaso-key-clear" type="button" title="清除已保存的 API Key（留空保存并不会清除，必须点这个按钮）">清除密钥</button>
      </div></div>

    <h3>添加自定义搜索服务</h3>
    <div class="field-row">
      <div class="field"><label>名称（自己辨认用）</label>
        <input type="text" id="new-sp-name" placeholder="例如：自建 SearXNG" /></div>
      <div class="field"><label>类型</label>
        <select id="new-sp-type">
          <option value="openai">JSON 搜索接口（POST）</option>
          <option value="bing">网页解析（Bing 结果格式）</option>
        </select></div>
    </div>
    <div class="field"><label>接口地址 / 搜索页地址</label>
      <input type="text" id="new-sp-baseurl" placeholder="JSON 类型：https://your-search.example.com/search；网页类型：https://your-searx.example.com/search" style="width:100%" /></div>
    <div class="field-row">
      <div class="field"><label>API Key（可选）</label>
        <input type="password" id="new-sp-apikey" placeholder="多数自建服务留空即可" autocomplete="new-password" style="width:100%" /></div>
      <div class="field"><label>模型名（可选）</label>
        <input type="text" id="new-sp-model" placeholder="Responses API 风格才需要" /></div>
    </div>
    <div style="display:flex;gap:8px;align-items:center;margin:8px 0">
      <button class="btn btn-small" id="add-search-provider-btn">＋ 添加并选中</button>
      <span id="add-search-provider-hint" class="muted" style="font-size:12px"></span>
    </div>
  `;
}

  function renderMemorySettingsSection(c) {
    return renderMemorySettingsSectionInner(c);
  }
  function renderMemorySettingsSectionInner(c) {
  const mem = c.memory || {};
  const providers = state.providers || [];
  const useChat = mem.useChatModel !== false;
  const selP = providers.find((p) => p.id === mem.provider);
  const currentDisplay = selP ? `${selP.displayName || selP.id} · ${mem.model || '未选模型'}` : (mem.model || '未选模型');
  return `
    <h3 id="settings-memory">记忆整理</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-mem-consolidate" ${mem.consolidateEnabled !== false ? 'checked' : ''} />
      <label for="cfg-mem-consolidate">启用记忆自动整理</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-mem-usechat" ${useChat ? 'checked' : ''} />
      <label for="cfg-mem-usechat">使用与聊天机器人相同的模型</label></div>
    <div id="mem-model-box" style="${useChat ? 'display:none' : ''}">
      <div class="field"><label>记忆整理模型（点击选择）</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="cfg-mem-model-pick" readonly placeholder="点击选择模型" value="${esc(currentDisplay)}" style="flex:1;cursor:pointer" />
        </div>
        <div class="hint" id="mem-model-hint">${selP ? `当前：${esc(selP.displayName)} @ ${esc(selP.baseURL)}` : '尚未选择专用模型'}</div>
        <input type="hidden" id="cfg-mem-provider" value="${esc(mem.provider || '')}" />
        <input type="hidden" id="cfg-mem-model" value="${esc(mem.model || '')}" />
      </div>
    </div>
    <div class="field"><label>整理冷却时间（毫秒）</label><input type="number" id="cfg-mem-interval" min="1800000" step="600000" value="${esc(mem.consolidateMinIntervalMs ?? 21600000)}" /></div>
    <div class="hint">条数超过阈值且距上次整理超过该冷却时间后，才会在运行结束后后台整理。默认 6 小时（21600000 毫秒）。</div>`;
}

  // ═══ 记忆 V2：群聊 / 个人 / 基本事实 ═══
  const MEM_TABS = [{ id: 'groups', label: '群聊/私聊' }, { id: 'persons', label: '个人' }, { id: 'general', label: '基本事实' }];
  // 记忆相关操作后的重渲染：记忆 tab 走 loadMemoryView，设置页走 loadSettings
  async function memRerender() {
    try {
      if (state.tab === 'memory' && typeof loadMemoryView === 'function') { await loadMemoryView(); return; }
      if (typeof loadSettings === 'function') await loadSettings();
    } catch (e) { /* 静默 */ }
  }
  function memState() {
    if (!state.memV2) state.memV2 = { tab: 'groups', list: null, sel: null, detail: null, q: '' };
    return state.memV2;
  }
  function memLineList(title, arr, fmt, emptyText) {
    const body = (arr || []).length ? arr.map(fmt).join('') : '<div class="muted" style="font-size:12px">' + (emptyText || '（空）') + '</div>';
    return '<div class="field"><label>' + title + '</label><div class="muted" style="font-size:13px;line-height:1.7">' + body + '</div></div>';
  }
  function memDetailHtml() {
    const st = memState();
    const d = st.detail;
    if (!d) return '<div class="muted" style="padding:20px">从左侧选一项</div>';
    const key = st.tab === 'persons' ? 'person/' + d.qq : (st.tab === 'groups' ? 'group/' + encodeURIComponent(d.chatKey) : 'general');
    const facts = (d.facts || []).map((f) => esc(f.key || '') + '=' + esc(f.value || '')).join('\n');
    const notes = (d.notes || []).join('\n');
    const prefs = (d.prefs || []).map((x) => esc(x.what || x.text || JSON.stringify(x))).join('\n');
    const pending = (d.pending || []).map((x) => esc(x.text || JSON.stringify(x))).join('\n');
    const members = (d.members || []).map((m) => esc(m.name || m.id) + ' · ' + (m.msgs || 0) + ' 条').join('、');
    const groupsOf = (d.groups || []).map((g) => esc(g.chatKey) + ' · ' + (g.msgs || 0) + ' 条').join('\n');
    return `
      ${st.tab === 'persons' ? '<div class="hint">QQ：' + esc(d.qq || '') + '（主键，改昵称不影响）</div>' : ''}
      <div class="field"><label>名称（昵称，可改）</label><input type="text" id="memv-name" value="${esc(d.name || '')}" /></div>
      <div class="field"><label>一句话概览</label><input type="text" id="memv-summary" value="${esc(d.summary || '')}" /></div>
      ${st.tab === 'persons' ? '<div class="field"><label>语气/关系（可选）</label><input type="text" id="memv-tone" value="' + esc(d.tone || '') + '" /></div>' : ''}
${st.tab === 'persons' ? memImpressionsHtml(d) : ''}
      <div class="field"><label>事实（一行一条，key=value）</label><textarea id="memv-facts" class="persona-role-text" style="min-height:110px">${facts}</textarea></div>
${st.tab === 'general' ? memScopeHtml(d) : ''}
      ${st.tab === 'persons' ? '<div class="field"><label>偏好（一行一条）</label><textarea id="memv-prefs" class="persona-role-text" style="min-height:80px">' + prefs + '</textarea></div>' : ''}
      ${st.tab === 'persons' ? '<div class="field"><label>待办/约定（一行一条）</label><textarea id="memv-pending" class="persona-role-text" style="min-height:70px">' + pending + '</textarea></div>' : ''}
      ${st.tab === 'general' ? '' : (st.tab === 'groups' ? '<div class="field"><label>成员（点名字跳到个人卡）</label><div style="font-size:13px;line-height:1.9">' + ((d.members || []).map((m) => '<a class="mem-link" href="#" data-mem="sel" data-json=\'' + esc(JSON.stringify({ tab: 'persons', qq: m.id })) + '\'>' + esc(m.name || m.id) + '</a> · ' + (m.msgs || 0) + ' 条').join('　') || '<span class="muted">（空）</span>') + '</div></div>' : '<div class="field"><label>所在群聊/私聊（点名字跳到会话卡）</label><div style="font-size:13px;line-height:1.9">' + ((d.groups || []).map((g) => '<a class="mem-link" href="#" data-mem="sel" data-json=\'' + esc(JSON.stringify({ tab: 'groups', chatKey: g.chatKey })) + '\'>' + esc((g.kind === 'private' ? '私聊 ' : '群 ') + (g.name || g.chatKey)) + '</a> · ' + (g.msgs || 0) + ' 条').join('　') || '<span class="muted">（空）</span>') + '</div></div>')}
      <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
        <button class="btn btn-small btn-primary" data-mem="save" data-key="${esc(key)}">保存</button>
        ${st.tab === 'persons' ? '<button class="btn btn-small btn-danger" data-mem="del" data-qq="' + esc(d.qq) + '">删除这张卡</button>' : ''}
        <span class="hint" id="memv-hint"></span>
      </div>`;
  }
  // 个人卡三层印象（通用 / 群聊 / 私聊）
  function memImpressionsHtml(d) {
    const imp = d.impressions || {};
    const byChat = imp.byChat || {};
    const block = (entries, kind) => entries.map(([k, list]) =>
      '<div class="field" style="margin-top:6px"><label style="font-size:12px">' + (kind === 'group' ? '群聊：' : '私聊：') + esc(k) + '</label>' +
      '<textarea class="memv-imp" data-chat="' + esc(k) + '" style="min-height:64px">' + esc((list || []).join(String.fromCharCode(10))) + '</textarea></div>'
    ).join('') || '<div class="muted" style="font-size:12px">（无）</div>';
    const gs = Object.entries(byChat).filter(([k]) => String(k).startsWith('group:'));
    const ps = Object.entries(byChat).filter(([k]) => String(k).startsWith('private:'));
    return '<div class="field"><label>通用印象（跨群）</label><textarea id="memv-imp-general" style="min-height:64px">' + esc(imp.general || '') + '</textarea></div>' +
      '<div class="field"><label>群聊印象</label>' + block(gs, 'group') + '</div>' +
      '<div class="field"><label>私聊印象</label>' + block(ps, 'private') + '</div>';
  }
  // 印象调用方式选择（基本事实 tab）
  function memScopeHtml(d) {
    const cur = d.impressionScope || 'auto';
    return '<div class="field"><label>个人印象的调用方式</label><select id="memv-scope">' +
      '<option value="auto"' + (cur === 'auto' ? ' selected' : '') + '>自动（通用印象 + 当前会话的印象）</option>' +
      '<option value="all"' + (cur === 'all' ? ' selected' : '') + '>全部（通用 + 所有群聊/私聊印象）</option>' +
      '<option value="model"' + (cur === 'model' ? ' selected' : '') + '>由模型自己调（需要时用工具查）</option>' +
      '</select><div class="hint">只影响注入提示词时带多少印象；不影响界面里看到的全部内容。</div></div>';
  }

  function renderMemorySectionV2(c) {
    const st = memState();
    if (!st.list) {
      // 首次进入：异步拉列表
      setTimeout(async () => {
        try {
          const d = await api('/api/memory-cards');
          st.list = d;
          if (!st.sel) {
            if (st.tab === 'groups' && (d.groups || [])[0]) st.sel = { tab: 'groups', chatKey: d.groups[0].chatKey, name: d.groups[0].name };
            else if (st.tab === 'persons' && (d.persons || [])[0]) st.sel = { tab: 'persons', qq: d.persons[0].qq, name: d.persons[0].name };
            else if (st.tab === 'general') st.sel = { tab: 'general' };
          }
          await memLoadDetail();
          if (state.tab === 'memory') memRerender();
        } catch (e) { /* 静默 */ }
      }, 30);
      return '<h3 id="settings-memory">记忆</h3><div class="hint">加载记忆卡…</div>';
    }
    const d = st.list;
    const q = String(st.q || '').trim().toLowerCase();
    let items = [];
    if (st.tab === 'groups') items = (d.groups || []).map((g) => ({ key: 'g:' + g.chatKey, label: g.name || g.chatKey, sub: (g.summary || '') , sel: st.sel && st.sel.tab === 'groups' && st.sel.chatKey === g.chatKey, data: { tab: 'groups', chatKey: g.chatKey } }));
    else if (st.tab === 'persons') items = (d.persons || []).map((p) => ({ key: 'p:' + p.qq, label: (p.name || '') + ' (' + p.qq + ')', sub: (p.summary || '') + ' · 群' + (p.groups || 0), sel: st.sel && st.sel.tab === 'persons' && st.sel.qq === p.qq, data: { tab: 'persons', qq: p.qq } }));
    else items = [{ key: 'general', label: '通用卡', sub: d.general?.summary || '', sel: true, data: { tab: 'general' } }];
    if (q) items = items.filter((x) => (x.label + ' ' + x.sub).toLowerCase().includes(q));
    const listHtml = items.map((x) => `<div class="memv-item${x.sel ? ' memv-sel' : ''}" data-mem="sel" data-json='${esc(JSON.stringify(x.data))}'>
        <div style="font-weight:600">${esc(x.label)}</div>
        <div class="muted" style="font-size:12px">${esc(String(x.sub).slice(0, 60))}</div>
      </div>`).join('') || '<div class="muted" style="padding:12px">（没有匹配项）</div>';
    const stats = `群 ${(d.groups || []).length} · 个人 ${(d.persons || []).length}`;
    return `
      <h3 id="settings-memory">记忆</h3>
      <div class="hint">记忆按<b>群聊 / 个人 / 基本事实</b>三类卡片管理；未分配的内容不会注入提示词。</div>
      <div style="display:flex;gap:8px;margin:10px 0;flex-wrap:wrap;align-items:center">
        ${MEM_TABS.map((t) => `<button class="btn btn-small ${st.tab === t.id ? 'btn-primary' : ''}" data-mem="tab" data-tab="${t.id}">${t.label}</button>`).join('')}
        <input type="text" id="memv-q" placeholder="搜索名称/概览…" value="${esc(st.q || '')}" style="flex:1;min-width:160px" />
        <span class="muted" style="font-size:12px">${stats}</span>
      </div>
      <div style="display:flex;gap:12px;align-items:flex-start">
        <div style="width:230px;flex-shrink:0;max-height:480px;overflow:auto;border:1px solid var(--line);border-radius:6px" id="memv-list">${listHtml}</div>
        <div style="flex:1;min-width:0" id="memv-detail">${memDetailHtml()}</div>
      </div>
      <details style="margin-top:16px"><summary class="muted" style="cursor:pointer">记忆整理设置（旧：按群整理印象）</summary>
        <div style="padding-top:10px">${renderMemorySettingsSectionInner(c)}</div>
      </details>`;
  }
  async function memLoadDetail() {
    const st = memState();
    try {
      if (st.tab === 'persons' && st.sel?.qq) {
        const r = await api('/api/memory-cards/person/' + encodeURIComponent(st.sel.qq));
        st.detail = r.card;
      } else if (st.tab === 'groups' && st.sel?.chatKey) {
        const r = await api('/api/memory-cards/group/' + encodeURIComponent(st.sel.chatKey));
        st.detail = r.card;
      } else {
        const r = await api('/api/memory-cards/general');
        st.detail = r.card;
      }
    } catch (e) { st.detail = null; }
  }
  function memParseLines(text) {
    return String(text || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  }
  async function memSave(key, st) {
    const g = (id) => document.getElementById(id);
    const body = {};
    if (g('memv-name')) body.name = g('memv-name').value;
    if (g('memv-summary')) body.summary = g('memv-summary').value;
    if (st.tab === 'persons') {
      if (g('memv-tone')) body.tone = g('memv-tone').value;
    // 笔记已拆进 impressions.byChat，不再单独保存 body.notes
      if (g('memv-prefs')) body.prefs = memParseLines(g('memv-prefs').value).map((x) => ({ what: x }));
      if (g('memv-pending')) body.pending = memParseLines(g('memv-pending').value).map((x) => ({ text: x, status: 'open' }));
    }
    if (st.tab === 'persons') {
      const generalEl = document.getElementById('memv-imp-general');
      const byChat = {};
      document.querySelectorAll('.memv-imp').forEach((el) => {
        const list = String(el.value || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
        if (list.length) byChat[el.dataset.chat] = list;
      });
      if (generalEl) body.impressions = { general: generalEl.value, byChat };
    }
    if (st.tab === 'general') {
      const sc = document.getElementById('memv-scope');
      if (sc) body.impressionScope = sc.value;
    }
    if (g('memv-facts')) {
      body.facts = memParseLines(g('memv-facts').value).map((line) => {
        const i = line.indexOf('=');
        return i > 0 ? { key: line.slice(0, i).trim(), value: line.slice(i + 1).trim() } : { key: line, value: '' };
      });
    }
    try {
      await api('/api/memory-cards/' + key, { method: 'PUT', body: JSON.stringify(body) });
      const hint = document.getElementById('memv-hint');
      if (hint) { hint.textContent = '已保存 ✅'; hint.style.color = 'var(--green)'; }
      const st2 = memState();
      await memLoadDetail();
      st2.list = null;   // 让列表下次重拉
      setTimeout(() => { if (state.tab === 'memory') memRerender(); }, 300);
    } catch (e) {
      const hint = document.getElementById('memv-hint');
      if (hint) { hint.textContent = '保存失败：' + (e?.message || e); hint.style.color = 'var(--red)'; }
    }
  }
  // 事件委托（CSP 禁内联 onclick）
  if (!window.__memvDelegated) {
    window.__memvDelegated = true;
    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-mem]');
      if (!el) return;
      const act = el.dataset.mem;
      const st = memState();
      if (act === 'tab') {
        e.preventDefault();
        st.tab = el.dataset.tab; st.sel = null; st.detail = null; st.q = '';
        st.list = null;
        memRerender();
        return;
      }
      if (act === 'sel') {
        e.preventDefault();
        try { st.sel = JSON.parse(el.dataset.json); } catch { return; }
        if (st.sel && st.sel.tab) st.tab = st.sel.tab;
        st.detail = null;
        memLoadDetail().then(() => { if (state.tab === 'memory') memRerender(); });
        return;
      }
      if (act === 'save') {
        e.preventDefault();
        memSave(el.dataset.key, st);
        return;
      }
      if (act === 'del') {
        e.preventDefault();
        (async () => {
          if (!(await uiConfirm('删除这个人（QQ ' + el.dataset.qq + '）的记忆卡？\n会移到同目录的 .deleted 备份。'))) return;
          try {
            await api('/api/memory-cards/person/' + encodeURIComponent(el.dataset.qq), { method: 'DELETE' });
            st.sel = null; st.detail = null; st.list = null;
            memRerender();
          } catch (err) { alert('删除失败：' + (err?.message || err)); }
        })();
        return;
      }
    });
    document.addEventListener('input', (e) => {
      const el = e.target.closest('#memv-q');
      if (!el) return;
      const st = memState();
      st.q = el.value;
      clearTimeout(window.__memvQT);
      window.__memvQT = setTimeout(() => { if (state.tab === 'memory') memRerender(); }, 200);
    });
  }

  // ═══ 人设 V2（人格卡）：选卡 + 批量 + 卡管理 + 共用段 + 黑名单 ═══
  function pv2Cards(c) { return Array.isArray(c.personas) ? c.personas : []; }
  function pv2Opts(c, sel) {
    return pv2Cards(c).map((x) => `<option value="${esc(x.id)}"${x.id === sel ? ' selected' : ''}>${esc(x.name)}${x.builtin ? '（只读）' : ''}</option>`).join('');
  }
  function pv2CardName(c, id) { const x = pv2Cards(c).find((k) => k && k.id === id); return x ? x.name : ''; }
  async function pv2Reload() {
    try { if (typeof memRerender === 'function') await memRerender(); else if (typeof loadSettings === 'function') await loadSettings(); else location.reload(); }
    catch (e) { try { location.reload(); } catch { /* ignore */ } }
  }
  function pv2Hint(id, text, color) { const e = document.getElementById(id); if (e) { e.textContent = text || ''; e.style.color = color || ''; } }
  function pv2Picked() {
    return [...document.querySelectorAll('.pv2-pick')].filter((x) => x.checked).map((x) => x.dataset.chat);
  }
  async function pv2Api(method, path2, body) {
    const opt = { method, headers: { 'content-type': 'application/json' } };
    if (body !== undefined) opt.body = JSON.stringify(body);
    return api(path2, opt);
  }
  function pv2CheckedMode() {
    const el = document.querySelector('input[name="pv2-mode"]:checked');
    return el ? el.value : 'prompt';
  }

  // 单会话改卡
  async function pv2Assign(sel) {
    const chatKey = sel.dataset.chat;
    const personaId = sel.value;
    try {
      await pv2Api('PUT', '/api/persona-assignments', { chatKey, personaId });
      pv2Hint('pv2-batch-hint', chatKey + ' → ' + (personaId ? pv2CardName(state.config, personaId) : '静默') + ' ✅', 'var(--green)');
    } catch (e) { pv2Hint('pv2-batch-hint', '保存失败：' + e.message, 'var(--red)'); }
  }
  // 批量设为 / 清除
  async function pv2Batch(clear) {
    const chatKeys = pv2Picked();
    if (!chatKeys.length) { pv2Hint('pv2-batch-hint', '先勾选会话', 'var(--orange)'); return; }
    const cardSel = document.getElementById('pv2-batch-card');
    const personaId = clear ? '' : (cardSel ? cardSel.value : '');
    if (!clear && !personaId) { pv2Hint('pv2-batch-hint', '先选一张卡', 'var(--orange)'); return; }
    try {
      const r = await pv2Api('POST', '/api/persona-assignments/batch', { chatKeys, personaId });
      pv2Hint('pv2-batch-hint', '已更新 ' + (r.updated || chatKeys.length) + ' 个会话 ✅', 'var(--green)');
      pv2Reload();
    } catch (e) { pv2Hint('pv2-batch-hint', '失败：' + e.message, 'var(--red)'); }
  }
  function pv2PickAll(on) {
    document.querySelectorAll('.pv2-pick').forEach((x) => { x.checked = !!on; });
  }
  // 默认卡
  async function pv2SaveDefault() {
    const sel = document.getElementById('pv2-default');
    try {
      await pv2Api('PUT', '/api/persona-default', { personaId: sel ? sel.value : '' });
      pv2Hint('pv2-batch-hint', '默认卡已保存 ✅', 'var(--green)');
    } catch (e) { pv2Hint('pv2-batch-hint', '失败：' + e.message, 'var(--red)'); }
  }
  // 共用段
  async function pv2SaveShared() {
    const core = (document.getElementById('pv2-shared-core') || {}).value || '';
    const voice = (document.getElementById('pv2-shared-voice') || {}).value || '';
    try {
      await pv2Api('PUT', '/api/persona-shared', { core, voice });
      pv2Hint('pv2-shared-hint', '共用部分已保存（core ' + core.length + ' / voice ' + voice.length + ' 字）✅', 'var(--green)');
    } catch (e) { pv2Hint('pv2-shared-hint', '失败：' + e.message, 'var(--red)'); }
  }
  // 黑名单
  async function pv2SavePolicy() {
    const text = (document.getElementById('pv2-banned') || {}).value || '';
    const bannedPhrases = text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    try {
      await pv2Api('PUT', '/api/persona-policy', { bannedPhrases, bannedPhraseMode: pv2CheckedMode() });
      pv2Hint('pv2-policy-hint', '黑名单已保存（' + bannedPhrases.length + ' 条，模式 ' + pv2CheckedMode() + '）✅', 'var(--green)');
    } catch (e) { pv2Hint('pv2-policy-hint', '失败：' + e.message, 'var(--red)'); }
  }
  // 卡片编辑器
  // 旧版（JSON 编辑，已停用；保留便于回溯）
  function pv2OpenEditorJSON(card, forceNew) {
    const isNew = !card || forceNew === true;
    const c0 = card || { name: '', variant: '', examples: [], scenarios: [] };
    const js = (v) => esc(JSON.stringify(v || [], null, 2));
    const overlay = modelModalShell({
      head: isNew ? '新建人格卡' : '编辑人格卡：' + c0.name,
      body: `<div class="field"><label>名称</label><input type="text" id="pv2e-name" value="${esc(c0.name || '')}" /></div>
        <div class="field"><label>本卡特有（variant / 变体：依赖型、害羞型…）</label>
          <textarea id="pv2e-variant" class="persona-role-text" style="min-height:180px">${esc(c0.variant || '')}</textarea>
          <div class="hint">这段会拼在 shared(core+voice) 之后，作为本卡的差异部分。内置卡/独立卡（useShared=false）则只用它。</div></div>
        <div class="field"><label>回复示例（JSON 数组：{user,bad,good}）</label>
          <textarea id="pv2e-examples" class="persona-role-text" style="min-height:90px">${js(c0.examples)}</textarea></div>
        <div class="field"><label>按需场景（JSON 数组：{id,trigger,text}，trigger 为正则）</label>
          <textarea id="pv2e-scenarios" class="persona-role-text" style="min-height:120px">${js(c0.scenarios)}</textarea></div>
        <div class="field checkbox-row"><input type="checkbox" id="pv2e-useshared" ${c0.useShared !== false ? 'checked' : ''} />
          <label for="pv2e-useshared">使用共用部分（core + voice）</label></div>`,
      foot: `<button class="btn" id="pv2e-cancel">取消</button><button class="btn btn-primary" id="pv2e-save">保存</button>`
    });
    const q = (id) => overlay.querySelector('#' + id);
    q('pv2e-cancel').addEventListener('click', () => closeModelModal(overlay));
    q('pv2e-save').addEventListener('click', async () => {
      if (q('pv2e-save').disabled) return;
      q('pv2e-save').disabled = true;
      let examples = [];
      let scenarios = [];
      try { examples = JSON.parse(q('pv2e-examples').value || '[]'); } catch { showNoticeModal('JSON 错误', '回复示例不是合法 JSON'); return; }
      try { scenarios = JSON.parse(q('pv2e-scenarios').value || '[]'); } catch { showNoticeModal('JSON 错误', '场景不是合法 JSON'); return; }
      const payload = {
        name: q('pv2e-name').value.trim(),
        variant: q('pv2e-variant').value,
        examples: Array.isArray(examples) ? examples : [],
        scenarios: Array.isArray(scenarios) ? scenarios : []
      };
      if (!payload.name) { showNoticeModal('缺少名称', '给这张卡起个名字'); return; }
      payload.useShared = q('pv2e-useshared').checked;
      try {
        if (isNew) await pv2Api('POST', '/api/personas', payload);
        else await pv2Api('PUT', '/api/personas/' + encodeURIComponent(card.id), payload);
        closeModelModal(overlay);
        pv2Reload();
      } catch (e) { showNoticeModal('保存失败', String(e.message || e)); }
    });
    overlay.querySelector('#pv2e-name').focus();
  }
  // 📥 导入原版人格卡（人格市场下载的 customPersonas / 旧 roleText）
  async function pv2Import() {
    let data = { items: [] };
    try { data = await pv2Api('GET', '/api/personas/legacy'); } catch (e) { showNoticeModal('读取失败', String(e?.message || e)); return; }
    const items = data.items || [];
    const rows = items.length
      ? items.map((it, i) => `<label style="display:flex;gap:8px;align-items:flex-start;padding:6px 0;border-bottom:1px solid var(--line);cursor:pointer">
          <input type="checkbox" class="pv2i-pick" data-i="${i}" style="margin-top:4px" />
          <span style="flex:1">
            <b>${esc(it.name)}</b> <span class="muted" style="font-size:12px">· ${it.source} · 原文 ${it.chars} 字</span>
            <div class="muted" style="font-size:12px">→ 正文 ${it.preview.variantChars} 字 · 示例 ${it.preview.examples} 组 · 小节 ${(it.preview.sections || []).length} 个</div>
          </span>
        </label>`).join('')
      : '<div class="muted">没有找到可导入的原版人格卡</div>';
    const overlay = modelModalShell({
      head: '📥 导入人格卡',
      body: `<div class="hint">来源：人格市场下载的自定义人格（customPersonas）+ 旧的全局/会话级 roleText。
        导入会按小节拆成「正文 + 示例」，AI 味黑名单并入全局策略；正文以「保真」为优先，导入后可在编辑器里再精简。</div>
        <div class="field"><label>① 检测到 ${items.length} 张</label>
          <div style="max-height:260px;overflow:auto;border:1px solid var(--line);border-radius:6px;padding:4px 8px">${rows}</div>
          <div style="margin-top:6px"><button class="btn btn-small" id="pv2i-all">全选</button>
          <button class="btn btn-small btn-primary" id="pv2i-run">导入选中</button>
          <span class="hint" id="pv2i-hint"></span></div></div>
        <div class="field"><label>② 或粘贴一张卡的文本（人格市场里复制的内容）</label>
          <input type="text" id="pv2i-name" placeholder="卡片名字（可选）" style="margin-bottom:6px" />
          <textarea id="pv2i-text" class="persona-role-text" style="min-height:110px" placeholder="把人格卡文本粘进来，系统自动拆小节/示例"></textarea>
          <div style="margin-top:6px"><button class="btn btn-small" id="pv2i-paste">解析这张</button>
          <span class="hint" id="pv2i-phint"></span></div></div>`,
      foot: '<button class="btn" id="pv2i-close">关闭</button>'
    });
    const q = (id) => overlay.querySelector('#' + id);
    q('pv2i-close').onclick = () => closeModelModal(overlay);
    q('pv2i-all').onclick = () => overlay.querySelectorAll('.pv2i-pick').forEach((x) => { x.checked = true; });
    q('pv2i-run').onclick = async () => {
      if (q('pv2i-run').disabled) return;
      q('pv2i-run').disabled = true;
      const picked = [...overlay.querySelectorAll('.pv2i-pick')].filter((x) => x.checked).map((x) => items[Number(x.dataset.i)]);
      if (!picked.length) { q('pv2i-hint').textContent = '先勾选要导入的卡'; return; }
      const btn = q('pv2i-run');
      btn.disabled = true;
      q('pv2i-hint').textContent = '导入中…';
      try {
        const r = await pv2Api('POST', '/api/personas/import', { items: picked.map((x) => ({ name: x.name, text: x.text })) });
        closeModelModal(overlay);
        showNoticeModal('导入完成', '新建了 ' + (r.created || []).length + ' 张卡：\n' + (r.created || []).map((c) => c.name).join('、'));
        pv2Reload();
      } catch (e) { q('pv2i-hint').textContent = '失败：' + (e?.message || e); btn.disabled = false; }
    };
    q('pv2i-paste').onclick = async () => {
      if (q('pv2i-paste').disabled) return;
      q('pv2i-paste').disabled = true;
      const text = q('pv2i-text').value.trim();
      if (!text) { q('pv2i-phint').textContent = '先粘贴内容'; return; }
      try {
        const r = await pv2Api('POST', '/api/personas/parse', { name: q('pv2i-name').value.trim(), text });
        closeModelModal(overlay);
        pv2OpenEditor({ ...r.card, id: '' }, true);   // 进编辑器预览，点保存才落盘
      } catch (e) { q('pv2i-phint').textContent = '解析失败：' + (e?.message || e); }
    };
  }

  // ✨ 用 AI 生成人格卡（阶段 4）
  function pv2AiGenerate() {
    const overlay = modelModalShell({
      head: '✨ 用 AI 生成人格卡',
      body: `<div class="field"><label>描述你想要的角色</label>
          <textarea id="pv2g-desc" class="persona-role-text" style="min-height:150px" placeholder="例：这个群的人设偏害羞、怕被冷落，但被人怼时会小声反驳，说话很短，喜欢潜水；被叫大肥鱼会炸毛。"></textarea>
          <div class="hint">会调用你在「设置 → 模型」里配置的 API（可在 personaPolicy.genModel 指定单独模型）。生成后先预览，点保存才落盘。</div></div>
        <div class="hint" id="pv2g-hint"></div>`,
      foot: `<button class="btn" id="pv2g-cancel">取消</button><button class="btn btn-primary" id="pv2g-run">生成</button>`
    });
    const q = (id) => overlay.querySelector('#' + id);
    const hint = (t, c) => { const e = q('pv2g-hint'); if (e) { e.textContent = t; e.style.color = c || ''; } };
    q('pv2g-cancel').addEventListener('click', () => closeModelModal(overlay));
    q('pv2g-run').addEventListener('click', async () => {
      const desc = q('pv2g-desc').value.trim();
      if (!desc) { hint('先写一句角色描述', 'var(--orange)'); return; }
      const btn = q('pv2g-run');
      btn.disabled = true;
      hint('生成中（大约 10~30 秒）…');
      try {
        const r = await pv2Api('POST', '/api/personas/generate', { description: desc });
        closeModelModal(overlay);
        pv2OpenEditor({ ...r.card, id: '' }, true);
      } catch (e) {
        hint('生成失败：' + (e?.message || e), 'var(--red)');
        btn.disabled = false;
      }
    });
    q('pv2g-desc').focus();
  }

  // 触发器与"关键词"互转：让用户只打词，系统拼正则
  function pv2TriggerToKeywords(trig) {
    const t = String(trig || '').trim();
    if (!t) return '';
    const m = t.match(/^\(([^()\\|]+(?:\|[^()\\|]+)*)\)$/);
    if (m) return m[1].split('|').map((x) => x.trim()).filter(Boolean).join('，');
    return t;   // 复杂正则原样展示（高级用户可以自己写）
  }
  function pv2KeywordsToTrigger(kw) {
    const t = String(kw || '').trim();
    if (!t) return '';
    // 看起来已经是正则 → 原样用
    if (/[|()\\[\]{}*+?$^]/.test(t)) return t;
    const parts = t.split(/[,，、/]+/).map((x) => x.trim()).filter(Boolean);
    if (!parts.length) return '';
    if (parts.length === 1) return parts[0];
    return '(' + parts.join('|') + ')';
  }

  // ═══ 卡片编辑器（表单式：只打字，格式系统拼）═══
  function pv2OpenEditor(card, forceNew) {
    const isNew = !card || forceNew === true;
    const c0 = card || {};
    const ex = (Array.isArray(c0.examples) ? c0.examples : []).map((e) => ({
      user: String(e?.user || ''), bad: String(e?.bad || ''), good: String(e?.good || '')
    }));
    const sc = (Array.isArray(c0.scenarios) ? c0.scenarios : []).map((x) => ({
      id: String(x?.id || ''), kw: pv2TriggerToKeywords(x?.trigger || ''), text: String(x?.text || ''), title: String(x?._title || x?.title || '')
    }));
    if (!ex.length) ex.push({ user: '', bad: '', good: '' });

    const overlay = modelModalShell({
      head: isNew ? '新建人格卡' : '编辑人格卡：' + (c0.name || ''),
      body: `<div class="field"><label>名称</label><input type="text" id="pv2e-name" value="${esc(c0.name || '')}" /></div>
        <div class="field"><label>本卡特有（这个人格怎么说话、怎么反应）</label>
          <textarea id="pv2e-variant" class="persona-role-text" style="min-height:170px">${esc(c0.variant || '')}</textarea>
          <div class="hint">会拼在「共用部分(core+voice)」之后。内置卡/独立卡（不用共用部分）则只发这一段。</div></div>
        <div class="field"><label>回复示例 <span class="muted" id="pv2e-ex-count"></span></label>
          <div id="pv2e-ex-rows"></div>
          <div style="margin-top:6px"><button class="btn btn-small" id="pv2e-ex-add">＋ 添加一组示例</button></div></div>
        <div class="field"><label>按需场景（命中关键词才注入）</label>
          <div id="pv2e-sc-rows"></div>
          <div style="margin-top:6px"><button class="btn btn-small" id="pv2e-sc-add">＋ 添加场景</button>
          <span class="hint" style="margin-left:8px">关键词用逗号分隔，系统自动拼成正则；留空 = 永不触发</span></div></div>
        <div class="field checkbox-row"><input type="checkbox" id="pv2e-useshared" ${c0.useShared !== false ? 'checked' : ''} />
          <label for="pv2e-useshared">使用共用部分（core + voice）</label></div>`,
      foot: `<button class="btn" id="pv2e-cancel">取消</button><button class="btn btn-primary" id="pv2e-save">保存</button>`
    });
    const q = (id) => overlay.querySelector('#' + id);

    // ── 行渲染 ──
    const exRow = (e, i) => `<div class="pv2e-row" data-k="ex" data-i="${i}" style="display:flex;gap:6px;align-items:flex-start;margin-bottom:6px">
      <div style="flex:1">
        <input class="inp pv2e-ex-user" style="width:100%;margin-bottom:4px" placeholder="群友说…" value="${esc(e.user)}" />
        <div style="display:flex;gap:6px">
          <input class="inp pv2e-ex-bad" style="flex:1" placeholder="✗ 错误示范（AI 腔）" value="${esc(e.bad)}" />
          <input class="inp pv2e-ex-good" style="flex:1" placeholder="✓ 正确示范（符合人格）" value="${esc(e.good)}" />
        </div>
      </div>
      <button class="btn btn-small btn-danger pv2e-del" data-k="ex" data-i="${i}" title="删除这组">×</button>
    </div>`;
    const scRow = (x, i) => `<div class="pv2e-row" data-k="sc" data-i="${i}" style="display:flex;gap:6px;align-items:flex-start;margin-bottom:6px">
      <div style="flex:1">
        <input class="inp pv2e-sc-kw" style="width:100%;margin-bottom:4px" placeholder="关键词：好厉害，你真棒，谢谢你（逗号分隔）" value="${esc(x.kw)}" />
        <textarea class="inp pv2e-sc-text" style="width:100%;min-height:70px" placeholder="命中这个关键词时，你要怎么反应">${esc(x.text)}</textarea>
      </div>
      <button class="btn btn-small btn-danger pv2e-del" data-k="sc" data-i="${i}" title="删除这段">×</button>
    </div>`;

    const readDom = () => {
      // 把当前 DOM 的值读回数组（重渲染前必做，否则刚打的字会丢）
      overlay.querySelectorAll('.pv2e-row').forEach((row) => {
        const i = Number(row.dataset.i);
        if (!Number.isFinite(i)) return;
        if (row.dataset.k === 'ex' && ex[i]) {
          ex[i].user = row.querySelector('.pv2e-ex-user').value;
          ex[i].bad = row.querySelector('.pv2e-ex-bad').value;
          ex[i].good = row.querySelector('.pv2e-ex-good').value;
        } else if (row.dataset.k === 'sc' && sc[i]) {
          sc[i].kw = row.querySelector('.pv2e-sc-kw').value;
          sc[i].text = row.querySelector('.pv2e-sc-text').value;
        }
      });
    };
    const render = () => {
      q('pv2e-ex-rows').innerHTML = ex.map(exRow).join('') || '<div class="muted">（还没有示例）</div>';
      q('pv2e-sc-rows').innerHTML = sc.map(scRow).join('') || '<div class="muted">（还没有场景）</div>';
      const cnt = q('pv2e-ex-count');
      if (cnt) cnt.textContent = '（' + ex.length + ' 组）';
      overlay.querySelectorAll('.pv2e-del').forEach((btn) => {
        btn.onclick = () => {
          readDom();
          const k = btn.dataset.k;
          const i = Number(btn.dataset.i);
          if (k === 'ex') ex.splice(i, 1);
          else sc.splice(i, 1);
          if (!ex.length) ex.push({ user: '', bad: '', good: '' });
          render();
        };
      });
    };
    q('pv2e-ex-add').onclick = () => { readDom(); ex.push({ user: '', bad: '', good: '' }); render(); };
    q('pv2e-sc-add').onclick = () => { readDom(); sc.push({ id: '', kw: '', text: '', title: '' }); render(); };
    q('pv2e-cancel').onclick = () => closeModelModal(overlay);

    // ── 保存：DOM → 数组 → 接口 ──
    q('pv2e-save').onclick = async () => {
      readDom();
      const name = q('pv2e-name').value.trim();
      if (!name) { showNoticeModal('缺少名称', '给这张卡起个名字'); return; }
      const examples = ex
        .map((e) => ({ user: String(e.user || '').trim(), bad: String(e.bad || '').trim(), good: String(e.good || '').trim() }))
        .filter((e) => e.user || e.good);
      const scenarios = sc
        .map((x, i) => ({ id: x.id || ('scn_' + (i + 1)), trigger: pv2KeywordsToTrigger(x.kw), text: String(x.text || '').trim(), ...(x.title ? { _title: x.title } : {}) }))
        .filter((x) => x.text);
      const payload = {
        name,
        variant: q('pv2e-variant').value,
        examples,
        scenarios,
        useShared: q('pv2e-useshared').checked
      };
      try {
        if (isNew) await pv2Api('POST', '/api/personas', payload);
        else await pv2Api('PUT', '/api/personas/' + encodeURIComponent(card.id), payload);
        closeModelModal(overlay);
        pv2Reload();
      } catch (e) { showNoticeModal('保存失败', String(e?.message || e)); }
    };

    render();
    q('pv2e-name').focus();
  }

  async function pv2CopyCard(id) {
    const c = state.config || {};
    const card = pv2Cards(c).find((x) => x && x.id === id);
    if (!card) return;
    try {
      await pv2Api('POST', '/api/personas', {
        name: card.name + '（副本）',
        variant: card.builtin ? '' : (card.variant || ''),
        examples: card.builtin ? [] : (card.examples || []),
        scenarios: card.builtin ? [] : (card.scenarios || []),
        useShared: card.builtin ? true : (card.useShared !== false)
      });
      pv2Reload();
    } catch (e) { showNoticeModal('复制失败', String(e.message || e)); }
  }
  async function pv2DelCard(id) {
    const c = state.config || {};
    const card = pv2Cards(c).find((x) => x && x.id === id);
    if (!card) return;
    const refs = Object.keys(c.personaByChat || {}).filter((k) => c.personaByChat[k]?.personaId === id).length;
    const msg = refs
      ? `「${card.name}」正被 ${refs} 个会话使用。删除后这些会话会回落到默认卡（默认卡也是它则静默）。确定删除？`
      : `确定删除「${card.name}」？`;
    if (!confirm(msg)) return;
    try {
      const r = await pv2Api('DELETE', '/api/personas/' + encodeURIComponent(id));
      showNoticeModal('已删除', `影响 ${r.affected || 0} 个会话，回落目标：${r.fallback || '无'}`);
      pv2Reload();
    } catch (e) { showNoticeModal('删除失败', String(e.message || e)); }
  }

  function renderPersonaSectionV2(c) {
    const cards = pv2Cards(c);
    const byChat = c.personaByChat || {};
    const allowIds = [
      ...(c.allow?.groups || []).map((g) => 'group:' + g),
      ...(c.allow?.private || []).map((p) => 'private:' + p)
    ].map(String);
    const extraIds = Object.keys(byChat).filter((k) => !allowIds.includes(k));
    const chatIds = [...allowIds, ...extraIds];
    const unassigned = chatIds.filter((k) => !byChat[k]?.personaId).length;
    const rows = chatIds.map((k) => {
      const cur = byChat[k]?.personaId || '';
      const title = formatChatTitle(k, extraIds.includes(k) ? '' : chatNameOf(k));
      return `<tr>
        <td><input type="checkbox" class="pv2-pick" data-chat="${esc(k)}" /></td>
        <td>${esc(title)}</td>
        <td><select class="pv2-assign" data-chat="${esc(k)}" >
          <option value=""${cur ? '' : ' selected'}>未选择 → 静默</option>${pv2Opts(c, cur)}</select></td>
      </tr>`;
    }).join('');
    const cardRows = cards.map((x) => {
      const shared = x.useShared !== false ? String((c.personaShared?.core || '') + (c.personaShared?.voice || '')).length : 0;
      const len = shared + String(x.variant || '').length;
      const refs = Object.keys(byChat).filter((k) => byChat[k]?.personaId === x.id).length;
      return `<div style="display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line)">
        <b style="min-width:160px">${esc(x.name)}${x.builtin ? '（只读）' : ''}</b>
        <span class="muted" style="font-size:12px">常驻 ${len} 字${refs ? ' · 被 ' + refs + ' 个会话使用' : ''}</span>
        <span style="flex:1"></span>
        ${x.builtin ? '' : `<button class="btn btn-small" data-pv2="edit" data-id="${esc(x.id)}">编辑</button>
        <button class="btn btn-small btn-danger" data-pv2="del" data-id="${esc(x.id)}">删除</button>`}
        <button class="btn btn-small" data-pv2="copy" data-id="${esc(x.id)}">复制</button>
      </div>`;
    }).join('');
    const policy = c.personaPolicy || {};
    const mode = policy.bannedPhraseMode || 'prompt';
    const part = c.persona?.participation || 'medium';
    return `
      <h3 id="settings-persona">人设（人格卡）</h3>
      <div class="hint">每个会话独立选卡；<b>未分配的会话将静默</b>（只存档、不回复、0 token）。</div>
      <div class="field-row" style="margin-top:10px">
        <div class="field"><label>机器人名字</label><input type="text" id="cfg-botname" value="${esc(c.persona?.botName || '')}" /></div>
        <div class="field"><label>群内展示名（可选）</label><input type="text" id="cfg-selfnick" value="${esc(c.persona?.selfNickname || '')}" /></div>
        <div class="field"><label>参与度</label><select id="cfg-participation">
          <option value="low"${part === 'low' ? ' selected' : ''}>安静型</option>
          <option value="medium"${part === 'medium' ? ' selected' : ''}>普通群友</option>
          <option value="high"${part === 'high' ? ' selected' : ''}>活跃型</option></select></div>
      </div>
      <h3>① 会话分配</h3>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        <button class="btn btn-small" data-pv2="pick-all" data-on="1">全选</button>
        <button class="btn btn-small" data-pv2="pick-all" data-on="0">全不选</button>
        <span class="muted">批量设为</span>
        <select id="pv2-batch-card"><option value="">（选择卡片）</option>${pv2Opts(c, '')}</select>
        <button class="btn btn-small btn-primary" data-pv2="batch">应用</button>
        <button class="btn btn-small" data-pv2="batch" data-clear="1">清除选择（静默）</button>
        <span class="hint" id="pv2-batch-hint"></span>
      </div>
      <table class="table"><thead><tr><th style="width:36px"></th><th>会话</th><th>人格卡</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="hint">当前未分配 ${unassigned} 个（会静默）。</div>
      <h3>② 默认卡</h3>
      <div class="field"><label>新建分配时预选 / 删除卡后的回落目标</label>
        <div style="display:flex;gap:8px">
          <select id="pv2-default" style="flex:1"><option value="">（不设置）</option>${pv2Opts(c, c.personaDefault || '')}</select>
          <button class="btn btn-small" data-pv2="save-default">保存</button>
        </div></div>
      <h3>③ 人格卡管理</h3>
      <div style="display:flex;gap:8px;margin-bottom:6px">
        <button class="btn btn-small btn-primary" data-pv2="new">＋ 新建人格卡</button>
        <button class="btn btn-small" data-pv2="ai-gen">✨ 用 AI 生成</button>
        <button class="btn btn-small" data-pv2="import">📥 导入原版人格卡</button>
      </div>
      ${cardRows || '<div class="muted">（还没有卡片）</div>'}
      <h3>④ 共用部分（useShared 的卡共享）</h3>
      <div class="hint">可以保存多份共用段，选一份作为「当前使用」；改完内容点保存会写回选中的那份。</div>
      ${(() => {
        const box = (typeof state !== 'undefined' && state.personaSharedPresets) || { activeId: '', items: [] };
        const items = Array.isArray(box.items) ? box.items : [];
        const activeId = String(box.activeId || '');
        const pickId = String((typeof state !== 'undefined' && state.pv2SharedPick) || '') || activeId;
        const shown = items.find((x) => x.id === pickId) || items.find((x) => x.id === activeId) || null;
        const coreText = shown ? String(shown.core || '') : String(c.personaShared?.core || '');
        const voiceText = shown ? String(shown.voice || '') : String(c.personaShared?.voice || '');
        const nameText = shown ? String(shown.name || '') : '';
        const cards = items.map((x) => {
          const isActive = x.id === activeId;
          return '<div class="preset-card' + (x.id === pickId ? ' sel' : '') + '" data-pv2="pick-shared" data-id="' + esc(x.id) + '">' +
            '<div class="preset-card-title">' + esc(x.name || x.id) + (isActive ? ' <span class="preset-badge">当前使用</span>' : '') + '</div>' +
            '<div class="preset-card-sub">core ' + String(x.core || '').length + ' 字 · voice ' + String(x.voice || '').length + ' 字</div>' +
          '</div>';
        }).join('') || '<div class="muted" style="font-size:12px">（还没有共用段，写好内容后点「另存为新预设」）</div>';
        return '<div class="preset-row">' + cards + '</div>' +
          '<div class="field"><label>这份共用段的名称</label><input type="text" id="pv2-shared-name" value="' + esc(nameText) + '" placeholder="例如：小鲸鱼基础版" /></div>' +
          '<div class="field"><label>core（身份/性格/定位）· ' + coreText.length + ' 字</label>' +
            '<textarea id="pv2-shared-core" class="persona-role-text" style="min-height:150px">' + esc(coreText) + '</textarea></div>' +
          '<div class="field"><label>voice（说话铁律/方式/节奏/工具）· ' + voiceText.length + ' 字</label>' +
            '<textarea id="pv2-shared-voice" class="persona-role-text" style="min-height:220px">' + esc(voiceText) + '</textarea></div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
            '<button class="btn btn-small btn-primary" data-pv2="save-shared">保存（覆盖选中）</button>' +
            '<button class="btn btn-small" data-pv2="new-shared">另存为新预设</button>' +
            (pickId ? '<button class="btn btn-small" data-pv2="use-shared">设为当前使用</button>' : '') +
            (pickId && items.length > 1 ? '<button class="btn btn-small btn-danger" data-pv2="del-shared">删除选中</button>' : '') +
            '<span class="hint" id="pv2-shared-hint"></span>' +
          '</div>';
      })()}
      <h3>⑤ AI 味黑名单</h3>
      <div class="hint">模式：<b>写进提示词</b>=模型自觉避免（自然，可能漏）；<b>出站过滤器</b>=生成后自动删（确定，可能句子变短）。</div>
      <div style="display:flex;gap:16px;margin:8px 0">
        <label><input type="radio" name="pv2-mode" value="prompt"${mode === 'prompt' ? ' checked' : ''}/> 写进提示词</label>
        <label><input type="radio" name="pv2-mode" value="filter"${mode === 'filter' ? ' checked' : ''}/> 出站过滤器</label>
        <label><input type="radio" name="pv2-mode" value="both"${mode === 'both' ? ' checked' : ''}/> 两者都要</label>
      </div>
      <div class="field"><label>短语（一行一条，${(policy.bannedPhrases || []).length} 条）</label>
        <textarea id="pv2-banned" style="min-height:140px">${esc((policy.bannedPhrases || []).join('\n'))}</textarea></div>
      <button class="btn btn-small btn-primary" data-pv2="save-policy">保存黑名单</button>
      <span class="hint" id="pv2-policy-hint"></span>
      <details style="margin-top:14px"><summary class="muted" style="cursor:pointer">高级：附加规则 / 系统提示词覆盖</summary>
        <div class="field"><label>管理员附加规则（追加到系统提示）</label><textarea id="cfg-customrules" class="persona-role-text" style="min-height:80px">${esc(c.persona?.customRules || '')}</textarea></div>
        <div class="field"><label>系统提示词覆盖（整体替换默认准则，谨慎）</label><textarea id="cfg-sysprompt" class="persona-role-text" style="min-height:100px">${esc(c.persona?.systemPromptOverride || '')}</textarea></div>
      </details>`;
  }

// ⚠️ CSP 的 script-src 不含 'unsafe-inline' → 内联 onclick 会被浏览器丢弃。
// 人设页所有按钮改成 data-pv2 + 这里一次性事件委托（重渲染也不会失联）。
if (!window.__pv2Delegated) {
  window.__pv2Delegated = true;
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-pv2]');
    if (!el) return;
    const act = el.dataset.pv2;
    e.preventDefault();
    if (act === 'pick-all') return pv2PickAll(el.dataset.on === '1');
    if (act === 'batch') return pv2Batch(el.dataset.clear === '1');
    if (act === 'pick-shared') return pv2PickShared(el.dataset.id);
    if (act === 'new-shared') return pv2NewShared();
    if (act === 'use-shared') return pv2UseShared();
    if (act === 'del-shared') return pv2DelShared();
    if (act === 'save-shared') return pv2SaveSharedNew();
    if (act === 'save-default') return pv2SaveDefault();
    if (act === 'save-shared') return pv2SaveShared();
    if (act === 'save-policy') return pv2SavePolicy();
    if (act === 'new') return pv2OpenEditor(null);
    if (act === 'ai-gen') return pv2AiGenerate();
    if (act === 'import') return pv2Import();
    if (act === 'edit') {
      const c = state.config || {};
      const card = (c.personas || []).find((p) => p && p.id === el.dataset.id);
      if (card) pv2OpenEditor(card);
      return undefined;
    }
    if (act === 'del') return pv2DelCard(el.dataset.id);
    if (act === 'copy') return pv2CopyCard(el.dataset.id);
    return undefined;
  });
  document.addEventListener('change', (e) => {
    const el = e.target.closest('.pv2-assign');
    if (el) pv2Assign(el);
  });
}

function renderPersonaSection(c) {
  // 统一人设开关：开启（默认）= 所有用同一套全局人设（下方完整编辑器）；
  // 关闭 = 每个白名单会话一个按钮，点开模态框单独编辑（personaByChat）。
  const unified = c.personaUnified !== false;
  const perChat = c.personaByChat || {};
  const allowIds = [
    ...(c.allow?.groups || []).map((g) => `group:${g}`),
    ...(c.allow?.private || []).map((p) => `private:${p}`)
  ].map(String);
  const extraIds = Object.keys(perChat).filter((id) => !allowIds.includes(id));
  const chatIds = [...allowIds, ...extraIds];

  const unifiedEditor = `
    ${renderPersonaPicker(c)}
    <div class="field-row">
      <div class="field"><label>机器人名字</label><input type="text" id="cfg-botname" value="${esc(c.persona.botName)}" /></div>
      <div class="field"><label>群内展示名（可选）</label><input type="text" id="cfg-selfnick" value="${esc(c.persona.selfNickname || '')}" /></div>
      <div class="field"><label>参与度</label>
        <select id="cfg-participation">
          <option value="low" ${c.persona.participation === 'low' ? 'selected' : ''}>安静型</option>
          <option value="medium" ${c.persona.participation === 'medium' ? 'selected' : ''}>普通群友</option>
          <option value="high" ${c.persona.participation === 'high' ? 'selected' : ''}>活跃型</option>
        </select></div>
    </div>
    <div class="field"><label>角色设定</label>
      <textarea id="cfg-roletext" class="persona-role-text" placeholder="例如：你是运维群里的老油条……">${esc(c.persona.roleText || '')}</textarea></div>
    <div class="field"><label>管理员附加规则（可选，追加到系统提示）</label>
      <textarea id="cfg-customrules" class="persona-role-text" style="min-height:100px">${esc(c.persona.customRules || '')}</textarea></div>
    <div class="field">
      <label>系统提示词覆盖（高级 · 可选）</label>
      <textarea id="cfg-sysprompt" class="persona-role-text" style="min-height:120px" placeholder="留空 = 使用内置默认系统提示词（含安全规则/工具协议/反AI味等）。填写后将整体替换默认行为准则。">${esc(c.persona.systemPromptOverride || '')}</textarea>
      <div class="hint">
        ⚠️ 高级功能：填写后会<b>整体替换</b>内置系统提示词，默认的安全规则、工具协议、反 AI 味等约束全部失效（需自行在覆盖文本里写明）。
        可用占位符：<code>{botName}</code> <code>{roleText}</code> <code>{participation}</code>。留空则完全不影响现有行为。
      </div>
    </div>`;

  // 分会话模式：按钮网格（白名单 ∪ 已配置过的会话）
  const chatButtons = chatIds.map((chatKey) => {
    const conf = perChat[chatKey] || {};
    const hasCustom = Boolean(conf.roleText || conf.participation || conf.customRules || conf.systemPromptOverride);
    const title = formatChatTitle(chatKey, extraIds.includes(chatKey) ? '' : chatNameOf(chatKey));
    return `
      <button class="btn persona-chat-btn ${hasCustom ? 'has-custom' : ''}" data-chat="${esc(chatKey)}" title="${esc(title)}的人设">
        ${esc(title)}${hasCustom ? ' ●' : ''}
      </button>`;
  }).join('');

  return `
    <h3>人设</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-persona-unified" ${unified ? 'checked' : ''} />
      <label for="cfg-persona-unified">为所有的群聊/私聊使用同一个人设</label></div>
    <div class="hint" style="margin-bottom:12px">${unified
      ? '所有会话共用下方这一套人设。'
      : '每个会话独立人设：点按对应按钮弹窗编辑（● = 已配置独立人设；未配置的跟随全局人设的字段）。机器人名字/群内展示名是账号身份，只能全局设置。'}</div>
    <div id="persona-unified-box" style="${unified ? '' : 'display:none'}">
      ${unifiedEditor}
    </div>
    <div id="persona-perchat-box" style="${unified ? 'display:none' : ''}">
      <div class="field" style="margin-bottom:10px">
        <button class="btn" id="open-global-persona-btn">⚙ 全局人设设置（未单独配置的会话用这套）</button>
      </div>
      <div class="persona-chat-grid">${chatButtons || '<div class="hint">（白名单为空——先在「聊天白名单」里添加群聊/私聊）</div>'}</div>
    </div>`;
}

/**
 * 「全局人设设置」模态框（2026-09-18）：统一人设关闭（分群模式）时，
 * persona 主编辑器不在场 —— 没有独立人设的会话跟随的全局字段就没了编辑入口。
 * 这里弹出同款字段（选择人设 / 参与度 / 角色设定 / 附加规则 / 系统提示覆盖 /
 * 机器人名字 / 群内展示名），保存直接 POST /api/config 的 persona 补丁。
 */
function openGlobalPersonaModal() {
  const c = state.config || {};
  const per = c.persona || {};
  const overlay = modelModalShell({
    head: '全局人设设置',
    body: `
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <input type="text" id="gp-pick" readonly placeholder="点击选择人设" value="${esc(Object.values(state.personaTemplates || {}).find((p) => p.text === (per.roleText || ''))?.name || '')}" style="flex:1;cursor:pointer" />
        <button class="btn btn-small" id="gp-new-btn">＋ 添加人设</button>
      </div>
      <div class="field-row">
        <div class="field"><label>机器人名字</label><input type="text" id="gp-botname" value="${esc(per.botName || '')}" /></div>
        <div class="field"><label>群内展示名（可选）</label><input type="text" id="gp-selfnick" value="${esc(per.selfNickname || '')}" /></div>
        <div class="field"><label>参与度</label>
          <select id="gp-participation">
            <option value="low" ${per.participation === 'low' ? 'selected' : ''}>安静型</option>
            <option value="medium" ${per.participation === 'medium' ? 'selected' : ''}>普通群友</option>
            <option value="high" ${per.participation === 'high' ? 'selected' : ''}>活跃型</option>
          </select></div>
      </div>
      <div class="field"><label>角色设定</label>
        <textarea id="gp-roletext" class="persona-role-text" style="min-height:180px" placeholder="例如：你是运维群里的老油条……">${esc(per.roleText || '')}</textarea></div>
      <div class="field"><label>管理员附加规则（可选，追加到系统提示）</label>
        <textarea id="gp-customrules" class="persona-role-text" style="min-height:80px">${esc(per.customRules || '')}</textarea></div>
      <div class="field"><label>系统提示词覆盖（高级 · 可选）</label>
        <textarea id="gp-sysprompt" class="persona-role-text" style="min-height:80px" placeholder="留空 = 使用内置默认系统提示词">${esc(per.systemPromptOverride || '')}</textarea></div>
      <div class="hint" style="margin-top:6px">未配置独立人设的群聊/私聊全部使用这套全局字段。</div>`,
    foot: `<button class="btn" id="gp-cancel">取消</button>
           <button class="btn btn-primary" id="gp-save">保存</button>`
  });

  // 选择人设：与统一编辑器同一份模板列表
  overlay.querySelector('#gp-pick').addEventListener('click', () => {
    const entries = Object.entries(state.personaTemplates || {});
    if (!entries.length) return;
    const pickOverlay = modelModalShell({
      head: '选择人设',
      body: `<div class="model-modal-right" style="flex:1">
        ${entries.map(([id, p]) => `
          <div class="mm-model" data-id="${esc(id)}">
            <span class="mm-check">${p.text === overlay.querySelector('#gp-roletext').value ? '✓' : ''}</span>
            <span>${esc(p.name)}</span>
            <span class="muted" style="font-size:11px">${p.builtin ? '内置' : '自定义'}</span>
          </div>`).join('')}
      </div>`,
      foot: `<button class="btn" id="pp-cancel">取消</button>`
    });
    pickOverlay.querySelectorAll('.mm-model').forEach((el) => {
      el.addEventListener('click', () => {
        const tpl = state.personaTemplates[el.dataset.id];
        if (tpl) {
          overlay.querySelector('#gp-roletext').value = tpl.text;
          overlay.querySelector('#gp-customrules').value = tpl.customRules || '';
          overlay.querySelector('#gp-pick').value = tpl.name;
        }
        closeModelModal(pickOverlay);
      });
    });
    pickOverlay.querySelector('#pp-cancel').addEventListener('click', () => closeModelModal(pickOverlay));
  });
  overlay.querySelector('#gp-new-btn').addEventListener('click', () => {
    openPersonaCreateModal();
  });

  overlay.querySelector('#gp-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#gp-save').addEventListener('click', async () => {
    const patch = {
      persona: {
        ...(c.persona || {}),
        botName: overlay.querySelector('#gp-botname').value.trim() || '小鲸鱼',
        selfNickname: overlay.querySelector('#gp-selfnick').value.trim(),
        participation: overlay.querySelector('#gp-participation').value,
        roleText: overlay.querySelector('#gp-roletext').value.trim(),
        customRules: overlay.querySelector('#gp-customrules').value.trim(),
        systemPromptOverride: overlay.querySelector('#gp-sysprompt').value.trim()
      }
    };
    try {
      await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
      closeModelModal(overlay);
      memRerender();
    } catch (e) {
      alert(`保存全局人设失败：${e.message}`);
    }
  });
}

/**
 * 分会话人设编辑模态框：与统一编辑器同款字段（人设选择/添加/机器人名字沿用全局说明/参与度/
 * 角色设定/附加规则/系统提示词覆盖）。保存按钮直接 POST /api/config 落盘
 * （personaByChat 整体 __replace__），不经过表单自动保存链。
 */
function openPerChatPersonaModal(chatKey) {
  const conf = (state.config?.personaByChat || {})[chatKey] || {};
  const chatName = formatChatTitle(chatKey, chatNameOf(chatKey));
  const overlay = modelModalShell({
    head: `${chatName} 的独立人设`,
    body: `
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <input type="text" id="pcp-pick" readonly placeholder="点击选择人设" value="${esc(conf.roleText ? (Object.values(state.personaTemplates || {}).find((p) => p.text === conf.roleText)?.name || '自定义') : '')}" style="flex:1;cursor:pointer" />
        <button class="btn btn-small" id="pcp-new-btn">＋ 添加人设</button>
      </div>
      <div class="field"><label>参与度（留空跟随全局）</label>
        <select id="pcp-participation">
          <option value="" ${!conf.participation ? 'selected' : ''}>跟随全局</option>
          <option value="low" ${conf.participation === 'low' ? 'selected' : ''}>安静型</option>
          <option value="medium" ${conf.participation === 'medium' ? 'selected' : ''}>普通群友</option>
          <option value="high" ${conf.participation === 'high' ? 'selected' : ''}>活跃型</option>
        </select></div>
      <div class="field"><label>角色设定（留空跟随全局）</label>
        <textarea id="pcp-roletext" class="persona-role-text" style="min-height:180px" placeholder="留空 = 用全局人设的角色设定">${esc(conf.roleText || '')}</textarea></div>
      <div class="field"><label>管理员附加规则（可选）</label>
        <textarea id="pcp-customrules" style="min-height:80px" placeholder="可选：追加到系统提示的规则（留空 = 用全局）">${esc(conf.customRules || '')}</textarea></div>
      <div class="field"><label>系统提示词覆盖（高级 · 可选）</label>
        <textarea id="pcp-sysprompt" style="min-height:80px" placeholder="可选：整体替换系统提示（留空 = 用全局）">${esc(conf.systemPromptOverride || '')}</textarea></div>
      <div class="hint" style="margin-top:6px">机器人名字/群内展示名不按会话变化（账号身份，改了会与 @ 判定对不上），在统一人设里设置。</div>`,
    foot: `<button class="btn" id="pcp-clear">清空独立人设</button>
           <button class="btn" id="pcp-cancel">取消</button>
           <button class="btn btn-primary" id="pcp-save">保存</button>`
  });

  // 选择人设：复用人设模板列表
  overlay.querySelector('#pcp-pick').addEventListener('click', () => {
    const entries = Object.entries(state.personaTemplates || {});
    if (!entries.length) return;
    const pickOverlay = modelModalShell({
      head: '选择人设',
      body: `<div class="model-modal-right" style="flex:1">
        ${entries.map(([id, p]) => `
          <div class="mm-model" data-id="${esc(id)}">
            <span class="mm-check">${p.text === overlay.querySelector('#pcp-roletext').value ? '✓' : ''}</span>
            <span>${esc(p.name)}</span>
            <span class="muted" style="font-size:11px">${p.builtin ? '内置' : '自定义'}</span>
          </div>`).join('')}
      </div>`,
      foot: `<button class="btn" id="pp-cancel">取消</button>`
    });
    pickOverlay.querySelectorAll('.mm-model').forEach((el) => {
      el.addEventListener('click', () => {
        const tpl = state.personaTemplates[el.dataset.id];
        if (tpl) {
          overlay.querySelector('#pcp-roletext').value = tpl.text;
          overlay.querySelector('#pcp-customrules').value = tpl.customRules || '';
          overlay.querySelector('#pcp-pick').value = tpl.name;
        }
        closeModelModal(pickOverlay);
      });
    });
    pickOverlay.querySelector('#pp-cancel').addEventListener('click', () => closeModelModal(pickOverlay));
  });
  overlay.querySelector('#pcp-new-btn').addEventListener('click', () => {
    // 复用统一编辑器的添加流程：加完模板直接填进本会话的角色设定
    openPersonaCreateModal();
  });

  // 直接 POST 落盘：不走"写隐藏 JSON + 等表单链保存"的老路。
  // 老路的两个坑（2026-09-17 用户实测）：
  //   1. modal 挂在 body 下、不在 #settings-form 内，dispatchEvent(change) 冒泡
  //      到不了 form 的委托监听 —— 从来没触发过自动保存；
  //   2. 就算触发了，随后的 memRerender() 重建表单 DOM，隐藏 input 被重渲染成
  //      GET 回来的旧值，用户刚写的条目被无声丢弃 → 重开 modal 一片空白。
  const saveToMap = async (entry) => {
    const current = state.config?.personaByChat || {};
    const next = { ...current };
    if (entry) next[chatKey] = entry; else delete next[chatKey];
    try {
      const r = await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({ personaByChat: { __replace__: next } })
      });
      if (r?.config) state.config = r.config;
    } catch (e) {
      alert(`保存独立人设失败：${e?.message || e}`);
      throw e;
    }
  };

  overlay.querySelector('#pcp-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#pcp-clear').addEventListener('click', async () => {
    try { await saveToMap(null); } catch { return; }
    closeModelModal(overlay);
    renderSettings();   // 只刷人设区块（按钮上的 ● 标记），不整页重拉 7 个接口
  });
  overlay.querySelector('#pcp-save').addEventListener('click', async () => {
    const roleText = overlay.querySelector('#pcp-roletext').value.trim();
    const participation = overlay.querySelector('#pcp-participation').value;
    const customRules = overlay.querySelector('#pcp-customrules').value.trim();
    const sysPrompt = overlay.querySelector('#pcp-sysprompt').value.trim();
    if (!roleText && !participation && !customRules && !sysPrompt) {
      try { await saveToMap(null); } catch { return; }   // 全空 = 清除独立人设
    } else {
      const entry = {};
      if (roleText) entry.roleText = roleText;
      if (participation) entry.participation = participation;
      if (customRules) entry.customRules = customRules;
      if (sysPrompt) entry.systemPromptOverride = sysPrompt;
      try { await saveToMap(entry); } catch { return; }
    }
    closeModelModal(overlay);
    renderSettings();
  });
}

function renderAllowSection(c) {
  return `
    <h3 id="settings-allow">聊天白名单</h3>
    <div class="hint" style="margin-bottom:10px">白名单为空时机器人不会在任何群聊/私聊内运行。</div>
    <div class="field"><label>从 QQ 账号直接勾选</label>
      <div class="allow-pick-row">
        <button class="btn btn-small" id="pick-groups-btn">选择群</button>
        <button class="btn btn-small" id="pick-friends-btn">选择好友</button>
        <span id="pick-result" class="muted allow-pick-msg"></span>
      </div></div>
    <div class="field-row">
      <div class="field"><label>允许的群号（逗号分隔）</label><input type="text" id="cfg-allowgroups" value="${esc((c.allow.groups || []).join(','))}" /></div>
      <div class="field"><label>允许的 QQ（逗号分隔）</label><input type="text" id="cfg-allowprivate" value="${esc((c.allow.private || []).join(','))}" /></div>
      ${renderForwardRulesSection(c)}
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-allowallwhenempty" ${c.allowAllWhenEmpty === true ? 'checked' : ''} />
      <label for="cfg-allowallwhenempty">白名单留空时允许所有会话</label></div>
    <div class="hint">说明：勾选后，若上方两个列表都为空，机器人会在<b>所有</b>群聊和私聊中运行；只要填了任意一项，就只按名单过滤。</div>
    <div class="hint" style="margin-top:8px">按会话的独立人设在「人设」页签配置（关闭"统一人设"后出现）。</div>`;
}

// 表情包积极程度档位：[值, 显示名]
const STICKER_LEVELS = [
  [0, '0 · 不鼓励（只在很贴切时偶尔用）'],
  [1, '1 · 偶尔（合适时配一张）'],
  [2, '2 · 较积极（优先考虑配图）'],
  [3, '3 · 很积极（表情包爱好者）']
];

// 读取历史档位：名称与说明（档位制，累积生效）
/** 把输入钳制到 [min,max]，非法值退回 fallback。 */
/**
 * 取会话的群名（群聊才有）。
 * 群名由后端 /api/chats 附带（走 OneBot get_group_info，带缓存与超时保护），
 * 拿不到就返回空串 —— 调用方会自动退回只显示群号。
 */
function chatNameOf(chatKey) {
  const c = (state.chats || []).find((x) => x.key === chatKey);
  return String(c?.chatName || '').trim();
}

/**
 * 会话标题：群名 / 私聊昵称
 * 侧栏只显示名字（过长由 CSS 省略号截断），不拼群号 —— 拼了会被挤爆。
 * 拿不到名字时才退回「群 123 / 私聊 123」兜底。
 */
function formatChatTitle(chatKey, name = '') {
  const n = String(name || '').trim();
  if (n) return n;
  const m = /^group:(\d+)$/.exec(String(chatKey || ''));
  if (m) return `群 ${m[1]}`;
  const p = /^private:(\d+)$/.exec(String(chatKey || ''));
  if (p) return `私聊 ${p[1]}`;
  return String(chatKey || '');
}

/** 详情页标题：名字 + 号（需要确认身份时用） */
function formatChatTitleWithId(chatKey, name = '') {
  const m = /^group:(\d+)$/.exec(String(chatKey || ''));
  if (m) return name ? `${name}（${m[1]}）` : `群 ${m[1]}`;
  const p = /^private:(\d+)$/.exec(String(chatKey || ''));
  if (p) return name ? `${name}（${p[1]}）` : `私聊 ${p[1]}`;
  return formatChatTitle(chatKey, name);
}

/**
 * 群名补底缓存（id → 群名）：/api/onebot/groups 的群列表名字。
 * 没有消息存档的白名单群在 /api/chats 里查不到名字，分群按钮会退化成「群 <号>」，
 * 不方便辨识 —— 这里用 OneBot 群列表把名字补齐。
 */
async function loadQqGroupNames() {
  if (state.qqGroupNamesLoading) return state.qqGroupNames || {};
  state.qqGroupNamesLoading = true;
  try {
    const data = await api('/api/onebot/groups');
    state.qqGroupNames = state.qqGroupNames || {};
    for (const g of data.groups || []) {
      const id = String(g?.id ?? '').trim();
      const name = String(g?.name ?? '').trim();
      if (id && name) state.qqGroupNames[id] = name;
    }
  } catch { /* OneBot 未连接时静默：退回群号兜底 */ }
  finally { state.qqGroupNamesLoading = false; }
  return state.qqGroupNames || {};
}

/** 分群场景的群显示名：**仅群名**（拿不到才退回「群 <号>」兜底）。 */
function groupDisplayName(gid) {
  const id = String(gid ?? '').trim();
  const n = chatNameOf(`group:${id}`) || String(state.qqGroupNames?.[id] || '').trim();
  return n || `群 ${id}`;
}

function clampInt(raw, min, max, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/*
 * 滑条换算（前端显示用）。
 *
 * 换算逻辑来自 /vendor/tier-slider.js（与 src/tier-slider.js 同一份镜像）。
 * 后端保存配置时会用它**重新权威换算**档位与概率，前端这里只负责界面即时反馈。
 * 下面的 sliderToTierUI / sliderToTierUI_tierToSlider 是对共享函数的薄封装，
 * 保持既有调用点签名不变。
 */
function sliderToTierUI(pos) {
  return sliderToTier(pos);
}

/** 已保存配置 → 滑条位置（优先用存下来的位置，老配置没有就从 tier/概率反推）。 */
function sliderToTierUI_tierToSlider(st) {
  const saved = Number(st?.contextSliderPos);
  if (Number.isFinite(saved)) return Math.min(100, Math.max(0, saved));
  return tierToSlider(st?.contextTier, st?.randomPercent);
}

/** 滑条位置 → 一句话说明（给用户的即时反馈）。 */
function sliderDesc(pos) {
  const { tier, randomPercent } = sliderToTierUI(pos);
  if (tier === 1) return '<b>1 档 · 仅艾特</b>：只有被 @ 时才响应，其余消息标记已读、不调模型（最省）';
  if (tier === 2) return '<b>2 档 · +关键词</b>：被 @ 或命中关键词时响应';
  // 3 档概率展示必须与后端判定同源：resolveContextTier 用 Math.random()*100 与
  // randomPercent 比较（即"骰子值 < 阈值"），滑条换算出的 randomPercent 就是这个阈值。
  // 之前这里展示的是 sliderToTier 的 randomPercent 四舍五入值，而后端在保存时会
  // 重新权威换算一次 —— 两边都来自同一公式，但旧版 desc 里取整方式不同导致偶发不一致，
  // 现在统一保留一位小数（与 sliderToTier 一致）。
  if (tier === 3) return `<b>3 档 · +随机</b>：被 @ / 关键词必响应；此外每批普通消息有 <b>${randomPercent}%</b> 概率响应`;
  return '<b>4 档 · 全响应</b>：任何消息都响应，且艾特/关键词/随机的判定全部失效';
}

const TIER_NAME = { 1: '仅艾特', 2: '+关键词', 3: '+随机', 4: '全响应' };

/** 滑条位置 → 纯文本档位名（无 HTML 标签，供双点滑条说明文字使用）。 */
function sliderDescText(pos) {
  const { tier, randomPercent } = sliderToTierUI(pos);
  if (tier === 3) return `3 档 · +随机（${randomPercent}%）`;
  return `${tier} 档 · ${TIER_NAME[tier]}`;
}
const TIER_HINT = {
  1: '只有被 @ 时才响应，其余消息标记已读、不调模型（最省 token）',
  2: '在 1 档基础上，命中关键词也响应',
  3: '在 2 档基础上，再按概率随机响应一些消息',
  4: '任何消息都响应（改造前的行为，最费 token）'
};

function renderChatSection(c) {
  const st = c.store || {};
  const fold = (typeof setCard === 'function') ? setCard : (o) => `<div class="setcard">${o.body}</div>`;
return `
    <h3>聊天设置</h3>
    ${renderSafeModeSection(c)}
    ${fold({
      id: 'card-send-config',
      icon: '📨',
      title: '信息发送配置',
      sub: '温度 / 思考 / 节奏 / 发送限流',
      body: `
      <div class="field-row">
        <div class="field"><label>温度</label><input type="number" id="sc-temperature" step="0.1" min="0" max="2" value="${esc(c.api?.temperature ?? 0.8)}" /></div>
        <div class="field"><label>单次运行最大工具轮数</label><input type="number" id="sc-maxrounds" min="1" max="40" value="${esc(c.api?.maxRounds ?? 12)}" /></div>
      </div>
      <div class="field"><label>思考强度</label>
        <select id="sc-thinking-effort">
          ${[
            ['off', '关（不思考，明确关闭）'],
            ['', '默认（跟随模型/网关）'],
            ['on-noeffort', '开（明确开启，不指定强度）'],
            ['low', '低（快、省 token）'],
            ['medium', '中'],
            ['high', '高（慢、细致）'],
            ['xhigh', '超高（更慢、更深入）'],
            ['max', '拉满（最强推理）']
          ].map(([v, l]) => {
            const eff = c.api?.thinkingEffort || '';
            const mode = c.api?.thinkingMode || 'auto';
            // (mode, effort) 二维状态压成一维下拉：off 优先，其次 effort 档；
            // "on 但没指定强度"是独立档 on-noeffort（不能折叠进"默认"——
            // 那样一次保存会把明确开启改写成 auto，见 saveConfig chat 分支）。
            const sel = mode === 'off' ? 'off' : (eff || (mode === 'on' ? 'on-noeffort' : ''));
            return `<option value="${v}" ${sel === v ? 'selected' : ''}>${l}</option>`;
          }).join('')}
        </select>
        <div class="hint">内置落成各厂商思考参数（off~max 六档）；渠道不支持高档时向下就近映射。</div></div>
      <div class="field-row">
        <div class="field"><label>防抖聚批窗口（毫秒）</label><input type="number" id="sc-wakedelay" min="0" value="${esc(c.wakeDelayMs)}" /></div>
        <div class="field"><label>批次间隔（毫秒）</label><input type="number" id="sc-draindelay" min="0" value="${esc(c.drainDelayMs)}" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>同时处理几个会话</label><input type="number" id="sc-maxruns" min="1" max="8" value="${esc(c.maxConcurrentRuns)}" /></div>
        <div class="field"><label>失败自动重试次数</label><input type="number" id="sc-sessionretry" min="0" max="5" value="${esc(c.sessionRetryAttempts ?? 2)}" />
          <div class="hint">0 = 关闭。已发出过消息的会话绝不自动重试。</div></div>
      </div>
      <div class="field-row">
        <div class="field"><label>相邻消息最小间隔（毫秒）</label><input type="number" id="sc-mingap" min="200" value="${esc(c.send?.minGapMs ?? 1000)}" /></div>
        <div class="field"><label>最大间隔（毫秒）</label><input type="number" id="sc-maxgap" min="500" value="${esc(c.send?.maxGapMs ?? 3000)}" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>每分钟最多发送</label><input type="number" id="sc-maxpermin" min="1" value="${esc(c.send?.maxPerMinute ?? 80)}" /></div>
        <div class="field"><label>每小时最多发送</label><input type="number" id="sc-maxperhour" min="1" value="${esc(c.send?.maxPerHour ?? 500)}" /></div>
      </div>
      <div class="hint">改动即时生效（自动保存），无需单独点保存。</div>`
    })}
    ${fold({
      id: 'card-active-config',
      icon: '⚡',
      title: '活跃设置',
      sub: '响应档位 / 峰谷',
      val: tierSummary(sliderToTierUI_tierToSlider(st)),
      // 卡头插槽：竖分割线 + 三件套（峰谷时段 / 档位参数 / 统一设置），
      // 紧贴标题块左侧排布，与右上角档位摘要之间留白。
      extra: `<span class="ac-head-controls"><span class="ac-head-div"></span>
        <div class="btn ac-peak-btn" id="ac-peak-btn" role="button" tabindex="0" title="点击设置高峰时段（开始 / 结束与预设方案）">
          <span>🌅 峰谷时段</span>
          <label class="switch ac-peak-switch" title="启用 / 停用峰谷切换（高峰时段用高峰档，其余时间用低谷档）"><input type="checkbox" id="ac-peak-enabled" ${st.peakSchedule?.enabled === true ? 'checked' : ''} /><span class="track"><span class="thumb"></span></span></label>
        </div>
        <button class="btn" id="ac-tier-params-btn" title="档位参数：各档条数 / 关键词表 / 被召唤后持续参与">⚙ 档位参数</button>
        <label class="switch" style="padding:0" title="开 = 所有群共用同一套档位 / 峰谷时段；关 = 每个群单独设置"><input type="checkbox" id="ac-unifiedtier" ${st.unifiedTier !== false ? 'checked' : ''} /><span class="track"><span class="thumb"></span></span><span style="font-size:12px">统一设置</span></label>
      </span>`,
      open: true,
      body: `<div id="ac-editor"></div>`
    })}

    ${fold({
      id: 'card-cmdmute',
      icon: '🔇',
      title: '指令禁言',
      sub: '被 @ 附带指令就安静一段时间',
      open: false,
      body: `
      <div class="field-row">
        <div class="field"><label>禁言指令（需与 @机器人 同条消息）</label>
          <input type="text" id="ac-cmdmute-command" value="${esc(c.commandMute?.command || '/安静')}" placeholder="如 /安静" /></div>
        <div class="field"><label>禁言时长（分钟，0 = 直到手动解除）</label>
          <input type="number" id="ac-cmdmute-duration" min="0" value="${esc(Number(c.commandMute?.durationMin ?? 30))}" /></div>
      </div>
      <div class="checkbox-row"><input type="checkbox" id="ac-cmdmute-enabled" ${c.commandMute?.enabled !== false ? 'checked' : ''} />
        <label for="ac-cmdmute-enabled">启用指令禁言</label></div>
      <div class="hint">改动即时生效（自动保存），无需单独点保存。</div>`
    })}

    ${fold({
      id: 'card-proactive',
      icon: '💬',
      title: '主动开话题',
      sub: '冷场时按概率主动开话题',
      body: `
      <div class="checkbox-row"><input type="checkbox" id="cfg-proactive" ${c.proactive.enabled ? 'checked' : ''} />
        <label for="cfg-proactive">冷场时按概率主动开话题</label></div>
      <div class="field-row">
        <div class="field"><label>检查间隔下限（毫秒）</label><input type="number" id="cfg-pro-min" min="60000" value="${esc(c.proactive.checkIntervalMinMs)}" /></div>
        <div class="field"><label>检查间隔上限（毫秒）</label><input type="number" id="cfg-pro-max" min="120000" value="${esc(c.proactive.checkIntervalMaxMs)}" /></div>
        <div class="field"><label>触发概率 0~1</label><input type="number" id="cfg-pro-prob" step="0.05" min="0" max="1" value="${esc(c.proactive.probability)}" /></div>
      </div>`
    })}

    ${fold({
      id: 'card-sticker',
      icon: '😄',
      title: '表情包',
      sub: '收藏表情同步 / 发送积极度 / 提示词列举数',
      body: `
      <div class="checkbox-row"><input type="checkbox" id="cfg-sticker" ${c.sticker.enabled ? 'checked' : ''} />
        <label for="cfg-sticker">启用表情包（收藏表情同步 + 发送工具）</label></div>
      <div class="field">
        <label>发表情包的积极程度</label>
        <select id="cfg-sticker-encourage">
          ${STICKER_LEVELS.map(([v, label], i) =>
            `<option value="${v}" ${Number(c.sticker?.encourage ?? 1) === v ? 'selected' : ''}>${esc(label)}</option>`
          ).join('')}
        </select>
        <div class="hint">
          这是"引导"不是"强制"，模型仍会自行判断什么时机合适。
        </div>
      </div>
      <div class="field">
        <label>提示词里列举的表情包数量（1~50）</label>
        <input type="number" id="cfg-sticker-promptmax" min="1" max="50" value="${esc(Number(c.sticker?.promptMaxStickers) || 10)}" />
        <div class="hint">
          每次唤醒时，系统会把收藏表里最多这么多个表情包列进提示词供模型挑选。
          列得越多模型选择越丰富，但 token 成本也越高；收藏很多时适当调大，收藏少或想省 token 就调小。
        </div>
      </div>`
    })}

    ${fold({
      id: 'card-dsh',
      icon: '🔗',
      title: 'DSH 桥',
      sub: '用QQ给本机DeepSeek Harness下指令',
      open: false,
      body: `
      <div class="checkbox-row"><input type="checkbox" id="cfg-dsh-enabled" ${c.dsh?.enabled ? 'checked' : ''} />
        <label for="cfg-dsh-enabled">启用 DSH 桥（QQ ↔ DeepSeek Harness 联通）</label></div>
      <div class="hint">
        <b>开</b>：白名单里的 QQ 号发 <b>${esc(c.dsh?.prefix || '/dsh')} &lt;任务&gt;</b> 会绕过大模型直接交给本机 DSH 执行，
        结果原样回发；不命中前缀的消息照旧交给你自己配的模型。<b>关</b>：不接管任何消息、也不接受 DSH 侧的主动推送，
        行为与未改过的原版一致。
      </div>
      <div class="field-row">
        <div class="field"><label>命令前缀</label>
          <input type="text" id="cfg-dsh-prefix" value="${esc(c.dsh?.prefix || '/dsh')}" placeholder="/dsh" /></div>
        <div class="field"><label>允许下指令的 QQ 号（逗号分隔，空 = 谁都不许）</label>
          <input type="text" id="cfg-dsh-senders" value="${esc((c.dsh?.allowedSenderIds || []).join(', '))}" placeholder="85946573" /></div>
      </div>
      <div class="field"><label>DSH 任务的工作目录</label>
        <input type="text" id="cfg-dsh-workdir" value="${esc(c.dsh?.workdir || '')}" placeholder="留空 = 用 QQ Agent 自己的目录" />
        <div class="hint">建议填你有<b>完全控制权</b>的目录（如 C:\\Users\\你\\dsh-workspace）。DSH 的 workspace-write 沙箱要靠目录 ACL 授权，只有 Modify 权限的目录会让"写文件"类任务失败。</div>
      </div>
      <div class="field-row">
        <div class="field"><label>通道</label>
          <select id="cfg-dsh-transport">
            <option value="headless" ${(c.dsh?.transport || 'headless') === 'headless' ? 'selected' : ''}>headless（每次起进程；不需要 DSH 开着）</option>
            <option value="plugin" ${c.dsh?.transport === 'plugin' ? 'selected' : ''}>plugin（常驻会话；需要 DSH 在运行）</option>
          </select></div>
        <div class="field"><label>执行进度提示</label>
          <select id="cfg-dsh-progress">
            <option value="off" ${(c.dsh?.showProgress || 'private') === 'off' ? 'selected' : ''}>不发</option>
            <option value="private" ${(c.dsh?.showProgress || 'private') === 'private' ? 'selected' : ''}>只在私聊发</option>
            <option value="all" ${(c.dsh?.showProgress || 'private') === 'all' ? 'selected' : ''}>所有会话都发</option>
          </select></div>
      </div>
      <div class="field-row">
        <div class="field"><label>plugin 通道入口（留空 = 默认）</label>
          <input type="text" id="cfg-dsh-pluginurl" value="${esc(c.dsh?.pluginUrl || '')}" placeholder="http://127.0.0.1:19387/__dsh-qq/message" /></div>
        <div class="field"><label>plugin 通道令牌（dsh-qq 的 bridgeToken）</label>
          <input type="text" id="cfg-dsh-plugintoken" value="${esc(c.dsh?.pluginToken || '')}" placeholder="留空 = 不校验" /></div>
      </div>
      <div class="field"><label>DSH 结果进入提示词的字数上限</label>
        <input type="text" id="cfg-dsh-promptchars" value="${esc(String(c.dsh?.resultPromptChars ?? 200))}" placeholder="200（0 = 完全不进上下文）" /></div>
      <div class="hint">
        DSH 的回复<b>全文照发 QQ</b>，但进模型上下文时只保留这么多字。不设的话，一份长报告会被存进存档，
        之后<b>每一轮</b>历史都带着它进提示词 —— token 会白白烧掉。填 <b>0</b> = 完全不进上下文；
        另外 <code>store.maxPromptChars</code>（默认 2000）是"任何单条消息进提示词"的兜底上限。
      </div>
      <div class="field"><label>DSH 任务的权限（两种通道都生效）</label>
        <select id="cfg-dsh-permissionmode">
          <option value="" ${!c.dsh?.permissionMode ? 'selected' : ''}>默认（工作区可写 + 越界要审批）</option>
          <option value="danger-full-access" ${c.dsh?.permissionMode === 'danger-full-access' ? 'selected' : ''}>完全放开（danger-full-access：不弹审批，可越界操作）</option>
          <option value="workspace-write" ${c.dsh?.permissionMode === 'workspace-write' ? 'selected' : ''}>只用工作区（workspace-write）</option>
          <option value="read-only" ${c.dsh?.permissionMode === 'read-only' ? 'selected' : ''}>只读（read-only）</option>
        </select>
        <div class="hint">
          常驻会话默认是「工作区可写 + 越界要审批」，而这类会话里<b>没人应答审批 = 自动拒绝</b> ——
          于是「帮我关机」「改系统设置」这类越界命令会失败。选<b>完全放开</b>它才能做（含关机 / 重启）。
          改动会在<b>下一次 /dsh 任务</b>时就地切换，不丢会话上下文。
          <b>注意</b>：这等于把本机完全交给能从白名单 QQ 号下指令的人（也就是你），谨慎开启。
        </div>
      </div>
      <div class="checkbox-row"><input type="checkbox" id="cfg-dsh-privacy-enabled" ${c.dsh?.privacy?.enabled !== false ? 'checked' : ''} />
        <label for="cfg-dsh-privacy-enabled">出站隐私过滤（不向白名单之外的会话发送隐私信息）</label></div>
      <div class="hint">
        <b>开</b>：DSH 的内容发往<b>不在下面白名单里的会话</b>时 —— 邮箱 / 手机号 / 身份证 / 卡号 /
        <code>C:\\Users\\&lt;用户名&gt;\\…</code> / 内网 IP / 本机用户名与主机名 <b>就地打码</b>；
        密钥与口令类（<code>sk-…</code>、<code>ghp_…</code>、<code>token: xxx</code>、私钥块、带凭据的连接串）
        <b>整条拒发</b>；打码后只剩占位符也拒发。覆盖桥回传的回复、<b>qq_send</b> 主动推送、
        <b>qq_send_file</b> 的文件名与文本类文件内容。<b>关</b>：所有会话都原样收到。
      </div>
      <div class="field-row">
        <div class="field"><label>隐私白名单会话（逗号分隔，这些会话原样放行）</label>
          <input type="text" id="cfg-dsh-privacy-chats" value="${esc((c.dsh?.privacy?.allowedChats || ['private:85946573']).join(', '))}" placeholder="private:85946573" />
          <div class="hint">裸 QQ 号按私聊算。<b>群默认不在白名单里</b>（群消息所有成员都能看到），确要放行请写 <code>group:群号</code>。</div></div>
        <div class="field"><label>命中后的处理方式</label>
          <select id="cfg-dsh-privacy-mode">
            <option value="redact" ${(c.dsh?.privacy?.mode || 'redact') === 'redact' ? 'selected' : ''}>打码后照发（推荐）</option>
            <option value="block" ${c.dsh?.privacy?.mode === 'block' ? 'selected' : ''}>有命中就整条拒发</option>
          </select></div>
      </div>
      <div class="field"><label>自定义规则（每行一条，留空 = 不用）</label>
        <textarea id="cfg-dsh-privacy-patterns" rows="4" spellcheck="false" placeholder="代号 = 夜莺计划&#10;拒发: 内部域名 = .*\\.corp\\.example\\.com">${esc(formatPrivacyPatterns(c.dsh?.privacy?.extraPatterns))}</textarea>
        <div class="hint" id="cfg-dsh-privacy-patterns-hint">${privacyPatternsHint(c.dsh?.privacy?.extraPatterns)}</div>
        <div class="hint">
          格式 <code>名字 = 正则</code>（默认<b>打码</b>、忽略大小写）；要整条拒发写 <code>拒发: 名字 = 正则</code>；
          要区分大小写就在末尾再加一段 flags，例如 <code>名字 = 正则 = g</code>；<code>#</code> 开头是注释。
          命中后会被替换成 <code>[已隐去:名字]</code>，用于封自己项目里的代号 / 内部域名 / 人名等。
        </div>
      </div>
      <div class="checkbox-row"><input type="checkbox" id="cfg-dsh-privacy-scanfile" ${c.dsh?.privacy?.scanFileContents !== false ? 'checked' : ''} />
        <label for="cfg-dsh-privacy-scanfile">发文件前扫描文本类文件内容（命中密钥/口令类就不发）</label></div>
      <div class="field-row">
        <div class="field"><label>内容扫描上限（KB）</label>
          <input type="number" id="cfg-dsh-privacy-maxscan" min="1" step="1" value="${Math.max(1, Math.round((c.dsh?.privacy?.maxScanBytes ?? 2097152) / 1024))}" /></div>
        <div class="field"><label>打码时的末尾说明</label>
          <select id="cfg-dsh-privacy-noticesuffix">
            <option value="0" ${c.dsh?.privacy?.noticeSuffix !== true ? 'selected' : ''}>不加说明</option>
            <option value="1" ${c.dsh?.privacy?.noticeSuffix === true ? 'selected' : ''}>附一句"已隐去 N 处"</option>
          </select></div>
      </div>
      <div class="checkbox-row"><input type="checkbox" id="cfg-dsh-privacy-logmatches" ${c.dsh?.privacy?.logMatches !== false ? 'checked' : ''} />
        <label for="cfg-dsh-privacy-logmatches">命中时在日志留痕（只记规则名与次数，不记内容）</label></div>
      <div class="hint">
        只剩 <code>blockOnSecrets</code> 还在 <code>data/config.json</code> 的 <code>dsh.privacy</code> 里：
        它控制"密钥/口令类整条拒发"（关掉 = 降级为打码）。之所以没搬上来 —— 这个键名含 <code>secret</code>，
        会被控制台的配置脱敏机制（<code>sanitizeConfig</code>）抹成 <code>hasBlockOnSecrets</code>，
        界面上读不到它的当前值，勾选框状态会骗人。
      </div>
      <div class="hint">
        在 QQ 里发 <b>${esc(c.dsh?.prefix || '/dsh')} 状态</b> 看当前会话、<b>${esc(c.dsh?.prefix || '/dsh')} 帮助</b> 看全部命令。
        DSH 侧还能用 <b>qq_send</b> 主动发消息、<b>qq_send_file</b> 把本机文件发到 QQ（群文件 / 私聊文件）。
        改动即时生效（自动保存），无需重启。
      </div>`
    })}

    <div class="field" style="margin-top:14px">
      <label>静默会话（只存档 / 只转发，不回复、不消耗 token）</label>
      <input type="text" id="cfg-silentchats" value="${esc((c.store?.silentChats || []).join(', '))}" placeholder="例：group:759694210, 941199011（裸号按群算）" />
      <div class="hint">
        命中的会话<b>永不调用模型</b>：消息照常进存档（历史与记忆素材不丢），链接转发、
        <code>/dsh</code> 命令等确定性功能照常生效，但不会产生任何回复、也不烧 token。
        多个用逗号或空格分隔；写裸号按<b>群</b>算。
      </div>
    </div>
    <div class="field" style="margin-top:14px">
      <button class="btn" id="blocklist-btn" style="height:44px;padding:0 28px;font-size:14px">管理屏蔽名单</button>
    </div>`;
}

function renderDesktopSection(c) {
  return `
    <h3>桌面端</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-autostart" ${c.server?.autoStart ? 'checked' : ''} />
      <label for="cfg-autostart">开机自启</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-closetray" ${c.server?.closeToTray !== false ? 'checked' : ''} />
      <label for="cfg-closetray">点关闭时最小化到托盘</label></div>
    <h3>界面</h3>
    <div class="field"><label>主题</label>
      <div class="theme-picker" id="theme-picker">
        ${['dark', 'light'].map((t) => `
          <div class="theme-option${getThemePref() === t ? ' on' : ''}" data-theme-opt="${t}" role="button" tabindex="0">
            <span class="t-ico">${THEME_ICON[t]}</span>
            <span>${THEME_LABEL[t]}</span>
          </div>`).join('')}
      </div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-showvision" ${c.ui?.showVision !== false ? 'checked' : ''} />
      <label for="cfg-showvision">模型目录显示“支持图片输入/不支持图片输入”徽标</label></div>
    <div class="field"><label>界面刷新间隔（毫秒）</label><input type="number" id="cfg-refreshms" min="1000" step="1000" value="${esc(c.ui?.refreshMs ?? 15000)}" /></div>
    <h3>数据管理</h3>
    <div class="field"><label>用户数据目录</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="cfg-datadir" readonly value="${esc(state.dataDir || '（加载中…）')}" style="flex:1" />
        <button class="btn btn-small" id="open-datadir-btn">打开文件夹</button>
      </div>
      <div class="hint">所有用户数据（配置、聊天记录、记忆、表情包）都存在这个目录里。删除后重启应用即为初始形态。</div>
    </div>
    <div class="field">
      <button class="btn btn-danger" id="reset-data-btn">重置为初始形态</button>
      <span class="hint" id="reset-data-hint" style="margin-left:10px"></span>
      <div class="hint" style="margin-top:6px">⚠️ 此操作会删除所有用户数据（配置、聊天记录、记忆、表情包），不可恢复。建议先备份。</div>
    </div>
    <h3>版本更新</h3>
    <div class="field"><label>当前版本 <b id="update-current">…</b><span id="update-status-text">${(typeof updateAvailable !== 'undefined' && updateAvailable) ? '<b style="color:var(--orange)">；发现新版本</b>' : '；检查线上是否有新版本'}</span></label>
      <div class="hint">更新源：<code>${esc(c.update?.githubRepo || 'A-common-Chinese/QQ-agent')}</code> 的最新 Release（只读检查，默认 12 小时一次；阶段 1 只下载安装包，不自动替换程序）</div>
      <div style="display:flex;gap:10px;align-items:center">
        <button class="btn btn-small" id="check-update-btn">立即检查</button>
        <span class="hint" id="update-hint" style="margin:0"></span>
      </div></div>
    <div class="field" id="update-detail" style="display:none">
      <label>新版本 <b id="update-latest"></b> <span class="hint" id="update-size"></span></label>
      <div class="hint" id="update-notes" style="white-space:pre-wrap;max-height:140px;overflow:auto;margin:6px 0"></div>
      <div style="display:flex;gap:10px;align-items:center">
        <button class="btn btn-primary" id="download-update-btn">下载安装包</button>
        <span class="hint" id="update-progress" style="margin:0"></span>
      </div>
      <div class="hint" style="margin-top:6px">⚠️ 阶段 1 只下载、不自动安装。下载完在 <code>data/updates/</code> 里，手动双击安装；升级前建议备份 <code>plugins/</code>、<code>skills/</code>、<code>snowluma/</code>。</div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-update-auto" ${c.update?.autoDownload ? 'checked' : ''} />
      <label for="cfg-update-auto">发现新版本时自动下载安装包（不自动安装）</label></div>
    <div class="field"><label>检查间隔（小时）</label><input type="number" id="cfg-update-hours" min="1" max="168" value="${esc(c.update?.intervalHours ?? 12)}" /></div>`;
}

function renderOnebotSection(c) {
  return `
    <h3 id="settings-onebot">OneBot（SnowLuma）</h3>
    <div class="hint" style="margin-bottom:10px">SnowLuma 的启动、关闭与日志已移动到顶部「SnowLuma」页签。此处只保留连接配置。</div>
    <div class="field"><label>SnowLuma 程序目录（留空 = 自动使用项目内 snowluma/ 文件夹）</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="cfg-snowlumadir" value="${esc(c.snowluma.dir || '')}" style="flex:1" />
        <button class="btn btn-small" id="open-snowluma-btn">打开文件夹</button>
      </div>
      <div class="hint" id="snowluma-hint"></div></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-snowlumalaunch" ${c.snowluma.autoLaunch ? 'checked' : ''} />
      <label for="cfg-snowlumalaunch">QQ Agent 启动时自动拉起 SnowLuma（未运行时）</label></div>
    <div class="field-row">
      <div class="field"><label>WebSocket 地址（收消息）</label><input type="text" id="cfg-wsurl" value="${esc(c.snowluma.wsUrl)}" /></div>
      <div class="field"><label>HTTP 地址（发消息）</label><input type="text" id="cfg-httpurl" value="${esc(c.snowluma.httpUrl)}" /></div>
      <div class="field"><label>WebSocket 令牌</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-obtoken" value="${esc(c.snowluma?.hasAccessToken ? '******' : '')}" placeholder="输入新令牌可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-obtoken-toggle" type="button">显示</button>
        </div></div>
      <div class="field"><label>HTTP 令牌（与 WS 不同时填；SnowLuma 默认分开）</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-obhttptoken" value="${esc(c.snowluma?.hasHttpAccessToken ? '******' : '')}" placeholder="输入新令牌可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-obhttptoken-toggle" type="button">显示</button>
        </div></div>
    </div>
    <div class="hint">改完 OneBot 地址需要重启应用生效；模型/人设/白名单即时生效。</div>`;
}

/**
 * 刷新 Skill 状态（后端判定结果）。
 * 单独抽出来是因为开关切换后需要立即重取，而不是等下一次 loadSettings。
 */
/**
 * 拉取技能/插件列表（内存态）。**不含磁盘重扫** —— 想让新放入的目录
 * 被看到，走 rescanSkills()。
 */
async function loadSkillsStatus() {
  try {
    const data = await api('/api/skills');
    state.skills = data.skills || [];
    state.skillsSummary = data.summary || {};
    state.uninstalledSkills = data.uninstalled || [];
  } catch {
    /* 取不到就保持原值，不覆盖成空列表造成"条目都不见了"的假象 */
  }
}

/**
 * 重扫磁盘并刷新列表：技能/插件页「刷新」按钮的完整动作。
 * 之前刷新只重读内存注册表，后台文件监听一旦丢事件（目录删除重建、
 * 网络盘、杀毒软件），放进去的新插件无论点多少次刷新都看不到。
 * 现在先 POST /api/skills/reload 让后端真正重扫；接口不可用时退回
 * 普通列表拉取（不比旧行为差）。
 */
async function rescanSkills({ quiet = false } = {}) {
  try {
    const r = await api('/api/skills/reload', { method: 'POST' });
    if (r && r.skills) {
      state.skills = r.skills;
      state.skillsSummary = r.summary || {};
      // 重扫接口的响应没有 uninstalled 字段，补拉一次（很轻，还能顺带拿脱敏配置）
      await loadSkillsStatus();
      if (!quiet && r.failed?.length) {
        console.warn('[skill] 本次重扫失败条目：', r.failed);
      }
      return r;
    }
  } catch (e) {
    console.warn('[skill] 重扫请求失败：', e?.message || e);
  }
  await loadSkillsStatus();
  return null;
}

/**
 * 技能设置弹窗。
 *
 * 为什么把设置放在技能自己的弹窗里（而不是塞进设置页）：
 *   · 这些字段**只对这个技能有意义** —— 分散在全局设置页里，用户根本对不上号
 *   · 技能页本来就该是"这个技能能配什么"的唯一入口
 *   · 开关和设置放在一起，改完立刻能看到状态徽章变化
 *
 * 表单**完全按 manifest 的 configSchema 渲染**，前端不硬编码任何字段名 ——
 * 加一个新技能、加一个字段，这里一行都不用改。
 * 支持的 type：boolean（复选框）/ number（数字输入）/ enum（下拉）/ string（文本框）
 * 另外 secret: true 的字段用密码框，且留空 = 不修改（后端也按同一约定处理）。
 */
/**
 * 生成技能设置弹窗的 HTML（**纯函数**，不碰 DOM）。
 *
 * 拆出来的唯一目的是可测：这次改动的重点是视觉层级
 * （名字用等宽大字、介绍用正文小字、模态框加宽），
 * 埋在 DOM 操作里就只能靠肉眼看，改坏了没人发现。
 *
 * @returns {{ html: string } | { error: string }}
 */
function renderSkillSettingsModal(skill) {
  if (!skill) return { error: '技能不存在' };
  const skillId = skill.id;
  const schema = skill.configSchema || {};
  const values = skill.settings || {};
  // internal 字段（列表/对象类）不渲染成表单输入 —— 它们由专用界面管理。
  // 但仍然要在弹窗里列出来并说明去哪改，否则用户会以为"这个设置根本不存在"。
  const allKeys = Object.keys(schema);
  const internalKeys = allKeys.filter((k) => schema[k]?.type === 'internal');
  const keys = allKeys.filter((k) => schema[k]?.type !== 'internal');
  if (!allKeys.length) return { error: '这个技能没有可配置项' };

  const fieldHtml = (key) => {
    const d = schema[key] || {};
    const v = values[key] ?? d.default ?? '';
    const label = esc(d.label || key);
    const hint = d.description ? `<div class="hint">${esc(d.description)}</div>` : '';
    const id = `skset-${esc(skillId)}-${esc(key)}`;
    // secret：用密码框 + 占位符提示"留空不改"，避免把脱敏值当明文回填
    const isSecret = d.secret === true;
    // 长文本字段跨整行：窄列里换行会碎成一条，读起来很累
    const isWide = d.type === 'string' && (d.multiline === true || String(d.description || '').length > 60);
    const cls = 'field' + (isWide ? ' field--wide' : '');
    let input;
    if (d.type === 'boolean') {
      // 整行做成可点区域：单摆一个小复选框在宽弹窗里像没渲染完
      input = `<label class="skill-toggle-row">
        <input type="checkbox" id="${id}" data-key="${esc(key)}" data-type="boolean" ${v ? 'checked' : ''} />
        <span class="st-text">${v ? '已开启' : '已关闭'}</span>
      </label>`;
    } else if (d.type === 'number') {
      input = `<input type="number" id="${id}" data-key="${esc(key)}" data-type="number" value="${esc(v)}" step="any" />`;
    } else if (d.type === 'enum' && Array.isArray(d.values)) {
      // 枚举渲染成下拉：值写错会让技能行为异常，下拉从根上避免手抖
      input = `<select id="${id}" data-key="${esc(key)}" data-type="enum">${
        d.values.map((x) => `<option value="${esc(x)}" ${String(v) === String(x) ? 'selected' : ''}>${esc(x)}</option>`).join('')
      }</select>`;
    } else {
      input = `<input type="${isSecret ? 'password' : 'text'}" id="${id}" data-key="${esc(key)}" data-type="string" value="${isSecret ? '' : esc(v)}" placeholder="${isSecret ? (v ? '已设置（留空 = 不修改）' : '未设置') : ''}" autocomplete="off" />`;
    }
    return `<div class="${cls}"><label>${label}${d.secret ? ' 🔒' : ''}</label>${input}${hint}</div>`;
  };

  return { html: `<div class="modal skill-modal" role="dialog" aria-modal="true" aria-label="${esc(skill.name)} 设置">
    <div class="skill-modal__head">
      <div class="skill-modal__titles">
        <div class="skill-modal__name">
          ${esc(skill.name)}
          <span class="skill-modal__ver">v${esc(skill.version || '')}</span>
        </div>
        <div class="skill-modal__id">${esc(skillId)}</div>
        <div class="skill-modal__desc">${esc(skill.description || '（这个技能没有写介绍）')}</div>
      </div>
      <button class="icon-btn" id="skset-x" title="关闭" aria-label="关闭">✕</button>
    </div>
    <div class="skill-modal__body">
      <div class="skill-modal__note">
        共 <b>${keys.length}</b> 项设置 · 保存在 <code>config.skills['${esc(skillId)}']</code>，只有这个技能会读到它们。
      </div>
      <div class="skill-form">${keys.map(fieldHtml).join('')}</div>
      ${internalKeys.length ? `<div class="skill-modal__internal">
        <div class="skill-modal__internal-head">以下设置不在这里改</div>
        ${internalKeys.map((k) => `<div class="skill-modal__internal-item"><b>${esc(schema[k].label || k)}</b><br />${esc(schema[k].description || '')}</div>`).join('')}
      </div>` : ''}
    </div>
    <div class="skill-modal__foot">
      <span class="skill-modal__foot-tip">改动即时生效，无需重启</span>
      <span class="spacer"></span>
      <button class="btn btn-small" id="skset-cancel">取消</button>
      <button class="btn btn-primary" id="skset-save">保存</button>
    </div>
  </div>` };
}

/** 打开某个技能的设置弹窗。 */
function openSkillSettings(skillId) {
  const skill = (state.skills || []).find((x) => x.id === skillId);
  if (!skill) return;
  const built = renderSkillSettingsModal(skill);
  if (built.error) { alert(built.error); return; }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = built.html;
  document.body.appendChild(overlay);

  const close = () => closeAnimatedOverlay(overlay);
  overlay.querySelector('#skset-x').addEventListener('click', close);
  overlay.querySelector('#skset-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  // Esc 关闭：弹窗大了以后鼠标要移很远，键盘出口是必需的
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  overlay.setAttribute('tabindex', '-1');
  overlay.focus();

  // 复选框旁边的"已开启/已关闭"文字要跟着变，否则看不出当前状态
  overlay.querySelectorAll('input[type="checkbox"][data-type="boolean"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const span = cb.parentElement?.querySelector('.st-text');
      if (span) span.textContent = cb.checked ? '已开启' : '已关闭';
    });
  });

  overlay.querySelector('#skset-save').addEventListener('click', async () => {
    const settings = {};
    overlay.querySelectorAll('[data-key]').forEach((el) => {
      const key = el.dataset.key;
      const type = el.dataset.type;
      if (type === 'boolean') settings[key] = el.checked;
      else if (type === 'number') {
        const n = Number(el.value);
        // 空值/非数字：不提交这个键，让后端保留原值（而不是写进一个 NaN）
        if (el.value.trim() !== '' && Number.isFinite(n)) settings[key] = n;
      } else if (type === 'enum') settings[key] = el.value;
      else settings[key] = el.value;   // secret 留空 → 后端按"不修改"处理
    });
    try {
      const r = await api(`/api/skills/${encodeURIComponent(skillId)}`, {
        method: 'POST',
        body: JSON.stringify({ settings })
      });
      const idx = (state.skills || []).findIndex((x) => x.id === skillId);
      if (idx >= 0 && r.skill) {
        // 后端返回的是 status 视图；把设置与 schema 合并回去，避免卡片丢掉这两项
        state.skills[idx] = { ...state.skills[idx], ...r.skill, settings: r.settings || {}, configSchema: state.skills[idx].configSchema };
      }
      if (r.config) state.config = r.config;
      await loadSkillsStatus();
      // 两页都重绘：设置弹窗可能从技能页或插件页打开，
      // 而改动会同时影响状态徽章。重绘代价可忽略（每页最多十来张卡片）。
      renderModulePage('skill');
      renderModulePage('plugin');
      close();
    } catch (err) {
      alert(`保存失败：${err.message}`);
    }
  });
}

/**
 * 扩展页（技能 / 插件）
 *
 * 两型在**代码里完全同构**（同一条加载器、同一套清单字段、同一个开关），
 * 唯一的区别是"谁决定何时执行"：
 *   skill  （LLM 型）  —— 注册工具，模型看了 description 自己决定调不调
 *   plugin （确定性型）—— 提供能力/钩子，核心代码按能力名确定性调用，必然执行
 *
 * 这件事对使用者太重要了（决定"这个功能会不会被模型忽略"），所以拆成两个页签，
 * 但渲染逻辑共用一份 —— 否则两页的卡片、分组、开关行为迟早会分叉。
 *
 * ⚠️ 状态一律用后端 /api/skills 的判定结果，前端**不自己推断**能不能用 ——
 * 否则又会出现"界面说能用、实际不生效"的两套口径。
 */
const MODULE_KINDS = {
  skill: {
    kind: 'skill',
    tab: 'skills',
    boxSel: '#skills-page',
    title: '技能（Skill）',
    dir: 'skills/',
    emptyHint: `还没加载到任何技能。<br />LLM 型技能放在项目的 <code>skills/&lt;id&gt;/</code> 目录，需要 <code>skill.json</code> + <code>index.js</code>。`,
    lead: `技能是 <b>LLM 型</b>扩展：它们注册工具进模型的 function 列表，<b>用不用、什么时候用由模型自己判断</b>。<br />
      所以技能不会"一定生效" —— 模型可能一直不调用它。需要"条件满足必跑"的功能，应该做成插件（见旁边的「插件」页签）。`,
    setupTitle: '新增技能',
    setupHint: `在 <code>skills/&lt;id&gt;/</code> 放 <code>skill.json</code> + <code>index.js</code>，
      导出 <code>setup(api)</code> 并在里面 <code>api.registerTool({...})</code>。
      热重载默认开启，保存即生效。完整规范见 <code>doc/extend_development/skill-development.md</code>。`
  },
  plugin: {
    kind: 'plugin',
    tab: 'plugins',
    boxSel: '#plugins-page',
    title: '插件（Plugin）',
    dir: 'plugins/',
    emptyHint: `还没加载到任何插件。<br />确定性型插件放在项目的 <code>plugins/&lt;id&gt;/</code> 目录，需要 <code>plugin.json</code> + <code>index.js</code>。`,
    lead: `插件是 <b>确定性型</b>扩展：它们提供<b>能力</b>（<code>providers</code>）或<b>钩子</b>（<code>hooks</code>），
      由核心代码按能力名确定性调用 —— <b>条件满足就一定会执行，不经过 LLM，模型想忽略也忽略不掉</b>。<br />
      代价是它不能"看情况发挥"：什么时候触发必须在代码里写死。需要模型理解意图的功能，应该做成技能（见旁边的「技能」页签）。`,
    setupTitle: '新增插件',
    setupHint: `在 <code>plugins/&lt;id&gt;/</code> 放 <code>plugin.json</code> + <code>index.js</code>，
      导出 <code>setup(api)</code>，并用 <code>export const providers = {...}</code> 或 <code>export const hooks = {...}</code> 声明扩展点。
      热重载默认开启，保存即生效。完整规范见 <code>doc/extend_development/plugin-development.md</code>。`
  }
};

async function loadModulePage(kind, { rescan = false } = {}) {
  const meta = MODULE_KINDS[kind];
  if (!meta) return;
  const box = $(meta.boxSel);
  if (!box) return;
  box.innerHTML = renderModuleSkeleton(meta);
  if (rescan) await rescanSkills({ quiet: true });
  else await loadSkillsStatus();
  renderModulePage(kind);
  // 页面整页重建（切页签 / 手动刷新）时内容淡入；卡片开关后的原地重绘不播
  uiEnter(box);
}

function renderModuleSkeleton(meta) {
  return `<div class="usage-wrap">
    <div class="usage-head"><h2>${esc(meta.title)}</h2></div>
    <div class="sk-block">${'<div class="sk-row"></div>'.repeat(5)}</div>
  </div>`;
}

/**
 * 渲染一页（技能或插件）。
 *
 * @param {'skill'|'plugin'} kind 只渲染该类型；另一类的条目**完全不进这一页**
 */
function renderModulePage(kind) {
  const meta = MODULE_KINDS[kind];
  if (!meta) return '';
  const box = $(meta.boxSel);
  const all = state.skills || [];
  // 只留本页该管的类型。
  // ⚠️ kind 为 null（自定义根目录，如测试用的临时目录）时归入**技能页**而不是丢弃 ——
  // "界面上凭空少了一个条目"比"归错页"难排查得多（用户刚刚就踩过这个坑）。
  // 卡片上会标「目录未识别」提示作者去确认放置位置。
  const items = all.filter((s) => s.kind === meta.kind || (s.kind == null && meta.kind === 'skill'));

  // 统计按本页条目现算：后端 summary 是全量的，直接用会把另一类也算进来
  const mine = {
    total: items.length,
    active: items.filter((s) => s.active).length,
    off: items.filter((s) => s.loaded && !s.enabled).length,
    broken: items.filter((s) => !s.loaded).length
  };

  if (!items.length) {
    const emptyHtml = `<div class="usage-wrap">
      <div class="usage-head"><h2>${esc(meta.title)}</h2>
        <button class="btn btn-small" id="${esc(meta.tab)}-add-btn" title="从市场口令安装，或查看自建指南">＋ 添加${meta.kind === 'skill' ? '技能' : '插件'}</button>
        <div class="usage-days">
          <button class="btn btn-small" id="${esc(meta.tab)}-refresh-btn">刷新</button>
        </div></div>
      <div class="empty-hint">${meta.emptyHint}</div>
      <div class="hint" style="margin-top:10px">${meta.lead}</div>
    </div>`;
    if (box) box.innerHTML = emptyHtml;
    bindModulePageEvents(kind);
    return emptyHtml;
  }

  const catLabel = { model: '模型', message: '消息', knowledge: '知识', media: '媒体', utility: '工具' };

  // 按分类分组：一屏里按功能归类，比一长串平铺好找
  const order = ['model', 'message', 'media', 'knowledge', 'utility'];
  const byCat = new Map();
  for (const s of items) {
    const c = order.includes(s.category) ? s.category : 'utility';
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push(s);
  }

  // ── 卡片：单列一行，名称+简介常显，上传/设置钉在行尾 ──
  // 不再做正反面翻转（悬停才看简介）；按钮固定在内容框后侧，不随文字换行。
  const card = (s) => {
    const loadedOk = s.loaded;
    const active = loadedOk && s.enabled && s.active;
    const stateCls = !loadedOk ? 'mcard-broken' : (!s.enabled ? 'mcard-off' : (active ? 'mcard-on' : 'mcard-dep'));
    const stateTitle = !loadedOk ? `加载失败：${s.loadError || '原因未知'}`
      : (!s.enabled ? '已关闭（点击开启）'
        : (active ? '生效中（点击关闭）' : `已启用但依赖未就绪：${s.reason || (s.missingRequires || []).join('、') || '原因未知'}`));
    // 无法真正生效时，把原因写在卡片上（不再只藏在 title 提示里）
    let errLine = '';
    if (!loadedOk) {
      errLine = String(s.loadError || '加载失败，原因未知').slice(0, 160);
    } else if (s.enabled && !s.active) {
      errLine = String(s.reason || (s.missingRequires || []).map((r) => `缺少能力：${r}`).join('、') || '依赖未就绪').slice(0, 160);
    }
    const allFields = Object.keys(s.configSchema || {});
    const settingsBtn = allFields.length
      ? `<button class="mcard-gear" data-skill-id="${esc(s.id)}" title="设置（${allFields.length} 项）" aria-label="打开 ${esc(s.name)} 的设置">⚙</button>`
      : '';
    const uploadBtn = `<button class="mcard-upload" data-skill-id="${esc(s.id)}" data-skill-kind="${kind}" title="上传到市场" aria-label="上传 ${esc(s.name)} 到市场">⬆</button>`;
      const delBtn = `<button class="mcard-del" data-skill-id="${esc(s.id)}" data-skill-name="${esc(s.name)}" title="删除（移到回收站，可恢复）" aria-label="删除 ${esc(s.name)}">🗑</button>`;
    const haystack = [s.id, s.name, s.description, s.dir].filter(Boolean).join(' ').toLowerCase();
    return `
    <div class="mcard ${stateCls}" data-skill-id="${esc(s.id)}" data-search="${esc(haystack)}" role="button" tabindex="0" title="${esc(stateTitle)}">
      <div class="mcard-main">
        <div class="mcard-name">${esc(s.name)} <span class="skill-card__ver">v${esc(s.version)}</span></div>
        ${(s.toolIds || []).length ? `<div class="mcard-tools" title="本技能注册的工具 id">${(s.toolIds || []).map((id) => `<code class="mcard-tool-id">${esc(id)}</code>`).join('')}</div>` : ''}
        <div class="mcard-desc">${esc(s.description || '（没有写介绍）')}</div>
        ${errLine ? `<div class="mcard-err">${esc(errLine)}</div>` : ''}
      </div>
      <div class="mcard-acts">${uploadBtn}${settingsBtn}${delBtn}</div>
    </div>`;
  };

  const sections = [...byCat.entries()].map(([cat, list]) => `
    <h3 class="usage-h3">${catLabel[cat] || cat}（${list.length}）</h3>
    <div class="module-grid">
      ${list.map(card).join('')}
    </div>
  `).join('');

  // 残留配置：只在技能页展示一次（两页共用 state）。
  const uninstalledHtml = (kind === 'skill' && (state.uninstalledSkills || []).length)
    ? `<h3 class="usage-h3">已配置但未安装（${state.uninstalledSkills.length}）</h3>
      <div class="hint" style="margin-bottom:6px">这些条目在配置里留着开关/设置，但 <code>skills/</code> 与 <code>plugins/</code> 目录里已经没有对应的文件夹。重装同名插件会自动恢复这些设置；确认不要了可以清理掉。</div>
      <div class="tool-meta" style="gap:6px;margin-bottom:8px">
        ${state.uninstalledSkills.map((u) => `<span class="tool-dep">${esc(u.id)}${u.enabled ? '' : '（已关）'}${u.hasSettings ? ' · 有设置' : ''}</span>`).join('')}
      </div>
      <button class="btn btn-small" id="skills-cleanup-btn">清理这些残留配置</button>`
    : '';

  const html = `<div class="usage-wrap">
      <div class="usage-head">
        <h2>${esc(meta.title)}</h2>
        <button class="btn btn-small" id="${esc(meta.tab)}-add-btn" title="从市场口令安装，或查看自建指南">＋ 添加${meta.kind === 'skill' ? '技能' : '插件'}</button>
        <input type="search" class="module-search" id="module-search-${esc(meta.tab)}"
          placeholder="搜索${meta.kind === 'skill' ? '技能' : '插件'}名称 / 简介…" autocomplete="off" />
        <div class="usage-days">
          <span class="uc-tag" title="生效中 / 这一页的总数">${mine.active} / ${mine.total} 生效</span>
          <button class="btn btn-small" id="${esc(meta.tab)}-refresh-btn">刷新</button>
        </div>
      </div>
      <div class="hint" style="margin-bottom:14px">
        ${meta.lead}<br />
        开关只有这一处 —— 关闭后它注册的工具、提供的能力、提示词片段和请求改写会**同时**失效。
        不可用时下面会直接写明原因（未启用 / 缺依赖 / 模型不支持 / 加载失败）。
      </div>
      ${sections}
      ${uninstalledHtml}
    </div>`;

  if (box) box.innerHTML = html;
  bindModulePageEvents(kind);
  if (typeof enhanceConcept2UI === 'function') enhanceConcept2UI(box);
  return html;
}

/** 供渲染测试按名取用的两个入口（render-test 会逐个执行这些函数）。 */
function renderSkillsPage() { return renderModulePage('skill'); }
function renderPluginsPage() { return renderModulePage('plugin'); }

function bindModulePageEvents(kind) {
  const meta = MODULE_KINDS[kind];
  if (!meta) return;
  // 「＋ 添加」入口（标题旁）：打开添加模态框（去市场口令安装 / 自建指南）。
  // ⚠️ 这个入口曾经从模板里消失过 —— openAddModuleModal 变成没人调用的孤本，
  // 技能/插件页直接失去"添加"能力。按钮与绑定必须成对存在（2026-09-26 修复）。
  $(`#${meta.tab}-add-btn`)?.addEventListener('click', () => openAddModuleModal(kind));
  $(`#${meta.tab}-refresh-btn`)?.addEventListener('click', () => loadModulePage(kind, { rescan: true }));
  // 残留配置清理（只在技能页渲染，按钮也只在这一页出现）
  $('#skills-cleanup-btn')?.addEventListener('click', async () => {
    const btn = $('#skills-cleanup-btn');
    if (!btn || !state.uninstalledSkills?.length) return;
    const ids = state.uninstalledSkills.map((u) => u.id);
    if (!(await uiConfirm(`清理 ${ids.length} 个未安装条目的配置（${ids.join('、')}）？\n清理后重装同名插件将恢复默认设置。`))) return;
    btn.disabled = true;
    try {
      const r = await api('/api/skills/cleanup', { method: 'POST', body: JSON.stringify({ ids }) });
      if (r.config) state.config = r.config;
      await loadModulePage('skill');
    } catch (e) {
      alert(`清理失败：${e?.message || e}`);
      btn.disabled = false;
    }
  });
  // 注意这里是 $$ （返回数组）不是 $（返回单个元素）：
  // 卡片可能有多个，用 $ 会拿到一个元素然后 .forEach 报错。
  // ⚠️ 绑定范围必须限定在**本页容器内**：两个页面同时存在于 DOM 里（只是 view 切换显隐），
  // 用全局 $$ 会把另一页的卡片也绑一遍 —— 同一个开关被绑两次，一次切换会发两个请求。
  const scope = $(meta.boxSel);
  if (!scope) return;
  scope.querySelectorAll('.skill-settings-btn, .mcard-gear').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();   // 齿轮在卡片内部，点它不能触发整卡开关
      openSkillSettings(btn.dataset.skillId);
    });
  });
  // 上传到市场（⬆ 钮）：同样 stopPropagation，且带上卡片所属类型
  scope.querySelectorAll('.mcard-upload').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openMarketUploadModal(btn.dataset.skillKind || kind, btn.dataset.skillId);
    });
  });
    // 删除（🗑）：移到回收站 + 清配置段，然后重扫
    scope.querySelectorAll('.mcard-del').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();
        const id = btn.dataset.skillId;
        const name = btn.dataset.skillName || id;
        if (!(await uiConfirm(`删除「${name}」？

目录会移到 data/trash/extensions/（可恢复），同时清掉它的配置段。
想恢复：把目录移回 skills/ 或 plugins/，再点「刷新」即可。`))) return;
        btn.disabled = true;
        try {
          const r = await api('/api/skills/delete', { method: 'POST', body: JSON.stringify({ id }) });
          if (r.config) state.config = r.config;
          await loadModulePage(kind, { rescan: true });
        } catch (err) {
          alert(`删除失败：${err?.message || err}`);
          btn.disabled = false;
        }
      });
    });

  // ── 整卡即开关：点击卡片任意处切换启停（复用原 skill-toggle 的请求链）──
  // 键盘可达：Enter/Space 同样触发（role=button + tabindex=0）。
  scope.querySelectorAll('.mcard').forEach((cardEl) => {
    const toggle = async () => {
      const id = cardEl.dataset.skillId;
      const cur = (state.skills || []).find((s) => s.id === id);
      if (!cur || !cur.loaded) return;   // 加载失败的条目切不动
      const next = !cur.enabled;
      cardEl.style.pointerEvents = 'none';
      try {
        const r = await api(`/api/skills/${encodeURIComponent(id)}`, {
          method: 'POST',
          body: JSON.stringify({ enabled: next })
        });
        const idx = (state.skills || []).findIndex((s) => s.id === id);
        if (idx >= 0 && r.skill) state.skills[idx] = r.skill;
        if (r.config) state.config = r.config;
        await loadSkillsStatus();
        renderModulePage(kind);
      } catch (err) {
        alert(`切换失败：${err.message}`);
        cardEl.style.pointerEvents = '';
      }
    };
    cardEl.addEventListener('click', toggle);
    cardEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  });

  // 顶部搜索：按卡片 data-search 本地过滤（不整页重绘，保留开关状态与滚动）
  const searchInput = scope.querySelector('.module-search');
  if (searchInput) {
    const applyFilter = () => {
      const q = searchInput.value.trim().toLowerCase();
      scope.querySelectorAll('.mcard').forEach((el) => {
        const hay = el.dataset.search || '';
        el.style.display = (!q || hay.includes(q)) ? '' : 'none';
      });
      // 分类标题：组内卡片被滤光则标题一并藏掉
      scope.querySelectorAll('.module-grid').forEach((grid) => {
        const any = [...grid.querySelectorAll('.mcard')].some((el) => el.style.display !== 'none');
        grid.style.display = any ? '' : 'none';
        const h = grid.previousElementSibling;
        if (h && h.classList.contains('usage-h3')) h.style.display = any ? '' : 'none';
      });
    };
    searchInput.addEventListener('input', applyFilter);
  }
}

function renderToolsSection(c) {
  // 技能失活（未启用 / 加载失败 / 依赖未就绪）时，它注册的工具整组**不再显示** ——
  // 与提示词口径一致（orchestrator 的 getToolAvailability 过滤，失活技能的工具
  // 也不会写进提示词）。"界面看得到、模型用不到"和"界面看不到、提示词却写了"
  // 都是要消灭的割裂。
  const skillActive = new Map((state.skills || []).map((s) => [s.id, s.active === true]));
  const tools = (state.toolRegistry || []).filter((t) => !t.skillId || skillActive.get(t.skillId) === true);
  const toolsCfg = c.tools || {};
  // 分类清单必须与 tool-registry 的 CATEGORY_META 同源（8 类）：
  // 曾经只列 6 类，media/knowledge 两类的工具（send_image、bili-meme 等）
  // 在设置页无卡片 → 无分类开关也无单工具开关，只能手改 JSON。
  const categories = ['messaging', 'sticker', 'query', 'memory', 'web', 'knowledge', 'media', 'system'];
  const categoryNames = {
    messaging: '💬 消息发送',
    sticker: '😀 表情管理',
    query: '🔍 消息查询',
    memory: '🧠 记忆系统',
    web: '🌐 联网搜索',
    knowledge: '📚 知识库',
    media: '🎞️ 媒体理解',
    system: '⚙️ 系统反馈'
  };

  // 按分类分组
  const byCategory = {};
  for (const t of tools) {
    if (!byCategory[t.category]) byCategory[t.category] = [];
    byCategory[t.category].push(t);
  }

  // 渐进式披露：默认折叠，点击展开
  const expandedCategories = state.expandedToolCategories || new Set(['messaging']); // 默认展开第一个

  const categoryCards = categories.map((cat) => {
    const catTools = byCategory[cat] || [];
    if (!catTools.length) return '';
    const catEnabled = toolsCfg.categories?.[cat] !== false;
    const isExpanded = expandedCategories.has(cat);

    const toolCards = isExpanded ? catTools.map((t) => {
      const enabled = toolsCfg.overrides?.[t.id] ?? t.defaultEnabled ?? true;
      const disabledByDep = (t.requiresVision && c.api?.vision === false) || (t.requiresSearch && c.webSearch?.enabled === false);
      // 功能名字 + 一句话概括（description 可能缺失，不能直接 .split）
      const funcName = String(t.id || '').split(':').pop();
      const summary = String(t.description || '（无说明）').split('。')[0] + '。';
      // send_to 的开关就是「跨会话发送」本身（tools.crossChatSend）：
      // 开关收编进消息发送分类，用户在工具卡上直接控制，不再单独设全局勾选框。
      const isSendTo = t.id === 'send_to';
      const checked = isSendTo ? (toolsCfg.crossChatSend === true) : enabled;
      const chkId = `tool-chk-${t.id.replace(/[^\w-]/g, '_')}`;
      return `
        <div class="tool-card ${checked ? 'enabled' : 'disabled'} ${disabledByDep ? 'dep-disabled' : ''}" data-tool-id="${t.id}">
          <div class="tool-header">
            <label class="switch tool-switch">
              <input type="checkbox" class="tool-checkbox" id="${chkId}" data-tool-id="${t.id}" ${isSendTo ? 'data-cross-chat="1"' : ''} ${checked ? 'checked' : ''} ${disabledByDep && !isSendTo ? 'disabled' : ''} />
              <span class="track"><span class="thumb"></span></span>
            </label>
            <span class="tool-icon">${t.icon}</span>
            <div class="tool-title">
              <div class="tool-name">${esc(funcName)}${t.skillId ? '<span class="tool-dep tool-skill">skill</span>' : ''}</div>
              <div class="tool-summary">${esc(summary)}</div>
            </div>
          </div>
          <div class="tool-meta">
            ${t.requiresVision ? '<span class="tool-dep">需要视觉模型</span>' : ''}
            ${t.requiresSearch ? '<span class="tool-dep">需要搜索服务</span>' : ''}
            ${disabledByDep ? '<span class="tool-dep-warn">依赖未满足</span>' : ''}
            ${isSendTo ? '<span class="tool-dep">目标须在白名单内</span>' : ''}
          </div>
        </div>`;
    }).join('') : '';

    return `
      <div class="tool-category ${isExpanded ? 'expanded' : 'collapsed'}" data-category="${cat}">
        <div class="tool-category-header" data-category="${cat}" role="button" tabindex="0">
          <span class="tool-category-arrow">${isExpanded ? '▼' : '▶'}</span>
          <span class="tool-category-name">${categoryNames[cat] || cat}</span>
          <label class="tool-category-toggle switch" onclick="event.stopPropagation()">
            <input type="checkbox" class="category-checkbox" data-category="${cat}" ${catEnabled ? 'checked' : ''} />
            <span class="track"><span class="thumb"></span></span>
          </label>
          <span class="tool-category-count">${catTools.length} 个工具</span>
        </div>
        ${isExpanded ? `<div class="tool-list">${toolCards}</div>` : ''}
      </div>`;
  }).join('');

  // ⚠️ 必须落在顶层 setCard 里：renderSettingsSection 直接嵌这一段时，
  // autoFoldSettings 会按 h3 把整页重包成折叠卡，再把 .fold-head 绑到
  // 分类头上 —— 点分类会开合整块面板，grid-rows 折叠把下半屏撑出大片空白。
  const fold = (typeof setCard === 'function') ? setCard : (o) => `<div class="setcard">${o.body}</div>`;
  return `
    <h3 id="settings-tools">工具与技能</h3>
    <div class="hint" style="margin-bottom:12px">
      打开开关启用机器人可调用的工具。关闭后模型将无法使用该功能。
      ${toolsCfg.enabled === false ? '<span style="color:var(--red)">⚠️ 全局开关已关闭，所有工具均不可用</span>' : ''}
    </div>
    ${fold({
      id: 'card-tools-list',
      icon: '🛠',
      title: '工具列表',
      sub: '按分类展开；开关即时保存',
      open: true,
      body: `
        <div class="checkbox-row">
          ${switchHtml('cfg-tools-enabled', toolsCfg.enabled !== false, '启用工具系统（关闭后机器人只能看不能做任何操作）')}
        </div>
        <div class="tool-actions" style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-small" id="tools-enable-all">全部启用</button>
          <button class="btn btn-small" id="tools-disable-all">全部禁用</button>
          <button class="btn btn-small" id="tools-reset">恢复默认</button>
        </div>
        ${categoryCards || '<div class="hint">（还没有注册任何工具）</div>'}`
    })}`;
}

/**
 * 完整提示词预览文本（设置-工具与技能 & 技能页右侧共用同一份）。
 * 数据来自 GET /api/prompt-preview —— 后端用运行时同一套
 * buildSystemPrompt + getToolAvailability 组装，按当前启停状态实时反映；
 * 前端不再自己拼（曾经前端复制了一份静态模板，永远是"全启用"的样子，
 * 与实际发送的提示词越漂越远）。
 * 后端返回结果缓存在 state.promptPreview；render* 渲染时同步取，
 * 开关变动后由 refreshPromptPreview() 异步拉新并原地更新 DOM。
 */
function renderPromptPreviewText() {
  const d = state.promptPreview;
  if (!d || typeof d.systemPrompt !== 'string') return '（正在加载提示词预览…）';
  const tools = d.tools || [];
  const toolLines = tools.length
    ? tools.map((t) => `- ${t.id}：${t.description}`).join('\n')
    : '（当前没有可用工具）';
  return `${d.systemPrompt}\n\n【本次可用工具清单（function calling）】\n${toolLines}`;
}

/**
 * 拉取/刷新提示词预览。
 * 实时性设计（2026-09-17）：预览读的是**后端活配置**（getConfig），而设置的
 * 自动保存有 600ms 防抖 —— 直接刷看到的是旧状态。所以本函数可带 overrides
 * （与配置同结构的临时补丁）：请求发给 /api/prompt-preview，后端先深合并补丁
 * 再组装（不落盘），预览即刻反映刚点的开关，不用等自动保存落地。
 */
async function refreshPromptPreview(overrides = null) {
  try {
    // 空对象不附 body（GET 语义）——没有补丁就按后端活配置组装
    const hasOverrides = overrides && Object.keys(overrides).length > 0;
    const d = await api('/api/prompt-preview', hasOverrides ? {
      method: 'POST',
      body: JSON.stringify(overrides)
    } : {});
    state.promptPreview = d;
  } catch {
    state.promptPreview = null;
  }
  // 两处预览 DOM（设置-工具页 / 技能页右侧）都原地换文本，不整页重渲染
  $$('.prompt-preview-content').forEach((pre) => {
    pre.textContent = renderPromptPreviewText();
  });
}

  // ── 共用段预设（多份：选中 / 保存覆盖 / 另存为 / 设为当前 / 删除）──
  function pv2SharedPickId() {
    const box = (typeof state !== 'undefined' && state.personaSharedPresets) || { activeId: '', items: [] };
    return String((typeof state !== 'undefined' && state.pv2SharedPick) || '') || String(box.activeId || '');
  }
  function pv2SharedFields() {
    return {
      name: String((document.getElementById('pv2-shared-name') || {}).value || '').trim(),
      core: String((document.getElementById('pv2-shared-core') || {}).value || ''),
      voice: String((document.getElementById('pv2-shared-voice') || {}).value || '')
    };
  }
  async function pv2PickShared(id) {
    if (typeof state !== 'undefined') state.pv2SharedPick = String(id || '');
    await pv2Reload();
  }
  async function pv2SaveSharedNew() {
    const pick = pv2SharedPickId();
    const { name, core, voice } = pv2SharedFields();
    try {
      if (pick) {
        await pv2Api('PUT', '/api/persona-shared/presets/' + encodeURIComponent(pick), { name, core, voice });
        pv2Hint('pv2-shared-hint', '已保存到「' + (name || pick) + '」（core ' + core.length + ' / voice ' + voice.length + ' 字）✅', 'var(--green)');
      } else {
        await pv2Api('POST', '/api/persona-shared/presets', { name: name || '默认共用段', core, voice, activate: true });
        pv2Hint('pv2-shared-hint', '已新建并设为当前使用 ✅', 'var(--green)');
      }
      await pv2Reload();
    } catch (e) { pv2Hint('pv2-shared-hint', '失败：' + (e?.message || e), 'var(--red)'); }
  }
  async function pv2NewShared() {
    const { name, core, voice } = pv2SharedFields();
    if (!core.trim() && !voice.trim()) { pv2Hint('pv2-shared-hint', '内容是空的，先写点东西', 'var(--orange)'); return; }
    try {
      const r = await pv2Api('POST', '/api/persona-shared/presets', { name: name || ('共用段 ' + new Date().toLocaleString('zh-CN')), core, voice, activate: true });
      if (typeof state !== 'undefined') state.pv2SharedPick = r?.item?.id || '';
      pv2Hint('pv2-shared-hint', '已另存为新预设并设为当前使用 ✅', 'var(--green)');
      await pv2Reload();
    } catch (e) { pv2Hint('pv2-shared-hint', '失败：' + (e?.message || e), 'var(--red)'); }
  }
  async function pv2UseShared() {
    const pick = pv2SharedPickId();
    if (!pick) { pv2Hint('pv2-shared-hint', '先选一份共用段', 'var(--orange)'); return; }
    try {
      await pv2Api('POST', '/api/persona-shared/presets/' + encodeURIComponent(pick) + '/activate', {});
      pv2Hint('pv2-shared-hint', '已设为当前使用 ✅', 'var(--green)');
      await pv2Reload();
    } catch (e) { pv2Hint('pv2-shared-hint', '失败：' + (e?.message || e), 'var(--red)'); }
  }
  async function pv2DelShared() {
    const pick = pv2SharedPickId();
    if (!pick) return;
    const okDel = (typeof uiConfirm === 'function')
      ? await uiConfirm('删除这份共用段？用到它的卡会改用剩下的当前使用那份。')
      : true;
    if (!okDel) return;
    try {
      await pv2Api('DELETE', '/api/persona-shared/presets/' + encodeURIComponent(pick), {});
      if (typeof state !== 'undefined') state.pv2SharedPick = '';
      pv2Hint('pv2-shared-hint', '已删除 ✅', 'var(--green)');
      await pv2Reload();
    } catch (e) { pv2Hint('pv2-shared-hint', '失败：' + (e?.message || e), 'var(--red)'); }
  }

// ── 转发白名单三档（显示在「聊天设置」分区）────────────────────────
function renderForwardRulesSection(c) {
  const fr = c.forwardRules || {};
  const fold = (typeof setCard === 'function') ? setCard : (o) => '<div class="setcard">' + (o.body || '') + '</div>';
  const all = [
    ...(c.allow?.groups || []).map((x) => 'group:' + String(x).trim()),
    ...(c.allow?.private || []).map((x) => 'private:' + String(x).trim())
  ].filter(Boolean);
  const total = (fr.free || []).length + (fr.limited || []).length + (fr.adminOnly || []).length;
  const tier = (id, title, desc) => {
    const sel = new Set((fr[id] || []).map(String));
    const chips = all.map((k) => '<span class="fwd-chip' + (sel.has(k) ? ' on' : '') + '" data-fwd="' + id + '" data-key="' + esc(k) + '">' + esc(k) + '</span>').join('')
      || '<span class="muted" style="font-size:12px">（白名单为空，先去「聊天白名单」加群号/QQ）</span>';
    return '<div class="field"><label>' + title + ' <span style="font-weight:400;color:var(--tx3)">· ' + desc + '</span></label>' +
      '<div class="fwd-row">' + chips + '</div></div>';
  };
  return fold({
    id: 'card-forward-rules',
    icon: '📤',
    title: '转发白名单',
    sub: '跨会话转发（send_to）三档权限 · 已选 ' + total + ' 个目标',
    open: false,
    body:
      '<div class="hint" style="margin-bottom:10px">只能从「聊天白名单」里的会话中选，点一下选中/取消，立即生效。三档权限不同，越靠后越严：</div>' +
      tier('free', '① 可自由转发', '任何人让模型转发都可以') +
      tier('limited', '② 受限转发', '由模型自行判断要不要转；留空则没有这一档') +
      tier('adminOnly', '③ 仅管理员可要求', '只有本机管理员（' + esc(String(fr.adminQQ || '85946573')) + '）能让模型转') +
      '<div class="hint">不在任何一档里的会话一律不能转发。跨会话发送总开关在「工具与技能 → 发送到指定会话」。</div>'
  });
}

// ── 安全模式卡（聊天设置分区）───────────────────────────────────
function renderSafeModeSection(c) {
  const sm = c.safeMode || {};
  const enabled = sm.enabled !== false;
  const level = Number(sm.level) === 2 ? 2 : 1;
  const fold = (typeof setCard === 'function') ? setCard : (o) => '<div class="setcard">' + (o.body || '') + '</div>';
  return fold({
    id: 'card-safe-mode',
    icon: '🛡',
    title: '安全模式',
    sub: enabled ? ('已开启 · ' + (level === 2 ? '自定义规则' : '全部拦截')) : '已关闭',
    open: false,
    body:
      '<div class="checkbox-row"><input type="checkbox" id="safe-enabled" data-safe="enabled" ' + (enabled ? 'checked' : '') + ' />' +
      '<label for="safe-enabled">开启安全模式（默认开）</label></div>' +
      '<div class="hint">开启后，别人发来的消息在<b>写入本地存档之前</b>先脱敏 —— 存档里只剩占位符，模型、归档页、导出都看不到原文。</div>' +
      '<div class="field" style="margin-top:10px"><label>拦截档位</label>' +
        '<div style="display:flex;flex-direction:column;gap:6px;margin-top:6px">' +
          '<label><input type="radio" name="safe-level" data-safe="level" value="1" ' + (level === 1 ? 'checked' : '') + '/> 第一档：全部拦 —— 电话 / 身份证 / 银行卡 / 邮箱 / 验证码 / 密码 / 账号 / 地址，替换成 [电话号码] 这类占位符</label>' +
          '<label><input type="radio" name="safe-level" data-safe="level" value="2" ' + (level === 2 ? 'checked' : '') + '/> 第二档：我自己定 —— 只按下面的规则拦，替换词随便改</label>' +
        '</div></div>' +
      '<div class="field" id="safe-custom-wrap" style="' + (level === 2 ? '' : 'display:none') + '">' +
        '<label>自定义规则（一行一条：名称 | 正则 | 替换词）</label>' +
        '<textarea id="safe-custom" data-safe="customText" style="min-height:120px" placeholder="手机号 | 1[3-9]\\d{9} | [手机号]\n密码 | (密码|口令)\\s*[:：=]?\\s*\\S{4,} | [密码]">' + esc(String(sm.customText || '')) + '</textarea>' +
        '<div class="hint">第二栏是正则（不写替换词就默认 [名称]）。正则写错的那行会被忽略，不会影响其它规则。</div>' +
      '</div>' +
      '<div class="field"><label>试一下（输入一段文字看脱敏结果）</label>' +
        '<input type="text" id="safe-test-in" placeholder="例如：我手机号 13800138000，密码 abc12345" />' +
        '<div class="hint" id="safe-test-out" style="margin-top:6px"></div>' +
      '</div>'
  });
}
