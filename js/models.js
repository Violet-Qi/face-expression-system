/* ============================================================
   models.js —— 模型加载
   ------------------------------------------------------------
   负责 4 个模型的加载：
     · 3 个基础模型（人脸检测 / 关键点 / 表情）在页面打开时一起加载
     · 人脸特征模型（6.15 MB）按需加载 —— 只有勾选"人物分组"时才去下
   初始化计算后端（优先 webgl，失败回退 cpu）也在这里。
   ============================================================ */

/* ============================================================
   模型加载
   ============================================================ */

/**
 * 初始化 TensorFlow.js 的计算后端。
 * face-api 默认会优先选 wasm 后端，但该后端需要额外的 .wasm 文件，
 * 我们这里没带，所以必须显式指定后端，否则会报
 * "The highest priority backend 'wasm' has not yet been initialized"。
 * 优先用 webgl（有显卡加速，快），失败则退回 cpu（慢但一定能跑）。
 */
async function initBackend() {
  const tf = faceapi.tf;
  if (!tf) return;                       // 个别构建未暴露 tf，跳过

  // 支持用 ?backend=webgl / ?backend=cpu 强制指定后端（排查问题时很有用）
  const forced = new URLSearchParams(location.search).get('backend');
  const list = forced ? [forced] : ['webgl', 'cpu'];

  for (const name of list) {
    try {
      const ok = await tf.setBackend(name);
      if (ok) {
        await tf.ready();
        console.log('[TF后端]', tf.getBackend());
        return;
      }
    } catch (err) {
      console.warn('[TF后端] ' + name + ' 不可用：' + err.message);
    }
  }
}

async function initModels() {
  setStatus('正在加载模型，请稍候…', 'loading');
  const t0 = performance.now();
  try {
    await initBackend();   // 先定好后端，再加载模型

    // 三个模型并行加载，比逐个加载快
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),      // 人脸检测
      faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL), // 人脸关键点
      faceapi.nets.faceExpressionNet.loadFromUri(MODEL_URL)      // 表情分类
    ]);
    modelsReady = true;
    const sec = ((performance.now() - t0) / 1000).toFixed(1);
    setStatus(`模型加载完成（耗时 ${sec} 秒），请选择图片或开启摄像头。`, 'ok');
    // 通知封面解封「开始体验」按钮（函数在 main.js 里，保持分层）
    if (typeof onModelsReady === 'function') onModelsReady();
    updateButtonState();
    runAutoMode();      // 支持 ?auto=1 直接跑一遍（演示/测试用）
  } catch (err) {
    console.error('[模型加载失败]', err);
    setStatus('模型加载失败：' + err.message +
      '。请确认是通过本地服务器（不是双击打开 HTML）访问，且 models 目录文件完整。', 'error');
  }
}

/** 确保识别模型已加载（点了开关才加载，避免每次打开页面都多下 6 MB） */
async function ensureDescriptorNet() {
  if (descriptorNetReady) return true;
  setStatus('正在加载人物分组模型（首次约 6 MB，请稍候）…', 'loading');
  try {
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
    descriptorNetReady = true;
    setStatus('人物分组模型加载完成。', 'ok');
    return true;
  } catch (err) {
    console.error('[人物分组模型加载失败]', err);
    setStatus('人物分组模型加载失败：' + err.message, 'error');
    return false;
  }
}

