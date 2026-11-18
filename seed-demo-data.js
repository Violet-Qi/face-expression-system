/**
 * 演示数据生成脚本（方案 A：直接写数据库）
 * ------------------------------------------------------------
 * 为什么不用 API 上报：
 *   server-app.js 里 `const at = Date.now()` —— 时间戳由服务端决定，
 *   客户端传什么都没用，所以通过 API 只能造出"全部发生在今天"的数据，
 *   趋势图只有一个点。这个脚本直接 INSERT，时间可以回溯到多天。
 *
 * 时间约束（用户明确要求）：
 *   · 不早于 2026-11-08 —— 管理台是 v1.3 才加的，更早没有统计是合理的
 *   · 不晚于今天
 *   · 一共 6 天窗口：11-08 ~ 11-13
 *
 * 用户数：5 个（用户要求"最多 8 个左右"）
 *
 * 用法（在服务器 /var/www/html 下执行）：
 *   node seed-demo-data.js              # 写入
 *   node seed-demo-data.js --dry        # 只看计划，不写库
 *   node seed-demo-data.js --clean      # 清除本脚本造的数据
 *   node seed-demo-data.js --db /path/to/app.db   # 指定数据库路径
 *
 * 需要 Node >= 22.5（node:sqlite 内置）
 * ============================================================ */

const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

/* ---------------- 配置 ---------------- */

const DEMO_PASSWORD = 'Demo123456';

/** 演示用户。days = 活跃天数（从今天往前数） */
const DEMO_USERS = [
  { username: 'caiyunfei',   email: 'caiyunfei@example.com', profile: 'heavy',  days: 6, perDay: [6, 10] },
  { username: 'linxiaoyu',  email: 'linxiaoyu@example.com',        profile: 'medium', days: 5, perDay: [3, 6]  },
  { username: 'wangzimo',   email: 'wangzimo@example.com',      profile: 'medium', days: 4, perDay: [2, 5]  },
  { username: 'zhaoyiran',  email: 'zhaoyiran@example.com',     profile: 'light',  days: 3, perDay: [1, 3]  },
  { username: 'sunhaoran',  email: 'sunhaoran@example.com',       profile: 'light',  days: 2, perDay: [1, 2]  },
];

const EXPR_KEYS = ['neutral', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised'];
const KINDS = ['image', 'batch', 'camera', 'video'];

/** 不同用户常用的表情不同，横向对比才有差异 */
const PROFILES = {
  heavy:  { happy: 0.40, neutral: 0.30, surprised: 0.11, sad: 0.07, angry: 0.05, fearful: 0.04, disgusted: 0.03 },
  medium: { neutral: 0.37, happy: 0.33, sad: 0.12, angry: 0.07, surprised: 0.06, fearful: 0.03, disgusted: 0.02 },
  light:  { happy: 0.36, neutral: 0.34, surprised: 0.14, fearful: 0.06, angry: 0.04, sad: 0.04, disgusted: 0.02 },
};

/** 数据窗口：不早于这个日期（管理台上线） */
const EARLIEST = '2026-11-08';

const BJ = 8 * 3600 * 1000;          // 北京时间在 UTC 上的偏移

/* ---------------- 工具 ---------------- */

function hashPassword(password) {
  // 与 server-app.js 完全一致：scrypt(password, salt16) → 32 字节 → hex
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, 32);
  return salt.toString('hex') + ':' + key.toString('hex');
}

/** 某个时间戳所在「北京时间那一天」的 00:00 */
function bjDayStart(ms) {
  const t = ms + BJ;
  return Math.floor(t / 86400000) * 86400000 - BJ;
}

/** 在「北京时间某天」的 hour:minute 上取时间戳 */
function bjTime(dayStartMs, hour, minute) {
  return dayStartMs + hour * 3600000 + minute * 60000;
}

/** 固定种子的伪随机，保证每次生成结果一致、可复现 */
let _seed = 20261113;
function rnd() {
  _seed = (_seed * 1103515245 + 12345) & 0x7fffffff;
  return _seed / 0x7fffffff;
}
function randInt(a, b) { return Math.floor(rnd() * (b - a + 1)) + a; }
function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }
function weightedPick(items, weights) {
  const total = weights.reduce((s, w) => s + w, 0);
  let r = rnd() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

function parseArgs() {
  const a = process.argv.slice(2);
  const out = { dry: false, clean: false, db: null };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--dry') out.dry = true;
    else if (a[i] === '--clean') out.clean = true;
    else if (a[i] === '--db') out.db = a[++i];
  }
  return out;
}

