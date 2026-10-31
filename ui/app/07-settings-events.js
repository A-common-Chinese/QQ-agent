// 〔设置事件绑定〕——M9 拆分第 8 段
'use strict';
// ── 设置页渲染守卫 ─────────────────────────────────────────────────────
// 自动保存期间（表单读取 + 保存请求在途），任何代码路径想整页重渲染设置表单
// 都会被拦下并记为"待重绘"（真正的拦截在 renderSettings 开头）。原因：
// 重渲染 = 用 state.config（上一次保存的旧值）重建整个表单 DOM ——
// 用户正在输入的未保存内容会被直接吹掉，看起来就是"设置存不上 / 改了又弹回去"。
// 拦下后等保存完成再补一次重绘，那时 state.config 已是最新值，不会丢内容。
const settingsGuard = { pending: 0, needRerender: false };

function beginSettingsGuard() { settingsGuard.pending++; }
function endSettingsGuard() {
  settingsGuard.pending = Math.max(0, settingsGuard.pending - 1);
  if (settingsGuard.pending === 0 && settingsGuard.needRerender) {
    settingsGuard.needRerender = false;
    renderSettings();
  }
}

// ── 离开设置页前的"挂起保存"清单 ───────────────────────────────────────
// bindSettingsEvents 每次重渲染都重建闭包，外部（switchTab）拿不到最新的
// flushSave —— 用模块级数组中转：渲染时登记、切页时逐个调用、
// 重渲染前清掉同表单的旧登记（表单 DOM 已换，旧 flush 引用的闭包失效）。
let settingsFlushHandlers = [];

/** 切走设置页前调用：把防抖窗口内还没落盘的改动立即保存。 */
function flushSettingsSaves() {
  for (const fn of settingsFlushHandlers) {
    try { fn(); } catch (e) { console.error('离开设置页前保存失败:', e); }
  }
}

