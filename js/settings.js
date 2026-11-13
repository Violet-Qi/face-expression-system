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
/* 可选主题。'default' 就是原来的橙色，不设 data-theme，保证老观感不变 */
const THEMES = ['default', 'sunflower', 'ocean', 'sakura'];
const THEME_CN = { default: '默认橙', sunflower: '向日葵黄', ocean: '海洋蓝', sakura: '樱花粉' };

const DEFAULT_SETTINGS = {
  detectThreshold: 0.50,     // 人脸检测阈值 0.30~0.80
  uncertainThreshold: 0.00,  // top1 低于它显示"不确定"，0 = 关闭
  cameraInterval: 400,       // 摄像头检测间隔(ms) 200~1000
  theme: 'default',          // 主题色（字符串，不走数值夹紧）
  detectPreset: 'speed',     // 检测器档位：speed / balanced / accurate
  smoothAlpha: 0.40,         // 多帧平滑强度：越大越跟随新帧（0 = 关闭）
  smoothHysteresis: 2,       // 标签切换要连续赢几次
  expressionEngine: 'faceapi',  // 表情引擎：faceapi（快速）/ ferplus（增强）
  cameraUseEnhance: true     // 摄像头模式是否允许增强表情模型（手机一律不允许）
};

/** 参数范围（滑块和校验共用） */
const SETTINGS_RANGE = {
  detectThreshold:    { min: 0.30, max: 0.80, step: 0.01, fix: 2 },
  uncertainThreshold: { min: 0.00, max: 0.90, step: 0.05, fix: 2 },
  cameraInterval:     { min: 200,  max: 1000, step: 50,  fix: 0 },
  smoothAlpha:        { min: 0.00, max: 1.00, step: 0.05, fix: 2 },
  smoothHysteresis:   { min: 1,    max: 6,    step: 1,    fix: 0 }
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
    if (raw[k] === undefined) continue;
    if (k === 'theme') {
      // 主题是字符串，不能走数值夹紧，只接受白名单
      out.theme = THEMES.indexOf(String(raw.theme)) >= 0 ? String(raw.theme) : 'default';
    } else if (k === 'detectPreset') {
      out.detectPreset = DETECT_PRESET_KEYS.indexOf(String(raw.detectPreset)) >= 0 ? String(raw.detectPreset) : 'speed';
    }
    else if (k === 'cameraUseEnhance') {
      out.cameraUseEnhance = (raw.cameraUseEnhance === false || raw.cameraUseEnhance === 'false') ? false : true;
    } else if (k === 'expressionEngine') {
      const ee = String(raw.expressionEngine);
      out.expressionEngine = (ee === 'ferplus') ? 'ferplus' : 'faceapi';
    } else {
      out[k] = clampSetting(k, raw[k]);
    }
  }
  return out;
}

/** 把主题套到 html 上。'default' 时移除属性，回到原始橙色 */
function applyTheme(name) {
  const root = document.documentElement;
  const t = THEMES.indexOf(name) >= 0 ? name : 'default';
  if (t === 'default') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);
  // 移动端浏览器地址栏跟着变（支持的浏览器才有用，不支持就算了）
  const meta = document.querySelector('meta[name="theme-color"]');
  const colors = { default: '#f4f6f8', sunflower: '#fdf8ec', ocean: '#eef5fa', sakura: '#fdf3f5' };
  if (meta) meta.setAttribute('content', colors[t]);
  return t;
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
  applyTheme(activeSettings.theme);
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

/**
 * 打开设置抽屉并滚到指定分组。
 * 用途：诊断面板和阈值实验原来埋在抽屉最下面，不给直达入口基本没人会翻到（用户反馈）。
 */