/* ---------------- 计划生成 ---------------- */

function buildPlan(nowMs) {
  const todayStart = bjDayStart(nowMs);
  const earliestStart = bjDayStart(Date.parse(EARLIEST + 'T00:00:00+08:00'));

  const plan = [];

  for (const u of DEMO_USERS) {
    const days = [];
    for (let d = u.days - 1; d >= 0; d--) {
      const dayStart = todayStart - d * 86400000;
      if (dayStart < earliestStart) continue;   // 不早于管理台上线日期

      const count = randInt(u.perDay[0], u.perDay[1]);
      const sessions = [];
      for (let i = 0; i < count; i++) {
        // 时间落在 09:00 ~ 22:30
        let hour = randInt(9, 22);
        let minute = randInt(0, 59);
        let at = bjTime(dayStart, hour, minute);
        if (at > nowMs - 60000) at = nowMs - randInt(2, 40) * 60000;   // 不能晚于现在

        const kind = weightedPick(KINDS, [5, 2, 2, 1]);
        const faces = weightedPick([1, 2, 3, 4], [6, 2, 1, 1]);

        /* 逐张脸抽表情，而不是"概率×脸数再取整"。
           后者的问题：faces=1 时 round(1 × 0.05) = 0，小概率表情永远消失，
           结果七类里只剩中性/高兴两种，一眼假。
           逐张抽能保证总数正好等于 faces，且七类都会自然出现。 */
        const prof = PROFILES[u.profile];
        const expr = {};
        const weights = EXPR_KEYS.map(k => prof[k] || 0.01);
        for (let fi = 0; fi < Math.max(1, faces); fi++) {
          const k = weightedPick(EXPR_KEYS, weights);
          expr[k] = (expr[k] || 0) + 1;
        }

        const top = Object.keys(expr).reduce((a, b) => (expr[a] >= expr[b] ? a : b));
        const cost = (kind === 'image' || kind === 'batch')
          ? randInt(280, 1600)
          : randInt(90, 420);

        sessions.push({
          at,
          kind,
          faces,
          top,
          top_val: Number((0.62 + rnd() * 0.35).toFixed(3)),
          cost_ms: cost,
          dur_ms: kind === 'video' ? randInt(4000, 32000) : null,
          client: 'demo' + randInt(100000, 999999),
          expr,
        });
      }
      sessions.sort((a, b) => a.at - b.at);
      days.push({ dayStart, sessions });
    }
    plan.push({ user: u, days });
  }

  return plan;
}

function printPlan(plan) {
  let totalSessions = 0, totalFaces = 0;
  for (const item of plan) {
    const n = item.days.reduce((s, d) => s + d.sessions.length, 0);
    const f = item.days.reduce((s, d) => s + d.sessions.reduce((t, x) => t + x.faces, 0), 0);
    totalSessions += n;
    totalFaces += f;
    const from = item.days.length ? new Date(item.days[0].dayStart + 12 * 3600000).toISOString().slice(0, 10) : '-';
    const to = item.days.length ? new Date(item.days[item.days.length - 1].dayStart + 12 * 3600000).toISOString().slice(0, 10) : '-';
    console.log(`  ${item.user.username.padEnd(14)} ${item.user.profile.padEnd(7)} ${String(item.days.length)} 天 (${from} ~ ${to})  ${String(n).padStart(3)} 会话  ${String(f).padStart(4)} 张脸`);
  }
  console.log('  ' + '-'.repeat(76));
  console.log(`  合计 ${plan.length} 个用户 · ${totalSessions} 个会话 · ${totalFaces} 张脸`);
}

/* ---------------- 写库 ---------------- */

