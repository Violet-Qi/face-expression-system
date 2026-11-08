/* ============================================================
   main.js —— 模式切换、事件绑定与启动
   ------------------------------------------------------------
   应用的"总装"部分，**最后一个加载** —— 因为这里会在加载时立即绑定事件，
   必须保证前面所有文件里的函数都已经定义好了：
     · 页面容器的整块切换（applyView）+ 按钮可用性
     · 所有事件绑定
     · 启动、?auto= / ?demo= 演示参数、?debug=1 测试接口
   ============================================================ */

/* ============================================================
   模式切换
   ============================================================ */

/**
 * ★ 全项目唯一的「状态 → 界面」映射处 ★
 *
 * 所有元素的显示/隐藏、选中态、按钮文案，都在这一个函数里决定。
 * 业务函数（选图、识别、开关摄像头、分组、统计…）**只改数据和 ui 里的标志，
 * 不要自己写 .hidden = ...**，最后调一次 renderView() 让界面跟上。
 *
 * 好处：
 *   · "这一屏到底该长什么样"只有一处答案，不用去十几个函数里拼
 *   · 加一个新面板，只改这里一处
 *   · 界面和行为分离，测试也能直接验证"状态对不对"而不是"谁最后写了 hidden"
 *
 * 判定依据全部是现成的数据，不新增影子状态：
 *   images.length     有没有选图 / 是不是多张
 *   stats.total       有没有累计统计
 *   trendData.length  有没有趋势数据（1 个点时连不成线，显示提示）
 *   ui.*              推导不出来的几项（见 js/config.js 的 ui 注释）
 */
function renderView() {
  const isImg    = (mode === 'image');
  const cam      = (mode === 'camera');
  const isVid    = (mode === 'video');
  const hasImage = images.length > 0;
  const multi    = images.length > 1;

  /* ---- 1. 页面：三种模式各一整页，整块切换 ---- */
  pageImage.hidden  = !isImg;
  pageCamera.hidden = !cam;
  pageVideo.hidden  = !isVid;
  tabImage.classList.toggle('is-active', isImg);
  tabCamera.classList.toggle('is-active', cam);
  tabVideo.classList.toggle('is-active', isVid);

  /* ---- 2. 顶部状态 / 主按钮 / 信息区标题（三页共用，文案随模式变）---- */
  infoTitle.textContent = cam ? '实时识别信息' : (isVid ? '视频分析信息' : '表情识别信息');

  // 主按钮三个页面共用。
  // 曾经这里写成 detectBtn.hidden = isVid —— 而视频页的提示却写着"点下方「开始分析」"，
  // 结果那个按钮根本不存在，analyzeVideo() 从来没有被调用过，视频功能完全无法启动。
  detectBtn.hidden = false;

  // 主按钮文案要分清三个模式：
  //   · 图片模式        → 开始识别
  //   · 摄像头模式      → 未开启=开启摄像头 / 已开启=停止摄像头
  //   · 视频模式        → 未分析=开始分析 / 分析中=中止分析
  // 另外图片识别过程中文案是"识别中…"，由 runDetect 自己接管，这里不能覆盖。
  if (!busy) {
    detectBtn.textContent = cam
      ? (ui.cameraLive ? '停止摄像头' : '开启摄像头')
      : (isVid ? (videoAnalyzing ? '中止分析' : '开始分析') : '开始识别');
  }
  detectBtn.classList.toggle('is-stop', cam ? ui.cameraLive : (isVid && videoAnalyzing));

  /* ---- 3. 上传区：没选图时显示提示，选了图就显示图片 + 操作条 ---- */
  sourceImg.hidden = !hasImage;
  dropInner.hidden = hasImage;
  dropZone.classList.toggle('has-image', hasImage);
  imgBar.hidden    = !hasImage;
  prevBtn.hidden   = !multi;          // 只有多张时才需要前后切换
  nextBtn.hidden   = !multi;
  batchPanel.hidden = !multi;         // 单张时不显示批量面板

  /* ---- 4. 右侧结果画布：识别过才把图片和画布露出来 ---- */
  resultImg.hidden         = !ui.resultShown;
  overlay.hidden           = !ui.resultShown;
  resultPlaceholder.hidden = ui.resultShown;

  /* ---- 5. 摄像头画面：出图时显示 video + 画布，否则显示占位提示 ---- */
  video.hidden             = !ui.cameraLive;
  cameraOverlay.hidden     = !ui.cameraLive;
  cameraPlaceholder.hidden = ui.cameraLive;

  /* ---- 6. 视频文件画面：载入视频后显示 video + 画布 ---- */
  videoFile.hidden        = !ui.videoShown;
  videoOverlay.hidden     = !ui.videoShown;
  videoPlaceholder.hidden = ui.videoShown;
  videoStopBtn.hidden     = !videoAnalyzing;
  videoProgressWrap.hidden = !videoAnalyzing;

  /* ---- 7. 累计统计：有数据才显示 ---- */
  statsBox.hidden = (stats.total === 0);

  /* ---- 8. 表情趋势：没数据整块不显示；只有 1 个点时提示"再识别一次" ---- */
  trendBox.hidden   = (trendData.length === 0);
  trendEmpty.hidden = (trendData.length !== 1);

  /* ---- 9. 人物分组 / 跨照片归属 ---- */
  groupBox.hidden    = !ui.groupShown;
  galleryWrap.hidden = !ui.galleryShown;

  /* ---- 10. 上传预览图上的打码层（左侧也要脱敏，否则"右边打码左边露脸"）---- */
  renderPreviewMask();
}

