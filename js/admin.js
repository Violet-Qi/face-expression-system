/* ============================================================
   admin.js —— 管理台前端
   ------------------------------------------------------------
   刻意**不依赖主站任何 JS**：主站那套是给识别用的（要 face-api），
   管理台只需要 fetch + 一点 canvas 画图，独立到底。

   后端接口（见 server-app.js）：
     POST /api/login         登录（下发 HttpOnly Cookie）
     POST /api/logout        退出
     GET  /api/me            当前用户
     GET  /api/stats?days=7  汇总统计
     GET  /api/sessions      会话明细（分页/筛选）
     GET  /api/export.csv    导出
     DELETE /api/sessions    清空
     POST /api/password      改密
   ============================================================ */

const $ = id => document.getElementById(id);

const EXPR_CN = {
  neutral: '中性', happy: '高兴', sad: '悲伤', angry: '愤怒',
  fearful: '恐惧', disgusted: '厌恶', surprised: '惊讶'
};
const EXPR_COLOR = {
  neutral: '#8a94a0', happy: '#ec6a0c', sad: '#5b6b7c', angry: '#c0392b',
  fearful: '#7a5cd6', disgusted: '#3f9c35', surprised: '#3a7bd5'
};
const KIND_CN = { image: '图片识别', batch: '批量识别', camera: '摄像头实时', video: '视频文件' };

const state = { page: 1, size: 20, total: 0, kind: '' };

/* ---------------- 小工具 ---------------- */
function msg(text, kind) {
  const el = $('adminMsg');
  el.textContent = text || '';
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

async function api(path, options) {
  const res = await fetch(path, Object.assign({ credentials: 'same-origin' }, options || {}));
  let body = null;
  try { body = await res.json(); } catch (e) { /* 可能是空响应 */ }
  if (res.status === 401) {
    showLogin('登录已失效，请重新登录。');
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error((body && body.error) || ('HTTP ' + res.status));
  return body;
}

function fmtTime(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------------- 登录 / 退出 ---------------- */
function showLogin(text) {
  $('loginBox').hidden = false;
  $('adminBox').hidden = true;
  if (text) { $('loginMsg').textContent = text; $('loginMsg').className = 'msg err'; }
}

async function showAdmin(user) {
  $('loginBox').hidden = true;
  $('adminBox').hidden = false;
  $('whoami').textContent = '当前用户：' + (user || 'admin');
  state.page = 1;
  await refreshAll();
}

$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('loginBtn');
  const m = $('loginMsg');
  btn.disabled = true;
  m.textContent = '';
  m.className = 'msg';
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ user: $('loginUser').value.trim(), pass: $('loginPass').value })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
    $('loginPass').value = '';
    await showAdmin(j.user);
  } catch (err) {
    m.textContent = '登录失败：' + err.message;
    m.className = 'msg err';
  } finally {
    btn.disabled = false;
  }
});

$('logoutBtn').addEventListener('click', async () => {
  try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } catch (e) { /* 忽略 */ }
  showLogin('已退出。');
});

$('pwdBtn').addEventListener('click', async () => {
  const oldPass = prompt('请输入当前密码：');
  if (oldPass === null) return;
  const newPass = prompt('请输入新密码（至少 6 位）：');
  if (newPass === null) return;
  try {
    await api('/api/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPass, newPass })
    });
    msg('密码已修改，请记住新密码。', 'ok');
  } catch (err) {
    if (err.message !== 'unauthorized') msg('改密码失败：' + err.message, 'err');
  }
});

/* ---------------- 数据刷新 ---------------- */
async function refreshAll() {
  await Promise.all([loadStats(), loadList(), loadUsers(), loadCompare()]);
}

async function loadStats() {
  let d;
  try {
    d = await api('/api/stats?days=7');
  } catch (err) {
    if (err.message !== 'unauthorized') msg('读取统计失败：' + err.message, 'err');
    return;
  }

  $('kpiSessions').textContent = d.totals.sessions;
  $('kpiFaces').textContent = d.totals.faces;
  $('kpiCost').innerHTML = (d.avgCostMs == null ? '—' : d.avgCostMs) + '<span class="u">ms</span>';

  const topExpr = (d.byExpr && d.byExpr[0]) || null;
  $('kpiTop').textContent = topExpr ? (EXPR_CN[topExpr.name] || topExpr.name) : '—';
  $('kpiAll').textContent = d.allTimes ? (d.allTimes.sessions + ' 场 · ' + d.allTimes.faces + ' 张脸') : '—';

  renderExprBars(d.byExpr || []);
  renderKindTable(d.byKind || []);
  renderDayChart(d.byDay || []);
}

