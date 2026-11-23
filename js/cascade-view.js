/* ============================================================
   cascade-view.js —— 「异构双引擎级联」页面的控制器
   ------------------------------------------------------------
   这是一个独立的功能窗口（和图片识别/摄像头/视频并排），
   专门展示「face-api 判定 + MediaPipe 强度」的对照结果。

   判定口径（重要）：只看 face-api 的 7 类结果，统计/熵/CSV 都不涉及；
   MediaPipe 只贡献每张脸下面那行"强度描述"（微微一笑 / 开怀大笑…）。
   本页开头也明确标注「实验功能 · 未参与正式统计」。

   与主流程（recognize.js / camera.js / video.js）刻意隔离：
   主流程不知道这个页面存在。这里自己维护一套 state + 渲染，互不干扰。
   ============================================================ */

/* ---------------- 本页独立的图片队列 ---------------- */
let _cascadeImages = [];        // { name, url }
let _cascadeCurrentIdx = 0;
let _cascadeFile = null;        // 当前 File（用于模型读源）
let _cascadeBusy = false;       // 是否正在识别
let _cascadeResults = null;     // face-api 结果数组（带 _cascadeText）
let _cascadeCostMs = 0;
let _cascadeHasResults = false; // 是否已出过一次结果

/* 级联页也用自己的 settings 读法，避免和主流程的 activeSettings 耦合 */
function _cascadeSet() {
  return (typeof curSettings === 'function') ? curSettings() : {};
}

/** 判断用户模型是否已就绪（跟主流程一致的 modelsReady） */
function _cascadeModelsReady() {
  return typeof modelsReady !== 'undefined' ? modelsReady : false;
}

/* ============================================================
   MediaPipe 加载（懒加载，切到本页时预拉一次）
   ============================================================ */
function _cascadeEnsureEngine() {
  if (typeof ensureCascadeEngine !== 'function') return Promise.resolve(false);
  return ensureCascadeEngine();
}

function _cascadeUpdateEngineInfo() {
  const el = document.getElementById('cascadeEngineInfo');
  if (!el) return;
  if (typeof cascadeEngineName === 'function') {
    const name = cascadeEngineName();
    const ready = name !== '未加载';
    el.textContent = ready
      ? 'MediaPipe 已就绪 · ' + name
      : 'MediaPipe 未加载';
    // stylist 的 .cascade-engine-info.is-ready 会把它变蓝（就绪态）
    el.classList.toggle('is-ready', ready);
  }
}

/* ============================================================
   页面切换（由 main.js 的 applyView 调用）
   ============================================================ */
function cascadeShow() {
  // 切到本页时预加载 MediaPipe（约 18 MB，首次较慢）
  _cascadeUpdateEngineInfo();
  if (typeof _cascadePreload === 'function') _cascadePreload();
}

function _cascadePreload() {
  if (_cascadeModelsReady()) {
    _cascadeEnsureEngine().then(ok => {
      if (ok) _cascadeUpdateEngineInfo();
    });
  }
}

/* ============================================================
   选图 / 清空
   ============================================================ */
function _cascadeUpdateDropZone() {
  const has = _cascadeImages.length > 0;
  const img = document.getElementById('cascadeSourceImg');
  const inner = document.getElementById('cascadeDropInner');
  const bar = document.getElementById('cascadeImgBar');
  const zone = document.getElementById('cascadeDropZone');
  if (img) img.hidden = !has;
  if (inner) inner.hidden = has;
  if (bar) bar.hidden = !has;
  if (zone) zone.classList.toggle('has-image', has);
  if (has && img) {
    // 高度过渡：记录当前高度，先锁住避免闪；等图片解码后平滑拉长
    const pageEl = document.getElementById('pageCascade');
    const fromHeight = pageEl ? pageEl.offsetHeight : 0;
    if (typeof pinPageHeight === 'function') pinPageHeight(pageEl, fromHeight);
    img.src = _cascadeImages[_cascadeCurrentIdx].url;
    if (typeof animateImagePageHeight === 'function' && pageEl && fromHeight) {
      animateImagePageHeight(pageEl, fromHeight, 'cascadeSourceImg');
    }
  }
}

