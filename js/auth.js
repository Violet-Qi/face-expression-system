/* ============================================================
   用户层：登录 / 注册 / 游客体验 1 次
   ------------------------------------------------------------
   产品规则（用户 2026-11-10 定）：
   · 必须注册才能长期使用
   · 但允许「游客体验 1 次」，用本地随机 UUID 计数
   · 体验过 1 次后，再点识别就弹登录框

   为什么用 UUID 而不是 IP 计数：
     ① IP 不可靠（校园网共用出口、4G 换基站就变）
     ② IP 属个人信息，存了就与"不采集设备信息"的承诺冲突
   代价：换浏览器 / 清缓存可以再体验一次。**这可以接受** ——
   这是个登录门槛，不是安全防线，没必要为此收集指纹。

   隐私边界（与《用户协议》第五章一致）：
     只上报"这个 UUID 已体验过"，不含 IP、不含 UA、不含任何识别内容。
   ============================================================ */

const GUEST_KEY      = 'fes.guestId.v1';
const GUEST_USED_KEY = 'fes.guestUsed.v1';

/** 当前登录用户（null = 游客或未登录） */
let currentUser = null;
/** 静态部署没有后端时为 false，此时不拦人（否则纯静态页就废了） */
let authAvailable = false;
/** 本次游客是否已经用掉体验机会 */
let guestUsed = false;
/** 关闭收尾防抖 token：重开时自增，让旧 settle 定时器作废 */
let _authSettleToken = 0;

function curUser() { return currentUser; }
function isLoggedIn() { return !!currentUser; }

/* ---------------- 游客身份 ---------------- */

function guestId() {
  try {
    let id = localStorage.getItem(GUEST_KEY);
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      id = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
          });
      localStorage.setItem(GUEST_KEY, id);
    }
    return id;
  } catch (e) { return null; }
}

function guestUsedLocal() {
  try { return localStorage.getItem(GUEST_USED_KEY) === '1'; } catch (e) { return false; }
}

function markGuestUsed() {
  try { localStorage.setItem(GUEST_USED_KEY, '1'); } catch (e) { /* 隐私模式忽略 */ }
  guestUsed = true;
  // 同步到服务器（仅记"这个 UUID 用过了"，不含任何其他信息）
  const id = guestId();
  if (id && authAvailable) {
    fetch('/api/guest-used', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    }).catch(() => { /* 失败就算了，本地已经拦住 */ });
  }
}

/**
 * 能不能开始一次识别？
 * 已登录 → 直接放行；游客未用过 → 放行并标记；游客已用过 → 拦下并弹登录。
 * 返回 true 表示可以继续。
 */
function canRunDetection() {
  if (currentUser) return true;
  /* 测试/调试模式不设门槛。
     自动化测试全部用 ?debug=1 打开页面，如果这里也拦，
     第二轮识别就会被弹窗挡住（实测基础套件 6 项全挂就是这个原因）。 */
  const q = new URLSearchParams(location.search);
  if (q.has('debug') || q.get('cover') === '0') return true;
  if (!authAvailable) return true;          // 纯静态：不设门槛
  if (!guestUsed && !guestUsedLocal()) return true;
  openAuthPanel('guest-used');
  return false;
}

/** 识别成功后调用：把本次游客体验标记为已用 */
function consumeGuestChance() {
  if (currentUser) return;
  if (!authAvailable) return;
  if (guestUsedLocal()) return;
  markGuestUsed();
  syncAuthUI();          // 立刻把「游客体验 1 次」改成「登录 / 注册」
}

/* ---------------- 与服务器交互 ---------------- */

async function api(path, body) {
  /* fetch 在断网 / 服务端重启 / 反代没配好时会**直接抛异常**（TypeError: Failed to fetch），
     之前没兜住，异常一路冒到 doLogin 外面，
     → 表单的 `await doLogin()` 直接中断，按钮永远停在「登录中…」（用户报的卡死就是这个）。
     所以这里统一转成 { ok:false }，让调用方按正常失败路径处理。 */
  try {
    const r = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    let data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null, networkError: true };
  }
}

async function refreshAuthState() {
  try {
    const { ok, data, networkError } = await api('/api/whoami');
    if (networkError) {
      // 连不上就当纯静态部署处理：不设门槛、不弹注册
      authAvailable = false;
      currentUser = null;
    } else if (ok && data && data.ok) {
      authAvailable = true;
      currentUser = data.user || null;
    } else {
      authAvailable = false;
    }
  } catch (e) {
    // 纯静态部署（Nginx）下这里必然失败：不设门槛，功能照常
    authAvailable = false;
    currentUser = null;
  }
  syncAuthUI();
  return authAvailable;
}

