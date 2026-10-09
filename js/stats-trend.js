/* ============================================================
   stats-trend.js —— 累计统计、表情趋势与导出
   ------------------------------------------------------------
   本项目的三个自有功能：
     · 累计统计：各表情出现次数与占比（摄像头模式每秒最多计一次，防虚高）
     · 表情趋势折线图：随时间记录主导表情与置信度，逐段着色，独立限流重绘
     · 结果导出 CSV：带 UTF-8 BOM，Excel 直接打开不乱码
   ============================================================ */

/* ============================================================
   累计统计（本项目自己实现的功能）
   ============================================================ */

/**
 * 把一次识别结果累加进统计。
 * minIntervalMs：最小统计间隔。摄像头模式每帧都识别，
 * 如果每帧都累加，14 秒就能记出上百张脸，数字没有意义，
 * 所以摄像头模式每秒最多统计一次。
 */
function addStats(results, minIntervalMs) {
  const now = performance.now();
  if (minIntervalMs && now - statsLastAt < minIntervalMs) return;
  statsLastAt = now;

  results.forEach(res => {
    const top = topExpression(res.expressions);
    if (stats[top.name] === undefined) stats[top.name] = 0;
    stats[top.name]++;
    stats.total++;
  });
  renderStats();

  // 被计入统计的这一次识别，同时也记进趋势曲线
  // （放在限流判断之后，所以趋势曲线和累计统计的节奏完全一致，不会虚高）
  recordTrend(results);
}

/** 把统计结果渲染成横向条形图 */
function renderStats() {
  if (stats.total === 0) { statsBox.hidden = true; return; }

  statsBox.hidden = false;
  statsTotal.textContent = stats.total;
  statsContent.innerHTML = '';

  // 找到出现次数最多的那一类，用它作为 100% 宽度基准
  const keys = Object.keys(EXPR_CN);
  let max = 1;
  keys.forEach(k => { if (stats[k] > max) max = stats[k]; });

  keys.forEach(k => {
    const count = stats[k] || 0;
    if (count === 0) return;                 // 没出现过的表情不显示，避免一片空条
    const pct = (count / max * 100).toFixed(1);
    const share = (count / stats.total * 100).toFixed(1);

    const row = document.createElement('div');
    row.className = 'stat-row';
    row.innerHTML =
      `<span class="stat-label">${EXPR_CN[k]}</span>` +
      `<span class="stat-bar"><i style="width:${pct}%;background:${EXPR_COLOR[k]}"></i></span>` +
      `<span class="stat-count">${count} 次（${share}%）</span>`;
    statsContent.appendChild(row);
  });
}

/* ============================================================
   表情趋势与结果导出（本项目自己实现的功能）
   ============================================================ */

/** 媒体元素自然尺寸：<img> 用 naturalWidth，<video> 用 videoWidth */
function mediaSize(el) {
  const w = el.naturalWidth !== undefined ? el.naturalWidth : el.videoWidth;
  const h = el.naturalHeight !== undefined ? el.naturalHeight : el.videoHeight;
  return { w: w || 0, h: h || 0 };
}

/** 人脸按"从左到右"排序，保证同一个人的编号在整条曲线上基本一致 */
function sortFacesLeftToRight(results) {
  return results.slice().sort((a, b) => a.detection.box.x - b.detection.box.x);
}

/**
 * 记录一个趋势采样点。
 * 每个点记一张人脸：一次识别里如果有多张脸，就记多个点（同一条时间轴上）。
 */
function recordTrend(results) {
  if (!results || !results.length) return;

  const exprName = mode === 'camera' ? 'video' : 'resultImg';
  const msrc = exprName === 'video' ? video : resultImg;
  const sz = mediaSize(msrc);

  const faces = sortFacesLeftToRight(results);
  const now = performance.now();
  if (!trendStartAt) trendStartAt = now;

  let dominantName = 'neutral', dominantVal = -1;
  faces.forEach(res => {
    const top = topExpression(res.expressions);
    const p = res.expressions ? res.expressions : {};
    if (top.value > dominantVal) { dominantVal = top.value; dominantName = top.name; }

    trendData.push({
      time:      now - trendStartAt,
      faces:     faces.length,
      imageW:    sz.w,
      imageH:    sz.h,
      dominant:  { name: top.name, value: top.value },
      exprName:  exprName,
      exprValue: top.value,
      expr:      p
    });
  });

  // 超出上限就丢最早的，保持定长
  while (trendData.length > TREND_MAX) trendData.shift();

  updateTrendMeta(faces.length, dominantName);
  scheduleTrendDraw();
}

