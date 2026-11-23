/* ============================================================
   cascade-engine.js —— 异构双引擎级联（v1.9.6 实验）
   ------------------------------------------------------------
   两个引擎各司其职：

     faceapi    face-api.js 的 faceExpressionNet —— 7 类表情**判定**
                （进桶/统计/熵/日记，单一票权，口径不变）

     mediapipe  MediaPipe FaceLandmarker —— 478 点 + 52 维 blendshape
                —— 只贡献"强度/细节"展示，**绝不参与判定与统计**

   为什么这样分工：
     · 连续 7 类概率（face-api）适合回答"是什么表情"
     · 52 维肌肉动作强度（MediaPipe）适合回答"有多强烈 / 是微笑还是大笑"
     · 判定权只给 face-api，保证统计与 CSV 口径和 1.9.5 完全一致；
       MediaPipe 只是"给展示层多一双眼睛"

   本文件只管数据层与文案映射，不碰界面。

   ⚠️ 实测记录（别踩第二次）：
     · `.task` / `.wasm` 必须在 server-app.js 里补 MIME（已补）
     · `import()` 的 specifier 必须是**绝对 URL**（bare 相对路径抛
       TypeError: Failed to resolve module specifier）
     · GPU delegate 可能失败，要两层 try 回落到 CPU（XNNPACK 日志是正常回落）
     · `runningMode:'IMAGE'` + `numFaces` + `outputFaceBlendshapes:true`
       才拿得到 52 维 blendshape
   ============================================================ */

/* ---------------- 引擎状态 ---------------- */
let _mpInitPromise = null;      // MediaPipe 初始化 Promise（防重入）
let _faceLandmarker = null;     // FaceLandmarker 实例
let _mpDelegate = '';           // 'gpu' | 'cpu'
let _cascadeReady = false;

/* blendshape 展示用分组：只做展示，不参与判定（同 zhaojian DETAIL_GROUPS 思路）
   名字里的"紧张/微笑"只是给人看的说法，值本身仍是肌肉动作强度。 */
const CASCADE_DETAIL_GROUPS = {
  browTension: ['browDownLeft', 'browDownRight', 'browInnerUp'],
  mouthSmile:  ['mouthSmileLeft', 'mouthSmileRight'],
  eyeTension:  ['eyeSquintLeft', 'eyeSquintRight', 'eyeBlinkLeft', 'eyeBlinkRight'],
  mouthOpen:   ['jawOpen']
};

function _clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
function _avgCat(bs, keys) {
  let sum = 0, n = 0;
  for (let i = 0; i < keys.length; i++) {
    if (typeof bs[keys[i]] === 'number') { sum += bs[keys[i]]; n++; }
  }
  return n ? sum / n : 0;
}

/** 把 MediaPipe 数组形式的 blendshape 转成 { 名字: 分数 } 对象 */
function _bsToObject(categories) {
  const out = {};
  if (!categories) return out;
  for (let i = 0; i < categories.length; i++) {
    out[categories[i].categoryName] = categories[i].score;
  }
  return out;
}

/** 四维展示指标：取相关 blendshape 平均，无阈值判断 */
function cascadeDetailFrom(bs) {
  if (!Object.keys(bs).length) return null;
  const d = {};
  for (const name in CASCADE_DETAIL_GROUPS) {
    d[name] = _avgCat(bs, CASCADE_DETAIL_GROUPS[name]);
  }
  return d;
}

/** 整体面部动作活跃度：52 维平均，规则无关，纯粹描述"动得多不多" */
function cascadeActivationFrom(bs) {
  const keys = Object.keys(bs);
  if (!keys.length) return null;
  let sum = 0;
  for (let i = 0; i < keys.length; i++) sum += bs[keys[i]];
  return _clamp01(sum / keys.length);
}

/**
 * 懒加载 MediaPipe（只有切到「异构双引擎级联」才触发，其它档不付这 ~18 MB）。
 * @returns {Promise<boolean>} 是否加载成功
 */
