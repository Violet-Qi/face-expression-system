/* ============================================================
   表情引擎适配器（v1.9.0）
   ------------------------------------------------------------
   系统里有两个「表情分类」实现：

     faceapi    face-api.js 的 faceExpressionNet，322 KB，随页面一起加载
                —— 默认档，所有设备可用

     ferplus    FERPlus 训练的 CNN（ONNX），18.4 MB 模型 + 10 MB 运行时
                —— 增强档，只在电脑上开放

   为什么需要这一层：
     两个引擎的**输入输出格式完全不同**，不能直接互换调用：

     face-api   输入：它自己内部裁剪对齐好的脸
                输出：{ neutral, happy, sad, angry, fearful, disgusted, surprised }
                      已经是 0~1 的概率

     FERPlus    输入：1×1×64×64 灰度浮点，**0~255** 不归一化
                输出：1×8 的 **logits**（未 softmax），且多一个 contempt 类
                      标签顺序 = { neutral, happiness, surprise, sadness, anger, disgust, fear, contempt }

   这一层的职责就是把 FERPlus 的输出**伪装成 face-api 的形状**，
   让上层（render / stats / 平滑 / 诊断）完全不用改。

   ⚠️ 实测记录（别踩第二次）：
     · 输入用 0~255 → 35 张评测图对 20 张（57.1%）
     · 输入用 0~1   → 只对 5 张（14.3%）  ← 归一化反而全错，因为模型是按 0~255 训练的
     · 输入尺寸必须是 64×64，不是 48×48
     · 会话输入名是 'Input3'，输出名是 'Plus692_Output_0'（编译产物里的层名，不是语义名）
   ============================================================ */

/** FERPlus 的 8 类标签顺序（**不能改**，必须与训练时一致） */
const FERPLUS_LABELS = ['neutral', 'happy', 'surprise', 'sad', 'angry', 'disgust', 'fear', 'contempt'];

/** FERPlus 类名 → face-api 键名 */
const FERPLUS_TO_FACEAPI = {
  neutral: 'neutral',
  happy: 'happy',
  surprise: 'surprised',   // face-api 用 surprised
  sad: 'sad',
  angry: 'angry',
  disgust: 'disgusted',    // face-api 用 disgusted
  fear: 'fearful',         // face-api 用 fearful
  contempt: null           // face-api 没有这一类，丢弃后重新归一化
};

/* 运行时状态 */
let _ortReady = false;      // onnxruntime 脚本是否已注入
let _ortSession = null;     // InferenceSession
let _ferLoading = null;     // 加载中的 Promise（防重入）
let _ferReady = false;

/**
 * 懒加载 onnxruntime 与 FERPlus 模型。
 * 只有用户真的切到「增强」档才会触发，默认档不付这 28 MB。
 */
function ensureEnhanceEngine() {
  if (_ferReady) return Promise.resolve(true);
  if (_ferLoading) return _ferLoading;

  _ferLoading = (async () => {
    try {
      // ① 注入 onnxruntime 的脚本（只注一次）
      if (!_ortReady) {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'lib/onnxruntime/ort.min.js';
          s.onload = resolve;
          s.onerror = () => reject(new Error('onnxruntime 脚本加载失败'));
          document.head.appendChild(s);
        });
        _ortReady = true;
      }
      if (typeof ort === 'undefined') throw new Error('onnxruntime 未就绪');

      // ② 告诉 ORT 去哪里找 wasm（必须指向本地目录，不能用 CDN）
      ort.env.wasm.wasmPaths = 'lib/onnxruntime/';
      ort.env.wasm.numThreads = 1;      // 多线程需要 COOP/COEP 响应头，我们没有，所以单线程

      // ③ 加载模型
      const session = await ort.InferenceSession.create(
        'models/emotion-ferplus-12-int8.onnx',
        { executionProviders: ['wasm'] }
      );
      _ortSession = session;
      _ferReady = true;
      return true;
    } catch (err) {
      console.error('[增强表情模型加载失败]', err);
      _ferLoading = null;
      return false;
    }
  })();

  return _ferLoading;
}

/** 增强引擎是否已就绪 */
function enhanceEngineReady() {
  return _ferReady;
}

/**
 * 用 FERPlus 对一张「已经裁好的人脸 canvas」做表情分类。
 * @param {HTMLCanvasElement} faceCanvas  只含一张脸的画布
 * @returns {Promise<object|null>} 与 face-api 一致的 7 类概率；失败返回 null
 */
