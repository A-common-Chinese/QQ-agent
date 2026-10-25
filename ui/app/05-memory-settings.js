// 〔记忆视图 / 设置加载 / 价格表状态〕——M9 拆分第 6 段
'use strict';
// ── 记忆视图 ──
async function loadMemoryViewLegacy() {
  try {
    const [cfg, chats] = await Promise.all([api('/api/config'), api('/api/chats')]);
    state.config = cfg;
  // 共用段预设（人设页 ④ 用）
  try {
    const sh = await api('/api/persona-shared');
    state.personaShared = sh.shared || {};
    state.personaSharedPresets = sh.presets || { activeId: '', items: [] };
  } catch (e) { /* 老后端没有这个接口时静默 */ }
  // 指令禁言运行态（哪些群正在禁言 / 解除指令配置）
  try {
    state.commandMute = await api('/api/command-mute');
  } catch (e) { state.commandMute = null; }
    const files = await api('/api/memory-files');
    state.memoryFiles = files.files || [];
    state.chats = chats.chats || [];
    // 用后端状态校正本地记录：覆盖"页面刚刷新""SSE 断连期间状态变化"两种情况。
    // 后端 consolidating 是唯一可信来源（它在 orchestrator 里真实维护）。
    for (const f of state.memoryFiles) {
      if (f.consolidating) {
        if (!state.consolidating[f.chatKey]) {
          state.consolidating[f.chatKey] = { startedAt: Date.now() };
        }
      } else if (state.consolidating[f.chatKey]) {
        // 后端已经不在整理，说明完成了（结果由 SSE 事件补充）
        delete state.consolidating[f.chatKey];
        if (!state.consolidateResult[f.chatKey]) {
          state.consolidateResult[f.chatKey] = { note: '整理完成', at: Date.now() };
        }
      }
    }
    renderMemoryList();
    if (state.currentMemoryChatKey) loadMemoryDetail(state.currentMemoryChatKey);
  } catch (e) {
    console.error('加载记忆视图失败:', e);
    $('#memory-items').innerHTML = '<div class="list-head muted">加载失败</div>';
  }
}

// 整理中的计时刷新：让"已 Ns"持续走动，并在没有活跃任务时自动停掉。
// 整理可能持续几十秒，用户切走再切回时靠它维持可见状态。
let consolidateTicker = null;
function startConsolidateTicker() {
  if (consolidateTicker) return;
  consolidateTicker = setInterval(() => {
    const active = Object.keys(state.consolidating);
    if (!active.length) {
      clearInterval(consolidateTicker);
      consolidateTicker = null;
      if (state.tab === 'memory') renderMemoryList();
      return;
    }
    if (state.tab !== 'memory') return;
    // 只更新计时文本，不重建整个详情页（避免打断用户阅读/滚动）
    const key = state.currentMemoryChatKey;
    const el = $('#mem-consolidate-status');
    if (key && state.consolidating[key] && el) {
      const sec = Math.max(0, Math.round((Date.now() - (state.consolidating[key].startedAt || Date.now())) / 1000));
      el.textContent = `整理中…（已 ${sec}s）`;
    }
    renderMemoryList();
  }, 1000);
}

function renderMemoryList() {
  const box = $('#memory-items');
  const files = state.memoryFiles || [];
  const names = {};
  for (const c of state.chats || []) names[c.key] = formatChatTitle(c.key, chatNameOf(c.key));
  if (!files.length) {
    box.innerHTML = '<div class="list-head muted">还没有任何记忆（等机器人使用记忆工具后才会出现）</div>';
    return;
  }
  box.innerHTML = files.map((f) => {
    const key = f.chatKey;
    const busy = !!state.consolidating[key];
    // 整理中：在列表项上直接标出，切页签回来也能一眼看到
    const busyHtml = busy
      ? `<span class="unread-pill" style="background:var(--orange)">整理中…</span>`
      : '';
    const sub = busy
      ? '正在整理本群记忆'
      : (f.memberCount
        ? `${f.memberCount} 位群友 · ${f.impressionCount} 条印象`
        : '暂无群友印象');
    const delBtn = (f.memberCount || f.impressionCount)
      ? `<button class="btn btn-small btn-danger mem-del-chat" data-key="${esc(key)}" title="删除本会话的全部记忆（所有群友的印象）">删除</button>`
      : '';
    return `
      <div class="chat-item ${key === state.currentMemoryChatKey ? 'selected' : ''}" data-key="${esc(key)}">
        <div class="chat-item-title">
          <span class="session-chat">${esc(names[key] || key)}</span>
          ${busyHtml}
          ${delBtn}
        </div>
        <div class="chat-item-sub">${esc(sub)}</div>
        <div class="session-meta"><span>更新于 ${fmtTime(f.updatedAt || 0)}</span></div>
      </div>`;
  }).join('');
  $$('.chat-item', box).forEach((el) => {
    el.addEventListener('click', () => {
      state.currentMemoryChatKey = el.dataset.key;
      renderMemoryList();
      loadMemoryDetail(state.currentMemoryChatKey);
    });
  });
  // 删除本会话的全部记忆（stopPropagation：别触发选中详情）
  $$('.mem-del-chat', box).forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const key = btn.dataset.key;
      const name = names[key] || key;
      const cnt = state.consolidating[key] ? 1 : 0;
      if (cnt) { alert('该会话记忆正在整理中，稍后再删'); return; }
      if (!(await uiConfirm(`确定删除「${name}」的全部记忆？\n\n所有群友的印象都会被删除，此操作不可撤销。`))) return;
      try {
        await api(`/api/memory-files/${encodeURIComponent(key.replace(':', '_'))}`, { method: 'DELETE' });
        if (state.currentMemoryChatKey === key) {
          state.currentMemoryChatKey = null;
          const detail = $('#memory-detail');
          if (detail) detail.innerHTML = '<div class="empty-hint">已删除。从左侧选择一个会话查看记忆</div>';
        }
        await loadMemoryView();
      } catch (err) {
        alert(`删除失败：${err.message}`);
      }
    });
  });
}

async function loadMemoryDetail(chatKey) {
  const detail = $('#memory-detail');
  detail.innerHTML = '<div class="empty-hint">加载中…</div>';
  try {
    const [mem, cfg] = await Promise.all([
      api(`/api/memory-files/${chatKey.replace(':', '_')}`),
      api('/api/config')
    ]);
    const notes = cfg.memberNotes || {};
    const kind = chatKey.startsWith('group') ? 'group' : 'private';
    const chatId = chatKey.split(':')[1] || '';
    const members = Array.isArray(mem.members) ? mem.members : [];
    const membersHtml = kind === 'group'
      ? `<div class="field" style="margin:8px 0"><button class="btn btn-small" id="mem-load-members-btn">拉取群成员列表（编辑备注）</button><span id="mem-members-status" class="muted"></span></div><div id="mem-members"></div>`
      : '';
    const rows = members.map((m) => {
      const who = notes[String(m.userId)] || m.name || m.userId || '某人';
      const qq = m.userId ? ` <span class="muted">(QQ ${esc(m.userId)})</span>` : '';
      const imps = m.impressions.map((e) => `- ${e.content}`).join('\n');
      // 必须是 <details> 才能开合：div+summary 点了不会收起
      return `<details class="collapsible mem-fold" open>
        <summary>
          <span class="mem-who">${esc(who)}${qq}（${m.impressions.length} 条）</span>
          <span class="mem-actions">
            <button class="btn btn-small mem-edit-imp" data-qq="${esc(m.userId)}" data-name="${esc(m.name)}">编辑</button>
            <button class="btn btn-small mem-refresh-imp" data-qq="${esc(m.userId)}" data-name="${esc(m.name)}" title="让模型重新分析这个人：有印象则整理合并，没印象则从聊天记录里提炼">更新记忆</button>
            <button class="btn btn-small btn-danger mem-del-imp" data-qq="${esc(m.userId)}" data-name="${esc(m.name)}" title="删除这个人的全部印象">删除</button>
          </span>
        </summary>
        <div class="coll-body">${esc(imps)}</div>
      </details>`;
    }).join('');
    // 整理状态从 state 恢复：切页签回来 / 刷新页面后依然可见
    const busy = !!state.consolidating[chatKey];
    const result = state.consolidateResult[chatKey];
    let consolidateStatusHtml = '';
    if (busy) {
      const started = state.consolidating[chatKey]?.startedAt || Date.now();
      const sec = Math.max(0, Math.round((Date.now() - started) / 1000));
      consolidateStatusHtml = `<span id="mem-consolidate-status" class="muted">整理中…（已 ${sec}s）</span>`;
    } else if (result) {
      const ago = Math.max(0, Math.round((Date.now() - (result.at || 0)) / 1000));
      const when = ago < 60 ? `${ago}s 前` : `${Math.round(ago / 60)} 分钟前`;
      consolidateStatusHtml = `<span id="mem-consolidate-status" class="muted">${esc(result.note)}（${when}）</span>`;
    } else {
      consolidateStatusHtml = `<span id="mem-consolidate-status" class="muted"></span>`;
    }
    detail.innerHTML = `
      <div class="detail-header">
        <h2>${esc(formatChatTitle(chatKey, chatNameOf(chatKey)))} 的记忆</h2>
        <div class="sub">
          <span>每个群友一个文件：data/memory/${esc(chatKey.replace(':', '_'))}/&lt;QQ&gt;.json</span>
          <button class="btn btn-small" id="mem-add-imp-btn">＋ 添加印象</button>
          <button class="btn btn-small" id="mem-consolidate-btn" ${busy ? 'disabled' : ''}>${busy ? '整理中…' : '整理本群记忆'}</button>
          ${consolidateStatusHtml}
        </div>
      </div>
      ${membersHtml}
      ${rows || '<div class="muted" style="padding:10px">还没有任何群友印象（可点右上角「＋ 添加印象」手动记，或点「整理本群记忆」让模型从聊天记录里提炼）。</div>'}
    `;
    const loadMembersBtn = $('#mem-load-members-btn');
    if (loadMembersBtn) loadMembersBtn.addEventListener('click', () => loadGroupMembers(chatId, chatKey));
    $$('.mem-edit-imp', detail).forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const m = members.find((x) => String(x.userId) === String(el.dataset.qq));
        openMemberImpressModal(chatKey, m || { userId: el.dataset.qq, name: el.dataset.name, impressions: [] });
      });
    });
    // 删除单个群友的全部印象（表面化按钮，不必进编辑弹窗）
    $$('.mem-del-imp', detail).forEach((el) => {
      el.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const uid = String(el.dataset.qq || '').trim();
        const name = el.dataset.name || uid;
        if (!(await uiConfirm(`确定删除「${name}」的全部印象？此操作不可撤销。`))) return;
        try {
          await api(`/api/memory-files/${encodeURIComponent(chatKey.replace(':', '_'))}/members/${encodeURIComponent(uid)}`, { method: 'DELETE' });
          await loadMemoryDetail(chatKey);
          await loadMemoryView();
        } catch (err) {
          alert(`删除失败：${err.message}`);
        }
      });
    });
    $('#mem-add-imp-btn')?.addEventListener('click', () => openMemberImpressModal(chatKey, null));
    // 针对单个群友更新记忆：有印象→整理合并；无印象→从聊天记录提炼
    $$('.mem-refresh-imp', detail).forEach((el) => {
      el.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const uid = String(el.dataset.qq || '').trim();
        if (!/^\d{1,15}$/.test(uid)) { alert('该群友缺少 QQ 号，无法定位聊天记录'); return; }
        el.disabled = true;
        const old = el.textContent;
        el.textContent = '更新中…';
        // 同样记进 state，切页签回来后仍能看到进行中
        state.consolidating[chatKey] = { startedAt: Date.now() };
        delete state.consolidateResult[chatKey];
        startConsolidateTicker();
        renderMemoryList();
        try {
          await api('/api/memory-files/consolidate', {
            method: 'POST',
            body: JSON.stringify({ chatKey, userIds: [uid] })
          });
          el.textContent = '已提交 ✓';
        } catch (err) {
          el.textContent = '失败';
          alert(`更新记忆失败：${err.message}`);
        }
        setTimeout(() => { el.disabled = false; el.textContent = old; }, 2500);
      });
    });
    $('#mem-consolidate-btn')?.addEventListener('click', async () => {
      const btn = $('#mem-consolidate-btn');
      const status = $('#mem-consolidate-status');
      // 立刻记进 state：即使马上切走页签，回来也能看到"整理中"
      state.consolidating[chatKey] = { startedAt: Date.now() };
      delete state.consolidateResult[chatKey];
      startConsolidateTicker();
      renderMemoryList();
      if (btn) { btn.disabled = true; btn.textContent = '整理中…'; }
      if (status) status.textContent = '整理中…';
      try {
        const r = await api('/api/memory-files/consolidate', {
          method: 'POST',
          body: JSON.stringify({ chatKey })
        });
        if (r.error) {
          delete state.consolidating[chatKey];
          state.consolidateResult[chatKey] = { note: `失败：${r.error}`, at: Date.now(), failed: true };
          if (status) status.textContent = `失败：${r.error}`;
          if (btn) { btn.disabled = false; btn.textContent = '整理本群记忆'; }
          renderMemoryList();
        }
        // 成功时保持"整理中"，等 SSE 的 consolidate-done 事件来收尾
      } catch (e) {
        delete state.consolidating[chatKey];
        state.consolidateResult[chatKey] = { note: `失败：${e.message}`, at: Date.now(), failed: true };
        if (status) status.textContent = `失败：${e.message}`;
        if (btn) { btn.disabled = false; btn.textContent = '整理本群记忆'; }
        renderMemoryList();
      }
    });
    // 若本群正在整理，启动计时刷新（切回来时也能接着走）
    if (state.consolidating[chatKey]) startConsolidateTicker();
    // 选中会话后记忆详情整体淡入
    uiEnter(detail);
  } catch (e) {
    detail.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

/** 编辑/添加某个群友的印象（一行一条，保存后整体替换）。 */
function openMemberImpressModal(chatKey, member) {
  const isEdit = !!(member && member.userId);
  const userId = member?.userId || '';
  const name = member?.name || '';
  const imps = (member?.impressions || []).map((e) => e.content).join('\n');
  const cfg = state.config || {};
  const notes = cfg.memberNotes || {};
  const note = notes[String(userId)] || '';
  const overlay = modelModalShell({
    head: isEdit ? `编辑群友印象：${note || name || userId}` : '添加群友印象',
    body: `
      ${isEdit ? `
      <div class="field-row">
        <div class="field"><label>QQ 号</label><input type="text" id="mi-qq" value="${esc(userId)}" readonly /></div>
        <div class="field"><label>QQ 昵称</label><input type="text" id="mi-nickname" value="${esc(name)}" readonly /></div>
        <div class="field"><label>群内昵称</label><input type="text" id="mi-card" value="${esc(member?.card || '')}" readonly /></div>
      </div>
      <div class="field"><label>QQ agent 对群友的当前备注</label><input type="text" id="mi-note" value="${esc(note)}" placeholder="留空则使用原群名片/昵称" /></div>` : `
      <div class="field"><label>QQ 号（必填）</label><input type="text" id="mi-qq" value="${esc(userId)}" /></div>
      <div class="field"><label>名字（备注名/群名片/昵称）</label><input type="text" id="mi-name" value="${esc(name)}" /></div>`}
      <div class="field"><label>印象内容（一行一条；留空 = 删除该成员全部印象）</label><textarea id="mi-imps" style="min-height:160px" placeholder="老王喜欢钓鱼，周末常不在&#10;说话爱玩梗，别太认真">${esc(imps)}</textarea></div>`,
    foot: `<button class="btn" id="mi-cancel">取消</button>
           ${isEdit ? '<button class="btn btn-danger" id="mi-del">删除此人</button>' : ''}
           <button class="btn btn-primary" id="mi-save">保存</button>`
  });
  overlay.querySelector('#mi-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#mi-save').addEventListener('click', async () => {
    const qq = ($('#mi-qq')?.value || '').trim();
    const nm = ($('#mi-name')?.value || $('#mi-nickname')?.value || '').trim();
    const newNote = ($('#mi-note')?.value || '').trim();
    const lines = ($('#mi-imps')?.value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!/^\d{1,15}$/.test(qq)) { alert('QQ 号必须是数字'); return; }
    try {
      await api(`/api/memory-files/${chatKey.replace(':', '_')}/members/${qq}`, {
        method: 'PUT',
        body: JSON.stringify({ name: nm, note: newNote, impressions: lines })
      });
      closeModelModal(overlay);
      loadMemoryDetail(chatKey);
    } catch (e) {
      alert(`保存失败：${e.message}`);
    }
  });
  const delBtn = overlay.querySelector('#mi-del');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!(await uiConfirm(`确定删除 ${note || name || userId} 的全部印象？`))) return;
    try {
      await api(`/api/memory-files/${chatKey.replace(':', '_')}/members/${userId}`, { method: 'DELETE', body: '{}' });
      closeModelModal(overlay);
      loadMemoryDetail(chatKey);
    } catch (e) {
      alert(`删除失败：${e.message}`);
    }
  });
}