function renderExprBars(rows) {
  const box = $('exprBars');
  if (!rows.length) { box.innerHTML = '<div class="empty">暂无数据</div>'; return; }
  const max = Math.max(...rows.map(r => r.count), 1);
  const total = rows.reduce((s, r) => s + r.count, 0) || 1;

  box.innerHTML = rows.map(r => {
    const pct = (r.count / max * 100).toFixed(1);
    const share = (r.count / total * 100).toFixed(1);
    const cn = EXPR_CN[r.name] || r.name;
    const color = EXPR_COLOR[r.name] || '#8a94a0';
    return `<div class="bar-row">
      <span class="label">${cn}</span>
      <span class="track"><i style="width:${pct}%;background:${color}"></i></span>
      <span class="num">${r.count} 次（${share}%）</span>
    </div>`;
  }).join('');
}

function renderKindTable(rows) {
  const body = $('kindBody');
  if (!rows.length) { body.innerHTML = '<tr><td colspan="3" class="empty">暂无数据</td></tr>'; return; }
  body.innerHTML = rows.map(r => `<tr>
      <td><span class="kind-chip" style="background:${r.kind === 'video' ? '#7a5cd6' : r.kind === 'camera' ? '#3a7bd5' : r.kind === 'batch' ? '#3f9c35' : '#8a94a0'}">${KIND_CN[r.kind] || r.kind}</span></td>
      <td>${r.sessions}</td>
      <td>${r.faces}</td>
    </tr>`).join('');
}

/**
 * 按天柱状图：数据一般只有几天，用柱子比折线直观。
 *
 * 关键点：canvas 不能再写死 width="1120"。
 * 那个尺寸会被 CSS 的 width:100% 缩到屏幕宽度，手机上等于缩小 2.7 倍，
 * 纵轴刻度数字直接糊掉。正确做法是按"显示宽度 × 设备像素比"设置画布，
 * 再用 setTransform 把坐标系缩回 CSS 像素，这样画出来永远是清晰的。
 */
let lastDayRows = [];        // 留一份数据，窗口尺寸变化时重画用

function renderDayChart(rows) {
  lastDayRows = rows || [];
  const cv = $('dayChart');
  const ctx = cv.getContext('2d');

  // 逻辑尺寸 = CSS 显示尺寸；物理尺寸 = 逻辑尺寸 × DPR
  const cssW = Math.max(240, Math.round(cv.getBoundingClientRect().width || 1120));
  const cssH = 180;
  const dpr = window.devicePixelRatio || 1;
  const needW = Math.round(cssW * dpr);
  const needH = Math.round(cssH * dpr);
  if (cv.width !== needW || cv.height !== needH) {
    cv.width = needW;
    cv.height = needH;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // 之后一律按 CSS 像素作图
  ctx.clearRect(0, 0, cssW, cssH);

  const W = cssW, H = cssH;

  if (!rows.length) {
    ctx.fillStyle = '#8a94a0';
    ctx.font = '13px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('暂无数据', W / 2, H / 2);
    return;
  }

  const padL = 44, padR = 12, padT = 14, padB = 34;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const max = Math.max(...rows.map(r => r.sessions), 1);

  // 网格线 + 纵轴刻度
  // 注意：会话数一般很小（比如最大才 1），如果固定分 4 段再取整，
  // 刻度会变成 1/1/1/0/0 这种重复值。所以段数按最大值收敛，保证刻度不重复。
  ctx.strokeStyle = '#eceff3';
  ctx.fillStyle = '#8a94a0';
  ctx.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const steps = Math.min(4, Math.max(1, max));
  for (let i = 0; i <= steps; i++) {
    const y = padT + plotH - plotH * i / steps;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.fillText(String(Math.round(max * i / steps)), padL - 8, y);
  }

  const n = rows.length;
  const slot = plotW / n;
  const barW = Math.max(6, Math.min(46, slot * 0.55));

  rows.forEach((r, i) => {
    const h = plotH * (r.sessions / max);
    const x = padL + slot * i + (slot - barW) / 2;
    const y = padT + plotH - h;

    const grad = ctx.createLinearGradient(0, y, 0, padT + plotH);
    grad.addColorStop(0, '#ec6a0c');
    grad.addColorStop(1, '#f7a35c');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, barW, h);

    // 柱顶数值
    ctx.fillStyle = '#6b7684';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(String(r.sessions), x + barW / 2, y - 3);

    // 横轴日期（只显示 月-日）
    ctx.fillStyle = '#8a94a0';
    ctx.textBaseline = 'top';
    ctx.fillText(String(r.day).slice(5), x + barW / 2, padT + plotH + 8);
  });
}

