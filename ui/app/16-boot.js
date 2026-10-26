/**
 * 启动动画（v0.6.x）
 *
 * 素材：ui/assets/boot/enter.webp（带 alpha 的动画 WebP，3 秒：角色从画面下方升起 → 站直 → 微笑）
 * 流程：角色播放 → 播放到 1.9s 时角色缩小侧移、"QQ Agent" 字样淡入 → 3.0s 整体淡出 → 露出控制台
 *
 * 播放策略 config.ui.bootAnim：
 *   'once'  （默认）**每天第一次启动** + **每次版本更新后第一次启动**播放，其余启动秒进
 *             （localStorage 记 { ver, date }：版本变了或日期变了就播一次）
 *   'always' 每次启动都播（仍可点击/按键跳过）
 *   'off'    关闭
 *
 * 兜底：prefers-reduced-motion、图片加载失败、素材超过 1.2s 还没就绪 → 直接进界面，绝不卡启动。
 */
(function () {
  const DONE_KEY = 'qqa-boot-played';
  const IMG_SRC = 'assets/boot/enter.webp?v=20261023j';   // 换素材时改这个版本号，避免浏览器拿旧图
  const AUD_SRC = 'assets/boot/enter.m4a?v=20261023j';
  const T_MOVE = 3300;   // 角色完全起身(约2.9s)后再等 0.4s，然后向左平移
  const T_END = 7500;    // 配音按原速 4.05s（从 0:02 到结尾），等它放完再淡出
  const T_GONE = 7850;   // 彻底移除

  let timers = [];
  let seq = 0;   // 每次创建动画层都换一个 URL，否则 loop=1 的动图第二次不会重播
  let overlay = null;
  let finished = false;

  const clearTimers = () => { timers.forEach((t) => (typeof t === 'function' ? t() : clearTimeout(t))); timers = []; };
  const later = (fn, ms) => { timers.push(setTimeout(fn, ms)); };

  let pendingMark = null;   // { ver, date }：真正开始播放后才写，避免加载失败也占掉当天机会

  function todayKey() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function markPlayed() {
    if (!pendingMark) return;
    try { localStorage.setItem(DONE_KEY, JSON.stringify(pendingMark)); } catch { /* 忽略 */ }
  }

  function finish(instant) {
    if (finished) return;
    finished = true;
    clearTimers();
    if (!overlay) { markPlayed(); return; }
    const el = overlay;
    overlay = null;
    try {
      const a = el.querySelector('#boot-audio');
      if (a) { a.pause(); a.removeAttribute('src'); a.load && a.load(); }
    } catch { /* 忽略 */ }
    el.classList.add('out');
    setTimeout(() => el.remove(), instant ? 60 : 340);
    markPlayed();
  }

  function build() {
    const el = document.createElement('div');
    el.id = 'boot-anim';
    el.innerHTML = ''
      + '<div class="boot-stage">'
      + '  <img id="boot-char" alt="" draggable="false">'
      + '</div>'
      + '<div class="boot-word"><span>QQ</span><span>Agent</span></div>'
      + '<audio id="boot-audio" preload="auto"></audio>'
      + '<div class="boot-skip">点击任意处跳过</div>';
    const img = el.querySelector('#boot-char');
    seq += 1;
    const audio = el.querySelector('#boot-audio');
    if (audio) audio.src = AUD_SRC + (AUD_SRC.indexOf('?') >= 0 ? '&' : '?') + 'run=' + seq;
    // 加 run 参数强制当作新资源：动画只播一次(loop=1)，复用同一个 URL 时 Chromium 会停在末帧不重播
    img.src = IMG_SRC + (IMG_SRC.indexOf('?') >= 0 ? '&' : '?') + 'run=' + seq;
    document.body.appendChild(el);
    return el;
  }

  async function play() {
    if (finished || overlay) return;
    try { window.__bootT0 = performance.now(); } catch { /* 忽略 */ }
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) { markPlayed(); return; }
    overlay = build();
    const img = overlay.querySelector('#boot-char');
    const word = overlay.querySelector('.boot-word');
    const stage = overlay.querySelector('.boot-stage');
    const audio = overlay.querySelector('#boot-audio');   // build() 里那个变量出不了作用域

    // 素材没就绪也不等它：先把时间线跑起来（低配机器上等图反而更慢），
    // 只有明确报错才立刻收掉动画层。
    img.addEventListener('error', () => finish(true), { once: true });

    const skip = () => finish(false);
    overlay.addEventListener('pointerdown', skip, { once: true });
    if (typeof window.addEventListener === 'function') window.addEventListener('keydown', skip, { once: true });

    later(() => stage.classList.add('go'), T_MOVE);
    later(() => word.classList.add('in'), T_MOVE + 180);
    // 配音比出字早 0.2 秒起（用户要求），出字前正好铺垫一拍
    later(() => {
      try {
        if (audio) { audio.volume = 0.85; const pr = audio.play(); if (pr && pr.catch) pr.catch(() => {}); }
      } catch { /* 自动播放被拦就静默，不影响动画 */ }
    }, T_MOVE - 20);
    // 淡出前 0.15s 收一下音量（配音此时已快放完）
    later(() => {
      try {
        if (!audio) return;
        let v = audio.volume;
        const t = setInterval(() => {
          v = Math.max(0, v - 0.15);
          audio.volume = v;
          if (v <= 0) { clearInterval(t); try { audio.pause(); } catch { /* 忽略 */ } }
        }, 40);
        timers.push(() => clearInterval(t));
      } catch { /* 忽略 */ }
    }, T_END - 150);
    later(() => finish(false), T_END);
    later(() => { if (overlay) finish(true); }, T_GONE + 50);
  }

  /** 设置页"预览一次"用 */
  window.__bootPreview = function () {
    finished = false;
    clearTimers();
    const old = document.getElementById('boot-anim');
    if (old) old.remove();
    overlay = null;
    return play();
  };

  function readMode() {
    let mode = 'once';
    try {
      const cached = localStorage.getItem('qqa-boot-mode');
      if (cached === 'off' || cached === 'always' || cached === 'once') mode = cached;
    } catch { /* 忽略 */ }
    return mode;
  }

  /**
   * 'once' 的判定：记的是**播过的版本号**。
   * - 首次安装：没有记录 → 播
   * - 升级后：记录 ≠ 当前版本 → 播（以前存的是布尔，升级后就再也不播了，这是个 bug）
   * - 同版本已播过：跳过
   * /api/version 是本地接口（毫秒级），拿不到时退回旧的"播过就不再播"行为。
   */
  async function shouldPlayOnce() {
    let raw = '';
    try { raw = localStorage.getItem(DONE_KEY) || ''; } catch { /* 忽略 */ }
    // 兼容旧格式（以前直接存版本号字符串）
    let playedVer = '', playedDate = '';
    if (raw) {
      try {
        const o = JSON.parse(raw);
        if (o && typeof o === 'object') {
          playedVer = String(o.ver || '');
          playedDate = String(o.date || '');
        } else {
          playedVer = raw;
        }
      } catch { playedVer = raw; }
    }
    let ver = '';
    try {
      const r = await fetch('/api/version', { cache: 'no-store' });
      const j = await r.json();
      ver = String((j && j.version) || '').trim();
    } catch { /* 忽略 */ }
    const today = todayKey();
    pendingMark = { ver, date: today };
    const info = { ver, playedVer, playedDate, today, at: Date.now() };
    try { window.__bootInfo = info; } catch { /* 忽略 */ }
    // 今天已经播过 → 不播（无论版本）
    if (playedDate === today) { info.play = false; return false; }
    // 版本变了 → 播；没有版本信息时按"今天没播过"处理
    info.play = true;
    return true;
  }

  (function boot() {
    try {
      // 同步读本地缓存（由 15-ui-skin 在配置加载/修改时写入），
      // 这样动画第一帧不用等 /api/config，启动不会先白屏一下。
      const mode = readMode();
      if (mode === 'off') return;
      if (mode === 'always') { play(); syncModeFromConfig(); return; }
      shouldPlayOnce().then((yes) => {
        if (yes) play();
        syncModeFromConfig();
      }).catch(() => { /* 判定失败不影响启动 */ });
      return;
    } catch { /* 任何异常都不影响启动 */ }
  })();

  function syncModeFromConfig() {
    try {
      // 后台再对一次配置（比如别的窗口刚把它关了），不一致时缓存同步过来
      api('/api/config').then((cfg) => {
        const v = cfg && cfg.ui && cfg.ui.bootAnim;
        if (v === 'off' || v === 'always' || v === 'once') {
          try { localStorage.setItem('qqa-boot-mode', v); } catch { /* 忽略 */ }
        }
      }).catch(() => {});
    } catch { /* 忽略 */ }
  }
})();