function cascadeSetImage(file) {
  if (!file) return;
  if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|gif)$/i.test(file.name)) {
    showInfo('请选择图片文件（JPG / PNG / WebP / GIF）。', true);
    return;
  }
  const url = URL.createObjectURL(file);
  _cascadeImages = [{ name: file.name, url }];
  _cascadeCurrentIdx = 0;
  _cascadeFile = file;
  _cascadeHasResults = false;
  _cascadeResults = null;
  _cascadeUpdateDropZone();
  _cascadeResetResultView();   // 换新图：复位旧结果图/画布，恢复占位（幂等）
  const ph = document.getElementById('cascadePlaceholder');
  if (ph) ph.hidden = false;
  showInfo('图片已就绪，点击「开始识别」运行异构双引擎级联。', false);
}

/* 复位级联结果区（结果图 + 画布 + 占位提示），供清空 / 初始同步共用 */
function _cascadeResetResultView() {
  const img = document.getElementById('cascadeResultImg');
  const ov = document.getElementById('cascadeOverlay');
  const ph = document.getElementById('cascadePlaceholder');
  if (img) { img.hidden = true; img.removeAttribute('src'); }
  if (ov) { try { ov.getContext('2d').clearRect(0, 0, ov.width, ov.height); } catch (e) {} ov.hidden = true; }
  if (ph) ph.hidden = false;
}

/* 显示级联结果区（结果图显示 + 占位提示隐藏）：与 _cascadeResetResultView 成对，
   task-5 给 #cascadeResultImg 加了 hidden，识别成功时必须在这里显式显示回来。 */
function _cascadeShowResultView() {
  const img = document.getElementById('cascadeResultImg');
  const ph = document.getElementById('cascadePlaceholder');
  if (img) img.hidden = false;
  if (ph) ph.hidden = true;
}

function _cascadeClear() {
  // 高度过渡：记录当前高度，先锁住避免闪；清空后平滑缩回
  const pageEl = document.getElementById('pageCascade');
  const fromHeight = pageEl ? pageEl.offsetHeight : 0;
  if (typeof pinPageHeight === 'function') pinPageHeight(pageEl, fromHeight);

  _cascadeImages = [];
  _cascadeCurrentIdx = 0;
  _cascadeFile = null;
  _cascadeHasResults = false;
  _cascadeResults = null;
  _cascadeUpdateDropZone();
  _cascadeResetResultView();
  showInfo('尚未开始识别。', false);

  // 把级联页从高度平滑过渡缩回
  if (typeof animateImagePageHeight === 'function' && pageEl && fromHeight) {
    animateImagePageHeight(pageEl, fromHeight, 'cascadeSourceImg', 60);
  }
}

/* ============================================================
   识别主流程
   ============================================================ */
async function runCascadeDetect() {
  if (_cascadeBusy || !_cascadeHasImage()) return;
  if (!_cascadeModelsReady()) { showInfo('模型尚未加载完成，请稍候。', true); return; }

  _cascadeBusy = true;
  const btn = document.getElementById('cascadeDetectBtn');
  const oldText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '识别中…'; }

  try {
    const url = _cascadeImages[_cascadeCurrentIdx].url;
    const resultImg = document.getElementById('cascadeResultImg');
    resultImg.src = url;
    // 关键：task-5 给 #cascadeResultImg 加了 hidden，这里必须显示回来，否则识别成功也看不到图。
    _cascadeShowResultView();
    if (resultImg.decode) { try { await resultImg.decode(); } catch (e) {} }
    else { await new Promise(r => { resultImg.onload = r; }); }

    // ——① face-api 判定（与主流程一致的模型链）——
    let faResults = [];
    try {
      const options = (typeof buildDetectOptions === 'function') ? buildDetectOptions() : undefined;
      let chain = faceapi
        .detectAllFaces(resultImg, options)
        .withFaceLandmarks(typeof useTinyLandmarks === 'function' ? useTinyLandmarks() : undefined)
        .withFaceExpressions();
      faResults = await chain;
    } catch (e) {
      console.error('[级联] face-api 失败', e);
      showInfo('face-api 识别失败：' + (e.message || e), true);
      return;
    }

    // ——② MediaPipe 强度（并行，失败不影响 face-api 判定）——
    let mpResults = [];
    let mpReady = true;
    try {
      const ok = await _cascadeEnsureEngine();
      if (!ok) { mpReady = false; }
      else { mpResults = runCascadeMediaPipe(resultImg); }
    } catch (e) {
      console.warn('[级联] MediaPipe 失败', e);
      mpReady = false;
    }

    // ——③ 整合：给 face-api 结果附加强度文案（判定权不变）——
    if (typeof attachCascadeDetail === 'function' && mpResults.length) {
      faResults = attachCascadeDetail(faResults, mpResults);
    } else if (!mpResults.length) {
      faResults.forEach(r => { r._cascadeText = mpReady ? '（未检出可用数据）' : '（MediaPipe 未就绪）'; });
    }

    _cascadeResults = { results: faResults, cost: 0 };
    _cascadeHasResults = true;

    _cascadeDraw(faResults);
    _cascadeRenderInfo(faResults, mpReady);
    _cascadeUpdateEngineInfo();
  } finally {
    _cascadeBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = oldText; }
  }
}

