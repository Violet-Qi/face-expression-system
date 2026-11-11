/* ============================================================
   camera.js —— 摄像头实时识别
   ------------------------------------------------------------
   与图片模式共用同一套模型和流程，区别只在输入源是 <video>：
     · 开启/关闭摄像头、错误代码翻译成中文提示
     · 连续检测主循环（算完一帧再排下一帧，避免任务堆积）
     · 检测框按视频"真实画面区域"对齐（处理 object-fit 留白）
     · 实时信息刷新
   ============================================================ */

/* ============================================================
   摄像头实时识别
   ============================================================ */

/** 把摄像头的错误代码翻译成用户看得懂的中文提示 */
function cameraErrorMessage(err) {
  const name = err && err.name ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return '摄像头权限被拒绝。请点击浏览器地址栏右侧的摄像头图标，允许本页面使用摄像头后重试。';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return '没有检测到摄像头设备。请确认电脑已连接摄像头（笔记本请注意是否有物理遮挡开关）。';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return '摄像头被其他程序占用了。请关闭正在使用摄像头的软件（如钉钉、腾讯会议、相机应用）后重试。';
  }
  if (name === 'OverconstrainedError') {
    return '摄像头不支持所请求的分辨率。已尝试降级，请重试。';
  }
  return '无法打开摄像头：' + (err && err.message ? err.message : '未知错误');
}

async function startCamera() {
  // 游客体验 1 次的限制（见 auth.js）：已登录或纯静态部署时直接放行
  if (typeof canRunDetection === 'function' && !canRunDetection()) return;
  // 异常处理：浏览器不支持或不是安全上下文
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showInfo('当前浏览器不支持摄像头，或页面不是通过 localhost / https 打开的。请使用「启动.bat」启动后访问。', true);
    return;
  }

  detectBtn.disabled = true;
  detectBtn.textContent = '正在开启摄像头…';

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false
    });

    video.srcObject = cameraStream;
    await video.play();

    // 画面元素显示出来、占位提示收起、按钮变成"停止" —— 这些显隐统一交给 renderView
    ui.cameraLive = true;
    if (typeof resetSmoothing === 'function') resetSmoothing('cam:');
    // 摄像头真的开起来了才算用掉游客机会
    if (typeof consumeGuestChance === 'function') consumeGuestChance();

    // 本次摄像头会话的匿名统计累计（停止时上报一次）
    cameraAgg = { faces: 0, expr: {}, top: null, topVal: null, startedAt: performance.now() };

    cameraFrames = 0;
    cameraFpsAt  = performance.now();
    detectBtn.textContent = '停止摄像头';
    detectBtn.disabled = false;

    showInfo('摄像头已开启，正在实时识别…', false);
    renderView();

    cameraLoop();   // 开始连续检测

  } catch (err) {
    console.error('[摄像头]', err);
    showInfo(cameraErrorMessage(err), true);
    await stopCamera();
  }
}

async function stopCamera() {
  if (cameraTimer) { clearTimeout(cameraTimer); cameraTimer = null; }
  cameraBusy = false;

  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  video.srcObject = null;

  // 画面回到占位提示、按钮去掉"停止"样式 —— 统一交给 renderView
  ui.cameraLive = false;
  if (typeof resetSmoothing === 'function') resetSmoothing('cam:');

  detectBtn.disabled = !modelsReady;

  showInfo('摄像头已关闭。', false);
  renderView();

  // 匿名统计上报（本次摄像头会话）。没累计到东西就不报，避免写空记录。
  if (cameraAgg && cameraAgg.faces > 0) {
    reportSession('camera', {
      faces: cameraAgg.faces, top: cameraAgg.top, topVal: cameraAgg.topVal,
      durMs: Math.round(performance.now() - cameraAgg.startedAt),
      expr: cameraAgg.expr
    });
  }
  cameraAgg = null;

  // 清空画布，避免残留最后一帧的检测框
  const ctx = cameraOverlay.getContext('2d');
  ctx.clearRect(0, 0, cameraOverlay.width, cameraOverlay.height);
}

/** 连续检测主循环：算完一帧再排下一帧，避免任务堆积卡死 */
function cameraLoop() {
  if (!cameraStream) return;

  (async () => {
    if (!cameraBusy && video.readyState >= 2) {
      cameraBusy = true;
      try {
        await detectCameraFrame();
      } catch (err) {
        console.warn('[摄像头检测]', err);
      }
      cameraBusy = false;
    }
  })();

  cameraTimer = setTimeout(cameraLoop, cameraIntervalNow());
}