/* ---------------- 明细列表 ---------------- */
async function loadList() {
  const q = new URLSearchParams({ page: state.page, size: state.size });
  if (state.kind) q.set('kind', state.kind);

  let d;
  try {
    d = await api('/api/sessions?' + q.toString());
  } catch (err) {
    if (err.message !== 'unauthorized') msg('读取明细失败：' + err.message, 'err');
    return;
  }

  state.total = d.total;
  const pages = Math.max(1, Math.ceil(d.total / state.size));
  if (state.page > pages) { state.page = pages; return loadList(); }

  $('pageInfo').textContent = `第 ${state.page} / ${pages} 页　共 ${d.total} 条`;
  $('prevBtn').disabled = state.page <= 1;
  $('nextBtn').disabled = state.page >= pages;
  $('listHint').textContent = d.total ? `共 ${d.total} 条` : '';

  const body = $('listBody');
  if (!d.rows.length) {
    body.innerHTML = '<tr><td colspan="9" class="empty">暂无数据<br><span style="font-size:12px">在主页面做一次识别，数据就会出现在这里</span></td></tr>';
    return;
  }

  body.innerHTML = d.rows.map(r => {
    const expr = (r.expr || []).map(x => `${EXPR_CN[x.name] || x.name}×${x.count}`).join('　');
    const kindCn = KIND_CN[r.kind] || r.kind;
    const topCn = r.top ? (EXPR_CN[r.top] || r.top) : '—';
    const conf = (r.top_val == null) ? '—' : (r.top_val * 100).toFixed(1) + '%';
    const cost = (r.cost_ms == null) ? '—' : r.cost_ms + ' ms';
    const userCn = r.username || '游客';
    return `<tr>
      <td>${r.id}</td>
      <td>${userCn === '游客' ? '<span class="tag">游客</span>' : '<b>' + esc(userCn) + '</b>'}</td>
      <td>${fmtTime(r.at)}</td>
      <td>${kindCn}</td>
      <td>${r.faces}</td>
      <td>${topCn}</td>
      <td>${conf}</td>
      <td>${cost}</td>
      <td class="expr-cell">${expr || '—'}</td>
    </tr>`;
  }).join('');
}

/* ---------------- 交互 ---------------- */
$('refreshBtn').addEventListener('click', () => {
  msg('已刷新。', 'ok');
  refreshAll();
});

$('kindFilter').addEventListener('change', e => {
  state.kind = e.target.value;
  state.page = 1;
  loadList();
});

$('prevBtn').addEventListener('click', () => {
  if (state.page > 1) { state.page--; loadList(); }
});

$('nextBtn').addEventListener('click', () => {
  const pages = Math.max(1, Math.ceil(state.total / state.size));
  if (state.page < pages) { state.page++; loadList(); }
});

$('exportBtn').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/export.csv', { credentials: 'same-origin' });
    if (res.status === 401) { showLogin('登录已失效，请重新登录。'); return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'expression-sessions.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    msg('已导出 CSV。', 'ok');
  } catch (err) {
    msg('导出失败：' + err.message, 'err');
  }
});

$('clearBtn').addEventListener('click', async () => {
  if (!confirm('确定清空全部统计数据吗？此操作不可撤销。')) return;
  try {
    await api('/api/sessions', { method: 'DELETE' });
    state.page = 1;
    msg('数据已清空。', 'ok');
    await refreshAll();
  } catch (err) {
    if (err.message !== 'unauthorized') msg('清空失败：' + err.message, 'err');
  }
});