function openDrawerTo(sectionId) {
  const d = document.getElementById('settingsDrawer');
  if (!d) return;
  if (d.hidden) setDrawer(true);
  const target = document.getElementById(sectionId);
  if (!target) return;
  // 等抽屉滑入完成再滚，否则量到的位置是错的
  setTimeout(() => {
    const body = d.querySelector('.drawer-body');
    if (body) {
      const top = target.offsetTop - body.offsetTop - 8;
      body.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    } else {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    // 高亮一下，让人知道"跳到这里了"
    target.classList.add('is-flash');
    setTimeout(() => target.classList.remove('is-flash'), 1200);
  }, 300);
}

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
    d.classList.add('is-closing');        // 让退场关键帧有机会跑
    d.setAttribute('aria-hidden', 'true');
    if (b) b.setAttribute('aria-expanded', 'false');
    setTimeout(() => {
      if (!drawerOpen) { d.classList.remove('is-closing'); d.hidden = true; m.hidden = true; }
    }, 240);
  }
}

function fmtSetting(key) {
  const r = SETTINGS_RANGE[key];
  const v = activeSettings[key];
  if (key === 'cameraInterval') return v + ' ms';
  if (key === 'smoothHysteresis') return Number(v) + ' 帧';  if (key === 'smoothAlpha') return Number(v) === 0 ? '关闭' : Number(v).toFixed(2);  return Number(v).toFixed(2);
}

/** 抽屉里的数值 / 状态文字同步 */
function syncDrawerUI() {
  const map = {
    setThreshold: 'detectThreshold',
    setUncertain: 'uncertainThreshold',
    setInterval: 'cameraInterval',
      setSmooth: 'smoothAlpha',
      setHysteresis: 'smoothHysteresis'
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

  syncThemeChips();

  syncPresetChips();

  const dirty = document.getElementById('settingsDirty');
  if (dirty) dirty.hidden = !pushPending;
}

/** 按注册表渲染档位列表（弹层里用） */
function renderPresetChips() {
  const box = document.getElementById('presetList');
  if (!box || typeof MODEL_REGISTRY === 'undefined') return;

  box.innerHTML = MODEL_REGISTRY.map(p =>
    '<button type="button" class="preset-chip" data-preset="' + p.key + '">' +
      '<b>' + p.name + '</b>' +
      '<span class="preset-sub">' + p.desc + '</span>' +
      '<span class="preset-meta">' +
        (p.detectNet === 'tinyFaceDetector' ? 'Tiny 检测器' : 'SSD 检测器') +
        ' · ' + (p.extraMB ? '首次需下载 ' + p.extraMB + ' MB' : '已内置，无需下载') +
        ' · ' + p.speedHint +
      '</span>' +
    '</button>'
  ).join('');

  bindPresetChips();
  syncPresetChips();
}

/** 打开分析弹层（tab: 'diag' | 'exp'） */
function openAnaModal(tab) {
  const mask = document.getElementById('anaMask');
  const modal = document.getElementById('anaModal');
  if (!mask || !modal) return;
  mask.hidden = false;
  modal.hidden = false;
  requestAnimationFrame(() => { mask.classList.add('is-open'); modal.classList.add('is-open'); });
  modal.setAttribute('aria-hidden', 'false');
  setAnaTab(tab || 'diag');
  if (typeof lockPageScroll === 'function') lockPageScroll(true);
  if (typeof renderDiagPanel === 'function') renderDiagPanel();
}

function closeAnaModal() {
  const mask = document.getElementById('anaMask');
  const modal = document.getElementById('anaModal');
  if (!mask || !modal || modal.hidden) return;
  modal.classList.remove('is-open');
  mask.classList.remove('is-open');
  modal.classList.add('is-closing');
  mask.classList.add('is-closing');
  const done = () => {
    modal.classList.remove('is-closing');
    mask.classList.remove('is-closing');
    modal.hidden = true;
    mask.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    // 其它弹层可能还开着，全部关掉才解锁
    const presetOpen = document.getElementById('presetModal') && !document.getElementById('presetModal').hidden;
    const authOpen = document.getElementById('authPanel') && !document.getElementById('authPanel').hidden;
    if (!presetOpen && !authOpen && typeof lockPageScroll === 'function') lockPageScroll(false);
  };
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) done(); else setTimeout(done, 200);
}