function bindSettingsEvents(c) {
  /* ── 即时保存：任何设置项变动 → 防抖 600ms 自动保存 ──
     变动的设置块背景变成流动的浅黄色渐变（.dirty-glow）。
     黄条的消退时机：**切换设置区块或主页签时**（renderSettings 重渲染会重建
     DOM，旧块随 DOM 消失）——保存完成不再立即淡出，让"已改"的视觉确认
     一直留在屏上（旧版保存完 1 秒就渐隐，操作反馈太短促、有"没生效"的错觉）。 */
  let dirtyEls = new Set();
  let saveTimer = null;
  let saving = false;
  // 撤销快照：进入本设置区块时拍一份配置；有改动后显示「撤销」按钮，
  // 点击 = 整份配置回滚到快照（设置是即时生效的，回滚与改动之间发生的一切不负责）。
  const sectionSnapshot = structuredClone(state.config || {});
  let undoBtn = null;

  function markDirty(el) {
    const block = el?.closest?.('.field, .checkbox-row, .tier-param, .price-card, .tool-card, .settings-runstate, .prompt-preview-card, .persona-per-chat, .persona-chat-btn');
    if (block) dirtyEls.add(block);
    showUndoBtn();
    scheduleSave();
  }

  function showUndoBtn() {
    if (undoBtn || !$('#settings-form')) return;
    undoBtn = document.createElement('button');
    undoBtn.className = 'btn btn-small settings-undo-btn';
    undoBtn.textContent = '↩ 撤销本次设置';
    undoBtn.title = '把本区块的设置整体还原到你进入时的状态。\n注意：设置是即时生效的，改动到撤销之间机器人可能已按新设置运行过，这部分不回滚。';
    undoBtn.addEventListener('click', async () => {
      if (!(await uiConfirm('确定撤销本次设置？\n将把整个配置还原到你进入本设置区块之前的状态。\n（改动期间的运行行为不会被追回）'))) return;
      try {
        // 整份快照写回（后端 updateConfig 深合并；快照含全部字段，等价整体覆盖）。
        // ⚠️ 不带 keepalive：fetch keepalive 有 64KB body 上限，整份配置快照
        // （含 providers/价格表/技能设置）很容易超 —— 超限时 fetch 直接以
        // "Failed to fetch" 拒绝，这就是"撤销设置偶发报错"的根源（2026-09-19 修）。
        // keepalive 只该用于页面卸载兜底（小 patch），撤销是普通点击场景。
        const r = await api('/api/config', { method: 'POST', body: JSON.stringify(sectionSnapshot) });
        if (r && r.config) state.config = r.config;
        dirtyEls.clear();
        renderSettings();
      } catch (e) {
        alert(`撤销失败：${e.message}`);
      }
    });
    const form = $('#settings-form');
    if (form) form.prepend(undoBtn);
  }

  function scheduleSave(delay = 600) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; doSave(); }, delay);
  }

  async function doSave() {
    if (saving) { scheduleSave(); return; }
    saving = true;
    // 渲染守卫：从"开始收集表单"到"state.config 更新完成"期间不允许整页重渲染。
    // saveConfig 会先逐字段读 DOM、再 POST 并用响应覆盖 state.config ——
    // 中途任何重渲染（SSE 事件 / 轮询回调）都会吹掉用户正在输入的值。
    beginSettingsGuard();
    try {
      await saveConfig({ quiet: true });
      refreshStatus();
      startListPoller();
      // 刷新间隔可能刚被改过：重建状态轮询，让新间隔立刻生效
      startStatusPoller();
    } catch (e) {
      console.error('自动保存失败:', e);
    } finally {
      saving = false;
      endSettingsGuard();
      // 黄条保留：dirtyEls 不清 —— 用户切走设置区块/页签时 DOM 重建自然消失。
    }
  }

  // 立即保存（清掉防抖定时器，当场发起）。
  // 两个触发点：
  //   1. change 事件（复选框勾选/下拉框切换/日期时间选择）——这类操作语义上
  //      已经"完成"，没有继续输入的后续，等 600ms 毫无意义，还留出
  //      "改完立刻切页签 → 定时器随 DOM 一起销毁 → 改动丢失"的窗口。
  //   2. 切走设置页前（switchTab flush）—— 同上，是离开前的最后一刻。
  // 定时器回调里先清引用：doSave 里若正在保存会再次 scheduleSave()，
  // 旧引用不清掉会让"已取消的定时器"看起来还活着。
  function flushSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    doSave();
  }

  // 表单变动监听（设置页所有输入都会经过这里）。
  // input（打字/拖滑条）保持 600ms 防抖聚批；change（勾选/选择完成）立即保存 ——
  // change 之后再没有"同一字段的后续输入"，防抖只会增加丢失窗口。
  //
  // ⚠️ 防重复绑定：#settings-form 是静态元素（只换 innerHTML），renderSettings
  //    每次都会调 bindSettingsEvents。曾经每次都在 form 上 addEventListener +
  //    向 window 挂 beforeunload —— N 次重渲染后每敲一个字触发 N 次保存
  //    （N 个并发 POST），关页时 N 次 keepalive 请求可能撞配额。
  //    这里仿照 attachScrollLoader 的做法：监听器只挂一次，闭包引用存在
  //    元素属性上，重渲染时只更新引用。
  const form = $('#settings-form');
  if (form && !form.__settingsBound) {
    form.__settingsBound = {
      markDirty: (el) => markDirty(el),
      flushSave: () => flushSave()
    };
    form.addEventListener('input', (e) => form.__settingsBound.markDirty(e.target), { passive: true });
    form.addEventListener('change', (e) => form.__settingsBound.markDirty(e.target), { passive: true });
    // 自定义隐私规则：边打字边校验，合法条数 / 哪几行有问题直接显示在输入框下面。
    // 保存时不合法的行会被跳过（保留原规则），所以这里只是即时反馈，不拦保存。
    form.addEventListener('input', (e) => {
      if (e.target?.id !== 'cfg-dsh-privacy-patterns') return;
      if (typeof parsePrivacyPatterns !== 'function') return;
      const hint = form.querySelector('#cfg-dsh-privacy-patterns-hint');
      if (!hint) return;
      const parsed = parsePrivacyPatterns(e.target.value);
      if (parsed.errors.length) {
        hint.innerHTML = `<b style="color:#e5534b">✗ 这些行不会生效：</b><br>${parsed.errors.map((x) => esc(x)).join('<br>')}`;
      } else if (parsed.list.length) {
        hint.textContent = '✓ 识别到 ' + parsed.list.length + ' 条规则：'
          + parsed.list.map((r) => r.id + (r.action === 'block' ? '(拒发)' : '(打码)')).join('、');
      } else {
        hint.textContent = '留空 = 不使用自定义规则。';
      }
    }, { passive: true });
    // 页面关闭/刷新兜底：防抖窗口内直接关页面前，先把挂起的保存发出去。
    // fetch keepalive 让请求在页面卸载后仍能完成（sendBeacon 带不了
    // 自定义头，这里用同款 api() 的 POST + keepalive 更简单可靠）。
    // 只挂一次：N 个闭包各带一个定时器，关页时并发 POST 反而丢数据。
    window.addEventListener('beforeunload', () => {
      if (form.__settingsBound) form.__settingsBound.flushSave();
    });
  } else if (form) {
    // 已绑定过：只刷新引用，指向本次渲染的新闭包
    form.__settingsBound.markDirty = (el) => markDirty(el);
    form.__settingsBound.flushSave = () => flushSave();
  }

  // 暴露给页签切换等外部路径：离开设置页前把挂起的改动落盘。
  // ⚠️ 必须挂在模块级状态上（bindSettingsEvents 每次重渲染都重建闭包），
  //    switchTab 永远能找到"当前这一份"的 flush。
  //    #settings-form 是静态元素（从不被替换），旧登记的去重条件曾用
  //    attachedForm 比较 —— 永远不相等，每次重渲染 push 一个新闭包，
  //    数组无限增长。改成"清空只留当前一份"：重渲染后旧闭包的
  //    saveTimer/dirtyEls 引用已失效，留着只会有害。
  settingsFlushHandlers = [];
  const flush = () => flushSave();
  settingsFlushHandlers.push(flush);

  // ── Skill 开关 ──
  // 与工具开关的关键区别：Skill 开关**立即生效并落盘**，不走"未保存更改"流程。
  // 原因：Skill 的启停要跑生命周期回调（activate/deactivate），
  // 如果只是改本地 state 等用户点保存，就会出现"界面显示已开、后端还没开"的中间态；
  // 而且用户随手关掉一个 Skill 后忘了保存，会以为已经生效 —— 正是要消灭的割裂。
  $$('.skill-toggle').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const id = cb.dataset.skillId;
      cb.disabled = true;
      try {
        const r = await api(`/api/skills/${encodeURIComponent(id)}`, {
          method: 'POST',
          body: JSON.stringify({ enabled: cb.checked })
        });
        // 用后端返回的状态覆盖本地，保证展示与判定一致
        const idx = (state.skills || []).findIndex((s) => s.id === id);
        if (idx >= 0 && r.skill) state.skills[idx] = r.skill;
        if (r.config) state.config = r.config;
        await loadSkillsStatus();
        renderSettings();
      } catch (err) {
        cb.checked = !cb.checked;   // 失败回滚勾选状态
        alert(`切换技能失败：${err.message}`);
      } finally {
        cb.disabled = false;
      }
    });
  });

  // 单个工具开关
  $$('.tool-checkbox').forEach((cb) => {
    cb.addEventListener('change', () => {
      const toolId = cb.dataset.toolId;
      state.config.tools = state.config.tools || {};
      // send_to 的勾选 = 「跨会话发送」开关本身（收编进消息发送分类）
      if (cb.dataset.crossChat) {
        state.config.tools.crossChatSend = cb.checked;
      } else {
        state.config.tools.overrides = state.config.tools.overrides || {};
        state.config.tools.overrides[toolId] = cb.checked;
      }
      const card = cb.closest('.tool-card');
      if (card) {
        card.classList.toggle('enabled', cb.checked);
        card.classList.toggle('disabled', !cb.checked);
      }
      // 提示词预览面板已删除；开关状态直接走表单自动保存
      // 标脏走表单链（自动保存 'tools' 分支读 state.config.tools 整体提交）
      const form = $('#settings-form');
      if (form && form.__settingsBound) form.__settingsBound.markDirty(card || cb);
    });
  });

  // 分类开关
  $$('.category-checkbox').forEach((cb) => {
    cb.addEventListener('change', () => {
      const cat = cb.dataset.category;
      state.config.tools = state.config.tools || {};
      state.config.tools.categories = state.config.tools.categories || {};
      state.config.tools.categories[cat] = cb.checked;
      const form = $('#settings-form');
      if (form && form.__settingsBound) form.__settingsBound.markDirty(cb);
    });
  });

  // 全局开关
  const toolsEnabledCb = $('#cfg-tools-enabled');
  if (toolsEnabledCb) toolsEnabledCb.addEventListener('change', () => {
    state.config.tools = state.config.tools || {};
    state.config.tools.enabled = toolsEnabledCb.checked;
    const form = $('#settings-form');
    if (form && form.__settingsBound) form.__settingsBound.markDirty(toolsEnabledCb);
    if (typeof updateToolsOffBar === 'function') updateToolsOffBar(state.config);
  });

  // 全部启用/禁用/恢复默认
  // categories 必须整体替换（__replace__）：deepMerge 下传 {} 删不掉已有键，
  // 曾经"全部启用"传 {} 后已存在的 media:false 之类仍然留在配置里且 UI 无入口恢复。
  $('#tools-enable-all')?.addEventListener('click', () => {
    state.config.tools = state.config.tools || {};
    state.config.tools.enabled = true;
    state.config.tools.overrides = {};
    state.config.tools.categories = { __replace__: {} };
    if (typeof updateToolsOffBar === 'function') updateToolsOffBar(state.config);
    renderSettings();});
  // ⚠️「全部禁用」= 连 send_message 都收走 → 机器人会"收到但一句话发不出"（会话全是 noreply）。
  // 这个后果太隐蔽，加一次确认；误触率比"少点一次"高得多。
  $('#tools-disable-all')?.addEventListener('click', async () => {
    const ok = await uiConfirm('确定禁用全部工具？\n\n关闭后模型连「发消息」的工具都没有了：群里 @ 它也只会沉默（会话状态显示"不回复"），联网、记忆、表情同样不可用。\n\n确认要关闭？');
    if (!ok) return;
    state.config.tools = state.config.tools || {};
    state.config.tools.enabled = false;
    if (typeof updateToolsOffBar === 'function') updateToolsOffBar(state.config);
    renderSettings();});
  $('#tools-reset')?.addEventListener('click', () => {
    state.config.tools = { enabled: true, overrides: {}, categories: { __replace__: {} } };
    if (typeof updateToolsOffBar === 'function') updateToolsOffBar(state.config);
    renderSettings();});

  /** 实时更新提示词预览（旧版在前端拼静态模板，已改为后端同源组装） */
  function updatePromptPreview() {
    // 立即刷：后端按当前内存态组装（工具开关已同步写进 state.config.tools，
    // 但自动保存有 600ms 防抖、还没落盘）——所以先把当前工具态随请求发过去，
    // 后端合并补丁组装但不落盘，预览即刻反映刚点的开关。
    const overrides = { tools: state.config?.tools || {} };
    refreshPromptPreview(overrides);
  }

  // 分类展开/折叠
  $$('.tool-category-header').forEach((header) => {
    header.addEventListener('click', (e) => {
      // 点击勾选框不触发展开/折叠
      if (e.target.closest('.tool-category-toggle')) return;
      const cat = header.dataset.category;
      state.expandedToolCategories = state.expandedToolCategories || new Set(['messaging']);
      const collapsing = state.expandedToolCategories.has(cat);
      if (collapsing) {
        state.expandedToolCategories.delete(cat);
      } else {
        state.expandedToolCategories.add(cat);
      }
      // 开合过渡：折叠 = 工具列表先淡出、落定后重建（重建即消失）；
      // 展开 = 重建后给新出现的 .tool-list 一个入场动画。
      const list = header.parentElement?.querySelector('.tool-list');
      if (collapsing && list) {
        uiHide(list, () => renderSettings());
        return;
      }
      renderSettings();
      if (!collapsing) {
        const fresh = document.querySelector(`.tool-category[data-category="${cat}"] .tool-list`);
        uiEnter(fresh);
      }
    });
  });

  // 搜索提供方切换
  const searchProviderSel = $('#cfg-searchprovider');
  if (searchProviderSel) searchProviderSel.addEventListener('change', () => {
    const v = searchProviderSel.value;
    const fields = {
      bing: '#bing-search-fields',
      deepseek: '#deepseek-search-fields',
      zhipu: '#zhipu-search-fields',
      bocha: '#bocha-search-fields',
      baidu: '#baidu-search-fields',
      metaso: '#metaso-search-fields'
    };
    for (const [provider, sel] of Object.entries(fields)) {
      const el = $(sel);
      // 自定义项形如 'custom:<id>'，统一按 custom 前缀匹配
      if (el) {
        if (provider === v) uiShow(el, () => { el.style.display = ''; });
        else uiHide(el, () => { el.style.display = 'none'; });
      }
    }
    const manage = $('#custom-provider-manage');
    if (manage) {
      if (v.startsWith('custom:')) uiShow(manage, () => { manage.style.display = ''; });
      else uiHide(manage, () => { manage.style.display = 'none'; });
    }
    // 自定义服务 Key 框随选中项重置：不同服务各自的掩码/空状态在渲染时生成，
    // 但切换提供方是原地改 display 不重渲染 —— 这里手动对齐，避免上一家的
    // Key 残留显示给下一家（看起来像"共享 Key"，实际两家的 Key 互不相干）。
    const cpKey = $('#cfg-custom-sp-key');
    const cpToggle = $('#cfg-custom-sp-key-toggle');
    if (cpKey) {
      const cp = (state.config?.webSearch?.providers || []).find((p) => `custom:${p.id}` === v);
      cpKey.type = 'password';
      cpKey.value = cp?.hasApiKey ? '******' : '';
      cpKey.placeholder = '输入新 Key 可替换；留空保持不变';
      if (cpToggle) cpToggle.textContent = '显示';
    }
  });

  // ── 自定义搜索服务：添加 / 测试 / 删除 ──
  $('#add-search-provider-btn')?.addEventListener('click', async () => {
    const hint = $('#add-search-provider-hint');
    const baseUrl = ($('#new-sp-baseurl')?.value || '').trim();
    if (!baseUrl) { if (hint) hint.textContent = '请先填接口地址'; return; }
    if (hint) hint.textContent = '添加中…';
    try {
      const r = await api('/api/search-providers', {
        method: 'POST',
        body: JSON.stringify({
          name: ($('#new-sp-name')?.value || '').trim(),
          type: $('#new-sp-type')?.value || 'openai',
          baseUrl,
          apiKey: ($('#new-sp-apikey')?.value || '').trim(),
          model: ($('#new-sp-model')?.value || '').trim()
        })
      });
      // 添加后直接选中它（省一次手动切换）
      await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({ webSearch: { provider: `custom:${r.provider.id}` } })
      });
      if (hint) hint.textContent = '已添加并选中 ✓';
      for (const id of ['#new-sp-name', '#new-sp-baseurl', '#new-sp-apikey', '#new-sp-model']) {
        const el = $(id);
        if (el) el.value = '';
      }
      await loadSettings();
    } catch (e) {
      if (hint) hint.textContent = `添加失败：${e.message}`;
    }
  });

  $('#test-search-provider-btn')?.addEventListener('click', async () => {
    const hint = $('#search-provider-action-hint');
    const sel = $('#cfg-searchprovider');
    const v = sel?.value || '';
    if (!v.startsWith('custom:')) { if (hint) hint.textContent = '请先选择一个自定义搜索服务'; return; }
    if (hint) hint.textContent = '测试中…';
    try {
      const r = await api('/api/search-providers/test', {
        method: 'POST',
        body: JSON.stringify({ providerId: v })
      });
      const res = r.result || {};
      if (hint) {
        hint.textContent = res.ok
          ? `✓ 可用（${res.count} 条结果，${res.latencyMs}ms）${res.sample ? `：${res.sample.slice(0, 30)}` : ''}`
          : `✗ ${res.note || '不可用'}`;
      }
    } catch (e) {
      if (hint) hint.textContent = `测试失败：${e.message}`;
    }
  });

  $('#del-search-provider-btn')?.addEventListener('click', async () => {
    const sel = $('#cfg-searchprovider');
    const v = sel?.value || '';
    if (!v.startsWith('custom:')) return;
    const id = v.slice('custom:'.length);
    const opt = sel.querySelector(`option[value="${v}"]`);
    const name = opt ? opt.textContent : id;
    if (!(await uiConfirm(`确定删除搜索服务「${name}」？`))) return;
    try {
      await api('/api/search-providers', { method: 'DELETE', body: JSON.stringify({ id }) });
      await loadSettings();
    } catch (e) {
      alert(`删除失败：${e.message}`);
    }
  });

  // ── 聊天设置收纳模态框入口（2026-09-18 改版）──
  // 信息发送配置已内联到「运行节奏」折叠卡（sc-* 字段走表单自动保存），
  // openSendConfigModal 第二编辑器与 #open-send-config-btn 入口已删除
  //（该按钮从未渲染，模态框不可达 = 一整套死写点）。
  // 活跃设置编辑器已内联进聊天设置的「活跃设置」折叠卡（#ac-editor），
  // 每次重渲染后原地挂载；旧挂载的滑条监听由其 MutationObserver 随节点摘除自动销毁。
  const acRoot = $('#ac-editor');
  if (acRoot) mountActiveConfigEditor(acRoot);

  // ── 屏蔽名单 ──
  $('#blocklist-btn')?.addEventListener('click', () => openBlocklistModal());

  // 主题选择器已移除：桌面端「界面」里那份主题是重复入口，
  // 统一由 设置 → 外观 → UI 自定义 管（15-ui-skin.js）。这里不再绑定。

  // ── 成本核算：价格卡片随模型/开关变化 ──
  const useOfficialBox = $('#cfg-useofficialprice');
  if (useOfficialBox) useOfficialBox.addEventListener('change', () => {
    // 开关一变，当前模型的可用单价来源就变了，重刷卡片
    refreshModelPriceCard();
  });
  // 直接在模型输入框里改模型时也要刷新 —— 只有从目录里选才会走另一条路径。
  // 用 input 而非 change：边打字边更新，避免"点了别处才变"的迟滞感。
  const modelInput = $('#cfg-model');
  if (modelInput) modelInput.addEventListener('input', () => refreshModelPriceCard());
  refreshModelPriceCard();

  // 批量自定义价格编辑
  $('#batch-price-btn')?.addEventListener('click', () => openBatchPriceModal());

  // ── 远程价格表：状态展示 + 立即拉取 ──
  renderPriceFeedStatus();
  $('#price-feed-refresh-btn')?.addEventListener('click', async () => {
    const statusEl = $('#price-feed-status');
    if (statusEl) statusEl.textContent = '正在拉取官网价格表…';
    try {
      const r = await api('/api/model-prices/refresh', { method: 'POST', body: '{}' });
      state.modelPrices = { prices: r.prices, current: r.current, remote: r.remote };
      renderPriceFeedStatus();
      refreshModelPriceCard();   // 价格可能变了，当前模型卡片跟着刷
    } catch (e) {
      if (statusEl) statusEl.textContent = `拉取失败：${e.message}`;
    }
  });

  // ── 记忆整理区块事件 ──
  const memUseChat = $('#cfg-mem-usechat');
  if (memUseChat) memUseChat.addEventListener('change', () => {
    const box = $('#mem-model-box');
    if (box) {
      if (memUseChat.checked) uiHide(box, () => { box.style.display = 'none'; });
      else uiShow(box, () => { box.style.display = ''; });
    }
  });
  const memModelPick = $('#cfg-mem-model-pick');
  if (memModelPick) memModelPick.addEventListener('click', () => openMemoryModelPicker());

  // ── 模型 API 区块事件 ──
  // 密码框显示/隐藏切换（点击按钮切换对应输入框的 type）
  // 已保存 Key 的输入框初始值统一为掩码 "******"；
  // 点「显示」→ 替换成真实 Key 明文；点「隐藏」→ 重新变回掩码 "******"。
  const pwdToggles = [
    ['cfg-apikey-toggle', 'cfg-apikey'],
    ['cfg-ds-searchkey-toggle', 'cfg-ds-searchkey'],
    ['cfg-zhipu-key-toggle', 'cfg-zhipu-key'],
    ['cfg-bocha-key-toggle', 'cfg-bocha-key'],
    ['cfg-baidu-key-toggle', 'cfg-baidu-key'],
    ['cfg-metaso-key-toggle', 'cfg-metaso-key'],
    ['cfg-custom-sp-key-toggle', 'cfg-custom-sp-key'],
    ['cfg-obtoken-toggle', 'cfg-obtoken'],
    ['cfg-obhttptoken-toggle', 'cfg-obhttptoken']
  ];
  for (const [btnId, inputId] of pwdToggles) {
    const btn = $(`#${btnId}`);
    const input = $(`#${inputId}`);
    if (btn && input) {
      btn.addEventListener('click', async () => {
        const show = input.type === 'password';
        // 所有 Key 统一走 fetchRealKey：/api/config 里的密钥都是脱敏的，
        // 明文只能向后端专用端点取（服务端会校验请求来源）。
        const real = await fetchRealKey(inputId);
        if (show) {
          // 切到明文：显示真实 Key（若之前是掩码/空占位）
          input.type = 'text';
          input.value = real;
          btn.textContent = '隐藏';
        } else {
          // 切回密码态：如果框里是真实 Key（用户没改过），用掩码盖住。
          // ⚠️ 空输入不再被强制回填掩码：曾经 current === '' 也变成 '******'，
          //    用户"清空输入框想清除 Key"的意图被吞掉 —— 保存时空串
          //    会被后端按"不修改"处理，导致已存 Key 永远无法清除。
          //    现在空 = 保持空（保存即清除）；掩码只盖"真实 Key 原样"这一种。
          const current = input.value || '';
          input.type = 'password';
          if (real && current === real) {
            input.value = '******';
          } else if (current === '******') {
            input.value = '******';
          } else {
            // 空串（清空意图）或新输入的 Key：保持原值
          }
          btn.textContent = '显示';
        }
      });
    }
  }

  // 输入框 id -> 搜索服务字段名（/api/config 里的搜索 Key 是脱敏的，
  // 所以“显示”必须向后端专用端点要明文，不能直接读 state.config）
  // 自定义服务是动态的：field 值在切换提供方时才定（custom:<id>），
  // 所以这里是个函数而不是常量表。
  const SEARCH_KEY_FIELDS = {
    'cfg-ds-searchkey': () => 'deepseek',
    'cfg-zhipu-key': () => 'zhipu',
    'cfg-bocha-key': () => 'bocha',
    'cfg-baidu-key': () => 'baidu',
    'cfg-metaso-key': () => 'metaso',
    'cfg-custom-sp-key': () => ($('#cfg-searchprovider')?.value || '').startsWith('custom:')
      ? $('#cfg-searchprovider').value
      : null
  };

  // 搜索服务 Key 的「清除密钥」按钮（与模型 API 页同款语义：
  // 留空保存 = 保持不变，真清除必须点按钮）
  const SEARCH_KEY_CLEAR_BTN = {
    'cfg-ds-searchkey-clear': 'cfg-ds-searchkey',
    'cfg-zhipu-key-clear': 'cfg-zhipu-key',
    'cfg-bocha-key-clear': 'cfg-bocha-key',
    'cfg-baidu-key-clear': 'cfg-baidu-key',
    'cfg-metaso-key-clear': 'cfg-metaso-key',
    'cfg-custom-sp-key-clear': 'cfg-custom-sp-key'
  };
  for (const [btnId, inputId] of Object.entries(SEARCH_KEY_CLEAR_BTN)) {
    const btn = $(`#${btnId}`);
    if (!btn) continue;
    btn.addEventListener('click', async () => {
      const isCustom = inputId === 'cfg-custom-sp-key';
      const field = SEARCH_KEY_FIELDS[inputId]?.();
      if (!field) return;
      const input = $(`#${inputId}`);
      if (!(await uiConfirm('确定清除该搜索服务已保存的 API Key？'))) return;
      try {
        if (isCustom) {
          // 自定义服务的 Key 存在 providers 数组条目里，不能走 webSearch.<field> 路径；
          // 重用 POST /api/search-providers 的"已存在则更新"分支：同一 baseUrl+type
          // 命中 existing，传空 apiKey 清除（后端只在 submitted 非空时覆盖 —— 空 = 清除
          // 需要 existing.apiKey = ''，见下方显式置空）
          const cp = (state.config?.webSearch?.providers || []).find((p) => `custom:${p.id}` === field);
          if (!cp) throw new Error('找不到这个自定义搜索服务');
          await api('/api/search-providers', {
            method: 'POST',
            body: JSON.stringify({
              name: cp.name, type: cp.type, baseUrl: cp.baseUrl,
              model: cp.model, apiKey: '', count: cp.count, timeoutMs: cp.timeoutMs
            })
          });
        } else {
          // 内置五家：空串走正常保存链就能清除（sanitize 删掉了掩码、空串覆盖旧值）
          await api('/api/config', { method: 'POST', body: JSON.stringify({ webSearch: { [field]: { apiKey: '' } } }) });
        }
        if (input) { input.value = ''; input.placeholder = '输入新 Key 可替换'; }
        const hint = $('#search-provider-action-hint');
        if (hint) hint.textContent = 'API Key 已清除';
        await loadSettings();
      } catch (e) {
        alert(`清除失败：${e.message}`);
      }
    });
  }

  // 前端点“显示”时向后端要真实 Key。
  // 说明：三个端点都只放行本机控制台请求（服务端校验来源），本地单机使用不受影响。
  async function fetchRealKey(inputId) {
    if (inputId === 'cfg-apikey') {
      const pid = state.config?.api?.provider;
      if (pid) {
        const r = await api(`/api/providers/key?providerId=${encodeURIComponent(pid)}`);
        return String(r.apiKey || '');
      }
      const r = await api('/api/api-key');
      return String(r.apiKey || '');
    }
    const field = SEARCH_KEY_FIELDS[inputId]?.();
    if (field) {
      const r = await api(`/api/search-key?field=${encodeURIComponent(field)}`);
      // 环境变量提供的 Key：配置里没存（apiKey 空）但 env 有 —— 显示时
      // 直接把 env 值亮出来（web-search.js 的运行时优先级就是 cfg > env，
      // 用户"看一眼"的语义应该覆盖两种来源）。
      return String(r.apiKey || '');
    }
    // OneBot 令牌：与搜索 Key 同样的"显示明文"专用端点
    if (inputId === 'cfg-obtoken' || inputId === 'cfg-obhttptoken') {
      const which = inputId === 'cfg-obtoken' ? 'ws' : 'http';
      const r = await api(`/api/onebot-token?which=${encodeURIComponent(which)}`);
      return String(r.token || '');
    }
    return '';
  }
  // 备选模型行：模型 ID + 可选提供商（留空 = 沿用主模型的提供商）
  let fallbackRows = (Array.isArray(c.api?.fallbackModels) ? c.api.fallbackModels : []).map((f) => ({ model: f.model || '', provider: f.provider || '' }));
  if (fallbackRows.length === 0) fallbackRows = [{ model: '', provider: '' }];
  // 备选模型点选：readonly 输入框 → 弹模型目录选择器，选完写回行数据并触发表单保存。
  // 与手输并行不存在了（readonly），杜绝"打错模型 id 等运行时才报错"。
  function openFallbackModelPicker(rowIdx) {
    const providers = state.providers || [];
    if (!providers.length) { alert('模型目录为空：请先在本页上方添加提供商。'); return; }
    const currentModel = fallbackRows[rowIdx]?.model || '';
    const overlay = modelModalShell({
      head: `选择备选模型（第 ${rowIdx + 1} 行）`,
      body: `
        <div class="model-modal-left" id="mm-left"></div>
        <div class="model-modal-right" id="mm-right"></div>`,
      foot: `<button class="btn" id="mm-cancel">取消</button>`
    });
    const left = overlay.querySelector('#mm-left');
    const right = overlay.querySelector('#mm-right');
    let activePid = providers[0].id;
    function renderLeft() {
      left.innerHTML = providers.map((p) =>
        `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.displayName || p.id)}</div>`).join('');
      left.querySelectorAll('.mm-prov').forEach((el) => {
        el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
      });
    }
    function renderRight() {
      const p = providers.find((x) => x.id === activePid);
      if (!p) { right.innerHTML = ''; return; }
      const names = p.modelNames || {};
      right.innerHTML = p.models.map((m) => `
        <div class="mm-model" data-model="${esc(m)}">
          <span class="mm-check">${m === currentModel ? '✓' : ''}</span>
          <span>${esc(names[m] || m)}</span>
          <span class="muted" style="font-size:11px">${esc(m)}</span>
        </div>`).join('') || '<div class="muted" style="padding:10px">该提供商下没有模型</div>';
      right.querySelectorAll('.mm-model').forEach((el) => {
        el.addEventListener('click', () => {
          fallbackRows[rowIdx].model = el.dataset.model;
          // 提供商下拉同步指向所选提供商（备选可跨提供商，这里帮用户带上）
          fallbackRows[rowIdx].provider = activePid;
          closeModelModal(overlay);
          renderFallbackRows();
          // 通知自动保存：fallbackModels 从 DOM 实时读，触发表单监听即可
          $('#fallback-model-rows')?.dispatchEvent(new Event('input', { bubbles: true }));
        });
      });
    }
    renderLeft();
    renderRight();
    overlay.querySelector('#mm-cancel').addEventListener('click', () => closeModelModal(overlay));
  }
  function renderFallbackRows() {
    const box = $('#fallback-model-rows');
    if (!box) return;
    // 提供商列已删（2026-09-18 用户需求）：选模型时自动带上所属提供商（跨渠道
    // 备选仍有效），手动再选一遍纯属多余。行内只留 模型点选 + 删除。
    const provNameOf = (pid) => {
      const p = (state.providers || []).find((x) => x.id === pid);
      return p ? (p.displayName || p.id) : '';
    };
    box.innerHTML = `
      <table class="model-rows-table">
        <tr><th style="width:88%">备选模型（点击选择；提供商随模型自动确定）</th><th></th></tr>
        ${fallbackRows.map((row, i) => `
          <tr>
            <td><input type="text" class="fb-model-pick" data-i="${i}" readonly placeholder="点击选择模型" data-model="${esc(row.model || '')}" data-provider="${esc(row.provider || '')}" value="${esc(row.model ? (provNameOf(row.provider) ? `${provNameOf(row.provider)} · ${row.model}` : row.model) : '')}" style="cursor:pointer" /></td>
            <td style="width:56px;text-align:right"><button class="btn btn-small btn-danger fb-del" data-i="${i}" ${fallbackRows.length <= 1 ? 'disabled' : ''}>删除</button></td>
          </tr>`).join('')}
      </table>`;
    box.querySelectorAll('.fb-model-pick').forEach((el) => {
      el.addEventListener('click', () => { openFallbackModelPicker(Number(el.dataset.i)); });
    });
    box.querySelectorAll('.fb-del').forEach((el) => {
      el.addEventListener('click', () => {
        if (fallbackRows.length <= 1) return;
        fallbackRows.splice(Number(el.dataset.i), 1);
        renderFallbackRows();
      });
    });
  }
  renderFallbackRows();
  const addFallbackRowBtn = $('#add-fallback-row-btn');
  if (addFallbackRowBtn) addFallbackRowBtn.addEventListener('click', () => {
    fallbackRows.push({ model: '', provider: '' });
    renderFallbackRows();
  });

  // ── 「模型配置」「模型管理」两个入口模态框（2026-09-18 改版）──
  // 原页面上的 模型目录/baseURL/Key/专用模型/图片视频开关/视频理解方式
  // 全部收进「模型配置」（mc-* 字段，弹窗内部自带绑定）；删除模型/手动添加
  // 提供商收进「模型管理」。Key 的显示/清除都已搬进「模型配置」弹窗
  // （mc-apikey-toggle / mc-apikey-clear，弹窗内自带绑定），旧绑定全部删除。
  $('#open-model-config-btn')?.addEventListener('click', () => openModelConfigModal());
  $('#open-model-manage-btn')?.addEventListener('click', () => openModelManageModal());
  // 拿当前 API Key 的真实值：如果输入框里是用户刚输入的新 Key（非掩码非空），优先用；否则向后端取
  // 2026-09-19（M9 清理）：唯一调用点已随「模型配置」弹窗改版删除（弹窗内自带取 Key
  // 逻辑），此函数成为死代码且引用不存在的 #cfg-apikey —— 一并删除。

  // 连通性测试：抽成公共逻辑，两个入口共用
  // （健康卡片的 test-api-btn 与「模型配置」弹窗里的测试按钮做的是同一件事）
  async function runConnectivityTest(btn, out, idleLabel) {
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = '测试中…';
    if (out) out.textContent = '';
    try {
      // 2026-09-18 模型配置改版后，设置页上只剩隐藏字段（cfg-baseurl-value），
      // 旧的 #cfg-baseurl / #cfg-apikey 输入框已搬进弹窗（mc-*）。这里按
      // 「界面实时值优先、隐藏字段兜底、最后用已保存配置」的顺序取值 ——
      // 否则健康卡片上的「测试一下」永远拿空 baseUrl，必报"请先填写 Base URL"。
      const baseUrl = ($('#mc-baseurl')?.value || $('#cfg-baseurl-value')?.value || state.config?.api?.baseUrl || '').trim();
      const model = ($('#mc-model-pick')?.dataset?.model || $('#cfg-model')?.value || state.config?.api?.model || '').trim();
      // 只把"用户新输入的明文 Key"传给服务端；若是掩码/空则不传，
      // 让服务端用自己保存的 Key —— 不依赖明文读取端点，未设 token 时也能测试。
      const raw = ($('#mc-apikey')?.value || '').trim();
      const apiKey = (raw && raw !== '******') ? raw : '';
      const r = await api('/api/providers/test-chat', {
        method: 'POST',
        body: JSON.stringify({ baseUrl, apiKey, model })
      });
      const res = r.result || {};
      // 思考方言由服务端 model.thinking-detect 能力给出，让用户提前知道这个模型
      // 会走哪套思考参数（避免"开了思考但实际没生效"的黑箱感）。
      const dialect = res.thinking?.label ? ` · 思考参数：${res.thinking.label}` : '';
      if (out) out.textContent = res.ok
        ? `✓ 测试通过（${res.latencyMs}ms）：${res.note || '请求成功'}${dialect}`
        : `✗ 测试失败：${res.note || '未知错误'}`;
    } catch (e) {
      if (out) out.textContent = `测试失败：${e.message}`;
    }
    btn.disabled = false;
    btn.textContent = idleLabel;
  }

  // 健康卡片上的「测试一下」：此前 renderHealthCard 渲染后从未绑定事件
  // （旧代码绑的是不存在的 test-provider-btn），按钮点了完全没反应。
  const testApiBtn = $('#test-api-btn');
  if (testApiBtn) testApiBtn.addEventListener('click', () => runConnectivityTest(testApiBtn, $('#test-api-result'), '测试一下'));

  // 健康卡片上的「去设置」按钮：点击跳转到对应设置区块并高亮
  $$('.hc-fix-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target;
      if (target === 'snowluma') {
        switchTab('snowluma');
        // 高亮一键启动按钮
        setTimeout(() => {
          const quickBtn = $('#quick-start-btn');
          if (quickBtn) {
            quickBtn.style.boxShadow = '0 0 0 3px var(--accent)';
            setTimeout(() => { quickBtn.style.boxShadow = ''; }, 2000);
          }
        }, 300);
      } else if (target === 'settings-api') {
        // 切换到 API 设置区块
        state.settingsSection = 'api';
        renderSettingsSidebar();
        renderSettings();
        // 高亮模型配置入口按钮（2026-09-18 改版后 Base URL 不再是页面输入框，
        // 引导用户进「模型配置」弹窗；旧 #cfg-baseurl 已不存在）
        setTimeout(() => {
          const input = $('#open-model-config-btn');
          if (input) {
            input.focus();
            input.style.boxShadow = '0 0 0 3px var(--accent)';
            setTimeout(() => { input.style.boxShadow = ''; }, 2000);
          }
        }, 100);
      } else if (target === 'settings-allow') {
        // 切换到白名单设置区块
        state.settingsSection = 'allow';
        renderSettingsSidebar();
        renderSettings();
        // 高亮白名单区域
        setTimeout(() => {
          const section = $('#settings-form');
          if (section) {
            section.style.boxShadow = '0 0 0 3px var(--accent)';
            setTimeout(() => { section.style.boxShadow = ''; }, 2000);
          }
        }, 100);
      }
    });
  });




  // 图片输入能力提示（视觉扫描结果）：图片输入开关本体已移入「模型配置」模态框，
  // 这里只更新区块头部的 #model-vision-hint。
  function syncVisionSwitch(pid, model) {
    const vhint = $('#model-vision-hint');
    if (!vhint) return;
    const r = (state.visionResults || {})[`${pid || ''}|||${model || ''}`];
    if (r && (r.verdict === 'vision' || r.verdict === 'no-vision')) {
      vhint.textContent = r.verdict === 'vision' ? '✅ 当前模型支持图片输入' : '🚫 当前模型不支持图片输入';
    } else {
      vhint.textContent = '';
    }
  }
  syncVisionSwitch(c.api.provider, c.api.model);

  // 「扫描视觉能力」按钮已按需求删除（2026-09-17）。
  // 视觉能力数据仍由内置视觉表 + 模型目录徽标提供；后端 /api/vision/scan
  // 端点保留（无 UI 入口），SSE vision-scan 事件监听保留兜底。

  // 模型目录“支持图片输入/不支持图片输入”徽标开关
  function applyShowVision() {
    const show = state.config?.ui?.showVision !== false;
    // 只在开关真正翻转时播动画：本函数每次重渲染都会跑一遍，
    // 而 .vbadge 是重建出来的全新节点，逐次播动画会闪成一片。
    // 上次状态存在 state 上（本函数每次渲染都重新绑定，闭包变量留不住）。
    const animate = state.__showVisionLast != null && state.__showVisionLast !== show;
    state.__showVisionLast = show;
    $$('.vbadge').forEach((el) => {
      if (show) uiShow(el, () => { el.style.display = ''; }, animate);
      else uiHide(el, () => { el.style.display = 'none'; }, animate);
    });
  }
  applyShowVision();

  // ── 人设区块事件 ──
  const personaPick = $('#cfg-persona-pick');
  function currentPersonaId() {
    const roleText = $('#cfg-roletext')?.value ?? '';
    const found = Object.entries(state.personaTemplates || {}).find(([, p]) => p.text === roleText);
    return found ? found[0] : '';
  }
  function syncPersonaButtons(animate = true) {
    const id = currentPersonaId();
    const tpl = state.personaTemplates[id];
    const isCustom = id.startsWith('custom_');
    const delBtn = $('#del-persona-btn');
    if (delBtn) {
      if (isCustom) uiShow(delBtn, () => delBtn.classList.remove('hidden'), animate);
      else uiHide(delBtn, () => delBtn.classList.add('hidden'), animate);
    }
    const hint = $('#persona-pick-hint');
    if (hint) hint.textContent = tpl ? (tpl.builtin ? '内置人设' : '自定义人设') : '';
  }
  if (personaPick) {
    personaPick.addEventListener('click', () => openPersonaPicker());
  }
  const newPersonaBtn = $('#new-persona-btn');
  if (newPersonaBtn) newPersonaBtn.addEventListener('click', () => openPersonaCreateModal());
  const delPersonaBtn = $('#del-persona-btn');
  if (delPersonaBtn) delPersonaBtn.addEventListener('click', async () => {
    const id = currentPersonaId();
    if (!id.startsWith('custom_')) return;
    const tpl = state.personaTemplates[id];
    if (!tpl) return;
    if (!(await uiConfirm(`确定删除自定义人设「${tpl.name}」？`))) return;
    try {
      await api(`/api/persona-templates/${id}`, { method: 'DELETE', body: '{}' });
      $('#cfg-roletext').value = state.personaTemplates.xiaojingyu?.text || '';
      $('#cfg-customrules').value = '';
      // 删除 = 表单值被程序化改回默认人设：同样派发 input 触发自动保存，
      // 否则"删完切走"后配置里还是被删掉的那套角色设定（保存从未发起）。
      $('#cfg-roletext')?.dispatchEvent(new Event('input', { bubbles: true }));
      await loadSettings();
    } catch (e) {
      $('#persona-pick-hint').textContent = `删除失败：${e.message}`;
    }
  });
  
  syncPersonaButtons(false);   // 初始装填不播动画（重渲染后是全新节点）

  // ── 白名单区块事件 ──
  const pickGroupsBtn = $('#pick-groups-btn');
  if (pickGroupsBtn) pickGroupsBtn.addEventListener('click', () => openWhitelistPicker('groups'));
  const pickFriendsBtn = $('#pick-friends-btn');
  if (pickFriendsBtn) pickFriendsBtn.addEventListener('click', () => openWhitelistPicker('friends'));

  // ── 按会话独立人设 ──
  // 唯一真相是隐藏 input 里的 JSON（与分群档位滑条同一套做法）：
  // ── 人设页：统一/分会话切换 + 分会话按钮网格 ──
  // 统一开关：切显隐（不触发保存——display 切换不是配置变化，真正的值在 checkbox 上）。
  const personaUnifiedChk = $('#cfg-persona-unified');
  if (personaUnifiedChk) personaUnifiedChk.addEventListener('change', () => {
    const ub = $('#persona-unified-box');
    const pb = $('#persona-perchat-box');
    if (ub) {
      if (personaUnifiedChk.checked) uiShow(ub, () => { ub.style.display = ''; });
      else uiHide(ub, () => { ub.style.display = 'none'; });
    }
    if (pb) {
      if (personaUnifiedChk.checked) uiHide(pb, () => { pb.style.display = 'none'; });
      else uiShow(pb, () => { pb.style.display = ''; });
    }
  });
  // 分会话按钮：点开独立人设模态框（写回隐藏 JSON → 自动保存）
  // root 判空：DOM 测试环境里 #persona-perchat-box 可能不在场（统一模式渲染时它存在，
  // 但旧测试快照可能没这个节点——$$ 对 null root 直接抛错）
  const perChatBox = $('#persona-perchat-box');
  if (perChatBox) $$('.persona-chat-btn', perChatBox).forEach((btn) => {
    btn.addEventListener('click', () => openPerChatPersonaModal(btn.dataset.chat));
  });
  // 分群模式的「全局人设设置」入口：编辑未单独配置会话所跟随的全局字段
  $('#open-global-persona-btn')?.addEventListener('click', () => openGlobalPersonaModal());
  // 群名异步补显：按钮文字先显示"群 号"，拉到群名后替换
  api('/api/onebot/groups').then((d) => {
    const names = new Map((d.groups || []).map((g) => [String(g.id), g.name]));
    if (perChatBox) $$('.persona-chat-btn', perChatBox).forEach((btn) => {
      const m = /^group:(\d+)$/.exec(String(btn.dataset.chat || ''));
      if (!m) return;
      const n = names.get(m[1]);
      if (!n) return;
      const hasDot = btn.textContent.includes('●');
      btn.textContent = hasDot ? `${n} ●` : n;
    });
  }).catch(() => {});

  // ── 检查更新（桌面端区块） ──
  const curVerEl = $('#update-current');
  if (curVerEl) {
    api('/api/version').then((d) => { curVerEl.textContent = `v${d.version || '?'}`; })
      .catch(() => { curVerEl.textContent = ''; });
  }
  // ── 自动更新（阶段 1：检查 + 下载，不自动安装）──
  function showUpdateDetail(data) {
    const box = $('#update-detail');
    if (!box) return;
    box.style.display = '';
    const latest = $('#update-latest'); if (latest) latest.textContent = 'v' + data.latest;
    const size = $('#update-size');
    if (size) size.textContent = data.asset?.size ? '(' + (data.asset.size / 1048576).toFixed(1) + ' MB)' : '';
    const notes = $('#update-notes'); if (notes) notes.textContent = data.notes || '（这个 Release 没有写说明）';
    const hint = $('#update-hint'); if (hint) hint.textContent = '发现新版本 v' + data.latest + '（当前 v' + data.current + '）';
  }
  async function pollUpdateDownload() {
    const hint = $('#update-progress');
    const btn = $('#download-update-btn');
    for (let i = 0; i < 3600; i += 1) {
      const st = await api('/api/update/status').catch(() => null);
      if (!st) break;
      if (st.state === 'downloading') {
        const got = (st.received / 1048576).toFixed(1);
        const all = st.total ? (st.total / 1048576).toFixed(1) + ' MB' : '?';
        if (hint) hint.textContent = '下载中 ' + (st.percent || 0) + '%（' + got + ' / ' + all + '）';
      } else if (st.state === 'done') {
        if (hint) hint.innerHTML = '下载完成 ✓ <code>' + esc(st.path || '') + '</code><br>sha256: <code>' + esc(st.sha256 || '') + '</code>';
        const instBtnShow = $('#install-update-btn');
        if (instBtnShow) instBtnShow.style.display = '';
        if (btn) btn.disabled = false;
        return;
      } else if (st.state === 'error') {
        if (hint) hint.textContent = '下载失败：' + (st.error || '未知错误');
        if (btn) btn.disabled = false;
        return;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  const checkUpdateBtn = $('#check-update-btn');
  if (checkUpdateBtn) checkUpdateBtn.addEventListener('click', async () => {
    const hint = $('#update-hint');
    checkUpdateBtn.disabled = true;
    if (hint) hint.textContent = '检查中…';
    const data = await runUpdateCheck({ manual: true });
    if (!data) {
      if (hint) hint.textContent = '检查失败：网络不可达';
    } else if (!data.ok) {
      if (hint) hint.textContent = '检查失败：' + (data.error || '未知错误');
    } else if (data.hasUpdate && isNewerVersion(data.latest, data.current)) {
      state.updateInfo = data;
  showUpdateDetail(data);
    } else if (hint) hint.textContent = '已是最新（v' + data.current + '）';
    checkUpdateBtn.disabled = false;
  });
  const dlUpdateBtn = $('#download-update-btn');
  if (dlUpdateBtn) dlUpdateBtn.addEventListener('click', async () => {
    const hint = $('#update-progress');
    dlUpdateBtn.disabled = true;
    if (hint) hint.textContent = '开始下载…';
    const r = await api('/api/update/download', { method: 'POST' });
    if (!r || r.ok === false) {
      if (hint) hint.textContent = '下载失败：' + (r?.error || '未知错误');
      dlUpdateBtn.disabled = false;
      return;
    }
    await pollUpdateDownload();
  });
  // ── 安装更新：自动备份 → 空间不足先问 → 强制安装二次确认 ──
  const instUpdateBtn = $('#install-update-btn');
  if (instUpdateBtn) instUpdateBtn.addEventListener('click', async () => {
    const hint = $('#update-progress');
    const mb = (n) => Math.round((Number(n) || 0) / 1048576) + ' MB';
    instUpdateBtn.disabled = true;
    if (hint) hint.textContent = '正在备份 plugins / skills / snowluma 与 data/ 到临时目录（数据多时十几秒）…';
    const r = await api('/api/update/install', { method: 'POST', body: JSON.stringify({ force: false }) })
      .catch((e) => ({ ok: false, error: e?.message || String(e) }));
    if (r && r.ok) {
      const log = r.logPath ? '<br>安装日志 <code>' + esc(r.logPath) + '</code>' : '';
      const warn = r.runExe ? '' : '<br>⚠ 没定位到可执行文件，装完可能不会自动启动（看日志最后两行）';
      if (hint) hint.innerHTML = '已备份到 <code>' + esc(r.backupDir || '') + '</code>' + log + '<br>应用即将退出并安装到 <code>' + esc(r.installDir || '') + '</code>，装完自动还原并重启 ✅' + warn;
      return;
    }
    if (r && r.needSpace) {
      const go = await uiConfirm('临时目录空间不足！\n需要约 ' + mb(r.needBytes) + '，当前可用 ' + mb(r.freeBytes) + '。\n\n【确定】= 强制安装（会再确认一次）\n【取消】= 取消安装并清理临时文件');
      if (!go) {
        const cb = await api('/api/update/clean-temp', { method: 'POST' }).catch(() => null);
        if (hint) hint.textContent = '已取消安装' + (cb?.removed ? '，清理了 ' + cb.removed + ' 个临时备份目录' : '，没有可清理的临时备份');
        instUpdateBtn.disabled = false;
        return;
      }
      const sure = await uiConfirm('⚠️ 强制安装：磁盘空间不足时继续，可能导致安装失败或系统变慢。\n\n确定要继续吗？');
      if (!sure) { instUpdateBtn.disabled = false; if (hint) hint.textContent = '已取消（未做任何改动）'; return; }
      if (hint) hint.textContent = '正在强制安装（已备份）…';
      const r2 = await api('/api/update/install', { method: 'POST', body: JSON.stringify({ force: true }) })
        .catch((e) => ({ ok: false, error: e?.message || String(e) }));
      if (r2 && r2.ok) { if (hint) hint.textContent = '已开始强制安装，应用即将退出…'; return; }
      if (hint) hint.textContent = '安装失败：' + (r2?.error || '未知错误');
      instUpdateBtn.disabled = false;
      return;
    }
    if (hint) hint.textContent = '安装失败：' + (r?.error || '未知错误');
    instUpdateBtn.disabled = false;
  });

  // 打开设置页时若有已知新版本，直接把详情填好（走缓存，不额外打网络）
  if (typeof updateAvailable !== 'undefined' && updateAvailable) {
    api('/api/update-check').then((d) => {
      if (d?.ok) { state.updateInfo = d; }
      if (d?.ok && d.hasUpdate && isNewerVersion(d.latest, d.current)) showUpdateDetail(d);
    }).catch(() => {});
  }

  // ── OneBot 区块事件 ──
  const openSnowlumaBtn = $('#open-snowluma-btn');
  if (openSnowlumaBtn) openSnowlumaBtn.addEventListener('click', async () => {
    await saveConfig({ quiet: true });
    try { await api('/api/snowluma/open-folder', { method: 'POST', body: '{}' }); }
    catch (e) { $('#snowluma-hint').textContent = `失败：${e.message}`; }
  });

  // ── 数据管理区块事件 ──
  const openDataDirBtn = $('#open-datadir-btn');
  if (openDataDirBtn) openDataDirBtn.addEventListener('click', async () => {
    try {
      await api('/api/open-data-dir', { method: 'POST', body: '{}' });
    } catch (e) {
      console.error('打开数据目录失败:', e);
    }
  });

  const resetDataBtn = $('#reset-data-btn');
  if (resetDataBtn) resetDataBtn.addEventListener('click', async () => {
    const hint = $('#reset-data-hint');
    if (!(await uiConfirm('⚠️ 确定要重置为初始形态吗？\n\n此操作会删除所有用户数据：\n- 配置（API Key、模型、白名单）\n- 聊天记录\n- 长期记忆\n- 表情包库\n\n不可恢复！建议先备份 data/ 目录。'))) return;
    if (!(await uiConfirm('再次确认：真的要删除所有用户数据吗？'))) return;
    resetDataBtn.disabled = true;
    if (hint) hint.textContent = '重置中…';
    try {
      const r = await api('/api/reset-data', { method: 'POST', body: '{}' });
      if (r.ok) {
        if (hint) hint.textContent = '✅ 已重置，请重启应用';
        setTimeout(() => {
          alert('已重置为初始形态！\n\n请关闭应用并重新启动。');
        }, 500);
      } else {
        if (hint) hint.textContent = `重置失败：${r.error}`;
      }
    } catch (e) {
      if (hint) hint.textContent = `重置失败：${e.message}`;
    }
    resetDataBtn.disabled = false;
  });
}

// ── 转发白名单：点 chip 切换档位，立即写配置 ──────────────────
document.addEventListener('click', async (e) => {
  const chip = e.target.closest('#view-settings [data-fwd]');
  if (!chip) return;
  e.preventDefault();
  const tier = chip.dataset.fwd;
  const key = chip.dataset.key;
  if (!tier || !key) return;
  const cur = Object.assign({ free: [], limited: [], adminOnly: [] }, (state.config && state.config.forwardRules) || {});
  const list = new Set((cur[tier] || []).map(String));
  if (list.has(key)) list.delete(key); else list.add(key);
  cur[tier] = [...list];
  chip.classList.toggle('on', list.has(key));
  try {
    await api('/api/config', { method: 'POST', body: JSON.stringify({ forwardRules: cur }) });
    if (state.config) state.config.forwardRules = cur;
  } catch (err) {
    chip.classList.toggle('on', !list.has(key));
    if (typeof showNoticeModal === 'function') showNoticeModal('保存失败', String(err?.message || err));
  }
});

// ── 安全模式：开关 / 档位 / 自定义规则 / 试一下 ────────────────────
let safeSaveTimer = null;
async function safeModeSave(patch, rerender = false) {
  try {
    const r = await api('/api/config', { method: 'POST', body: JSON.stringify({ safeMode: patch }) });
    if (r && r.config) state.config = r.config;
    else if (state.config) state.config.safeMode = Object.assign({}, state.config.safeMode || {}, patch);
    if (rerender && typeof loadSettings === 'function') await loadSettings();
  } catch (e) {
    if (typeof showNoticeModal === 'function') showNoticeModal('保存失败', String(e?.message || e));
  }
}
document.addEventListener('change', async (e) => {
  const el = e.target.closest('#view-settings [data-safe]');
  if (!el) return;
  const field = el.dataset.safe;
  if (field === 'enabled') {
    if (!el.checked) {
      const ok = await uiConfirm(
        '确定关闭安全模式？\n\n关闭后，新收到的消息里的手机号、身份证号、银行卡号、密码/密钥等会**原样写入本地存档**，任何能访问 data 目录的程序都能读到。\n\n建议只在临时调试时关闭，用完立刻打开。',
        { title: '关闭安全模式', okText: '仍然关闭', danger: true }
      );
      if (!ok) { el.checked = true; return; }
    }
    safeModeSave({ enabled: !!el.checked });
    return;
  }
  if (field === 'level') {
    const lvl = Number(el.value) === 2 ? 2 : 1;
    const wrap = document.getElementById('safe-custom-wrap');
    if (wrap) wrap.style.display = lvl === 2 ? '' : 'none';
    const sub = document.querySelector('#settings-form .setcard');
    safeModeSave({ level: lvl });
    return;
  }
});
document.addEventListener('input', (e) => {
  const el = e.target.closest('#view-settings [data-safe="customText"]');
  if (!el) return;
  clearTimeout(safeSaveTimer);
  safeSaveTimer = setTimeout(() => { safeModeSave({ customText: el.value }); }, 600);
});
document.addEventListener('input', (e) => {
  const el = e.target.closest('#view-settings #safe-test-in');
  if (!el) return;
  clearTimeout(window.__safeTestT);
  window.__safeTestT = setTimeout(async () => {
    const out = document.getElementById('safe-test-out');
    if (!out) return;
    const text = el.value;
    if (!text.trim()) { out.textContent = ''; return; }
    try {
      const r = await api('/api/safe-mode/test', { method: 'POST', body: JSON.stringify({ text }) });
      out.innerHTML = r?.enabled === false
        ? '<span style="color:var(--orange)">安全模式已关闭，不会脱敏</span>'
        : '脱敏后：<b>' + (typeof esc === 'function' ? esc(String(r.after || '')) : String(r.after || '')) + '</b>' +
          (Array.isArray(r.hits) && r.hits.length ? '　<span style="color:var(--tx3)">命中：' + r.hits.join('、') + '</span>' : '　<span style="color:var(--tx3)">没命中规则</span>');
    } catch (err) {
      out.textContent = '测试失败：' + (err?.message || err);
    }
  }, 350);
});

// ── 白名单标签块：增 / 删 / 下拉选择 ──────────────────────────────
function tagHiddenEl(kind) {
  return document.getElementById(kind === 'groups' ? 'cfg-allowgroups' : (kind === 'private' ? 'cfg-allowprivate' : 'cfg-silentchats'));
}
function tagValsOf(kind) {
  const h = tagHiddenEl(kind);
  if (!h) return [];
  return String(h.value || '').split(/[,，\s]+/).map((v) => v.trim()).filter(Boolean);
}
function tagRenderChips(kind) {
  const box = document.querySelector('[data-tag-list="' + kind + '"]');
  if (!box) return;
  const escFn = (typeof esc === 'function') ? esc : (x) => String(x);
  box.innerHTML = tagValsOf(kind).map((v) =>
    '<span class="tag" data-tag-chip="' + kind + '"><span>' + escFn(v) + '</span>' +
    '<b class="tag-x" data-tag-del="' + kind + '" data-tag-val="' + escFn(v) + '" title="删除">✕</b></span>'
  ).join('');
}
function tagWrite(kind, vals) {
  const h = tagHiddenEl(kind);
  if (!h) return;
  h.value = vals.join(',');
  tagRenderChips(kind);
  // 复用既有自动保存：对整个设置表单生效的 input 监听会读到这个新值
  h.dispatchEvent(new Event('input', { bubbles: true }));
  // 额外显式落盘一次：通用自动保存是防抖 + 读 DOM 的整包流程，标签块这种
  // "点了就该立即生效"的操作不能只靠它（2026-10-22 实测：删掉静默会话后配置没变，
  // 群依然是静默）。这里直接写对应字段，成功后再刷新一次配置。
  try {
    const body = kind === 'silent'
      ? { store: { silentChats: vals.slice() } }
      : { allow: { [kind === 'groups' ? 'groups' : 'private']: vals.slice() } };
    api('/api/config', { method: 'POST', body: JSON.stringify(body) })
      .then((r) => { if (r && r.config) state.config = r.config; })
      .catch((e) => { if (typeof showNoticeModal === 'function') showNoticeModal('保存失败', String(e?.message || e)); });
  } catch { /* ignore */ }
}
function tagAddVal(kind, raw) {
  let v = String(raw || '').trim();
  if (kind === 'silent') {
    // 静默会话：group:123 / private:456 / 裸号（裸号按群算，统一补成 group:）
    const bare = /^(\d{4,})$/.exec(v);
    const pref = /^(group|private):(\d{4,})$/i.exec(v);
    if (bare) v = 'group:' + bare[1];
    else if (pref) v = pref[1].toLowerCase() + ':' + pref[2];
    else return false;
  } else {
    v = v.replace(/[^0-9]/g, '');
    if (!v) return false;
  }
  const cur = tagValsOf(kind);
  if (cur.includes(v)) return false;
  tagWrite(kind, [...cur, v]);
  return true;
}
document.addEventListener('click', (e) => {
  const x = e.target.closest('[data-tag-del]');
  if (!x) return;
  e.preventDefault();
  const kind = x.dataset.tagDel;
  const val = String(x.dataset.tagVal || '');
  tagWrite(kind, tagValsOf(kind).filter((v) => v !== val));
});
document.addEventListener('keydown', (e) => {
  const box = e.target.closest('[data-tag-box]');
  if (!box || e.key !== 'Enter') return;
  e.preventDefault();
  if (box.value.trim()) { tagAddVal(box.dataset.tagBox, box.value); box.value = ''; }
});
document.addEventListener('change', (e) => {
  const box = e.target.closest('[data-tag-box]');
  if (!box) return;
  // 下拉（datalist）选完之后 change 触发：直接变成标签
  if (String(box.value || '').trim()) { tagAddVal(box.dataset.tagBox, box.value); box.value = ''; }
});
// 「从 QQ 账号直接勾选」弹窗会直接改 hidden input 的值 → 让标签跟着刷新
document.addEventListener('input', (e) => {
  const id = e.target && e.target.id;
  if (id === 'cfg-allowgroups') tagRenderChips('groups');
  else if (id === 'cfg-allowprivate') tagRenderChips('private');
  else if (id === 'cfg-silentchats') tagRenderChips('silent');
});

// ── 静默会话被 @ 时的处理：开关 / 档位 / 固定回复词 ──────────────
let silentAtSaveTimer = null;
async function silentAtSave(patch) {
  try {
    const r = await api('/api/config', { method: 'POST', body: JSON.stringify({ silentAt: patch }) });
    if (r && r.config) state.config = r.config;
    else if (state.config) state.config.silentAt = Object.assign({}, state.config.silentAt || {}, patch);
  } catch (e) {
    if (typeof showNoticeModal === 'function') showNoticeModal('保存失败', String(e?.message || e));
  }
}
document.addEventListener('change', (e) => {
  const el = e.target.closest('#view-settings [data-silentat]');
  if (!el) return;
  const field = el.dataset.silentat;
  if (field === 'enabled') { silentAtSave({ enabled: !!el.checked }); return; }
  if (field === 'mode') { silentAtSave({ mode: Number(el.value) === 2 ? 2 : 1 }); return; }
});
document.addEventListener('input', (e) => {
  const el = e.target.closest('#view-settings [data-silentat="replyText"]');
  if (!el) return;
  clearTimeout(silentAtSaveTimer);
  silentAtSaveTimer = setTimeout(() => { silentAtSave({ replyText: el.value }); }, 600);
});

// ── 「未分配人格 = 静默」开关 ────────────────────────────────
document.addEventListener('change', async (e) => {
  const el = e.target.closest('#view-settings [data-silent-unassigned]');
  if (!el) return;
  try {
    const r = await api('/api/config', { method: 'POST', body: JSON.stringify({ store: { silentWhenUnassigned: !!el.checked } }) });
    if (r && r.config) state.config = r.config;
    if (typeof loadSettings === 'function') await loadSettings();
  } catch (err) {
    if (typeof showNoticeModal === 'function') showNoticeModal('保存失败', String(err?.message || err));
  }
});

// ── 指令禁言：解除按钮 + 解除指令配置 ──────────────────────────
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('#view-settings [data-cmdmute-release]');
  if (!btn) return;
  e.preventDefault();
  const gid = String(btn.dataset.cmdmuteRelease || '');
  btn.disabled = true;
  try {
    await api('/api/command-mute/release', { method: 'POST', body: JSON.stringify({ groupId: gid }) });
    state.commandMute = await api('/api/command-mute');
    if (typeof loadSettings === 'function') await loadSettings();
  } catch (err) {
    btn.disabled = false;
    if (typeof showNoticeModal === 'function') showNoticeModal('解除失败', String(err?.message || err));
  }
});
let cmdMuteCfgTimer = null;
function saveCmdMuteCfg(patch) {
  clearTimeout(cmdMuteCfgTimer);
  cmdMuteCfgTimer = setTimeout(async () => {
    try {
      const r = await api('/api/config', { method: 'POST', body: JSON.stringify({ commandMute: patch }) });
      if (r && r.config) state.config = r.config;
    } catch (err) {
      if (typeof showNoticeModal === 'function') showNoticeModal('保存失败', String(err?.message || err));
    }
  }, 600);
}
document.addEventListener('change', (e) => {
  const el = e.target.closest('#view-settings #ac-cmdmute-releaseadmin');
  if (!el) return;
  saveCmdMuteCfg({ releaseAdminOnly: !!el.checked });
});
document.addEventListener('input', (e) => {
  const el = e.target.closest('#view-settings #ac-cmdmute-release');
  if (!el) return;
  saveCmdMuteCfg({ releaseCommand: el.value.trim() });
});

