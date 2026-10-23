'use strict';
// 〔用量页图表〕2026-10 UI 改版第 4 步
// 一个坐标框 + 可配置：折线/柱状、指标（花费/tokens/请求数）、模型（自动=按当天主导，或单选）、
// 纵轴（自动/手动，手动时超出画锯齿 + 红字真值）、底部模型占比扇形。
//
// 数据来自 POST /api/usage/series（桶 × 序列矩阵）。"今天"是进行中的桶：
// 折线末段画虚线、柱状末柱画虚框 + 半透明，图例单独标「今天（累计中）」。
(function () {
  const CHART_KEY = 'qqa-usage-chart';
  const COLORS = ['#3a62cd', '#2f9e6b', '#c77700', '#8e44ad', '#d9534f', '#0f9b8e', '#c2185b', '#5d4037'];
  const SHAPES = ['circle', 'square', 'triangle'];

  const S = {
    chart: 'line',      // line | bar
    metric: 'cost',     // cost | tokens | runs
    model: 'auto',      // auto | <modelKey>
    axis: 'auto',       // auto | manual
    axisMax: '',
    data: null,
    loading: false,
    error: '',
    seq: 0
  };
  try {
    const saved = JSON.parse(localStorage.getItem(CHART_KEY) || '{}');
    if (saved && typeof saved === 'object') {
      if (saved.chart === 'bar' || saved.chart === 'line') S.chart = saved.chart;
      if (['cost', 'tokens', 'runs'].includes(saved.metric)) S.metric = saved.metric;
      if (typeof saved.model === 'string') S.model = saved.model;
      if (saved.axis === 'manual' || saved.axis === 'auto') S.axis = saved.axis;
      if (saved.axisMax !== undefined) S.axisMax = String(saved.axisMax || '');
    }
  } catch { /* 忽略 */ }

  function persist() {
    try {
      localStorage.setItem(CHART_KEY, JSON.stringify({ chart: S.chart, metric: S.metric, model: S.model, axis: S.axis, axisMax: S.axisMax }));
    } catch { /* 忽略 */ }
  }

  const METRIC_LABEL = { cost: '花费', tokens: 'tokens', runs: '请求数' };
  const METRIC_UNIT = { cost: '元', tokens: '', runs: '次' };

  function fmtNum(v) {
    const n = Number(v) || 0;
    if (S.metric === 'cost') return n >= 100 ? n.toFixed(0) : n.toFixed(n >= 10 ? 1 : 2);
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(Math.round(n));
  }
  function niceMax(v) {
    if (!(v > 0)) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    const norm = v / mag;
    const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
    return step * mag;
  }
  function colorOf(key) {
    const i = (S.data?.series || []).findIndex((s) => s.key === key);
    return COLORS[(i < 0 ? 0 : i) % COLORS.length];
  }
  function shortLabel(key) {
    const s = String(key || '');
    const parts = s.split('·');
    return (parts.length > 1 ? parts[1] : s).trim();
  }

  async function fetchSeries() {
    const seq = ++S.seq;
    S.loading = true;
    render();
    try {
      const r = await api('/api/usage/series', {
        method: 'POST',
        body: JSON.stringify({ range: (typeof usageRange !== 'undefined' ? usageRange : '7'), seriesBy: 'model', metric: S.metric })
      });
      if (seq !== S.seq) return;
      if (!r || r.ok === false) throw new Error((r && r.error) || '接口返回失败');
      S.data = r;
      S.error = '';
      // 选中的模型可能已经不在数据里（换了时间范围）→ 回自动
      if (S.model !== 'auto' && !(r.series || []).some((s) => s.key === S.model)) S.model = 'auto';
    } catch (e) {
      if (seq !== S.seq) return;
      S.error = String((e && e.message) || e);
      S.data = null;
    }
    S.loading = false;
    render();
  }

  // ── 计算绘制用的量 ────────────────────────────────────────────────────
  function computeView() {
    const d = S.data;
    if (!d) return null;
    const buckets = d.buckets || [];
    const series = d.series || [];
    const shown = S.model === 'auto' ? series : series.filter((s) => s.key === S.model);
    const n = buckets.length;
    const totals = new Array(n).fill(0);
    for (const s of shown) for (let i = 0; i < n; i += 1) totals[i] += Number(s.values[i]) || 0;
    // 当天主导模型（折线点形状）：所有模型里当天值最大的
    const dominant = buckets.map((_, i) => {
      let best = null, bv = -1;
      for (const s of series) {
        const v = Number(s.values[i]) || 0;
        if (v > bv) { bv = v; best = s.key; }
      }
      return { key: best, value: bv };
    });
    const yMax = S.axis === 'manual' ? Math.max(0.0001, Number(S.axisMax) || 0) : niceMax(Math.max(...totals, 0));
    return { buckets, series, shown, totals, dominant, yMax, n };
  }

  // ── SVG 绘制 ──────────────────────────────────────────────────────────
  const W = 1000, H = 380, PAD = { l: 62, r: 18, t: 20, b: 42 };
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;

  function yOf(v, yMax) { return PAD.t + plotH - Math.min(1, Math.max(0, v / yMax)) * plotH; }
  function xOf(i, n) { return n <= 1 ? PAD.l + plotW / 2 : PAD.l + (plotW * i) / (n - 1); }

  function markerSvg(cx, cy, shape, color, filled) {
    const f = filled ? color : '#ffffff';
    if (shape === 'square') return `<rect x="${(cx - 4.5).toFixed(1)}" y="${(cy - 4.5).toFixed(1)}" width="9" height="9" rx="1.5" fill="${f}" stroke="${color}" stroke-width="2"></rect>`;
    if (shape === 'triangle') return `<polygon points="${cx.toFixed(1)},${(cy - 6).toFixed(1)} ${(cx + 6).toFixed(1)},${(cy + 5).toFixed(1)} ${(cx - 6).toFixed(1)},${(cy + 5).toFixed(1)}" fill="${f}" stroke="${color}" stroke-width="2"></polygon>`;
    return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4.5" fill="${f}" stroke="${color}" stroke-width="2"></circle>`;
  }

  function gridSvg(v) {
    let out = '';
    for (let i = 0; i <= 4; i += 1) {
      const y = PAD.t + (plotH * i) / 4;
      out += `<line x1="${PAD.l}" y1="${y.toFixed(1)}" x2="${W - PAD.r}" y2="${y.toFixed(1)}" stroke="var(--bd)" stroke-width="1"></line>`;
      out += `<text x="${PAD.l - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--tx3)">${fmtNum(v.yMax * (1 - i / 4))}</text>`;
    }
    const n = v.n;
    const step = n <= 8 ? 1 : Math.ceil(n / 8);
    for (let i = 0; i < n; i += step) {
      out += `<text x="${xOf(i, n).toFixed(1)}" y="${H - PAD.b + 18}" text-anchor="middle" font-size="10" fill="var(--tx3)">${esc(v.buckets[i].label)}</text>`;
    }
    if ((n - 1) % step !== 0) {
      out += `<text x="${xOf(n - 1, n).toFixed(1)}" y="${H - PAD.b + 18}" text-anchor="middle" font-size="10" fill="var(--tx3)">${esc(v.buckets[n - 1].label)}</text>`;
    }
    return out;
  }

  function lineSvg(v) {
    const n = v.n;
    const pts = v.totals.map((t, i) => [xOf(i, n), yOf(t, v.yMax)]);
    let out = '';
    const partialFrom = v.buckets.findIndex((b) => b.partial);
    // 实线部分：到"今天"之前
    // 实线部分：**到"今天"的前一个点为止**（今天那段只画虚线）
    // ⚠️ 不能画到最后一个点：虚线叠在实线上会露出下面的实线段，看起来仍是一条实线（实测踩过）
    const solidEnd = partialFrom > 0 ? partialFrom - 1 : n - 1;
    if (solidEnd >= 1) {
      out += `<polyline points="${pts.slice(0, solidEnd + 1).map((p) => p.map((x) => x.toFixed(1)).join(',')).join(' ')}" fill="none" stroke="var(--ac)" stroke-width="2"></polyline>`;
    }
    // 今天那一段画虚线
    if (partialFrom > 0 && partialFrom < n) {
      const [x1, y1] = pts[partialFrom - 1];
      const [x2, y2] = pts[partialFrom];
      out += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="var(--ac)" stroke-width="2" stroke-dasharray="7 5"></line>`;
    }
    for (let i = 0; i < n; i += 1) {
      const [x, y] = pts[i];
      const pid = safeShapeIndex(v, i);
      const color = pid >= 0 ? COLORS[pid % COLORS.length] : 'var(--ac)';
      const shape = SHAPES[(pid >= 0 ? pid : 0) % SHAPES.length];
      if (v.buckets[i].partial) {
        out += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6" fill="none" stroke="var(--ac)" stroke-width="2" stroke-dasharray="3 3"></circle>`;
      } else {
        out += markerSvg(x, y, shape, color, false);
      }
      out += `<title>${esc(v.buckets[i].label)} · ${fmtNum(v.totals[i])}${METRIC_UNIT[S.metric]}</title>`;
    }
    return out;
  }

  function safeShapeIndex(v, i) {
    const key = v.dominant[i] && v.dominant[i].key;
    if (!key) return -1;
    return (v.series.findIndex((s) => s.key === key));
  }

  function barSvg(v) {
    const n = v.n;
    const slot = plotW / Math.max(1, n);
    const bw = Math.min(30, Math.max(6, slot * 0.55));
    let out = '';
    for (let i = 0; i < n; i += 1) {
      const cx = PAD.l + slot * i + slot / 2;
      let base = PAD.t + plotH;
      let clipped = false;
      const segs = [];
      for (const s of v.shown) {
        const val = Number(s.values[i]) || 0;
        if (val <= 0) continue;
        segs.push({ key: s.key, val });
      }
      const total = segs.reduce((a, b) => a + b.val, 0);
      for (const seg of segs) {
        const fullH = (seg.val / v.yMax) * plotH;
        const room = base - PAD.t;
        const h = Math.min(fullH, room);
        if (fullH > room + 0.5) clipped = true;
        if (h > 0.4) {
          const y = base - h;
          if (v.buckets[i].partial) {
            out += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${colorOf(seg.key)}" fill-opacity="0.45"></rect>`;
          } else {
            out += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${colorOf(seg.key)}"></rect>`;
          }
        }
        base -= h;
      }
      if (v.buckets[i].partial) {
        // 今天：虚框（数据还在累计）—— 围住柱子本身；今天还没数据就给个底部小虚框
        const frameTop = total > 0 ? base : (PAD.t + plotH - 8);
        out += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${frameTop.toFixed(1)}" width="${bw.toFixed(1)}" height="${(PAD.t + plotH - frameTop).toFixed(1)}" fill="none" stroke="var(--tx2)" stroke-width="1.5" stroke-dasharray="5 4"></rect>`;
        out += `<text x="${cx.toFixed(1)}" y="${(PAD.t - 6)}" text-anchor="middle" font-size="10" fill="var(--tx3)">累计中</text>`;
      } else if (clipped) {
        const y = PAD.t;
        out += `<path d="M${(cx - 9).toFixed(1)},${y + 8} l4,-6 l4,6 l4,-6 l4,6" fill="none" stroke="var(--err)" stroke-width="1.5"></path>`;
        out += `<text x="${cx.toFixed(1)}" y="${y - 4}" text-anchor="middle" font-size="10" fill="var(--err)">${fmtNum(total)}</text>`;
      }
      out += `<title>${esc(v.buckets[i].label)} · ${fmtNum(total)}${METRIC_UNIT[S.metric]}</title>`;
    }
    return out;
  }

  function pieSvg(v) {
    const parts = (S.data.pie || []).filter((p) => p.value > 0);
    const total = parts.reduce((s, p) => s + p.value, 0) || 1;
    const R = 74, CX = 100, CY = 96;
    let ang = -Math.PI / 2;
    let out = '';
    if (parts.length === 1) {
      // 只有一个模型占 100%：整圆（用起止角相同的 path 会退化成不绘制）
      out += `<circle cx="${CX}" cy="${CY}" r="${R}" fill="${colorOf(parts[0].key)}"><title>${esc(parts[0].label)} 100%</title></circle>`;
    }
    for (const p of (parts.length === 1 ? [] : parts)) {
      const a = (p.share || 0) * Math.PI * 2;
      const x1 = CX + R * Math.cos(ang), y1 = CY + R * Math.sin(ang);
      const x2 = CX + R * Math.cos(ang + a), y2 = CY + R * Math.sin(ang + a);
      const large = a > Math.PI ? 1 : 0;
      out += `<path d="M${CX},${CY} L${x1.toFixed(1)},${y1.toFixed(1)} A${R},${R} 0 ${large} 1 ${x2.toFixed(1)},${y2.toFixed(1)} Z" fill="${colorOf(p.key)}" stroke="var(--bg2)" stroke-width="2"><title>${esc(p.label)} ${(p.share * 100).toFixed(1)}%</title></path>`;
      ang += a;
    }
    out += `<circle cx="${CX}" cy="${CY}" r="46" fill="var(--bg2)"></circle>`;
    out += `<text x="${CX}" y="${CY - 6}" text-anchor="middle" font-size="10" fill="var(--tx3)">合计</text>`;
    out += `<text x="${CX}" y="${CY + 14}" text-anchor="middle" font-size="15" font-weight="700" fill="var(--tx)">${fmtNum(total)}${METRIC_UNIT[S.metric]}</text>`;
    return out;
  }

  // ── 渲染 ──────────────────────────────────────────────────────────────
  function controlsHtml() {
    const models = (S.data?.series || []).map((s) => s.key);
    const seg = (name, items, cur, attr) => '<span class="uc-seg">'
      + items.map(([v, label]) => `<button class="uc-seg-btn${cur === v ? ' on' : ''}" data-${attr}="${esc(v)}">${esc(label)}</button>`).join('')
      + '</span>';
    return '<div class="uc-bar">'
      + '<span class="uc-lbl">图表</span>' + seg('chart', [['line', '折线'], ['bar', '柱状']], S.chart, 'uc-chart')
      + '<span class="uc-lbl">指标</span>' + seg('metric', [['cost', '花费'], ['tokens', 'tokens'], ['runs', '请求数']], S.metric, 'uc-metric')
      + '<span class="uc-lbl">模型</span>'
      + `<select class="uc-select" id="uc-model"><option value="auto"${S.model === 'auto' ? ' selected' : ''}>自动（按当天主导）</option>`
      + models.map((m) => `<option value="${esc(m)}"${S.model === m ? ' selected' : ''}>${esc(shortLabel(m))}</option>`).join('')
      + '</select>'
      + '<span class="uc-lbl">纵轴</span>' + seg('axis', [['auto', '自动'], ['manual', '手动']], S.axis, 'uc-axis')
      + (S.axis === 'manual'
        ? `<input class="uc-input" id="uc-axis-max" type="number" min="0" step="any" placeholder="上限" value="${esc(S.axisMax)}" />`
        : '')
      + '</div>';
  }

  function render() {
    const box = $('#usage-chart');
    if (!box) return;
    if (S.loading && !S.data) {
      box.innerHTML = '<div class="uc-card uc-loading">正在统计用量…</div>';
      return;
    }
    if (S.error) {
      box.innerHTML = '<div class="uc-card"><div class="uc-err">用量图表加载失败：' + esc(S.error) + '</div>'
        + '<button class="btn btn-small" id="uc-retry">重试</button></div>';
      $('#uc-retry')?.addEventListener('click', fetchSeries);
      return;
    }
    const v = computeView();
    if (!v || !v.buckets.length) { box.innerHTML = '<div class="uc-card uc-empty">这个时间范围还没有调用记录</div>'; return; }
    const note = S.data.bucket === 'week' ? '按周' : '按天';
    box.innerHTML = '<div class="uc-card">'
      + '<div class="uc-head"><div class="uc-title">用量趋势 <span class="uc-sub">' + note + ' · ' + esc(S.data.range === 'all' ? '全部' : '近 ' + S.data.range + ' 天') + '</span></div>'
      + '<div class="uc-legend">'
      + (S.model === 'auto'
        ? (S.data.series || []).slice(0, 6).map((s) => `<span class="uc-lg"><i style="background:${colorOf(s.key)}"></i>${esc(shortLabel(s.key))}</span>`).join('')
        : `<span class="uc-lg"><i style="background:${colorOf(S.model)}"></i>${esc(shortLabel(S.model))}</span>`)
      + '<span class="uc-lg uc-lg-dash"><i></i>今天（累计中）</span>'
      + '</div></div>'
      + controlsHtml()
      + '<div class="uc-plot"><svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="用量趋势图">'
      + gridSvg(v) + (S.chart === 'bar' ? barSvg(v) : lineSvg(v))
      + '</svg></div>'
      + '<div class="uc-foot"><div class="uc-pie"><svg viewBox="0 0 200 200" role="img" aria-label="模型占比">' + pieSvg(v) + '</svg></div>'
      + '<div class="uc-pie-legend">' + (S.data.pie || []).filter((p) => p.value > 0).slice(0, 8).map((p) => `<div class="uc-pl"><i style="background:${colorOf(p.key)}"></i><span class="uc-pl-name">${esc(shortLabel(p.key))}</span><span class="uc-pl-pct">${(p.share * 100).toFixed(1)}%</span></div>`).join('') + '</div>'
      + '<div class="uc-note">折线点的形状 = 当天调用最多的模型；最后一段虚线 / 最后一根虚框 = 今天（数据还在累计）</div>'
      + '</div></div>';
    bind();
  }

  function bind() {
    const box = $('#usage-chart');
    if (!box) return;
    box.querySelectorAll('[data-uc-chart]').forEach((el) => el.addEventListener('click', () => { S.chart = el.dataset.ucChart; persist(); render(); }));
    box.querySelectorAll('[data-uc-metric]').forEach((el) => el.addEventListener('click', () => {
      S.metric = el.dataset.ucMetric; persist(); fetchSeries();
    }));
    box.querySelectorAll('[data-uc-axis]').forEach((el) => el.addEventListener('click', () => {
      S.axis = el.dataset.ucAxis; persist(); render();
    }));
    box.querySelector('#uc-model')?.addEventListener('change', (e) => { S.model = e.currentTarget.value; persist(); render(); });
    box.querySelector('#uc-axis-max')?.addEventListener('change', (e) => {
      S.axisMax = String(e.currentTarget.value || ''); persist(); render();
    });
  }

  window.renderUsageChart = function () {
    const box = $('#usage-chart');
    if (!box) return;
    S.data = null;
    render();
    fetchSeries();
  };
})();