async function loadGroupMembers(chatId, chatKey) {
  const status = $('#mem-members-status');
  if (status) status.textContent = '拉取中…';
  try {
    const data = await api(`/api/groups/${chatId}/members`);
    state.groupMembers = data.members || [];
    state.groupMembersLoaded = true;
    const cfg = state.config || await api('/api/config');
    const notes = cfg.memberNotes || {};
    const box = $('#mem-members');
    if (box) {
      box.innerHTML = `<details class="collapsible mem-fold" open><summary><span class="mem-who">群成员（${state.groupMembers.length} 人）</span></summary><div class="coll-body"><table class="member-table">
        <tr><th style="text-align:left">群名片</th><th style="text-align:left">QQ昵称</th><th style="text-align:left">QQ号</th><th style="width:90px;text-align:right">备注</th></tr>
        ${state.groupMembers.map((m) => {
          const note = notes[String(m.userId)];
          return `<tr>
            <td>${esc(note || m.card || '—')}${note && (m.card || m.nickname) ? ` <span class="muted">(${esc(m.card || m.nickname)})</span>` : ''}</td>
            <td>${esc(m.nickname || '—')}</td>
            <td class="muted" style="font-size:11px">${esc(m.userId)}</td>
            <td style="text-align:right"><button class="btn btn-small member-note-edit" data-qq="${esc(m.userId)}">编辑备注</button></td>
          </tr>`;
        }).join('')}
      </table></div></details>`;
      box.querySelectorAll('.member-note-edit').forEach((el) => {
        el.addEventListener('click', () => openMemberNoteModal(el.dataset.qq, chatKey));
      });
    }
    if (status) status.textContent = `已拉取 ${state.groupMembers.length} 人`;
  } catch (e) {
    if (status) status.textContent = `拉取失败：${e.message}`;
  }
}

async function openMemberNoteModal(qq, chatKey) {
  const cfg = state.config || await api('/api/config');
  const notes = cfg.memberNotes || {};
  const oldNote = notes[String(qq)] || '';
  const member = (state.groupMembers || []).find((m) => String(m.userId) === String(qq));
  const displayName = member ? String(member.card || member.nickname || '') : '';
  const overlay = modelModalShell({
    head: `编辑备注：${esc(oldNote || displayName || qq)}`,
    body: `
      <div class="field"><label>QQ 号</label><input type="text" value="${esc(qq)}" readonly style="width:100%" /></div>
      <div class="field"><label>备注名</label><input type="text" id="mn-note" value="${esc(oldNote)}" placeholder="${esc(displayName || '备注名（如 老王）')}" style="width:100%" /></div>
      <div class="hint">保存后，聊天记录、记忆、群成员列表都会优先显示这个备注；留空则显示原群名片/昵称。</div>`,
    foot: `<button class="btn" id="mn-cancel">取消</button>
           ${oldNote ? '<button class="btn btn-danger" id="mn-delete">删除备注</button>' : ''}
           <button class="btn btn-primary" id="mn-save">保存</button>`
  });
  overlay.querySelector('#mn-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#mn-save').addEventListener('click', async () => {
    const name = $('#mn-note')?.value.trim() || '';
    const nextNotes = { ...(state.config?.memberNotes || {}) };
    if (name) nextNotes[String(qq)] = name; else delete nextNotes[String(qq)];
    try {
      const data = await api('/api/config', { method: 'POST', body: JSON.stringify({ memberNotes: nextNotes }) });
      state.config = data.config;
      closeModelModal(overlay);
      await loadGroupMembers(chatKey.split(':')[1] || '', chatKey);
    } catch (e) {
      alert(`保存失败：${e.message}`);
    }
  });
  const delBtn = overlay.querySelector('#mn-delete');
  if (delBtn) delBtn.addEventListener('click', async () => {
    const nextNotes = { ...(state.config?.memberNotes || {}) };
    delete nextNotes[String(qq)];
    try {
      const data = await api('/api/config', { method: 'POST', body: JSON.stringify({ memberNotes: nextNotes }) });
      state.config = data.config;
      closeModelModal(overlay);
      await loadGroupMembers(chatKey.split(':')[1] || '', chatKey);
    } catch (e) {
      alert(`删除失败：${e.message}`);
    }
  });
}
async function loadSettings() {
  const [cfg, tplData, provData, visionData, priceData, toolsData, skillsData] = await Promise.all([
    api('/api/config'),
    api('/api/persona-templates').catch(() => ({ templates: [] })),
    api('/api/providers').catch(() => ({ providers: [] })),
    api('/api/vision/results').catch(() => ({ results: {}, scanning: false })),
    api('/api/model-prices').catch(() => ({ prices: [], current: null })),
    api('/api/tools').catch(() => ({ tools: [] })),
    // 技能状态由后端判定（loaded/enabled/available/active + reason），
    // 前端只展示，不自己推断可用性 —— 避免出现第二套口径
    api('/api/skills').catch(() => ({ skills: [], summary: {} }))
  ]);
  state.config = cfg;
  state.providers = provData.providers || [];
  state.visionResults = visionData.results || {};
  state.visionScanning = !!visionData.scanning;
  state.modelPrices = priceData || { prices: [], current: null };
  state.personaTemplates = {};
  state.toolRegistry = toolsData.tools || [];
  state.skills = skillsData.skills || [];
  state.skillsSummary = skillsData.summary || {};
  state.uninstalledSkills = skillsData.uninstalled || [];
  for (const t of tplData.templates || []) state.personaTemplates[t.id] = { name: t.name, text: t.text, builtin: !!t.builtin };
  // 提示词预览与配置并行拉取；渲染时可能还没到（先显示占位，到达后原地替换）
  refreshPromptPreview(cfg);
  renderSettings();
}

/** 设置页「远程价格表」状态行：来源（在线/缓存/内置）、时间、条目数、错误。 */
function renderPriceFeedStatus() {
  const el = $('#price-feed-status');
  if (!el) return;
  const r = state.modelPrices?.remote;
  if (!r || !r.enabled) {
    el.textContent = '官网价格表暂未启用，当前使用内置表；点击“拉取价格表”即可立即重试。';
    return;
  }
  const when = r.fetchedAt ? fmtTime(r.fetchedAt) : '-';
  const droppedTxt = r.dropped ? `，${r.dropped} 条不合格被丢弃` : '';
  if (r.ok && r.source === 'remote') {
    el.textContent = `远程表生效中：${r.count} 条覆盖内置表 · 上次拉取 ${when}${droppedTxt}`;
  } else if (!r.ok && r.source === 'cache') {
    el.textContent = `服务器暂时拉不到（${r.error || '未知错误'}），正在用上次缓存的远程表（${r.count} 条）· ${when}`;
  } else if (!r.ok) {
    el.textContent = `拉取失败（${r.error || '未知错误'}），暂用内置表 · ${when}`;
  } else {
    el.textContent = `已应用本地缓存（${r.count} 条），正在拉取最新…`;
  }
}

/**
 * 刷新「当前模型单价」卡片。
 *
 * ── 规则（只跟开关绑定，绝不依赖保存状态）──
 *   开关开 → 展示内置官方价，输入框**只读**
 *            匹配不到就是 0，提示关掉开关自填
 *   开关关 → 输入框**可编辑**，优先该模型的自定义价，没设则用全局兜底
 *
 * 匹配判断在本地用 state.modelPrices.prices 直接算，
 * 不读 state.modelPrices.current —— 那是后端按「当时请求的模型」算的，
 * 切换模型后若不重新请求就会拿到旧值。
 */
/**
 * 在内置价格表里匹配模型（前端版）。
 *
 * 前端是无模块单文件，拿不到 src/model-prices.js 的导出，所以这里实现一份
 * 与后端 matchPriceTable 完全相同的逻辑：精确 → 去前缀 → 最长前缀匹配。
 * 用本地数据算而不是读 state.modelPrices.current —— 后者是后端按
 * 「当时请求的模型」算的，切换模型后不重新请求就会拿到旧值。
 */
function refreshModelPriceCard() {
  const modelEl = $('#pc-model');
  const noteEl = $('#pc-note');
  const inEl = $('#cfg-price-in');
  const outEl = $('#cfg-price-out');
  const cachedEl = $('#cfg-price-cached');
  if (!modelEl) return;

  const cfg = state.config || {};
  const api = cfg.api || {};

  // 实时值：优先界面控件，退回已保存配置
  const box = $('#cfg-useofficialprice');
  const modelInput = $('#cfg-model');
  const useOfficial = box ? box.checked : (api.useOfficialPrice !== false);
  const model = String((modelInput ? modelInput.value : api.model) || '').trim();

  modelEl.textContent = model || '（未选择模型）';

  if (!model) {
    [inEl, outEl, cachedEl].forEach((el) => { if (el) { el.value = 0; el.disabled = true; } });
    if (noteEl) noteEl.textContent = '先在上方选择一个模型，才能查看/设定它的单价。';
    return;
  }

  let shown, locked, sourceTxt;

  // 优先级与后端 resolveModelPrice 一致：模型级自定义价命中 > 官方表（开关开）
  // > 全局兜底。曾经开关开时只查官方表 —— 已存自定义价 + 开关开 → 界面显示
  // 官方价、成本看板按自定义价计费，显示与计费两张皮。
  const customEntry = (api.modelPrices || {})[model];
  const hasCustom = !!(customEntry && (Number(customEntry.in) || Number(customEntry.out)));

  if (hasCustom) {
    locked = true;   // 与后端口径对齐：自定义价命中时 locked = useOfficial
    shown = {
      in: Number(customEntry.in) || 0,
      out: Number(customEntry.out) || 0,
      cached: customEntry.cached == null ? Number(customEntry.in) || 0 : Number(customEntry.cached) || 0
    };
    sourceTxt = '正在使用你为该模型设定的单价（优先于官方价格表）。要改请先清除自定义单价。';
  } else if (useOfficial) {
    locked = true;
    const official = matchPriceTable(model, state.modelPrices?.prices || []);
    if (official) {
      shown = {
        in: official.in ?? 0,
        out: official.out ?? 0,
        cached: official.cached == null ? official.in : official.cached
      };
      const tag = official.src === 'official' ? '厂商官方定价页直取' : '二手折算，仅供参考';
      sourceTxt = `内置官方价格表已匹配到「${official.id}」（${tag}）。开关开启时只读 —— 要自定义请关闭上方开关。`;
      if (official.peak) {
        sourceTxt += `　该模型分时段计价（高峰 ${official.peak.in}/${official.peak.out}/${official.peak.cached}）。`;
      }
      if (official.image) {
        sourceTxt += '　支持图片输入：' + (official.image.mode === 'capped'
          ? `每张封顶 ${official.image.maxTokensPerImage} token`
          : official.image.mode === 'pixel'
            ? `每张 = 宽×高/${official.image.divisor}+${official.image.base} token`
            : '换算规则待补');
      }
    } else {
      shown = { in: 0, out: 0, cached: 0 };
      sourceTxt = '';
    }
  } else {
    locked = false;
    shown = {
      in: Number(api.priceInputPerM) || 0,
      out: Number(api.priceOutputPerM) || 0,
      cached: Number(api.priceCachedPerM) || Number(api.priceInputPerM) || 0
    };
    sourceTxt = '已关闭官方价格表，可在此填写该模型的单价（也可在「批量自定义价格编辑」里为多个模型分别设定）。';
  }

  if (inEl) { inEl.value = shown.in ?? 0; inEl.disabled = locked; }
  if (outEl) { outEl.value = shown.out ?? 0; outEl.disabled = locked; }
  if (cachedEl) { cachedEl.value = shown.cached ?? 0; cachedEl.disabled = locked; }
  const card = $('#model-price-card');
  if (card) {
    card.classList.toggle('locked', locked);
    // 官方价开启且无自定义价命中时整卡置灰：视觉上明确「这里不可改」；
    // 命中自定义价时锁定状态由 locked 表达，不额外置灰混淆来源
    card.classList.toggle('pc-official-on', useOfficial === true && !hasCustom);
  }
  if (noteEl) noteEl.textContent = sourceTxt;
}

/**
 * 批量自定义价格编辑：左列选供应商 → 右列该供应商的模型 →
 * 官方表（输入/输出/缓存命中）参考列 + 自定义单价输入列。
 *
 * 曾经的候选列表是"当前模型 + 已自定义 + 用量统计里出现过的" ——
 * 没调用过的模型根本进不了名单，想提前给没用过的新模型定价都做不到。
 * 现在按供应商目录浏览，全量模型都可设定。
 *
 * 两个细节：
 *   1. 编辑暂存在 edits 里（input 事件实时写入），切换供应商不丢未保存的修改
 *   2. 目录之外但已自定义的模型归到虚拟供应商「已自定义（目录外）」，
 *      保证旧条目永远能找到、能清除
 */