function ensureCascadeEngine() {
  if (_cascadeReady) return Promise.resolve(true);
  if (_mpInitPromise) return _mpInitPromise;

  _mpInitPromise = (async () => {
    try {
      const MP_BUNDLE = new URL('lib/mediapipe/vision_bundle.js', location.href).href;
      const MP_WASM    = new URL('lib/mediapipe/wasm', location.href).href;
      const MP_TASK    = new URL('models/face_landmarker.task', location.href).href;

      const mod = await import(MP_BUNDLE);
      if (!mod.FaceLandmarker) throw new Error('vision_bundle 里没有 FaceLandmarker');

      const fileset = await mod.FilesetResolver.forVisionTasks(MP_WASM);

      // GPU 优先，失败回落 CPU（两层 try，避免把回落当作错误报给用户）
      try {
        _faceLandmarker = await mod.FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MP_TASK, delegate: 'GPU' },
          runningMode: 'IMAGE', numFaces: 6, outputFaceBlendshapes: true
        });
        _mpDelegate = 'gpu';
      } catch (gpuErr) {
        console.warn('[级联] GPU 失败，回落 CPU：' + (gpuErr && gpuErr.message ? gpuErr.message : gpuErr));
        _faceLandmarker = await mod.FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MP_TASK, delegate: 'CPU' },
          runningMode: 'IMAGE', numFaces: 6, outputFaceBlendshapes: true
        });
        _mpDelegate = 'cpu';
      }
      _cascadeReady = true;
      return true;
    } catch (err) {
      console.error('[级联] MediaPipe 加载失败', err);
      _mpInitPromise = null;    // 允许下次重试
      return false;
    }
  })();
  return _mpInitPromise;
}

/** 当前级联引擎名（诊断面板用） */
function cascadeEngineName() {
  if (!_cascadeReady) return '未加载';
  return 'mediapipe-' + _mpDelegate;
}

/**
 * 对一张图跑 MediaPipe，返回每张脸的 { box, blendshapes, detail, activation }。
 * 只返回 MediaPipe 自己的结果，不碰 face-api（判定权在 face-api 那边）。
 * @param {HTMLImageElement|HTMLVideoElement|HTMLCanvasElement} source
 * @returns {Array<{box,blendshapes,detail,activation}>}
 */
function runCascadeMediaPipe(source) {
  if (!_faceLandmarker) return [];
  const res = _faceLandmarker.detect(source);
  if (!res || !res.faceLandmarks || !res.faceLandmarks.length) return [];

  // 取源元素的固有像素尺寸：MediaPipe 关键点是 0~1 归一化，乘以它才得到像素框。
  // face-api 的检测框本身就是像素坐标，两者必须统一到像素空间再配对（P0-2）。
  const sW = (source.naturalWidth || source.videoWidth || source.width) || 0;
  const sH = (source.naturalHeight || source.videoHeight || source.height) || 0;

  const out = [];
  for (let i = 0; i < res.faceLandmarks.length; i++) {
    const lms = res.faceLandmarks[i];
    if (!lms || !lms.length) continue;
    // faceBlendshapes[i] 是 Classification 对象 {categories,headIndex,headName}，
    // _bsToObject 要的是 categories 数组（[{categoryName,score}...]）。
    const bs = _bsToObject(res.faceBlendshapes && res.faceBlendshapes[i] && res.faceBlendshapes[i].categories);
    out.push({
      box: cascadeBoxFromLandmarks(lms, sW, sH),
      blendshapes: bs,
      detail: cascadeDetailFrom(bs),
      activation: cascadeActivationFrom(bs)
    });
  }
  return out;
}

/**
 * 从关键点求外接框。
 * @param {Array<{x,y}>} lms MediaPipe 归一化关键点（0~1）
 * @param {number} [srcW] 源元素固有像素宽。缺省时返回归一化框；传入则返回像素框。
 * @param {number} [srcH] 源元素固有像素高。
 * @returns {{x,y,width,height,normalized:boolean}}
 */