function setAnaTab(which) {
  const isDiag = which !== 'exp';
  const d = document.getElementById('anaDiag');
  const e = document.getElementById('anaExp');
  const td = document.getElementById('tabDiag');
  const te = document.getElementById('tabExp');
  if (d) d.hidden = !isDiag;
  if (e) e.hidden = isDiag;
  if (td) td.classList.toggle('is-active', isDiag);
  if (te) te.classList.toggle('is-active', !isDiag);
}

/* ---------------- 页头档位下拉（v1.9.0）---------------- */

const PRESET_ICONS = { speed: '⚡', balanced: '⚖️', accurate: '🎯' };

/** 渲染页头下拉里的条目 */
function renderPresetMenu() {
  const menu = document.getElementById('presetMenu');
  if (!menu || typeof MODEL_REGISTRY === 'undefined') return;

  const items = MODEL_REGISTRY.map(p =>
    '<button type="button" class="preset-menu-item" role="option" data-preset="' + p.key + '">' +
      '<b>' + (PRESET_ICONS[p.key] || '') + ' ' + p.name + '</b>' +
      '<span class="pm-check">✓</span>' +
      '<span class="pm-sub">' + p.desc + '</span>' +
      '<span class="pm-meta">' +
        (p.extraMB ? '首次需下载 ' + p.extraMB + ' MB' : '已内置') + ' · ' + p.speedHint +
      '</span>' +
    '</button>'
  ).join('');

  /* 第二组：表情引擎。检测器决定"找不找得到脸"，表情引擎决定"判得准不准"，是两件事。 */
  const curEngine = curSettings().expressionEngine || 'faceapi';
  const engineItems = [
    { key: 'faceapi', name: '快速表情模型', sub: 'face-api 自带，322 KB，随页面加载',
      meta: '所有设备可用 · 速度最快' },
    { key: 'ferplus', name: '增强表情模型', sub: 'FERPlus 训练的 CNN，18.4 MB',
      meta: '仅电脑可用 · 首次需下载 · 明显变慢' }
  ].map(e =>
    '<button type="button" class="preset-menu-item" role="option" data-engine="' + e.key + '">' +
      '<b>' + e.name + '</b>' +
      '<span class="pm-check">✓</span>' +
      '<span class="pm-sub">' + e.sub + '</span>' +
      '<span class="pm-meta">' + e.meta + '</span>' +
    '</button>'
  ).join('');

  menu.innerHTML =
    '<div class="pm-group-title">检测器</div>' + items +
    '<div class="preset-menu-sep"></div>' +
    '<div class="pm-group-title">表情模型</div>' + engineItems +
    '<div class="preset-menu-sep"></div>' +
    '<button type="button" class="preset-menu-more" id="presetMenuMore">查看说明与对比 ›</button>';

  // 表情引擎：选中态 + 点击切换
  menu.querySelectorAll('[data-engine]').forEach(b => {
    b.classList.toggle('is-active', b.getAttribute('data-engine') === curEngine);
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      await switchExpressionEngine(b.getAttribute('data-engine'), b);
    });
  });
  menu.querySelectorAll('.preset-menu-item').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await switchPresetFromMenu(btn.getAttribute('data-preset'), btn);
    });
  });
  const more = document.getElementById('presetMenuMore');
  if (more) more.addEventListener('click', (e) => {
    e.stopPropagation();
    closePresetMenu();
    openPresetModal();
  });

  syncPresetPicker();
}

/** 下拉里点某一档 */
async function switchPresetFromMenu(key, btnEl) {
  if (key === curSettings().detectPreset) { closePresetMenu(); return; }

  const menu = document.getElementById('presetMenu');
  if (menu) menu.querySelectorAll('.preset-menu-item').forEach(b => b.classList.add('is-busy'));
  if (btnEl) btnEl.classList.add('is-busy');

  const r = await applyDetectPreset(key);

  if (menu) menu.querySelectorAll('.preset-menu-item').forEach(b => b.classList.remove('is-busy'));
  if (btnEl) btnEl.classList.remove('is-busy');

  if (!r.ok) { syncPresetPicker(); return; }

  const next = Object.assign({}, activeSettings);
  next.detectPreset = key;
  applySettings(next);
  pushRemoteSettings();
  if (typeof renderDiagPanel === 'function') renderDiagPanel();
  closePresetMenu();
}

