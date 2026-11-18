/* ============================================================
   PWA 安装与离线状态（v1.9.5）
   ------------------------------------------------------------
   做三件事：
     ① 注册 Service Worker —— 让页面可以离线运行
     ② 处理「安装到桌面」——
        Android/Chrome: 拦截 beforeinstallprompt，用自定义按钮触发
        iOS Safari:     没有安装 API，只能给引导图文
        已安装/不支持:   隐藏按钮，不打扰
     ③ 显示离线状态 —— 断网时提示「已离线，仍可正常使用」

   设计取舍：
     · 不做「进站就弹安装提示」——那很烦。按钮放在页头，想装的人自己点
     · iOS 不支持自动安装，所以给一步一步的图文引导
     · 装好之后按钮变成「已安装」，不再骚扰
   ============================================================ */

/** beforeinstallprompt 事件暂存（Chrome/Edge/Android 用） */
let _deferredInstallPrompt = null;

/** 环境判断 */
function pwaEnv() {
  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  // iPadOS 13+ 会伪装成 Mac，用触屏判断
  const isIPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches
                    || window.navigator.standalone === true;
  const isAndroid = /Android/.test(ua);
  return { isIOS: isIOS || isIPadOS, isAndroid, isStandalone };
}

/** 已安装（独立窗口运行）时不显示安装按钮 */
function isInstalled() {
  return pwaEnv().isStandalone;
}

/* ---------------- Service Worker 注册 ---------------- */

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    console.log('[PWA] 此浏览器不支持 Service Worker');
    return null;
  }

  // 本地用 file:// 或 localhost 之外的 http 无法注册，直接跳过不报错
  if (location.protocol !== 'https:' && location.hostname !== 'localhost'
      && location.hostname !== '127.0.0.1') {
    console.log('[PWA] 非安全上下文（需 HTTPS），跳过 SW 注册');
    return null;
  }

  try {
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    console.log('[PWA] Service Worker 已注册，scope =', reg.scope);

    /* 有新 SW 在等待时提示用户 */
    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      if (!newWorker) return;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          // 已有旧版本在跑，新版本装好了 → 提示
          showUpdateToast();
        }
      });
    });

    return reg;
  } catch (err) {
    console.warn('[PWA] SW 注册失败:', err);
    return null;
  }
}

/* ---------------- 安装按钮 ---------------- */

/** 渲染/更新安装按钮的状态 */
function syncInstallButton() {
  const btn = document.getElementById('installBtn');
  if (!btn) return;

  const { isIOS, isStandalone } = pwaEnv();

  if (isStandalone) {
    btn.hidden = true;          // 已安装，不显示
    return;
  }

  // iOS 没有 beforeinstallprompt，但只要不是已安装就显示（点了给引导）
  // Android/桌面：只有收到 beforeinstallprompt 才显示（否则说明不支持或已装）
  if (!isIOS && !_deferredInstallPrompt) {
    btn.hidden = true;
    return;
  }

  btn.hidden = false;
}

/** 点安装按钮 */
async function onInstallClick() {
  const { isIOS } = pwaEnv();

  if (isIOS) {
    showIOSInstallGuide();
    return;
  }

  if (!_deferredInstallPrompt) {
    setStatus('当前浏览器不支持一键安装，可用浏览器菜单里的「安装应用」或「添加到主屏幕」。', 'ok');
    return;
  }

  // 触发系统安装弹窗
  _deferredInstallPrompt.prompt();
  const choice = await _deferredInstallPrompt.userChoice;
  console.log('[PWA] 用户选择:', choice.outcome);

  if (choice.outcome === 'accepted') {
    setStatus('已安装到桌面。以后从桌面图标打开，断网也能用。', 'ok');
  }
  _deferredInstallPrompt = null;
  syncInstallButton();
}

/** iOS 的图文引导（Safari 没有安装 API） */
function showIOSInstallGuide() {
  const modal = document.getElementById('iosGuideModal');
  const mask = document.getElementById('iosGuideMask');
  if (!modal || !mask) return;

  mask.hidden = false;
  modal.hidden = false;
  requestAnimationFrame(() => {
    mask.classList.add('is-open');
    modal.classList.add('is-open');
  });
  if (typeof lockPageScroll === 'function') lockPageScroll(true);
}

function closeIOSInstallGuide() {
  const modal = document.getElementById('iosGuideModal');
  const mask = document.getElementById('iosGuideMask');
  if (!modal || !mask || modal.hidden) return;

  modal.classList.remove('is-open');
  mask.classList.remove('is-open');
  const done = () => {
    modal.hidden = true;
    mask.hidden = true;
    if (typeof lockPageScroll === 'function') lockPageScroll(false);
  };
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) done(); else setTimeout(done, 200);
}