/**
 * 让页面容器从「上一页的高度」平滑过渡到自身高度。
 *
 * 为什么要这么做：两个页面高度不一样（实测图片页 460px、摄像头页 368px），
 * 直接切换会让下方共用的区块瞬移 92px，看起来像"跳"了一下。
 * 过渡高度可以让它滑动过去。
 *
 * 注意：不能简单给 height 设 auto —— auto 不参与 transition。
 * 标准做法是「先设起始高度 → 强制回流 → 再设目标高度 → 动画结束后清掉内联值」。
 */
function animatePageHeight(el, fromHeight) {
  const targetHeight = el.scrollHeight;      // 此刻 height 还是 auto，取到的是自然高度
  if (!fromHeight || Math.abs(fromHeight - targetHeight) < 1) {
    el.style.height = '';                    // 高度没变，不需要动画
    return;
  }

  el.classList.add('is-animating');
  el.style.height = fromHeight + 'px';
  void el.offsetHeight;                      // 强制回流，让浏览器认下起始值
  el.style.height = targetHeight + 'px';

  // 动画结束（或超时兜底）后清掉内联高度，恢复 auto，避免影响后续布局
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    el.style.height = '';
    el.classList.remove('is-animating');
    clearTimeout(timer);
  };
  const timer = setTimeout(finish, 400);
  el.addEventListener('transitionend', finish, { once: true });
}

/**
 * 唯一的「状态 → 界面」映射处。
 *
 * 布局相关的显隐**全部**由 mode 推导出来，不要在别处零散地写
 * .hidden = true/false —— 那样加一个新面板就要满地找地方改。
 *
 * 三个页面（pageImage / pageCamera / pageVideo）是整体切换的，页面内部的标题
 * （「识别结果」/「摄像头实时画面」/「视频文件逐帧分析」）是各自页面里的静态文字，
 * 所以这里不需要再改任何文字标签。
 *
 * 注意：下面这些区块**三种模式共用、刻意不切**：
 *   info-box（识别信息）、statsBox（累计统计）、trendBox（表情趋势）
 * 它们的数据跨模式累加，切模式不该清空（趋势曲线的数据是同一个数组）。
 *
 * @param {boolean} animate 是否做高度过渡（启动时不需要，切换时需要）
 */