async function doLogin(username, password) {
  const res = await api('/api/user/login', { username, password });
  const { ok, data } = res;
  if (res.networkError) {
    return { ok: false, error: '连不上服务器（网络中断或后端没启动），请稍后重试' };
  }
  if (ok && data && data.ok) {
    currentUser = data.user;
    syncAuthUI();
    closeAuthPanel();
    // 用邮箱匹配到账号时说一句，避免用户以为"我输错了居然还能进"
    if (data.matchedBy === 'email') {
      setStatus('已用注册邮箱登录（账号：' + data.user.username + '）。', 'ok');
    }
    if (typeof onAuthChanged === 'function') onAuthChanged();
    return { ok: true };
  }
  return { ok: false, error: (data && data.error) || '登录失败' };
}

async function doRegister(username, email, password, agreed) {
  if (!agreed) return { ok: false, error: '请先阅读并同意《用户协议与隐私说明》' };
  const res = await api('/api/user/register', { username, email, password });
  if (res.networkError) {
    return { ok: false, error: '连不上服务器（网络中断或后端没启动），请稍后重试' };
  }
  const { ok, data } = res;
  if (ok && data && data.ok) {
    // 注册后服务器已种 Cookie，直接算登录
    currentUser = data.user;
    syncAuthUI();
    closeAuthPanel();
    if (typeof onAuthChanged === 'function') onAuthChanged();
    return { ok: true };
  }
  return { ok: false, error: (data && data.error) || '注册失败' };
}

async function doLogout() {
  try { await api('/api/user/logout', {}); } catch (e) { /* 忽略 */ }
  currentUser = null;
  syncAuthUI();
  if (typeof onAuthChanged === 'function') onAuthChanged();
}

/* ---------------- 界面 ---------------- */

function syncAuthUI() {
  const btn = document.getElementById('authBtn');
  const txt = btn && btn.querySelector('.auth-btn-txt');
  if (!btn) return;
  const nameEl = document.getElementById('authUsername');
  if (nameEl) nameEl.textContent = currentUser ? currentUser.username : '—';

  if (currentUser) {
    btn.classList.add('is-logged');
    if (txt) txt.textContent = currentUser.username;
    btn.title = '已登录：' + currentUser.username + '（点击查看）';
  } else if (authAvailable) {
    btn.classList.remove('is-logged');
    if (txt) txt.textContent = guestUsed || guestUsedLocal() ? '登录 / 注册' : '游客体验 1 次';
    btn.title = '';
  } else {
    btn.classList.remove('is-logged');
    if (txt) txt.textContent = '离线模式';
    btn.title = '当前为纯静态部署，未连接服务器';
  }
}

/* ---------------- 进入应用后主动引导注册 ---------------- */

const PROMPTED_KEY = 'fes.authPrompted.v1';

/**
 * 进入应用时，如果还没登录，就主动弹一次注册/登录。
 * 只在**每个会话弹一次**（sessionStorage），避免每次刷新都糊一脸。
 * ?debug=1 / ?cover=0 下不弹，否则所有自动化测试都会被弹层挡住。
 */
function maybePromptAuth() {
  const panel = document.getElementById('authPanel');
  if (panel && !panel.hidden) return;     // 已经开着，别重复弹（也不抢焦点）
  const q = new URLSearchParams(location.search);
  if (q.has('debug') || q.get('cover') === '0') return;
  if (currentUser) return;
  if (!authAvailable) return;                 // 纯静态部署没有账号系统，别弹
  try {
    if (sessionStorage.getItem(PROMPTED_KEY) === '1') return;
    sessionStorage.setItem(PROMPTED_KEY, '1');
  } catch (e) { /* 隐私模式忽略 */ }
  openAuthPanel('welcome');
}

/* 弹窗打开时锁住背景滚动。
   两个理由：
     ① 模态弹窗后面还能滚，体验很怪；
     ② 页面有滚动条时，fixed 居中会偏「半个滚动条宽度」（实测 1280 宽偏 7px）。
        锁滚动后滚动条消失，居中就精确了。消失前用 padding 补回宽度，避免内容跳一下。 */
