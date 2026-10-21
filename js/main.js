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
  const cam      = (mode === 'camera');
  const hasImage = images.length > 0;
  const multi    = images.length > 1;

  /* ---- 1. 页面：两种模式各一整页，整块切换 ---- */
  pageImage.hidden  = cam;
  pageCamera.hidden = !cam;
  tabImage.classList.toggle('is-active', !cam);
  tabCamera.classList.toggle('is-active', cam);

  /* ---- 2. 顶部状态 / 主按钮 / 信息区标题（两页共用，文案随模式变）---- */
  infoTitle.textContent = cam ? '实时识别信息' : '表情识别信息';

  // 主按钮文案要分清三种情况，不能一律写成"开始识别"：
  //   · 图片模式            → 开始识别
  //   · 摄像头模式未开启    → 开启摄像头
  //   · 摄像头模式已开启    → 停止摄像头
  // 另外识别过程中文案是"识别中…"，由 runDetect 自己接管，这里不能覆盖。
  if (!busy) {
    detectBtn.textContent = cam
      ? (ui.cameraLive ? '停止摄像头' : '开启摄像头')
      : '开始识别';
  }
  detectBtn.classList.toggle('is-stop', ui.cameraLive);

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

  /* ---- 6. 累计统计：有数据才显示 ---- */
  statsBox.hidden = (stats.total === 0);

  /* ---- 7. 表情趋势：没数据整块不显示；只有 1 个点时提示"再识别一次" ---- */
  trendBox.hidden   = (trendData.length === 0);
  trendEmpty.hidden = (trendData.length !== 1);

  /* ---- 8. 人物分组 / 跨照片归属 ---- */
  groupBox.hidden    = !ui.groupShown;
  galleryWrap.hidden = !ui.galleryShown;
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
 * 两个页面（pageImage / pageCamera）是整体切换的，页面内部的标题
 * （「识别结果」/「摄像头实时画面」）是各自页面里的静态文字，
 * 所以这里不需要再改任何文字标签。
 *
 * 注意：下面这些区块**两种模式共用、刻意不切**：
 *   info-box（识别信息）、statsBox（累计统计）、trendBox（表情趋势）
 * 它们的数据跨模式累加，切模式不该清空（趋势曲线的数据是同一个数组）。
 *
 * @param {boolean} animate 是否做高度过渡（启动时不需要，切换时需要）
 */
function applyView(animate) {
  const cam = (mode === 'camera');
  const from = cam ? pageImage : pageCamera;   // 即将隐藏的那一页
  const to   = cam ? pageCamera : pageImage;   // 即将显示的那一页

  // 记下旧页面的高度，用于高度过渡（必须在隐藏之前取）
  const fromHeight = (animate && !from.hidden) ? from.offsetHeight : 0;

  renderView();                                // 唯一的「状态 → 界面」映射

  // 切换时做一次高度过渡，让下方共用区块平滑滑动而不是瞬跳
  if (animate && fromHeight) {
    animatePageHeight(to, fromHeight);
  } else {
    to.style.height = '';
  }
}

function switchMode(target) {
  if (target === mode) return;
  mode = target;

  if (target === 'camera') {
    applyView(true);                   // true = 带高度过渡
    detectBtn.disabled = !modelsReady;
    showInfo('点击下方「开启摄像头」开始实时识别。', false);

  } else {
    // 切回图片模式时，务必关掉摄像头，释放设备
    if (cameraStream) stopCamera();

    applyView(true);
    if (!lastResults) showInfo('尚未开始识别。', false);
    updateButtonState();
  }
}

/** 图片模式下按钮可用性：模型就绪 + 有图片 + 不在识别中 */
function updateButtonState() {
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

// 主按钮：图片模式=开始识别，摄像头模式=开启/停止摄像头
detectBtn.addEventListener('click', () => {
  if (mode === 'camera') {
    if (cameraStream) stopCamera();
    else startCamera();
  } else {
    runDetect();
  }
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
applyView(false);              // false = 启动时不做高度动画

window.addEventListener('DOMContentLoaded', initModels);

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