function applyView(animate) {
  const pages = { image: pageImage, camera: pageCamera, video: pageVideo };
  const to = pages[mode] || pageImage;                 // 即将显示的那一页

  // 找出当前正在显示、且不是目标的那一页（用于取旧高度做过渡）
  let from = null;
  let fromMode = null;
  Object.keys(pages).forEach(k => {
    if (pages[k] !== to && !pages[k].hidden) { from = pages[k]; fromMode = k; }
  });

  // 记下旧页面的高度，用于高度过渡（必须在隐藏之前取）
  const fromHeight = (animate && from) ? from.offsetHeight : 0;

  // 动效：给旧页面拍快照，让它稍后"原地飞出"（必须在 renderView 隐藏它之前）
  if (animate && from) startLeaveFx(from, fromMode, mode);

  renderView();                                        // 唯一的「状态 → 界面」映射

  // 切换时做一次高度过渡，让下方共用区块平滑滑动而不是瞬跳
  if (animate && fromHeight) {
    animatePageHeight(to, fromHeight);
  } else {
    to.style.height = '';
  }

  // 动效：新页面的模块从四面八方飞入（重播入场动画）
  if (animate) replayEnterFx();
}

/* ============================================================
   动效：切换模式时「旧页面飞出、新页面飞入」
   ------------------------------------------------------------
   关键点：`.hidden` 是**立刻**改变的（业务和测试都读它），
   飞出纯粹是视觉层 —— 给旧页面挂 .is-leaving 让它在 180ms 内仍然可见，
   同时用 position:fixed 按快照坐标留在原地，然后飞走。
   所以页面的显隐状态一秒都没被推迟。
   ============================================================ */

let fxLeaveTimer = null;

/** 是否关掉了动态效果（系统设置） */
function fxReduced() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function startLeaveFx(oldPage, oldMode, newMode) {
  if (!oldPage || fxReduced()) return;

  // 上一次还没播完就清掉，避免两层叠在一起
  if (fxLeaveTimer) { clearTimeout(fxLeaveTimer); fxLeaveTimer = null; }
  document.querySelectorAll('.page.is-leaving').forEach(el => {
    el.classList.remove('is-leaving', 'fx-out-left', 'fx-out-right');
    el.style.top = el.style.left = el.style.width = el.style.height = '';
  });

  const r = oldPage.getBoundingClientRect();
  if (!r.width || !r.height) return;

  oldPage.style.top    = r.top + 'px';
  oldPage.style.left   = r.left + 'px';
  oldPage.style.width  = r.width + 'px';
  oldPage.style.height = r.height + 'px';
  oldPage.classList.add('is-leaving');

  // 往哪飞：新页在右边 → 旧页向左飞；新页在左边 → 旧页向右飞
  const order = { image: 0, camera: 1, video: 2 };
  const goRight = (order[newMode] || 0) < (order[oldMode] || 0);
  oldPage.classList.add(goRight ? 'fx-out-right' : 'fx-out-left');

  fxLeaveTimer = setTimeout(() => {
    oldPage.classList.remove('is-leaving', 'fx-out-left', 'fx-out-right');
    oldPage.style.top = oldPage.style.left = oldPage.style.width = oldPage.style.height = '';
    fxLeaveTimer = null;
  }, 220);
}

/**
 * 切换模式时重播「页面内容飞入」动画。
 *
 * 用 `fx-switch` 而不是首屏那个 `fx-anim`：切换时只让页面内容飞，
 * **页签、状态条、主按钮保持不动** —— 它们跟着飞的话，用户会觉得
 * 导航和主操作凭空消失了半秒。
 *
 * 原理：动画挂在 `body.fx-switch` 下，所以"移除类 → 强制回流 → 加回类"
 * 会让元素的计算 animation-name 从 none 变回有值，动画才会重新播放。
 * 直接改样式没用 —— 同名动画不会自动重启。
 */
