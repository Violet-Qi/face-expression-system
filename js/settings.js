/* ============================================================
   设置层：判定偏好 + 跨设备同步（匿名编号）+ 设置分享链接
   ------------------------------------------------------------
   设计取舍（这里写清楚）：

   1. **为什么不记录 IP / 设备信息？**
      IP 在《个人信息保护法》和 GDPR 里都算个人信息，存了就得改隐私声明。
      所以只用一个前端生成的**随机 UUID**（crypto.randomUUID）当键，
      服务器只存"某串随机字符 + 几个数字"，**不知道是谁、也不知道从哪来**。

   2. **为什么清缓存会"失联"？**
      编号存在 localStorage 里，清掉就没了。服务器上那条记录还在，
      但再也对不上号（相当于退出登录）。这一点在设置面板里明确告诉用户。

   3. **为什么参数只能调"判定偏好"，不能调"准确率"？**
      模型准确率是训练时定死的，改不了。能调的只有"宁可漏检还是宁可误检"的取舍。
      所以面板里每个滑块下面都写了调高/调低的实际后果，不写「提高准确率」。

   4. 设置存在两处：localStorage（本机，优先）+ 服务器的匿名编号（可选同步）。
      后端没跑（纯静态部署）时自动降级为"只存本机"，不报错。
   ============================================================ */

const SETTINGS_KEY = 'fes.settings.v1';
const DEVICE_KEY   = 'fes.deviceId.v1';

/** 默认值。注意 detectThreshold 与 config.js 的 SCORE_TH 保持一致 */
const DEFAULT_SETTINGS = {
  detectThreshold: 0.50,     // 人脸检测阈值 0.30~0.80
  uncertainThreshold: 0.00,  // top1 低于它显示"不确定"，0 = 关闭
  cameraInterval: 400        // 摄像头检测间隔(ms) 200~1000
};

/** 参数范围（滑块和校验共用） */
const SETTINGS_RANGE = {
  detectThreshold:    { min: 0.30, max: 0.80, step: 0.01, fix: 2 },
  uncertainThreshold: { min: 0.00, max: 0.90, step: 0.05, fix: 2 },
  cameraInterval:     { min: 200,  max: 1000, step: 50,  fix: 0 }
};

/* 当前生效的设置。其他模块**只读**这个对象（用 curSettings()） */
let activeSettings = Object.assign({}, DEFAULT_SETTINGS);

/** 取当前生效设置 */
function curSettings() {
  return activeSettings;
}

/** 检测阈值（recognize / camera / video 三处都改用它） */
function scoreThresholdNow() {
  return activeSettings.detectThreshold;
}

/** 摄像头检测间隔 */
function cameraIntervalNow() {
  return activeSettings.cameraInterval;
}

/* ---------------- 存取 ---------------- */

function clampSetting(key, v) {
  const r = SETTINGS_RANGE[key];
  if (!r) return DEFAULT_SETTINGS[key];
  let n = Number(v);
  if (!isFinite(n)) return DEFAULT_SETTINGS[key];
  n = Math.min(r.max, Math.max(r.min, n));
  // 对齐步长，避免出现 0.5000001 这种脏值
  n = Math.round(n / r.step) * r.step;
  return Number(n.toFixed(r.fix + 2));
}

/** 把任意输入（本地 / 云端 / 链接）洗成合法的设置对象 */
function sanitizeSettings(raw) {
  const out = Object.assign({}, DEFAULT_SETTINGS);
  if (!raw || typeof raw !== 'object') return out;
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (raw[k] !== undefined) out[k] = clampSetting(k, raw[k]);
  }
  return out;
}

function readLocalSettings() {
  try {
    const s = localStorage.getItem(SETTINGS_KEY);
    return s ? sanitizeSettings(JSON.parse(s)) : null;
  } catch (e) {
    return null;
  }
}

function writeLocalSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(activeSettings));
  } catch (e) { /* 隐私模式下 localStorage 可能不可用，忽略 */ }
}

/** 设备匿名编号：随机 UUID，不含任何设备信息 */
function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      id = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
          });
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch (e) {
    return null;   // 拿不到就退化成"只存本机"
  }
}

/* ---------------- 生效 ---------------- */

/** 把设置应用成当前生效值（不重算已有结果，下次识别才生效） */
function applySettings(next, opts) {
  activeSettings = sanitizeSettings(next);
  writeLocalSettings();
  syncDrawerUI();
  const o = opts || {};
  if (!o.silent && typeof onSettingsApplied === 'function') onSettingsApplied();
  return activeSettings;
}

/* ---------------- 与服务器同步（可选） ---------------- */

let settingsSyncState = 'idle';   // idle | ok | offline | saving

