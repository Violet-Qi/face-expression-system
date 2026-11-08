/* ============================================================
   基于Web平台的人脸表情识别系统 —— 应用服务器（静态资源 + 管理后台 API）
   ------------------------------------------------------------
   为什么要这个文件：
     · 原来的 server.js 只发静态文件，没有后端，管理台就无从谈起
     · 这里在同一个端口上同时提供「静态页面」和「/api/*」接口，
       同源部署，前端不用处理跨域，也方便以后套 HTTPS

   技术选择（重要）：
     · **零第三方依赖** —— 只用 Node 内置模块：
         node:http / node:sqlite / node:crypto / node:fs
     · 数据库用 Node 24 内置的 SQLite（node:sqlite），不需要装任何东西
     · 这样在网络受限的机器上也能直接跑，也便于说明

   隐私边界（本项目最重要的一条）：
     · 只接收**匿名的计数统计**：模式、人脸数、各表情出现次数、耗时、时间戳
     · **绝不接收**图片、视频、人脸框、人脸特征向量、缩略图
     · 前端可以不开启上报（界面上有开关），关掉后一条数据都不会进来

   用法：
     node server-app.js [端口]        默认 8000
     node server-app.js --reset-admin 重置管理员密码为 admin123
     node server-app.js --stats       命令行打印一次统计后退出

   说明：控制台提示一律用英文。Node 输出的是 UTF-8 字节，
         中文控制台默认 GBK(936)，直接打中文会乱码。
   ============================================================ */

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

/* ---------------- 基本配置 ---------------- */
const PORT      = (process.argv[2] && /^\d+$/.test(process.argv[2])) ? Number(process.argv[2]) : 8000;
const ROOT      = __dirname;
const DATA_DIR  = path.join(ROOT, 'data');
const DB_FILE   = path.join(DATA_DIR, 'app.db');
const AUTH_FILE = path.join(DATA_DIR, 'admin.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.json');
const VERSION   = '1.0.0';

const DEFAULT_ADMIN_USER = 'admin';
const DEFAULT_ADMIN_PASS = 'admin123';   // 首次启动写入；请在管理台里改掉
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;   // 登录有效期 8 小时
const MAX_BODY = 64 * 1024;                  // 上报/登录体上限 64KB

/* ---------------- 工具 ---------------- */
function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function writeJSON(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

/** scrypt 加盐哈希，返回 hex；用于管理员口令，不存明文 */
function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const key  = crypto.scryptSync(String(password), salt, 32);
  return { salt: salt.toString('hex'), hash: key.toString('hex') };
}

function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a), 'hex');
  const bb = Buffer.from(String(b), 'hex');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/* ---------------- 数据目录与会话密钥 ---------------- */
ensureDir(DATA_DIR);

let secretKey;
{
  const s = readJSON(SECRET_FILE, null);
  if (s && typeof s.key === 'string' && s.key.length >= 32) {
    secretKey = Buffer.from(s.key, 'hex');
  } else {
    secretKey = crypto.randomBytes(32);
    writeJSON(SECRET_FILE, { key: secretKey.toString('hex'), createdAt: Date.now() });
  }
}

/* ---------------- 管理员账户 ---------------- */
function initAdmin(force) {
  const cur = readJSON(AUTH_FILE, null);
  if (cur && !force) return cur;
  const { salt, hash } = hashPassword(DEFAULT_ADMIN_PASS);
  const rec = { user: DEFAULT_ADMIN_USER, salt, hash, createdAt: Date.now() };
  writeJSON(AUTH_FILE, rec);
  return rec;
}
const adminAccount = initAdmin(process.argv.includes('--reset-admin'));

/* ---------------- 数据库 ---------------- */
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