function replayEnterFx() {
  if (fxReduced()) return;
  document.body.classList.remove('fx-switch');
  void document.body.offsetWidth;      // 强制回流，重置动画
  document.body.classList.add('fx-switch');
}

function switchMode(target) {
  if (target === mode) return;
  const prev = mode;
  mode = target;

  // 离开摄像头模式：务必关掉摄像头，释放设备
  if (prev === 'camera' && cameraStream) stopCamera();

  // 离开视频页：中止正在跑的分析，否则它会继续占着 CPU
  if (prev === 'video' && videoAnalyzing) abortVideoAnalysis();

  applyView(true);                   // true = 带高度过渡

  if (target === 'camera') {
    detectBtn.disabled = !modelsReady;
    showInfo('点击下方「开启摄像头」开始实时识别。', false);

  } else if (target === 'video') {
    showInfo(
      videoReady
        ? '视频已载入，点「开始分析」逐帧识别。'
        : '点「选择本地视频」载入一段短视频，然后逐帧识别表情（不会上传）。',
      false
    );

  } else {
    if (!lastResults) showInfo('尚未开始识别。', false);
    updateButtonState();
  }
}

/** 主按钮可用性：图片模式=有图，视频模式=已载入视频；摄像头模式不限制 */
function updateButtonState() {
  if (mode === 'video') {
    // 已载入视频、或正在分析（此时按钮是「中止分析」，要能点）才可点
    detectBtn.disabled = !(modelsReady && (videoReady || videoAnalyzing));
    return;
  }
  if (mode !== 'image') return;
  detectBtn.disabled = !(modelsReady && hasImage() && !busy);
  batchBtn.disabled = !(modelsReady && images.length > 1 && !busy && !batchRunning);
  batchCsvBtn.disabled = batchResults.filter(Boolean).length === 0;
}

/* ============================================================
   事件绑定
   ============================================================ */

// 模式切换
tabImage.addEventListener('click', () => switchMode('image'));
tabCamera.addEventListener('click', () => switchMode('camera'));
tabVideo.addEventListener('click', () => switchMode('video'));

// 视频文件：选片 / 中止分析
pickVideoBtn.addEventListener('click', () => videoInput.click());
videoInput.addEventListener('change', e => {
  const f = e.target.files && e.target.files[0];
  if (f) acceptVideoFile(f);
  e.target.value = '';        // 允许连续选同一个文件
});
videoStopBtn.addEventListener('click', () => {
  abortVideoAnalysis();
  showInfo('已请求中止分析…', false);
});

// 点击选择文件（支持一次多选）
$('pickBtn').addEventListener('click', () => fileInput.click());
replaceBtn.addEventListener('click', () => fileInput.click());
clearImgBtn.addEventListener('click', () => clearImages());
prevBtn.addEventListener('click', () => gotoPrevImage());
nextBtn.addEventListener('click', () => gotoNextImage());

// 选完图之后，图片本身也可以再点一次直接换图 —— 否则用户会觉得"卡住了没法换"
sourceImg.addEventListener('click', () => fileInput.click());

dropInner.addEventListener('click', e => {
  if (e.target.id === 'dropInner' || e.target.classList.contains('drop-icon') ||
      e.target.classList.contains('drop-text') || e.target.classList.contains('drop-hint')) {
    fileInput.click();
  }
});
fileInput.addEventListener('change', e => {
  acceptFiles(e.target.files);
  fileInput.value = '';   // 允许连续选择同一张图片
});

// 使用示例图片
$('sampleBtn').addEventListener('click', () => acceptUrl(SAMPLE_URL));

// 拖拽上传（支持一次拖入多张）
['dragenter', 'dragover'].forEach(evt =>
  dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.classList.add('dragover'); }));
['dragleave', 'drop'].forEach(evt =>
  dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.classList.remove('dragover'); }));
dropZone.addEventListener('drop', e => {
  const dt = e.dataTransfer;
  if (dt && dt.files && dt.files.length) acceptFiles(dt.files);
});