function _cascadeHasImage() {
  return _cascadeImages.length > 0 && !!_cascadeImages[_cascadeCurrentIdx].url;
}

/* ============================================================
   绘制检测框（级联页独有：face-api 框用主色，MediaPipe 框用青色虚线）
   ============================================================ */
function _cascadeDraw(faResults) {
  const resultImg = document.getElementById('cascadeResultImg');
  const ov = document.getElementById('cascadeOverlay');
  if (!resultImg || !ov) return;

  ov.width = resultImg.naturalWidth;
  ov.height = resultImg.naturalHeight;

  const wrap = ov.parentElement;
  const wrapRect = wrap.getBoundingClientRect();
  const imgRect = resultImg.getBoundingClientRect();
  // 别在隐藏/未布局的元素上量 rect（会得到 0×0，导致 overlay 也是 0×0）。
  // 若 resultImg 此刻宽高为 0，用父级 .canvas-wrap 的实际尺寸 + 图片自然宽高比推算显示区域，
  // 并按 flex 居中的规则把它定位在 wrap 中央。
  let l, t, w, h;
  if (imgRect.width > 0 && imgRect.height > 0) {
    l = imgRect.left - wrapRect.left;
    t = imgRect.top - wrapRect.top;
    w = imgRect.width;
    h = imgRect.height;
  } else {
    const imgW = resultImg.naturalWidth, imgH = resultImg.naturalHeight;
    if (!imgW || !imgH) return;   // 图片还没真正 decode 出尺寸，干脆不画
    // 与 .preview-img 规则一致：max-width:100%（受 wrap 宽）、max-height:420px
    const wrapW = wrapRect.width || wrap.clientWidth || 1;
    const wrapH = wrapRect.height || wrap.clientHeight || 1;
    const scale = Math.min(wrapW / imgW, 420 / imgH);
    w = Math.min(imgW * scale, wrapW);
    h = Math.min(imgH * scale, wrapH);
    l = (wrapW - w) / 2;
    t = (wrapH - h) / 2;
  }
  ov.style.left = l + 'px';
  ov.style.top = t + 'px';
  ov.style.width = w + 'px';
  ov.style.height = h + 'px';
  ov.hidden = false;

  const ctx = ov.getContext('2d');
  ctx.clearRect(0, 0, ov.width, ov.height);
  // scale = 自然像素 → 显示像素。显示宽度 w 在隐藏/未布局时由上面 fallback 算出，
  // 不能用 imgRect.width（隐藏时为 0，会导致 Infinity）。
  const displayW = (typeof w === 'number' && w > 0) ? w : (imgRect.width || 1);
  const scale = ov.width / displayW || 1;

  faResults.forEach((res, i) => {
    const top = topExpression(res.expressions);
    const box = res.detection.box;
    const lineW = Math.max(2, 3 * scale);
    const fontS = Math.max(11, 18 * scale);
    // face-api 框：主色紫蓝
    ctx.strokeStyle = '#6b7cff';
    ctx.lineWidth = lineW;
    ctx.strokeRect(box.x, box.y, box.width, box.height);
    // 标签：人脸N + 主导情绪
    ctx.fillStyle = '#6b7cff';
    ctx.font = `bold ${fontS}px "Segoe UI", Arial, sans-serif`;
    ctx.textBaseline = 'alphabetic';
    const label = `人脸${i + 1}: ${EXPR_CN[top.name] || top.name}`;
    const ty = (box.y - 6 * scale) > fontS ? (box.y - 6 * scale) : (box.y + fontS + 4 * scale);
    ctx.fillText(label, Math.max(0, box.x), ty);

    // 强度描述（MediaPipe）：显示在框下方，青色小字
    if (res._cascadeText) {
      const text = res._cascadeText;
      const fs2 = Math.max(9, 13 * scale);
      ctx.fillStyle = '#0ea5e9';
      ctx.font = `${fs2}px "Segoe UI", Arial, sans-serif`;
      const ty2 = box.y + box.height + fs2 + 4 * scale;
      ctx.fillText(text, Math.max(0, box.x), ty2);
    }
  });
}