// ── 禁言口令列表：增 / 删 / 改（整份 commands 数组落盘）──────────
function cmCollect() {
  const rows = [...document.querySelectorAll('#cm-rows .cm-row')];
  return rows.map((row) => {
    const cmdEl = row.querySelector('[data-cm-cmd]');
    const durEl = row.querySelector('[data-cm-dur]');
    const id = String(cmdEl?.dataset.cmId || ('cm_' + Math.random().toString(36).slice(2, 7)));
    return {
      id,
      command: String(cmdEl?.value || '').trim(),
      durationMin: Math.max(0, Number(durEl?.value) || 0),
      adminOnly: !!row.querySelector('[data-cm-admin]')?.checked
    };
  }).filter((x) => x.command);
}
let cmListTimer = null;
function cmSaveList(list, reload = false) {
  clearTimeout(cmListTimer);
  cmListTimer = setTimeout(async () => {
    try {
      const r = await api('/api/config', { method: 'POST', body: JSON.stringify({ commandMute: { commands: list } }) });
      if (r && r.config) state.config = r.config;
      if (reload && typeof loadSettings === 'function') await loadSettings();
    } catch (e) {
      if (typeof showNoticeModal === 'function') showNoticeModal('保存失败', String(e?.message || e));
    }
  }, reload ? 0 : 500);
}
document.addEventListener('click', (e) => {
  const add = e.target.closest('#view-settings [data-cm-add]');
  if (add) {
    e.preventDefault();
    const list = cmCollect();
    list.push({ id: 'cm_' + Date.now().toString(36), command: '/新口令', durationMin: 30 });
    cmSaveList(list, true);
    return;
  }
  const del = e.target.closest('#view-settings [data-cm-del]');
  if (del) {
    e.preventDefault();
    const list = cmCollect();
    list.splice(Number(del.dataset.cmDel), 1);
    cmSaveList(list, true);
  }
});
document.addEventListener('input', (e) => {
  if (!e.target.closest('#view-settings #cm-rows')) return;
  cmSaveList(cmCollect(), false);
});
document.addEventListener('change', (e) => {
  if (!e.target.closest('#view-settings #cm-rows')) return;
  cmSaveList(cmCollect(), false);
});