// 批量识别
batchBtn.addEventListener('click', () => runBatch());
batchCsvBtn.addEventListener('click', () => exportBatchCsv());

// 键盘左右方向键切换图片（在看多张图时很顺手）
window.addEventListener('keydown', e => {
  if (mode !== 'image' || images.length < 2) return;
  const t = e.target;
  // 输入框里按方向键不该切图
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  if (e.key === 'ArrowLeft')  { gotoPrevImage(); }
  if (e.key === 'ArrowRight') { gotoNextImage(); }
});

// 主按钮：图片=开始识别，摄像头=开启/停止，视频=开始分析/中止分析
detectBtn.addEventListener('click', () => {
  if (mode === 'camera') {
    if (cameraStream) stopCamera();
    else startCamera();
    return;
  }
  if (mode === 'video') {
    // 视频页：没在分析就开跑，正在分析就中止
    if (videoAnalyzing) abortVideoAnalysis();
    else analyzeVideo();
    return;
  }
  runDetect();
});

// 人物分组开关：只记住用户的意愿，模型等真正识别时才懒加载
groupToggle.addEventListener('change', () => {
  groupEnabled = groupToggle.checked;
  // 关掉开关时清掉上一次的分组结果，避免残留着旧组号
  if (!groupEnabled) {
    lastGroups = null;
    // 画布和信息列表都要重绘 —— 组号在信息列表里也有，
    // 只重画画布的话列表上会残留上一次的人物编号。
    clearGroupCards();
    if (lastResults) {
      drawResults(lastResults);
      renderInfo(lastResults, lastInfoCostMs, null);
    }
  }
  updateButtonState();
});

// 人脸脱敏开关：只影响显示，原图不动
maskToggle.addEventListener('change', () => {
  maskEnabled = maskToggle.checked;

  // 打码会同时影响结果画布、左侧预览图、所有小头像，所以要整体重画一遍。
  // 摄像头模式不用管：下一帧（400ms 内）会自己带上打码。
  if (mode === 'image' && lastResults) {
    drawResults(lastResults, lastGroups);   // 内部会顺带刷新左侧预览图的打码层
    if (lastGroups) renderGroupCards(lastResults, lastGroups);
    if (galleryData) {
      renderGallery();
      redrawCurrentWithCrossPhotoLabels();
    }
  }
  renderView();   // 没有识别结果时也要让打码层跟着收起/出现
});

// 匿名统计上报开关：只影响上报，不影响识别
if (reportToggle) reportToggle.addEventListener('change', () => {
  setReportEnabled(reportToggle.checked);
  showInfo(reportToggle.checked
    ? '已允许上报匿名统计（只含表情计数与人数，不含图片）。'
    : '已关闭匿名统计上报，之后不会再发送任何数据。', false);
});

// 趋势面板：导出 / 清空
trendCsvBtn.addEventListener('click', exportTrendCsv);
trendClearBtn.addEventListener('click', clearTrend);

// 窗口尺寸变化时重新绘制检测框（响应式）。
// 注意：这里必须「重画」而不是只 clearRect —— 否则一改变窗口大小，识别框就全没了。
let resizeTimer = null;
window.addEventListener('resize', () => {
  // 折线图也要跟着重画，否则画布会被拉伸变形
  if (trendData.length >= 2) {
    trendPlot = buildTrendPlot();
    drawTrendChart(trendPlot);
  }
  if (mode !== 'image' || !lastResults || overlay.hidden) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (lastResults) drawResults(lastResults, lastGroups); }, 120);
});

// 关闭页面时释放摄像头，避免摄像头指示灯一直亮着
window.addEventListener('beforeunload', () => {
  if (trendRedrawTimer) clearTimeout(trendRedrawTimer);
  if (cameraStream) cameraStream.getTracks().forEach(t => t.stop());
});

/* ============================================================
   可选：?auto=1 直接跑一遍（演示与自动化测试用）
   ============================================================ */