async function fetchRemoteSettings() {
  const id = deviceId();
  if (!id) { settingsSyncState = 'offline'; syncDrawerUI(); return null; }
  try {
    const r = await fetch('/api/settings?id=' + encodeURIComponent(id));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    if (data && data.payload) {
      settingsSyncState = 'ok';
      syncDrawerUI();
      return sanitizeSettings(data.payload);
    }
    settingsSyncState = 'ok';
    syncDrawerUI();
    return null;
  } catch (e) {
    // 纯静态部署（Nginx）下这里必然失败，属于预期，不打扰用户
    settingsSyncState = 'offline';
    syncDrawerUI();
    return null;
  }
}

let pushTimer = null;
let pushPending = false;

/** 把设置推到服务器（防抖 600ms，失败就静默降级为只存本机） */
function pushRemoteSettings() {
  const id = deviceId();
  if (!id) return;
  pushPending = true;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    pushTimer = null;
    pushPending = false;
    try {
      const r = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, payload: activeSettings })
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      settingsSyncState = 'ok';
    } catch (e) {
      settingsSyncState = 'offline';
    }
    syncDrawerUI();
  }, 600);
}

/* ---------------- 分享链接（C 方案） ---------------- */

function toBase64Url(str) {
  // 中文/ASCII 都按 UTF-8 编，再转 URL 安全的 base64
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s) {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b + '='.repeat((4 - b.length % 4) % 4));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** 生成"带上这套设置"的分享链接 */
function buildShareLink() {
  const packed = toBase64Url(JSON.stringify(activeSettings));
  const u = new URL(location.href);
  u.searchParams.delete('preset');
  u.searchParams.set('preset', packed);
  u.hash = '';
  return u.toString();
}

/** 解析用户粘贴的链接或裸字符串，返回设置对象或 null */
function parseSharedSettings(text) {
  if (!text) return null;
  let raw = String(text).trim();
  if (!raw) return null;
  // 允许直接粘贴整条链接
  if (raw.indexOf('preset=') >= 0) {
    const m = raw.match(/preset=([A-Za-z0-9_-]+)/);
    if (m) raw = m[1];
  }
  // 也允许粘贴 JSON
  if (raw.charAt(0) === '{') {
    try { return sanitizeSettings(JSON.parse(raw)); } catch (e) { return null; }
  }
  try {
    return sanitizeSettings(JSON.parse(fromBase64Url(raw)));
  } catch (e) {
    return null;
  }
}

/** 打开页面时如果 URL 带 ?preset=，就问一句要不要套用 */
function maybeApplyUrlPreset() {
  const q = new URLSearchParams(location.search);
  const p = q.get('preset');
  if (!p) return false;
  const s = parseSharedSettings(p);
  if (!s) return false;
  applySettings(s, { silent: true });
  showPresetNote();
  pushRemoteSettings();
  return true;
}

/** 套用了链接里的设置时，在状态条下面挂一条可关闭的小提示（不占用模型状态条，避免互相覆盖） */
function showPresetNote() {
  if (document.getElementById('presetNote')) return;
  const bar = document.getElementById('modelStatus');
  if (!bar || !bar.parentNode) return;

  const wrap = document.createElement('div');
  wrap.id = 'presetNote';
  wrap.className = 'preset-note';
  wrap.innerHTML =
    '<span class="preset-note-txt">已套用链接里分享的设置（下次识别生效）。想恢复就点右上角「设置」→「恢复默认」。</span>' +
    '<button type="button" class="preset-note-x" aria-label="关闭提示">×</button>';
  bar.parentNode.insertBefore(wrap, bar.nextSibling);
  wrap.querySelector('.preset-note-x').addEventListener('click', () => wrap.remove());
}

/* ============================================================
   设置面板 UI
   ============================================================ */

let drawerOpen = false;

function setDrawer(open) {
  const d = document.getElementById('settingsDrawer');
  const m = document.getElementById('settingsMask');
  const b = document.getElementById('settingsBtn');
  if (!d || !m) return;
  drawerOpen = !!open;
  if (open) {
    d.hidden = false; m.hidden = false;
    // 下一帧再加 class，让 CSS 过渡能跑
    requestAnimationFrame(() => { d.classList.add('is-open'); m.classList.add('is-open'); });
    d.setAttribute('aria-hidden', 'false');
    if (b) b.setAttribute('aria-expanded', 'true');
    syncDrawerUI();
  } else {
    d.classList.remove('is-open'); m.classList.remove('is-open');
    d.setAttribute('aria-hidden', 'true');
    if (b) b.setAttribute('aria-expanded', 'false');
    setTimeout(() => { if (!drawerOpen) { d.hidden = true; m.hidden = true; } }, 240);
  }
}

function fmtSetting(key) {
  const r = SETTINGS_RANGE[key];
  const v = activeSettings[key];
  if (key === 'cameraInterval') return v + ' ms';
  return Number(v).toFixed(2);
}

