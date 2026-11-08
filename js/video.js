/* ============================================================
   video.js —— 视频文件逐帧分析
   ------------------------------------------------------------
   和摄像头模式的区别只在"帧从哪来"：
     摄像头：getUserMedia 拿实时流，按时间间隔反复检测
     视频文件：把本地文件塞进 <video>，用 seek 逐帧跳着取
   两者共用同一套识别流程（detectAllFaces + withFaceExpressions）、
   同一套打码与画框函数、同一份趋势与统计。

   视频不播放、只 seek：为了能"精确控制取哪一帧"以及"随时中止"，
   这里不靠播放事件的节奏，而是一帧一帧地 seek 过去。
   ============================================================ */

const VIDEO_SAMPLE_STEP  = 0.5;    // 每 0.5 秒取一帧
const VIDEO_MAX_FRAMES   = 600;    // 采样帧数上限（约 5 分钟视频），防止长片跑到天荒地老

/** 把视频 seek 到指定时间并等它真的到位（seek 是异步的，不等会拿到上一帧） */
function seekVideo(v, t) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      v.removeEventListener('seeked', finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 3000);   // 兜底：个别编码 seek 不触发事件
    v.addEventListener('seeked', finish);
    try {
      v.currentTime = Math.max(0, t);
    } catch (err) {
      finish();
    }
  });
}

/**
 * 读视频时长。
 *
 * 有些 WebM（尤其是 MediaRecorder 录出来的、或者没写 duration 元数据的）
 * 一载入时 `duration` 是 Infinity。业界通用修法是：先 seek 到一个极大的时间点，
 * 浏览器为了定位不得不把真实时长算出来，然后再 seek 回 0。
 */
async function readVideoDuration(v) {
  if (Number.isFinite(v.duration) && v.duration > 0) return v.duration;

  const fixed = await new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      v.removeEventListener('timeupdate', finish);
      clearTimeout(timer);
      resolve(Number.isFinite(v.duration) ? v.duration : 0);
    };
    const timer = setTimeout(finish, 3000);
    v.addEventListener('timeupdate', finish);
    try {
      v.currentTime = 1e101;
    } catch (err) {
      finish();
    }
  });

  try { v.currentTime = 0; } catch (err) { /* 忽略 */ }
  return fixed;
}

/**
 * 用户选择了一个视频文件：载入到 <video>，显示第一帧，等用户点「开始分析」。
 */
async function acceptVideoFile(file) {
  if (!file) return;
  if (videoAnalyzing) abortVideoAnalysis();

  if (!/^video\//.test(file.type || '')) {
    showInfo('这不是视频文件。请选择 MP4 / WebM 等常见格式的短视频。', true);
    return;
  }

  // 换视频时把上一个文件的 URL 释放掉，避免内存泄漏
  if (videoFile.dataset.objectUrl) {
    URL.revokeObjectURL(videoFile.dataset.objectUrl);
    videoFile.dataset.objectUrl = '';
  }
  const url = URL.createObjectURL(file);
  videoFile.dataset.objectUrl = url;

  videoFile.src = url;
  videoFile.currentTime = 0;

  // 等元数据（时长、分辨率）就绪
  await new Promise(resolve => {
    let done = false;
    const ok = () => { if (!done) { done = true; resolve(); } };
    videoFile.addEventListener('loadedmetadata', ok, { once: true });
    videoFile.addEventListener('error', ok, { once: true });
    setTimeout(ok, 8000);
  });

  const dur = await readVideoDuration(videoFile);
  if (!videoFile.videoWidth || !dur) {
    videoReady = false;
    ui.videoShown = false;
    videoMeta = null;
    videoName.textContent = '无法读取该视频（可能是不支持的编码，或缺少时长信息）';
    videoStats.textContent = '';
    renderView();
    return;
  }

  videoMeta = {
    name: file.name,
    duration: dur,
    width: videoFile.videoWidth,
    height: videoFile.videoHeight
  };
  videoReady = true;
  ui.videoShown = true;
  videoSummary = null;
  videoFile.hidden = false;
  videoOverlay.hidden = false;

  // 换视频后进度条要归零，否则会留着上一段视频的 100%
  if (videoBar) videoBar.style.width = '0%';

  const mm = Math.floor(dur / 60), ss = Math.round(dur % 60);
  videoName.textContent = `${file.name}　·　${mm > 0 ? mm + ' 分 ' : ''}${ss} 秒　·　${videoMeta.width}×${videoMeta.height}`;
  videoStats.textContent = `预计采样 ${estimateFrameCount(dur)} 帧（每 ${VIDEO_SAMPLE_STEP} 秒一帧），点下方「开始分析」开始。`;
  videoOverlay.width = 1;
  videoOverlay.height = 1;

  showInfo('视频已载入。点下方「开始分析」逐帧识别表情（不会上传，全部在本地完成）。', false);
  renderView();
  updateButtonState();
}