// ── 指令消息在上下文里怎么显示 ──────────────────────────────
document.addEventListener('change', async (e) => {
  const el = e.target.closest('#view-settings [data-cmdctx]');
  if (!el) return;
  try {
    const r = await api('/api/config', { method: 'POST', body: JSON.stringify({ commandContext: { mode: el.dataset.cmdctx } }) });
    if (r && r.config) state.config = r.config;
  } catch (err) {
    if (typeof showNoticeModal === 'function') showNoticeModal('保存失败', String(err?.message || err));
  }
});

// ── 记忆导出 / 导入 ─────────────────────────────────────────────────
let pendingBundleText = null;

/** 收集导出/导入选项：栏目 + 时间范围 + 是否脱敏 */
function membundleOptions() {
  const sections = {};
  for (const el of document.querySelectorAll('#view-settings [data-membundle-section]')) {
    sections[el.dataset.membundleSection] = !!el.checked;
  }
  const dayStart = (v) => (v ? new Date(v + 'T00:00:00').toISOString() : null);
  const dayEnd = (v) => (v ? new Date(v + 'T23:59:59.999').toISOString() : null);
  const sinceEl = document.getElementById('membundle-since');
  const untilEl = document.getElementById('membundle-until');
  const redactEl = document.getElementById('membundle-redact');
  return {
    sections,
    since: dayStart(sinceEl?.value || ''),
    until: dayEnd(untilEl?.value || ''),
    redact: !!redactEl?.checked
  };
}
function memBundleHint(text, color) {
  const el = document.getElementById('membundle-hint');
  if (!el) return;
  el.textContent = text || '';
  el.style.color = color || '';
}
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('#view-settings [data-membundle]');
  if (!btn) return;
  e.preventDefault();
  const act = btn.dataset.membundle;
  if (act === 'export') {
    memBundleHint('正在导出…');
    try {
      const opt = membundleOptions();
      const r = await api('/api/memory-bundle/export', { method: 'POST', body: JSON.stringify(opt) });
      if (!r || r.ok === false) { memBundleHint('导出失败：' + (r?.error || '未知错误'), 'var(--red)'); return; }
      const blob = new Blob([r.text], { type: 'application/json;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = r.name || 'memories.qqmem.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
      const c = r.counts || {};
      memBundleHint('已导出：通用 ' + (c.generals || 0) + ' / 群 ' + (c.groups || 0) + ' / 个人 ' + (c.persons || 0) + ' / 话题 ' + (c.topics || 0) + '，另存于 data/exports/', 'var(--green)');
    } catch (err) {
      memBundleHint('导出失败：' + (err?.message || err), 'var(--red)');
    }
    return;
  }
  if (act === 'pick') {
    const f = document.getElementById('membundle-file');
    if (f) f.click();
    return;
  }
  if (act === 'import') {
    if (!pendingBundleText) { memBundleHint('先选择文件', 'var(--orange)'); return; }
    const mode = btn.dataset.mode === 'replace' ? 'replace' : 'merge';
    btn.disabled = true;
    memBundleHint('正在导入（' + (mode === 'replace' ? '覆盖' : '合并') + '）…');
    try {
      const opt = membundleOptions();
      const r = await api('/api/memory-bundle/import', { method: 'POST', body: JSON.stringify({ bundle: pendingBundleText, mode, ...opt }) });
      if (!r || r.ok === false) {
        memBundleHint('导入失败：' + ((r?.errors || []).join('；') || '未知错误'), 'var(--red)');
      } else {
        const w = r.written || {}, s2 = r.skipped || {};
        memBundleHint('导入完成：写入 通用' + (w.generals || 0) + '/群' + (w.groups || 0) + '/个人' + (w.persons || 0) + '/话题' + (w.topics || 0) +
          '，跳过 ' + ((s2.generals || 0) + (s2.groups || 0) + (s2.persons || 0) + (s2.topics || 0)) + ' 条（已更新）', 'var(--green)');
        if (typeof loadSettings === 'function') await loadSettings();
      }
    } catch (err) {
      memBundleHint('导入失败：' + (err?.message || err), 'var(--red)');
    }
    btn.disabled = false;
    return;
  }
});
document.addEventListener('change', async (e) => {
  const f = e.target.closest('#view-settings #membundle-file');
  if (!f || !f.files || !f.files[0]) return;
  const file = f.files[0];
  const box = document.getElementById('membundle-preview');
  try {
    pendingBundleText = await file.text();
    memBundleHint('正在解析 ' + file.name + ' …');
    const opt = membundleOptions();
    const r = await api('/api/memory-bundle/preview', { method: 'POST', body: JSON.stringify({ bundle: pendingBundleText, ...opt }) });
    if (!r || r.ok === false) {
      pendingBundleText = null;
      if (box) { box.style.display = ''; box.innerHTML = '<span style="color:var(--red)">无法导入：' + ((r?.errors || []).join('；') || '未知错误') + '</span>'; }
      memBundleHint('');
      return;
    }
    const p = r.plan || {};
    const rows = ['generals', 'groups', 'persons', 'topics'].map((k) => {
      const x = p[k] || {};
      const label = { generals: '通用卡', groups: '群/私聊卡', persons: '个人卡', topics: '话题卡' }[k];
      return label + '：新增 ' + (x.add || 0) + ' · 更新 ' + (x.update || 0) + ' · 相同 ' + (x.same || 0) + ' · 较旧 ' + (x.older || 0);
    }).join('<br>');
    const gen = r.generator ? ((r.generator.app || '') + ' v' + (r.generator.version || '?') + ' · ' + (r.generator.exportedAt || '')) : '未知来源';
    if (box) {
      box.style.display = '';
      box.innerHTML = '<div style="border:1px solid var(--bd);border-radius:9px;padding:10px;background:var(--bg1)">' +
        '<div><b>' + (file.name) + '</b> <span class="muted">（' + gen + '）</span></div>' +
        '<div class="hint" style="margin:6px 0">' + rows + '</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
          '<button class="btn btn-small btn-primary" data-membundle="import" data-mode="merge">合并导入（保留较新）</button>' +
          '<button class="btn btn-small btn-danger" data-membundle="import" data-mode="replace">覆盖导入</button>' +
        '</div></div>';
    }
    memBundleHint('解析完成，确认下面的差异后再点导入');
  } catch (err) {
    pendingBundleText = null;
    memBundleHint('读取失败：' + (err?.message || err), 'var(--red)');
  }
});