/** 切换表情引擎（内置 / 增强） */
async function switchExpressionEngine(key, btnEl) {
  if (key === (curSettings().expressionEngine || 'faceapi')) { closePresetMenu(); return; }

  if (key === 'ferplus') {
    /* 增强模型要下载约 28 MB（模型 18.4 + 运行时 10）。
       手机上原来是直接拒绝，但用户希望手机上也能用，改成：
         ① 告知体积，让使用者自己决定（检测到移动网络时额外提醒）
         ② 同意后加载，状态条显示进度
         ③ 摄像头模式会自动回落到快速模型（见 camera.js），这里不用管 */
    const needed = 28;
    const onCellular = (function () {
      const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (!c) return false;
      if (c.type === 'cellular') return true;
      return c.effectiveType === 'slow-2g' || c.effectiveType === '2g' || c.effectiveType === '3g';
    })();

    const narrow = window.matchMedia && window.matchMedia('(max-width: 760px)').matches;
    if (narrow) {
      const msg = '启用增强表情模型需要下载约 ' + needed + ' MB 数据' +
                  (onCellular ? '（检测到当前可能是移动网络）' : '') + '。\n\n' +
                  '建议在 WiFi 下进行。\n\n' +
                  '注意：摄像头模式会自动使用快速模型（增强模型帧率太低）。\n\n' +
                  '确定要下载吗？';
      if (!confirm(msg)) return;
    }

    if (btnEl) btnEl.classList.add('is-busy');
    setStatus('正在加载增强表情模型（约 ' + needed + ' MB，首次较慢）…', 'loading');

    const ok = await ensureEnhanceEngine();
    if (btnEl) btnEl.classList.remove('is-busy');
    if (!ok) {
      setStatus('增强表情模型加载失败，已保持快速表情模型。', 'error');
      syncPresetPicker();
      return;
    }
    setStatus('增强表情模型已就绪。', 'ok');
  }

  const next = Object.assign({}, activeSettings);
  next.expressionEngine = key;
  applySettings(next);
  pushRemoteSettings();
  if (typeof renderDiagPanel === 'function') renderDiagPanel();
  closePresetMenu();
}

/** 同步下拉按钮上的文字与选中态 */
function syncPresetPicker() {
  const cur = curSettings().detectPreset;
  const p = (typeof DETECT_PRESETS !== 'undefined' && DETECT_PRESETS[cur]) ? DETECT_PRESETS[cur] : null;
  const txt = document.getElementById('presetPickerTxt');
  const ico = document.getElementById('presetPickerIco');
  // 引擎是增强档时，在按钮上加个小标记，让人知道当前用的是哪个表情模型
  const useEnhance = (curSettings().expressionEngine === 'ferplus');
  if (txt) txt.textContent = (p ? p.name : '速度优先') + (useEnhance ? ' +增强' : '');
  if (ico) ico.textContent = PRESET_ICONS[cur] || '⚡';

  /* 只处理「检测器」那一组。表情引擎项的选中态单独处理 ——
     早先这里对所有 .preset-menu-item 都按 data-preset 判定，引擎项没有该属性
     就被算成"非选中"，把 renderPresetMenu 刚设好的 is-active 抹掉了（实测引擎永远无勾）。 */
  document.querySelectorAll('.preset-menu-item[data-preset]').forEach(b => {
    b.classList.toggle('is-active', b.getAttribute('data-preset') === cur);
  });

  const curEngine = curSettings().expressionEngine || 'faceapi';
  document.querySelectorAll('.preset-menu-item[data-engine]').forEach(b => {
    b.classList.toggle('is-active', b.getAttribute('data-engine') === curEngine);
  });

  const drawerTxt = document.getElementById('presetCurrentText');
  if (drawerTxt && p) drawerTxt.textContent = p.name;
}

