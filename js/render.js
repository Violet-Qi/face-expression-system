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

/* ============================================================
   人脸脱敏（马赛克）
   ------------------------------------------------------------
   做法是"缩小再放大"：先把目标区域画进一张很小的临时画布，
   再关掉平滑插值放大回去 —— 每个格子变成纯色块，就得到马赛克。
   比逐个像素取平均快得多，而且看起来更像"打码"。
   只是显示层的处理，原图不修改、不上传、不落盘。
   ============================================================ */

/**
 * 把画布 c 整体做成马赛克（用于小头像）。
 * @param {HTMLCanvasElement} c
 * @param {number} block 格子边长（像素）
 */
function mosaicCanvas(c, block) {
  if (!c || !c.width || !c.height) return;
  const b = Math.max(2, Math.round(block || 8));
  const cols = Math.max(1, Math.round(c.width / b));
  const rows = Math.max(1, Math.round(c.height / b));

  const tmp = document.createElement('canvas');
  tmp.width = cols;
  tmp.height = rows;
  tmp.getContext('2d').drawImage(c, 0, 0, cols, rows);

  const ctx = c.getContext('2d');
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.drawImage(tmp, 0, 0, cols, rows, 0, 0, c.width, c.height);
  ctx.restore();
}

/**
 * 把人脸框那一块做成马赛克（用于结果画布，图片/摄像头共用）。
 *
 * 前提：目标画布的像素坐标系和人脸框的坐标系一致。
 * 本项目的图片叠加层和摄像头叠加层都是"分辨率 = 源的原始像素"，
 * 所以直接把 srcEl 的同一块区域画回去即可，不需要任何换算。
 *
 * @param {CanvasRenderingContext2D} ctx  要画到的画布上下文
 * @param {HTMLImageElement|HTMLVideoElement} srcEl  像素来源（原图 / 视频帧）
 * @param {{x,y,width,height}} box  人脸框（原始像素坐标）
 * @param {number} [block] 格子边长；不传则按人脸大小自适应
 */
function mosaicFaceRect(ctx, srcEl, box, block) {
  const w = Math.round(box.width);
  const h = Math.round(box.height);
  if (!w || !h || w < 4 || h < 4) return;

  // 格子按人脸短边的 1/14 取，人脸越大格子越粗，观感一致
  const b = Math.max(4, Math.round(block || Math.min(w, h) / 14));
  const cols = Math.max(1, Math.round(w / b));
  const rows = Math.max(1, Math.round(h / b));

  const tmp = document.createElement('canvas');
  tmp.width = cols;
  tmp.height = rows;
  const tctx = tmp.getContext('2d');
  try {
    tctx.drawImage(srcEl, box.x, box.y, box.width, box.height, 0, 0, cols, rows);
  } catch (err) {
    return;   // 源还没就绪（视频首帧、图片未加载完）就跳过这一帧
  }

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, cols, rows, box.x, box.y, box.width, box.height);
  ctx.restore();
}

/**
 * 把叠加层画布对准 <video> 的「真实画面区域」。
 *
 * 视频用了 object-fit: contain，元素盒子里可能左右或上下留白，
 * 直接按元素盒子摆放会让检测框偏心。这里按宽高比算出真正的画面区域。
 *
 * 摄像头页和视频文件页共用这一套（两边都是 <video>，坑也一样）。
 * @returns {number} 画面区域的实际显示宽度（用来换算线宽/字号）
 */
function syncOverlayToVideo(canvas, videoEl) {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh) return 0;

  const wrapRect = canvas.parentElement.getBoundingClientRect();
  const vRect    = videoEl.getBoundingClientRect();
  const aspect   = vw / vh;

  let dispW = vRect.width;
  let dispH = vRect.height;
  if (dispW / dispH > aspect) { dispW = dispH * aspect; } else { dispH = dispW / aspect; }

  const offX = vRect.left + (vRect.width  - dispW) / 2;
  const offY = vRect.top  + (vRect.height - dispH) / 2;

  canvas.style.left   = (offX - wrapRect.left) + 'px';
  canvas.style.top    = (offY - wrapRect.top)  + 'px';
  canvas.style.width  = dispW + 'px';
  canvas.style.height = dispH + 'px';

  return dispW;
}

/**
 * 在画布上画一个检测框和标签。
 * scale 用来把线宽和字号换算到画布自己的像素坐标系里，
 * 否则图片被缩小显示时，框会细得看不见。
 * color 不传时用默认的绿色（表情模式）。
 */