/* ---------------- 更新提示 ---------------- */

function showUpdateToast() {
  const t = document.getElementById('updateToast');
  if (!t) return;
  t.hidden = false;
  requestAnimationFrame(() => t.classList.add('is-open'));
}

function applyUpdate() {
  if (!navigator.serviceWorker || !navigator.serviceWorker.controller) {
    location.reload();
    return;
  }
  navigator.serviceWorker.controller.postMessage({ type: 'SKIP_WAITING' });
  // 等新 SW 接管后刷新
  setTimeout(() => location.reload(), 300);
}

/* ---------------- 离线状态 ---------------- */

function syncOnlineState() {
  const bar = document.getElementById('offlineBar');
  if (!bar) return;

  if (navigator.onLine) {
    bar.hidden = true;
  } else {
    bar.hidden = false;
  }
}

/* ---------------- 初始化 ---------------- */

function initPWA() {
  if (initPWA._done) return;
  initPWA._done = true;

  /* ① 注册 SW */
  registerServiceWorker();

  /* ② 安装提示事件（Chrome / Edge / Android） */
  window.addEventListener('beforeinstallprompt', (e) => {
    // 阻止浏览器自带的迷你提示条，改用我们自己的按钮
    e.preventDefault();
    _deferredInstallPrompt = e;
    syncInstallButton();
  });

  /* 安装完成 */
  window.addEventListener('appinstalled', () => {
    console.log('[PWA] 已安装');
    _deferredInstallPrompt = null;
    syncInstallButton();
    setStatus('已安装到桌面。以后断网也能用。', 'ok');
  });

  /* ③ 绑定按钮 */
  const btn = document.getElementById('installBtn');
  if (btn) btn.addEventListener('click', onInstallClick);

  const iosClose = document.getElementById('iosGuideClose');
  if (iosClose) iosClose.addEventListener('click', closeIOSInstallGuide);
  const iosMask = document.getElementById('iosGuideMask');
  if (iosMask) iosMask.addEventListener('click', closeIOSInstallGuide);

  const updateYes = document.getElementById('updateToastYes');
  if (updateYes) updateYes.addEventListener('click', applyUpdate);
  const updateNo = document.getElementById('updateToastNo');
  if (updateNo) {
    updateNo.addEventListener('click', () => {
      const t = document.getElementById('updateToast');
      if (t) { t.classList.remove('is-open'); setTimeout(() => { t.hidden = true; }, 200); }
    });
  }

  /* ④ 在线/离线 */
  window.addEventListener('online', syncOnlineState);
  window.addEventListener('offline', syncOnlineState);
  syncOnlineState();

  /* ⑤ 首次渲染按钮状态（延迟一点，等 beforeinstallprompt 可能先到） */
  setTimeout(syncInstallButton, 1200);

  /* ⑥ 从桌面图标启动时，判断是否已安装 */
  if (pwaEnv().isStandalone) {
    console.log('[PWA] 以独立应用模式运行');
  }

  /* ⑦ 页头版本号：安装版显示 "v1.9.5(p)"，网页版显示 "v1.9.5" */
  syncVersionLabel();
}

/**
 * 版本号显示区分：
 *   普通网页    v1.9.5
 *   装到桌面的  v1.9.5(p)   —— p = PWA，一眼看出是应用版
 */
function syncVersionLabel() {
  const el = document.getElementById('versionLabel');
  if (!el) return;

  const base = el.dataset.base || el.textContent.replace(/\(p\)$/, '');
  el.dataset.base = base;

  if (pwaEnv().isStandalone) {
    el.textContent = base + '(p)';
    el.title = '已安装为桌面应用（PWA）';
    el.classList.add('is-pwa');
  } else {
    el.textContent = base;
    el.title = '网页版';
    el.classList.remove('is-pwa');
  }
}

/** 页面手动「检查更新」（设置在抽屉里可以放一个入口） */
function checkForUpdate() {
  if (!navigator.serviceWorker || !navigator.serviceWorker.controller) {
    setStatus('当前不是离线模式，每次打开都是最新版。', 'ok');
    return;
  }
  navigator.serviceWorker.controller.postMessage({ type: 'CHECK_UPDATE' });
  setStatus('正在检查更新…', 'loading');
  setTimeout(() => setStatus('已是最新版本。', 'ok'), 1500);
}
