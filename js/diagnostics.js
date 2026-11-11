/* ============================================================
   诊断面板 + 阈值对比实验（v1.8.0）
   ------------------------------------------------------------
   两个功能都是"把看不见的东西摆到台面上"：

   ① 诊断面板
      显示后端（webgl / cpu）、模型加载状态、输入尺寸、单帧耗时、
      设备编号等。被问「你怎么证明是在本地算的」「性能怎么样」时，
      直接指着面板说话，比空口保证有力。

   ② 阈值对比实验
      同一张图，用 0.30 / 0.50 / 0.70 三档检测阈值各跑一遍，
      记录检出人脸数与耗时。用户可以填「真实有几张脸」，
      就能算出漏检数 —— 这才是「阈值敏感性分析」，
      而不是「我加了个滑块」。

   两个都只读、不改任何主流程，纯前端，不上传任何东西。
   ============================================================ */

/* ---------------- 一、诊断面板 ---------------- */

const DIAG_MODELS = [
  { key: 'tinyFaceDetector',        net: () => faceapi.nets.tinyFaceDetector,        cn: '人脸检测' },
  { key: 'faceLandmark68TinyNet',   net: () => faceapi.nets.faceLandmark68TinyNet,   cn: '关键点' },
  { key: 'faceExpressionNet',       net: () => faceapi.nets.faceExpressionNet,       cn: '表情分类' }
];

/** 读当前运行状态，返回一个纯数据对象（方便测试断言） */
function collectDiagnostics() {
  const tf = faceapi.tf;
  let backend = '未知';
  try { backend = tf && typeof tf.getBackend === 'function' ? (tf.getBackend() || '未初始化') : '未知'; } catch (e) { backend = '读取失败'; }

  let modelsLoaded = 0;
  const modelRows = DIAG_MODELS.map(m => {
    let loaded = false;
    try { loaded = !!(m.net() && m.net().isLoaded); } catch (e) { loaded = false; }
    if (loaded) modelsLoaded++;
    return { cn: m.cn, loaded };
  });

  const hasImg = (typeof images !== 'undefined') && images.length > 0;
  const imgEl = document.getElementById('resultImg');
  const lastFaces = (typeof lastResults !== 'undefined' && lastResults) ? lastResults.length : 0;

  return {
    backend,
    presetName: (typeof currentPresetName === 'function') ? currentPresetName() : '—',
    exprEngine: (typeof currentExpressionEngineName === 'function') ? currentExpressionEngineName() : '—',
    presetKey: (typeof activePreset !== 'undefined') ? activePreset : '—',
    ssdReady: (typeof ssdReady !== 'undefined') ? ssdReady : false,
    modelsLoaded,
    modelsTotal: DIAG_MODELS.length,
    modelRows,
    inputSize: typeof INPUT_SIZE === 'number' ? INPUT_SIZE : null,
    detectThreshold: (typeof curSettings === 'function') ? curSettings().detectThreshold : null,
    lastCostMs: (typeof lastInfoCostMs === 'number' && lastInfoCostMs) ? lastInfoCostMs : null,
    lastFaces,
    imageSize: (hasImg && imgEl && imgEl.naturalWidth)
      ? (imgEl.naturalWidth + '×' + imgEl.naturalHeight) : '未载入',
    hasImage: hasImg,
    deviceId: (typeof deviceId === 'function' && deviceId()) ? deviceId().slice(0, 8) : '不可用',
    dpr: window.devicePixelRatio || 1,
    ua: (navigator.userAgent || '').indexOf('Mobile') >= 0 ? '移动端' : '桌面端'
  };
}

/** 把诊断信息刷到面板上 */
function renderDiagPanel() {
  const d = collectDiagnostics();
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

  set('diagBackend', d.backend === 'webgl' ? 'webgl（显卡加速）' : d.backend === 'cpu' ? 'cpu（软件计算）' : d.backend);
  set('diagModels', d.modelsLoaded + ' / ' + d.modelsTotal + ' 已加载');
  set('diagInput', d.inputSize ? (d.inputSize + ' × ' + d.inputSize) : '—');
  set('diagThreshold', d.detectThreshold != null ? Number(d.detectThreshold).toFixed(2) : '—');
  set('diagCost', d.lastCostMs ? (d.lastCostMs + ' ms') : '还没识别过');
  set('diagFaces', d.lastFaces ? (d.lastFaces + ' 张') : '—');
  set('diagImage', d.imageSize);
  set('diagPreset', d.presetName + (d.presetKey === 'speed' ? '' : '（SSD）'));
  set('diagExprEngine', d.exprEngine);
  set('diagDevice', d.deviceId);
  set('diagEnv', d.ua + ' · DPR ' + d.dpr);

  // 模型状态灯
  const box = document.getElementById('diagModelList');
  if (box) {
    box.innerHTML = d.modelRows.map(m =>
      '<span class="diag-dot ' + (m.loaded ? 'is-ok' : 'is-off') + '">' + m.cn + '</span>'
    ).join('');
  }
}

/* ---------------- 二、阈值对比实验 ---------------- */

const EXPERIMENT_THRESHOLDS = [0.30, 0.50, 0.70];