// 窗口尺寸变化时重画柱状图（手机上转屏很常见，不重画会糊/拉伸）
let dayResizeTimer = null;
/* ============================================================
   用户管理（v1.7.0）
   ============================================================ */

function fmtDate(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

const STATUS_CN = { active: '启用', disabled: '停用', guest: '游客' };

async function loadUsers() {
  const body = $('userBody');
  let d;
  try { d = await api('/api/users?days=30'); }
  catch (e) { body.innerHTML = '<tr><td colspan="9" class="empty">加载失败：' + esc(e.message) + '</td></tr>'; return; }

  const rows = (d.users || []).map(u => {
    const st = STATUS_CN[u.status] || u.status;
    return '<tr>'
      + '<td>' + u.id + '</td>'
      + '<td><b>' + esc(u.username) + '</b></td>'
      + '<td>' + esc(u.email || '—') + '</td>'
      + '<td><span class="tag ' + (u.status === 'active' ? 'tag-ok' : 'tag-off') + '">' + st + '</span></td>'
      + '<td>' + u.sessions + '</td>'
      + '<td>' + u.faces + '</td>'
      + '<td>' + fmtDate(u.last_login_at) + '</td>'
      + '<td>'
      +   '<button type="button" class="btn btn-mini" data-act="detail" data-id="' + u.id + '">详情</button>'
      +   '<button type="button" class="btn btn-mini" data-act="pwd" data-id="' + u.id + '" data-name="' + esc(u.username) + '">改密</button>'
      +   '<button type="button" class="btn btn-mini" data-act="toggle" data-id="' + u.id + '" data-status="' + u.status + '">' + (u.status === 'active' ? '停用' : '启用') + '</button>'
      +   '<button type="button" class="btn btn-mini btn-danger" data-act="del" data-id="' + u.id + '" data-name="' + esc(u.username) + '">删除</button>'
      + '</td>'
      + '</tr>';
  });

  // 游客单独一行（不能删、不能停用，只能看详情）
  if (d.guest) {
    rows.push('<tr class="row-guest">'
      + '<td>—</td>'
      + '<td><b>游客</b> <span class="tag">未登录</span></td>'
      + '<td>—</td>'
      + '<td>' + STATUS_CN.guest + '</td>'
      + '<td>' + d.guest.sessions + '</td>'
      + '<td>' + d.guest.faces + '</td>'
      + '<td>—</td>'
      + '<td><button type="button" class="btn btn-mini" data-act="detail" data-id="guest">详情</button></td>'
      + '</tr>');
  }

  body.innerHTML = rows.length ? rows.join('') : '<tr><td colspan="9" class="empty">还没有注册用户</td></tr>';
  const hint = $('userHint');
  if (hint) hint.textContent = '共 ' + (d.users || []).length + ' 个注册用户 + 游客 · 近 ' + d.days + ' 天';
}

async function loadCompare() {
  const body = $('compareBody');
  let d;
  try { d = await api('/api/users/compare?days=30'); }
  catch (e) { body.innerHTML = '<tr><td colspan="6" class="empty">加载失败：' + esc(e.message) + '</td></tr>'; return; }

  const rows = (d.data || []).map(r => '<tr>'
    + '<td><b>' + esc(r.username) + '</b></td>'
    + '<td>' + r.sessions + '</td>'
    + '<td>' + r.faces + '</td>'
    + '<td>' + (r.avgCost ? r.avgCost + ' ms' : '—') + '</td>'
    + '<td>' + (r.top ? (EXPR_CN[r.top] || r.top) + ' <span class="hint">×' + r.topCount + '</span>' : '—') + '</td>'
    + '<td>' + fmtDate(r.lastAt) + '</td>'
    + '</tr>');
  body.innerHTML = rows.length ? rows.join('') : '<tr><td colspan="6" class="empty">暂无数据</td></tr>';
}

async function loadUserDetail(id) {
  const panel = $('userDetailPanel');
  let d;
  try { d = await api('/api/users/detail?id=' + encodeURIComponent(id) + '&days=30'); }
  catch (e) { msg('加载详情失败：' + e.message, 'err'); return; }

  panel.hidden = false;
  $('udTitle').textContent = '用户详情 · ' + (d.user.username || '游客');
  $('udSessions').textContent = (d.totals && d.totals.sessions) || 0;
  $('udFaces').textContent = (d.totals && d.totals.faces) || 0;
  const c = d.totals && d.totals.avgCost ? Math.round(d.totals.avgCost) : 0;
  $('udCost').innerHTML = (c || '—') + '<span class="u">ms</span>';

  const rows = (d.byDay || []).map(r => '<tr><td>' + r.day + '</td><td>' + r.sessions + '</td><td>' + r.faces + '</td></tr>');
  $('udDayBody').innerHTML = rows.length ? rows.join('') : '<tr><td colspan="3" class="empty">该用户暂无数据</td></tr>';
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* 表格里的按钮统一事件委托 */
document.addEventListener('click', async e => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.getAttribute('data-act');
  const id = btn.getAttribute('data-id');

  if (act === 'detail') return loadUserDetail(id);

  if (act === 'toggle') {
    const cur = btn.getAttribute('data-status');
    const next = cur === 'active' ? 'disabled' : 'active';
    try {
      await api('/api/users/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: Number(id), status: next })
      });
      msg(next === 'active' ? '已启用' : '已停用', 'ok');
      loadUsers();
    } catch (err) { msg('操作失败：' + err.message, 'err'); }
    return;
  }

  if (act === 'pwd') {
    const name = btn.getAttribute('data-name') || ('id=' + id);
    const np = prompt('给「' + name + '」设置新密码（6~64 位）：\n\n留空则取消。');
    if (np === null) return;                    // 点了取消
    if (np.length < 6 || np.length > 64) { msg('新密码需 6~64 位', 'err'); return; }
    try {
      const r = await api('/api/users/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: Number(id), password: np })
      });
      msg('已重置「' + (r && r.username ? r.username : name) + '」的密码', 'ok');
    } catch (err) { msg('重置失败：' + err.message, 'err'); }
    return;
  }

  if (act === 'del') {
    const name = btn.getAttribute('data-name') || id;
    if (!confirm('确定删除用户「' + name + '」？\n\n该用户的统计记录会转为游客数据保留，不会丢失。')) return;
    try {
      await api('/api/users?id=' + encodeURIComponent(id), { method: 'DELETE' });
      msg('已删除，统计已转为游客', 'ok');
      loadUsers(); loadCompare();
    } catch (err) { msg('删除失败：' + err.message, 'err'); }
    return;
  }
});

