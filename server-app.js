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
const os     = require('node:os');
const { DatabaseSync } = require('node:sqlite');

/* ---------------- 基本配置 ---------------- */
const PORT      = (process.argv[2] && /^\d+$/.test(process.argv[2])) ? Number(process.argv[2]) : 8000;
const ROOT      = __dirname;
const DATA_DIR  = path.join(ROOT, 'data');
const DB_FILE   = path.join(DATA_DIR, 'app.db');
const AUTH_FILE = path.join(DATA_DIR, 'admin.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.json');
const VERSION = '1.7.0';

const DEFAULT_ADMIN_USER = 'admin';
const DEFAULT_ADMIN_PASS = 'admin123';   // 首次启动写入；请在管理台里改掉
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;   // 登录有效期 8 小时
const MAX_BODY = 64 * 1024;                  // 上报/登录体上限 64KB
 /* 实时请求日志：默认开启，控制台能看到"谁在什么时候访问了什么"。    加 --quiet 参数可关掉（适合后台服务运行）。    注意：日志里只打 URL 路径，不打内容 —— 不会泄露任何分析数据。 */ const LOG_REQUESTS = !process.argv.includes('--quiet');

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

/* 游客体验记录（v1.7.0）—— 只记"这个随机 UUID 已经体验过一次"。
   同样是随机串，不含 IP、不含设备信息。清缓存可绕过，这是刻意接受的代价：
   它是登录门槛，不是安全防线。 */
db.exec(`
  CREATE TABLE IF NOT EXISTS guest_trials (
    gid TEXT PRIMARY KEY,
    at  INTEGER NOT NULL
  )
`);

/* 用户表（v1.7.0）—— 学生自己注册：用户名 + 邮箱 + 密码（不做邮箱验证）
   ⚠️ 只存用户名、邮箱、密码哈希（scrypt 加盐）。**不存任何图像、人脸特征、识别结果。**
   老版本产生的统计记录 user_id 为 NULL，界面统一归入「游客」账号。 */
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE,
    email         TEXT    NOT NULL,
    pass_hash     TEXT    NOT NULL,
    created_at    INTEGER NOT NULL,
    last_login_at INTEGER,
    status        TEXT    NOT NULL DEFAULT 'active'   -- active / disabled
  )
`);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_name ON users(username)');

/* 统计会话增加 user_id（NULL = 游客，用来承接升级前的历史数据） */
try {
  const cols = db.prepare("PRAGMA table_info(sessions)").all().map(c => c.name);
  if (cols.indexOf('user_id') < 0) db.exec('ALTER TABLE sessions ADD COLUMN user_id INTEGER');
} catch (e) {
  console.error('[初始化] sessions.user_id 列检查失败：', e.message);
}
db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)');

/* 设备级设置（v1.6.0）—— 跨设备记住"判定偏好"。
   ⚠️ 隐私边界：这里**只存一个前端生成的随机 UUID + 几个数字参数**。
   不存 IP、不存 UA、不存设备型号、不存任何图像或人脸特征。
   UUID 存在浏览器 localStorage 里，用户清缓存就换新号，旧记录再也对不上（等于退出登录）。 */
db.exec(`
  CREATE TABLE IF NOT EXISTS device_settings (
    device_id  TEXT PRIMARY KEY,
    payload    TEXT NOT NULL,              -- JSON：{detectThreshold, uncertainThreshold, cameraInterval}
    updated_at INTEGER NOT NULL
  )
