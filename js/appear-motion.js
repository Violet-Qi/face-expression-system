/* ============================================================
   V1.9.EXP · 通用"从按钮展开"弹窗动效（WAAPI 版）
   ------------------------------------------------------------
   MIUI 12.5 的核心是「可中断 / 可接续」：动画播到一半被打断，
   会从【当前位置】平滑接着走，而不是跳回起点。

   之前用 CSS animation（fill-mode）无法做到这一点 —— 播完就完，
   不能读取"当前在哪个位置"。改用 Web Animations API (WAAPI)：

     · modal.animate() 返回一个 Animation 对象
     · 关闭时读取 getComputedStyle(modal) 的当前 transform/opacity，
       cancel 掉开启动画，再从当前位置反向动画 —— 完全连续

   用法：
     openFromButton(modal, mask)          // 自动用最近点击的元素
     openFromButton(modal, mask, trigger) // 显式指定起点
     closeFromButton(modal)               // 反向收回（可中断）
     没有可用起点（开机自动弹/游客门禁）→ 用 spring 落位（同样可中断）
   ============================================================ */

/** 用户最近点击的元素 + 那一刻的矩形 */
let _lastClick = null;   // { rect, at }
const CLICK_MEMO_MS = 1500;

/** 开/关弹窗的时长（与 anim.css 的 --dur-motion 同步） */
const DUR_OPEN  = 620;
const DUR_CLOSE = 360;

/** 是否开启"减弱动效"（无障碍） */
function _prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 返回动画时长：开启减弱动效时几乎无动画（尊重无障碍） */
function _dur(base) {
  return _prefersReducedMotion() ? 1 : base;
}

/** 读取 anim.css 里那条物理弹簧曲线给 WAAPI 用 */
function _getSpringEasing() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--ease-spring');
  return (v || 'linear(0, 1)').trim();
}

/** 判断元素是否适合当"展开起点" */
function _isTriggerCandidate(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.tagName === 'BUTTON' || el.tagName === 'A') return true;
  if (el.getAttribute && el.getAttribute('role') === 'button') return true;
  const cls = (el.className && typeof el.className === 'string') ? el.className : '';
  return /(^|\s)(btn|button)(\s|$)|-btn(\s|$)|\bbtn-/.test(cls);
}

/** 向上找最近的交互祖先 */
function _closestTrigger(el) {
  let cur = el, depth = 0;
  while (cur && depth < 5) {
    if (_isTriggerCandidate(cur)) return cur;
    cur = cur.parentElement; depth++;
  }
  return null;
}

/** 全局记录最近一次点击（捕获阶段，拿到"还在原位"的矩形） */
function initAppearTracking() {
  if (initAppearTracking._done) return;
  initAppearTracking._done = true;
  document.addEventListener('click', (e) => {
    const t = _closestTrigger(e.target);
    if (!t) return;
    const r = t.getBoundingClientRect();
    if (!r.width || !r.height) return;
    _lastClick = { rect: { left: r.left, top: r.top, width: r.width, height: r.height }, at: Date.now() };
  }, true);
}

/** 取"最近点击"的矩形（过期不用） */
function _getRecentRect() {
  if (!_lastClick) return null;
  if (Date.now() - _lastClick.at > CLICK_MEMO_MS) return null;
  return _lastClick.rect;
}

/** 取消弹窗上残留的 WAAPI（防止多个动画打架） */
function _cancelModalAnim(modal) {
  if (modal._anim) { 
    try { modal._anim.cancel(); } catch(e){}
    modal._anim = null;
  }
}

/* ---------------- 打开 ---------------- */

/**
 * 让弹窗从触发按钮的位置展开（或 spring 落位），WAAPI 可中断。
 */