async function runAutoMode() {
  const params = new URLSearchParams(location.search);

  // ?mode=camera 只切换到摄像头模式但不开启摄像头（用于查看界面）
  if (params.get('mode') === 'camera') {
    switchMode('camera');
    return;
  }

  // ?camera=1 自动进入摄像头模式并开启（用于演示与自动化测试）
  if (params.get('camera') === '1') {
    switchMode('camera');
    await startCamera();
    return;
  }

  // ?demo=<名字> 自动载入一组示例照片并跑批量识别（供演示）
  //   demo=gallery  6 张照片，用来展示"跨照片人物归属汇总"
  //   demo=group    一张多人合影，用来展示"人物分组"
  const demo = params.get('demo');
  if (demo) {
    const sets = {
      gallery: [
        'tests/images/01-单人脸.jpg',
        'tests/images/05-大尺寸图片.jpg',
        'tests/images/02-两张人脸.jpg',
        'tests/faces_seed/woman-44_1.jpg',
        'tests/faces_seed/woman-68_1.jpg',
        'tests/faces_seed/man-75_1.jpg'
      ],
      group: ['tests/images/11-多人合影.png']
    };
    const urls = sets[demo];
    if (urls) {
      if (demo === 'gallery') {
        const r = await loadPhotoSet(urls);
        console.log('[演示] 跨照片汇总:', r);
      } else {
        if (!groupEnabled) { groupToggle.checked = true; groupEnabled = true; }
        acceptUrl(urls[0]);
        await new Promise(r => setTimeout(r, 100));
        await runDetect();
      }
    }
    return;
  }

  if (!params.has('auto')) return;
  const target = params.get('auto');
  acceptUrl(target && target.length > 1 ? target : SAMPLE_URL);
  await runDetect();
}

/**
 * 载入一组示例照片并跑批量识别（供演示与自动化测试使用）。
 * 会顺带打开人物分组，因为跨照片归属汇总依赖人脸特征。
 * @param {string[]} urls 图片地址
 */
async function loadPhotoSet(urls) {
  if (!modelsReady) return { ok: false, reason: '模型未就绪' };

  if (!groupEnabled) {
    groupToggle.checked = true;
    groupEnabled = true;
  }

  const files = [];
  for (const u of urls) {
    try {
      const resp = await fetch(u);
      if (!resp.ok) continue;
      const blob = await resp.blob();
      const name = decodeURIComponent(u.split('/').pop());
      files.push(new File([blob], name, { type: blob.type || 'image/jpeg' }));
    } catch (err) {
      console.warn('[载入示例] 取不到 ' + u, err);
    }
  }
  if (!files.length) return { ok: false, reason: '没有取到任何图片' };

  acceptFiles(files);
  await new Promise(r => setTimeout(r, 120));
  await runBatch();
  return { ok: true, photos: images.length };
}

/* ---------------- 启动 ---------------- */
// 脚本都在 body 末尾，执行到这里时 DOM 已经全部解析完，
// 所以可以**立即**按状态摆好界面，不必等 DOMContentLoaded。
// 正因如此，index.html 里不需要任何 hidden 属性来表达初始状态 ——
// 所有显隐一律由 renderView() 负责，只有这一个来源。
// 第一件事就是把界面摆对（只显示图片页）。这样即使后面任何一步出问题，
// 也不会出现"几个页面同时露出来"的坏状态。
try {
  applyView(false);            // false = 启动时不做高度动画
} catch (err) {
  console.error("[启动] 界面初始化失败：", err);
}

// 匿名统计：先探一次后端在不在（只用 Python 起静态服务时会探不到，那就静默关掉）
if (typeof reportToggle !== 'undefined' && reportToggle) reportToggle.checked = reportEnabled;
probeReportBackend().then(ok => {
  if (!ok) console.info('[report] 未检测到后端接口，匿名统计上报已自动关闭（不影响识别）。');
});