function lockPageScroll(lock) {
  const html = document.documentElement;
  const body = document.body;
  if (!html || !body) return;

  /* ⚠️ 手机端**不能**锁 html 的 overflow。
     iOS Safari 有一个已知行为：html/body 被禁止滚动时，
     聚焦输入框会尝试「把输入框滚进可视区」，但滚动被禁 → 浏览器放弃 → 输入框失焦，
     表现就是「输入一个字母键盘就收起」（用户报的真实问题）。
     手机端的弹层本身是整屏宽/底部抽屉，背景滚动影响很小，所以这里不加锁。 */
  const isMobile = window.matchMedia && window.matchMedia('(max-width: 760px)').matches;
  if (lock && isMobile) {
    // 只用 CSS 的 overscroll-behavior 挡住穿透滚动，不动 overflow
    body.classList.add('modal-open-mobile');
    html.classList.add('modal-open');      // 手机也要让弹层盖过封面
    return;
  }
  if (!lock) {
    body.classList.remove('modal-open-mobile');
    html.classList.remove('modal-open');
  }

  if (lock) {
    /* 修：以前给 body 加 paddingRight = 滚动条宽度，会让页面整体左移一下
       （用户报的"打开弹窗时整页左右平移"）。
       现在改用 scrollbar-gutter: stable —— 浏览器原生保留滚动条占位，
       锁定 overflow 时布局宽度不变，页面纹丝不动。
       对不支持的浏览器，退回"给 html 加 padding、不加给 body"的老办法。 */
    html.dataset.prevOverflow = html.style.overflow || '';
    html.dataset.prevPaddingRight = html.style.paddingRight || '';
    html.classList.add('is-scroll-locked');
    html.classList.add('modal-open');
    html.style.overflow = 'hidden';

    // 兜底：不支持 scrollbar-gutter 的浏览器
    const supportsGutter = (typeof CSS !== 'undefined' && CSS.supports &&
                            CSS.supports('scrollbar-gutter', 'stable'));
    if (!supportsGutter) {
      const sbw = window.innerWidth - html.clientWidth;
      if (sbw > 0) html.style.paddingRight = sbw + 'px';
    }
  } else {
    html.classList.remove('is-scroll-locked');
    html.classList.remove('modal-open');
    html.style.overflow = html.dataset.prevOverflow || '';
    html.style.paddingRight = html.dataset.prevPaddingRight || '';
    delete html.dataset.prevOverflow;
    delete body.dataset.prevPadding;
  }
}

function openAuthPanel(reason) {
  const mask = document.getElementById('authMask');
  const panel = document.getElementById('authPanel');
  if (!mask || !panel) return;

  /* 已经开着就只更新提示，**不要重新初始化**：
     重复调用会重播动画、并把焦点抢到「登录」的用户名框上，
     如果用户正在「注册」页签输入，就会当场失焦、键盘收起。 */
  if (!panel.hidden) {
    const hintEl = document.getElementById('authHint');
    if (hintEl) {
      if (reason === 'guest-used') {
        hintEl.textContent = '游客体验机会已用完。注册一个账号即可继续使用，并保存你的统计数据。';
        hintEl.hidden = false;
      } else if (reason === 'need-login') {
        hintEl.textContent = '请先登录。'; hintEl.hidden = false;
      }
    }
    return;
  }

  /* 真正要打开面板了：作废任何 pending 的「关闭收尾」定时器，
     否则重开时旧的 settle 会误把刚打开的遮罩强关。 */
  ++_authSettleToken;

  /* 从按钮展开：主动点击（无 reason 或 reason 为 welcome 手动打开）时，
     用 openFromButton 从 authBtn 展开；游客门禁等自动触发（guest-used/need-login）
     没有明确的按钮，走默认 spring 落位（.is-open） */
  const isAutoTrigger = reason === 'guest-used' || reason === 'need-login';
  if (!isAutoTrigger && typeof openFromButton === 'function') {
    // 起点交给自动检测：点页头按钮就从页头展开，
    // 点页脚「用户协议」就从页脚展开
    openFromButton(panel, mask);
  } else {
    mask.hidden = false;
    panel.hidden = false;
    lockPageScroll(true);
    // 记录遮罩，让 closeFromButton（依赖 _maskObj）能定位并隐藏它；
    // 否则 autoauth 走 CSS fallback 不设 _maskObj，关闭后遮罩残留锁页。
    panel._maskObj = mask;
    requestAnimationFrame(() => { mask.classList.add('is-open'); panel.classList.add('is-open'); });
  }
  panel.setAttribute('aria-hidden', 'false');

  const hint = document.getElementById('authHint');
  if (hint) {
    if (reason === 'guest-used') {
      hint.textContent = '游客体验机会已用完。注册一个账号即可继续使用，并保存你的统计数据。';
      hint.hidden = false;
    } else if (reason === 'need-login') {
      hint.textContent = '请先登录。';
      hint.hidden = false;
    } else if (reason === 'welcome') {
      hint.textContent = '注册一个账号就能保存你的识别统计，也能在管理台看到自己的使用趋势。想先试试的话，以游客身份可以体验 1 次。';
      hint.hidden = false;
    } else {
      hint.hidden = true;
    }
  }
  setAuthTab('login');
  /* 自动聚焦要克制：只在「页面上没有任何元素被聚焦」时才做，而且聚焦**当前页签**的输入框。
     之前无条件聚焦 loginUser —— 如果用户已经在别的输入框里打字，这一下会把焦点抢走、键盘收起。 */
  setTimeout(() => {
    const ae = document.activeElement;
    const someoneTyping = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA');
    if (someoneTyping) return;
    const loginForm = document.getElementById('loginForm');
    const onLoginTab = loginForm && !loginForm.hidden;
    const target = onLoginTab
      ? document.getElementById('loginUser')
      : document.getElementById('regUser');
    if (target) target.focus();
  }, 80);
}

