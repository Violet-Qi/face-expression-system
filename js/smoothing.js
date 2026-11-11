/* ============================================================
   多帧平滑：抑制表情标签来回跳（v1.9.0）
   ------------------------------------------------------------
   为什么需要：
     摄像头模式下每次检测是**独立**的。同一个人的表情概率每帧都会小幅波动，
     argmax 在"中性 51% / 高兴 49%"这种临界情况下来回翻转 →
     屏幕上的标签一秒变三次，看起来就是"识别不准"。

     实测经验：单帧偶尔判错很难避免，但**连续多帧的多数结果通常是稳定的**。
     所以与其换更大的模型，不如把时间维度上的信息用起来。

   两种做法，这里都用：
     ① EMA（指数移动平均）：把每帧的 7 类概率加权平均，
        新帧权重 alpha，历史权重 (1-alpha)。抑制抖动最直接。
     ② 迟滞（hysteresis）：新标签要**连续赢几张**才真的切换，
        避免"51% vs 49%"这种临界值反复横跳。

   为什么按"人脸序号"分别记录：
     同一帧里第 0 张脸和第 1 张脸是不同的人，不能混。检测结果的顺序通常稳定
     （同一位置的人会一直排在同一序号），所以用序号当 key 够用。
     人手移动导致顺序互换时会短暂错乱，几百毫秒内会重新稳定。

   边界：
     · 只在**摄像头**和**视频**这种多帧场景启用；单张图片不经过这里（本来就是一次判定）
     · 关掉开关时完全走原路径，行为与旧版一致
     · 每帧第一次出现的人脸不参与平滑（直接用原始概率），避免"冷启动延迟"
   ============================================================ */

/** 每个 key 的历史概率：{ key: { expr: {...}, streak: {label: n}, last: 'happy' } } */
const _smoothState = new Map();

/** 当前设置的平滑强度（0 = 关闭） */
function smoothAlpha() {
  const s = (typeof curSettings === 'function') ? curSettings() : null;
  const v = s && typeof s.smoothAlpha === 'number' ? s.smoothAlpha : 0.4;
  return v;
}

/** 要多连续赢几次才切换标签 */
function smoothHysteresis() {
  const s = (typeof curSettings === 'function') ? curSettings() : null;
  const v = s && typeof s.smoothHysteresis === 'number' ? s.smoothHysteresis : 2;
  return v;
}

/** 清空平滑状态（开关摄像头、换视频、切换模式时调用） */
function resetSmoothing(prefix) {
  if (!prefix) { _smoothState.clear(); return; }
  for (const k of Array.from(_smoothState.keys())) {
    if (k.indexOf(prefix) === 0) _smoothState.delete(k);
  }
}

/**
 * 对一次检测结果做时序平滑。
 * @param {string} key      区分是哪一路的第几张脸，如 'cam:0'
 * @param {object} raw      本帧的原始概率对象 { happy: 0.9, ... }
 * @returns {object}        平滑后的概率对象（结构与 raw 相同，可以直接喂给 topExpression）
 */
function smoothExpressions(key, raw) {
  if (!raw) return raw;

  const alpha = smoothAlpha();
  if (!(alpha > 0)) {
    // 关闭状态：不记录，原样返回
    _smoothState.delete(key);
    return raw;
  }

  const prev = _smoothState.get(key);
  if (!prev) {
    // 第一次见到这张脸：直接用原始值，同时建立历史
    _smoothState.set(key, {
      expr: Object.assign({}, raw),
      last: null,
      streak: 0
    });
    return raw;
  }

  // ① EMA：新 = alpha*新帧 + (1-alpha)*历史
  const out = {};
  for (const k in raw) {
    const oldVal = (typeof prev.expr[k] === 'number') ? prev.expr[k] : raw[k];
    out[k] = alpha * raw[k] + (1 - alpha) * oldVal;
  }
  prev.expr = out;

  // ② 迟滞：新赢家要连续赢够次数才认
  let winner = null, best = -1;
  for (const k in out) { if (out[k] > best) { best = out[k]; winner = k; } }

  const need = smoothHysteresis();
  if (prev.last && winner === prev.last) {
    prev.streak = 0;
    return out;
  }
  if (winner && winner !== prev.last) {
    prev.streak = (prev.streak || 0) + 1;
    if (prev.streak >= need || !prev.last) {
      prev.last = winner;
      prev.streak = 0;
    } else {
      /* 还没赢够次数 —— 故意把历史赢家的概率抬高一点点，
         让 topExpression() 暂时仍返回旧标签，观感上不闪烁。
         这不是改数据，只是这几帧的显示选择；概率对象本身保留了真实值。 */
      if (prev.last && typeof out[prev.last] === 'number') {
        out[prev.last] = Math.max(out[prev.last], best + 0.001);
      }
    }
  }
  return out;
}

/** 诊断用：当前记录了多少张脸的历史 */
function smoothingStateSize() {
  return _smoothState.size;
}