window.addEventListener('DOMContentLoaded', initModels);

/* ============================================================
   封面：点「开始体验」才进入功能页
   ------------------------------------------------------------
   为什么要有这一层：
   · 演示有仪式感，先给一张封面比直接扔个页面好
   · 把模型加载的等待时间藏起来（模型在封面后面照常加载）
   · 入场动画在"点开始"那一刻才播（否则一打开就播完，根本看不见）

   测试怎么办：带 ?debug=1 或 ?cover=0 时直接跳过封面，
   所以 195 项回归一行都不用改。
   ============================================================ */

let coverEntered = false;

/** 封面期间锁住页面滚动（见 css 的 body.cover-open） */
function setCoverScrollLock(on) {
  // 滚动条是 html 的，只锁 body 不管用
  if (document.documentElement) document.documentElement.classList.toggle('cover-open', !!on);
  if (document.body) document.body.classList.toggle('cover-open', !!on);
}

/** 是否跳过封面（测试 / 调试用） */
function coverSuppressed() {
  const q = new URLSearchParams(location.search);
  return q.has('debug') || q.get('cover') === '0';
}

/** 重播首屏那套入场动画（从四面八方飞入） */
function replayBootFx() {
  if (fxReduced()) return;
  document.body.classList.remove('fx-anim');
  void document.body.offsetWidth;      // 强制回流，让动画重置
  document.body.classList.add('fx-anim');
}

/** 点「开始体验」/按回车 → 收起封面并播入场动画 */
function enterApp() {
  if (coverEntered) return;
  coverEntered = true;

  if (cover) {
    cover.classList.add('is-leaving');
    // 420ms 动画放完再彻底移除，避免它继续挡住点击
    setTimeout(() => cover.classList.add('is-gone'), 430);
  }
  setCoverScrollLock(false);           // 解开滚动锁
  // 入场动画在这一刻才播
  replayBootFx();
}

/** 模型加载完成 → 解开封面上的按钮（由 models.js 调用） */
function onModelsReady() {
  if (!coverStart) return;
  coverStart.disabled = false;
  coverStart.textContent = '开始体验';
  if (coverStatus) coverStatus.textContent = '模型已就绪，点击开始进入。';
}

if (cover && !coverSuppressed()) {
  setCoverScrollLock(true);
  coverStart.addEventListener('click', enterApp);

  // 键盘也能进：回车 / 空格
  document.addEventListener('keydown', e => {
    if (coverEntered) return;
    if (e.key === 'Enter' || e.key === ' ') {
      if (!coverStart.disabled) { e.preventDefault(); enterApp(); }
    }
  });
} else if (cover) {
  // 跳过封面时直接收起来（不播动画，测试要的就是静态最终态）
  cover.classList.add('is-gone');
  coverEntered = true;
}


/* ------------------------------------------------------------
   供自动化测试使用的小接口（?debug=1 时才挂到 window 上）。
   平时不影响任何功能，只是让测试脚本能读到内部状态、能拦住下载。
   ------------------------------------------------------------ */
