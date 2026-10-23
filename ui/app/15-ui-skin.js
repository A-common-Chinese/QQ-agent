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
  const FAMILIES = {
    '': '系统默认',
    msyh: '"Microsoft YaHei", "微软雅黑"',
    deng: '"DengXian", "等线"',
    simhei: '"SimHei", "黑体"',
    simsun: '"SimSun", "宋体"'
  };
  // 2026-10：预设颜色加深一档（原来太淡，被面板一盖基本看不出效果）
  const PRESETS = {
    moon: { label: '云白', css: 'linear-gradient(160deg, #eef2fa 0%, #d5e1f1 100%)' },
    sand: { label: '暖砂', css: 'linear-gradient(160deg, #f6ead1 0%, #e6cfa4 100%)' },
    pine: { label: '松绿', css: 'linear-gradient(160deg, #e4f1e7 0%, #c8e0cf 100%)' },
    mist: { label: '雾蓝', css: 'linear-gradient(160deg, #e6eefb 0%, #cbdaf0 100%)' },
    night: { label: '墨夜', css: 'linear-gradient(160deg, #0b0f15 0%, #1b2333 100%)' }
  };
  // 透明方式：直接透明 / 两档毛玻璃 / 磨砂（都是给背景层加 filter，不影响内容）
  const BG_MODES = {
    none: { label: '直接透明', filter: '' },
    soft: { label: '轻微模糊', filter: 'blur(4px)' },
    strong: { label: '强模糊', filter: 'blur(12px)' },
    frost: { label: '磨砂玻璃', filter: 'blur(8px) saturate(1.15) brightness(1.04)' }
  };
  const SOLIDS = ['#f7f8fa', '#efe7d8', '#e8efe9', '#e9eef7', '#f3ecf4', '#ffffff'];
  const DEFAULTS = {
    bg: { type: 'solid', color: '', preset: '', blur: 0, dim: 0, fit: 'cover', opacity: 100, mode: 'none' },
    colors: { accent: '', bg: '', card: '', text: '', tx2: '', line: '' },
    font: { family: '', scale: 1 },
    sidebarW: 0
  };

  const S = { skin: clone(DEFAULTS), saved: false, dirty: false };

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

  // ── 应用皮肤 ──────────────────────────────────────────────────────────
  function applySkin(skin) {
    const root = document.documentElement;
    const c = (skin && skin.colors) || {};
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
    const solidColor = bg.color || (skin && skin.colors && skin.colors.bg) || '';
    const showSolid = bg.type === 'solid' && !!solidColor;
    if (!showImage && !showPreset && !showSolid) {
      if (layer) layer.remove();
      root.style.removeProperty('--skin-dim');
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
    } else if (showPreset) {
      layer.style.backgroundImage = PRESETS[bg.preset].css;
      layer.style.backgroundColor = 'transparent';
      layer.style.backgroundSize = 'cover';
      layer.style.backgroundRepeat = 'no-repeat';
    } else {
      layer.style.backgroundImage = 'none';
      layer.style.backgroundColor = solidColor;
    }
    // 透明度（0-100）
    const opacity = bg.opacity === undefined ? 100 : Math.min(100, Math.max(0, Number(bg.opacity)));
    layer.style.opacity = String(opacity / 100);
    // 透明方式（模糊档）：与图片自身的"模糊"叠加
    const mode = BG_MODES[bg.mode] ? bg.mode : 'none';
    const filters = [];
    if (BG_MODES[mode].filter) filters.push(BG_MODES[mode].filter);
    if (showImage && Number(bg.blur) > 0) filters.push('blur(' + Number(bg.blur) + 'px)');
    layer.style.filter = filters.length ? filters.join(' ') : '';
    const dim = showImage ? Number(bg.dim) || 0 : 0;
    root.style.setProperty('--skin-dim', dim > 0 ? 'rgba(0,0,0,' + Math.min(0.8, dim / 100) + ')' : 'transparent');
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
      + Object.entries(PRESETS).map(([id, p]) => `<button class="skin-preset${bg.type === 'preset' && bg.preset === id ? ' on' : ''}" style="background:${p.css}" data-skin-preset="${id}"><span>${p.label}</span></button>`).join('')
      + `<button class="skin-btn" id="skin-upload-btn">上传图片</button>`
      + '<input type="file" id="skin-file" accept="image/png,image/jpeg,image/webp" style="display:none">'
      + '</div>'
      + '<div class="skin-note">上传图片只保存在本机（≤2MB，png/jpg/webp），不会进配置文件；换机器需要重新上传。</div>';
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
    return v === undefined ? 100 : Math.min(100, Math.max(0, Number(v) || 0));
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
        <div class="skin-row"><div class="skin-lbl">背景透明度与透明方式</div>
          <div class="skin-range"><span class="skin-range-lbl">透明度</span>
            <input type="range" id="skin-opacity-range" min="0" max="100" step="5" value="${opacityVal()}">
            <input class="skin-num" type="number" id="skin-opacity" min="0" max="100" step="5" value="${opacityVal()}">
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
        <div class="skin-row"><div class="skin-lbl">颜色</div>
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
      rerender();
    }));
    $id('skin-color-bg')?.addEventListener('input', (e) => {
      S.skin.bg.type = 'solid';
      S.skin.colors.bg = e.currentTarget.value;
      touch();
      rerender();
    });
    document.querySelectorAll('[data-skin-preset]').forEach((el) => el.addEventListener('click', () => {
      S.skin.bg.type = 'preset';
      S.skin.bg.preset = el.dataset.skinPreset;
      S.skin.colors.bg = '';
      touch();
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
    ['accent', 'bg', 'card', 'text', 'tx2', 'line'].forEach((k) => $id('skin-c-' + k)?.addEventListener('input', (e) => {
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
    } catch { /* 用默认 */ }
    applySkin(S.skin);
  }
  window.__applySkin = applySkin;
  window.renderSkinPanel = renderSkinPanel;   // 06 的 renderUiCustomSection 要调用它（跨脚本全局）
  window.__skinState = S;
  bootSkin();
})();