function openBatchPriceModal() {
  const cfg = state.config || {};
  const customMap = cfg.api?.modelPrices || {};
  // 编辑暂存：以已保存的自定义价为起点，用户的每一次输入都先落在这里
  const edits = {};
  for (const [k, v] of Object.entries(customMap)) edits[k] = { ...(v || {}) };

  // 左列数据：供应商目录 + 虚拟供应商（目录外已自定义的模型）
  const catalogModels = new Set();
  for (const p of (state.providers || [])) for (const m of (p.models || [])) catalogModels.add(m);
  const orphanCustoms = Object.keys(customMap).filter((k) => !catalogModels.has(k)).sort();
  const lefts = (state.providers || []).map((p) => ({
    id: p.id, name: p.displayName || p.id, models: p.models || [], names: p.modelNames || {}
  }));
  if (orphanCustoms.length) {
    lefts.push({ id: '__custom__', name: `已自定义（目录外 ${orphanCustoms.length}）`, models: orphanCustoms, names: {} });
  }

  if (!lefts.length) {
    modelModalShell({
      head: '批量自定义价格编辑',
      body: '<div class="empty-hint">模型目录为空：请先在「模型 API」页签添加提供商。</div>',
      foot: ''
    });
    return;
  }

  let activePid = lefts[0].id;
  let kw = '';   // 搜索关键词（中转站供应商可能有几百个模型，没搜索没法用）

  const overlay = modelModalShell({
    head: '批量自定义价格编辑',
    body: `
      <div class="ma-toolbar">
        <input type="text" id="bp-search" placeholder="搜索模型…" autocomplete="off" />
        <span class="muted" style="font-size:12px;white-space:nowrap">留空 = 不自定义（走官方表/兜底）</span>
      </div>
      <div class="ma-body dual">
        <div class="model-modal-left" id="bp-left"></div>
        <div class="model-modal-right" id="bp-right"></div>
      </div>
      <div id="bp-hint" class="muted" style="font-size:12px;flex-shrink:0;margin-top:8px">
        输入框占位符与模型名悬停提示均为官方价（元/百万 token）；修改只写入你的配置，不会改动官方价格表。
      </div>`,
    foot: `<button class="btn" id="bp-cancel">取消</button>
           <button class="btn btn-primary" id="bp-save">保存</button>`
  });

  const left = overlay.querySelector('#bp-left');
  const right = overlay.querySelector('#bp-right');
  const hintEl = overlay.querySelector('#bp-hint');

  function renderLeft() {
    left.innerHTML = lefts.map((p) =>
      `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.name)}</div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
    });
  }

  function rowHtml(p, m) {
    if (kw && !m.toLowerCase().includes(kw) && !String(p.names[m] || '').toLowerCase().includes(kw)) return '';
    const off = matchPriceTable(m, state.modelPrices?.prices || []);
    const c = edits[m] || {};
    // 官方价不占列（太挤）：placeholder 里有，模型名悬停也有
    const offTitle = off ? `官方价：输入 ${off.in} / 输出 ${off.out} / 缓存 ${off.cached ?? '—'}（元/百万）` : '官方价格表未收录';
    return `
      <tr data-model="${esc(m)}">
        <td title="${esc(offTitle)}">${esc(p.names[m] || m)}<div class="muted" style="font-size:11px">${esc(m)}</div></td>
        <td><input type="number" step="0.01" min="0" class="bp-in" value="${esc(c.in ?? '')}" placeholder="${off ? off.in : 0}" /></td>
        <td><input type="number" step="0.01" min="0" class="bp-out" value="${esc(c.out ?? '')}" placeholder="${off ? off.out : 0}" /></td>
        <td><input type="number" step="0.01" min="0" class="bp-cached" value="${esc(c.cached ?? '')}" placeholder="${off ? (off.cached ?? 0) : 0}" /></td>
        <td><button class="bp-del" title="清除该模型的自定义价">清除</button></td>
      </tr>`;
  }

  function renderRight() {
    const p = lefts.find((x) => x.id === activePid);
    const models = p ? p.models : [];
    right.innerHTML = `
      <table class="usage-table">
        <thead><tr>
          <th>模型（悬停看官方价）</th>
          <th>自定义 输入</th><th>自定义 输出</th><th>自定义 缓存命中</th><th></th>
        </tr></thead>
        <tbody id="bp-body">
          ${models.map((m) => rowHtml(p, m)).join('') || '<tr><td colspan="5" class="muted">没有匹配的模型</td></tr>'}
        </tbody>
      </table>`;
    // 输入实时落进 edits：切换供应商/搜索重渲染后不丢未保存的修改
    right.querySelectorAll('#bp-body tr[data-model]').forEach((tr) => {
      const m = tr.dataset.model;
      const sync = () => {
        const num = (sel) => {
          const v = String(tr.querySelector(sel)?.value ?? '').trim();
          return v === '' ? null : (Number(v) || 0);
        };
        const i = num('.bp-in'), o = num('.bp-out'), c = num('.bp-cached');
        if (i === null && o === null && c === null) delete edits[m];
        else edits[m] = { in: i ?? 0, out: o ?? 0, cached: c ?? (i ?? 0) };
      };
      tr.querySelectorAll('input').forEach((inp) => inp.addEventListener('input', sync));
    });
    right.querySelectorAll('#bp-body .bp-del').forEach((el) => {
      el.addEventListener('click', () => {
        const tr = el.closest('tr[data-model]');
        if (!tr) return;
        delete edits[tr.dataset.model];
        tr.querySelectorAll('input').forEach((i) => { i.value = ''; });
      });
    });
  }

  overlay.querySelector('#bp-search')?.addEventListener('input', (e) => {
    kw = String(e.target.value || '').trim().toLowerCase();
    renderRight();
  });

  renderLeft();
  renderRight();

  overlay.querySelector('#bp-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#bp-save').addEventListener('click', async () => {
    // 保存的就是 edits 本身（输入时已实时同步，不用再扫 DOM）
    const next = edits;
    try {
      hintEl.textContent = '保存中…';
      // 用 __replace__ 整体替换：普通深合并传对象是删不掉旧键的，
      // 用户点"清除"某行后保存，旧条目会复活。
      await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({ api: { modelPrices: { __replace__: next } } })
      });
      // 更新本地状态，避免下次打开还是旧值
      state.config = state.config || {};
      state.config.api = state.config.api || {};
      state.config.api.modelPrices = next;
      closeModelModal(overlay);
      refreshModelPriceCard();
      // 2026-09-19（M9 清理）：旧 #provider-action-hint 元素已随改版消失，写它会在
      // try 里抛 TypeError 被自己的 catch 吞成"保存失败"。改写存活的 #provider-hint。
      $('#provider-hint').textContent = `已保存 ${Object.keys(next).length} 个模型的自定义单价。`;
    } catch (e) {
      hintEl.textContent = `保存失败：${esc(e.message)}`;
    }
  });
}

function renderPersonaPicker(c) {
  const currentId = Object.entries(state.personaTemplates || {}).find(([, p]) => p.text === (c.persona?.roleText || ''))?.[0] || '';
  const currentName = state.personaTemplates[currentId]?.name || '';
  return `
    <div class="field-row" style="align-items:flex-end">
      <div class="field">
        <label>选择人设</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <input type="text" id="cfg-persona-pick" class="inp persona-pick" readonly placeholder="点击选择人设" value="${esc(currentName)}" style="flex:1;min-width:160px;cursor:pointer" />
          <button class="btn btn-small" id="new-persona-btn">＋ 添加人设</button>
          <button class="btn btn-small btn-danger hidden" id="del-persona-btn">删除当前自定义人设</button>
        </div>
        <span id="persona-pick-hint" class="muted" style="font-size:12px"></span>
      </div>
    </div>`;
}

function renderHealthCard() {
  const { ready, checks } = assessReadiness(state.config, state.status);
  const rows = checks.map((c, idx) => {
    let extra = '';
    if (!c.ok) {
      if (c.fix === 'snowluma-tab') {
        extra = ' <button class="btn btn-small hc-fix-btn" data-target="snowluma">前往启动</button>';
      } else if (c.fix === 'settings-api') {
        extra = ' <button class="btn btn-small hc-fix-btn" data-target="settings-api">去填写</button>';
      } else if (c.fix === 'settings-allow') {
        extra = ' <button class="btn btn-small hc-fix-btn" data-target="settings-allow">去勾选</button>';
      }
    }
    return `
    <div class="h-item ${c.ok ? 'ok' : 'bad'}">
      <span>${c.ok ? '✓' : '✗'}</span>
      <span class="h-label">${esc(c.label)}${extra}</span>
    </div>`;
  }).join('');
  const testRow = `
    <div class="h-item ${'mute'}">
      <span>·</span>
      <span class="h-label">API 连通性：
        <button class="btn btn-small" id="test-api-btn">测试一下</button>
        <span id="test-api-result" class="muted"></span>
      </span>
    </div>`;
  return `
    <div class="health-card ${ready ? 'all-ok' : ''}">
      <div class="h-title">${ready ? '✅ 一切就绪，机器人运行中' : '🧭 完成下面缺失项就能跑起来'}</div>
      ${rows}
      ${testRow}
    </div>`;
}

// 人设模板数据：state.personaTemplates（由 loadSettings 从后端填充）


  // ── 话题卡（「记忆 → 本会话」子页签内）────────────────────────────────
  // 话题卡只属于某个会话（chatKey），落盘在 data/memory-cards/<chatKey>/topic_*.json。
  // 注入侧读 title / body / summary / keywords[]（见 src/memory-cards-prompt.js:122-143）。
  // 控件一律 data-topic + document 级委托（控制台 CSP 禁内联 onclick）；
  // 委托选择器登记在 test/coverage-wiring.mjs 的 DELEGATED_SELECTOR。
  const memTopicState = window.__memTopicState || (window.__memTopicState = {
    chatKey: '', loaded: false, loading: false, error: '', cards: [], editing: ''
  });

  async function memTopicFetch(chatKey) {
    let cards = [];
    let error = '';
    try {
      const r = await api('/api/memory-cards/topics?chatKey=' + encodeURIComponent(chatKey));
      cards = Array.isArray(r && r.topics) ? r.topics : [];
    } catch (e) {
      error = String((e && e.message) || e);
    }
    // 期间用户切了会话：丢弃这次结果，别把别的会话的话题卡画到当前会话下
    if (memTopicState.chatKey !== chatKey) return;
    memTopicState.cards = cards;
    memTopicState.error = error;
    memTopicState.loaded = !error;
    memTopicState.loading = false;
  }

  /** 进入「本会话」时确保已拉过该会话的话题卡；未加载 → 拉完再渲染一次 */
  function memTopicEnsure(chatKey) {
    if (!chatKey) return;
    if (memTopicState.chatKey !== chatKey) {
      memTopicState.chatKey = chatKey;
      memTopicState.loaded = false;
      memTopicState.loading = false;
      memTopicState.error = '';
      memTopicState.cards = [];
      memTopicState.editing = '';
    }
    if (memTopicState.loaded || memTopicState.loading) return;
    memTopicState.loading = true;
    memTopicFetch(chatKey).then(() => { if (state.tab === 'memory') loadMemoryView(); });
  }

  /** 重新拉当前会话的话题卡并重绘（保存/删除后调用） */
  async function memTopicReload() {
    const chatKey = memTopicState.chatKey;
    if (!chatKey) return;
    memTopicState.loading = true;
    await memTopicFetch(chatKey);
    if (state.tab === 'memory') await loadMemoryView();
  }

  function memTopicChipsHtml(keywords) {
    const kws = (Array.isArray(keywords) ? keywords : []).filter(Boolean).slice(0, 12);
    if (!kws.length) return '<span class="muted" style="font-size:11px">（没有关键词：只会出现在标题索引里）</span>';
    return kws.map((k) => '<span class="mem-topic-kw" style="display:inline-block;padding:1px 7px;margin:2px 4px 2px 0;border-radius:99px;border:1px solid var(--line);font-size:11px">' + esc(k) + '</span>').join('');
  }

  function memTopicEditorHtml(card) {
    const isNew = !card;
    return '<div class="mem-topic-editor" style="margin-top:8px;padding:10px;border:1px dashed var(--line);border-radius:6px">' +
      '<div class="field"><label>标题</label><input type="text" id="memt-title" value="' + esc(card ? card.title || '' : '') + '" placeholder="如：周末爬山计划" /></div>' +
      '<div class="field"><label>摘要（一句话；随机闪回时注入）</label><input type="text" id="memt-summary" value="' + esc(card ? card.summary || '' : '') + '" /></div>' +
      '<div class="field"><label>关键词（逗号或空格分隔；命中就把正文注入提示词）</label><input type="text" id="memt-keywords" value="' + esc(card && Array.isArray(card.keywords) ? card.keywords.join('，') : '') + '" /></div>' +
      '<div class="field"><label>正文</label><textarea id="memt-body" style="min-height:96px">' + esc(card ? card.body || '' : '') + '</textarea></div>' +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
        '<button class="btn btn-small btn-primary" data-topic="save" data-id="' + esc(isNew ? '' : String(card.id || '')) + '">保存</button>' +
        '<button class="btn btn-small" data-topic="cancel">取消</button>' +
        '<span class="hint" id="memt-hint"></span>' +
      '</div></div>';
  }

  function memTopicCardHtml(t) {
    const id = String(t.id || '');
    const editing = memTopicState.editing === id;
    const summary = String(t.summary || '').trim();
    const body = String(t.body || '').trim();
    const bodyPreview = body && body !== summary
      ? '<div class="mem-topic-body muted" style="font-size:12px;margin-top:2px">' + esc(body.slice(0, 160)) + (body.length > 160 ? '…' : '') + '</div>'
      : '';
    const when = t.updatedAt ? '<span class="muted" style="font-size:11px">更新于 ' + esc(fmtTime(Date.parse(t.updatedAt) || 0)) + '</span>' : '';
    return '<div class="mem-topic-card' + (editing ? ' editing' : '') + '" data-topic-id="' + esc(id) + '" style="padding:8px 0;border-bottom:1px solid var(--line)">' +
      '<div style="display:flex;gap:8px;align-items:flex-start">' +
        '<div style="flex:1;min-width:0">' +
          '<div class="mem-topic-title" style="font-weight:600">' + esc(t.title || '未命名话题') + '</div>' +
          (summary ? '<div class="mem-topic-summary muted" style="font-size:12px;margin-top:2px">' + esc(summary) + '</div>' : '') +
          bodyPreview +
          '<div class="mem-topic-kws" style="margin-top:4px">' + memTopicChipsHtml(t.keywords) + '</div>' +
        '</div>' +
        '<div class="mem-topic-actions" style="display:flex;gap:6px;flex-shrink:0">' +
          '<button class="btn btn-small" data-topic="edit" data-id="' + esc(id) + '">编辑</button>' +
          '<button class="btn btn-small btn-danger" data-topic="del" data-id="' + esc(id) + '">删除</button>' +
        '</div>' +
      '</div>' +
      '<div style="margin-top:2px">' + when + '</div>' +
      (editing ? memTopicEditorHtml(t) : '') +
    '</div>';
  }

  function memTopicSectionHtml(chatKey) {
    const st = memTopicState;
    const cards = st.cards || [];
    const head = '<div class="mem-topics-head" style="display:flex;align-items:center;gap:8px;margin-bottom:2px">' +
        '<span class="mem-topics-title" style="font-weight:600">话题卡</span>' +
        '<span class="mem-count muted" style="font-size:12px">' + cards.length + '</span>' +
        '<span style="flex:1"></span>' +
        '<button class="btn btn-small" data-topic="new">＋ 新建话题</button>' +
      '</div>' +
      '<div class="hint" style="font-size:12px;margin:4px 0 6px">关键词命中时整段注入提示词；未命中只出现在标题索引里。</div>';
    let inner;
    if (st.loading && !st.loaded) {
      inner = '<div class="muted" style="padding:8px">话题卡加载中…</div>';
    } else if (st.error) {
      inner = '<div class="muted" style="padding:8px">加载失败：' + esc(st.error) +
        ' <button class="btn btn-small" data-topic="reload">重试</button></div>';
    } else {
      const editingNew = st.editing === '__new__';
      const list = cards.map(memTopicCardHtml).join('');
      inner = (editingNew ? memTopicEditorHtml(null) : '') +
        (list ? '<div class="mem-topic-list">' + list + '</div>'
          : (editingNew ? '' : '<div class="muted" style="padding:8px">还没有话题卡。点「＋ 新建话题」记一条。</div>'));
    }
    return '<div class="mem-topics" data-topic-chat="' + esc(chatKey) + '" style="margin-top:18px;padding-top:12px;border-top:1px solid var(--line)">' +
      head + inner + '</div>';
  }

  /** 「编辑 / 新建 / 保存 / 删除 / 取消 / 重试」统一走 document 级委托 */
  if (!window.__memTopicsDelegated) {
    window.__memTopicsDelegated = true;
    document.addEventListener('click', (e) => {
      if (state.tab !== 'memory') return;
      const el = e.target.closest('#view-memory [data-topic]');
      if (!el) return;
      e.preventDefault();
      const act = el.dataset.topic;
      const chatKey = memTopicState.chatKey;
      if (act === 'new') {
        memTopicState.editing = '__new__';
        loadMemoryView();
        return;
      }
      if (act === 'cancel') {
        memTopicState.editing = '';
        loadMemoryView();
        return;
      }
      if (act === 'reload') {
        memTopicReload();
        return;
      }
      const id = String(el.dataset.id || '');
      if (act === 'edit') {
        memTopicState.editing = id;
        loadMemoryView();
        return;
      }
      if (!chatKey) return;
      // 编辑框是"批量读取式"：点保存时一次性把四个输入框读走
      const val = (domId) => {
        const box = document.getElementById(domId);
        return box ? String(box.value == null ? '' : box.value) : '';
      };
      if (act === 'save') {
        (async () => {
          if (!document.getElementById('memt-title')) return;   // 编辑器不在当前 DOM
          const payload = {
            chatKey,
            title: val('memt-title'),
            summary: val('memt-summary'),
            keywords: val('memt-keywords').split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean),
            body: val('memt-body')
          };
          if (!payload.title.trim()) { alert('话题卡标题不能为空'); return; }
          try {
            if (id) await api('/api/memory-cards/topics/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify(payload) });
            else await api('/api/memory-cards/topics', { method: 'POST', body: JSON.stringify(payload) });
            memTopicState.editing = '';
            await memTopicReload();
          } catch (err) {
            const hint = document.getElementById('memt-hint');
            if (hint) { hint.textContent = '保存失败：' + ((err && err.message) || err); hint.style.color = 'var(--red)'; }
            else alert('保存话题卡失败：' + ((err && err.message) || err));
          }
        })();
        return;
      }
      if (act === 'del') {
        (async () => {
          const card = (memTopicState.cards || []).find((t) => String(t.id) === id);
          if (!(await uiConfirm('删除话题卡「' + ((card && card.title) || id) + '」？\n会重命名为 .deleted 备份，可手工恢复。'))) return;
          try {
            await api('/api/memory-cards/topics/' + encodeURIComponent(id) + '?chatKey=' + encodeURIComponent(chatKey), { method: 'DELETE' });
            if (memTopicState.editing === id) memTopicState.editing = '';
            await memTopicReload();
          } catch (err) { alert('删除话题卡失败：' + ((err && err.message) || err)); }
        })();
        return;
      }
    });
  }


  // 记忆页右栏的子页签。`compress` 是「记忆压缩」：不依赖选中会话，
  // 读的是整份记忆 bundle（见文件末尾「记忆压缩」段）。
  const MEM_SUBTABS = [
    { id: 'groups', label: '本会话' },
    { id: 'persons', label: '个人卡' },
    { id: 'general', label: '基本事实' },
    { id: 'compress', label: '压缩' }
  ];

  // 2026-10 改版：这些子页签渲染到顶部二级菜单条里（#subnav）。
  // 「压缩」与前三个不是一类东西（它是整份记忆的离线处理，不看选中会话），
  // 所以中间插一条分隔线、并给它实心胶囊样式（见 style.css 的 .subnav 规则）。
  let memActiveSub = 'groups';
  window.__memRenderSubnav = function (box) {
    if (!box) return;
    const pill = (t) => '<button class="mem-subtab' + (memActiveSub === t.id ? ' act' : '') +
      '" data-mem="subtab" data-sub="' + t.id + '">' + t.label + '</button>';
    const cards = MEM_SUBTABS.filter((t) => t.id !== 'compress');
    const compress = MEM_SUBTABS.find((t) => t.id === 'compress');
    box.innerHTML = cards.map(pill).join('') +
      '<span class="subnav-sep"></span>' +
      (compress ? pill(compress) : '') +
    '<button class="mem-subtab' + (memActiveSub === 'batch' ? ' act' : '') + '" data-mem="subtab" data-sub="batch">记忆整理</button>' +
    '<span class="subnav-note" title="' + esc(typeof consumptionTip === 'function' ? consumptionTip('memory-compress') : '') + '">压缩只改注入内容，不动原始记忆</span>';
  };

  // 【记忆栏目 V2】顶部「记忆」tab 的三分区卡片视图（覆盖上面的旧 loadMemoryView）
  async function loadMemoryView() {
    const itemsBox = document.getElementById('memory-items');
    const detailBox = document.getElementById('memory-detail');
    if (!itemsBox || !detailBox) return;
    const st = (typeof memState === 'function') ? memState() : null;
    if (!st) return;
    if (!st.sub) st.sub = 'groups';
    // 首次加载列表
    if (!st.list) {
      itemsBox.innerHTML = '<div class="mem-side"><div class="mem-side-head">加载记忆卡…</div></div>';
      try {
        st.list = await api('/api/memory-cards');
        try { st.generals = (await api('/api/memory-cards/generals')).generals || []; } catch (e) { st.generals = []; }
      } catch (e) {
        itemsBox.innerHTML = '<div class="mem-side"><div class="mem-side-head">加载失败：' + esc(String(e?.message || e)) + '</div></div>';
        return;
      }
      const groups0 = st.list.groups || [];
      if (groups0[0]) {
        st.chatSel = { chatKey: groups0[0].chatKey, name: groups0[0].name || groups0[0].chatKey, kind: groups0[0].kind || '' };
        st.sel = { tab: 'groups', chatKey: st.chatSel.chatKey, name: st.chatSel.name };
        st.tab = 'groups';
        await memLoadDetail();
      }
    }
    const groups = st.list.groups || [];
    if (!st.chatSel && groups[0]) {
      st.chatSel = { chatKey: groups[0].chatKey, name: groups[0].name || groups[0].chatKey, kind: groups[0].kind || '' };
    }
    const q = String(st.q || '').trim().toLowerCase();
    const hit = (s) => !q || String(s || '').toLowerCase().includes(q);

    // ── 侧栏：只列 群聊 / 私聊 卡片 ──
    // 个人卡子页签：左侧列个人卡（而不是会话）
    const isPersons = st.tab === 'persons';
    const personsAll = (st.list.persons || []).filter((x) => hit(x.name || '') || hit(x.qq) || hit(x.summary || ''));
    const personCards = personsAll.map((x) => {
      const sel = st.sel && st.sel.tab === 'persons' && String(st.sel.qq) === String(x.qq);
      const payload = JSON.stringify({ tab: 'persons', qq: x.qq });
      const sub = 'QQ ' + String(x.qq || '') + (x.summary ? ' · ' + String(x.summary).slice(0, 20) : '');
      return '<div class="mem-card' + (sel ? ' sel' : '') + '" data-mem="sel" data-json=\'' + esc(payload) + '\'>' +
        '<div class="mem-card-title">' + esc(x.name || ('QQ' + x.qq)) + '</div>' +
        '<div class="mem-card-sub">' + esc(sub) + '</div></div>';
    }).join('') || '<div class="mem-empty">（没有匹配的个人卡）</div>';
    const chatCards = groups
      .filter((g) => hit(g.name || g.chatKey) || hit(g.chatKey))
      .map((g) => {
        const sel = st.chatSel && st.chatSel.chatKey === g.chatKey;
        const kind = g.kind || (String(g.chatKey || '').startsWith('private') ? 'private' : 'group');
        const nMember = Array.isArray(g.members) ? g.members.length : (g.memberCount || 0);
        const sub = (kind === 'private' ? '私聊' : '群') + ' · ' + nMember + ' 人 · ' + (g.msgs || 0) + ' 条';
        const payload = JSON.stringify({ chatKey: g.chatKey, name: g.name || g.chatKey, kind });
        return '<div class="mem-card' + (sel ? ' sel' : '') + '" data-mem="chat" data-json=\'' + esc(payload) + '\'>' +
          '<div class="mem-card-title">' + esc(g.name || g.chatKey) + '</div>' +
          '<div class="mem-card-sub">' + esc(sub) + '</div></div>';
      }).join('') || '<div class="mem-empty">（没有匹配的会话）</div>';

    itemsBox.innerHTML =
      '<div class="mem-side">' +
        '<div class="mem-side-head"><span>' + (isPersons ? '个人卡' : '群聊 / 私聊') + '</span><span class="mem-count">' +
          (isPersons ? personsAll.length : groups.length) + '</span></div>' +
        '<input type="text" data-mem="search" id="memv-q" class="mem-search" placeholder="' +
          (isPersons ? '搜索昵称 / QQ 号…' : '搜索会话名…') + '" value="' + esc(st.q || '') + '" />' +
        '<div class="mem-cards">' + (isPersons ? personCards : chatCards) + '</div>' +
      '</div>';

    // ── 右栏：子页签 + 内容（点进会话后才显示） ──
    // 子页签清单在 MEM_SUBTABS（顶部），压缩是它的最后一项。
    // 「压缩」用 st.sub 记，不动 st.tab：st.tab 是 06 段「设置→记忆」分区共用的
    // 选中态，写成 compress 会让那个分区找不到自己的 tab。
    let activeSub = 'groups';
    if (st.tab === 'persons') activeSub = 'persons';
    else if (st.tab === 'general') activeSub = 'general';
    if (st.sub === 'compress') activeSub = 'compress';
  else if (st.sub === 'batch') activeSub = 'batch';

    let body = '';
    if (activeSub === 'compress') {
      // 压缩面板自己管渲染与轮询（全部 data-* + 文档级委托），这里只给挂载点
      body = memStudioPanelHtml();
    } else if (activeSub === 'batch') {
      body = memBatchPanelHtml();
    } else if (activeSub === 'groups') {
      body = (typeof memDetailHtml === 'function') ? memDetailHtml() : '<div class="muted" style="padding:20px">从左侧选一个会话</div>';
      // 话题卡只属于具体会话：挂在「本会话」页签下半区。
      // 首次进入时先异步拉取，数据回来后会再渲染一次（memTopicEnsure 内部处理）。
      const topicChatKey = st.chatSel && st.chatSel.chatKey;
      if (topicChatKey) {
        memTopicEnsure(topicChatKey);
        body += memTopicSectionHtml(topicChatKey);
      }
    } else if (activeSub === 'persons') {
      // 个人卡：左侧是卡列表，右侧只显示选中的那张卡
      const selQq = st.sel && st.sel.tab === 'persons' ? String(st.sel.qq || '') : '';
      if (!selQq) {
        body = '<div class="muted" style="padding:20px">← 从左侧选择一张个人卡</div>';
      } else if (st.detail && String(st.detail.qq || '') === selQq) {
        body = memDetailHtml();
      } else {
        memLoadDetail();
        body = '<div class="muted" style="padding:20px">加载中…</div>';
      }
    } else {
      const gens = (st.generals && st.generals.length) ? st.generals : (st.list.general ? [st.list.general] : []);
      if (!st.genId && gens[0]) st.genId = gens[0].id;
      const cards = gens.map((g) => {
        const sel = st.genId === g.id;
        const sub = (g.scope === 'global' ? '★ 全局默认 · ' : '') + String(g.summary || '').slice(0, 30);
        return '<div class="mem-card' + (sel ? ' sel' : '') + '" data-mem="gen-pick" data-gid="' + esc(g.id) + '">' +
          '<div class="mem-card-title">' + esc(g.name || g.id) + '</div>' +
          '<div class="mem-card-sub">' + esc(sub) + '</div></div>';
      }).join('') || '<div class="mem-empty">（还没有通用卡）</div>';
      body = '<div class="mem-grid">' + cards + '</div>' +
        '<div class="mem-detail-sub">' + (typeof memGeneralDetailHtml === 'function' ? memGeneralDetailHtml() : '') + '</div>';
    }

    detailBox.innerHTML = '<div class="mem-main">' +
      '<div class="mem-sub-body">' + body + '</div>' +
    '</div>';
    // 2026-10 改版：子页签挪到顶部二级菜单条（#subnav），这里只负责同步它与内容
    // ⚠️ 只有当前页就是「记忆」时才写 #subnav —— 启动时后台会预渲染一次记忆页，
    //    不加这个判断会把记忆的子页签画到会话页顶上（实测踩过）。
    memActiveSub = activeSub;
    if (state.tab === 'memory' && typeof window.__memRenderSubnav === 'function') {
      window.__memRenderSubnav(document.getElementById('subnav'));
    }
    if (typeof bindMemoryTabEvents === 'function') bindMemoryTabEvents();
    if (activeSub === 'compress') memStudioMount();
  if (activeSub === 'batch') memBatchMount();
  }


  // 记忆 tab 的事件（因为 #memory-items 每次重建，绑在容器上做一次委托就够）
  if (!window.__memTabDelegated) {
    window.__memTabDelegated = true;
    document.addEventListener('click', (e) => {
      if (state.tab !== 'memory') return;
      const el = e.target.closest('#view-memory [data-mem], #subnav [data-mem]');
      if (!el) return;
      e.preventDefault();
      const st = (typeof memState === 'function') ? memState() : null;
      if (!st) return;
      const act = el.dataset.mem;
      if (act === 'chat') {
        try { st.chatSel = JSON.parse(el.dataset.json); } catch { return; }
        st.sub = 'groups';
        st.tab = 'groups';
        st.sel = { tab: 'groups', chatKey: st.chatSel.chatKey, name: st.chatSel.name };
        st.detail = null;
        memLoadDetail().then(async () => { if (state.tab === 'memory') await loadMemoryView(); });
        return;
      }
      if (act === 'subtab') {
        const sub = el.dataset.sub;
        st.sub = sub;
        // 「压缩」不需要先选会话：直接渲染压缩面板（不进 memLoadDetail，
        // 它只认群/个人/通用三种卡，传 compress 会去拉通用卡）
        if (sub === 'compress') {
          st.detail = null;
          loadMemoryView();
          return;
        }
        if (sub === 'groups') {
          st.tab = 'groups';
          st.sel = st.chatSel ? { tab: 'groups', chatKey: st.chatSel.chatKey, name: st.chatSel.name } : null;
        } else if (sub === 'persons') {
          st.tab = 'persons';
          const keep = st.sel && st.sel.tab === 'persons' ? st.sel : null;
          const first = (st.list && (st.list.persons || [])[0]) || null;
          st.sel = keep || (first ? { tab: 'persons', qq: first.qq } : null);
        } else {
          st.tab = 'general';
          st.sel = { tab: 'general' };
        }
        st.detail = null;
        memLoadDetail().then(async () => { if (state.tab === 'memory') await loadMemoryView(); });
        return;
      }
      if (act === 'gen-pick') { st.genId = el.dataset.gid; loadMemoryView(); return; }
      if (act === 'tab') {
        st.tab = el.dataset.tab; st.sel = null; st.detail = null; st.q = '';
        loadMemoryView();
        return;
      }
      if (act === 'sel') {
        try { st.sel = JSON.parse(el.dataset.json); } catch { return; }
        if (st.sel && st.sel.tab) st.tab = st.sel.tab;
        st.detail = null;
        memLoadDetail().then(async () => { if (state.tab === 'memory') await loadMemoryView(); });
        return;
      }
      if (act === 'gen-save') {
        (async () => {
          const gid = el.dataset.gid;
          const name = document.getElementById('memg-name')?.value || '';
          const summary = document.getElementById('memg-summary')?.value || '';
          const facts = String(document.getElementById('memg-facts')?.value || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).map((line) => {
            const i = line.indexOf('=');
            return i > 0 ? { key: line.slice(0, i).trim(), value: line.slice(i + 1).trim() } : { key: line, value: '' };
          });
          try {
            await api('/api/memory-cards/generals/' + encodeURIComponent(gid), { method: 'PUT', body: JSON.stringify({ name, summary, facts }) });
            // 挂靠：逐个改人设的 generalCardId
            const hooks = [...document.querySelectorAll('.memg-hook')];
            for (const cb of hooks) {
              const pid = cb.dataset.pid;
              await api('/api/personas/' + encodeURIComponent(pid), { method: 'PUT', body: JSON.stringify({ generalCardId: cb.checked ? gid : '' }) });
            }
            const hint = document.getElementById('memg-hint');
            if (hint) { hint.textContent = '已保存 ✅'; hint.style.color = 'var(--green)'; }
            st.generals = (await api('/api/memory-cards/generals')).generals || [];
            st.list = null;
            loadMemoryView();
          } catch (e) {
            const hint = document.getElementById('memg-hint');
            if (hint) { hint.textContent = '保存失败：' + (e?.message || e); hint.style.color = 'var(--red)'; }
          }
        })();
        return;
      }
      if (act === 'gen-new') {
        (async () => {
          try {
            const r = await api('/api/memory-cards/generals', { method: 'POST', body: JSON.stringify({ name: '新通用卡', summary: '', facts: [] }) });
            st.generals = (await api('/api/memory-cards/generals')).generals || [];
            st.genId = r.card?.id || st.genId;
            loadMemoryView();
          } catch (e) { alert('新建失败：' + (e?.message || e)); }
        })();
        return;
      }
      if (act === 'gen-global') {
        (async () => {
          try {
            await api('/api/memory-cards/generals/' + encodeURIComponent(el.dataset.gid), { method: 'PUT', body: JSON.stringify({ scope: 'global' }) });
            st.generals = (await api('/api/memory-cards/generals')).generals || [];
            st.list = null;
            loadMemoryView();
          } catch (e) { alert('设置失败：' + (e?.message || e)); }
        })();
        return;
      }
      if (act === 'gen-del') {
        (async () => {
          if (!(await uiConfirm('删除这张通用卡？挂靠它的人设会回到全局默认。'))) return;
          try {
            await api('/api/memory-cards/generals/' + encodeURIComponent(el.dataset.gid), { method: 'DELETE' });
            st.generals = (await api('/api/memory-cards/generals')).generals || [];
            st.genId = null;
            loadMemoryView();
          } catch (e) { alert('删除失败：' + (e?.message || e)); }
        })();
        return;
      }
      if (act === 'save') { memSave(el.dataset.key, st); return; }
      if (act === 'del') {
        (async () => {
          if (!(await uiConfirm('删除该记忆卡？'))) return;
          try {
            await api('/api/memory-cards/person/' + encodeURIComponent(el.dataset.qq), { method: 'DELETE' });
            st.sel = null; st.detail = null; st.list = null;
            loadMemoryView();
          } catch (err) { alert('删除失败：' + (err?.message || err)); }
        })();
        return;
      }
    });
    document.addEventListener('input', (e) => {
      if (state.tab !== 'memory') return;
      const el = e.target.closest('#view-memory #memv-q');
      if (!el) return;
      const st = (typeof memState === 'function') ? memState() : null;
      if (!st) return;
      st.q = el.value;
      clearTimeout(window.__memTabQT);
      window.__memTabQT = setTimeout(() => { if (state.tab === 'memory') loadMemoryView(); }, 250);
    });
  }


  // 通用卡详情（多卡 + 挂靠人设）
  function memGeneralDetailHtml() {
    const st = (typeof memState === 'function') ? memState() : null;
    if (!st) return '<div class="muted">（无）</div>';
    const gens = (st.generals && st.generals.length) ? st.generals : [];
    if (!gens.length) return '<div class="muted" style="padding:16px">还没有通用卡 <button class="btn btn-small" data-mem="gen-new">＋ 新建</button></div>';
    const g = gens.find((x) => x.id === st.genId) || gens[0];
    st.genId = g.id;
    const facts = (g.facts || []).map((f) => memFactLine(f)).join('\n');
    // 挂靠：哪些人设卡用了这张通用卡
    const personas = (st.list && st.list.personas) ? st.list.personas : [];
    const allPersonas = (state.config && state.config.personas) ? state.config.personas : [];
    const hooked = allPersonas.filter((p) => p.generalCardId === g.id);
    const hookList = allPersonas.filter((p) => !p.builtin).map((p) => `<label style="display:block;font-size:13px"><input type="checkbox" class="memg-hook" data-pid="${esc(p.id)}" ${p.generalCardId === g.id ? 'checked' : ''}/> ${esc(p.name)}</label>`).join('') || '<div class="muted" style="font-size:12px">（没有人设卡）</div>';
    return `
      <div class="hint">${g.scope === 'global' ? '★ 这是<b>全局默认</b>：没挂靠的人设都用它' : '普通通用卡（把另一张设为全局可替换默认）'}</div>
      <div class="field"><label>名称</label><input type="text" id="memg-name" value="${esc(g.name || '')}" /></div>
      <div class="field"><label>一句话概览</label><input type="text" id="memg-summary" value="${esc(g.summary || '')}" /></div>
      <div class="field"><label>事实（一行一条，key=value）</label><textarea id="memg-facts" style="min-height:100px">${facts}</textarea></div>
      <div class="field"><label>挂靠的人设卡（勾选后该人设的会话就用这张通用卡）</label><div style="max-height:160px;overflow:auto">${hookList}</div></div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap">
        <button class="btn btn-small btn-primary" data-mem="gen-save" data-gid="${esc(g.id)}">保存</button>
        <button class="btn btn-small" data-mem="gen-global" data-gid="${esc(g.id)}">设为全局默认</button>
        <button class="btn btn-small" data-mem="gen-new">＋ 新建通用卡</button>
        ${g.scope === 'global' ? '' : '<button class="btn btn-small btn-danger" data-mem="gen-del" data-gid="' + esc(g.id) + '">删除</button>'}
        <span class="hint" id="memg-hint"></span>
      </div>`;
  }

  // ════════════════════════════════════════════════════════════════════════
  // 记忆「压缩」子页签（本地记忆解释器 qq-memory-studio）
  //
  // 为什么要有这一页：记忆包要靠外部解释器压缩，以前只能开解释器的网页版手动
  // 上传/下载 .qqmem.json，再切回「记忆导出 / 记忆导入」导回去 —— 三步、两个
  // 页面。这里把它做进控制台：载入 → 压缩（带进度）→ 导回（带二次确认），
  // 全程不离开本页面。
  //
  // 后端契约（已冻结，见 task-4；src/ 由 backend 负责，前端不碰）：
  //   GET  /api/memory-studio/status → {ok,found,dir,running,port,url,version}
  //   POST /api/memory-studio/start  → {ok,running,port,url,error?}（幂等，可能几秒）
  //   POST /api/memory-studio/stop   → {ok,stopped}
  //   POST /api/memory-studio/call   {path,method?,body?} → {ok,status,data}
  //   GET  /api/memory-bundle/json   → {ok,bundle,counts,stats}
  //   POST /api/memory-bundle/import {bundle,mode,sections?} → {ok,written,skipped,mode}
  //   解释器侧：POST /api/compress/start {bundle,options} → {ok,jobId}
  //             GET  /api/job/:id → {ok,status,progress,result?,error?}
  //
  // 接线约定（控制台 CSP 禁内联 onclick）：
  //   所有控件只有三种 data 属性 —— data-studio（点击动作）/
  //   data-studio-opt（change：单选、复选）/ data-studio-input（input：文本框、
  //   数字、搜索、文件）。三个选择器都登记在 test/coverage-wiring.mjs 的
  //   DELEGATED_SELECTOR 里，否则接线测试会判"可见但没接线"。
  // ════════════════════════════════════════════════════════════════════════

  /** 记忆解释器（qq-memory-studio）仓库地址：找不到解释器时给用户指路 */
  const MEM_STUDIO_REPO = 'https://github.com/A-common-Chinese/qq-memory-studio';
  /** 解释器应放的相对位置（相对 QQ Agent 安装目录） */
  const MEM_STUDIO_INSTALL_HINT = '<安装目录>\\tools\\memory-studio';
  const MEM_STUDIO_SECTION_LABEL = { generals: '通用', groups: '群聊', persons: '个人', topics: '话题' };
  const MEM_STUDIO_MODE_LABEL = { merge: '合并卡片', both: '合并 + 压文字', text: '只压文字' };
  const MEM_STUDIO_COLD_LABEL = { oneline: '一句话背景', drop: '完全忘掉' };
  const MEM_STUDIO_KEEP_FIELDS = [
    ['facts', '事实'], ['impressions', '印象'], ['events', '重要事件'],
    ['prefs', '偏好'], ['aliases', '别名'], ['body', '正文']
  ];

  // 压缩页的全部状态都放这里（不依赖 DOM）：切页签 / 面板重渲染后进度与结果还在。
  // 放在 window 上是为了与同文件的话题卡状态（__memTopicState）一致，也方便测试读取。
  const memStudioState = window.__memStudioState || (window.__memStudioState = {
    status: null,          // 解释器状态（/api/memory-studio/status 原样）
    statusError: '',       // 检测/启停失败原文（必须显示，不许静默）
    statusBusy: '',        // '' | 'detect' | 'start' | 'stop'
    statusAt: 0,           // 上次检测时间（挂载时判断要不要自动重检）
    update: null,          // 解释器更新检查结果（/api/memory-studio/update-check 原样）
    updateBusy: '',        // '' | 'check' | 'install'
    updateError: '',       // 检查/下载失败原文
    updateAt: 0,
    source: null,          // { kind:'live'|'file', name, counts, stats, at }
    bundle: null,          // 载入的完整记忆包（解释器只认它）
    loadBusy: false,
    loadError: '',
    options: {
      mode: 'both',
      targetMode: 'ratio', // ratio | kb | free（不指定）
      ratio: 40,
      targetKB: 60,
      coldMode: 'oneline',
      longTermOnly: true,
      extractFromTopics: false,
      keepTopShare: 0.45,
      keep: { facts: true, impressions: true, events: true, prefs: true, aliases: true, body: false },
      activeParams: { topN: '', minMsgs: '', recentDays: '', minMemScore: '' },
      mustKeep: []
    },
    mustKeepQuery: '',
    job: { id: '', status: '', progress: null, error: '', startedAt: 0, pct: 0, pollTimer: null, pollFails: 0, tick: null },
    result: null,          // { bundle, stats, warnings, at }
    importOpen: false,     // 「导回」二次确认面板是否展开
    importMode: 'merge',   // merge | replace
    importBusy: false,
    importError: '',
    importDone: null,      // { written, skipped, mode, filteredOut }
    downloadOk: '',
    downloadError: ''
  });

  // ── 小工具 ──────────────────────────────────────────────────────────────
  function memStudioNum(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function memStudioFmt(v) {
    const n = memStudioNum(v);
    return n === null ? '-' : n.toLocaleString('zh-CN');
  }
  function memStudioDelta(before, after) {
    const b = memStudioNum(before), a = memStudioNum(after);
    if (b === null || a === null || !b) return '';
    const d = Math.round(((a - b) / b) * 100);
    return d === 0 ? '持平' : (d > 0 ? '+' : '') + d + '%';
  }
  function memStudioElapsedSec() {
    const st = memStudioState;
    if (!st.job || !st.job.startedAt) return 0;
    return Math.max(0, Math.round((Date.now() - st.job.startedAt) / 1000));
  }
  /** 解释器进度对象 → 百分比估算（合并/提炼/压文字三段的进度不是一个分母） */
  function memStudioEstimatePct(p) {
    if (typeof p === 'number' && Number.isFinite(p)) return p <= 1 ? p * 100 : p;
    if (!p || typeof p !== 'object') return null;
    const index = Number(p.index) || 0;
    const total = Math.max(1, Number(p.total) || 1);
    const frac = Math.min(1, index / total);
    const phase = String(p.phase || '');
    if (phase === 'batch') return 55 + frac * 40;      // 压文字：55% → 95%
    if (phase === 'topics') return 45 + frac * 8;      // 提炼话题：45% → 53%
    return 6 + frac * 38;                              // 合并卡片：6% → 44%
  }
  /** 进度文案：阶段 + 第几批 + 卡数/字数 + 已用时（解释器只给结构体，文案在前端拼） */
  function memStudioStageText(p, sec) {
    if (!p || typeof p !== 'object') return '任务已提交，等待解释器返回第一批进度…（已 ' + sec + 's）';
    const phase = String(p.phase || '');
    const label = phase === 'batch' ? '压缩文字' : phase === 'topics' ? '提炼话题要点' : phase === 'merge' ? '合并卡片' : '处理中';
    let text = label;
    if (Number(p.total)) text += '（第 ' + (Number(p.index) || 0) + '/' + Number(p.total) + ' 批）';
    if (Number(p.cards)) text += ' · ' + Number(p.cards) + ' 张卡';
    if (Number(p.chars)) text += ' · ' + Number(p.chars) + ' 字';
    return text + '（已 ' + sec + 's）';
  }
  function memStudioCountsText(counts) {
    const c = counts || {};
    return '通用 ' + memStudioFmt(c.generals) + ' · 群聊 ' + memStudioFmt(c.groups) +
      ' · 个人 ' + memStudioFmt(c.persons) + ' · 话题 ' + memStudioFmt(c.topics);
  }

  // ── 渲染：整块面板 ──────────────────────────────────────────────────────
  function memStudioBlocksHtml() {
    return '<div id="memstudio-status">' + memStudioStatusInnerHtml() + '</div>' +
      '<div id="memstudio-source">' + memStudioSourceInnerHtml() + '</div>' +
      '<div id="memstudio-options">' + memStudioOptionsInnerHtml() + '</div>' +
      '<div id="memstudio-progress">' + memStudioProgressInnerHtml() + '</div>' +
      '<div id="memstudio-result">' + memStudioResultInnerHtml() + '</div>';
  }
  function memStudioPanelHtml() {
    return '<div id="memstudio-panel" class="mem-studio" style="padding:2px 0">' +
      '<div class="hint" style="margin:0 0 10px">在控制台里直接完成：把现有记忆（或一个 .qqmem.json）交给本地「记忆解释器」压缩，再把结果导回 QQ Agent。全程不离开本页面。</div>' +
      memStudioBlocksHtml() +
    '</div>';
  }
  function memStudioRenderStatus() { const el = $('#memstudio-status'); if (el) el.innerHTML = memStudioStatusInnerHtml(); }
  function memStudioRenderSource() { const el = $('#memstudio-source'); if (el) el.innerHTML = memStudioSourceInnerHtml(); }
  function memStudioRenderOptions() { const el = $('#memstudio-options'); if (el) el.innerHTML = memStudioOptionsInnerHtml(); }
  function memStudioRenderProgress() { const el = $('#memstudio-progress'); if (el) el.innerHTML = memStudioProgressInnerHtml(); }
  function memStudioRenderResult() { const el = $('#memstudio-result'); if (el) el.innerHTML = memStudioResultInnerHtml(); }
  function memStudioRenderMustKeep() {
    const el = $('#memstudio-mustkeep-list');
    if (el) el.innerHTML = memStudioMustKeepListHtml();
    const cnt = $('#memstudio-mustkeep-count');
    if (cnt) cnt.textContent = '已选 ' + (memStudioState.options.mustKeep || []).length + ' 张';
  }
  function memStudioRenderAll() {
    const panel = $('#memstudio-panel');
    if (!panel) return;
    panel.innerHTML = memStudioBlocksHtml();
    memStudioRenderMustKeep();
  }

  const MEM_STUDIO_BLOCK_STYLE = 'border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin-bottom:10px';
  const MEM_STUDIO_TITLE_STYLE = 'font-weight:600;font-size:13px;margin-bottom:6px';

  // ── 状态条 ──────────────────────────────────────────────────────────────
  function memStudioStatusInnerHtml() {
    const st = memStudioState;
    const s = st.status;
    const busy = !!st.statusBusy;
    const dis = busy ? ' disabled' : '';
    let inner = '';
    if (!s && !st.statusError) {
      inner = '<span class="muted">正在检测记忆解释器…</span>';
    } else if (!s) {
      inner = '<div class="mem-studio-err" style="color:var(--red);font-size:12px;line-height:1.6">检测失败：' + esc(st.statusError) + '</div>' +
        '<div class="hint">如果这个控制台版本里没有 <code>/api/memory-studio/status</code> 接口，说明后端还是旧版；先升级程序再试。</div>';
    } else if (!s.found) {
      inner =
        '<div style="font-weight:600;color:var(--orange);margin-bottom:4px">⚠ 未找到解释器</div>' +
        '<div style="font-size:12.5px;line-height:1.75">' +
          '<div>点下面的<b>「下载并安装解释器」</b>会从它的 GitHub Release 取网页版（约 60 KB），' +
            '自动解压到：</div>' +
          '<div style="margin:4px 0"><code style="background:var(--bg-3);padding:2px 6px;border-radius:4px">' + esc(MEM_STUDIO_INSTALL_HINT) + '</code></div>' +
          '<div class="muted" style="font-size:12px">也可以自己把源码放到该目录（里面要有 <code>server.mjs</code> 与 <code>src\\merge.mjs</code>），放好后点「重新检测」。' +
            '解释器不随 QQ Agent 安装包分发，单独下载/更新，它自己的 <code>data\\</code> 不会被覆盖。</div>' +
          '<div>仓库地址：<a href="' + esc(MEM_STUDIO_REPO) + '" target="_blank" rel="noreferrer">' + esc(MEM_STUDIO_REPO) + '</a></div>' +
        '</div>';
    } else {
      const ver = s.version ? ' · v' + esc(s.version) : '';
      const up = st.update;
      let upLine = '';
      if (up?.ok) {
        upLine = up.hasUpdate
          ? '<div style="font-size:12.5px;color:var(--orange);margin-top:4px">发现解释器新版本 v' + esc(up.latest) + '（当前 v' + esc(up.current || s.version || '?') + '）</div>'
          : '<div class="muted" style="font-size:12px;margin-top:4px">已是最新版本' + (up.latest ? '（v' + esc(up.latest) + '）' : '') + '</div>';
      } else if (up && !up.ok) {
        upLine = '<div style="font-size:12px;color:var(--red);margin-top:4px">检查更新失败：' + esc(up.error || '未知错误') + '</div>';
      }
      if (s.running) {
        inner =
          '<div style="font-weight:600;color:var(--green)">✅ 解释器运行中 <span class="muted" style="font-weight:400">127.0.0.1:' + esc(s.port || '') + ver + '</span></div>' +
          '<div class="muted" style="font-size:12px;line-height:1.6">' + (s.url ? '地址：' + esc(s.url) + '　' : '') + '目录：' + esc(s.dir || '(未知)') + '</div>' +
          '<div class="hint" style="font-size:11.5px">「停止」只结束控制台拉起的那一份；如果你另外手动开过解释器窗口，那份不受影响。</div>' +
          upLine;
      } else {
        inner =
          '<div style="font-weight:600;color:var(--orange)">⚙ 已找到解释器，但未运行' + ver + '</div>' +
          '<div class="muted" style="font-size:12px;line-height:1.6">目录：' + esc(s.dir || '(未知)') + '　点「启动解释器」拉起（需要几秒）。</div>' +
          upLine;
      }
    }
    let buttons;
    if (!s || st.statusError) {
      buttons = '<button class="btn btn-small" data-studio="redetect"' + dis + '>' + (st.statusBusy === 'detect' ? '检测中…' : '重新检测') + '</button>';
    } else if (!s.found) {
      // 没装 → 直接给下载按钮（逻辑与 QQ Agent 自身的"检查更新"一致：查 Release → 下载 → 落地）
      buttons = '<button class="btn btn-small btn-primary" data-studio="install"' + dis + '>' +
        (st.updateBusy === 'install' ? '正在下载并安装解释器…' : '下载并安装解释器') + '</button>' +
        '<button class="btn btn-small" data-studio="redetect"' + dis + '>重新检测</button>';
    } else if (s.found && !s.running) {
      buttons = '<button class="btn btn-small btn-primary" data-studio="start"' + dis + '>' + (st.statusBusy === 'start' ? '正在启动解释器…（最长约 20 秒）' : '启动解释器') + '</button>' +
        '<button class="btn btn-small" data-studio="check-update"' + dis + '>' + (st.updateBusy === 'check' ? '检查中…' : '检查更新') + '</button>' +
        (st.update?.ok && st.update.hasUpdate
          ? '<button class="btn btn-small" data-studio="install"' + dis + '>' + (st.updateBusy === 'install' ? '更新中…' : '更新到 v' + esc(st.update.latest)) + '</button>'
          : '') +
        '<button class="btn btn-small" data-studio="redetect"' + dis + '>重新检测</button>';
    } else {
      buttons = '<button class="btn btn-small" data-studio="stop"' + dis + '>' + (st.statusBusy === 'stop' ? '停止中…' : '停止') + '</button>' +
        '<button class="btn btn-small" data-studio="check-update"' + dis + '>' + (st.updateBusy === 'check' ? '检查中…' : '检查更新') + '</button>' +
        (st.update?.ok && st.update.hasUpdate
          ? '<button class="btn btn-small" data-studio="install"' + dis + '>' + (st.updateBusy === 'install' ? '更新中…' : '更新到 v' + esc(st.update.latest)) + '</button>'
          : '') +
        '<button class="btn btn-small" data-studio="redetect"' + dis + '>重新检测</button>';
    }
    if (st.statusError && s) inner += '<div class="mem-studio-err" style="color:var(--red);font-size:12px;margin-top:6px">' + esc(st.statusError) + '</div>';
    if (st.updateError) inner += '<div class="mem-studio-err" style="color:var(--red);font-size:12px;margin-top:6px">' + esc(st.updateError) + '</div>';
    return '<div class="mem-studio-block" style="' + MEM_STUDIO_BLOCK_STYLE + '">' +
      '<div style="' + MEM_STUDIO_TITLE_STYLE + '">解释器状态</div>' + inner +
      '<div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap">' + buttons + '</div>' +
    '</div>';
  }

  // ── 载入来源 ────────────────────────────────────────────────────────────
  function memStudioSourceInnerHtml() {
    const st = memStudioState;
    const s = st.source;
    const info = s
      ? '<div style="font-size:12.5px;line-height:1.7;margin-top:6px">已载入 <b>' + esc(s.name || '记忆包') + '</b>：' +
        memStudioCountsText(s.counts) + '　·　共 <b>' + memStudioFmt(s.stats && s.stats.cards) + '</b> 张卡 / <b>' +
        memStudioFmt(s.stats && s.stats.chars) + '</b> 字</div>'
      : '<div class="muted" style="font-size:12px;line-height:1.7;margin-top:6px">还没有载入记忆。可读取 QQ Agent 现有记忆，或选择一个本地 .qqmem.json 文件。</div>';
    const err = st.loadError ? '<div class="mem-studio-err" style="color:var(--red);font-size:12px;margin-top:6px">载入失败：' + esc(st.loadError) + '</div>' : '';
    return '<div class="mem-studio-block" style="' + MEM_STUDIO_BLOCK_STYLE + '">' +
      '<div style="' + MEM_STUDIO_TITLE_STYLE + '">载入来源</div>' +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
        '<button class="btn btn-small" data-studio="load-live"' + (st.loadBusy ? ' disabled' : '') + '>' + (st.loadBusy ? '读取中…' : '载入当前记忆') + '</button>' +
        '<button class="btn btn-small" data-studio="pick-file">选择 .qqmem.json 文件…</button>' +
        '<input type="file" id="memstudio-file" data-studio-input="file" accept=".json,.qqmem.json,application/json" style="display:none" />' +
      '</div>' +
      '<div class="hint">「载入当前记忆」只读现有记忆卡，不改动数据；选择文件只在本机读取，不上传。</div>' +
      info + err +
    '</div>';
  }

  // ── 压缩选项 ────────────────────────────────────────────────────────────
  function memStudioRadioRow(name, act, value, checked, label, disabled) {
    return '<label style="display:inline-flex;align-items:center;gap:5px;margin:2px 14px 2px 0;font-size:12.5px;cursor:pointer">' +
      '<input type="radio" name="' + name + '" value="' + value + '" data-studio-opt="' + act + '"' +
      (checked ? ' checked' : '') + (disabled ? ' disabled' : '') + ' /> <span>' + label + '</span></label>';
  }
  function memStudioCheckRow(act, key, checked, label, disabled) {
    return '<label style="display:inline-flex;align-items:center;gap:5px;margin:2px 14px 2px 0;font-size:12.5px;cursor:pointer">' +
      '<input type="checkbox" data-studio-opt="' + act + '" data-k="' + key + '"' + (checked ? ' checked' : '') +
      (disabled ? ' disabled' : '') + ' /> <span>' + label + '</span></label>';
  }
  function memStudioCardIndex() {
    const st = memStudioState;
    const payload = (st.bundle && st.bundle.payload) || {};
    const out = [];
    const add = (section, key, title, sub) => {
      const k = String(key == null ? '' : key).trim();
      if (!k) return;
      out.push({ id: section + '|' + k, section, key: k, title: String(title || k), sub: String(sub || '') });
    };
    for (const g of (payload.generals || [])) add('generals', g.id, g.name || g.id, g.summary);
    for (const g of (payload.groups || [])) add('groups', g.chatKey, g.name || g.chatKey, g.chatKey);
    for (const p of (payload.persons || [])) add('persons', p.qq, p.name || ('QQ' + p.qq), 'QQ ' + p.qq);
    for (const t of (payload.topics || [])) add('topics', t.id, t.title || t.id, t.chatKey);
    return out;
  }
  function memStudioMustKeepListHtml() {
    const st = memStudioState;
    const all = memStudioCardIndex();
    if (!all.length) return '<div class="muted" style="padding:6px;font-size:12px">先载入记忆，才能选择要保留的卡。</div>';
    const q = String(st.mustKeepQuery || '').trim().toLowerCase();
    const hit = q ? all.filter((x) => (x.title + ' ' + x.key + ' ' + x.sub).toLowerCase().includes(q)) : all;
    const selected = new Set(st.options.mustKeep || []);
    const MAX = 120;
    const rows = hit.slice(0, MAX).map((x) => {
      return '<label style="display:flex;align-items:center;gap:6px;padding:2px 0;font-size:12px;cursor:pointer">' +
        '<input type="checkbox" data-studio-opt="mustkeep" data-key="' + esc(x.id) + '"' + (selected.has(x.id) ? ' checked' : '') + ' />' +
        '<span class="muted" style="flex-shrink:0">[' + esc(MEM_STUDIO_SECTION_LABEL[x.section] || x.section) + ']</span>' +
        '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(x.title) + '</span>' +
        '<span class="muted" style="font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(x.sub) + '</span>' +
      '</label>';
    }).join('');
    const more = hit.length > MAX ? '<div class="muted" style="font-size:11px;padding:4px 0">还有 ' + (hit.length - MAX) + ' 张没显示，用上面的搜索缩小范围。</div>' : '';
    return (rows || '<div class="muted" style="padding:6px;font-size:12px">没有匹配的卡。</div>') + more;
  }
  function memStudioOptionsInnerHtml() {
    const st = memStudioState;
    const o = st.options;
    const running = !!(st.status && st.status.running);
    const hasSource = !!st.bundle;
    const jobRunning = st.job.status === 'running';
    const dis = jobRunning ? ' disabled' : '';
    const disabledAttr = jobRunning ? ' disabled' : '';

    const modeRow = ['merge', 'both', 'text'].map((m) =>
      memStudioRadioRow('memstudio-mode', 'mode', m, o.mode === m, MEM_STUDIO_MODE_LABEL[m], !!dis)
    ).join('');

    const targetRow =
      memStudioRadioRow('memstudio-target', 'target-mode', 'ratio', o.targetMode === 'ratio', '压到原字数的', !!dis) +
      '<input type="number" min="5" max="95" step="1" data-studio-input="ratio" value="' + esc(o.ratio) + '"' +
      ' style="width:64px;margin:0 4px 0 2px" title="5-95（%）"' + (o.targetMode !== 'ratio' || jobRunning ? ' disabled' : '') + ' />' +
      '<span style="font-size:12.5px;margin-right:14px">%</span>' +
      memStudioRadioRow('memstudio-target', 'target-mode', 'kb', o.targetMode === 'kb', '压到约', !!dis) +
      '<input type="number" min="1" step="1" data-studio-input="targetKB" value="' + esc(o.targetKB) + '"' +
      ' style="width:74px;margin:0 4px 0 2px" title="KB（按载入字数换算百分比）"' + (o.targetMode !== 'kb' || jobRunning ? ' disabled' : '') + ' />' +
      '<span style="font-size:12.5px;margin-right:14px">KB</span>' +
      memStudioRadioRow('memstudio-target', 'target-mode', 'free', o.targetMode === 'free', '不指定（交给模型按约 30% 自行取舍）', !!dis);

    const coldRow = ['oneline', 'drop'].map((m) =>
      memStudioRadioRow('memstudio-cold', 'cold-mode', m, o.coldMode === m, MEM_STUDIO_COLD_LABEL[m], !!dis)
    ).join('');

    const apInput = (key, label, extra, value, tip) =>
      '<label style="font-size:11.5px;color:var(--tx3);display:block">' + label +
        '<input type="number" ' + extra + ' data-studio-input="' + key + '" value="' + esc(value) + '" style="width:100%;margin-top:2px" title="' + esc(tip) + '"' + disabledAttr + ' /></label>';
    const ap = o.activeParams || {};

    const keepRow = MEM_STUDIO_KEEP_FIELDS.map(([k, label]) =>
      memStudioCheckRow('keep', k, !!o.keep[k], label, !!dis)
    ).join('');

    let runBlock;
    if (jobRunning) {
      runBlock = '<span class="hint">压缩进行中…进度见下方。</span>';
    } else if (!hasSource) {
      runBlock = '<button class="btn btn-primary" data-studio="run" disabled>开始压缩</button><span class="hint">先载入记忆。</span>';
    } else if (!running) {
      runBlock = '<button class="btn btn-primary" data-studio="run" disabled>开始压缩</button><span class="hint">先在上方启动记忆解释器。</span>';
    } else {
      runBlock = '<button class="btn btn-primary" data-studio="run">开始压缩</button><span class="hint">会调用本地解释器的模型（消耗 API 额度），可能持续几分钟；期间可切页签。</span>';
    }

    return '<div class="mem-studio-block" style="' + MEM_STUDIO_BLOCK_STYLE + '">' +
      '<div style="' + MEM_STUDIO_TITLE_STYLE + '">压缩选项</div>' +
      '<div class="field" style="margin-bottom:10px"><label>压缩方式</label><div>' + modeRow + '</div>' +
        '<div class="hint">合并卡片不调模型（只裁剪/合并同类卡），<b>不需要 API Key</b>；「压文字 / 合并+压文字」会让模型改写长文本，需要解释器那边先配好 Key（<code>tools\\memory-studio\\data\\config.json</code>，或单独运行解释器在它的设置里填）。</div></div>' +
      '<div class="field" style="margin-bottom:10px"><label>目标大小</label><div style="display:flex;align-items:center;flex-wrap:wrap">' + targetRow + '</div>' +
        '<div class="hint">目标只用于换算压缩比例；实际结果受「保留字段 / 冷门策略」影响。</div></div>' +
      '<div class="field" style="margin-bottom:10px"><label>冷门策略（很少出现的人怎么处理）</label><div>' + coldRow + '</div></div>' +
      '<div class="field" style="margin-bottom:10px"><label>活跃参数（留空 = 不限制）</label>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px">' +
          apInput('ap-topn', '最多保留活跃成员 topN', 'min="1" step="1"', ap.topN, '按活跃度排序后最多保留多少人（留空 = 按保留比例自动定）') +
          apInput('ap-minmsgs', '最少消息数 minMsgs', 'min="0" step="1"', ap.minMsgs, '在本群累计发言少于该数的人算冷门（留空 = 不限）') +
          apInput('ap-recentdays', '最近活跃天数 recentDays', 'min="1" step="1"', ap.recentDays, '最近 N 天出现过的人算活跃（留空 = 不限）') +
          apInput('ap-minmemscore', '最低记忆分 minMemScore', 'min="0" max="30" step="0.5"', ap.minMemScore, '记忆综合分低于该值算冷门（大致 0~23：facts/事件/印象/摘要长度/近期活跃的加权分，留空 = 不限）') +
        '</div>' +
        '<div class="hint">四个阈值任意填一个就按阈值筛人；全部留空 = 按综合分 + 冷门策略保留。</div></div>' +
      '<div class="field" style="margin-bottom:10px"><label>必须保留的卡（mustKeep）</label>' +
        '<input type="text" data-studio-input="mustkeep-search" placeholder="搜索名字 / QQ / 卡标题…" value="' + esc(st.mustKeepQuery) + '" style="width:100%"' + disabledAttr + ' />' +
        '<div id="memstudio-mustkeep-list" style="max-height:200px;overflow:auto;border:1px solid var(--line);border-radius:6px;margin-top:6px;padding:6px">' + memStudioMustKeepListHtml() + '</div>' +
        '<div class="hint" id="memstudio-mustkeep-count">已选 ' + ((o.mustKeep || []).length) + ' 张</div></div>' +
      '<div class="field" style="margin-bottom:10px"><label>保留字段（不勾的字段压缩后会从卡里删掉）</label><div>' + keepRow + '</div>' +
        '<div class="hint">别名（aliases）是身份字段，解释器始终保留。</div></div>' +
      '<div class="field" style="margin-bottom:10px"><label>从话题提炼长期要点</label><div>' +
        memStudioCheckRow('extract', 'topics', !!o.extractFromTopics, '勾选后会把话题卡交给模型提炼成长期要点', !!dis) +
        '</div><div class="hint">会多一次模型调用（不确定要不要就留空）。</div></div>' +
      '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:6px">' + runBlock + '</div>' +
    '</div>';
  }

  // ── 进度 ────────────────────────────────────────────────────────────────
  function memStudioProgressInnerHtml() {
    const st = memStudioState;
    const job = st.job || {};
    if (job.status === 'failed') {
      return '<div class="mem-studio-block" style="' + MEM_STUDIO_BLOCK_STYLE + '">' +
        '<div style="' + MEM_STUDIO_TITLE_STYLE + 'color:var(--red)">压缩失败</div>' +
        '<div class="mem-studio-err" style="color:var(--red);font-size:12.5px;line-height:1.6;white-space:pre-wrap">' + esc(job.error || '解释器没有给出错误信息') + '</div>' +
        '<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap"><button class="btn btn-small" data-studio="recompress">重新压缩</button></div>' +
      '</div>';
    }
    if (job.status !== 'running') return '';
    const pct = Math.max(2, Math.min(100, Math.round(memStudioNum(job.pct) || 2)));
    const stage = memStudioStageText(job.progress, memStudioElapsedSec());
    return '<div class="mem-studio-block" style="' + MEM_STUDIO_BLOCK_STYLE + '">' +
      '<div style="' + MEM_STUDIO_TITLE_STYLE + '">压缩中…</div>' +
      '<div style="height:8px;background:var(--line);border-radius:99px;overflow:hidden">' +
        '<div style="height:100%;width:' + pct + '%;background:var(--accent);transition:width .3s ease"></div>' +
      '</div>' +
      '<div class="hint" id="memstudio-progress-text" style="margin-top:6px">' + esc(stage) + '</div>' +
      '<div class="hint" style="font-size:11.5px">任务 ' + esc(job.id || '(提交中)') + ' · 切到别的页签不会中断，回来还能看到进度。</div>' +
    '</div>';
  }

  // ── 结果 + 导回 ─────────────────────────────────────────────────────────
  function memStudioResultInnerHtml() {
    const st = memStudioState;
    const r = st.result;
    if (!r) return '';
    const stats = r.stats || {};
    // mode='both' 时解释器把最终文字压缩的 stats 放在顶层、合并阶段的
    // stats 塞在 stats.merge 里（server.mjs: { ...texted.stats, merge: merged.stats }）。
    // 原始的「压缩前」和每轮注入成本只有 merge 那份有 —— 不往下找就会显示成 "-"。
    const mergeStats = (stats.merge && typeof stats.merge === 'object') ? stats.merge : null;
    const before = (mergeStats && mergeStats.before) || stats.before || {};
    const after = stats.after || (mergeStats && mergeStats.after) || {};
    const costBefore = stats.costBefore || (mergeStats && mergeStats.costBefore) || {};
    const costAfter = stats.costAfter || (mergeStats && mergeStats.costAfter) || {};
    // 冷门统计只在合并阶段产生（只压文字的模式没有）
    const coldStats = (stats.coldMode !== undefined || stats.personsMerged !== undefined)
      ? stats : (mergeStats || stats);
    const rows = [
      ['记忆卡数', memStudioFmt(before.cards), memStudioFmt(after.cards), memStudioDelta(before.cards, after.cards)],
      ['总字数', memStudioFmt(before.chars), memStudioFmt(after.chars), memStudioDelta(before.chars, after.chars)],
      ['每轮注入字数（中位会话）', memStudioFmt(costBefore.perTurnChars), memStudioFmt(costAfter.perTurnChars), memStudioDelta(costBefore.perTurnChars, costAfter.perTurnChars)]
    ].map(([label, b, a, d]) => {
      return '<tr><td style="padding:3px 8px 3px 0;color:var(--tx3);font-size:12px">' + esc(label) + '</td>' +
        '<td style="padding:3px 8px;font-size:12.5px">' + esc(b) + '</td>' +
        '<td style="padding:3px 8px;font-size:12.5px">→ ' + esc(a) + '</td>' +
        '<td style="padding:3px 0;font-size:12px;color:var(--green)">' + esc(d) + '</td></tr>';
    }).join('');
    // 冷门数：解释器给 personsMerged / coldDropped / coldMode / coldLines
    const merged = memStudioNum(coldStats.personsMerged);
    const coldMode = String(coldStats.coldMode || memStudioState.options.coldMode || 'oneline');
    let coldText = '冷门成员：-';
    if (merged !== null) {
      const dropped = memStudioNum(coldStats.coldDropped) || 0;
      const lines = memStudioNum(coldStats.coldLines) || 0;
      coldText = '冷门成员：' + merged + ' 人（' + (MEM_STUDIO_COLD_LABEL[coldMode] || coldMode) +
        (coldMode === 'drop' ? '，实际丢弃 ' + dropped + ' 人' : '，缩成 ' + lines + ' 行背景') + '）';
    }
    const kept = memStudioNum(coldStats.kept);
    const keptText = kept === null ? '' : '　·　保留 ' + kept + ' 张完整卡';
    const warnings = Array.isArray(r.warnings) && r.warnings.length
      ? '<div class="hint" style="color:var(--orange);font-size:12px;margin-top:6px">提示：' + r.warnings.map((w) => esc(String(w))).join('；') + '</div>'
      : '';

    const done = st.importDone;
    let importHtml = '';
    if (st.importOpen) {
      const payload = (r.bundle && r.bundle.payload) || {};
      const est = (k) => (payload[k] || []).length;
      importHtml =
        '<div style="border:1px dashed var(--orange);border-radius:8px;padding:10px;margin-top:10px">' +
          '<div style="font-weight:600;font-size:13px;color:var(--orange);margin-bottom:4px">⚠ 确认导回 QQ Agent？</div>' +
          '<div class="hint" style="font-size:12px">会写入 <code>data/memory-cards/</code>。压缩前的记忆不会自动备份 —— 想留底先点「下载 .qqmem.json」。</div>' +
          '<div style="margin:6px 0">' +
            '<label style="display:block;font-size:12.5px;margin:2px 0"><input type="radio" name="memstudio-importmode" value="merge" data-studio-opt="import-mode"' + (st.importMode === 'merge' ? ' checked' : '') + ' /> 合并（推荐）：按 updatedAt 取新的，较旧的卡跳过</label>' +
            '<label style="display:block;font-size:12.5px;margin:2px 0"><input type="radio" name="memstudio-importmode" value="replace" data-studio-opt="import-mode"' + (st.importMode === 'replace' ? ' checked' : '') + ' /> 覆盖：包里同 key 的卡用它覆盖，包里没有的卡保留（不清空）</label>' +
          '</div>' +
          '<div class="hint" style="font-size:12px">这次将提交：通用 ' + est('generals') + ' · 群聊 ' + est('groups') + ' · 个人 ' + est('persons') + ' · 话题 ' + est('topics') + ' 张卡。</div>' +
          '<div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap">' +
            '<button class="btn btn-small btn-primary" data-studio="import-confirm"' + (st.importBusy ? ' disabled' : '') + '>' + (st.importBusy ? '导回中…' : '确认导回') + '</button>' +
            '<button class="btn btn-small" data-studio="import-cancel"' + (st.importBusy ? ' disabled' : '') + '>取消</button>' +
            '<span class="hint">导回期间别关窗口</span>' +
          '</div>' +
          (st.importError ? '<div class="mem-studio-err" style="color:var(--red);font-size:12px;margin-top:6px;white-space:pre-wrap">导回失败：' + esc(st.importError) + '</div>' : '') +
        '</div>';
    } else if (done) {
      const w = done.written || {};
      const sk = done.skipped || {};
      const totalW = ['generals', 'groups', 'persons', 'topics'].reduce((n, k) => n + (memStudioNum(w[k]) || 0), 0);
      const totalS = ['generals', 'groups', 'persons', 'topics'].reduce((n, k) => n + (memStudioNum(sk[k]) || 0), 0);
      importHtml =
        '<div style="border:1px solid var(--green);border-radius:8px;padding:10px;margin-top:10px">' +
          '<div style="font-weight:600;font-size:13px;color:var(--green)">✅ 已导回 QQ Agent（' + esc(done.mode || st.importMode) + '）</div>' +
          '<div style="font-size:12.5px;line-height:1.7;margin-top:4px">写入 <b>' + totalW + '</b> 张：' + memStudioCountsText(w) + '</div>' +
          '<div style="font-size:12.5px;line-height:1.7">跳过 <b>' + totalS + '</b> 张（同 key 且不比现有新）：' + memStudioCountsText(sk) + '</div>' +
          (done.filteredOut ? '<div class="hint">另有 ' + done.filteredOut + ' 张因时间范围被过滤。</div>' : '') +
          '<div class="hint">切到「本会话 / 个人卡 / 基本事实」可看到最新数据（列表会自动重拉）。</div>' +
        '</div>';
    }
    return '<div class="mem-studio-block" style="' + MEM_STUDIO_BLOCK_STYLE + '">' +
      '<div style="' + MEM_STUDIO_TITLE_STYLE + '">压缩结果 <span class="muted" style="font-weight:400;font-size:12px">' + esc(MEM_STUDIO_MODE_LABEL[r.mode || stats.mode || ''] || '') + '</span></div>' +
      '<table style="border-collapse:collapse;margin-bottom:2px">' + rows + '</table>' +
      '<div style="font-size:12.5px;line-height:1.7">' + esc(coldText) + esc(keptText) + '</div>' +
      warnings +
      '<div style="display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap">' +
        '<button class="btn btn-small btn-primary" data-studio="import">导回 QQ Agent</button>' +
        '<button class="btn btn-small" data-studio="download">下载 .qqmem.json</button>' +
        '<button class="btn btn-small" data-studio="recompress">重新压缩</button>' +
        (st.downloadOk ? '<span class="hint" style="color:var(--green)">' + esc(st.downloadOk) + '</span>' : '') +
        (st.downloadError ? '<span class="hint" style="color:var(--red)">' + esc(st.downloadError) + '</span>' : '') +
      '</div>' +
      importHtml +
    '</div>';
  }

  // ── 状态拉取 / 启停 ────────────────────────────────────────────────────
  async function memStudioLoadStatus(force) {
    const st = memStudioState;
    if (st.statusBusy === 'detect') return;
    if (!force && st.status && st.statusAt && Date.now() - st.statusAt < 8000) return;
    st.statusBusy = 'detect';
    memStudioRenderStatus();
    try {
      const r = await api('/api/memory-studio/status');
      if (!r || r.ok === false) throw new Error((r && r.error) || '状态接口返回 ok=false');
      st.status = r;
      st.statusError = '';
    } catch (e) {
      st.status = null;
      st.statusError = String((e && e.message) || e);
    }
    st.statusBusy = '';
    st.statusAt = Date.now();
    memStudioRenderStatus();
    memStudioRenderOptions();
  }

  async function memStudioStart() {
    const st = memStudioState;
    if (st.statusBusy) return;
    st.statusBusy = 'start';
    st.statusError = '';
    memStudioRenderStatus();
    try {
      const r = await api('/api/memory-studio/start', { method: 'POST', body: '{}' });
      if (!r || r.ok === false) throw new Error((r && r.error) || '启动接口返回 ok=false');
      st.status = { ...(st.status || {}), ...r, ok: true, found: true, running: !!r.running };
      st.statusAt = Date.now();
    } catch (e) {
      st.statusError = String((e && e.message) || e);
    }
    st.statusBusy = '';
    memStudioRenderStatus();
    memStudioRenderOptions();
    memStudioLoadStatus(true);   // 启动可能顺延端口 → 以真实状态为准
  }

  async function memStudioStop() {
    const st = memStudioState;
    if (st.statusBusy) return;
    st.statusBusy = 'stop';
    st.statusError = '';
    memStudioRenderStatus();
    try {
      const r = await api('/api/memory-studio/stop', { method: 'POST', body: '{}' });
      if (!r || r.ok === false) throw new Error((r && r.error) || '停止接口返回 ok=false');
      st.status = { ...(st.status || {}), running: false, port: null, url: null };
      st.statusAt = Date.now();
    } catch (e) {
      st.statusError = String((e && e.message) || e);
    }
    st.statusBusy = '';
    memStudioRenderStatus();
    memStudioRenderOptions();
    memStudioLoadStatus(true);
  }

  // ── 检查更新 / 下载安装解释器（解释器不在 QQ Agent 安装包里，单独分发）──
  async function memStudioCheckUpdate() {
    const st = memStudioState;
    if (st.updateBusy) return;
    st.updateBusy = 'check';
    st.updateError = '';
    memStudioRenderStatus();
    try {
      const r = await api('/api/memory-studio/update-check');
      if (!r || r.ok === false) {
        st.update = r && r.ok === false ? { ...r, ok: false } : null;
        st.updateError = (r && r.error) || '检查更新失败';
      } else {
        st.update = r;
        st.updateError = '';
      }
      st.updateAt = Date.now();
    } catch (e) {
      st.updateError = '检查更新失败：' + String((e && e.message) || e);
    }
    st.updateBusy = '';
    memStudioRenderStatus();
  }

  async function memStudioInstall() {
    const st = memStudioState;
    if (st.updateBusy) return;
    st.updateBusy = 'install';
    st.updateError = '';
    memStudioRenderStatus();
    try {
      const r = await api('/api/memory-studio/install', { method: 'POST', body: '{}' });
      if (!r || r.ok === false) throw new Error((r && r.error) || '安装接口返回 ok=false');
      // 装/更新成功后清掉旧的更新结论，重新检测目录与版本
      st.update = null;
      st.status = null;
      st.statusAt = 0;
      st.updateError = '';
    } catch (e) {
      st.updateError = '下载/安装失败：' + String((e && e.message) || e);
    }
    st.updateBusy = '';
    memStudioRenderStatus();
    await memStudioLoadStatus(true);
    memStudioRenderOptions();
  }

  // ── 载入记忆 ────────────────────────────────────────────────────────────
  function memStudioAcceptBundle(bundle, meta) {
    const st = memStudioState;
    const payload = (bundle && bundle.payload) || {};
    const counts = (meta && meta.counts) || {
      generals: (payload.generals || []).length,
      groups: (payload.groups || []).length,
      persons: (payload.persons || []).length,
      topics: (payload.topics || []).length
    };
    let stats = (meta && meta.stats) || null;
    if (!stats || memStudioNum(stats.cards) === null) {
      let chars = 0;
      try { chars = JSON.stringify(payload).length; } catch (e) { chars = 0; }
      stats = {
        cards: ['generals', 'groups', 'persons', 'topics'].reduce((n, k) => n + ((payload[k] || []).length), 0),
        chars
      };
    }
    st.bundle = bundle;
    st.source = { kind: meta.kind, name: meta.name, counts, stats, at: Date.now() };
    st.loadError = '';
    // 换了份记忆包：旧的进度/结果/勾选都要清掉，避免把 A 包的结果导进 B 包
    const valid = new Set(memStudioCardIndex().map((x) => x.id));
    st.options.mustKeep = (st.options.mustKeep || []).filter((id) => valid.has(id));
    memStudioResetJob();
    memStudioRenderAll();
  }

  async function memStudioLoadLive() {
    const st = memStudioState;
    if (st.loadBusy) return;
    st.loadBusy = true;
    st.loadError = '';
    memStudioRenderSource();
    try {
      const r = await api('/api/memory-bundle/json');
      if (!r || r.ok === false) throw new Error((r && r.error) || '接口返回 ok=false');
      if (!r.bundle || !r.bundle.payload) throw new Error('返回里没有 bundle（接口版本可能不匹配）');
      memStudioAcceptBundle(r.bundle, { kind: 'live', name: '当前记忆', counts: r.counts, stats: r.stats });
    } catch (e) {
      st.loadError = String((e && e.message) || e);
    }
    st.loadBusy = false;
    memStudioRenderSource();
    memStudioRenderOptions();
  }

  function memStudioReadFile(file) {
    const st = memStudioState;
    st.loadError = '';
    try {
      if (typeof FileReader !== 'function') throw new Error('当前环境不支持 FileReader');
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const obj = JSON.parse(String(reader.result == null ? '' : reader.result));
          const payload = obj && obj.payload;
          if (!payload || typeof payload !== 'object') throw new Error('不是 QQ Agent 记忆包（缺少 payload）');
          memStudioAcceptBundle(obj, { kind: 'file', name: file && file.name ? file.name : '本地文件' });
        } catch (e) {
          st.loadError = String((e && e.message) || e);
          memStudioRenderSource();
          memStudioRenderOptions();
        }
      };
      reader.onerror = () => {
        st.loadError = String((reader.error && reader.error.message) || '读取文件失败');
        memStudioRenderSource();
      };
      reader.readAsText(file, 'utf-8');
    } catch (e) {
      st.loadError = String((e && e.message) || e);
      memStudioRenderSource();
    }
  }

  // ── 构造解释器 options（形状已冻结，别改字段名）──────────────────────────
  function memStudioBuildOptions() {
    const o = memStudioState.options;
    const options = {
      mode: o.mode === 'merge' || o.mode === 'text' ? o.mode : 'both',
      coldMode: o.coldMode === 'drop' ? 'drop' : 'oneline',
      longTermOnly: o.longTermOnly !== false,
      extractFromTopics: !!o.extractFromTopics,
      keepTopShare: memStudioNum(o.keepTopShare) === null ? 0.45 : memStudioNum(o.keepTopShare),
      keep: {
        facts: !!o.keep.facts,
        impressions: !!o.keep.impressions,
        events: !!o.keep.events,
        prefs: !!o.keep.prefs,
        aliases: !!o.keep.aliases,
        body: !!o.keep.body
      },
      mustKeep: (o.mustKeep || []).slice(),
      activeParams: {
        topN: (o.activeParams || {}).topN === undefined ? '' : (o.activeParams || {}).topN,
        minMsgs: (o.activeParams || {}).minMsgs === undefined ? '' : (o.activeParams || {}).minMsgs,
        recentDays: (o.activeParams || {}).recentDays === undefined ? '' : (o.activeParams || {}).recentDays,
        minMemScore: (o.activeParams || {}).minMemScore === undefined ? '' : (o.activeParams || {}).minMemScore
      }
    };
    if (o.targetMode === 'kb') options.targetKB = Math.max(1, memStudioNum(o.targetKB) || 1);
    else if (o.targetMode === 'ratio') options.ratio = Math.min(95, Math.max(5, memStudioNum(o.ratio) || 40));
    else { options.ratio = 30; options.free = true; }   // 不指定：交给模型按约 30% 自行取舍
    return options;
  }

  // ── 执行压缩 + 轮询 ─────────────────────────────────────────────────────
  function memStudioStopTicker() {
    const job = memStudioState.job;
    if (job && job.tick) { clearInterval(job.tick); job.tick = null; }
  }
  function memStudioStartTicker() {
    const st = memStudioState;
    if (st.job.tick) return;
    st.job.tick = setInterval(() => {
      const job = st.job;
      if (!job || job.status !== 'running') { memStudioStopTicker(); return; }
      const text = $('#memstudio-progress-text');
      if (text) text.textContent = memStudioStageText(job.progress, memStudioElapsedSec());
      // 还没有任何进度时让进度条缓慢往前挪，避免看起来像卡死（最多到 12%）
      if (!job.progress && (memStudioNum(job.pct) || 0) < 12) {
        job.pct = Math.min(12, (memStudioNum(job.pct) || 2) + 1);
        memStudioRenderProgress();
      }
    }, 1000);
  }
  function memStudioResetJob() {
    const st = memStudioState;
    memStudioStopTicker();
    st.job = { id: '', status: '', progress: null, error: '', startedAt: 0, pct: 0, pollTimer: null, pollFails: 0, tick: null };
    st.result = null;
    st.importOpen = false;
    st.importBusy = false;
    st.importError = '';
    st.importDone = null;
    st.downloadOk = '';
    st.downloadError = '';
  }
  function memStudioFail(message) {
    const st = memStudioState;
    memStudioStopTicker();
    st.job.status = 'failed';
    st.job.error = String(message == null ? '未知错误' : message);
    st.job.pollTimer = null;
    memStudioRenderProgress();
    memStudioRenderOptions();
  }
  async function memStudioRun() {
    const st = memStudioState;
    if (!st.bundle) return;
    if (!(st.status && st.status.running)) return;
    if (st.job.status === 'running') return;
    const options = memStudioBuildOptions();
    st.job = { id: '', status: 'running', progress: null, error: '', startedAt: Date.now(), pct: 3, pollTimer: null, pollFails: 0, tick: null };
    st.result = null;
    st.importOpen = false;
    st.importBusy = false;
    st.importError = '';
    st.importDone = null;
    st.downloadOk = '';
    st.downloadError = '';
    memStudioRenderProgress();
    memStudioRenderResult();
    memStudioRenderOptions();
    memStudioStartTicker();
    try {
      const r = await api('/api/memory-studio/call', {
        method: 'POST',
        body: JSON.stringify({ path: '/api/compress/start', method: 'POST', body: { bundle: st.bundle, options } })
      });
      if (!r || r.ok === false) throw new Error(String((r && r.error) || '调用解释器失败'));
      const data = r.data || {};
      if (data && data.ok === false) throw new Error(String(data.error || '解释器拒绝了压缩任务'));
      const jobId = String((data && data.jobId) || '');
      if (!jobId) {
        let brief = '';
        try { brief = JSON.stringify(data).slice(0, 200); } catch (e) { brief = String(data).slice(0, 200); }
        throw new Error('解释器没有返回 jobId（返回：' + brief + '）');
      }
      st.job.id = jobId;
      memStudioRenderProgress();
      memStudioPollJob(jobId);
    } catch (e) {
      memStudioFail('压缩任务提交失败：' + String((e && e.message) || e));
    }
  }
  function memStudioPollJob(jobId) {
    const st = memStudioState;
    if (!jobId || st.job.id !== jobId) return;
    if (st.job.pollTimer) { clearTimeout(st.job.pollTimer); st.job.pollTimer = null; }
    const tick = async () => {
      const job = st.job;
      if (!job || job.id !== jobId || job.status !== 'running') return;
      job.pollTimer = null;
      try {
        const r = await api('/api/memory-studio/call', {
          method: 'POST',
          body: JSON.stringify({ path: '/api/job/' + encodeURIComponent(jobId), method: 'GET' })
        });
        if (!r || r.ok === false) throw new Error(String((r && r.error) || '轮询接口返回 ok=false'));
        const data = r.data || {};
        if (data && data.ok === false) throw new Error(String(data.error || '解释器查任务失败'));
        const status = String((data && data.status) || 'running');
        if (data && data.progress) {
          job.progress = data.progress;
          const est = memStudioEstimatePct(data.progress);
          if (est !== null) job.pct = Math.max(memStudioNum(job.pct) || 0, est);
        }
        if (status === 'done') {
          const res = (data && data.result) || {};
          if (!res.bundle || !res.bundle.payload) {
            memStudioFail('解释器返回完成，但结果里没有 bundle');
            return;
          }
          job.status = 'done';
          job.pct = 100;
          job.progress = null;
          st.result = {
            bundle: res.bundle,
            stats: res.stats || {},
            warnings: Array.isArray(res.warnings) ? res.warnings : [],
            mode: st.options.mode,
            at: Date.now()
          };
          memStudioStopTicker();
          memStudioRenderProgress();
          memStudioRenderResult();
          memStudioRenderOptions();
          return;
        }
        if (status === 'failed') {
          memStudioFail('压缩失败：' + String((data && data.error) || '解释器没有给出错误信息'));
          return;
        }
        memStudioRenderProgress();
        job.pollTimer = setTimeout(tick, 900);
      } catch (e) {
        job.pollFails = (memStudioNum(job.pollFails) || 0) + 1;
        if (job.pollFails <= 3) {
          memStudioRenderProgress();
          job.pollTimer = setTimeout(tick, 1500);
        } else {
          memStudioFail('轮询压缩进度失败：' + String((e && e.message) || e));
        }
      }
    };
    tick();
  }

  // ── 下载（前端 Blob，不走解释器）────────────────────────────────────────
  function memStudioDownload() {
    const st = memStudioState;
    const bundle = st.result && st.result.bundle;
    if (!bundle) return;
    st.downloadOk = '';
    st.downloadError = '';
    let text = '';
    try { text = JSON.stringify(bundle, null, 1); }
    catch (e) { st.downloadError = '下载失败：序列化出错（' + String((e && e.message) || e) + '）'; memStudioRenderResult(); return; }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = 'compressed-' + stamp + '.qqmem.json';
    try {
      if (typeof Blob !== 'function' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
        throw new Error('当前环境不支持前端下载');
      }
      const blob = new Blob([text], { type: 'application/json' });
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = name;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        try { a.remove(); URL.revokeObjectURL(href); } catch (e) { /* ignore */ }
      }, 0);
      st.downloadOk = '已开始下载 ' + name;
    } catch (e) {
      st.downloadError = '下载失败：' + String((e && e.message) || e);
    }
    memStudioRenderResult();
  }

  // ── 导回 QQ Agent（二次确认 + written/skipped）──────────────────────────
  async function memStudioImport() {
    const st = memStudioState;
    if (!st.result || !st.result.bundle || st.importBusy) return;
    st.importBusy = true;
    st.importError = '';
    st.importDone = null;
    memStudioRenderResult();
    try {
      const r = await api('/api/memory-bundle/import', {
        method: 'POST',
        body: JSON.stringify({ bundle: st.result.bundle, mode: st.importMode === 'replace' ? 'replace' : 'merge' })
      });
      if (!r || r.ok === false) {
        const list = r && Array.isArray(r.errors) ? r.errors.filter(Boolean) : [];
        throw new Error(list.length ? list.join('；') : String((r && r.error) || '导回接口返回 ok=false'));
      }
      st.importDone = {
        written: r.written || {},
        skipped: r.skipped || {},
        mode: r.mode || st.importMode,
        filteredOut: memStudioNum(r.filteredOut) || 0
      };
      st.importOpen = false;
      // 让「本会话 / 个人卡 / 基本事实」下次进入时重拉数据（导回已经改动磁盘上的卡）
      try { if (typeof memState === 'function') { const ms = memState(); if (ms) ms.list = null; } } catch (e) { /* ignore */ }
    } catch (e) {
      st.importError = String((e && e.message) || e);
    }
    st.importBusy = false;
    memStudioRenderResult();
  }

  // ── 事件委托用到的面板动作分发 ─────────────────────────────────────────
  function memStudioResetResult() {
    memStudioState.result = null;
    memStudioState.importOpen = false;
    memStudioState.importDone = null;
    memStudioState.importError = '';
    memStudioState.downloadOk = '';
    memStudioState.downloadError = '';
    memStudioRenderProgress();
    memStudioRenderResult();
  }
  function memStudioHandleAction(act) {
    if (act === 'redetect') { memStudioLoadStatus(true); return; }
    if (act === 'start') { memStudioStart(); return; }
    if (act === 'stop') { memStudioStop(); return; }
    if (act === 'check-update') { memStudioCheckUpdate(); return; }
    if (act === 'install') { memStudioInstall(); return; }
    if (act === 'load-live') { memStudioLoadLive(); return; }
    if (act === 'pick-file') {
      const file = $('#memstudio-file');
      if (file) file.click();
      return;
    }
    if (act === 'run') { memStudioRun(); return; }
    if (act === 'recompress') { memStudioResetResult(); return; }
    if (act === 'download') { memStudioDownload(); return; }
    if (act === 'import') {
      if (!memStudioState.result) return;
      memStudioState.importOpen = true;
      memStudioState.importError = '';
      memStudioRenderResult();
      return;
    }
    if (act === 'import-cancel') {
      memStudioState.importOpen = false;
      memStudioState.importError = '';
      memStudioRenderResult();
      return;
    }
    if (act === 'import-confirm') { memStudioImport(); return; }
  }
  function memStudioHandleOption(el) {
    const st = memStudioState;
    const kind = el.dataset ? el.dataset.studioOpt : '';
    const value = el.value;
    if (kind === 'mode') { st.options.mode = value === 'merge' || value === 'text' ? value : 'both'; return; }
    if (kind === 'target-mode') {
      st.options.targetMode = value === 'kb' || value === 'free' ? value : 'ratio';
      memStudioRenderOptions();
      return;
    }
    if (kind === 'cold-mode') { st.options.coldMode = value === 'drop' ? 'drop' : 'oneline'; return; }
    if (kind === 'keep') {
      const k = el.dataset.k;
      if (k && Object.prototype.hasOwnProperty.call(st.options.keep, k)) st.options.keep[k] = !!el.checked;
      return;
    }
    if (kind === 'extract') { st.options.extractFromTopics = !!el.checked; return; }
    if (kind === 'import-mode') { st.importMode = value === 'replace' ? 'replace' : 'merge'; return; }
    if (kind === 'mustkeep') {
      const key = String(el.dataset.key || '');
      if (!key) return;
      const set = new Set(st.options.mustKeep || []);
      if (el.checked) set.add(key); else set.delete(key);
      st.options.mustKeep = [...set];
      const cnt = $('#memstudio-mustkeep-count');
      if (cnt) cnt.textContent = '已选 ' + st.options.mustKeep.length + ' 张';
      return;
    }
  }
  function memStudioHandleInput(el) {
    const st = memStudioState;
    const kind = el.getAttribute('data-studio-input');
    const value = String(el.value == null ? '' : el.value);
    if (kind === 'ratio') { st.options.ratio = value === '' ? '' : Number(value); return; }
    if (kind === 'targetKB') { st.options.targetKB = value === '' ? '' : Number(value); return; }
    if (kind === 'ap-topn') { st.options.activeParams.topN = value; return; }
    if (kind === 'ap-minmsgs') { st.options.activeParams.minMsgs = value; return; }
    if (kind === 'ap-recentdays') { st.options.activeParams.recentDays = value; return; }
    if (kind === 'ap-minmemscore') { st.options.activeParams.minMemScore = value; return; }
    if (kind === 'mustkeep-search') { st.mustKeepQuery = value; memStudioRenderMustKeep(); return; }
  }

  // ── 挂载（每次「压缩」子页签渲染后调用）────────────────────────────────
  function memStudioMount() {
    const st = memStudioState;
    memStudioRenderMustKeep();
    if (!st.status && !st.statusBusy) memStudioLoadStatus();
    else if (st.status && !st.statusBusy && st.statusAt && Date.now() - st.statusAt > 10000) memStudioLoadStatus(true);
    if (st.job.status === 'running') {
      memStudioStartTicker();
      if (st.job.id && !st.job.pollTimer) memStudioPollJob(st.job.id);
    }
  }

  // ── document 级一次性委托（CSP 禁内联 onclick；三个选择器登记在接线测试）──
  if (!window.__memStudioDelegated) {
    window.__memStudioDelegated = true;
    document.addEventListener('click', (e) => {
      if (state.tab !== 'memory') return;
      const el = e.target.closest('#view-memory [data-studio]');
      if (!el) return;
      if (el.tagName === 'INPUT') return;   // 单选/复选走 change，别重复处理
      e.preventDefault();
      memStudioHandleAction(el.getAttribute('data-studio'));
    });
    document.addEventListener('change', (e) => {
      if (state.tab !== 'memory') return;
      const opt = e.target.closest('#view-memory [data-studio-opt]');
      if (opt) { memStudioHandleOption(opt); return; }
      const file = e.target.closest('#view-memory [data-studio-input="file"]');
      if (!file) return;
      const picked = file.files && file.files[0];
      if (picked) memStudioReadFile(picked);
      try { file.value = ''; } catch (err) { /* ignore */ }
    });
    document.addEventListener('input', (e) => {
      if (state.tab !== 'memory') return;
      const el = e.target.closest('#view-memory [data-studio-input]');
      if (!el) return;
      if (el.getAttribute('data-studio-input') === 'file') return;
      memStudioHandleInput(el);
    });
  }


// ── 记忆整理（独立子页签卡片）：批量整理配置 + 手动触发 + 进度 ──────────────
function memBatchPanelHtml() {
  const mc = (state.config && state.config.memoryCards) || {};
  const hours = Math.round((Number(mc.batchIntervalMs) || 6 * 3600 * 1000) / 3600000);
  const max = Number(mc.batchMaxChats) || 20;
  const includeSilent = mc.batchIncludeSilent === true;
  return `
    <div class="health-card mem-batch-card" style="max-width:720px">
      <div class="h-title">记忆整理（批量）</div>
      <div class="hint" style="margin-bottom:10px">
        定时把所有「有新消息的白名单会话」各整理一次：先整理印象，再生成/更新记忆卡。
        两个通道的记忆按通道映射合并后处理。
      </div>
      <div class="field-row">
        <div class="field"><label>每隔（小时）</label><input type="number" min="1" max="72" step="1" id="mem-batch-hours" value="${hours}" /></div>
        <div class="field"><label>单次最多处理（个会话）</label><input type="number" min="1" max="100" step="1" id="mem-batch-max" value="${max}" /></div>
      </div>
      <div class="checkbox-row"><input type="checkbox" id="mem-batch-silent" ${includeSilent ? 'checked' : ''} />
        <label for="mem-batch-silent">包含静默会话（静默=不花 token 调模型，默认排除）</label></div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap">
        <button class="btn btn-small" id="mem-batch-save">保存设置</button>
        <button class="btn btn-small btn-primary" id="mem-batch-run">立即整理全部</button>
        <span class="muted" id="mem-batch-status" style="font-size:12px"></span>
      </div>
      <div class="hint" style="margin-top:8px">
        说明：整理会调用一次模型/会话（成本随会话数增加）；压缩记忆后头 1–2 轮缓存命中率下降属正常。
      </div>
    </div>`;
}

function memBatchMount() {
  const root = document.getElementById('memory-detail');
  if (!root) return;
  const status = (t) => { const el = root.querySelector('#mem-batch-status'); if (el) el.textContent = t || ''; };
  const hours = root.querySelector('#mem-batch-hours');
  const max = root.querySelector('#mem-batch-max');
  const silent = root.querySelector('#mem-batch-silent');
  [hours, max, silent].forEach((el) => {
    if (el) el.addEventListener('change', () => status('有未保存的配置'));
  });
  const save = root.querySelector('#mem-batch-save');
  if (save) {
    save.addEventListener('click', async () => {
      const h = Number(hours && hours.value) || 6;
      const m = Number(max && max.value) || 20;
      save.disabled = true;
      try {
        state.config = await api('/api/config', {
          method: 'POST',
          body: JSON.stringify({ memoryCards: { batchIntervalMs: h * 3600 * 1000, batchMaxChats: m, batchIncludeSilent: !!(silent && silent.checked) } })
        });
        status('已保存 ✅');
      } catch (err) { status('保存失败：' + (err.message || err)); }
      save.disabled = false;
    });
  }
  const run = root.querySelector('#mem-batch-run');
  if (run) {
    run.addEventListener('click', async () => {
      run.disabled = true;
      status('整理中…');
      try {
        await api('/api/memory-cards/batch', { method: 'POST', body: JSON.stringify({ force: true }) });
        const poll = async () => {
          try {
            const st = await api('/api/memory-cards/batch/status');
            if (st.running) {
              status(`整理中 ${st.done}/${st.total}${st.current ? '：' + String(st.current).slice(0, 18) : ''}`);
              setTimeout(poll, 1500);
            } else {
              const r = st.result || {};
              status(`完成：${r.done || 0}/${r.total || 0} 个会话${r.failed ? '（失败 ' + r.failed + '）' : ''}`);
              run.disabled = false;
            }
          } catch { setTimeout(poll, 2500); }
        };
        setTimeout(poll, 1200);
      } catch (err) {
        status('启动失败：' + (err.message || err));
        run.disabled = false;
      }
    });
  }
}
