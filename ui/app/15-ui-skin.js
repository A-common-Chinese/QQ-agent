'use strict';
// 〔UI 自定义〕2026-10 改版第 5 步
// 设置 → 外观 → UI 自定义：背景（纯色 / 预设渐变 / 上传图片）、深浅、颜色（4 项 + 高级）、
// 字体（系统字体 + 字号缩放）、侧栏宽度，带实时预览、保存、恢复默认、导出/导入 JSON。
//
// 存储分工：
//   · 颜色/字体/背景类型/侧栏宽度 → data/config.json 的 ui.skin（跟 data 一起备份，升级不丢）
//   · 上传的位图本体 → 本机 localStorage（太大不适合塞 config；换机器/换浏览器不同步）
(function () {
  const IMG_KEY = 'qqa-skin-image';
  const AUTO_KEY = 'qqa-skin-auto';   // 自动配色（含开启前的颜色快照）存本机
  const FAMILIES = {
    '': '系统默认',
    msyh: '"Microsoft YaHei", "微软雅黑"',
    deng: '"DengXian", "等线"',
    simhei: '"SimHei", "黑体"',
    simsun: '"SimSun", "宋体"'
  };
  // 2026-10：预设颜色加深一档；2026-10-23：每个预设再加一层"和名字对应"的纹样，
  // 这样和「纯色」一眼能区分（纯色是平的，预设是有质感的）。全部用 CSS 多层渐变，不加载图片。
  const PRESETS = {
    moon: {
      label: '云白',
      base: '#eef2fa',
      css: 'linear-gradient(160deg, #eef2fa 0%, #d5e1f1 100%)',
      motif: 'radial-gradient(42% 24% at 16% 26%, rgba(255,255,255,.95), transparent 100%),'
        + 'radial-gradient(30% 18% at 44% 16%, rgba(255,255,255,.85), transparent 100%),'
        + 'radial-gradient(36% 22% at 78% 34%, rgba(255,255,255,.8), transparent 100%),'
        + 'radial-gradient(28% 16% at 62% 78%, rgba(255,255,255,.55), transparent 100%)'
    },
    sand: {
      label: '暖砂',
      base: '#f6ead1',
      css: 'linear-gradient(160deg, #f6ead1 0%, #e6cfa4 100%)',
      motif: 'repeating-linear-gradient(102deg, rgba(160,120,60,.085) 0 3px, transparent 3px 10px),'
        + 'radial-gradient(70% 40% at 86% 6%, rgba(255,246,224,.9), transparent 100%),'
        + 'radial-gradient(95% 55% at 50% 118%, rgba(188,148,86,.32), transparent 100%)'
    },
    pine: {
      label: '松绿',
      base: '#e4f1e7',
      css: 'linear-gradient(160deg, #e4f1e7 0%, #c8e0cf 100%)',
      motif: 'repeating-linear-gradient(118deg, rgba(24,84,56,.16) 0 2px, transparent 2px 11px),'
        + 'repeating-linear-gradient(62deg, rgba(24,84,56,.10) 0 2px, transparent 2px 15px),'
        + 'radial-gradient(60% 40% at 18% 86%, rgba(28,98,64,.2), transparent 100%),'
        + 'radial-gradient(50% 34% at 82% 12%, rgba(255,255,255,.5), transparent 100%)'
    },
    mist: {
      label: '雾蓝',
      base: '#e6eefb',
      css: 'linear-gradient(160deg, #e6eefb 0%, #cbdaf0 100%)',
      motif: 'repeating-linear-gradient(0deg, rgba(70,110,175,.12) 0 18px, transparent 18px 54px),'
        + 'radial-gradient(80% 50% at 18% 18%, rgba(255,255,255,.75), transparent 100%),'
        + 'radial-gradient(60% 40% at 86% 82%, rgba(116,156,216,.28), transparent 100%)'
    },
    night: {
      label: '墨夜',
      base: '#0b0f15',
      css: 'linear-gradient(160deg, #0b0f15 0%, #1b2333 100%)',
      motif: 'radial-gradient(1.3px 1.3px at 12% 18%, rgba(255,255,255,.9), transparent 100%),'
        + 'radial-gradient(1px 1px at 31% 8%, rgba(255,255,255,.65), transparent 100%),'
        + 'radial-gradient(1.5px 1.5px at 54% 28%, rgba(255,255,255,.8), transparent 100%),'
        + 'radial-gradient(1px 1px at 72% 13%, rgba(255,255,255,.6), transparent 100%),'
        + 'radial-gradient(1.2px 1.2px at 89% 41%, rgba(255,255,255,.75), transparent 100%),'
        + 'radial-gradient(1px 1px at 21% 63%, rgba(255,255,255,.5), transparent 100%),'
        + 'radial-gradient(1.4px 1.4px at 44% 85%, rgba(255,255,255,.6), transparent 100%),'
        + 'radial-gradient(1px 1px at 78% 71%, rgba(255,255,255,.55), transparent 100%),'
        + 'radial-gradient(125% 95% at 50% 45%, transparent 42%, rgba(0,0,0,.38) 100%)'
    },
    // 角色 / 海报类：自带图片（ui/assets/skins），每张一套排版（靠右站立 / 左边缘渐隐）
    harness: {
      label: '深海海报',
      photo: 'assets/skins/harness.webp',
      base: '#25407e',
      // 铺满：素材本身是 16:9 白底画布（海报居中），所以 cover 时既铺满、四周也是白的
      // 贴右、顶栏下沿到窗口底、左缘渐隐（用户要的 A-2 效果）
      layout: { whiteBg: true, scale: 94, top: 56, offsetX: 0, fade: 20, paneAlpha: 50, alpha: false }
    },
    point: {
      label: '指认',
      photo: 'assets/skins/point.webp',
      base: '#2a3f7a',
      // 缩小一点、整体左移，别压住顶栏
      // 头顶正好抵住顶栏下边线（top=56px），手和脸朝向内容区
      layout: { whiteBg: true, scale: 118, top: 56, offsetX: 64, fade: 40, opacity: 0.9, paneAlpha: 56, alpha: false }
    },
    maid: {
      label: '小鲸鱼',
      photo: 'assets/skins/maid.webp',
      base: '#2b3f7d',
      // 左侧出现、半透明、比原来放大一点：像"站在窗边"的背景角色，不抢内容
      // 左侧、半透明、放大并整体下移：只露上半身（裙摆/脚被窗口底边裁掉）
      layout: { whiteBg: true, side: 'left', scale: 132, top: 130, offsetX: -96, fade: 30, opacity: 0.6, paneAlpha: 68, alpha: false }
    }
  };
  // 透明方式 = 半透明面板本身的效果（backdrop-filter，作用于面板/卡片，不作用于背景图）
  //   直接透明 = 只是变透；毛玻璃 = 面板后面的背景被模糊（经典 glass 效果）
  const BG_MODES = {
    none: { label: '直接透明', filter: 'none' },
    soft: { label: '轻微毛玻璃', filter: 'blur(6px)' },
    strong: { label: '强毛玻璃', filter: 'blur(14px)' },
    frost: { label: '磨砂玻璃', filter: 'blur(10px) saturate(1.2)' }
  };
  const SOLIDS = ['#f7f8fa', '#efe7d8', '#e8efe9', '#e9eef7', '#f3ecf4', '#ffffff'];
  const DEFAULTS = {
    bg: { type: 'preset', color: '', preset: 'maid', blur: 0, dim: 0, fit: 'cover', opacity: 68, mode: 'none' },
    colors: { accent: '', bg: '', card: '', text: '', tx2: '', line: '' },
    font: { family: '', scale: 1 },
    sidebarW: 0
  };

  // ── 根据背景自动配色 ────────────────────────────────────────────────
  // 从背景取一个"基色"，按色相推出一套浅色主题 + 一套深色主题的配色；
  // 开启时记住原来的颜色（skin.auto.prev），关闭时原样还回去。
  function hexToRgb(hex) {
    let s = String(hex || '').trim().replace('#', '');
    if (s.length === 3) s = s.split('').map((c) => c + c).join('');
    if (!/^[0-9a-f]{6}$/i.test(s)) return null;
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  }
  function rgbToHsl([r, g, b]) {
    const R = r / 255, G = g / 255, B = b / 255;
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
    const l = (mx + mn) / 2;
    let h = 0, s = 0;
    if (mx !== mn) {
      const d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === R) h = ((G - B) / d + (G < B ? 6 : 0));
      else if (mx === G) h = (B - R) / d + 2;
      else h = (R - G) / d + 4;
      h *= 60;
    }
    return [h, s, l];
  }
  const hsl = (h, s, l) => `hsl(${Math.round(((h % 360) + 360) % 360)} ${Math.round(Math.min(100, Math.max(0, s)))}% ${Math.round(Math.min(100, Math.max(0, l)))}%)`;

  function buildPalette(baseHex, theme) {
    const rgb = hexToRgb(baseHex) || [210, 222, 240];
    const [h, s, l] = rgbToHsl(rgb);
    const sat = s * 100, lig = l * 100;
    if (theme === 'dark') {
      return {
        accent: hsl(h, Math.min(72, Math.max(48, sat * 0.85 + 34)), 62),
        bg: hsl(h, Math.min(26, sat * 0.5 + 6), 9),
        card: hsl(h, Math.min(24, sat * 0.45 + 5), 14),
        text: hsl(h, 12, 94),
        tx2: hsl(h, 10, 70),
        line: hsl(h, 14, 25)
      };
    }
    return {
      accent: hsl(h, Math.min(74, Math.max(46, sat * 0.9 + 28)), 40),
      bg: hsl(h, Math.min(42, sat * 0.6 + 10), Math.max(93, 99 - lig * 0.04)),
      card: hsl(h, Math.min(30, sat * 0.4 + 4), 99),
      text: hsl(h, Math.min(30, sat * 0.4 + 10), 14),
      tx2: hsl(h, 14, 40),
      line: hsl(h, Math.min(30, sat * 0.5 + 10), 88)
    };
  }

  /** 背景的"基色"：纯色取色值 / 预设取 base / 图片取平均色 */
  function baseColorOf(skin, cb) {
    const bg = (skin && skin.bg) || {};
    if (bg.type === 'image') {
      const img = readImage();
      if (!img) { cb('#9fb4cf'); return; }
      const im = new Image();
      im.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = 24; c.height = 24;
          const g = c.getContext('2d');
          g.drawImage(im, 0, 0, 24, 24);
          const d = g.getImageData(0, 0, 24, 24).data;
          let r = 0, gg = 0, b = 0, n = 0;
          for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n += 1; }
          cb('#' + [r / n, gg / n, b / n].map((v) => Math.round(v).toString(16).padStart(2, '0')).join(''));
        } catch { cb('#9fb4cf'); }
      };
      im.onerror = () => cb('#9fb4cf');
      im.src = img;
      return;
    }
    if (bg.type === 'preset' && PRESETS[bg.preset] && PRESETS[bg.preset].base) { cb(PRESETS[bg.preset].base); return; }
    cb(bg.color || (skin.colors && skin.colors.bg) || '#eef2fa');
  }

  /** 重新计算两套自动配色（不改变开关状态） */
  function recomputeAuto(done) {
    baseColorOf(S.skin, (base) => {
      const auto = S.skin.auto || {};
      auto.light = buildPalette(base, 'light');
      auto.dark = buildPalette(base, 'dark');
      auto.base = base;
      S.skin.auto = auto;
      if (done) done();
    });
  }

  const resolvedTheme = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  function colorsForApply(skin) {
    const auto = skin && skin.auto;
    if (auto && auto.on) {
      const pal = auto[resolvedTheme()] || auto.light;
      if (pal) return pal;
    }
    return (skin && skin.colors) || {};
  }

  const S = { skin: clone(DEFAULTS), saved: false, dirty: false, bootAnim: 'once' };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function mergeSkin(raw) {
    const out = clone(DEFAULTS);
    const s = raw && typeof raw === 'object' ? raw : {};
    out.bg = Object.assign(out.bg, s.bg || {});
    out.colors = Object.assign(out.colors, s.colors || {});
    out.font = Object.assign(out.font, s.font || {});
    out.sidebarW = Number(s.sidebarW) || 0;
    return out;
  }
  function readImage() {
    try { return localStorage.getItem(IMG_KEY) || ''; } catch { return ''; }
  }
  function readAuto() {
    try {
      const raw = localStorage.getItem(AUTO_KEY);
      if (!raw) return null;
      const v = JSON.parse(raw);
      return v && v.on ? v : null;
    } catch { return null; }
  }
  function writeAuto(auto) {
    try { localStorage.setItem(AUTO_KEY, JSON.stringify(auto)); } catch { /* 忽略 */ }
  }
  function clearAuto() {
    try { localStorage.removeItem(AUTO_KEY); } catch { /* 忽略 */ }
  }


  // ── 应用皮肤 ──────────────────────────────────────────────────────────
  function applySkin(skin) {
    const root = document.documentElement;
    const c = colorsForApply(skin);
    const setVar = (k, v) => {
      if (v) root.style.setProperty(k, v);
      else root.style.removeProperty(k);
    };
    setVar('--ac', c.accent);
    setVar('--bg0', c.bg);
    setVar('--bg2', c.card);
    setVar('--tx', c.text);
    setVar('--tx2', c.tx2);
    setVar('--bd', c.line);

    const f = (skin && skin.font) || {};
    const fam = FAMILIES[f.family] || '';
    if (fam) root.style.setProperty('--font-ui', fam + ', system-ui, -apple-system, sans-serif');
    else root.style.removeProperty('--font-ui');
    // 字号缩放：body 固定了 14px，改根字号不管用；用 zoom 整体缩放并补偿宽高，
    // 否则 100vh/100vw 会被放大而裁掉底部/右侧
    const scale = Math.min(1.15, Math.max(0.9, Number(f.scale) || 1));
    const app = document.getElementById('app');
    if (app) {
      if (Math.abs(scale - 1) > 0.001) {
        app.style.zoom = String(scale);
        app.style.width = 'calc(100vw / ' + scale + ')';
        app.style.height = 'calc(100vh / ' + scale + ')';
        app.classList.add('ui-zoomed');
      } else {
        app.style.zoom = '';
        app.style.width = '';
        app.style.height = '';
        app.classList.remove('ui-zoomed');
      }
    }

    const w = Number(skin && skin.sidebarW) || 0;
    if (w >= 180 && w <= 320) root.style.setProperty('--sidebar-w', w + 'px');
    else root.style.removeProperty('--sidebar-w');

    // 背景层：纯色 / 预设渐变 / 上传图片，三者都支持透明度与"透明方式"（模糊档）
    const bg = (skin && skin.bg) || {};
    let layer = document.getElementById('skin-bg');
    const image = readImage();
    const showImage = bg.type === 'image' && image;
    const showPreset = bg.type === 'preset' && PRESETS[bg.preset];
    const presetDef = showPreset ? PRESETS[bg.preset] : null;
    const showPhotoPreset = !!(presetDef && presetDef.photo);
    const solidColor = bg.color || (skin && skin.colors && skin.colors.bg) || '';
    const showSolid = bg.type === 'solid' && !!solidColor;
    if (!showImage && !showPreset && !showSolid) {
      if (layer) layer.remove();
      root.style.removeProperty('--skin-dim');
      root.style.setProperty('--skin-motif', 'none');
      document.body.classList.remove('skin-bg-on');
      return;
    }
    document.body.classList.add('skin-bg-on');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'skin-bg';
      document.body.insertBefore(layer, document.body.firstChild);
    }
    // 背景本体
    if (showImage) {
      layer.style.backgroundImage = 'url("' + image + '")';
      layer.style.backgroundColor = 'transparent';
      layer.style.backgroundSize = bg.fit === 'contain' ? 'contain' : bg.fit === 'repeat' ? 'auto' : 'cover';
      layer.style.backgroundRepeat = bg.fit === 'repeat' ? 'repeat' : 'no-repeat';
    } else if (showPreset && showPhotoPreset) {
      // 图片预设：背景层自己不上色，图片由 #skin-photo 画（可做靠右/渐隐/缩放）
      layer.style.backgroundImage = 'none';
      layer.style.backgroundColor = 'transparent';
      layer.style.backgroundSize = 'auto';
      layer.style.backgroundRepeat = 'no-repeat';
    } else if (showPreset) {
      layer.style.backgroundImage = PRESETS[bg.preset].css;
      layer.style.backgroundColor = 'transparent';
      layer.style.backgroundSize = 'cover';
      layer.style.backgroundRepeat = 'no-repeat';
    } else {
      layer.style.backgroundImage = 'none';
      layer.style.backgroundColor = solidColor;
    }
    // 预设纹样：只在该预设生效时显示（#skin-bg::before 读取这个变量）
    root.style.setProperty('--skin-motif', showPreset && PRESETS[bg.preset].motif ? PRESETS[bg.preset].motif : 'none');
    // 背景层本身永远不透明：透明度调的是"面板/卡片"，否则调低只会露出底色（看着像变黑）
    layer.style.opacity = '1';
    layer.style.filter = showImage && Number(bg.blur) > 0 ? 'blur(' + Number(bg.blur) + 'px)' : '';
    // 卡片/面板透明度（0-100）：越低，背景越透出来
    const alpha = bg.opacity === undefined ? 100 : Math.min(100, Math.max(0, Number(bg.opacity)));
    root.style.setProperty('--skin-alpha', alpha + '%');
    // 透明方式：面板的毛玻璃效果
    const mode = BG_MODES[bg.mode] ? bg.mode : 'none';
    root.style.setProperty('--skin-panel-filter', BG_MODES[mode].filter);
    const dim = showImage ? Number(bg.dim) || 0 : 0;
    root.style.setProperty('--skin-dim', dim > 0 ? 'rgba(0,0,0,' + Math.min(0.8, dim / 100) + ')' : 'transparent');
    renderPhotoPreset(showPhotoPreset ? presetDef : null);
  }

  /**
   * 图片预设的排版：靠右站立 / 左边缘渐隐 / 高度与上下偏移由预设自己的 layout 决定。
   * 用 <img> 而不是 background-image，才能"按高度缩放 + 底边对齐 + 渐隐遮罩"。
   */
  function renderPhotoPreset(def) {
    const layer = document.getElementById('skin-bg');
    if (!layer) return;
    let img = document.getElementById('skin-photo');
    if (!def) { if (img) img.remove(); const sc = document.getElementById('skin-scrim'); if (sc) sc.remove(); return; }
    const L = def.layout || {};
    if (!img) {
      img = document.createElement('img');
      img.id = 'skin-photo';
      img.alt = '';
      img.decoding = 'async';
      img.draggable = false;
      layer.appendChild(img);
    }
    if (img.getAttribute('src') !== def.photo) img.setAttribute('src', def.photo);
    img.removeAttribute('style');
    // scrim：整屏铺满时用一层主题自适应遮罩保证面板文字可读
    let scrim = document.getElementById('skin-scrim');
    if (L.bleed && L.scrim) {
      if (!scrim) {
        scrim = document.createElement('div');
        scrim.id = 'skin-scrim';
        layer.appendChild(scrim);
      }
      // 白底类预设（whiteBg）在任何主题下都压白：否则深色主题会把白底压成灰黑，看起来又"发黑"了
      const dark = resolvedTheme() === 'dark' && !L.whiteBg;
      scrim.style.background = dark
        ? 'rgba(0,0,0,' + Math.min(0.8, L.scrim + 0.12) + ')'
        : 'rgba(255,255,255,' + L.scrim + ')';
    } else if (scrim) {
      scrim.remove();
    }
    if (L.whiteBg) layer.style.backgroundColor = '#fff';
    if (L.bleed) {
      // 整屏铺满：顶部对齐裁切
      img.style.left = '0'; img.style.right = '0'; img.style.top = '0'; img.style.bottom = '0';
      img.style.width = '100%'; img.style.height = '100%';
      img.style.maxWidth = 'none';   // CSS 里给靠右站位留的 max-width:62vw 会在这里把画布截窄
      // contain：白底铺满窗口、海报完整居中（不裁切）；cover：素材自带白边时整屏裁切
      img.style.objectFit = L.contain ? 'contain' : 'cover';
      img.style.objectPosition = L.contain ? 'center center' : 'top center';
      img.style.opacity = '1';
      img.style.filter = 'none';
      return;
    }
    img.style.height = (L.scale || 92) + 'vh';
    // 两种垂直锚定：给 top 就"头顶贴线"，否则底边对齐再上移 offsetY
    if (L.top !== undefined) {
      img.style.top = L.top + 'px';
    } else {
      img.style.bottom = (L.offsetY || 0) + 'px';
    }
    const left = L.side === 'left';
    img.style.left = left ? ((L.offsetX || 0) + 'px') : '';
    img.style.right = left ? '' : ((L.offsetX || 0) * -1 + 'px');
    const to = left ? 'to left' : 'to right';
    img.style.maskImage = 'linear-gradient(' + to + ', transparent 0%, #000 ' + (L.fade || 30) + '%)';
    img.style.webkitMaskImage = img.style.maskImage;
    img.style.opacity = String(L.opacity === undefined ? 1 : L.opacity);
    img.style.filter = L.alpha === false ? 'none' : 'drop-shadow(0 10px 28px rgba(0,0,0,.16))';
  }

  // ── 面板 HTML ─────────────────────────────────────────────────────────
  function swatchRow() {
    const cur = S.skin.colors.bg || '';
    return '<div class="skin-line">'
      + SOLIDS.map((c) => `<button class="skin-swatch${cur.toLowerCase() === c.toLowerCase() ? ' on' : ''}" style="background:${c}" data-skin-solid="${c}" title="${c}"></button>`).join('')
      + `<label class="skin-color">自定义 <input type="color" id="skin-color-bg" value="${esc(cur || '#f7f8fa')}"></label>`
      + '</div>';
  }
  function presetRow() {
    const bg = S.skin.bg || {};
    return '<div class="skin-line">'
      + Object.entries(PRESETS).map(([id, p]) => {
        const on = bg.type === 'preset' && bg.preset === id ? ' on' : '';
        if (p.photo) return `<button class="skin-preset skin-preset-photo${on}" data-skin-preset="${id}" title="${esc(p.label)}"><img src="${p.photo}" alt=""><span>${p.label}</span></button>`;
        const img = p.motif ? p.css + ', ' + p.motif : p.css;
        return `<button class="skin-preset${on}" style="background-image:${img};background-size:cover" data-skin-preset="${id}"><span>${p.label}</span></button>`;
      }).join('')
      + `<button class="skin-btn" id="skin-upload-btn">上传图片</button>`
      + '<input type="file" id="skin-file" accept="image/png,image/jpeg,image/webp" style="display:none">'
      + '</div>'
      + '<div class="skin-note">预设带各自纹理（云团 / 沙丘 / 松针 / 雾带 / 星点），和上面的纯色底不是一类；后三张是白底插画，选中时若在深色主题会自动切到浅色；上传图片只保存在本机（≤2MB，png/jpg/webp），换机器需要重新上传。</div>';
  }
  function imageOptionsRow() {
    const bg = S.skin.bg || {};
    if (bg.type !== 'image') return '';
    const blur = Math.min(20, Math.max(0, Number(bg.blur) || 0));
    const dim = Math.min(80, Math.max(0, Number(bg.dim) || 0));
    // 滑块 + 数字框：滑块拖着看效果，数字框能精确输入（一边动、另一边同步）
    return '<div class="skin-ranges">'
      + '<div class="skin-range"><span class="skin-range-lbl">模糊</span>'
      + `<input type="range" id="skin-blur-range" min="0" max="20" step="1" value="${blur}">`
      + `<input class="skin-num" type="number" id="skin-blur" min="0" max="20" step="1" value="${blur}">`
      + '<span class="skin-range-unit">px</span></div>'
      + '<div class="skin-range"><span class="skin-range-lbl">变暗</span>'
      + `<input type="range" id="skin-dim-range" min="0" max="80" step="5" value="${dim}">`
      + `<input class="skin-num" type="number" id="skin-dim" min="0" max="80" step="5" value="${dim}">`
      + '<span class="skin-range-unit">%</span></div>'
      + '<div class="skin-range"><span class="skin-range-lbl">铺法</span>'
      + '<select class="skin-num" id="skin-fit" style="width:110px">'
      + ['cover|铺满', 'contain|居中', 'repeat|平铺'].map((x) => { const [v, l] = x.split('|'); return `<option value="${v}"${bg.fit === v ? ' selected' : ''}>${l}</option>`; }).join('')
      + '</select>'
      + '<button class="skin-btn" id="skin-clear-image">去掉图片</button>'
      + '</div></div>';
  }
  function colorRow(label, key) {
    const v = S.skin.colors[key] || '';
    return '<label class="skin-color" style="margin-right:14px">' + label
      + ` <input type="color" id="skin-c-${key}" value="${esc(v || defaultColorOf(key))}">`
      + `<button class="skin-btn" data-skin-clear="${key}" title="恢复默认">↺</button></label>`;
  }
  function defaultColorOf(key) {
    const map = { accent: '#3a62cd', bg: '#f7f8fa', card: '#ffffff', text: '#1b1e27', tx2: '#5a6474', line: '#dfe3ea' };
    return map[key] || '#ffffff';
  }

  function previewHtml() {
    return '<div class="skin-preview" id="skin-preview">'
      + '<div class="sp-row"><div class="sp-side" style="width:' + Math.min(96, Math.max(52, (S.skin.sidebarW || 236) / 3)) + 'px">'
      + '<div class="sp-dot on"></div><div class="sp-dot"></div><div class="sp-dot"></div><div class="sp-dot"></div></div>'
      + '<div class="sp-main"><b>实时预览</b><div style="margin-top:6px;line-height:1.7">正文文字 Aa 123<br>'
      + '<span style="color:var(--ac)">主色 / 链接</span> · <span style="color:var(--tx3)">次要文字</span></div></div></div>'
      + '<div class="skin-note">改任何一项立即生效；点「保存」才会写进配置（换设备也保留）。</div></div>';
  }

  function opacityVal() {
    const v = S.skin.bg && S.skin.bg.opacity;
    return v === undefined ? 80 : Math.min(100, Math.max(0, Number(v) || 0));
  }

  function renderSkinPanel() {
    const bg = S.skin.bg || {};
    return `
    <h3 id="settings-ui">UI 自定义</h3>
    <p class="setsub">背景 / 深浅 / 颜色 / 字体 / 侧栏宽度 —— 改完全界面即时生效，保存后写进配置</p>
    <div class="setcard"><div class="skin-wrap">
      <div class="skin-col">
        <div class="skin-row"><div class="skin-lbl">背景（纯色）</div>${swatchRow()}</div>
        <div class="skin-row"><div class="skin-lbl">背景（预设 / 图片）</div>${presetRow()}${imageOptionsRow()}</div>
        <div class="skin-row"><div class="skin-lbl">卡片透明度与透明方式</div>
          <div class="skin-note" style="margin:0 0 6px">调低后侧栏 / 列表 / 卡片会变半透明，背景从后面透出来（背景图本身不受影响）</div>
          <div class="skin-range"><span class="skin-range-lbl">卡片透明度</span>
            <input type="range" id="skin-opacity-range" min="0" max="100" step="5" value="${opacityVal()}">
            <input class="skin-num" id="skin-opacity" type="number" min="0" max="100" step="5" value="${opacityVal()}">
            <span class="skin-range-unit">%</span></div>
          <div class="skin-line" style="margin-top:8px">
            ${Object.entries(BG_MODES).map(([id, m]) => `<button class="skin-btn${(S.skin.bg.mode || 'none') === id ? ' on' : ''}" data-skin-mode="${id}">${m.label}</button>`).join('')}
          </div>
        </div>
        <div class="skin-row"><div class="skin-lbl">深浅</div>
          <div class="skin-line">
            ${[['light', '浅色'], ['dark', '深色'], ['auto', '跟随系统']].map(([v, l]) => `<button class="skin-btn${getThemePref() === v ? ' on' : ''}" data-skin-theme="${v}">${l}</button>`).join('')}
          </div>
        </div>
        <div class="skin-row"><div class="skin-lbl">根据背景自动配色</div>
          <div class="skin-line">
            <button class="skin-btn${S.skin.auto && S.skin.auto.on ? ' primary' : ''}" id="skin-auto-toggle">${S.skin.auto && S.skin.auto.on ? '已开启（点此关闭并还原）' : '开启自动配色'}</button>
            ${S.skin.auto && S.skin.auto.on
              ? `<span class="skin-note" style="margin:0">浅色主题：<i class="skin-dot" style="background:${esc((S.skin.auto.light || {}).accent || '#888')}"></i><i class="skin-dot" style="background:${esc((S.skin.auto.light || {}).bg || '#eee')}"></i><i class="skin-dot" style="background:${esc((S.skin.auto.light || {}).card || '#fff')}"></i> 深色主题：<i class="skin-dot" style="background:${esc((S.skin.auto.dark || {}).accent || '#888')}"></i><i class="skin-dot" style="background:${esc((S.skin.auto.dark || {}).bg || '#111')}"></i><i class="skin-dot" style="background:${esc((S.skin.auto.dark || {}).card || '#1b1b1b')}"></i></span>`
              : ''}
          </div>
          <div class="skin-note" style="margin:6px 0 0">开启后按背景基色自动给浅色/深色两套配色（随主题切换）；会记住你开启前的颜色，关闭时自动还原。</div>
        </div>
        <div class="skin-row"><div class="skin-lbl">颜色${S.skin.auto && S.skin.auto.on ? '（自动配色中，手动修改会先关掉自动）' : ''}</div>
          <div class="skin-line">${colorRow('主色', 'accent')}${colorRow('页面底色', 'bg')}${colorRow('卡片', 'card')}${colorRow('正文', 'text')}</div>
          <div class="skin-adv${S.adv ? ' open' : ''}" id="skin-adv">
            ${colorRow('次要文字', 'tx2')}${colorRow('分隔线', 'line')}
          </div>
          <button class="skin-btn" id="skin-adv-toggle" style="margin-top:8px">${S.adv ? '收起高级' : '高级：逐项覆盖'}</button>
        </div>
        <div class="skin-row"><div class="skin-lbl">字体</div>
          <div class="skin-line">
            <select class="skin-num" id="skin-font-family" style="width:170px">
              ${Object.entries(FAMILIES).map(([v, l]) => `<option value="${v}"${S.skin.font.family === v ? ' selected' : ''}>${l}</option>`).join('')}
            </select>
            <label class="skin-color">字号 <input type="range" id="skin-font-scale" min="0.9" max="1.15" step="0.05" value="${S.skin.font.scale || 1}"><b id="skin-scale-label">${Math.round((S.skin.font.scale || 1) * 100)}%</b></label>
          </div>
        </div>
        <div class="skin-row"><div class="skin-lbl">侧栏宽度</div>
          <div class="skin-line">
            <input class="skin-num" type="number" id="skin-sidebar-w" min="180" max="320" step="1" value="${S.skin.sidebarW || 236}"> px
            <button class="skin-btn" id="skin-sidebar-reset">恢复默认 236</button>
            <span class="skin-note">也可以直接拖主栏右边缘调</span>
          </div>
        </div>
        <div class="skin-row"><div class="skin-lbl">启动动画</div>
          <div class="skin-line">
            <button class="skin-btn skin-boot-btn${S.bootAnim === 'once' ? ' on' : ''}" data-boot-anim="once">仅一次</button>
            <button class="skin-btn skin-boot-btn${S.bootAnim === 'always' ? ' on' : ''}" data-boot-anim="always">总是</button>
            <button class="skin-btn skin-boot-btn${S.bootAnim === 'off' ? ' on' : ''}" data-boot-anim="off">关闭</button>
            <button class="skin-btn" id="skin-boot-preview">预览一次</button>
          </div>
          <div class="skin-note" style="margin:6px 0 0">默认「仅一次」：装完 / 更新后第一次启动播一遍角色动画，之后秒进；播放中点击任意处可跳过。</div>
        </div>
        <div class="skin-actions">
          <button class="skin-btn primary" id="skin-save">保存</button>
          <button class="skin-btn" id="skin-reset">恢复全部默认</button>
          <button class="skin-btn" id="skin-export">导出主题</button>
          <button class="skin-btn" id="skin-import">导入主题</button>
          <input type="file" id="skin-import-file" accept="application/json,.json" style="display:none">
          <span class="skin-note" id="skin-save-hint">${S.saved ? '已保存 ✓' : ''}</span>
        </div>
      </div>
      ${previewHtml()}
    </div></div>`;
  }

  // ── 变更处理 ──────────────────────────────────────────────────────────
  function touch() {
    S.dirty = true;
    S.saved = false;
    applySkin(S.skin);
    const hint = document.getElementById('skin-save-hint');
    if (hint) hint.textContent = '未保存';
  }
  function rerender() {
    const box = document.getElementById('settings-form');
    if (box && state.tab === 'settings' && state.settingsSection === 'ui' && typeof renderSettings === 'function') {
      renderSettings();
    }
  }

  window.__bindSkinPanel = function () {
    const panel = document.getElementById('settings-ui');
    if (!panel) return;
    const $id = (x) => document.getElementById(x);

    document.querySelectorAll('[data-skin-solid]').forEach((el) => el.addEventListener('click', () => {
      S.skin.bg.type = 'solid';
      S.skin.colors.bg = el.dataset.skinSolid;
      touch();
      recolorIfAuto();
      rerender();
    }));
    $id('skin-color-bg')?.addEventListener('input', (e) => {
      S.skin.bg.type = 'solid';
      S.skin.colors.bg = e.currentTarget.value;
      touch();
      recolorIfAuto();
      rerender();
    });
    document.querySelectorAll('[data-skin-preset]').forEach((el) => el.addEventListener('click', () => {
      S.skin.bg.type = 'preset';
      S.skin.bg.preset = el.dataset.skinPreset;
      S.skin.colors.bg = '';
      // 图片类预设自带"建议面板透明度"：不改的话 80% 不透明的面板会把背景图压成水印
      const pdef = PRESETS[S.skin.bg.preset];
      if (pdef && pdef.layout && pdef.layout.paneAlpha) S.skin.bg.opacity = pdef.layout.paneAlpha;
      // 白底插画（whiteBg）在深色主题下必然发灰发黑（深色面板压在白底上），
      // 选中时直接切到浅色主题；想回深色可以点左下角的主题按钮。
      if (pdef && pdef.layout && pdef.layout.whiteBg && resolvedTheme() === 'dark' && typeof applyTheme === 'function') {
        applyTheme('light');
        api('/api/config', { method: 'POST', body: JSON.stringify({ ui: { theme: 'light' } }) }).catch(() => {});
      }
      touch();
      recolorIfAuto();
      rerender();
    }));
    $id('skin-upload-btn')?.addEventListener('click', () => $id('skin-file')?.click());
    $id('skin-file')?.addEventListener('change', (e) => {
      const f = e.currentTarget.files && e.currentTarget.files[0];
      if (!f) return;
      if (f.size > 2 * 1024 * 1024) {
        if (typeof showNoticeModal === 'function') showNoticeModal('图片太大', '请选 2MB 以内的 png / jpg / webp。');
        return;
      }
      const fr = new FileReader();
      fr.onload = () => {
        try { localStorage.setItem(IMG_KEY, String(fr.result)); } catch {
          if (typeof showNoticeModal === 'function') showNoticeModal('保存失败', '本机存储空间不足，换张小一点的图片试试。');
          return;
        }
        S.skin.bg.type = 'image';
        S.skin.bg.preset = '';
        touch();
        recolorIfAuto();
        rerender();
      };
      fr.readAsDataURL(f);
    });
    $id('skin-clear-image')?.addEventListener('click', () => {
      try { localStorage.removeItem(IMG_KEY); } catch { /* 忽略 */ }
      S.skin.bg.type = 'solid';
      touch();
      rerender();
    });
    // 背景透明度：滑块 + 数字，双向同步
    {
      const rangeEl = $id('skin-opacity-range');
      const numEl = $id('skin-opacity');
      const applyOpacity = (raw, from) => {
        const v = Math.min(100, Math.max(0, Number(raw) || 0));
        S.skin.bg.opacity = v;
        if (rangeEl && from !== 'range') rangeEl.value = String(v);
        if (numEl && from !== 'num') numEl.value = String(v);
        touch();
      };
      rangeEl?.addEventListener('input', (e) => applyOpacity(e.currentTarget.value, 'range'));
      numEl?.addEventListener('input', (e) => applyOpacity(e.currentTarget.value, 'num'));
    }
    // 透明方式（模糊档）
    document.querySelectorAll('[data-skin-mode]').forEach((el) => el.addEventListener('click', () => {
      S.skin.bg.mode = el.dataset.skinMode;
      touch();
      rerender();
    }));

    // 模糊 / 变暗：滑块与数字框双向同步（滑块即时应用，数字框精确输入）
    const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));
    const syncPair = (key, lo, hi, commit) => {
      const rangeEl = $id('skin-' + key + '-range');
      const numEl = $id('skin-' + key);
      const apply = (raw, fromRange) => {
        const v = clampNum(raw, lo, hi);
        S.skin.bg[key] = v;
        if (rangeEl && fromRange !== 'range') rangeEl.value = String(v);
        if (numEl && fromRange !== 'num') numEl.value = String(v);
        touch();
      };
      rangeEl?.addEventListener('input', (e) => apply(e.currentTarget.value, 'range'));
      numEl?.addEventListener('input', (e) => apply(e.currentTarget.value, 'num'));
      numEl?.addEventListener('change', (e) => apply(e.currentTarget.value, 'num'));
    };
    syncPair('blur', 0, 20);
    syncPair('dim', 0, 80);
    $id('skin-fit')?.addEventListener('change', (e) => { S.skin.bg.fit = e.currentTarget.value; touch(); });

    document.querySelectorAll('[data-skin-theme]').forEach((el) => el.addEventListener('click', () => {
      applyTheme(el.dataset.skinTheme);
      api('/api/config', { method: 'POST', body: JSON.stringify({ ui: { theme: el.dataset.skinTheme } }) }).catch(() => {});
      rerender();
    }));
    document.querySelectorAll('[data-skin-clear]').forEach((el) => el.addEventListener('click', () => {
      S.skin.colors[el.dataset.skinClear] = '';
      touch();
      rerender();
    }));
    // 启动动画：三档 + 预览
    document.querySelectorAll('[data-boot-anim]').forEach((el) => el.addEventListener('click', () => {
      S.bootAnim = el.dataset.bootAnim;
      try { localStorage.setItem('qqa-boot-mode', S.bootAnim); } catch { /* 忽略 */ }
      api('/api/config', { method: 'POST', body: JSON.stringify({ ui: { bootAnim: S.bootAnim } }) }).catch(() => {});
      rerender();
    }));
    $id('skin-boot-preview')?.addEventListener('click', () => {
      if (typeof window.__bootPreview === 'function') window.__bootPreview();
    });
    // 背景一变，自动配色要跟着重算（图片是异步取平均色）
    const recolorIfAuto = () => {
      if (!(S.skin.auto && S.skin.auto.on)) return;
      recomputeAuto(() => { writeAuto(S.skin.auto); applySkin(S.skin); });
    };
    // 自动配色：开 / 关（关闭时还原开启前保存的颜色）
    $id('skin-auto-toggle')?.addEventListener('click', () => {
      const auto = S.skin.auto || {};
      if (auto.on) {
        // 关闭：还原开启前的颜色（快照存在 auto.prev 里）
        if (auto.prev) S.skin.colors = Object.assign({}, DEFAULTS.colors, auto.prev);
        S.skin.auto = { on: false, prev: null, light: null, dark: null, base: '' };
        clearAuto();
        applySkin(S.skin);
        rerender();
        return;
      }
      const prev = Object.assign({}, S.skin.colors);
      S.skin.auto = { on: true, prev, light: null, dark: null, base: '' };
      recomputeAuto(() => {
        writeAuto(S.skin.auto);
        applySkin(S.skin);
        rerender();
      });
    });
    // 颜色手改 → 自动配色先关掉（否则改了也看不见）
    const kickAutoOff = () => {
      if (S.skin.auto && S.skin.auto.on) {
        const prev = Object.assign({}, S.skin.auto.prev || S.skin.colors);
        S.skin.auto = { on: false, prev: null, light: null, dark: null, base: '' };
        S.skin.colors = prev;
      }
    };
    ['accent', 'bg', 'card', 'text', 'tx2', 'line'].forEach((k) => $id('skin-c-' + k)?.addEventListener('input', (e) => {
      kickAutoOff();
      S.skin.colors[k] = e.currentTarget.value;
      touch();
    }));
    $id('skin-adv-toggle')?.addEventListener('click', () => { S.adv = !S.adv; rerender(); });
    $id('skin-font-family')?.addEventListener('change', (e) => { S.skin.font.family = e.currentTarget.value; touch(); });
    $id('skin-font-scale')?.addEventListener('input', (e) => {
      S.skin.font.scale = Number(e.currentTarget.value) || 1;
      const l = $id('skin-scale-label');
      if (l) l.textContent = Math.round(S.skin.font.scale * 100) + '%';
      touch();
    });
    $id('skin-sidebar-w')?.addEventListener('change', (e) => {
      const v = Number(e.currentTarget.value) || 236;
      S.skin.sidebarW = Math.min(320, Math.max(180, v));
      touch();
    });
    $id('skin-sidebar-reset')?.addEventListener('click', () => {
      S.skin.sidebarW = 0;
      try { localStorage.removeItem('qqa-sidebar-w'); } catch { /* 忽略 */ }
      document.documentElement.style.removeProperty('--sidebar-w');
      touch();
      rerender();
    });
    $id('skin-save')?.addEventListener('click', () => saveSkin());
    $id('skin-reset')?.addEventListener('click', () => {
      S.skin = clone(DEFAULTS);
      try { localStorage.removeItem(IMG_KEY); } catch { /* 忽略 */ }
      applySkin(S.skin);
      saveSkin();
      rerender();
    });
    $id('skin-export')?.addEventListener('click', () => {
      const data = JSON.stringify(clone(S.skin), null, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'qq-agent-theme.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
    $id('skin-import')?.addEventListener('click', () => $id('skin-import-file')?.click());
    $id('skin-import-file')?.addEventListener('change', (e) => {
      const f = e.currentTarget.files && e.currentTarget.files[0];
      if (!f) return;
      const fr = new FileReader();
      fr.onload = () => {
        try {
          const raw = JSON.parse(String(fr.result));
          S.skin = mergeSkin(raw);
          applySkin(S.skin);
          saveSkin();
          rerender();
          if (typeof showNoticeModal === 'function') showNoticeModal('已导入主题', '颜色/字体/背景设置已应用并保存。');
        } catch (err) {
          if (typeof showNoticeModal === 'function') showNoticeModal('导入失败', '不是有效的主题 JSON：' + String((err && err.message) || err));
        }
      };
      fr.readAsText(f);
    });
  };

  async function saveSkin() {
    S.dirty = false;
    try {
      await api('/api/config', { method: 'POST', body: JSON.stringify({ ui: { skin: S.skin } }) });
      S.saved = true;
      const hint = document.getElementById('skin-save-hint');
      if (hint) hint.textContent = '已保存 ✓';
    } catch (e) {
      S.saved = false;
      if (typeof showNoticeModal === 'function') showNoticeModal('保存失败', String((e && e.message) || e));
    }
  }

  // 启动时应用（拿后端配置；失败就用默认）
  async function bootSkin() {
    try {
      const cfg = await api('/api/config');
      S.skin = mergeSkin(cfg && cfg.ui && cfg.ui.skin);
      const ba = cfg && cfg.ui && cfg.ui.bootAnim;
      if (ba === 'off' || ba === 'always' || ba === 'once') S.bootAnim = ba;
      try { localStorage.setItem('qqa-boot-mode', S.bootAnim); } catch { /* 忽略 */ }
    } catch { /* 用默认 */ }
    const autoSaved = readAuto();
    if (autoSaved) S.skin.auto = autoSaved;   // 自动配色以本机为准（含开启前的颜色）
    applySkin(S.skin);
  }
  // 主题变化（浅/深/跟随系统）→ 自动配色要换成对应那一套
  try {
    let lastTheme = resolvedTheme();
    new MutationObserver(() => {
      const now = resolvedTheme();
      if (now === lastTheme) return;
      lastTheme = now;
      if (S.skin.auto && S.skin.auto.on) applySkin(S.skin);
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  } catch { /* 老环境没有 MutationObserver */ }

  window.__applySkin = applySkin;
  window.renderSkinPanel = renderSkinPanel;   // 06 的 renderUiCustomSection 要调用它（跨脚本全局）
  window.__skinState = S;
  bootSkin();
})();