/* 一次分析会话（一行 = 一次上报）。
   注意这里**没有**图片、没有人脸特征，只有计数与时间。 */
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    at      INTEGER NOT NULL,              -- 上报时刻（毫秒时间戳）
    kind    TEXT    NOT NULL,              -- image / batch / camera / video
    faces   INTEGER NOT NULL DEFAULT 0,    -- 检出人脸总数
    top     TEXT,                          -- 主导表情（英文键）
    top_val REAL,                          -- 主导表情置信度（0~1）
    cost_ms INTEGER,                       -- 处理耗时（毫秒）
    dur_ms  INTEGER,                       -- 素材时长（视频/摄像头），毫秒
    client  TEXT                           -- 匿名随机 ID（前端生成，可清）
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_at ON sessions(at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_kind ON sessions(kind)');

/* 表情明细：一行 = 某次会话里某个表情被计了几次 */
db.exec(`
  CREATE TABLE IF NOT EXISTS expr_items (
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    name       TEXT    NOT NULL,
    count      INTEGER NOT NULL DEFAULT 0
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_items_session ON expr_items(session_id)');

/* 统计表里用到的合法表情键（与前端 EXPR_CN 对齐） */
const EXPR_KEYS = ['neutral', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised'];
const KINDS = ['image', 'batch', 'camera', 'video'];

/* ---------------- 登录会话（HMAC 签名 Cookie，无状态） ---------------- */
function sign(payloadB64) {
  return crypto.createHmac('sha256', secretKey).update(payloadB64).digest('hex').slice(0, 40);
}

function makeToken(user) {
  const payload = JSON.stringify({ u: user, exp: Date.now() + SESSION_TTL_MS });
  const b64 = Buffer.from(payload, 'utf8').toString('base64url');
  return b64 + '.' + sign(b64);
}

function verifyToken(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [b64, sig] = token.split('.');
  if (sign(b64) !== sig) return null;
  try {
    const p = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    if (!p || !p.exp || p.exp < Date.now()) return null;
    return p;
  } catch (e) {
    return null;
  }
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function getAdmin(req) {
  const c = parseCookies(req);
  const p = verifyToken(c.dsh_admin);
  if (!p || p.u !== adminAccount.user) return null;
  return p;
}

/* ---------------- 登录失败限流（内存，防暴力猜） ---------------- */
const loginFails = new Map();   // ip -> { count, firstAt }
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAIL  = 10;

function loginBlocked(ip) {
  const rec = loginFails.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.firstAt > LOGIN_WINDOW_MS) { loginFails.delete(ip); return false; }
  return rec.count >= LOGIN_MAX_FAIL;
}

function noteLoginFail(ip) {
  const rec = loginFails.get(ip);
  if (!rec || Date.now() - rec.firstAt > LOGIN_WINDOW_MS) loginFails.set(ip, { count: 1, firstAt: Date.now() });
  else rec.count++;
}

/* ---------------- HTTP 小工具 ---------------- */
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket.remoteAddress || 'unknown';
}

/* ---------------- API 实现 ---------------- */

/** 上报一次匿名统计 */
async function apiReport(req, res) {
  const body = await readBody(req);

  const kind = String(body.kind || '').toLowerCase();
  if (KINDS.indexOf(kind) < 0) return sendJSON(res, 400, { ok: false, error: 'bad kind' });

  const faces = Math.max(0, Math.min(100000, Number(body.faces) || 0));
  const top   = EXPR_KEYS.indexOf(body.top) >= 0 ? body.top : null;
  const topVal = Number.isFinite(Number(body.topVal)) ? Math.max(0, Math.min(1, Number(body.topVal))) : null;
  const costMs = Number.isFinite(Number(body.costMs)) ? Math.max(0, Math.round(Number(body.costMs))) : null;
  const durMs  = Number.isFinite(Number(body.durMs))  ? Math.max(0, Math.round(Number(body.durMs)))  : null;
  const client = /^[A-Za-z0-9_-]{6,40}$/.test(String(body.client || '')) ? String(body.client) : null;

  // 表情明细：只接受白名单键、非负整数
  const expr = {};
  if (body.expr && typeof body.expr === 'object') {
    EXPR_KEYS.forEach(k => {
      const v = Number(body.expr[k]);
      if (Number.isFinite(v) && v > 0) expr[k] = Math.min(100000, Math.round(v));
    });
  }
  if (!faces && !Object.keys(expr).length) {
    // 没有人脸的会话（比如空画面）也允许记一笔，但至少要有一个有效字段
    if (!top && !costMs && !durMs) return sendJSON(res, 400, { ok: false, error: 'empty report' });
  }

  const at = Date.now();
  const insSession = db.prepare(
    'INSERT INTO sessions (at, kind, faces, top, top_val, cost_ms, dur_ms, client) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const r = insSession.run(at, kind, faces, top, topVal, costMs, durMs, client);
  const sid = Number(r.lastInsertRowid);

  const insItem = db.prepare('INSERT INTO expr_items (session_id, name, count) VALUES (?, ?, ?)');
  Object.keys(expr).forEach(k => insItem.run(sid, k, expr[k]));

  return sendJSON(res, 200, { ok: true, id: sid });
}

/** 汇总统计 */
function apiStats(req, res, url) {
  const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days')) || 7));
  const since = Date.now() - days * 24 * 3600 * 1000;

  const totals = db.prepare(
    'SELECT COUNT(*) AS sessions, COALESCE(SUM(faces),0) AS faces FROM sessions WHERE at >= ?'
  ).get(since);

  const byKind = db.prepare(
    'SELECT kind, COUNT(*) AS sessions, COALESCE(SUM(faces),0) AS faces FROM sessions WHERE at >= ? GROUP BY kind ORDER BY sessions DESC'
  ).all(since);

  const byExpr = db.prepare(
    `SELECT i.name AS name, SUM(i.count) AS count
       FROM expr_items i JOIN sessions s ON s.id = i.session_id
      WHERE s.at >= ?
      GROUP BY i.name ORDER BY count DESC`
  ).all(since);

  const byDay = db.prepare(
    `SELECT date(at/1000, 'unixepoch', 'localtime') AS day,
            COUNT(*) AS sessions, COALESCE(SUM(faces),0) AS faces
       FROM sessions WHERE at >= ?
      GROUP BY day ORDER BY day`
  ).all(since);

  const avg = db.prepare(
    'SELECT AVG(cost_ms) AS avg_cost FROM sessions WHERE at >= ? AND cost_ms IS NOT NULL'
  ).get(since);

  return sendJSON(res, 200, {
    ok: true, days,
    totals: { sessions: totals.sessions || 0, faces: totals.faces || 0 },
    avgCostMs: avg && avg.avg_cost ? Math.round(avg.avg_cost) : null,
    byKind, byExpr, byDay,
    allTimes: db.prepare('SELECT COUNT(*) AS sessions, COALESCE(SUM(faces),0) AS faces FROM sessions').get()
  });
}

/** 会话明细（分页） */
function apiSessions(req, res, url) {
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const size = Math.max(1, Math.min(100, Number(url.searchParams.get('size')) || 20));
  const kind = url.searchParams.get('kind');
  const offset = (page - 1) * size;

  const where = (kind && KINDS.indexOf(kind) >= 0) ? 'WHERE kind = ?' : '';
  const args = where ? [kind] : [];

  const total = db.prepare('SELECT COUNT(*) AS c FROM sessions ' + where).get(...args).c;

  const rows = db.prepare(
    'SELECT id, at, kind, faces, top, top_val, cost_ms, dur_ms FROM sessions ' + where +
    ' ORDER BY id DESC LIMIT ? OFFSET ?'
  ).all(...args, size, offset);

  // 把每条会话的表情明细一并带出来
  const itemStmt = db.prepare('SELECT name, count FROM expr_items WHERE session_id = ? ORDER BY count DESC');
  rows.forEach(r => { r.expr = itemStmt.all(r.id); });

  return sendJSON(res, 200, { ok: true, page, size, total, rows });
}

/** 导出 CSV（带 UTF-8 BOM，Excel 直接打开不乱码） */
function apiExportCsv(req, res) {
  const rows = db.prepare(
    'SELECT id, at, kind, faces, top, top_val, cost_ms, dur_ms FROM sessions ORDER BY id'
  ).all();
  const itemStmt = db.prepare('SELECT name, count FROM expr_items WHERE session_id = ?');

  const esc = v => {
    const s = (v === null || v === undefined) ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = ['序号,时间,模式,人脸数,主导表情,置信度,耗时(毫秒),时长(毫秒),表情明细'];
  rows.forEach(r => {
    const items = itemStmt.all(r.id).map(i => i.name + ':' + i.count).join(' ');
    lines.push([
      r.id,
      new Date(r.at).toLocaleString('zh-CN'),
      r.kind, r.faces, r.top || '',
      r.top_val == null ? '' : (r.top_val * 100).toFixed(1) + '%',
      r.cost_ms == null ? '' : r.cost_ms,
      r.dur_ms == null ? '' : r.dur_ms,
      items
    ].map(esc).join(','));
  });

  const body = '\uFEFF' + lines.join('\r\n') + '\r\n';
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="expression-sessions.csv"',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/** 清空全部数据（需要登录） */
function apiClear(req, res) {
  db.exec('DELETE FROM expr_items');
  db.exec('DELETE FROM sessions');
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('sessions')");
  return sendJSON(res, 200, { ok: true });
}

async function apiLogin(req, res) {
  const ip = clientIp(req);
  if (loginBlocked(ip)) return sendJSON(res, 429, { ok: false, error: 'too many attempts' });

  const body = await readBody(req);
  const user = String(body.user || '').trim();
  const pass = String(body.pass || '');

  const rec = readJSON(AUTH_FILE, adminAccount);
  const okUser = user === rec.user;
  const calc = hashPassword(pass, rec.salt);
  const okPass = safeEqualHex(calc.hash, rec.hash);

  if (!okUser || !okPass) {
    noteLoginFail(ip);
    return sendJSON(res, 401, { ok: false, error: '用户名或密码不对' });
  }

  loginFails.delete(ip);
  const token = makeToken(rec.user);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Set-Cookie': `dsh_admin=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  });
  res.end(JSON.stringify({ ok: true, user: rec.user }));
}