function openPresetMenu() {
  const menu = document.getElementById('presetMenu');
  const btn = document.getElementById('presetPickerBtn');
  if (!menu || !btn) return;
  renderPresetMenu();
  menu.hidden = false;

  /* 定位策略（v1.9.2 修正）：
     手机上页头右侧还有三个按钮，用 absolute + right:0 会把菜单推到屏幕左边外面
     （实测 left = -162px）。所以窄屏改成 fixed，位置按按钮的矩形自己算，
     并且保证左右各留 12px 边距。

     桌面仍用 absolute（相对按钮右下角），因为空间充足。 */
  const isNarrow = window.matchMedia && window.matchMedia('(max-width: 760px)').matches;

  if (isNarrow) {
    const r = btn.getBoundingClientRect();
    const margin = 12;
    const width = Math.min(window.innerWidth - margin * 2, 340);

    menu.style.position = 'fixed';
    menu.style.width = width + 'px';
    menu.style.left = margin + 'px';
    menu.style.right = 'auto';

    // 垂直：默认贴按钮下方；下方放不下就往上翻
    const below = Math.round(r.bottom + 8);
    const estH = Math.min(menu.scrollHeight || 420, window.innerHeight - margin * 2);
    if (below + estH > window.innerHeight - margin) {
      const above = Math.round(r.top - 8 - estH);
      menu.style.top = Math.max(margin, above) + 'px';
    } else {
      menu.style.top = below + 'px';
    }
  } else {
    menu.style.position = '';
    menu.style.width = '';
    menu.style.left = '';
    menu.style.right = '';
    menu.style.top = '';
  }

  btn.setAttribute('aria-expanded', 'true');

  // 高度兜底：无论如何不超过可视区
  const rect = menu.getBoundingClientRect();
  if (rect.bottom > window.innerHeight - 8) {
    menu.style.maxHeight = Math.max(160, window.innerHeight - rect.top - 16) + 'px';
    menu.style.overflowY = 'auto';
  } else if (isNarrow) {
    menu.style.maxHeight = Math.min(rect.height, window.innerHeight - 24) + 'px';
    menu.style.overflowY = 'auto';
  } else {
    menu.style.maxHeight = '';
    menu.style.overflowY = '';
  }
}

function closePresetMenu() {
  const menu = document.getElementById('presetMenu');
  const btn = document.getElementById('presetPickerBtn');
  if (!menu || !btn || menu.hidden) return;
  menu.hidden = true;
  btn.setAttribute('aria-expanded', 'false');
  /* 清掉 openPresetMenu 设的内联定位，避免下次在别的尺寸下残留 */
  menu.style.position = '';
  menu.style.left = '';
  menu.style.right = '';
  menu.style.top = '';
  menu.style.width = '';
  menu.style.maxHeight = '';
  menu.style.overflowY = '';
}

function togglePresetMenu() {
  const menu = document.getElementById('presetMenu');
  if (!menu) return;
  if (menu.hidden) openPresetMenu(); else closePresetMenu();
}
/** 打开档位弹层 */
function openPresetModal() {
  const mask = document.getElementById('presetMask');
  const modal = document.getElementById('presetModal');
  if (!mask || !modal) return;
  mask.hidden = false;
  modal.hidden = false;
  requestAnimationFrame(() => { mask.classList.add('is-open'); modal.classList.add('is-open'); });
  modal.setAttribute('aria-hidden', 'false');
  /* 锁背景滚动：不锁的话页面滚动条还在，fixed 居中会偏「半个滚动条宽度」
     （实测 1280 宽偏 7px）。auth.js 里已有 lockPageScroll，直接复用。 */
  if (typeof lockPageScroll === 'function') lockPageScroll(true);
  syncPresetChips();
}