/** 估算采样帧数（和 analyzeVideo 里算的保持一致） */
function estimateFrameCount(duration) {
  const raw = Math.max(1, Math.floor(duration / VIDEO_SAMPLE_STEP));
  return Math.min(raw, VIDEO_MAX_FRAMES);
}

/** 中止分析（用户可以随时点「中止分析」，或切到别的模式时自动调用） */
function abortVideoAnalysis() {
  if (!videoAnalyzing) return;
  videoAbortAt = Date.now();       // 循环里轮询这个值
}

/**
 * 逐帧分析当前载入的视频。
 * 每帧：seek → 检测 → 画框（含打码）→ 记账趋势与统计 → 推进进度。
 */
async function analyzeVideo() {
  if (videoAnalyzing || !videoReady || !modelsReady) return;

  const tStarted = performance.now();

  videoAnalyzing = true;
  videoAbortAt = 0;
  videoSummary = null;
  if (videoBar) videoBar.style.width = '0%';

  // 这次分析要画自己的曲线：清掉旧趋势，横轴用视频内时间
  clearTrend();
  trendTimeOverride = 0;

  const dur  = Number(videoFile.duration) || 0;
  const step = VIDEO_SAMPLE_STEP;
  const total = estimateFrameCount(dur);

  const options = new faceapi.TinyFaceDetectorOptions({
    inputSize: INPUT_SIZE,
    scoreThreshold: SCORE_TH
  });

  let frameIdx = 0, faceFrames = 0, faceTotal = 0;
  const exprCount = {};

  renderView();          // 让「中止」按钮和进度条出现
  videoStats.textContent = `分析中… 0 / ${total} 帧`;

  try {
    for (let i = 0; i < total; i++) {
      if (videoAbortAt) break;

      // 取这一帧：时间点稍微避开视频最后一瞬间（末尾常没有可解码帧）
      const t = Math.min(Math.max(0, dur - 0.05), i * step);
      await seekVideo(videoFile, t);
      if (videoAbortAt) break;

      let results = [];
      try {
        results = await faceapi.detectAllFaces(videoFile, options).withFaceExpressions();
      } catch (err) {
        console.warn('[视频分析] 第 ' + i + ' 帧识别失败，跳过', err);
      }

      // 画到叠加层（打码开关同样生效）
      drawVideoFrameResults(results);

      // 记账：趋势用视频时间轴，统计与摄像头一样逐帧计
      if (results.length) {
        faceFrames++;
        faceTotal += results.length;
        results.forEach(res => {
          const top = topExpression(res.expressions);
          exprCount[top.name] = (exprCount[top.name] || 0) + 1;
        });
        trendTimeOverride = t * 1000;      // 毫秒
        addStats(results, 0, videoFile);
      }

      frameIdx = i + 1;
      const pct = Math.round(frameIdx / total * 100);
      if (videoBar) videoBar.style.width = pct + '%';
      videoStats.textContent = `分析中… ${frameIdx} / ${total} 帧（${pct}%）` +
        (faceTotal ? `　当前累计 ${faceTotal} 张人脸` : '');

      // 让出主线程，界面才更得上新（否则进度条和画框要等全部跑完才刷新）
      await new Promise(r => setTimeout(r, 0));
    }
  } finally {
    trendTimeOverride = null;
    videoAnalyzing = false;
    const aborted = !!videoAbortAt;
    videoAbortAt = 0;

    // 汇总
    let topName = '—', topCount = 0;
    Object.keys(exprCount).forEach(k => {
      if (exprCount[k] > topCount) { topCount = exprCount[k]; topName = k; }
    });
    videoSummary = { frames: frameIdx, faceFrames, faces: faceTotal, topName, topCount };

    // 匿名统计上报（整段视频一次）
    reportSession('video', {
      faces: faceTotal,
      top: Object.keys(exprCount).length ? topName : null,
      topVal: null,
      costMs: Math.round(performance.now() - tStarted),
      durMs: Math.round(dur * 1000),
      expr: exprCount
    });

    if (videoBar) videoBar.style.width = (frameIdx / total * 100) + '%';

    // 分析结束时立刻把曲线画出来。
    // 平时是 300ms 限流重绘，如果这里不强制画，
    // 用户会看到"已记录 N 个采样点"但图还是空的（截图时尤其明显）。
    renderTrend();

    const head = aborted
      ? `已中止：分析了 ${frameIdx} / ${total} 帧`
      : `分析完成：共 ${frameIdx} 帧`;
    const body = faceTotal
      ? `其中 ${faceFrames} 帧检出人脸，合计 ${faceTotal} 张脸；出现最多的表情是「${EXPR_CN[topName] || topName}」（${topCount} 次）。`
      : '这段视频里没有检出人脸。';
    videoStats.textContent = `${head}。${body}`;

    showInfo(
      (aborted ? '视频分析已中止。' : '视频分析完成。') +
      '下方「表情趋势」是这段视频里的表情变化曲线，可导出 CSV。',
      false
    );

    // 把最后一帧的框留在画面上，让用户看到结果
    if (videoOverlay.dataset.lastCount === undefined) {
      videoOverlay.dataset.lastCount = '0';
    }
    renderView();
    updateButtonState();
  }
}