/** 修改管理员口令（需要登录） */
async function apiChangePassword(req, res) {
  const body = await readBody(req);
  const oldPass = String(body.oldPass || '');
  const newPass = String(body.newPass || '');

  const rec = readJSON(AUTH_FILE, adminAccount);
  const calc = hashPassword(oldPass, rec.salt);
  if (!safeEqualHex(calc.hash, rec.hash)) return sendJSON(res, 401, { ok: false, error: '原密码不对' });
  if (newPass.length < 6) return sendJSON(res, 400, { ok: false, error: '新密码至少 6 位' });

  const next = hashPassword(newPass);
  writeJSON(AUTH_FILE, { user: rec.user, salt: next.salt, hash: next.hash, createdAt: Date.now(), updatedAt: Date.now() });
  return sendJSON(res, 200, { ok: true });
}

/* ---------------- 静态资源 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.bin':  'application/octet-stream',
  '.png':  'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif':  'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico':  'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8'
};

/* data 目录绝不对外提供（里面有数据库和管理员口令哈希）。
   服务端自己的源码也不给下载 —— 它不属于"网站内容"。 */
const BLOCKED_PREFIX = path.join(ROOT, 'data') + path.sep;
const BLOCKED_FILES = new Set([
  path.join(ROOT, 'server-app.js'),
  path.join(ROOT, 'server.js'),
  path.join(ROOT, 'package.json'),
  path.join(ROOT, 'package-lock.json')
]);

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(ROOT, rel));

  // 防目录穿越 + 屏蔽 data 目录 + 屏蔽服务端源码
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) return sendText(res, 403, '403 Forbidden');
  if (filePath.startsWith(BLOCKED_PREFIX) || filePath === path.join(ROOT, 'data')) {
    return sendText(res, 403, '403 Forbidden');
  }
  if (BLOCKED_FILES.has(filePath)) return sendText(res, 403, '403 Forbidden');

  fs.readFile(filePath, (err, data) => {
    if (err) return sendText(res, 404, '404 Not Found: ' + rel);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // 本地开发容易吃到旧缓存，统一 no-cache（模型文件靠浏览器内存缓存足够快）
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

/* ---------------- 路由 ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = url.pathname;

  try {
    if (p.startsWith('/api/')) {
      // 注意：p 形如 "/api/health"，去掉前 5 个字符（"/api/"）才是路由名。
      // 早先写成 slice(4) 会留下一个前导斜杠，导致所有路由都匹配不上。
      const route = p.slice(5);

      // --- 无需登录 ---
      if (route === 'health' && req.method === 'GET') {
        return sendJSON(res, 200, { ok: true, version: VERSION, time: Date.now() });
      }
      if (route === 'report' && req.method === 'POST') {
        return await apiReport(req, res);
      }
      if (route === 'login' && req.method === 'POST') {
        return await apiLogin(req, res);
      }
      if (route === 'logout' && req.method === 'POST') {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': 'dsh_admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
        });
        return res.end(JSON.stringify({ ok: true }));
      }

      // --- 以下需要登录 ---
      const admin = getAdmin(req);
      if (!admin) return sendJSON(res, 401, { ok: false, error: '未登录' });

      if (route === 'me' && req.method === 'GET')  return sendJSON(res, 200, { ok: true, user: admin.u });
      if (route === 'stats' && req.method === 'GET') return apiStats(req, res, url);
      if (route === 'sessions' && req.method === 'GET') return apiSessions(req, res, url);
      if (route === 'export.csv' && req.method === 'GET') return apiExportCsv(req, res);
      if (route === 'sessions' && req.method === 'DELETE') return apiClear(req, res);
      if (route === 'password' && req.method === 'POST') return await apiChangePassword(req, res);

      return sendJSON(res, 404, { ok: false, error: 'no such api' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, '405 Method Not Allowed');
    return serveStatic(req, res, p);

  } catch (err) {
    const msg = String(err && err.message || err);
    if (msg === 'invalid json')  return sendJSON(res, 400, { ok: false, error: 'invalid json' });
    if (msg === 'body too large') return sendJSON(res, 413, { ok: false, error: 'body too large' });
    console.error('[ERROR] ' + msg);
    return sendJSON(res, 500, { ok: false, error: 'server error' });
  }
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error('  [ERROR] Port ' + PORT + ' is already in use. Try: node server-app.js 8080');
  } else {
    console.error('  [ERROR] ' + err.message);
  }
  process.exit(1);
});

/* ---------------- 命令行：--stats ---------------- */
if (process.argv.includes('--stats')) {
  const t = db.prepare('SELECT COUNT(*) AS sessions, COALESCE(SUM(faces),0) AS faces FROM sessions').get();
  console.log('sessions=' + t.sessions + '  faces=' + t.faces + '  db=' + DB_FILE);
  db.close();
  process.exit(0);
}

server.listen(PORT, () => {
  console.log('');
  console.log('  ============================================================');
  console.log('     Face Expression Recognition System  v' + VERSION);
  console.log('     App server: static files + admin API (zero dependencies)');
  console.log('  ============================================================');
  console.log('');
  console.log('  App       : http://localhost:' + PORT + '/index.html');
  console.log('  Admin     : http://localhost:' + PORT + '/admin.html');
  console.log('  API       : http://localhost:' + PORT + '/api/health');
  console.log('');
  console.log('  Default admin account:');
  console.log('    user = ' + adminAccount.user);
  console.log('    pass = ' + (process.argv.includes('--reset-admin') ? DEFAULT_ADMIN_PASS : '(unchanged)'));
  console.log('  Change it in the admin panel after first login.');
  console.log('');
  console.log('  Database  : ' + DB_FILE);
  console.log('  Privacy   : only anonymous counts are stored (no images, no face data).');
  console.log('');
  console.log('  Keep this window open. Closing it stops the server.');
  console.log('');
});