async function classifyWithEnhanceEngine(faceCanvas) {
  if (!_ferReady || !_ortSession) return null;

  try {
    // ① 缩到 64×64 并转灰度。注意：**不归一化**，保持 0~255
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.imageSmoothingEnabled = true;
    cx.drawImage(faceCanvas, 0, 0, 64, 64);
    const px = cx.getImageData(0, 0, 64, 64).data;

    const data = new Float32Array(64 * 64);
    for (let i = 0; i < 64 * 64; i++) {
      // 标准灰度权重
      data[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    }

    // ② 推理
    const tensor = new ort.Tensor('float32', data, [1, 1, 64, 64]);
    const out = await _ortSession.run({ Input3: tensor });
    const logits = Array.from(out['Plus692_Output_0'].data);

    // ③ softmax（模型输出是 logits，不是概率）
    const mx = Math.max.apply(null, logits);
    const exps = logits.map(v => Math.exp(v - mx));
    const sum = exps.reduce((a, b) => a + b, 0);
    const probs = exps.map(v => v / sum);

    // ④ 映射成 face-api 的 7 类，丢掉 contempt 后重新归一化
    const result = { neutral: 0, happy: 0, sad: 0, angry: 0, fearful: 0, disgusted: 0, surprised: 0 };
    let kept = 0;
    for (let i = 0; i < FERPLUS_LABELS.length; i++) {
      const key = FERPLUS_TO_FACEAPI[FERPLUS_LABELS[i]];
      if (!key) continue;                 // contempt：丢弃
      result[key] = probs[i];
      kept += probs[i];
    }
    if (kept > 0) {
      for (const k in result) result[k] = result[k] / kept;
    }
    return result;
  } catch (err) {
    console.warn('[增强表情推理失败]', err);
    return null;
  }
}

/**
 * 把 FERPlus 的结果写回到识别结果数组上。
 * 上层代码（渲染、统计、平滑）读的都是 res.expressions，所以改这里就够了。
 * @param {Array} results  face-api 的识别结果数组
 * @param {HTMLCanvasElement|HTMLVideoElement|HTMLImageElement} source 这些脸来自哪张图
 * @returns {Promise<number>} 成功覆盖的数量
 */
async function applyEnhanceExpressions(results, source) {
  if (!results || !results.length) return 0;
  if (!_ferReady) return 0;

  let done = 0;
  for (const res of results) {
    const box = res.detection && res.detection.box;
    if (!box) continue;

    // 从原图裁出这张脸（稍微外扩一点，包含下巴与发际线，经验上更准）
    const pad = 0.12;
    const w = box.width * (1 + pad * 2);
    const h = box.height * (1 + pad * 2);
    const x = box.x - box.width * pad;
    const y = box.y - box.height * pad;

    const c = document.createElement('canvas');
    c.width = Math.max(8, Math.round(w));
    c.height = Math.max(8, Math.round(h));
    const cx = c.getContext('2d');
    try {
      cx.drawImage(source, x, y, w, h, 0, 0, c.width, c.height);
    } catch (e) {
      continue;   // 视频未就绪 / 跨域等异常，跳过
    }

    const probs = await classifyWithEnhanceEngine(c);
    if (probs) {
      res.expressions = probs;
      res.expressionsSource = 'ferplus';
      done++;
    }
  }
  return done;
}

/** 当前生效的表情引擎（给诊断面板用） */
function currentExpressionEngineName() {
  const s = (typeof curSettings === 'function') ? curSettings() : null;
  const e = s && s.expressionEngine ? s.expressionEngine : 'faceapi';
  return e === 'ferplus' ? '增强表情模型（FERPlus）' : '快速表情模型（face-api）';
}

/**
 * 摄像头模式是否允许用增强模型。
 * 增强模型单次推理约 52 ms（桌面 wasm），加上检测合计约 100~150 ms/帧，
 * 摄像头连续跑会明显掉帧，所以默认**只允许电脑**，且用户能在设置里彻底关掉。
 * 手机上任何模式都回落快速模型。
 */
function cameraEnhanceAllowed() {
  const s = (typeof curSettings === 'function') ? curSettings() : null;
  if (!s) return false;
  // 用户显式关掉「摄像头用增强模型」时，一律不启用
  if (s.cameraUseEnhance === false) return false;
  const narrow = window.matchMedia && window.matchMedia('(max-width: 760px)').matches;
  return !narrow;
}