/** 把某一帧的检测结果画到视频叠加层（含打码），坐标系与视频原始像素一致 */
function drawVideoFrameResults(results) {
  const vw = videoFile.videoWidth;
  const vh = videoFile.videoHeight;
  if (!vw || !vh) return;

  if (videoOverlay.width !== vw || videoOverlay.height !== vh) {
    videoOverlay.width  = vw;
    videoOverlay.height = vh;
  }
  // 把叠加层对准视频「真实画面区域」（object-fit: contain 会留白）
  const dispW = syncOverlayToVideo(videoOverlay, videoFile);

  const ctx = videoOverlay.getContext('2d');
  ctx.clearRect(0, 0, videoOverlay.width, videoOverlay.height);

  const scale = dispW ? (videoOverlay.width / dispW) : 1;

  results.forEach((res, i) => {
    const top = topExpression(res.expressions);
    if (maskEnabled) mosaicFaceRect(ctx, videoFile, res.detection.box);
    drawBox(ctx, res.detection.box, faceLabel(i, top, -1), scale);
  });
}

/** 清空视频页的状态（切走模式或重新选片时用） */
function clearVideoFile() {
  if (videoAnalyzing) abortVideoAnalysis();
  videoReady = false;
  ui.videoShown = false;
  videoMeta = null;
  videoSummary = null;

  if (videoFile.dataset.objectUrl) {
    URL.revokeObjectURL(videoFile.dataset.objectUrl);
    videoFile.dataset.objectUrl = '';
  }
  videoFile.removeAttribute('src');
  if (videoBar) videoBar.style.width = '0%';
  if (videoName) videoName.textContent = '未选择视频';
  if (videoStats) videoStats.textContent = '';

  const ctx = videoOverlay.getContext('2d');
  ctx.clearRect(0, 0, videoOverlay.width, videoOverlay.height);

  renderView();
  updateButtonState();
}
