/* ============================================================
   水滴涟漪点击反馈（v1.9.2）
   ------------------------------------------------------------
   目标：点击任何可点元素时，从**手指/鼠标按下的那个点**扩散一圈水波，
        像水滴落进水面。

   为什么必须用 JS：
     CSS 的 :active 只能整体缩放/变色，无法知道"点的位置"，
     也做不出"从一点向外扩散"的形状。涟漪的中心必须由点击坐标决定。

   实现要点：
     ① 事件委托绑在 document 上，而不是逐个元素绑。
        原因：页面里有大量动态生成的元素（档位卡片、下拉条目、会话行、
        管理台表格里的按钮），逐个绑定必然漏。
     ② 用 pointerdown 而不是 click —— 按下即出水波，不用等手指抬起。
     ③ 涟漪颜色用 currentColor：
        深色按钮文字是白的 → 白色水波；
        浅色按钮文字是深的 → 深色水波。自动适配，不用为每个按钮配色。
     ④ 元素如果是 static 定位或没裁切，临时补上 position:relative /
        overflow:hidden，否则水波会溢出到元素外面。
     ⑤ 动画结束就移除节点，不在 DOM 里堆积。
     ⑥ 尊重 prefers-reduced-motion：系统开了"减少动态效果"就不生成水波。
   ============================================================ */

/** 会出水波的元素（尽量覆盖全站可点元素） */
const RIPPLE_SELECTOR = [
  '.btn',
  '.btn-primary',
  '.btn-ghost',
  '.btn-mini',
  '.mode-btn',
  '.settings-btn',
  '.preset-picker-btn',
  '.preset-chip',
  '.preset-menu-item',
  '.preset-menu-more',
  '.theme-chip',
  '.auth-submit',
  '.auth-tab',
  '.drawer-close',
  '.set-btn',
  '.set-row-btn',
  '.info-exp-link',
  '.cover-start',
  '.face-card',
  '.tab-btn',
  '.link-btn'
].join(',');

/** 让容器能容纳水波（不裁切就会溢出到外面） */
function _ripplePrepare(el) {
  const cs = getComputedStyle(el);
  if (cs.position === 'static') {
    el.style.position = 'relative';
    el.dataset.fxRipplePos = '1';
  }
  // 已经有 auto/scroll 的元素不动（比如可滚动列表），其余补 hidden
  if (cs.overflow !== 'hidden' && cs.overflow !== 'clip' && cs.overflow !== 'auto' && cs.overflow !== 'scroll') {
    el.style.overflow = 'hidden';
    el.dataset.fxRippleOverflow = '1';
  }
}

/**
 * 在元素内的 (clientX, clientY) 处生成一圈水波。
 * @param {HTMLElement} el
 * @param {number} clientX
 * @param {number} clientY
 */
function createRipple(el, clientX, clientY) {
  if (!el || el.disabled) return;
  // 系统开启"减少动态效果"时不出水波
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  _ripplePrepare(el);

  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const x = (typeof clientX === 'number' ? clientX : rect.left + rect.width / 2) - rect.left;
  const y = (typeof clientY === 'number' ? clientY : rect.top + rect.height / 2) - rect.top;

  /* 半径要足够盖住整个元素：取"圆心到最远角"的距离。
     加 8px 余量，避免圆角处露出边缘。 */
  const dx = Math.max(x, rect.width - x);
  const dy = Math.max(y, rect.height - y);
  const radius = Math.sqrt(dx * dx + dy * dy) + 8;
  const size = radius * 2;

  const wave = document.createElement('span');
  wave.className = 'fx-ripple';
  wave.style.width = size + 'px';
  wave.style.height = size + 'px';
  wave.style.left = (x - radius) + 'px';
  wave.style.top = (y - radius) + 'px';

  el.appendChild(wave);

  /* 动画结束移除。用 animationend 而不是固定 setTimeout：
     标签页切到后台时动画会暂停，setTimeout 会提前删掉，
     表现就是"切回来水波没了"。 */
  const cleanup = () => { if (wave.parentNode) wave.parentNode.removeChild(wave); };
  wave.addEventListener('animationend', cleanup, { once: true });
  // 兜底：万一 animationend 没触发（元素被移除等），1.2 秒后强制清理
  setTimeout(cleanup, 1200);
}

/** 初始化（只需调用一次） */
function initRipple() {
  if (initRipple._done) return;
  initRipple._done = true;

  document.addEventListener('pointerdown', (e) => {
    // 只响应主键（鼠标左键 / 单指）
    if (e.button !== undefined && e.button !== 0) return;

    const el = e.target && e.target.closest ? e.target.closest(RIPPLE_SELECTOR) : null;
    if (!el) return;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return;
    // 被 is-busy 标记（请求中）的元素不响应
    if (el.classList.contains('is-busy')) return;

    createRipple(el, e.clientX, e.clientY);
  }, { passive: true });
}