/** 关闭档位弹层 */
function closePresetModal() {
  const mask = document.getElementById('presetMask');
  const modal = document.getElementById('presetModal');
  if (!mask || !modal || modal.hidden) return;
  modal.classList.remove('is-open');
  mask.classList.remove('is-open');
  modal.classList.add('is-closing');
  mask.classList.add('is-closing');
  const done = () => {
    modal.classList.remove('is-closing');
    mask.classList.remove('is-closing');
    modal.hidden = true;
    mask.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    // 只有设置抽屉也关着时才解锁，否则抽屉还在下面
    const drawer = document.getElementById('settingsDrawer');
    const authOpen = document.getElementById('authPanel') && !document.getElementById('authPanel').hidden;
    const anaOpen = document.getElementById('anaModal') && !document.getElementById('anaModal').hidden;
    if (!authOpen && !anaOpen && typeof lockPageScroll === 'function') lockPageScroll(false);
  };
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) done(); else setTimeout(done, 200);
}
/** 检测器档位：更新选中态 */
function syncPresetChips() {
  if (typeof syncPresetPicker === 'function') syncPresetPicker();
  const cur = curSettings().detectPreset;
  document.querySelectorAll('.preset-chip').forEach(btn => {
    btn.classList.toggle('is-active', btn.getAttribute('data-preset') === cur);
  });
  // 设置抽屉里那行入口显示当前档位名
  const txt = document.getElementById('presetCurrentText');
  if (txt && typeof DETECT_PRESETS !== 'undefined' && DETECT_PRESETS[cur]) {
    txt.textContent = DETECT_PRESETS[cur].name;
  }
}

/** 绑定档位卡片的点击 */
function bindPresetChips() {
  document.querySelectorAll('.preset-chip').forEach(btn => {
    btn.addEventListener('click', async () => {
      const key = btn.getAttribute('data-preset');
      if (key === curSettings().detectPreset) return;

      document.querySelectorAll('.preset-chip').forEach(b => b.classList.add('is-busy'));
      const r = await applyDetectPreset(key);
      document.querySelectorAll('.preset-chip').forEach(b => b.classList.remove('is-busy'));

      if (!r.ok) { syncPresetChips(); return; }
      const next = Object.assign({}, activeSettings);
      next.detectPreset = key;
      applySettings(next);
      pushRemoteSettings();
      if (typeof renderDiagPanel === 'function') renderDiagPanel();
      closePresetModal();
    });
  });
}