// ── 操作审计查看 ───────────────────────────────────────────────
async function openSafeAudit() {
  try {
    const r = await api('/api/audit?limit=30');
    const items = Array.isArray(r.items) ? r.items : [];
    if (!items.length) { showNoticeModal('操作审计', '还没有记录。关闭安全模式、清理消息存档等操作会自动记入。'); return; }
    const lines = items.map((x) => {
      const d = new Date(x.ts);
      const pad = (n) => String(n).padStart(2, '0');
      const t = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      const detail = x.detail && Object.keys(x.detail).length ? ' ' + JSON.stringify(x.detail) : '';
      return `${t} ${x.action}${detail}`;
    }).join('\n');
    showNoticeModal('操作审计（最近 30 条）', lines);
  } catch (err) { showNoticeModal('读取失败', String(err?.message || err)); }
}
function bindSafeAuditBtn() {
  const b = document.getElementById('safe-audit-btn');
  if (!b || b.__bound) return;
  b.__bound = true;
  b.addEventListener('click', (e) => { e.stopPropagation(); openSafeAudit(); });
}
if (typeof window !== 'undefined' && !window.__safeAuditHook) {
  window.__safeAuditHook = true;
  const orig = window.renderSettings;
  if (typeof orig === 'function') {
    window.renderSettings = function () { const r = orig.apply(this, arguments); try { bindSafeAuditBtn(); } catch { /* ignore */ } return r; };
  }
  document.addEventListener('DOMContentLoaded', bindSafeAuditBtn);
  setInterval(bindSafeAuditBtn, 1500);
  try { new MutationObserver(() => bindSafeAuditBtn()).observe(document.body, { childList: true, subtree: true }); } catch { /* ignore */ }
}
