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
  const r = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await r.json(); } catch (e) { data = null; }
  return { ok: r.ok, status: r.status, data };
}

async function refreshAuthState() {
  try {
    const { ok, data } = await api('/api/whoami');
    if (ok && data && data.ok) {
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
  const { ok, data } = await api('/api/user/login', { username, password });
  if (ok && data && data.ok) {
    currentUser = data.user;
    syncAuthUI();
    closeAuthPanel();
    if (typeof onAuthChanged === 'function') onAuthChanged();
    return { ok: true };
  }
  return { ok: false, error: (data && data.error) || '登录失败' };
}

async function doRegister(username, email, password, agreed) {
  if (!agreed) return { ok: false, error: '请先阅读并同意《用户协议与隐私说明》' };
  const { ok, data } = await api('/api/user/register', { username, email, password });
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
  if (lock) {
    const sbw = window.innerWidth - html.clientWidth;   // 滚动条宽度（0 表示本来就没滚动条）
    html.dataset.prevOverflow = html.style.overflow || '';
    body.dataset.prevPadding = body.style.paddingRight || '';
    html.style.overflow = 'hidden';
    if (sbw > 0) body.style.paddingRight = sbw + 'px';
  } else {
    html.style.overflow = html.dataset.prevOverflow || '';
    body.style.paddingRight = body.dataset.prevPadding || '';
    delete html.dataset.prevOverflow;
    delete body.dataset.prevPadding;
  }
}

function openAuthPanel(reason) {
  const mask = document.getElementById('authMask');
  const panel = document.getElementById('authPanel');
  if (!mask || !panel) return;
  mask.hidden = false;
  panel.hidden = false;
  lockPageScroll(true);
  requestAnimationFrame(() => { mask.classList.add('is-open'); panel.classList.add('is-open'); });
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
  const u = document.getElementById('loginUser');
  if (u) setTimeout(() => u.focus(), 80);
}

function closeAuthPanel() {
  const mask = document.getElementById('authMask');
  const panel = document.getElementById('authPanel');
  if (!mask || !panel) return;
  mask.classList.remove('is-open');
  panel.classList.remove('is-open');
  lockPageScroll(false);
  panel.setAttribute('aria-hidden', 'true');
  setTimeout(() => { mask.hidden = true; panel.hidden = true; }, 220);
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
    const r = await doLogin(u, p);
    if (btnSubmit) { btnSubmit.disabled = false; btnSubmit.textContent = '登录'; }
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
    const r = await doRegister(u, em, p, agreed);
    if (btnSubmit) { btnSubmit.disabled = false; btnSubmit.textContent = '注册并登录'; }
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