/* 幂等收尾：无论从哪个入口关，都保证 #authMask / #authPanel 复位到干净态。
   —— 为什么必须独立于 WAAPI onfinish：
      closeFromButton 的遮罩清理（remove is-closing / hidden）写在 close 动画的
      anim.onfinish 里；一旦用户「关闭中又立刻重开」或「连点两次关闭」，
      _cancelModalAnim 会 cancel 掉在跑的关闭动画，其 onfinish 不触发 →
      #authMask 就带着 is-open / is-closing + display:block 残留，把整页点击全拦了。
      本函数不依赖动画回调，拿到遮罩就立即复位；拿不到也绝不抛错。 */
function settleAuthDismiss() {
  const token = _authSettleToken;
  const mask = document.getElementById('authMask');
  const panel = document.getElementById('authPanel');

  // token 已变说明期间又重开了面板，绝不能按"关闭"去强关它
  if (token !== _authSettleToken) return;

  if (mask) {
    mask.classList.remove('is-open', 'is-closing');
    mask.hidden = true;
  }
  if (panel) {
    panel.classList.remove('is-open', 'is-closing');
    panel.hidden = true;
    panel.setAttribute('aria-hidden', 'true');
  }
  if (typeof lockPageScroll === 'function') {
    try { lockPageScroll(false); } catch (e) {}
  }
  const err = document.getElementById('authError');
  if (err) { err.hidden = true; err.textContent = ''; }
}

function closeAuthPanel() {
  const mask = document.getElementById('authMask');
  const panel = document.getElementById('authPanel');
  if (!mask || !panel) return;
  if (panel.hidden) return;          // 已经关了就别重复播

  /* 每次关闭自增 token：如果在这期间又被重开（openAuthPanel 也自增），
     settleAuthDismiss 会看到 token 不对，从而不把刚打开的面板误关。 */
  ++_authSettleToken;
  const token = _authSettleToken;

  if (typeof closeFromButton === 'function') {
    /* closeFromButton 把遮罩清理放在动画 onfinish 里，cancel 时会被跳过。
       所以等关动画（DUR_CLOSE=360ms）结束后再补一次幂等兜底：遮罩若仍残留
       （onfinish 没跑到）就立即复位。动画被取消时 onfinish 不跑，这层兜底兜住它。 */
    closeFromButton(panel);
    setTimeout(() => { if (token === _authSettleToken) settleAuthDismiss(); }, 420);
    return;
  }

  /* 关闭必须有动画，不能"啪"地消失。
     做法：先挂 .is-closing 播退场关键帧（240ms），
     播完再真正 hidden —— 否则元素一隐藏，动画根本来不及跑。 */
  panel.classList.remove('is-open');
  mask.classList.remove('is-open');
  panel.classList.add('is-closing');
  mask.classList.add('is-closing');

  const done = () => {
    panel.classList.remove('is-closing');
    mask.classList.remove('is-closing');
    mask.hidden = true;
    panel.hidden = true;
    panel.setAttribute('aria-hidden', 'true');
  };
  // 动效被系统关掉时直接收，不等待
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) done();
  else setTimeout(done, 240);

  lockPageScroll(false);
  setTimeout(() => { if (token === _authSettleToken) settleAuthDismiss(); }, 420);
  const err = document.getElementById('authError');
  if (err) { err.hidden = true; err.textContent = ''; }
}

