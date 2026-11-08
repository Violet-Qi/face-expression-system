/* ============================================================
   report.js —— 匿名统计上报（管理台的数据来源）
   ------------------------------------------------------------
   上报什么：
     模式（图片/批量/摄像头/视频）、检出人脸数、各表情出现次数、
     处理耗时、素材时长、匿名随机 ID、时间戳。

   绝不上报什么：
     图片、视频、人脸框坐标、人脸特征向量、缩略图、任何可定位到人的东西。

   三条设计原则：
     1. **默认开启，但可关**：界面上有开关，关掉后一条都不发（记在 localStorage）
     2. **静默失败**：后端不在（比如只用 Python 起了静态服务）就直接不上报，
        绝不影响识别本身，也不弹窗打扰
     3. **先探活再上报**：启动时探一次 /api/health，探不到就把整个上报关掉，
        避免每次识别都发一个注定失败的请求
   ============================================================ */

const REPORT_ENABLED_KEY = 'dsh_report_enabled';
const REPORT_CLIENT_KEY  = 'dsh_client_id';

/* 默认开启：用户没表过态就当允许；显式关掉才是关 */
let reportEnabled = (function () {
  try {
    const v = localStorage.getItem(REPORT_ENABLED_KEY);
    return v === null ? true : v === '1';
  } catch (e) {
    return true;   // 隐私模式禁用 localStorage 时按默认处理
  }
})();

/* 后端是否可用：null = 还没探测过 */
let reportBackendOk = null;

/** 匿名客户端 ID：随便生成一串，只用来区分"不同浏览器"，不关联任何身份 */
function reportClientId() {
  try {
    let id = localStorage.getItem(REPORT_CLIENT_KEY);
    if (!id || !/^[A-Za-z0-9_-]{6,40}$/.test(id)) {
      const rnd = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID().replace(/-/g, '')
        : Math.random().toString(36).slice(2) + Date.now().toString(36);
      id = rnd.slice(0, 24);
      localStorage.setItem(REPORT_CLIENT_KEY, id);
    }
    return id;
  } catch (e) {
    return 'anon' + Math.random().toString(36).slice(2, 12);
  }
}

/** 设置开关并持久化 */
function setReportEnabled(on) {
  reportEnabled = !!on;
  try { localStorage.setItem(REPORT_ENABLED_KEY, reportEnabled ? '1' : '0'); } catch (e) { /* 忽略 */ }
}

/**
 * 探一次后端：能通才上报。
 * 只用 Python 起静态服务时会 404，这里就静默关掉上报。
 */
async function probeReportBackend() {
  if (location.protocol === 'file:') { reportBackendOk = false; return false; }
  try {
    const res = await fetch('api/health', { method: 'GET', cache: 'no-store' });
    if (!res.ok) { reportBackendOk = false; return false; }
    const j = await res.json();
    reportBackendOk = !!(j && j.ok);
  } catch (e) {
    reportBackendOk = false;
  }
  return reportBackendOk;
}

/**
 * 上报一次会话。fire-and-forget：不 await、不抛错、不阻塞识别。
 *
 * @param {string} kind  image | batch | camera | video
 * @param {object} payload { faces, top, topVal, costMs, durMs, expr:{name:count} }
 */
function reportSession(kind, payload) {
  if (!reportEnabled) return;
  if (reportBackendOk !== true) return;      // 没探到后端就别发
  const p = payload || {};

  const body = JSON.stringify({
    kind: kind,
    faces: Math.max(0, Number(p.faces) || 0),
    top: p.top || null,
    topVal: (p.topVal === undefined || p.topVal === null) ? null : Number(p.topVal),
    costMs: p.costMs == null ? null : Math.round(p.costMs),
    durMs: p.durMs == null ? null : Math.round(p.durMs),
    expr: p.expr || {},
    client: reportClientId()
  });

  try {
    // 保持请求存活，页面关掉也不会丢（现代浏览器支持 keepalive）
    fetch('api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
      keepalive: body.length < 60000
    }).catch(() => { /* 静默 */ });
  } catch (e) { /* 静默 */ }
}

/** 把一组识别结果汇总成上报用的计数 */
function summarizeResults(results) {
  const out = { faces: 0, expr: {}, top: null, topVal: null };
  if (!results || !results.length) return out;
  out.faces = results.length;

  let bestVal = -1;
  results.forEach(res => {
    const t = topExpression(res.expressions);
    out.expr[t.name] = (out.expr[t.name] || 0) + 1;
    if (t.value > bestVal) { bestVal = t.value; out.top = t.name; out.topVal = t.value; }
  });
  return out;
}

/** 把"多帧累计"的计数合成一次上报 */
function mergeSummaries(list) {
  const out = { faces: 0, expr: {}, top: null, topVal: null };
  list.forEach(s => {
    out.faces += s.faces || 0;
    Object.keys(s.expr || {}).forEach(k => { out.expr[k] = (out.expr[k] || 0) + s.expr[k]; });
    if (s.topVal != null && s.topVal > (out.topVal == null ? -1 : out.topVal)) {
      out.top = s.top; out.topVal = s.topVal;
    }
  });
  return out;
}