function doSeed(db, plan) {
  const now = Date.now();
  const findUser = db.prepare('SELECT id FROM users WHERE username = ?');
  const insUser = db.prepare(
    'INSERT INTO users (username, email, pass_hash, created_at, last_login_at, status) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insSession = db.prepare(
    'INSERT INTO sessions (at, kind, faces, top, top_val, cost_ms, dur_ms, client, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insItem = db.prepare('INSERT INTO expr_items (session_id, name, count) VALUES (?, ?, ?)');

  let usersCreated = 0, sessionsCreated = 0, itemsCreated = 0;

  db.exec('BEGIN');
  try {
    for (const item of plan) {
      const u = item.user;
      let row = findUser.get(u.username);
      let uid;

      if (row) {
        uid = row.id;
        console.log(`  跳过已存在用户 ${u.username}（id=${uid}）`);
      } else {
        const createdAt = item.days.length ? item.days[0].sessions[0].at - 3600000 : now;
        const lastLogin = item.days.length
          ? item.days[item.days.length - 1].sessions.slice(-1)[0].at
          : now;
        const r = insUser.run(u.username, u.email, hashPassword(DEMO_PASSWORD), createdAt, lastLogin, 'active');
        uid = Number(r.lastInsertRowid);
        usersCreated++;
        console.log(`  创建用户 ${u.username}（id=${uid}）`);
      }

      for (const d of item.days) {
        for (const s of d.sessions) {
          const r = insSession.run(s.at, s.kind, s.faces, s.top, s.top_val, s.cost_ms, s.dur_ms, s.client, uid);
          const sid = Number(r.lastInsertRowid);
          sessionsCreated++;
          for (const k of Object.keys(s.expr)) {
            insItem.run(sid, k, s.expr[k]);
            itemsCreated++;
          }
        }
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return { usersCreated, sessionsCreated, itemsCreated };
}

function doClean(db) {
  const names = DEMO_USERS.map(u => u.username);
  const ph = names.map(() => '?').join(',');
  const ids = db.prepare(`SELECT id FROM users WHERE username IN (${ph})`).all(...names).map(r => r.id);

  if (!ids.length) {
    console.log('  没有找到本脚本创建的用户，无需清理');
    return { sessions: 0, users: 0 };
  }

  const idPh = ids.map(() => '?').join(',');
  db.exec('BEGIN');
  try {
    // 先删子表（外键虽然有 CASCADE，但显式删更保险）
    db.prepare(
      `DELETE FROM expr_items WHERE session_id IN (SELECT id FROM sessions WHERE user_id IN (${idPh}))`
    ).run(...ids);
    const s = db.prepare(`DELETE FROM sessions WHERE user_id IN (${idPh})`).run(...ids);
    db.prepare(`DELETE FROM guest_trials WHERE 1 = 0`).run();   // 不碰游客记录
    const u = db.prepare(`DELETE FROM users WHERE id IN (${idPh})`).run(...ids);
    db.exec('COMMIT');
    console.log(`  已删除 ${s.changes} 个会话、${u.changes} 个用户`);
    return { sessions: s.changes, users: u.changes };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/* ---------------- 入口 ---------------- */

function main() {
  const args = parseArgs();
  const dbPath = args.db || path.join(__dirname, 'data', 'app.db');

  if (!require('fs').existsSync(dbPath)) {
    console.error('找不到数据库文件: ' + dbPath);
    console.error('请在站点根目录执行，或用 --db 指定路径');
    process.exit(1);
  }

  console.log('数据库: ' + dbPath);
  const db = new DatabaseSync(dbPath);

  try {
    if (args.clean) {
      console.log('\n=== 清理演示数据 ===');
      doClean(db);
      db.close();
      return;
    }

    const now = Date.now();
    const plan = buildPlan(now);

    console.log('\n=== 计划 ===');
    printPlan(plan);

    if (args.dry) {
      console.log('\n（--dry 模式，未写入数据库）');
      db.close();
      return;
    }

    console.log('\n=== 写入 ===');
    const r = doSeed(db, plan);
    console.log(`\n完成：新增 ${r.usersCreated} 个用户、${r.sessionsCreated} 个会话、${r.itemsCreated} 条表情记录`);
    console.log(`\n演示账号密码统一为：${DEMO_PASSWORD}`);
    DEMO_USERS.forEach(u => console.log('  ' + u.username.padEnd(14) + u.email));
    console.log('\n如需清除：node seed-demo-data.js --clean');
  } finally {
    try { db.close(); } catch (e) {}
  }
}

main();