/** 对摄像头的当前帧做一次检测 + 识别，并把检测框画到叠加层上 */
async function detectCameraFrame() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;

  // 摄像头模式不需要关键点，少跑一个模型，速度更快
  // 检测器按档位选（速度档 tinyFaceDetector / 均衡与精度档 SSD），选项类由 buildDetectOptions 决定
    const options = buildDetectOptions();
  const results = await faceapi
    .detectAllFaces(video, options)
    .withFaceExpressions();

  /* 增强表情引擎：选了 FERPlus 就用它覆盖（仅电脑档） */
  if (typeof curSettings === "function" && curSettings().expressionEngine === "ferplus" && results.length) {
    try { await applyEnhanceExpressions(results, video); } catch (e) { /* 单帧失败不影响继续 */ }
  }

  // 叠加层的分辨率 = 摄像头画面原始像素（检测框坐标就是这个坐标系下的）
  if (cameraOverlay.width !== vw || cameraOverlay.height !== vh) {
    cameraOverlay.width  = vw;
    cameraOverlay.height = vh;
  }
  // 再把叠加层对准视频「真实画面区域」（object-fit: contain 可能留白）
  const dispW = syncOverlayToVideo(cameraOverlay, video);

  const ctx = cameraOverlay.getContext('2d');
  ctx.clearRect(0, 0, cameraOverlay.width, cameraOverlay.height);

  // 视频被缩小显示时，线宽字号要按比例放大
  const scale = dispW ? (cameraOverlay.width / dispW) : 1;

  results.forEach((res, i) => {
    /* 多帧平滑：用历史概率压掉逐帧抖动（见 smoothing.js）。
       关闭平滑时原样返回，行为与旧版一致。 */
    const smoothed = (typeof smoothExpressions === 'function')
      ? smoothExpressions('cam:' + i, res.expressions)
      : res.expressions;
    const top = topExpression(smoothed);

    // 开了打码就先盖住人脸，再画框和标签
    if (maskEnabled) mosaicFaceRect(ctx, video, res.detection.box);

    drawBox(ctx, res.detection.box, faceLabel(i, top, -1), scale);
  });

  // 帧率统计
  cameraFrames++;
  const now = performance.now();
  if (now - cameraFpsAt >= 1000) {
    const fps = (cameraFrames * 1000 / (now - cameraFpsAt)).toFixed(1);
    cameraFrames = 0;
    cameraFpsAt = now;
    cameraOverlay.dataset.fps = fps;
  }

  renderCameraInfo(results);
  // 摄像头模式每秒最多计入一次统计，避免数字虚高
  if (results.length) {
    // addStats 返回 false 表示被限流跳过了 —— 那也不计入本次会话的上报累计，
    // 保证"上报的数字"和"界面统计的数字"是同一个口径。
    if (addStats(results, 1000)) {
      const s = summarizeResults(results);
      cameraAgg.faces += s.faces;
      Object.keys(s.expr).forEach(k => { cameraAgg.expr[k] = (cameraAgg.expr[k] || 0) + s.expr[k]; });
      if (s.topVal != null && s.topVal > (cameraAgg.topVal == null ? -1 : cameraAgg.topVal)) {
        cameraAgg.top = s.top; cameraAgg.topVal = s.topVal;
      }
    }
  }
}

/** 摄像头模式：把实时结果写进信息框 */
function renderCameraInfo(results) {
  infoContent.innerHTML = '';

  const fps = cameraOverlay.dataset.fps || '—';
  const summary = document.createElement('p');
  summary.className = 'info-summary';
  summary.textContent = `实时检测：画面中 ${results.length} 张人脸　|　处理帧率约 ${fps} FPS`;
  infoContent.appendChild(summary);

  if (!results.length) {
    const p = document.createElement('p');
    p.className = 'info-empty';
    p.textContent = '当前画面中未检测到人脸，请把脸朝向摄像头并保证光线充足。';
    infoContent.appendChild(p);
    return;
  }

  results.forEach((res, i) => {
    /* 多帧平滑：用历史概率压掉逐帧抖动（见 smoothing.js）。
       关闭平滑时原样返回，行为与旧版一致。 */
    const smoothed = (typeof smoothExpressions === 'function')
      ? smoothExpressions('cam:' + i, res.expressions)
      : res.expressions;
    const top = topExpression(smoothed);
    const pct = top.value * 100;
    const row = document.createElement('div');
    row.className = 'face-row';
    row.innerHTML =
      `<span class="face-index">人脸${i + 1}</span>` +
      `<span class="face-label">${EXPR_CN[top.name] || top.name}</span>` +
      `<span class="face-bar"><i style="width:${pct.toFixed(1)}%"></i></span>` +
      `<span class="face-percent">${pct.toFixed(1)}%</span>`;
    infoContent.appendChild(row);
  });
}

