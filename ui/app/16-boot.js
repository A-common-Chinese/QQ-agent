/**
 * 启动动画（v0.6.x）
 *
 * 素材：ui/assets/boot/enter.webp（带 alpha 的动画 WebP，3 秒：角色从画面下方升起 → 站直 → 微笑）
 * 流程：角色播放 → 播放到 1.9s 时角色缩小侧移、"QQ Agent" 字样淡入 → 3.0s 整体淡出 → 露出控制台
 *
 * 播放策略 config.ui.bootAnim：
 *   'once'  （默认）装完/更新后第一次启动播一次，之后秒进（localStorage 标记）
 *   'always' 每次启动都播（仍可点击/按键跳过）
 *   'off'    关闭
 *
 * 兜底：prefers-reduced-motion、图片加载失败、素材超过 1.2s 还没就绪 → 直接进界面，绝不卡启动。
 */
(function () {
  const DONE_KEY = 'qqa-boot-played';
  const IMG_SRC = 'assets/boot/enter.webp?v=20261023d';   // 换素材时改这个版本号，避免浏览器拿旧图
  const T_MOVE = 3400;   // 角色完全起身(约2.9s)后再等 0.5s，然后向左平移
  const T_END = 4900;    // 平移到位后再停一下才淡出
  const T_GONE = 5250;   // 彻底移除

  let timers = [];
  let seq = 0;   // 每次创建动画层都换一个 URL，否则 loop=1 的动图第二次不会重播
  let overlay = null;
  let finished = false;

  const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };
  const later = (fn, ms) => { timers.push(setTimeout(fn, ms)); };

  function markPlayed() {
    try { localStorage.setItem(DONE_KEY, String(Date.now())); } catch { /* 忽略 */ }
  }

  function finish(instant) {
    if (finished) return;
    finished = true;
    clearTimers();
    if (!overlay) { markPlayed(); return; }
    const el = overlay;
    overlay = null;
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
      + '<div class="boot-skip">点击任意处跳过</div>';
    const img = el.querySelector('#boot-char');
    seq += 1;
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

    // 素材没就绪也不等它：先把时间线跑起来（低配机器上等图反而更慢），
    // 只有明确报错才立刻收掉动画层。
    img.addEventListener('error', () => finish(true), { once: true });

    const skip = () => finish(false);
    overlay.addEventListener('pointerdown', skip, { once: true });
    if (typeof window.addEventListener === 'function') window.addEventListener('keydown', skip, { once: true });

    later(() => stage.classList.add('go'), T_MOVE);
    later(() => word.classList.add('in'), T_MOVE + 180);
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

  (function boot() {
    try {
      // 同步读本地缓存（由 15-ui-skin 在配置加载/修改时写入），
      // 这样动画第一帧不用等 /api/config，启动不会先白屏一下。
      let mode = 'once';
      try {
        const cached = localStorage.getItem('qqa-boot-mode');
        if (cached === 'off' || cached === 'always' || cached === 'once') mode = cached;
      } catch { /* 忽略 */ }
      if (mode === 'off') return;
      if (mode === 'once') {
        let played = '';
        try { played = localStorage.getItem(DONE_KEY) || ''; } catch { /* 忽略 */ }
        if (played) return;
      }
      play();
      // 后台再对一次配置（比如别的窗口刚把它关了），不一致时缓存同步过来
      api('/api/config').then((cfg) => {
        const v = cfg && cfg.ui && cfg.ui.bootAnim;
        if (v === 'off' || v === 'always' || v === 'once') {
          try { localStorage.setItem('qqa-boot-mode', v); } catch { /* 忽略 */ }
        }
      }).catch(() => {});
    } catch { /* 任何异常都不影响启动 */ }
  })();
})();