/** 更新趋势面板的标题数字、底部状态文字和"导出/清空"按钮可用性 */
function updateTrendMeta(faceCount, dominantName) {
  trendBox.hidden = trendData.length === 0;

  if (trendData.length === 0) {
    trendTotal.textContent = '0';
    trendCsvBtn.disabled = true;
    trendClearBtn.disabled = true;
    return;
  }

  trendTotal.textContent = trendData.length;
  // 只有一个点时还连不成线、CSV 也只有孤零零一行，先禁用导出，避免用户拿到没意义的数据
  trendCsvBtn.disabled = trendData.length < 2;
  trendClearBtn.disabled = false;

  const first = trendData[0];
  const last  = trendData[trendData.length - 1];
  const span  = ((last.time - first.time) / 1000).toFixed(1);
  trendNote.textContent =
    `纵轴是置信度，横轴是时间（共 ${span} 秒）　|　` +
    `本次识别到 ${faceCount} 张人脸，此刻主导表情：${EXPR_CN[dominantName] || dominantName}`;
}

/** 绘图限流：数据来得再快，折线图也最多每 TREND_REDRAW_MS 重画一次 */
function scheduleTrendDraw() {
  if (trendRedrawTimer) return;
  trendRedrawTimer = setTimeout(() => {
    trendRedrawTimer = null;
    renderTrend();
  }, TREND_REDRAW_MS);
}

/** 按当前数据决定是画曲线还是显示"数据不够"提示 */
function renderTrend() {
  if (trendData.length === 0) {
    trendBox.hidden = true;
    trendPlot = null;
    return;
  }

  // 只有一个点连不成线，直接提示，避免画出一张只有孤点的空图
  if (trendData.length < 2) {
    trendEmpty.hidden = false;
    trendEmpty.textContent = '再识别一次，这里就会画出趋势曲线';
    renderTrendLegend();
    return;
  }

  trendEmpty.hidden = true;
  trendPlot = buildTrendPlot();
  drawTrendChart(trendPlot);
  renderTrendLegend();
}

/** 把原始采样点换算成绘图用的坐标（与画布实际尺寸无关，只算 0~1 的比值） */
function buildTrendPlot() {
  const first = trendData[0];
  const last  = trendData[trendData.length - 1];
  const spanMs = Math.max(1, last.time - first.time);

  const used = {};
  const points = trendData.map(d => {
    used[d.dominant.name] = true;
    return {
      rx: (d.time - first.time) / spanMs,   // 横轴 0~1
      ry: Math.min(1, Math.max(0, d.dominant.value)),  // 纵轴 0~1
      color: EXPR_COLOR[d.dominant.name] || '#8a94a0',
      expr: d.dominant.name
    };
  });

  return { points, spanSec: (last.time - first.time) / 1000, used };
}

/** 把画布尺寸对准它的 CSS 显示尺寸（乘以设备像素比，保证高分屏下不糊） */
function prepTrendCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const cw = Math.max(320, Math.round(trendCanvas.clientWidth || trendWrap.clientWidth || 640));
  const ch = Math.max(140, Math.round(trendCanvas.clientHeight || 180));

  trendCanvas.width  = Math.round(cw * dpr);
  trendCanvas.height = Math.round(ch * dpr);

  const ctx = trendCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // 之后全部按 CSS 像素坐标画
  ctx.clearRect(0, 0, cw, ch);
  return { ctx, cw, ch };
}