function openFromButton(modal, mask, trigger) {
  if (!modal) return;

  // 统一签名：openFromButton(modal, mask, trigger?)
  //   - modal   弹窗元素
  //   - mask    遮罩元素（始终是第 2 参）
  //   - trigger 可选，显式起点；省略则用"最近点击的元素"
  // 注意：历史上曾有 openFromButton(modal, trigger, mask) 旧签名，现已废弃并删除。
  //   旧签名 shim 会把 mask 误判为 trigger，导致遮罩被置 null（遮罩不显示/点击关闭失效）。
  //   所有调用点已统一为 (modal, mask) 新签名，故不再需要兼容。

  // 取消任何在跑的关闭/打开动画
  _cancelModalAnim(modal);

  // 起点：显式传入 > 最近点击
  let rect = null;
  if (trigger && trigger.nodeType === 1) {
    const r = trigger.getBoundingClientRect();
    if (r.width || r.height) rect = { left: r.left, top: r.top, width: r.width, height: r.height };
  }
  if (!rect) rect = _getRecentRect();

  if (mask) {
    mask.hidden = false;
    // V1.9.EXP：打开瞬间就显示 + 景深模糊，和弹窗展开同步。
    // P1-1 修复：先移除 is-closing，避免"关→开"快速切换时残留 is-closing is-open 双类冲突
    // （之前只 add is-open 没 remove is-closing，导致遮罩残留黑幕）。
    mask.classList.remove('is-closing');
    mask.classList.add('is-open');
    // 记录遮罩，供 closeFromButton 定位
    modal._maskObj = mask;
  }
  modal.hidden = false;
  modal.classList.remove('is-closing', 'fx-appear');
  if (typeof lockPageScroll === 'function') lockPageScroll(true);

  // P1-3 修复：弹窗终点按视口切换。
  // 桌面（>=760px）：translate(-50%,-50%) 居中；移动端（<760px）CSS 是底部抽屉（bottom:0），
  // 终点应用 translate(-50%, 0) 贴屏底。否则移动端弹窗"居中弹出"而非"底部弹出"。
  const isMobile = window.matchMedia && window.matchMedia('(max-width: 760px)').matches;
  const CENTER = isMobile ? 'translate(-50%, 0)' : 'translate(-50%, -50%)';
  let startTransform, startOpacity = 0;
  if (rect) {
    const mr = modal.getBoundingClientRect();
    const dx = (rect.left + rect.width / 2) - (mr.left + mr.width / 2);
    const dy = (rect.top + rect.height / 2) - (mr.top + mr.height / 2);
    // 起点：居中基础上偏移到按钮 + 缩小（MIUI 从按钮展开）
    startTransform = `translate(calc(-50% + ${dx.toFixed(1)}px), calc(-50% + ${dy.toFixed(1)}px)) scale(.55)`;
  } else {
    // 无按钮：桌面从上方 spring 落位居中；移动端从底部 spring 落位（底部抽屉）
    startTransform = isMobile
      ? 'translate(-50%, calc(100% + 14vh)) scale(.92)'
      : 'translate(-50%, calc(-50% + 14vh)) scale(.92)';
  }

  const anim = modal.animate(
    [ { transform: startTransform, opacity: startOpacity }, { transform: CENTER, opacity: 1 } ],
    { duration: _dur(DUR_OPEN), easing: _getSpringEasing(), fill: 'forwards' }
  );
  modal._anim = anim;
  modal._openStart = { transform: startTransform, opacity: startOpacity };

  anim.onfinish = () => {
    modal.classList.add('is-open');
    // WAAPI 已完成入场动画，加 waapi-done 让 .is-open 的 CSS fxSpring 不再重播
    // （避免"落位后又抖回"的二次运动；内部级联入场不受影响）
    modal.classList.add('waapi-done');
    try { anim.cancel(); } catch(e){}   // 释放 fill，元素回到 .is-open 的自然态
    modal._anim = null;
  };
}

/* ---------------- 关闭（可中断） ---------------- */

/**
 * 让弹窗反向收回到起点。
 * 如果开启动画还在跑/刚结束，会读取【当前】位置，从当前位置平滑逆收，
 * 而不是跳回 —— 这就是 MIUI 的"可接续"。
 */
function closeFromButton(modal) {
  if (!modal) return;
  const mask = modal._maskObj || null;

  // 读取当前状态（开启动画可能仍在跑）
  const cur = getComputedStyle(modal);
  const current = {
    transform: cur.transform || 'none',
    opacity: String(+cur.opacity),
  };

  // 关闭目标：统一的"退场态"（缩小 + 下沉 + 淡出），带居中 translate 保持居中。
  // 不强行回按钮坐标 —— 弹窗已展开到居中了，"收回"是退场，
  // 从当前位置平滑缩向退场态即可（MIUI 的收回语义）。
  // P1-3：退场态也按视口切换（移动端从底部退场）
  const isMobile = window.matchMedia && window.matchMedia('(max-width: 760px)').matches;
  const end = isMobile
    ? { transform: 'translate(-50%, calc(100% - 6vh)) scale(.9)', opacity: '0' }
    : { transform: 'translate(-50%, calc(-50% + 6vh)) scale(.9)', opacity: '0' };

  // 取消残留的打开动画
  _cancelModalAnim(modal);

  // V1.9.EXP：弹窗关闭动画开始时，就让遮罩同步渐出（模糊随 opacity 渐弱）。
  // 之前是等弹窗 onfinish 才 mask.hidden=true，遮罩瞬间消失 → 高斯模糊僵硬。
  if (mask) {
    mask.classList.remove('is-open');
    mask.classList.add('is-closing');
  }

  const anim = modal.animate(
    [ current, end ],
    { duration: _dur(DUR_CLOSE), easing: _getSpringEasing(), fill: 'forwards' }
  );
  modal._anim = anim;

  anim.onfinish = () => {
    modal.classList.remove('is-open');
    modal.classList.add('is-closing');
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    if (mask) { mask.classList.remove('is-closing'); mask.hidden = true; }
    // 弹窗关闭完成，解锁背景滚动（打开时 lockPageScroll(true) 锁了，这里必须解锁）
    if (typeof lockPageScroll === 'function') lockPageScroll(false);
    try { anim.cancel(); } catch(e){}
    modal._anim = null;
    modal._openStart = null;
  };
}

/* ---------------- 自启动 ---------------- */

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAppearTracking, { once: true });
} else {
  initAppearTracking();
}