if (new URLSearchParams(location.search).has('debug')) {
  /** 调一次导出，但拦下真实下载，把 Blob 交回来 */
  async function captureCsvBlob() {
    const origCreate = URL.createObjectURL;
    const origClick  = HTMLAnchorElement.prototype.click;
    const origAppend = document.body.appendChild;
    const origRemove = document.body.removeChild;
    const origRevoke = URL.revokeObjectURL;
    let captured = null;

    URL.createObjectURL = function (blob) { captured = blob; return 'blob:test'; };
    URL.revokeObjectURL = function () {};
    HTMLAnchorElement.prototype.click = function () {};
    document.body.appendChild = function (n) { return n; };   // 不真的插入
    document.body.removeChild = function (n) { return n; };   // 配套不真的移除

    try {
      exportTrendCsv();
      await new Promise(r => setTimeout(r, 30));
      return captured;
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
      HTMLAnchorElement.prototype.click = origClick;
      document.body.appendChild = origAppend;
      document.body.removeChild = origRemove;
    }
  }

  window.__dshTest = {
    /** 当前采样点数、是否已画出曲线、曲线数据点个数 */
    trendState: () => ({
      points: trendData.length,
      drawn: !!trendPlot,
      plotPoints: trendPlot ? trendPlot.points.length : 0,
      spanSec: trendData.length >= 2
        ? +((trendData[trendData.length - 1].time - trendData[0].time) / 1000).toFixed(2)
        : 0
    }),

    /** CSV 文本。注意 Blob.text() 按规范会剥掉 UTF-8 BOM，所以它验不出 BOM */
    csvRead: async () => {
      const blob = await captureCsvBlob();
      return blob ? await blob.text() : '';
    },

    /** CSV 前几个原始字节（十六进制），用于验证 BOM 真的存在于字节层 */
    csvBytes: async () => {
      const blob = await captureCsvBlob();
      if (!blob) return '';
      const buf = await blob.slice(0, 6).arrayBuffer();
      return Array.from(new Uint8Array(buf))
        .map(x => x.toString(16).padStart(2, '0')).join(' ');
    },

    /** 清空趋势，便于测试从零开始 */
    clear: () => clearTrend(),

    /** 聚类算法本身：给定 128 维描述子数组和阈值，返回分组结果。
        暴露出来是为了能用"已知标准答案"的测试数据直接验证算法，不必依赖界面。 */
    cluster: (descriptors, threshold) => clusterDescriptors(descriptors, threshold),

    /** 自动定阈值：给定一组两两距离，返回建议阈值（找不到断层返回 null） */
    autoThreshold: (distances) => autoThreshold(distances),

    /** 两个描述子的距离 */
    distance: (a, b) => descriptorDistance(a, b),

    /** 当前分组开关状态与最近一次分组结果 */
    groupState: () => ({
      enabled: groupEnabled,
      netReady: descriptorNetReady,
      groups: lastGroups
        ? {
            k: lastGroups.k,
            labels: Array.from(lastGroups.labels),
            maxIntra: +lastGroups.maxIntraDistance.toFixed(4),
            autoThreshold: lastGroups.autoThreshold
          }
        : null
    }),

    /** 打开/关闭人物分组开关（测试用，等价于用户勾选） */
    setGroup: (on) => {
      groupToggle.checked = !!on;
      groupEnabled = !!on;
      if (!on) {
        lastGroups = null;
        clearGroupCards();
        if (lastResults) {
          drawResults(lastResults);
          renderInfo(lastResults, lastInfoCostMs, null);
        }
      }
      updateButtonState();
      return groupEnabled;
    },

    /** 生成一段用于演示/出图的趋势数据。
        只在 ?debug=1 时可用，正常使用（不带 debug 参数）根本不会挂上这个接口。
        用固定公式而不是随机数，保证每次出图长得一样，方便写进文档。 */
    seedDemo: (n) => {
      const count = n || 40;
      clearTrend();
      const wave = [0.86, 0.91, 0.95, 0.88, 0.72, 0.61, 0.55, 0.68, 0.83, 0.94];
      const names = ['happy', 'happy', 'happy', 'neutral', 'neutral',
                     'neutral', 'surprised', 'happy', 'happy', 'happy'];
      for (let i = 0; i < count; i++) {
        const k = i % wave.length;
        const name = names[k];
        const value = Math.min(0.99, wave[k]);
        const expr = {};
        expr[name] = value;
        trendData.push({
          time: i * 500,
          faces: 1,
          imageW: 640, imageH: 480,
          dominant: { name, value },
          exprName: 'video',
          exprValue: value,
          expr
        });
      }
      trendStartAt = 0;
      renderTrend();
      updateTrendMeta(1, trendData[trendData.length - 1].dominant.name);
      return trendData.length;
    }
  };
}