function cascadeBoxFromLandmarks(lms, srcW, srcH) {
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (let i = 0; i < lms.length; i++) {
    const p = lms[i];
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  // 关键点归一化（0~1）。给到源尺寸就换算成像素框，与 face-api 的像素框同一坐标系；
  // 没给尺寸则保持归一化（旧接口，未被 runCascadeMediaPipe 使用）。
  if (srcW && srcH) {
    return {
      x: minX * srcW,
      y: minY * srcH,
      width: (maxX - minX) * srcW,
      height: (maxY - minY) * srcH,
      normalized: false
    };
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY, normalized: true };
}

/* ============================================================
   ★ 设计核心：把 blendshape 翻译成中文强度文案 ★
   ------------------------------------------------------------
   规则原则：判定用 face-api 的 top 情绪；强度文案用 MediaPipe 的
   detail 四维 + 激活度，全部是"取相关肌肉强度"的展示层描述，
   只给用户看，不写进统计/CSV。
   ============================================================ */

/**
 * 从 blendshape 里取嘴角上扬（杜兴式微笑的"嘴"信号）。
 * @returns {number} 取左右嘴角较大者
 */
function _smileMouth(bs) {
  return Math.max(bs.mouthSmileLeft || 0, bs.mouthSmileRight || 0);
}

/** 从 blendshape 里取眼周/苹果肌挤压（杜兴式微笑的"眼/腮"信号）。
    cheekSquint 是脸颊上提（皱眼）的直接信号，比 eyeSquint 更贴杜兴判定。 */
function _smileCheek(bs) {
  return Math.max(bs.cheekSquintLeft || 0, bs.cheekSquintRight || 0);
}

/**
 * 生成某张脸的强度文案。
 * @param {string} topName   face-api 判定出的主导情绪键
 * @param {number} topValue  face-api 主导情绪概率（0~1）
 * @param {Object} bs        52 维 blendshape 对象
 * @param {Object|null} detail 四维 detail（可为 null）
 * @param {number|null} activation 活跃度（可为 null）
 * @returns {string} 例如「微微一笑（嘴角微扬，眼周平静）」
 */
function cascadeIntensityText(topName, topValue, bs, detail, activation) {
  if (!bs || !Object.keys(bs).length) {
    return (detail ? '（无 MediaPipe 数据）' : '');
  }

  const mouth = _smileMouth(bs);
  const cheek = _smileCheek(bs);
  const jaw   = bs.jawOpen || 0;
  const brow  = bs.browInnerUp || 0;
  const act   = (typeof activation === 'number') ? activation : 0;

  // —— 高兴：杜兴式真假笑分级 ——
  if (topName === 'happy') {
    if (mouth >= 0.35 && cheek >= 0.20) {
      return '开怀大笑（嘴角上扬 + 眉头舒展）';
    }
    if (mouth >= 0.20 && cheek >= 0.12) {
      return '眉开眼笑（真笑，眼角有笑意）';
    }
    if (mouth >= 0.15) {
      return cheek >= 0.08
        ? '微微一笑（带着眼角的笑意）'
        : '微微一笑（嘴角微扬，眼周平静）';
    }
    if (mouth >= 0.08) return '浅浅一笑（嘴角微微上扬）';
    return '抿嘴微笑（嘴角几乎未动，可能是礼貌性招呼）';
  }

  // —— 惊讶 ——
  if (topName === 'surprised') {
    if (jaw >= 0.30 && brow >= 0.20) return '目瞪口呆（嘴张大 + 眉头上扬）';
    if (jaw >= 0.15) return '微微惊讶（嘴微微张开）';
    return '略显惊讶（眉头微抬）';
  }

  // —— 愤怒 ——
  if (topName === 'angry') {
    if ((detail && detail.browTension >= 0.25)) return '眉头紧锁（眉毛下压明显）';
    if (act >= 0.15) return '面带愠色（肌肉紧绷）';
    return '略有不悦（表情波动不大）';
  }

  // —— 悲伤 ——
  if (topName === 'sad') {
    if ((detail && detail.browTension >= 0.20)) return '眉头微蹙（眉间收紧）';
    return '神情低落（情绪平静）';
  }

  // —— 恐惧 ——
  if (topName === 'fearful') {
    if (brow >= 0.25) return '眉眼惊恐（眉毛上扬明显）';
    return '略带紧张（眉梢微动）';
  }

  // —— 厌恶 ——
  if (topName === 'disgusted') {
    if ((detail && detail.mouthOpen >= 0.15)) return '眉头微皱（鼻翼嘴角收紧）';
    return '略显厌恶（表情紧绷）';
  }

  // —— 中性 ——
  if (topName === 'neutral') {
    if (act >= 0.12) return '表情平静（面部动作较少）';
    if (cheek >= 0.10) return '似有笑意（嘴角微动）';
    return '表情平和（面部基本放松）';
  }

  return '';
}

/** 整合：给 face-api 的 results 附加 MediaPipe 的强度描述（就地附加，不改判定）。
    @param {Array} faResults  face-api 的 express 结果数组
    @param {Array} mpResults  runCascadeMediaPipe 的返回
    @returns {Array} faResults（每项追加 _cascadeDetail / _cascadeText 字段） */
function attachCascadeDetail(faResults, mpResults) {
  if (!faResults || !faResults.length) return faResults;
  if (!mpResults || !mpResults.length) {
    faResults.forEach(r => { r._cascadeText = ''; });
    return faResults;
  }

  // 配对：按检测框中心距离最近配对（no pairFallback）
  faResults.forEach(r => {
    const rBox = r.detection && r.detection.box;
    if (!rBox) { r._cascadeText = ''; return; }
    const rc = centerOf(rBox);
    let best = null, bestD = Infinity;
    for (let i = 0; i < mpResults.length; i++) {
      const mBox = mpResults[i].box || rBox;
      const mc = centerOf(mBox);
      const d = Math.hypot(rc.x - mc.x, rc.y - mc.y);
      if (d < bestD) { bestD = d; best = mpResults[i]; }
    }
    if (best) {
      r._cascadeDetail = best.detail;
      r._cascadeBs = best.blendshapes;
      r._cascadeActivation = best.activation;
      const top = topExpression(r.expressions);
      r._cascadeText = cascadeIntensityText(
        top.name, top.value, best.blendshapes, best.detail, best.activation);
    } else {
      r._cascadeText = '';
    }
  });
  return faResults;
}

function centerOf(box) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
