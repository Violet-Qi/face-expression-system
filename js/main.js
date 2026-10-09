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
 */
function applyView() {
  const cam = (mode === 'camera');

  // 页面整块切换
  pageImage.hidden  = cam;
  pageCamera.hidden = !cam;

  // 模式按钮的选中态
  tabImage.classList.toggle('is-active', !cam);
  tabCamera.classList.toggle('is-active', cam);

  // 主按钮的文案与样式（按钮是两页共用的，只有文案随模式变）
  detectBtn.textContent = cam ? '开启摄像头' : '开始识别';
  detectBtn.classList.remove('is-stop');

  // 识别信息框的标题
  infoTitle.textContent = cam ? '实时识别信息' : '表情识别信息';
}

function switchMode(target) {
  if (target === mode) return;
  mode = target;

  if (target === 'camera') {
    applyView();
    detectBtn.disabled = !modelsReady;
    showInfo('点击下方「开启摄像头」开始实时识别。', false);

  } else {
    // 切回图片模式时，务必关掉摄像头，释放设备
    if (cameraStream) stopCamera();

    applyView();
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