/** 抽屉里的数值 / 状态文字同步 */
function syncDrawerUI() {
  const map = {
    setThreshold: 'detectThreshold',
    setUncertain: 'uncertainThreshold',
    setInterval: 'cameraInterval'
  };
  for (const inputId in map) {
    const key = map[inputId];
    const input = document.getElementById(inputId);
    const out = document.getElementById(inputId + 'Val');
    if (input && Number(input.value) !== Number(activeSettings[key])) input.value = activeSettings[key];
    if (out) out.textContent = fmtSetting(key);
  }

  const idText = document.getElementById('deviceIdText');
  if (idText) {
    const id = deviceId();
    idText.textContent = id ? id.slice(0, 8) + '…' : '（本机存储不可用）';
  }

  const st = document.getElementById('settingsSync');
  if (st) {
    const txt = {
      idle: '正在读取云端设置…',
      saving: '正在保存…',
      ok: '已连接服务器：这套设置会按匿名编号自动同步。',
      offline: '未连接服务器：设置只保存在本机（部署形态为纯静态时属正常）。'
    }[settingsSyncState] || '';
    st.textContent = txt;
    st.className = 'set-status ' + (settingsSyncState === 'ok' ? 'is-ok' : settingsSyncState === 'offline' ? 'is-warn' : '');
  }

  const dirty = document.getElementById('settingsDirty');
  if (dirty) dirty.hidden = !pushPending;
}

/** 点「复制设置链接」 */
async function copyShareLink() {
  const link = buildShareLink();
  try {
    await navigator.clipboard.writeText(link);
    toastInDrawer('链接已复制。任何设备打开它都会套用这套设置。');
  } catch (e) {
    // 剪贴板不可用（非 https / 浏览器限制）→ 退化成让用户手动复制
    const box = document.getElementById('shareFallback');
    const ta = document.getElementById('shareFallbackText');
    if (box && ta) { ta.value = link; box.hidden = false; ta.select(); }
    toastInDrawer('已生成链接，请手动复制下面的内容。');
  }
}

function toastInDrawer(msg) {
  const t = document.getElementById('settingsToast');
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t.__timer);
  t.__timer = setTimeout(() => { t.hidden = true; }, 5200);
}

function initSettingsUI() {
  const btn = document.getElementById('settingsBtn');
  const close = document.getElementById('settingsClose');
  const mask = document.getElementById('settingsMask');
  if (!btn || !close) return;

  btn.addEventListener('click', () => setDrawer(!drawerOpen));
  close.addEventListener('click', () => setDrawer(false));
  if (mask) mask.addEventListener('click', () => setDrawer(false));

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && drawerOpen) { e.stopPropagation(); setDrawer(false); }
  }, true);

  // 三个滑块
  const bindings = [
    ['setThreshold', 'detectThreshold'],
    ['setUncertain', 'uncertainThreshold'],
    ['setInterval', 'cameraInterval']
  ];
  bindings.forEach(([inputId, key]) => {
    const input = document.getElementById(inputId);
    if (!input) return;
    input.addEventListener('input', () => {
      const next = Object.assign({}, activeSettings);
      next[key] = input.value;
      applySettings(next);
      pushRemoteSettings();
    });
  });

  const copyBtn = document.getElementById('copyLinkBtn');
  if (copyBtn) copyBtn.addEventListener('click', copyShareLink);

  const importBtn = document.getElementById('importLinkBtn');
  if (importBtn) importBtn.addEventListener('click', () => {
    const box = document.getElementById('importBox');
    const ta = document.getElementById('importText');
    if (box) box.hidden = false;
    if (ta) ta.focus();
  });

  const doImport = document.getElementById('importConfirm');
  if (doImport) doImport.addEventListener('click', () => {
    const ta = document.getElementById('importText');
    const s = parseSharedSettings(ta ? ta.value : '');
    if (!s) { toastInDrawer('没看懂这段内容，请粘贴完整的设置链接。'); return; }
    applySettings(s);
    pushRemoteSettings();
    toastInDrawer('已套用导入的设置（下次识别生效）。');
  });

  const resetBtn = document.getElementById('resetBtn');
  if (resetBtn) resetBtn.addEventListener('click', () => {
    applySettings(DEFAULT_SETTINGS);
    pushRemoteSettings();
    toastInDrawer('已恢复默认。');
  });
}

/** 启动：先给默认值，再本机覆盖，再尝试云端覆盖；最后应用并挂 UI */
async function bootSettings() {
  initSettingsUI();

  const local = readLocalSettings();
  if (local) activeSettings = local;

  // URL 里的分享设置优先级最高（用户是从别人那儿点进来的）
  const hadPreset = maybeApplyUrlPreset();

  if (!hadPreset) {
    const remote = await fetchRemoteSettings();
    if (remote) {
      // 云端有记录就用云端的（这台设备之前存过）
      applySettings(remote, { silent: true });
    } else if (!local) {
      // 第一次用：把本机默认值登记到匿名编号下
      pushRemoteSettings();
    }
  }

  if (!hadPreset) applySettings(activeSettings, { silent: true });
  syncDrawerUI();
  if (typeof onSettingsApplied === 'function') onSettingsApplied();
}

window.addEventListener('DOMContentLoaded', bootSettings);
