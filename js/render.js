/* ============================================================
   render.js —— 界面反馈与绘制
   ------------------------------------------------------------
   负责"把结果画出来"，不参与识别与计算：
     · 顶部状态条、提示信息的输出
     · 在 canvas 上画检测框与文字标签
     · 下方结果列表（每张人脸一行：类别 + 置信度进度条）
   ============================================================ */

/* ============================================================
   界面反馈
   ============================================================ */

/** 顶部状态条：loading / ok / error */
function setStatus(text, type) {
  modelStatus.className = 'status-bar status-' + type;
  modelStatusText.textContent = text;
}

/** 在信息框里显示一条提示（红色=错误，灰色=普通） */
function showInfo(text, isError) {
  infoContent.innerHTML = '';
  const p = document.createElement('p');
  p.className = isError ? 'info-error' : 'info-empty';
  p.textContent = text;
  infoContent.appendChild(p);
}

/** 从表情概率对象里取出概率最高的那一项 */
function topExpression(expressions) {
  let best = 'neutral', bestVal = -1;
  for (const key in expressions) {
    if (expressions[key] > bestVal) { bestVal = expressions[key]; best = key; }
  }
  return { name: best, value: bestVal };
}

/**
 * 在画布上画一个检测框和标签。
 * scale 用来把线宽和字号换算到画布自己的像素坐标系里，
 * 否则图片被缩小显示时，框会细得看不见。
 * color 不传时用默认的绿色（表情模式）。
 */
function drawBox(ctx, box, label, scale, color) {
  const lineW = Math.max(2, 3 * scale);
  const fontS = Math.max(12, 20 * scale);

  ctx.strokeStyle = color || '#00e000';
  ctx.lineWidth = lineW;
  ctx.strokeRect(box.x, box.y, box.width, box.height);

  ctx.fillStyle = color || '#00e000';
  ctx.font = `bold ${fontS}px "Segoe UI", Arial, sans-serif`;
  ctx.textBaseline = 'alphabetic';
  const ty = (box.y - 6 * scale) > fontS ? (box.y - 6 * scale) : (box.y + fontS + 4 * scale);
  ctx.fillText(label, box.x, ty);
}

/** 图片模式：把检测结果画到叠在图片上的 canvas */
function drawResults(results, groups) {
  // canvas 分辨率 = 图片原始像素；再把它对准图片在页面上的实际位置
  overlay.width  = resultImg.naturalWidth;
  overlay.height = resultImg.naturalHeight;

  const wrapRect = overlay.parentElement.getBoundingClientRect();
  const imgRect  = resultImg.getBoundingClientRect();
  overlay.style.left   = (imgRect.left - wrapRect.left) + 'px';
  overlay.style.top    = (imgRect.top  - wrapRect.top)  + 'px';
  overlay.style.width  = imgRect.width  + 'px';
  overlay.style.height = imgRect.height + 'px';

  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);

  const scale = overlay.width / imgRect.width || 1;

  results.forEach((res, i) => {
    const top = topExpression(res.expressions);
    const g = groups && groups.labels ? groups.labels[i] : -1;
    const color = g >= 0 ? groupColor(g) : undefined;
    let label = `Face ${i + 1}: ${top.name} ${(top.value * 100).toFixed(1)}%`;
    if (g >= 0) label = `人物${g + 1} · ` + label;
    drawBox(ctx, res.detection.box, label, scale, color);
  });
}

/** 图片模式：在下方信息框输出每张人脸的类别与置信度 */
function renderInfo(results, costMs, groups) {
  infoTitle.textContent = '表情识别信息';
  infoContent.innerHTML = '';

  const summary = document.createElement('p');
  summary.className = 'info-summary';
  summary.textContent = `共检测到 ${results.length} 张人脸，识别耗时 ${costMs} 毫秒。`;
  infoContent.appendChild(summary);

  // 人物分组结果说明
  if (groups) {
    const p = document.createElement('p');
    p.className = 'group-summary';
    if (results.length === 1) {
      p.textContent = '人物分组：画面中只有 1 张人脸，无法比较，因此不分组。';
    } else {
      const th = groups.autoThreshold
        ? `${groups.autoThreshold.toFixed(2)}（按距离断层自动判定）`
        : `${GROUP_TH}（默认值）`;
      let txt = `人物分组：${results.length} 张人脸中判断出 ${groups.k} 个不同的人，` +
                `判定阈值 ${th}。`;
      // 组内最大距离越接近阈值，说明这一组越"勉强"，如实提示
      if (groups.k < results.length && groups.maxIntraDistance > GROUP_TH * 0.85) {
        txt += '（提示：本组两张脸相似度偏低，分组结果可能存疑）';
      }
      p.textContent = txt;
    }
    infoContent.appendChild(p);

    // 分组图例
    const legend = document.createElement('div');
    legend.className = 'group-legend';
    for (let g = 0; g < groups.k; g++) {
      const count = groups.labels.filter(x => x === g).length;
      const item = document.createElement('span');
      item.className = 'group-legend-item';
      item.innerHTML =
        `<i class="group-legend-dot" style="background:${groupColor(g)}"></i>` +
        `人物${g + 1}（${count} 张脸）`;
      legend.appendChild(item);
    }
    infoContent.appendChild(legend);
  }

  results.forEach((res, i) => {
    const top = topExpression(res.expressions);
    const pct = top.value * 100;
    const g = groups && groups.labels ? groups.labels[i] : -1;

    const row = document.createElement('div');
    row.className = 'face-row';
    row.innerHTML =
      `<span class="face-index">人脸${i + 1}</span>` +
      (g >= 0
        ? `<span class="face-group" style="background:${groupColor(g)}">人物${g + 1}</span>`
        : '') +
      `<span class="face-label">${EXPR_CN[top.name] || top.name}</span>` +
      `<span class="face-bar"><i style="width:${pct.toFixed(1)}%"></i></span>` +
      `<span class="face-percent">${pct.toFixed(1)}%</span>`;

    infoContent.appendChild(row);
  });
}