/**
 * 对同一张图，用不同置信度阈值各跑一遍检测。
 * 只跑**人脸检测**，不跑关键点和表情分类 —— 因为要对比的是"检测阈值"的影响，
 * 带上表情分类会让耗时混入无关成本，结论就不干净了。
 */
async function runThresholdExperiment() {
  if (typeof images === 'undefined' || !images.length) {
    return { ok: false, error: '先选一张图片再运行实验' };
  }
  if (!modelsReady) {
    return { ok: false, error: '模型还没加载完，稍等一下' };
  }
  const img = document.getElementById('resultImg');
  if (!img || !img.naturalWidth) {
    return { ok: false, error: '图片还没渲染好，重试一次' };
  }

  const rows = [];
  for (const th of EXPERIMENT_THRESHOLDS) {
    const options = new faceapi.TinyFaceDetectorOptions({
      inputSize: INPUT_SIZE,
      scoreThreshold: th
    });
    const t0 = performance.now();
    let dets = [];
    try {
      dets = await faceapi.detectAllFaces(img, options);
    } catch (e) {
      return { ok: false, error: '第 ' + th + ' 档检测失败：' + e.message };
    }
    const ms = Math.round(performance.now() - t0);
    // 顺便记一下每张脸的置信度，方便看阈值到底卡掉了什么
    const scores = dets.map(d => Number(d.score.toFixed(3)));
    rows.push({ threshold: th, faces: dets.length, costMs: ms, scores });
  }

  return { ok: true, rows, imageLabel: img.naturalWidth + '×' + img.naturalHeight };
}

/** 把实验结果画成表格 */
function renderExperiment(result) {
  const box = document.getElementById('expResult');
  const msg = document.getElementById('expMsg');
  if (!box) return;

  if (!result || !result.ok) {
    if (msg) { msg.hidden = false; msg.textContent = (result && result.error) || '实验失败'; }
    box.innerHTML = '';
    return;
  }
  if (msg) msg.hidden = true;

  // 用户填的"真实人脸数"，用来算漏检；不填就不显示这一列
  const truthEl = document.getElementById('expTruth');
  const truth = truthEl ? parseInt(truthEl.value, 10) : NaN;
  const hasTruth = Number.isFinite(truth) && truth >= 0;

  const head = '<tr><th>检测阈值</th><th>检出人脸</th>' +
               (hasTruth ? '<th>漏检</th><th>准确率</th>' : '') +
               '<th>检测耗时</th><th>各脸置信度</th></tr>';

  const body = result.rows.map(r => {
    const miss = hasTruth ? Math.max(0, truth - r.faces) : null;
    const acc = hasTruth && truth > 0
      ? Math.min(100, Math.round(r.faces / truth * 100)) + '%'
      : (hasTruth ? '—' : null);
    return '<tr' + (r.threshold === curSettings().detectThreshold ? ' class="is-current"' : '') + '>' +
      '<td>' + r.threshold.toFixed(2) + (r.threshold === curSettings().detectThreshold ? ' <span class="tag">当前</span>' : '') + '</td>' +
      '<td>' + r.faces + ' 张</td>' +
      (hasTruth ? '<td>' + miss + ' 张</td><td>' + acc + '</td>' : '') +
      '<td>' + r.costMs + ' ms</td>' +
      '<td class="exp-scores">' + (r.scores.length ? r.scores.join('、') : '—') + '</td>' +
      '</tr>';
  }).join('');

  const note = hasTruth
    ? '图片尺寸 ' + result.imageLabel + '　·　你标定真实 <b>' + truth + '</b> 张脸'
    : '图片尺寸 ' + result.imageLabel + '　·　在「真实人脸数」里填个数，就能算出漏检和准确率';

  box.innerHTML = '<table class="exp-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>' +
                  '<p class="exp-note">' + note + '</p>';
}

/* ---------------- 三、接线 ---------------- */

function initDiagnosticsUI() {
  const refresh = document.getElementById('diagRefresh');
  if (refresh) refresh.addEventListener('click', () => { renderDiagPanel(); });

  const runBtn = document.getElementById('expRun');
  if (runBtn) runBtn.addEventListener('click', async () => {
    const msg = document.getElementById('expMsg');
    runBtn.disabled = true;
    const old = runBtn.textContent;
    runBtn.textContent = '检测中…';
    if (msg) { msg.hidden = false; msg.textContent = '正在用三档阈值各跑一遍，稍等…'; }
    try {
      const r = await runThresholdExperiment();
      lastExperiment = r;          // 存下来，改「真实人脸数」时不用重跑检测
      renderExperiment(r);
    } catch (e) {
      renderExperiment({ ok: false, error: e.message });
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = old;
    }
  });

  // 改了"真实人脸数"就重算漏检（不重新跑检测）
  const truthEl = document.getElementById('expTruth');
  if (truthEl) truthEl.addEventListener('input', () => {
    if (lastExperiment) renderExperiment(lastExperiment);
  });

  /* 诊断面板现在在「分析」弹层里，打开时由 settings.js 的 openAnaModal() 调用刷新，
     所以这里不再监听设置按钮（那是它还嵌在设置抽屉里时的写法）。 */
}

let lastExperiment = null;

window.addEventListener('DOMContentLoaded', initDiagnosticsUI);