/** 主题切换器：更新选中态 */
function syncThemeChips() {
  document.querySelectorAll('.theme-chip').forEach(btn => {
    btn.classList.toggle('is-active', btn.getAttribute('data-theme') === activeSettings.theme);
  });
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
  renderPresetChips();
  renderPresetMenu();
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
    ['setInterval', 'cameraInterval'],
      ['setSmooth', 'smoothAlpha'],
      ['setHysteresis', 'smoothHysteresis']
    ];
  bindings.forEach(([inputId, key]) => {
    const input = document.getElementById(inputId);
    if (!input) return;
    input.addEventListener('input', () => {
      const next = Object.assign({}, activeSettings);
      next[key] = input.value;
      applySettings(next);
      pushRemoteSettings();
            if ((key === 'smoothAlpha' || key === 'smoothHysteresis') && typeof resetSmoothing === 'function') resetSmoothing();
    });
  });

  // 主题切换
  document.querySelectorAll('.theme-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const next = Object.assign({}, activeSettings);
      next.theme = btn.getAttribute('data-theme');
      applySettings(next);
      pushRemoteSettings();
    });
  });

  // 三个直达入口：页头「分析」→ 诊断；表情信息区「阈值对比实验」→ 实验；设置 → 顶部
  // 档位弹层：设置抽屉里的入口 + 遮罩 + 关闭键
  const openPreset = document.getElementById('openPresetBtn');
  if (openPreset) openPreset.addEventListener('click', openPresetModal);
  const presetClose = document.getElementById('presetClose');
  if (presetClose) presetClose.addEventListener('click', closePresetModal);
  const presetMask = document.getElementById('presetMask');
  if (presetMask) presetMask.addEventListener('click', closePresetModal);
  document.addEventListener('keydown', e => {
    const m = document.getElementById('presetModal');
    if (e.key === 'Escape' && m && !m.hidden) { e.stopPropagation(); closePresetModal(); }
  }, true);
  /* 页头档位下拉：桌面和手机都启用。
     手机上有 CSS 收窄成只显示图标，但依然能点开切档（v1.9.1 起手机支持增强模型）。 */
  const pickerBtn = document.getElementById('presetPickerBtn');
  if (pickerBtn) pickerBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePresetMenu(); });
  document.addEventListener('click', (e) => {
    const picker = document.getElementById('presetPicker');
    if (picker && !picker.contains(e.target)) closePresetMenu();
  });
  document.addEventListener('keydown', (e) => {
    const m = document.getElementById('presetMenu');
    if (e.key === 'Escape' && m && !m.hidden) closePresetMenu();
  }, true);

  // 分析弹层：设置抽屉两个入口 + 页头「分析」按钮 + 表情区内联入口
  // 分析弹层：设置抽屉两个入口 + 页头「分析」按钮 + 表情区内联入口
  const od = document.getElementById('openDiagBtn');
  if (od) od.addEventListener('click', () => openAnaModal('diag'));
  const oe = document.getElementById('openExpBtn');
  if (oe) oe.addEventListener('click', () => openAnaModal('exp'));
  const ac = document.getElementById('anaClose');
  if (ac) ac.addEventListener('click', closeAnaModal);
  const am = document.getElementById('anaMask');
  if (am) am.addEventListener('click', closeAnaModal);
  const td = document.getElementById('tabDiag');
  if (td) td.addEventListener('click', () => setAnaTab('diag'));
  const te = document.getElementById('tabExp');
  if (te) te.addEventListener('click', () => setAnaTab('exp'));
  document.addEventListener('keydown', e => {
    const m = document.getElementById('anaModal');
    if (e.key === 'Escape' && m && !m.hidden) { e.stopPropagation(); closeAnaModal(); }
  }, true);

  const analyzeBtn = document.getElementById('analyzeBtn');
  if (analyzeBtn) analyzeBtn.addEventListener('click', () => openAnaModal('diag'));

  const infoExpBtn = document.getElementById('infoExpBtn');
  if (infoExpBtn) infoExpBtn.addEventListener('click', () => openAnaModal('exp'));


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

  /* ?debug=1 / ?cover=0 时**完全忽略已保存的设置**，一律用默认值。
     原因：自动化测试共用同一个浏览器 profile，上一套测试把阈值改到 0.66，
     下一套测试就会少检出人脸（跨照片套件 9 项失败就是这么来的）。
     调试模式本来就该"每次都是同一个起点"，顺手也把测试之间隔离开了。 */
  const q = new URLSearchParams(location.search);
  if (q.has('debug') || q.get('cover') === '0') {
    activeSettings = Object.assign({}, DEFAULT_SETTINGS);
    applyTheme(activeSettings.theme);
    syncDrawerUI();
    if (typeof onSettingsApplied === 'function') onSettingsApplied();
    return;
  }

  const local = readLocalSettings();
  if (local) activeSettings = local;

  // URL 里的分享设置优先级最高（用户是从别人那儿点进来的）
  const hadPreset = maybeApplyUrlPreset();

  if (!hadPreset) {
    const remote = await fetchRemoteSettings();
    if (remote) {
      /* 云端有记录就套用，但**要和本机合并**而不是整体替换：
         云端那条可能是旧版本存下的（比如还没有 theme 字段），
         直接替换会把本机已有的主题冲掉（实测刷新后主题丢失就是这个原因）。 */
      applySettings(Object.assign({}, local || {}, remote), { silent: true });
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
