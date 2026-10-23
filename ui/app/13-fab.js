'use strict';
// 〔右下悬浮菜单〕2026-10 UI 改版第 3 步
// 三条杠 → 向上弹出九条四组：服务 / 扩展 / 社区 / 帮助与维护。
// 说明：市场入口不再放这里 —— Skill/插件市场改成"技能页/插件页内部的按钮"
// （见 06-settings-render.js 的 -market-btn）。这里点市场类操作会去点那两个隐藏的旧按钮，
// 复用 09-community.js 既有逻辑，不复制一份。
(function () {
  const fab = $('#fab');
  const btn = $('#fab-btn');
  const menu = $('#fab-menu');
  if (!fab || !btn || !menu) return;

  const openMenu = () => {
    menu.hidden = false;
    btn.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    reveal();                     // 菜单打开期间保持滑出，否则会被贴边裁掉
  };
  const closeMenu = () => {
    if (menu.hidden) return;
    menu.hidden = true;
    btn.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
    // 关掉菜单后：鼠标不在右下角就缩回去（否则会一直贴着屏幕露着）
    try { if (typeof scheduleHide === 'function') scheduleHide(300); } catch { /* 忽略 */ }
  };

  // ── 贴边/滑出：默认只露 1/3 圆，鼠标靠近右下角（或按钮本身获得焦点）才滑出 ──
  const PEEK = 19;                // 贴边时露出的像素（约 1/3 圆）
  const ZONE_X = 132;             // 距右边缘多少像素内算"靠近"
  const ZONE_Y = 150;
  let hideTimer = 0;
  let keyboardMode = false;
  const nearCorner = (x, y) => (window.innerWidth - x) <= ZONE_X && (window.innerHeight - y) <= ZONE_Y;
  const reveal = () => {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; }
    fab.classList.add('reveal');
  };
  // ⚠️ 不把"按钮有焦点"当作保持滑出的理由：点过按钮后焦点一直留在它身上，
  //    鼠标移开也永远缩不回去（用户实测就是这个现象）。只有键盘操作（Tab）才按焦点保持。
  const hideNow = () => {
    hideTimer = 0;
    if (!menu.hidden) return;                                          // 菜单开着不收起
    if (keyboardMode && fab.contains(document.activeElement)) return;  // 键盘操作中不收起
    fab.classList.remove('reveal');
  };
  const scheduleHide = (delay = 550) => {
    if (!menu.hidden) return;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(hideNow, delay);
  };
  document.addEventListener('mousemove', (e) => {
    if (nearCorner(e.clientX, e.clientY)) reveal(); else scheduleHide();
  }, { passive: true });
  // 光标移出窗口 / 窗口失焦 / 点到别处：都要缩回去
  document.addEventListener('mouseleave', () => scheduleHide(200));
  window.addEventListener('blur', () => scheduleHide(0));
  document.addEventListener('pointerdown', () => { keyboardMode = false; scheduleHide(0); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Tab') keyboardMode = true; }, true);
  fab.addEventListener('pointerenter', reveal);
  fab.addEventListener('pointerleave', () => scheduleHide(350));
  btn.addEventListener('focus', () => { if (keyboardMode) reveal(); });
  // 页面初次渲染时如果鼠标已经停在右下角（比如窗口刚开），直接滑出
  document.addEventListener('pointermove', (e) => {
    if (nearCorner(e.clientX, e.clientY)) reveal();
  }, { passive: true, once: true });
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) openMenu(); else closeMenu();
  });
  menu.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', closeMenu);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

  // ── Bug 反馈：小弹窗（邮箱 + 一键复制 + 版本/系统/日志路径 + 邮件客户端）──
  const BUG_EMAIL = 'noapig@163.com';

  function bugContext(info) {
    const ua = String(navigator.userAgent || '');
    const platform = String(navigator.platform || '');
    return [
      '问题描述：',
      '',
      '',
      '---- 以下信息请保留 ----',
      'QQ Agent 版本：v' + (info.version || '未知'),
      '系统：' + (platform ? platform + ' · ' : '') + ua,
      '数据目录：' + (info.dataDir || '(未知)'),
      '日志目录：' + (info.logDir || '(未知)')
    ].join('\n');
  }

  async function openBugReport() {
    let info = {
      version: (state.status && state.status.version) || '',
      dataDir: '', logDir: ''
    };
    try {
      const v = await api('/api/version');
      if (v) { info.version = v.version || info.version; info.dataDir = v.dataDir || ''; info.logDir = v.logDir || ''; }
    } catch { /* 拿不到就留空，不挡反馈 */ }
    const ctx = bugContext(info);
    const subject = 'QQ Agent Bug 反馈 v' + (info.version || '?');
    const mailto = 'mailto:' + BUG_EMAIL
      + '?subject=' + encodeURIComponent(subject)
      + '&body=' + encodeURIComponent(ctx);

    const ov = document.createElement('div');
    ov.className = 'fab-modal-overlay';
    ov.innerHTML =
      '<div class="fab-modal" role="dialog" aria-modal="true" aria-label="Bug 反馈">'
      + '<h3>Bug 反馈</h3>'
      + '<div class="sub">把问题发到作者邮箱；点「用邮件客户端发送」会自动带上下面的版本与路径信息，你只需补一句问题描述。</div>'
      + '<div class="mail-row">'
      + '<div class="mail-box">' + esc(BUG_EMAIL) + '</div>'
      + '<button class="btn btn-small" data-act="copy">复制邮箱</button>'
      + '</div>'
      + '<div class="info">' + esc(ctx) + '</div>'
      + '<div class="acts">'
      + '<button class="btn btn-small" data-act="close">关闭</button>'
      + '<a class="btn btn-small btn-primary" href="' + esc(mailto) + '">用邮件客户端发送</a>'
      + '</div>'
      + '</div>';
    document.body.appendChild(ov);
    const close = () => { try { ov.remove(); } catch { /* 忽略 */ } };
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); }
    });
    ov.querySelector('[data-act="close"]')?.addEventListener('click', close);
    ov.querySelector('[data-act="copy"]')?.addEventListener('click', async (e) => {
      const b = e.currentTarget;
      let ok = false;
      try { await navigator.clipboard.writeText(BUG_EMAIL); ok = true; } catch { /* 再试 execCommand */ }
      if (!ok) {
        try {
          const ta = document.createElement('textarea');
          ta.value = BUG_EMAIL;
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.select();
          ok = document.execCommand('copy');
          ta.remove();
        } catch { ok = false; }
      }
      b.textContent = ok ? '已复制 ✓' : '复制失败，请手动选中';
      setTimeout(() => { b.textContent = '复制邮箱'; }, 1800);
    });
  }

  // ── 动作分派 ──────────────────────────────────────────────────────────
  const ACTIONS = {
    snowluma: () => switchTab('snowluma'),
    skills: () => switchTab('skills'),
    plugins: () => switchTab('plugins'),
    persona: () => $('#persona-plaza-btn')?.click(),
    site: () => $('#open-site-btn')?.click(),
    bug: () => openBugReport(),
    update: async () => {
      try {
        const data = await runUpdateCheck({ manual: true });
        if (!data || data.ok === false) {
          if (typeof showNoticeModal === 'function') showNoticeModal('检查更新失败', (data && (data.error || data.reason)) || '网络或服务不可用');
          return;
        }
        if (data.hasUpdate && isNewerVersion(data.latest, data.current)) return;  // 已有浮窗提示
        if (typeof showNoticeModal === 'function') showNoticeModal('已是最新版本', '当前 v' + (data.current || '?') + (data.latest ? '（线上 v' + data.latest + '）' : ''));
      } catch (e) {
        if (typeof showNoticeModal === 'function') showNoticeModal('检查更新失败', String((e && e.message) || e));
      }
    },
    datadir: async () => {
      try {
        await api('/api/open-data-dir', { method: 'POST', body: '{}' });
        if (typeof showNoticeModal === 'function') showNoticeModal('已打开', '已在资源管理器打开数据目录。');
      } catch (e) {
        if (typeof showNoticeModal === 'function') showNoticeModal('打开失败', String((e && e.message) || e));
      }
    }
  };

  // 逐项绑监听（不用菜单上的委托：界面的"每个可见交互元素都有事可做"由
  // coverage-wiring 逐个元素核查，委托写法会被判成"可见但没接线"）
  $$('[data-fab]', menu).forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const act = ACTIONS[el.dataset.fab];
      closeMenu();
      if (!act) return;
      try {
        const r = act();
        if (r && typeof r.catch === 'function') r.catch((err) => console.error('[fab] 动作失败:', err));
      } catch (err) {
        console.error('[fab] 动作失败:', err);
      }
    });
  });
})();