if ($('addUserBtn')) {
  $('addUserBtn').addEventListener('click', async () => {
    const username = ($('newUserName').value || '').trim();
    const email = ($('newUserEmail').value || '').trim();
    const password = $('newUserPass').value || '';
    if (!username || !email || !password) { msg('用户名、邮箱、密码都要填', 'err'); return; }
    try {
      await api('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, email, password })
      });
      msg('已创建用户 ' + username, 'ok');
      $('newUserName').value = ''; $('newUserEmail').value = ''; $('newUserPass').value = '';
      loadUsers(); loadCompare();
    } catch (err) { msg('创建失败：' + err.message, 'err'); }
  });
}
if ($('refreshUsersBtn')) $('refreshUsersBtn').addEventListener('click', () => { loadUsers(); loadCompare(); });
if ($('udClose')) $('udClose').addEventListener('click', () => { $('userDetailPanel').hidden = true; });

window.addEventListener('resize', () => {
  if (dayResizeTimer) clearTimeout(dayResizeTimer);
  dayResizeTimer = setTimeout(() => renderDayChart(lastDayRows), 200);
});

/* ---------------- 启动：先看有没有登录 ---------------- */
(async () => {
  try {
    const me = await fetch('/api/me', { credentials: 'same-origin' });
    if (me.ok) {
      const j = await me.json();
      await showAdmin(j.user);
    } else {
      showLogin('');
    }
  } catch (err) {
    showLogin('连不上后端服务。请用「启动.bat」启动（需要 Node），而不是只开静态服务。');
  }
})();

/* ---------------- 水波点击反馈 ---------------- */
(function bootRipple() {
  if (typeof initRipple !== 'function') return;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initRipple, { once: true });
  } else {
    initRipple();
  }
})();