/** 画折线图的主函数 */
function drawTrendChart(plot) {
  if (!plot || !plot.points.length) return;

  const { ctx, cw, ch } = prepTrendCanvas();
  const pad = { l: 44, r: 14, t: 14, b: 26 };
  const plotW = Math.max(10, cw - pad.l - pad.r);
  const plotH = Math.max(10, ch - pad.t - pad.b);

  const X = rx => pad.l + rx * plotW;
  const Y = ry => pad.t + (1 - ry) * plotH;

  // 读 CSS 变量，保证图里配色和整站一致（换 --primary 时不用改 JS）
  const cssVar = (n, fb) => {
    const v = getComputedStyle(document.documentElement).getPropertyValue(n);
    return (v && v.trim()) || fb;
  };
  const gridColor  = cssVar('--border', '#e3e7ec');
  const textColor  = cssVar('--text-muted', '#6b7683');
  const lineStrong = cssVar('--border-strong', '#d3d9e0');

  ctx.font = '11px "Microsoft YaHei", "Segoe UI", Arial, sans-serif';
  ctx.textBaseline = 'middle';

  // ---- 横向网格线 + 纵轴百分比刻度 ----
  [0, 0.25, 0.5, 0.75, 1].forEach(ry => {
    const y = Y(ry);
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.setLineDash(ry === 0 ? [] : [3, 3]);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + plotW, y);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.fillStyle = textColor;
    ctx.textAlign = 'right';
    ctx.fillText(Math.round(ry * 100) + '%', pad.l - 6, y);
  });

  // ---- 底部时间轴（最多 5 个刻度，按实际时长换算）----
  ctx.textAlign = 'center';
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const rx = i / ticks;
    ctx.fillStyle = textColor;
    ctx.fillText((rx * plot.spanSec).toFixed(1) + 's', X(rx), pad.t + plotH + 14);
  }

  // ---- 竖轴与底轴 ----
  ctx.strokeStyle = lineStrong;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(pad.l, pad.t);
  ctx.lineTo(pad.l, pad.t + plotH);
  ctx.lineTo(pad.l + plotW, pad.t + plotH);
  ctx.stroke();

  // ---- 置信度曲线下方的淡色填充，让趋势更醒目 ----
  if (plot.points.length >= 2) {
    const pts = plot.points;
    ctx.beginPath();
    ctx.moveTo(X(pts[0].rx), pad.t + plotH);
    pts.forEach(p => ctx.lineTo(X(p.rx), Y(p.ry)));
    ctx.lineTo(X(pts[pts.length - 1].rx), pad.t + plotH);
    ctx.closePath();
    ctx.fillStyle = hexToRgba(pts[pts.length - 1].color, 0.12);
    ctx.fill();
  }

  // ---- 曲线本体：逐段上色，颜色 = 该时刻识别出的主导表情 ----
  for (let i = 1; i < plot.points.length; i++) {
    const a = plot.points[i - 1], b = plot.points[i];
    ctx.strokeStyle = b.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(X(a.rx), Y(a.ry));
    ctx.lineTo(X(b.rx), Y(b.ry));
    ctx.stroke();
  }

  // ---- 每个采样点画一个小圆点（点很多时省略，否则会糊成一片）----
  if (plot.points.length <= 80) {
    plot.points.forEach(p => {
      ctx.beginPath();
      ctx.arc(X(p.rx), Y(p.ry), 2.5, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.fill();
    });
  }

  // ---- 最后一个点加高亮圈，一眼看出"当前值" ----
  const lastP = plot.points[plot.points.length - 1];
  ctx.beginPath();
  ctx.arc(X(lastP.rx), Y(lastP.ry), 4.5, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.strokeStyle = lastP.color;
  ctx.lineWidth = 2;
  ctx.stroke();
}

/** 按当前数据刷新图例，只列出真正出现过的表情 */
function renderTrendLegend() {
  const counts = {};
  trendData.forEach(d => {
    const n = d.dominant.name;
    counts[n] = (counts[n] || 0) + 1;
  });
  const total = trendData.length || 1;

  trendLegend.innerHTML = '';
  Object.keys(EXPR_CN).forEach(k => {
    if (!counts[k]) return;
    const share = (counts[k] / total * 100).toFixed(0);
    const item = document.createElement('span');
    item.className = 'trend-legend-item';
    item.innerHTML =
      `<i class="trend-legend-dot" style="background:${EXPR_COLOR[k]}"></i>` +
      `${EXPR_CN[k]}　${share}%`;
    trendLegend.appendChild(item);
  });
}

/** #rrggbb → rgba(r,g,b,a)，用于曲线下方的淡色填充 */
function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return `rgba(138,148,160,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** 清空趋势数据，重新开始记录 */
function clearTrend() {
  trendData = [];
  trendStartAt = 0;
  trendPlot = null;
  if (trendRedrawTimer) { clearTimeout(trendRedrawTimer); trendRedrawTimer = null; }

  const ctx = trendCanvas.getContext('2d');
  ctx.clearRect(0, 0, trendCanvas.width, trendCanvas.height);
  trendLegend.innerHTML = '';
  trendNote.textContent = '纵轴是当前主导表情的置信度；线的颜色代表该时刻识别出的表情。';
  updateTrendMeta(0, 'neutral');   // 统一由它负责隐藏面板、重置按钮状态
}

/** CSV 字段转义：含逗号、引号、换行时用双引号包起来 */
function csvField(v) {
  const s = (v === undefined || v === null) ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** 导出识别结果为 CSV（带 UTF-8 BOM，Excel 打开不会乱码） */
function exportTrendCsv() {
  if (!trendData.length) { showInfo('还没有可导出的数据。', true); return; }

  const exprKeys = Object.keys(EXPR_CN);
  const baseMs = trendData[0].time;

  const rows = [
    ['序号', '时间(秒)', '模式', '画面中人数', '表情', '置信度(%)']
      .concat(exprKeys.map(k => EXPR_CN[k] + '(%)'))
      .concat(['图片宽度', '图片高度'])
  ];

  trendData.forEach((d, i) => {
    const p = d.expr || {};
    const row = [
      i + 1,
      ((d.time - baseMs) / 1000).toFixed(2),
      d.exprName === 'video' ? '摄像头实时' : '图片识别',
      d.faces,
      EXPR_CN[d.dominant.name] || d.dominant.name,
      (d.dominant.value * 100).toFixed(1)
    ];
    exprKeys.forEach(k => {
      // 摄像头模式下只跑了表情模型，没有七类明细，留空而不是写 0，避免误导
      row.push(p[k] === undefined ? '' : (p[k] * 100).toFixed(1));
    });
    row.push(d.imageW, d.imageH);
    rows.push(row);
  });

  const csv = '\uFEFF' + rows.map(r => r.map(csvField).join(',')).join('\r\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date();
  const pad2 = n => String(n).padStart(2, '0');
  a.href = url;
  a.download = `表情识别结果_${stamp.getFullYear()}${pad2(stamp.getMonth() + 1)}${pad2(stamp.getDate())}` +
               `_${pad2(stamp.getHours())}${pad2(stamp.getMinutes())}${pad2(stamp.getSeconds())}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 稍后再回收，避免个别浏览器还没开始下载就失效
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