/* ============================================================
   结果信息框（每行：类别 + 强度描述小字）
   ============================================================ */
function _cascadeRenderInfo(faResults, mpReady) {
  const content = document.getElementById('cascadeInfoContent');
  if (!content) return;
  content.innerHTML = '';

  const title = document.createElement('p');
  title.className = 'info-summary';
  title.textContent = (mpReady
    ? '共检测到 ' + faResults.length + ' 张人脸。判定用 face-api（7 类），强度用 MediaPipe（52 维）。'
    : '共检测到 ' + faResults.length + ' 张人脸。MediaPipe 未就绪，仅显示 face-api 判定。');
  content.appendChild(title);

  faResults.forEach((res, i) => {
    const top = topExpression(res.expressions);
    const row = document.createElement('div');
    row.className = 'face-row cascade-face-row';

    const labelLine = document.createElement('span');
    labelLine.className = 'face-label';
    labelLine.textContent = `人脸${i + 1} · ${EXPR_CN[top.name] || top.name} ${(top.value * 100).toFixed(1)}%`;

    const extra = document.createElement('div');
    extra.className = 'cascade-extra';
    extra.textContent = res._cascadeText || (mpReady ? '（未检出可用强度数据）' : '');

    row.appendChild(labelLine);
    row.appendChild(extra);
    content.appendChild(row);
  });
}

/* ============================================================
   事件绑定（在 main.js 加载后统一调用，避免重复绑定）
   ============================================================ */
function bindCascadeEvents() {
  const pick = document.getElementById('cascadePickBtn');
  const fileInput = document.getElementById('cascadeFileInput');
  const sample = document.getElementById('cascadeSampleBtn');
  const replace = document.getElementById('cascadeReplaceBtn');
  const clear = document.getElementById('cascadeClearBtn');
  const detect = document.getElementById('cascadeDetectBtn');

  if (pick) pick.addEventListener('click', () => fileInput && fileInput.click());
  if (fileInput) fileInput.addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    if (f) cascadeSetImage(f);
    e.target.value = '';
  });
  if (sample) sample.addEventListener('click', () => {
    const url = 'samples/test-face.jpg';
    _cascadeImages = [{ name: '测试人脸', url }];
    _cascadeCurrentIdx = 0;
    _cascadeFile = null;
    _cascadeHasResults = false;
    _cascadeUpdateDropZone();
    _cascadeResetResultView();   // 换新示例图：复位旧结果图/画布，恢复占位（幂等）
    showInfo('已载入示例图片，点击「开始识别」运行异构双引擎级联。', false);
  });
  if (replace) replace.addEventListener('click', () => fileInput && fileInput.click());
  if (clear) clear.addEventListener('click', _cascadeClear);
  if (detect) detect.addEventListener('click', runCascadeDetect);

  // 初始同步：进页时两个 img 都无 src，必须立刻隐藏，避免显示碎图图标。
  // _cascadeUpdateDropZone() 会依据 _cascadeImages 长度（初始为空）隐藏上传区图；
  // _cascadeResetResultView() 复位结果区。都做了空值/类型兜底，不会抛错。
  try {
    _cascadeUpdateDropZone();
    _cascadeResetResultView();
  } catch (e) {
    console.error('[级联] 初始视图同步失败：', e);
  }
}