function setAuthTab(which) {
  const isLogin = which === 'login';
  const loginForm = document.getElementById('loginForm');
  const regForm = document.getElementById('registerForm');
  const tabLogin = document.getElementById('tabLogin');
  const tabReg = document.getElementById('tabRegister');
  if (loginForm) loginForm.hidden = !isLogin;
  if (regForm) regForm.hidden = isLogin;
  if (tabLogin) tabLogin.classList.toggle('is-active', isLogin);
  if (tabReg) tabReg.classList.toggle('is-active', !isLogin);
  const err = document.getElementById('authError');
  if (err) { err.hidden = true; err.textContent = ''; }
}

function authError(msg) {
  const el = document.getElementById('authError');
  if (!el) return;
  if (!msg) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = msg;
}

function initAuthUI() {
  const btn = document.getElementById('authBtn');
  const mask = document.getElementById('authMask');
  const close = document.getElementById('authClose');
  if (btn) btn.addEventListener('click', () => {
    if (currentUser) {
      // 已登录 → 点一下问是否退出
      const box = document.getElementById('authUserBox');
      if (box) box.hidden = !box.hidden;
      return;
    }
    openAuthPanel();
  });
  if (close) close.addEventListener('click', closeAuthPanel);
  if (mask) mask.addEventListener('click', closeAuthPanel);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.getElementById('authPanel').hidden) { e.stopPropagation(); closeAuthPanel(); }
  }, true);

  const tabLogin = document.getElementById('tabLogin');
  const tabReg = document.getElementById('tabRegister');
  if (tabLogin) tabLogin.addEventListener('click', () => setAuthTab('login'));
  if (tabReg) tabReg.addEventListener('click', () => setAuthTab('register'));

  const loginForm = document.getElementById('loginForm');
  if (loginForm) loginForm.addEventListener('submit', async e => {
    e.preventDefault();
    authError('');
    const u = document.getElementById('loginUser').value.trim();
    const p = document.getElementById('loginPass').value;
    if (!u || !p) { authError('请填写用户名和密码'); return; }
    const btnSubmit = document.getElementById('loginSubmit');
    if (btnSubmit) { btnSubmit.disabled = true; btnSubmit.textContent = '登录中…'; }
    /* finally 里恢复按钮：不管 doLogin 是成功、失败还是抛异常，
       按钮绝不能停在「登录中…」——那会让人以为页面卡死，只能刷新。 */
    let r = { ok: false, error: '登录失败，请重试' };
    try {
      r = await doLogin(u, p);
    } catch (e) {
      r = { ok: false, error: '登录出错：' + (e && e.message ? e.message : '未知错误') };
    } finally {
      if (btnSubmit) { btnSubmit.disabled = false; btnSubmit.textContent = '登录'; }
    }
    if (!r.ok) authError(r.error);
  });

  const regForm = document.getElementById('registerForm');
  if (regForm) regForm.addEventListener('submit', async e => {
    e.preventDefault();
    authError('');
    const u = document.getElementById('regUser').value.trim();
    const em = document.getElementById('regEmail').value.trim();
    const p = document.getElementById('regPass').value;
    const agreed = document.getElementById('regAgree').checked;
    const btnSubmit = document.getElementById('regSubmit');
    if (btnSubmit) { btnSubmit.disabled = true; btnSubmit.textContent = '提交中…'; }
    let r = { ok: false, error: '注册失败，请重试' };
    try {
      r = await doRegister(u, em, p, agreed);
    } catch (e) {
      r = { ok: false, error: '注册出错：' + (e && e.message ? e.message : '未知错误') };
    } finally {
      if (btnSubmit) { btnSubmit.disabled = false; btnSubmit.textContent = '注册并登录'; }
    }
    if (!r.ok) authError(r.error);
  });

  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) logoutBtn.addEventListener('click', async () => {
    await doLogout();
    const box = document.getElementById('authUserBox');
    if (box) box.hidden = true;
  });

  // 页脚的「用户协议」链接：打开弹层并直接亮出协议摘要
  const termsLink = document.getElementById('termsLink');
  if (termsLink) termsLink.addEventListener('click', e => {
    e.preventDefault();
    openAuthPanel();
    const box = document.getElementById('agreementBox');
    if (box) { box.hidden = false; setTimeout(() => box.scrollIntoView({ block: 'nearest' }), 120); }
  });

  const agreeLink = document.getElementById('agreeLink');
  if (agreeLink) agreeLink.addEventListener('click', e => {
    e.preventDefault();
    const box = document.getElementById('agreementBox');
    if (box) { box.hidden = !box.hidden; if (!box.hidden) box.scrollIntoView({ block: 'nearest' }); }
  });
}

async function bootAuth() {
  initAuthUI();
  guestUsed = guestUsedLocal();
  await refreshAuthState();
  syncAuthUI();
}

window.addEventListener('DOMContentLoaded', bootAuth);