/**
 * 生成人脸标签。
 *
 * 手机上人脸在画面上只有几十像素宽，如果还写"人物1 · Face 1: neutral 97.8%"这种长标签，
 * 会比人脸本身宽得多，几个标签互相糊在一起、还会溢出画面右边。
 * 所以窄屏用短格式：把英文表情换成中文、去掉百分比小数。
 *
 * @param {number} index    第几张脸（从 0 开始）
 * @param {{name:string,value:number}} top  主导表情
 * @param {number} groupIdx 人物分组编号（-1 表示没有分组）
 */
function faceLabel(index, top, groupIdx) {
  const narrow = window.innerWidth < 640;
  if (narrow) {
    // 手机上人脸在画面里往往只有几十像素宽，放不下"人物1 · 表情 98%"这种标签，
    // 几个标签必然叠在一起。这里只保留 2~3 个汉字的情绪名，
    // "是谁"靠框的颜色 + 下方信息列表区分，不再挤在画面上。
    return EXPR_CN[top.name] || top.name;
  }
  let s = `Face ${index + 1}: ${top.name} ${(top.value * 100).toFixed(1)}%`;
  if (groupIdx >= 0) s = `人物${groupIdx + 1} · ` + s;
  return s;
}

function drawBox(ctx, box, label, scale, color) {
  const narrow = window.innerWidth < 640;
  const lineW = Math.max(2, (narrow ? 2 : 3) * scale);
  // 窄屏字号也收小，否则标注比人脸还大
  const fontS = Math.max(narrow ? 9 : 12, (narrow ? 13 : 20) * scale);

  ctx.strokeStyle = color || '#00e000';
  ctx.lineWidth = lineW;
  ctx.strokeRect(box.x, box.y, box.width, box.height);

  ctx.fillStyle = color || '#00e000';
  ctx.font = `bold ${fontS}px "Segoe UI", Arial, sans-serif`;
  ctx.textBaseline = 'alphabetic';
  const ty = (box.y - 6 * scale) > fontS ? (box.y - 6 * scale) : (box.y + fontS + 4 * scale);

  // 文字不能画出画布右边（手机上很容易发生）
  const tw = ctx.measureText(label).width;
  const maxX = ctx.canvas.width - tw - 2 * scale;
  const tx = Math.max(0, Math.min(box.x, maxX));
  ctx.fillText(label, tx, ty);
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

    // 开了打码就先盖住人脸，再把框和标签画在上面
    // （标签显示的是表情而不是身份，所以保留不影响脱敏）
    if (maskEnabled) mosaicFaceRect(ctx, resultImg, res.detection.box);

    const label = faceLabel(i, top, g);
    drawBox(ctx, res.detection.box, label, scale, color);
  });

  // 左边预览图上的打码层要跟着这批人脸一起更新
  renderPreviewMask();
}

/**
 * 上传预览图上的打码层。
 *
 * 左侧预览图里也是同一批人脸，如果只给右边结果画布打码，
 * 屏幕上仍然露着脸，脱敏就不成立。所以这里用一层绝对定位的 canvas
 * 盖住预览图里的人脸。
 *
 * 由 renderView() 调用，保证"有没有这层"始终和当前状态一致
 * （换图、清空、关掉开关时都会自动消失，不会残留）。
 */
function renderPreviewMask() {
  const cv = maskOverlay;
  if (!cv) return;

  const needMask = maskEnabled
    && lastResults && lastResults.length
    && !sourceImg.hidden
    && sourceImg.naturalWidth > 0;

  if (!needMask) {
    cv.hidden = true;
    return;
  }

  cv.hidden = false;
  cv.width  = sourceImg.naturalWidth;
  cv.height = sourceImg.naturalHeight;

  // 和结果画布一样：把 canvas 对准图片在页面上的实际位置
  const wrapRect = cv.parentElement.getBoundingClientRect();
  const imgRect  = sourceImg.getBoundingClientRect();
  cv.style.left   = (imgRect.left - wrapRect.left) + 'px';
  cv.style.top    = (imgRect.top  - wrapRect.top)  + 'px';
  cv.style.width  = imgRect.width  + 'px';
  cv.style.height = imgRect.height + 'px';

  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  lastResults.forEach(res => mosaicFaceRect(ctx, sourceImg, res.detection.box));
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

