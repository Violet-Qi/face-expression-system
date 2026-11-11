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

/* 防重入：initModels 可能被调用两次（DOMContentLoaded 已放过时 main.js 会补一次），
   重复加载会让两套 fetch 抢同一个模型缓存，出现过"卡住不返回"的怪象。 */
let modelsInitStarted = false;

/**
 * 重新加载模型。
 * 用途：加载卡住（网络抖动 / 缓存混版）时，用户可以在封面上点「重试」，
 * 不必手动刷新页面。会先解开防重入标记，再重跑一遍完整流程。
 */
async function retryInitModels() {
  modelsInitStarted = false;
  modelsReady = false;
  if (typeof setStatus === 'function') setStatus('正在重新加载模型…', 'loading');
  await initModels();
}

/* ---------------- 检测器档位（v1.8.1）---------------- */

/** 当前该用哪个检测器 */
function currentDetectNet() {
  const p = DETECT_PRESETS[activePreset] || DETECT_PRESETS.speed;
  return p.detectNet;
}

/** 当前档位是否用完整 68 点关键点模型（false = 用 tiny 版） */
function useTinyLandmarks() {
  const p = DETECT_PRESETS[activePreset] || DETECT_PRESETS.speed;
  return p.landmarkNet !== 'faceLandmark68Net';
}

/** 按档位生成检测选项。两种检测器的选项类不同，不能混用。 */
function buildDetectOptions(threshold) {
  const th = (typeof threshold === 'number') ? threshold : scoreThresholdNow();
  if (currentDetectNet() === 'ssdMobilenetv1') {
    // SSD 用 minConfidence，没有 inputSize（内部固定 512）
    return new faceapi.SsdMobilenetv1Options({ minConfidence: th });
  }
  return new faceapi.TinyFaceDetectorOptions({ inputSize: INPUT_SIZE, scoreThreshold: th });
}

/**
 * 切换到指定档位。
 * SSD 是懒加载的：第一次切到 balanced 才去下 5.5 MB，之后走缓存。
 * 返回 { ok, error? }
 */
/**
 * 切换到指定档位。
 * 加载哪些网络完全由注册表的 nets 字段决定 —— 加模型不用改这里。
 */
async function applyDetectPreset(key, opts) {
  const target = DETECT_PRESETS[key] ? key : DEFAULT_PRESET_KEY;
  const o = opts || {};
  const preset = DETECT_PRESETS[target];

  // 这一档还缺哪些网络？(已内置的不算)
  const need = (preset.nets || []).filter(n => !netLoaded(n));

  for (const netName of need) {
    const net = faceapi.nets[netName];
    if (!net) {
      const msg = '未知模型：' + netName + '（请检查 model-registry.js 的 nets 字段）';
      console.error('[档位切换]', msg);
      if (o.silent !== true) setStatus(msg, 'error');
      return { ok: false, error: msg };
    }
    if (o.silent !== true) {
      const mb = NET_SIZE_MB[netName] ? ('，约 ' + NET_SIZE_MB[netName] + ' MB') : '';
      setStatus('正在加载「' + preset.name + '」所需的模型' + mb + '…', 'loading');
    }
    try {
      await net.loadFromUri(MODEL_URL);
    } catch (err) {
      console.error('[模型加载失败] ' + netName, err);
      if (o.silent !== true) {
        setStatus('模型「' + netName + '」加载失败：' + err.message + '。已回退到速度优先。', 'error');
      }
      activePreset = DEFAULT_PRESET_KEY;
      return { ok: false, error: err.message };
    }
  }

  activePreset = target;
  if (o.silent !== true) {
    setStatus('检测精度已切换为「' + preset.name + '」。' + preset.desc, 'ok');
  }
  return { ok: true };
}

/** 某个 net 是否已加载 */
function netLoaded(name) {
  const net = faceapi.nets[name];
  return !!(net && net.isLoaded);
}

/** 各模型的体积（只为提示文案，不影响逻辑） */
const NET_SIZE_MB = {
  tinyFaceDetector: 0.2,
  ssdMobilenetv1: 5.5,
  faceLandmark68TinyNet: 0.1,
  faceLandmark68Net: 0.35,
  faceExpressionNet: 0.3,
  faceRecognitionNet: 6.1
};


/** 档位的中文名，给诊断面板用 */
function currentPresetName() {
  const p = DETECT_PRESETS[activePreset] || DETECT_PRESETS.speed;
  return p.name;
}

async function initModels() {
  if (modelsInitStarted) return;
  modelsInitStarted = true;

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
    /* 如果上次选的是"均衡"档，启动时就把 SSD 也加载上
       （不静默：让用户看到"正在加载高精度模型"） */
    try {
      const want = (typeof curSettings === 'function' && curSettings().detectPreset) || 'speed';
      if (want !== 'speed' && DETECT_PRESETS[want]) await applyDetectPreset(want, { silent: false });
      else activePreset = 'speed';
    } catch (e) { activePreset = 'speed'; }
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