`);

/* 统计表里用到的合法表情键（与前端 EXPR_CN 对齐） */
const EXPR_KEYS = ['neutral', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised'];
const KINDS = ['image', 'batch', 'camera', 'video'];

/* 设备设置的合法范围（与前端 SETTINGS_RANGE 对齐）。
   服务端必须再校验一遍：前端能被绕过，不能信。 */
const SETTING_SPEC = {
  detectThreshold:    { min: 0.30, max: 0.80 },
  uncertainThreshold: { min: 0.00, max: 0.90 },
  cameraInterval:     { min: 200,  max: 1000 }
};
const SETTINGS_MAX_ROWS = 20000;      // 防刷：超过就丢最旧的

/* 用户登录态有效期（7 天，比管理员长——普通用户使用周期更长） */
const USER_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
/** 两位补零 */
const p2 = n => String(n).padStart(2, '0');

/** 当前时间 HH:MM:SS */
function stamp() {
  const d = new Date();
  return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
}

/** 右补空格，让每列对齐 */
function padR(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

/** 把 ::ffff:192.168.1.5 简化成 192.168.1.5；本机显示为 local */
function shortIp(ip) {
  if (!ip) return '-';
  const s = String(ip).replace(/^::ffff:/, '');
  if (s === '::1' || s === '127.0.0.1') return 'local';
  return s;
}

/** 给每行日志加一个中文类别，扫一眼就知道这条请求在干什么 */
function pathTag(pathname, status) {
  if (status === 404) return '[未找到]';
  // 这几类是后端主动拦截的（数据库、源码、包配置），单独标出来更醒目
  if (pathname.startsWith('/data/') || /\/(server-app\.js|server\.js|package\.json|package-lock\.json)$/.test(pathname)) {
    return '[已拦截]';
  }
  if (status === 401 || status === 403) return '[未授权]';
  if (status >= 500) return '[服务器错误]';
  if (pathname === '/api/users') return '[用户管理]';
  if (pathname === '/api/user/register') return '[注册]';
  if (pathname === '/api/user/login') return '[用户登录]';
  if (pathname === '/api/guest-used') return '[游客体验]';
  if (pathname === '/api/settings') return '[设备设置]';
  if (pathname === '/api/report') return '[统计上报]';
  if (pathname === '/api/login') return '[登录]';
  if (pathname === '/api/logout') return '[退出]';
  if (pathname === '/api/export.csv') return '[导出CSV]';
  if (pathname.startsWith('/api/')) return '[接口]';
  if (pathname.startsWith('/models/')) return '[模型]';
  if (pathname.startsWith('/lib/')) return '[引擎]';
  if (pathname.endsWith('.html')) return '[页面]';
  if (/\.(js|css)$/.test(pathname)) return '[脚本样式]';
  if (/\.(png|jpe?g|webp|gif)$/i.test(pathname)) return '[图片]';
  if (/\/(data|server-app\.js|server\.js|package)/.test(pathname)) return '[已拦截]';
  return '[静态]';
}
/** 一行日志：时间  来源 方法 路径  状态  耗时  [附加] */
function logLine(req, res, pathname, ms, extra) {
  const status = res.statusCode;
  const flag = (status >= 400) ? '  <-- ' + (status >= 500 ? 'SERVER ERROR' : 'client error') : '';
  const tail = extra ? '  ' + extra : '';
  // 路径太长会顶掉后面的列，超过 32 字符就截断
  let shownPath = pathname;
  // 用 ASCII 的 ... 而不是 Unicode 省略号：Windows 控制台是 GBK，Unicode 会变乱码
  if (shownPath.length > 32) shownPath = shownPath.slice(0, 29) + '...';
  const line = '[' + stamp() + '] ' + padR(shortIp(clientIp(req)), 16)
    + padR(req.method, 6) + padR(shownPath, 34)
    + padR(status, 4) + padR(Math.round(ms) + 'ms', 7)
    + '  ' + padR(pathTag(pathname, status), 12) + tail + flag;

  // 去掉行尾多余空格（类别列是补齐对齐的，没有附加信息时会留白）
  console.log(line.replace(/\s+$/, ''));
}
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
  /* 归属：登录了就记到该用户名下，没登录就是游客（user_id 为 NULL）。
     这里只写一个整数 id，不写任何身份或图像信息。 */
  const me = getStudent(req);
  const userId = me ? me.id : null;
  const insSession = db.prepare(
    'INSERT INTO sessions (at, kind, faces, top, top_val, cost_ms, dur_ms, client, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const r = insSession.run(at, kind, faces, top, topVal, costMs, durMs, client, userId);
  const sid = Number(r.lastInsertRowid);

  const insItem = db.prepare('INSERT INTO expr_items (session_id, name, count) VALUES (?, ?, ?)');
  Object.keys(expr).forEach(k => insItem.run(sid, k, expr[k]));

  // 让请求日志多显示一点：哪一类、几张脸（不含任何图像内容）
  const KIND_CN = { image: '图片', batch: '批量', camera: '摄像头', video: '视频' };
  res.__logExtra = (KIND_CN[kind] || kind) + ' ' + faces + ' 张脸';
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

  // 带用户名的列表查询：v1.7.0 起每条会话都归属到某个用户（未登录的归「游客」）
  const where = (kind && KINDS.indexOf(kind) >= 0) ? 'WHERE s.kind = ?' : '';
  const args = where ? [kind] : [];

  const total = db.prepare('SELECT COUNT(*) AS c FROM sessions s ' + where).get(...args).c;

  const rows = db.prepare(
    `SELECT s.id, s.at, s.kind, s.faces, s.top, s.top_val, s.cost_ms, s.dur_ms,
            COALESCE(u.username, '游客') AS username
       FROM sessions s LEFT JOIN users u ON u.id = s.user_id
       ${where}
      ORDER BY s.id DESC LIMIT ? OFFSET ?`
  ).all(...args, size, offset);

  // 把每条会话的表情明细一并带出来
  const itemStmt = db.prepare('SELECT name, count FROM expr_items WHERE session_id = ? ORDER BY count DESC');
  rows.forEach(r => { r.expr = itemStmt.all(r.id); });

  return sendJSON(res, 200, { ok: true, page, size, total, rows });
}

/** 导出 CSV（带 UTF-8 BOM，Excel 直接打开不乱码） */
function apiExportCsv(req, res) {
  const rows = db.prepare(
    `SELECT s.id, s.at, s.kind, s.faces, s.top, s.top_val, s.cost_ms, s.dur_ms,
            COALESCE(u.username, '游客') AS username
       FROM sessions s LEFT JOIN users u ON u.id = s.user_id ORDER BY s.id`
  ).all();
  const itemStmt = db.prepare('SELECT name, count FROM expr_items WHERE session_id = ?');

  const esc = v => {
    const s = (v === null || v === undefined) ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = ['序号,用户,时间,模式,人脸数,主导表情,置信度,耗时(毫秒),时长(毫秒),表情明细'];
  rows.forEach(r => {
    const items = itemStmt.all(r.id).map(i => i.name + ':' + i.count).join(' ');
    lines.push([
      r.id,
      r.username || '游客',
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

/* ---------------- 设备设置（匿名编号，无需登录） ----------------
   GET  /api/settings?id=<uuid>   → { ok, payload }  payload 为 null 表示没记录
   POST /api/settings              → body { id, payload }  upsert
   两个都不需要登录，也都不记录 IP —— 这是刻意的：设置不属于身份信息。 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanSettingsPayload(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return null;
  for (const key of Object.keys(SETTING_SPEC)) {
    const spec = SETTING_SPEC[key];
    let v = Number(raw[key]);
    if (!isFinite(v)) continue;
    v = Math.min(spec.max, Math.max(spec.min, v));
    out[key] = Math.round(v * 1000) / 1000;
  }
  return Object.keys(out).length ? out : null;
}

function apiGetSettings(req, res, url) {
  const id = url.searchParams.get('id') || '';
  if (!UUID_RE.test(id)) return sendJSON(res, 400, { ok: false, error: 'bad id' });
  const row = db.prepare('SELECT payload FROM device_settings WHERE device_id = ?').get(id);
  if (!row) return sendJSON(res, 200, { ok: true, payload: null });
  let payload = null;
  try { payload = JSON.parse(row.payload); } catch (e) { payload = null; }
  return sendJSON(res, 200, { ok: true, payload });
}

async function apiSaveSettings(req, res) {
  // 注意：readBody 返回的已经是解析好的对象（空 body 时是 {}），别再多转一次
  let data;
  try { data = await readBody(req); } catch (e) { return sendJSON(res, 400, { ok: false, error: 'bad json' }); }
  const id = String(data && data.id || '');
  if (!UUID_RE.test(id)) return sendJSON(res, 400, { ok: false, error: 'bad id' });
  const payload = cleanSettingsPayload(data.payload);
  if (!payload) return sendJSON(res, 400, { ok: false, error: 'bad payload' });
  const json = JSON.stringify(payload);
  if (json.length > 512) return sendJSON(res, 400, { ok: false, error: 'payload too large' });

  db.prepare(`
    INSERT INTO device_settings (device_id, payload, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `).run(id, json, Date.now());

  // 防刷：行数超上限就丢最旧的一批（不能无限长）
  try {
    const cnt = db.prepare('SELECT COUNT(*) AS c FROM device_settings').get().c;
    if (cnt > SETTINGS_MAX_ROWS) {
      db.prepare(`DELETE FROM device_settings WHERE device_id IN (
        SELECT device_id FROM device_settings ORDER BY updated_at ASC LIMIT ?
      )`).run(cnt - SETTINGS_MAX_ROWS);
    }
  } catch (e) { /* 清理失败不影响主流程 */ }

  return sendJSON(res, 200, { ok: true });
}

/* ---------------- 用户系统（v1.7.0） ----------------
   学生自己注册：用户名 + 邮箱 + 密码，不做邮箱验证。
   密码用 scrypt 加盐哈希存成 "salt:hash" 一个字段，永远不存明文。
   ⚠️ 用户表里**没有**任何图像、人脸特征、识别相关字段 —— 这条边界不变。 */

const USERNAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5]{3,20}$/;
const EMAIL_RE    = /^[^\s@]{1,64}@[^\s@]{1,64}\.[A-Za-z]{2,10}$/;

/** 取当前登录用户（学生）；没登录返回 null */
function getStudent(req) {
  const p = verifyToken(parseCookies(req).fes_user);
  if (!p) return null;
  /* makeToken(user) 会把传进去的对象整体塞进 payload.u，所以 uid 在 p.u.uid 里；
     这里两种形态都兼容，避免以后再踩。 */
  const uid = (p.u && typeof p.u === 'object') ? p.u.uid : p.uid;
  if (!uid) return null;
  try {
    const row = db.prepare('SELECT id, username, email, status FROM users WHERE id = ?').get(uid);
    if (!row || row.status !== 'active') return null;
    return row;
  } catch (e) { return null; }
}

/** 学生端注册 */
async function apiRegister(req, res) {
  let body;
  try { body = await readBody(req); } catch (e) { return sendJSON(res, 400, { ok: false, error: 'bad json' }); }

  const username = String(body.username || '').trim();
  const email    = String(body.email || '').trim();
  const password = String(body.password || '');

  if (!USERNAME_RE.test(username)) return sendJSON(res, 400, { ok: false, error: '用户名需 3~20 位，仅限中英文、数字、下划线' });
  if (!EMAIL_RE.test(email))       return sendJSON(res, 400, { ok: false, error: '邮箱格式不正确' });
  if (password.length < 6 || password.length > 64) return sendJSON(res, 400, { ok: false, error: '密码需 6~64 位' });

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return sendJSON(res, 409, { ok: false, error: '这个用户名已被使用' });

  const h = hashPassword(password);
  const now = Date.now();
  try {
    const r = db.prepare(
      'INSERT INTO users (username, email, pass_hash, created_at, last_login_at, status) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(username, email, h.salt + ':' + h.hash, now, now, 'active');
    const uid = Number(r.lastInsertRowid);
    const token = makeToken({ uid, u: 'student:' + uid });
    res.setHeader('Set-Cookie',
      `fes_user=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(USER_SESSION_TTL_MS / 1000)}`);
    return sendJSON(res, 200, { ok: true, user: { id: uid, username, email } });
  } catch (e) {
    return sendJSON(res, 500, { ok: false, error: '注册失败：' + e.message });
  }
}

/** 学生端登录 */
async function apiUserLogin(req, res) {
  let body;
  try { body = await readBody(req); } catch (e) { return sendJSON(res, 400, { ok: false, error: 'bad json' }); }

  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password) return sendJSON(res, 400, { ok: false, error: '请填写用户名和密码' });

  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const fail = () => sendJSON(res, 401, { ok: false, error: '用户名或密码不正确' });
  if (!row) return fail();
  if (row.status !== 'active') return sendJSON(res, 403, { ok: false, error: '该账号已被停用' });

  const [salt, hash] = String(row.pass_hash).split(':');
  const calc = hashPassword(password, salt);
  if (!safeEqualHex(hash, calc.hash)) return fail();

  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), row.id);
  const token = makeToken({ uid: row.id, u: 'student:' + row.id });
  res.setHeader('Set-Cookie',
    `fes_user=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(USER_SESSION_TTL_MS / 1000)}`);
  return sendJSON(res, 200, { ok: true, user: { id: row.id, username: row.username, email: row.email } });
}

/** 学生端登出 */
function apiUserLogout(req, res) {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Set-Cookie': 'fes_user=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
  });
  return res.end(JSON.stringify({ ok: true }));
}

/** 记录一次游客体验（前端在第一次识别后调用） */
async function apiGuestUsed(req, res) {
  let data;
  try { data = await readBody(req); } catch (e) { return sendJSON(res, 400, { ok: false, error: 'bad json' }); }
  const id = String(data && data.id || '');
  if (!UUID_RE.test(id)) return sendJSON(res, 400, { ok: false, error: 'bad id' });
  try {
    db.prepare('INSERT INTO guest_trials (gid, at) VALUES (?, ?) ON CONFLICT(gid) DO UPDATE SET at = excluded.at')
      .run(id, Date.now());
  } catch (e) { /* 记不上也不影响前端拦截 */ }
  return sendJSON(res, 200, { ok: true });
}

/** 当前登录状态（前端启动时问一次） */
function apiWhoami(req, res) {
  const u = getStudent(req);
  if (!u) return sendJSON(res, 200, { ok: true, user: null });
  return sendJSON(res, 200, { ok: true, user: { id: u.id, username: u.username, email: u.email } });
}

/* ---------------- 管理台：用户管理与对比（v1.7.0） ----------------
   管理员可以：列出用户、新建、删除、停用/启用、看单个用户详情。
   还能做两种对比：
     · 横向 —— 同一时间段内，多个用户的使用量/人脸数/主导表情
     · 纵向 —— 某个用户按天的使用趋势
   注意：这里读的全是**统计数字**，没有任何图像或人脸特征。 */

/** 用户列表（含每个用户的统计汇总） */
function apiAdminUsers(req, res, url) {
  const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days')) || 30));
  const since = Date.now() - days * 24 * 3600 * 1000;

  const users = db.prepare(`
    SELECT u.id, u.username, u.email, u.created_at, u.last_login_at, u.status,
           (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.at >= ?) AS sessions,
           (SELECT COALESCE(SUM(faces),0) FROM sessions s WHERE s.user_id = u.id AND s.at >= ?) AS faces
      FROM users u ORDER BY u.id ASC
  `).all(since, since);

  // 游客（历史数据 + 未登录使用）
  const guest = db.prepare(`
    SELECT COUNT(*) AS sessions, COALESCE(SUM(faces),0) AS faces
      FROM sessions WHERE user_id IS NULL AND at >= ?
  `).get(since);

  const byDay = db.prepare(
    `SELECT date(at/1000, 'unixepoch', 'localtime') AS day, COUNT(*) AS sessions, COALESCE(SUM(faces),0) AS faces
       FROM sessions WHERE at >= ? GROUP BY day ORDER BY day ASC`
  ).all(since);

  return sendJSON(res, 200, {
    ok: true,
    days,
    users,
    guest: { id: null, username: '游客', email: '', status: 'guest', sessions: guest.sessions, faces: guest.faces },
    byDay
  });
}

/** 新建用户（管理员代建） */
async function apiAdminUserCreate(req, res) {
  let body;
  try { body = await readBody(req); } catch (e) { return sendJSON(res, 400, { ok: false, error: 'bad json' }); }
  const username = String(body.username || '').trim();
  const email    = String(body.email || '').trim();
  const password = String(body.password || '');
  if (!USERNAME_RE.test(username)) return sendJSON(res, 400, { ok: false, error: '用户名需 3~20 位，仅限中英文、数字、下划线' });
  if (!EMAIL_RE.test(email))       return sendJSON(res, 400, { ok: false, error: '邮箱格式不正确' });
  if (password.length < 6 || password.length > 64) return sendJSON(res, 400, { ok: false, error: '密码需 6~64 位' });
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    return sendJSON(res, 409, { ok: false, error: '用户名已存在' });
  }
  const h = hashPassword(password);
  const now = Date.now();
  const r = db.prepare(
    'INSERT INTO users (username, email, pass_hash, created_at, last_login_at, status) VALUES (?, ?, ?, ?, NULL, ?)'
  ).run(username, email, h.salt + ':' + h.hash, now, 'active');
  return sendJSON(res, 200, { ok: true, id: Number(r.lastInsertRowid) });
}

/** 删除用户（连带它的统计记录） */
function apiAdminUserDelete(req, res, url) {
  const id = Number(url.searchParams.get('id'));
  if (!id) return sendJSON(res, 400, { ok: false, error: 'bad id' });
  const row = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!row) return sendJSON(res, 404, { ok: false, error: '用户不存在' });

  // 统计记录不真删，改为转成游客（保留数据完整性，也不会让图表凭空少一截）
  db.prepare('UPDATE sessions SET user_id = NULL WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return sendJSON(res, 200, { ok: true, movedToGuest: true });
}

/** 停用 / 启用 */
async function apiAdminUserStatus(req, res) {
  let body;
  try { body = await readBody(req); } catch (e) { return sendJSON(res, 400, { ok: false, error: 'bad json' }); }
  const id = Number(body.id);
  const status = body.status === 'active' ? 'active' : 'disabled';
  if (!id) return sendJSON(res, 400, { ok: false, error: 'bad id' });
  const row = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!row) return sendJSON(res, 404, { ok: false, error: '用户不存在' });
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, id);
  return sendJSON(res, 200, { ok: true, status });
}

/** 单个用户详情（纵向趋势 + 表情分布 + 模式分布） */
function apiAdminUserDetail(req, res, url) {
  const idParam = url.searchParams.get('id');
  const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days')) || 30));
  const since = Date.now() - days * 24 * 3600 * 1000;

  // id=guest 看游客数据
  const isGuest = idParam === 'guest' || idParam === 'null';
  const id = isGuest ? null : Number(idParam);
  if (!isGuest && !id) return sendJSON(res, 400, { ok: false, error: 'bad id' });

  let user = null;
  if (!isGuest) {
    user = db.prepare('SELECT id, username, email, created_at, last_login_at, status FROM users WHERE id = ?').get(id);
    if (!user) return sendJSON(res, 404, { ok: false, error: '用户不存在' });
  } else {
    user = { id: null, username: '游客', email: '', status: 'guest' };
  }

  const cond = isGuest ? 'user_id IS NULL AND at >= ?' : 'user_id = ? AND at >= ?';
  const args = isGuest ? [since] : [id, since];

  const totals = db.prepare(`SELECT COUNT(*) AS sessions, COALESCE(SUM(faces),0) AS faces, COALESCE(AVG(cost_ms),0) AS avgCost FROM sessions WHERE ${cond}`).get(...args);
  const byKind = db.prepare(`SELECT kind, COUNT(*) AS sessions, COALESCE(SUM(faces),0) AS faces FROM sessions WHERE ${cond} GROUP BY kind`).all(...args);
  const byDay = db.prepare(`SELECT date(at/1000,'unixepoch','localtime') AS day, COUNT(*) AS sessions, COALESCE(SUM(faces),0) AS faces FROM sessions WHERE ${cond} GROUP BY day ORDER BY day`).all(...args);
  const byExpr = db.prepare(
    `SELECT i.name AS name, SUM(i.count) AS count FROM expr_items i JOIN sessions s ON s.id = i.session_id
      WHERE ${cond.replace(/user_id/g, 's.user_id').replace(/at >= \?/g, 's.at >= ?')}
      GROUP BY i.name ORDER BY count DESC`
  ).all(...args);

  return sendJSON(res, 200, { ok: true, user, days, totals, byKind, byDay, byExpr });
}

/** 横向对比：多个用户在同一时间段的核心指标 */
function apiAdminCompare(req, res, url) {
  const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days')) || 30));
  const since = Date.now() - days * 24 * 3600 * 1000;

  const rows = db.prepare(`
    SELECT COALESCE(u.username, '游客') AS username,
           COALESCE(u.id, 0) AS uid,
           COUNT(s.id) AS sessions,
           COALESCE(SUM(s.faces),0) AS faces,
           COALESCE(AVG(s.cost_ms),0) AS avgCost,
           MIN(s.at) AS firstAt,
           MAX(s.at) AS lastAt
      FROM sessions s LEFT JOIN users u ON u.id = s.user_id
     WHERE s.at >= ?
     GROUP BY s.user_id
     ORDER BY faces DESC
  `).all(since);

  // 每人主导表情
  const topByUser = db.prepare(`
    SELECT s.user_id AS uid, i.name AS name, SUM(i.count) AS count
      FROM expr_items i JOIN sessions s ON s.id = i.session_id
     WHERE s.at >= ?
     GROUP BY s.user_id, i.name
     ORDER BY s.user_id, count DESC
  `).all(since);

  const topMap = {};
  topByUser.forEach(r => {
    const k = r.uid === null ? 0 : r.uid;
    if (!topMap[k]) topMap[k] = { name: r.name, count: r.count };
  });

  const data = rows.map(r => ({
    uid: r.uid,
    username: r.username,
    sessions: r.sessions,
    faces: r.faces,
    avgCost: Math.round(r.avgCost),
    top: topMap[r.uid] ? topMap[r.uid].name : null,
    topCount: topMap[r.uid] ? topMap[r.uid].count : 0,
    firstAt: r.firstAt,
    lastAt: r.lastAt
  }));

  return sendJSON(res, 200, { ok: true, days, data });
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
  // 请求日志：响应结束时打印一行（来源 IP、状态码、耗时）
  if (LOG_REQUESTS) {
    const t0 = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      logLine(req, res, p, ms, res.__logExtra);
    });
  }

  try {
    if (p.startsWith('/api/')) {
      // 注意：p 形如 "/api/health"，去掉前 5 个字符（"/api/"）才是路由名。
      // 早先写成 slice(4) 会留下一个前导斜杠，导致所有路由都匹配不上。
      const route = p.slice(5);

      // --- 无需登录 ---
      if (route === 'health' && req.method === 'GET') {
        return sendJSON(res, 200, { ok: true, version: VERSION, time: Date.now() });
      }
      if (route === 'guest-used' && req.method === 'POST') {
        return await apiGuestUsed(req, res);
      }
      if (route === 'user' || route.startsWith('user/')) {
        const sub = route.slice(5);
        if (sub === 'register' && req.method === 'POST') return await apiRegister(req, res);
        if (sub === 'login'    && req.method === 'POST') return await apiUserLogin(req, res);
        if (sub === 'logout'   && req.method === 'POST') return apiUserLogout(req, res);
        if (sub === 'me'       && req.method === 'GET')  return apiWhoami(req, res);
      }
      if (route === 'whoami' && req.method === 'GET') {
        return apiWhoami(req, res);
      }
      if (route === 'settings' && req.method === 'GET') {
        return apiGetSettings(req, res, url);
      }
      if (route === 'settings' && req.method === 'POST') {
        return await apiSaveSettings(req, res);
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

      /* --- 用户管理（v1.7.0）--- */
      if (route === 'users' && req.method === 'GET')    return apiAdminUsers(req, res, url);
      if (route === 'users' && req.method === 'POST')   return await apiAdminUserCreate(req, res);
      if (route === 'users' && req.method === 'DELETE') return apiAdminUserDelete(req, res, url);
      if (route === 'users/status' && req.method === 'POST') return await apiAdminUserStatus(req, res);
      if (route === 'users/detail' && req.method === 'GET')  return apiAdminUserDetail(req, res, url);
      if (route === 'users/compare' && req.method === 'GET') return apiAdminCompare(req, res, url);

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

/**
 * 列出本机的局域网 IPv4 地址。
 * 用途：手机连同一个热点/路由器时，用 http://这些地址:端口 就能访问。
 * 注意：普通 HTTP 下手机浏览器不允许用摄像头（不是 localhost 就不算安全来源），
 *       但图片、视频文件、管理台等功能都正常。
 */
function lanAddresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  Object.keys(ifs).forEach(name => {
    (ifs[name] || []).forEach(ni => {
      // 排除内部回环和 169.254.x.x（APIPA/link-local）：
      // 后者是网卡没拿到 DHCP 时的自动地址，手机用它连不上，列出来只会误导。
      if (ni.family === 'IPv4' && !ni.internal && !/^169\\.254\\./.test(ni.address)) {
        out.push({ name, address: ni.address });
      }
    });
  });
  return out;
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

  const lans = lanAddresses();
  if (lans.length) {
    console.log('');
    console.log('  LAN access (same WiFi / hotspot):');
    lans.forEach(l => {
      console.log('    http://' + l.address + ':' + PORT + '/index.html    [' + l.name + ']');
    });
    console.log('    note: over plain HTTP, mobile browsers will NOT allow the camera.');
    console.log('          Image / video / admin features work fine.');
  }
  console.log('');
  // 判断管理员密码是否仍是默认值（对比哈希），公网/局域网部署前必须改掉
  const stillDefault = safeEqualHex(
    hashPassword(DEFAULT_ADMIN_PASS, adminAccount.salt).hash,
    adminAccount.hash
  );
  console.log('  Admin account:');
  console.log('    user = ' + adminAccount.user);
  if (stillDefault) {
    console.log('    pass = ' + DEFAULT_ADMIN_PASS + '   <-- still the DEFAULT password, change it!');
  } else {
    console.log('    pass = (you have already changed it)');
  }
  console.log('');
  console.log('  Database  : ' + DB_FILE);
  console.log('  Privacy   : only anonymous counts are stored (no images, no face data).');
  console.log('  Request log: ON  (add --quiet to disable)');
  console.log('  日志格式: [时间] 来源IP  方法  路径  状态码  耗时  类别');
  console.log('  例: [19:23:05] 192.168.1.5  GET  /index.html  200  3ms  [页面]');
  console.log('');
  console.log('  Keep this window open. Closing it stops the server.');
  console.log('');
});
