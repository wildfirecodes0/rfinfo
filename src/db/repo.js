// Data access layer. Money is always in paise (integer). Every balance change is atomic/conditional.
const fs = require('fs');
const path = require('path');
const db = require('./d1');

const now = () => Math.floor(Date.now() / 1000);

/* ───────────────────────────── migrations ───────────────────────────── */
async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'schema.sql'), 'utf8');
  const statements = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of statements) await db.run(s);
}

/* ───────────────────────────── settings ───────────────────────────── */
// Numbers that represent money are paise.
const DEFAULTS = {
  refer_bonus: 500, // ₹5
  join_bonus: 0,
  daily_bonus_enabled: 1,
  daily_bonus_min: 50,
  daily_bonus_max: 200,
  min_withdraw: 5000, // ₹50
  max_withdraw: 100000, // ₹1000
  min_refs_withdraw: 3,
  withdraw_fee_percent: 0,
  withdraw_enabled: 1,
  device_verify: 1,
  block_duplicate: 1,
  max_per_ip: 0,
  maintenance: 0,
  notify_new_ref: 1,
  channels: '[]',
  milestones: '10=20, 25=60, 50=150, 100=400',
  support_username: '',
  payout_channel: '',
  welcome_photo_url: '',
  welcome_text:
    '🚀 <b>Refer your friends &amp; earn real money!</b>\n\n💸 Get paid directly to your <b>UPI</b>. Fast, simple and secure.',
};

let sCache = null;
let sAt = 0;

function parseSettings(rows) {
  const s = {};
  for (const [k, def] of Object.entries(DEFAULTS)) s[k] = def;
  for (const r of rows) {
    if (!(r.key in DEFAULTS)) continue;
    s[r.key] = typeof DEFAULTS[r.key] === 'number' ? Number(r.value) || 0 : r.value == null ? '' : String(r.value);
  }
  try {
    const ch = JSON.parse(s.channels || '[]');
    s.channelList = Array.isArray(ch) ? ch.filter((c) => c && c.id) : [];
  } catch {
    s.channelList = [];
  }
  s.milestoneMap = parseMilestones(s.milestones);
  return s;
}

// "10=20, 50=150"  → { 10: 2000, 50: 15000 }  (referrals → bonus in paise)
function parseMilestones(str) {
  const map = {};
  String(str || '')
    .split(/[,\n]/)
    .forEach((part) => {
      const m = part.trim().match(/^(\d+)\s*[=:]\s*(\d+(?:\.\d{1,2})?)$/);
      if (m && Number(m[1]) > 0) map[Number(m[1])] = Math.round(Number(m[2]) * 100);
    });
  return map;
}

async function settings(force = false) {
  if (!force && sCache && Date.now() - sAt < 30000) return sCache;
  const rows = await db.all('SELECT key, value FROM settings');
  sCache = parseSettings(rows);
  sAt = Date.now();
  return sCache;
}

async function saveSettings(obj) {
  for (const [k, v] of Object.entries(obj)) {
    if (!(k in DEFAULTS)) continue;
    await db.run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [k, String(v)]
    );
  }
  sCache = null;
}

/* ───────────────────────────── users ───────────────────────────── */
const uCache = new Map(); // id -> { u, at }
const U_TTL = 15000;
const invalidate = (id) => uCache.delete(Number(id));

async function getUser(id, fresh = false) {
  id = Number(id);
  const c = uCache.get(id);
  if (!fresh && c && Date.now() - c.at < U_TTL) return c.u;
  const u = await db.first('SELECT * FROM users WHERE id = ?', [id]);
  if (u) uCache.set(id, { u, at: Date.now() });
  else uCache.delete(id);
  if (uCache.size > 5000) uCache.delete(uCache.keys().next().value);
  return u;
}

async function createUser({ id, username, first_name, referred_by }) {
  const t = now();
  const r = await db.run(
    `INSERT OR IGNORE INTO users (id, username, first_name, referred_by, created_at, last_active)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, username || null, first_name || null, referred_by || null, t, t]
  );
  invalidate(id);
  return r.changes > 0;
}

async function touchUser(u, from) {
  const t = now();
  const changed = (from.username || null) !== (u.username || null) || (from.first_name || null) !== (u.first_name || null);
  if (!changed && t - (u.last_active || 0) < 600 && !u.is_blocked) return;
  await db.run('UPDATE users SET username = ?, first_name = ?, last_active = ?, is_blocked = 0 WHERE id = ?', [
    from.username || null,
    from.first_name || null,
    t,
    u.id,
  ]);
  invalidate(u.id);
}

async function setState(id, state) {
  await db.run('UPDATE users SET state = ? WHERE id = ?', [state || null, id]);
  invalidate(id);
}

async function updateUser(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  await db.run(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [
    ...keys.map((k) => fields[k]),
    id,
  ]);
  invalidate(id);
}

// Atomically flips verified 0 → 1. Returns true only for the first caller (so rewards run once).
async function markVerified(id) {
  const r = await db.run('UPDATE users SET verified = 1 WHERE id = ? AND verified = 0', [id]);
  invalidate(id);
  return r.changes > 0;
}

async function addTx(userId, amount, type, note) {
  await db.run('INSERT INTO transactions (user_id, amount, type, note, created_at) VALUES (?, ?, ?, ?, ?)', [
    userId,
    amount,
    type,
    note || null,
    now(),
  ]);
}

// Credit (amount>0) or debit (amount<0). Debit never makes balance negative. Returns true on success.
async function addBalance(userId, amount, type, note, { countEarned = true } = {}) {
  amount = Math.round(amount);
  if (!amount) return false;
  let r;
  if (amount > 0) {
    r = await db.run(
      `UPDATE users SET balance = balance + ?, total_earned = total_earned + ? WHERE id = ?`,
      [amount, countEarned ? amount : 0, userId]
    );
  } else {
    r = await db.run('UPDATE users SET balance = balance + ? WHERE id = ? AND balance + ? >= 0', [
      amount,
      userId,
      amount,
    ]);
  }
  invalidate(userId);
  if (!r.changes) return false;
  await addTx(userId, amount, type, note);
  return true;
}

/* ───────────────────────────── referrals ───────────────────────────── */
// ref_credited: 0 = pending, 1 = credited, 2 = rejected (fraud)
async function creditReferral(userId, S) {
  const u = await getUser(userId, true);
  if (!u || !u.referred_by || u.ref_credited !== 0) return null;
  const lock = await db.run('UPDATE users SET ref_credited = 1 WHERE id = ? AND ref_credited = 0', [userId]);
  invalidate(userId);
  if (!lock.changes) return null;

  const referrer = await getUser(u.referred_by, true);
  if (!referrer || referrer.is_banned) return null;

  const bonus = S.refer_bonus;
  await db.run(
    `UPDATE users SET referrals = referrals + 1, ref_earned = ref_earned + ?, balance = balance + ?,
       total_earned = total_earned + ? WHERE id = ?`,
    [bonus, bonus, bonus, referrer.id]
  );
  invalidate(referrer.id);
  if (bonus > 0) await addTx(referrer.id, bonus, 'referral', `Referral: ${u.first_name || u.id} (${u.id})`);

  const fresh = await getUser(referrer.id, true);
  let milestone = 0;
  const m = S.milestoneMap[fresh.referrals];
  if (m) {
    await addBalance(referrer.id, m, 'milestone', `Milestone: ${fresh.referrals} referrals`);
    milestone = m;
  }
  return { referrer: fresh, bonus, milestone, count: fresh.referrals };
}

async function rejectReferral(userId) {
  await db.run('UPDATE users SET ref_credited = 2 WHERE id = ? AND ref_credited = 0', [userId]);
  invalidate(userId);
}

const myReferrals = (id, limit = 20) =>
  db.all(
    `SELECT id, first_name, username, verified, ref_credited, created_at FROM users
     WHERE referred_by = ? ORDER BY created_at DESC LIMIT ?`,
    [id, limit]
  );

const referralCounts = (id) =>
  db.first(
    `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN ref_credited = 0 THEN 1 ELSE 0 END), 0) AS pending
     FROM users WHERE referred_by = ?`,
    [id]
  );

const leaderboard = (limit = 10) =>
  db.all(
    `SELECT id, first_name, username, referrals FROM users
     WHERE referrals > 0 AND is_banned = 0 ORDER BY referrals DESC, id ASC LIMIT ?`,
    [limit]
  );

const userRank = async (id, referrals) =>
  (await db.first('SELECT COUNT(*) + 1 AS r FROM users WHERE referrals > ? AND is_banned = 0', [referrals])).r;

/* ───────────────────────────── daily bonus ───────────────────────────── */
async function claimDaily(userId, amount) {
  const t = now();
  const r = await db.run(
    'UPDATE users SET last_bonus = ?, balance = balance + ?, total_earned = total_earned + ? WHERE id = ? AND last_bonus <= ?',
    [t, amount, amount, userId, t - 86400]
  );
  invalidate(userId);
  if (!r.changes) return false;
  await addTx(userId, amount, 'daily', 'Daily bonus');
  return true;
}

/* ───────────────────────────── devices / anti-fraud ───────────────────────────── */
const findDeviceConflict = (userId, fp, token) =>
  db.first(
    `SELECT user_id FROM devices WHERE user_id != ? AND (fp_hash = ? OR (token IS NOT NULL AND token = ?)) LIMIT 1`,
    [userId, fp, token || '__none__']
  );

const countIp = async (ip, userId) =>
  (await db.first('SELECT COUNT(*) AS c FROM devices WHERE ip = ? AND user_id != ?', [ip, userId])).c;

async function saveDevice(userId, d) {
  await db.run(
    `INSERT INTO devices (user_id, fp_hash, token, ip, ua, platform, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET fp_hash = excluded.fp_hash, token = excluded.token, ip = excluded.ip,
       ua = excluded.ua, platform = excluded.platform`,
    [userId, d.fp, d.token || null, d.ip || null, (d.ua || '').slice(0, 300), (d.platform || '').slice(0, 40), now()]
  );
}

const getDevice = (userId) => db.first('SELECT * FROM devices WHERE user_id = ?', [userId]);

async function resetDevice(userId) {
  await db.run('DELETE FROM devices WHERE user_id = ?', [userId]);
  await db.run('UPDATE users SET verified = 0 WHERE id = ?', [userId]);
  invalidate(userId);
}

const logFraud = (userId, matched, reason, fp, ip) =>
  db.run('INSERT INTO fraud_logs (user_id, matched_user_id, reason, fp_hash, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
    userId,
    matched || null,
    reason,
    fp || null,
    ip || null,
    now(),
  ]);

const fraudLogs = (limit, offset) =>
  db.all(
    `SELECT f.*, u.first_name AS name, u.username AS uname, m.first_name AS mname, m.username AS muname
     FROM fraud_logs f LEFT JOIN users u ON u.id = f.user_id LEFT JOIN users m ON m.id = f.matched_user_id
     ORDER BY f.id DESC LIMIT ? OFFSET ?`,
    [limit, offset]
  );
const fraudCount = async () => (await db.first('SELECT COUNT(*) AS c FROM fraud_logs')).c;

/* ───────────────────────────── withdrawals ───────────────────────────── */
const pendingWithdrawal = (userId) =>
  db.first("SELECT * FROM withdrawals WHERE user_id = ? AND status = 'pending' LIMIT 1", [userId]);

async function createWithdrawal(userId, amount, fee, upi) {
  const r = await db.run('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?', [
    amount,
    userId,
    amount,
  ]);
  invalidate(userId);
  if (!r.changes) return null;
  const ins = await db.run(
    `INSERT INTO withdrawals (user_id, amount, fee, net, upi, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    [userId, amount, fee, amount - fee, upi, now()]
  );
  await addTx(userId, -amount, 'withdraw', `Withdrawal #${ins.lastId} to ${upi}`);
  return ins.lastId;
}

const getWithdrawal = (id) =>
  db.first(
    `SELECT w.*, u.first_name, u.username, u.referrals FROM withdrawals w LEFT JOIN users u ON u.id = w.user_id WHERE w.id = ?`,
    [id]
  );

async function approveWithdrawal(id, utr) {
  const r = await db.run(
    "UPDATE withdrawals SET status = 'approved', utr = ?, processed_at = ? WHERE id = ? AND status = 'pending'",
    [utr || null, now(), id]
  );
  if (!r.changes) return null;
  const w = await getWithdrawal(id);
  await db.run('UPDATE users SET total_withdrawn = total_withdrawn + ? WHERE id = ?', [w.amount, w.user_id]);
  invalidate(w.user_id);
  return w;
}

async function rejectWithdrawal(id, reason, refund = true) {
  const r = await db.run(
    "UPDATE withdrawals SET status = 'rejected', note = ?, processed_at = ? WHERE id = ? AND status = 'pending'",
    [reason || null, now(), id]
  );
  if (!r.changes) return null;
  const w = await getWithdrawal(id);
  if (refund) await addBalance(w.user_id, w.amount, 'refund', `Refund for withdrawal #${id}`, { countEarned: false });
  return w;
}

const listWithdrawals = (status, limit, offset) =>
  db.all(
    `SELECT w.*, u.first_name, u.username, u.referrals FROM withdrawals w LEFT JOIN users u ON u.id = w.user_id
     ${status ? 'WHERE w.status = ?' : ''} ORDER BY w.id DESC LIMIT ? OFFSET ?`,
    status ? [status, limit, offset] : [limit, offset]
  );
const countWithdrawals = async (status) =>
  (await db.first(`SELECT COUNT(*) AS c FROM withdrawals ${status ? 'WHERE status = ?' : ''}`, status ? [status] : [])).c;
const userWithdrawals = (userId, limit = 10) =>
  db.all('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT ?', [userId, limit]);

/* ───────────────────────────── transactions ───────────────────────────── */
const userTx = (userId, limit = 10, offset = 0) =>
  db.all('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?', [userId, limit, offset]);
const allTx = (limit, offset) =>
  db.all(
    `SELECT t.*, u.first_name, u.username FROM transactions t LEFT JOIN users u ON u.id = t.user_id
     ORDER BY t.id DESC LIMIT ? OFFSET ?`,
    [limit, offset]
  );
const txCount = async () => (await db.first('SELECT COUNT(*) AS c FROM transactions')).c;

/* ───────────────────────────── gift codes ───────────────────────────── */
async function redeemCode(userId, codeRaw) {
  const code = String(codeRaw || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) return { error: 'invalid' };
  const c = await db.first('SELECT * FROM codes WHERE code = ?', [code]);
  if (!c) return { error: 'invalid' };
  if (c.expires_at && c.expires_at < now()) return { error: 'expired' };
  if (c.used >= c.max_uses) return { error: 'exhausted' };
  const ins = await db.run('INSERT OR IGNORE INTO code_redemptions (code, user_id, created_at) VALUES (?, ?, ?)', [
    code,
    userId,
    now(),
  ]);
  if (!ins.changes) return { error: 'used' };
  const up = await db.run('UPDATE codes SET used = used + 1 WHERE code = ? AND used < max_uses', [code]);
  if (!up.changes) {
    await db.run('DELETE FROM code_redemptions WHERE code = ? AND user_id = ?', [code, userId]);
    return { error: 'exhausted' };
  }
  await addBalance(userId, c.amount, 'code', `Gift code ${code}`);
  return { amount: c.amount };
}
const listCodes = () => db.all('SELECT * FROM codes ORDER BY created_at DESC LIMIT 200');
const createCode = (code, amount, maxUses, expiresAt) =>
  db.run('INSERT INTO codes (code, amount, max_uses, used, expires_at, created_at) VALUES (?, ?, ?, 0, ?, ?)', [
    code,
    amount,
    maxUses,
    expiresAt || 0,
    now(),
  ]);
async function deleteCode(code) {
  await db.run('DELETE FROM codes WHERE code = ?', [code]);
  await db.run('DELETE FROM code_redemptions WHERE code = ?', [code]);
}

/* ───────────────────────────── admin: users & stats ───────────────────────────── */
function userFilter(q, filter) {
  const where = [];
  const params = [];
  if (q) {
    const n = Number(String(q).replace('@', ''));
    if (Number.isFinite(n) && /^\d+$/.test(String(q).trim())) {
      where.push('id = ?');
      params.push(n);
    } else {
      where.push('(username LIKE ? OR first_name LIKE ? OR upi LIKE ?)');
      const like = `%${String(q).replace('@', '').replace(/[%_]/g, '')}%`;
      params.push(like, like, like);
    }
  }
  if (filter === 'banned') where.push('is_banned = 1');
  if (filter === 'verified') where.push('verified = 1');
  if (filter === 'unverified') where.push('verified = 0');
  if (filter === 'blocked') where.push('is_blocked = 1');
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}
const SORTS = {
  new: 'created_at DESC',
  refs: 'referrals DESC',
  balance: 'balance DESC',
  active: 'last_active DESC',
};
async function listUsers({ q, filter, sort, limit, offset }) {
  const f = userFilter(q, filter);
  const rows = await db.all(`SELECT * FROM users ${f.sql} ORDER BY ${SORTS[sort] || SORTS.new} LIMIT ? OFFSET ?`, [
    ...f.params,
    limit,
    offset,
  ]);
  const total = (await db.first(`SELECT COUNT(*) AS c FROM users ${f.sql}`, f.params)).c;
  return { rows, total };
}

async function stats() {
  const t = now();
  const dayStart = t - ((t + 19800) % 86400);
  const u = await db.first(
    `SELECT COUNT(*) AS total, COALESCE(SUM(verified),0) AS verified, COALESCE(SUM(is_banned),0) AS banned,
       COALESCE(SUM(is_blocked),0) AS blocked,
       COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END),0) AS today,
       COALESCE(SUM(CASE WHEN last_active >= ? THEN 1 ELSE 0 END),0) AS active24,
       COALESCE(SUM(referrals),0) AS referrals, COALESCE(SUM(balance),0) AS balance,
       COALESCE(SUM(total_earned),0) AS earned
     FROM users`,
    [dayStart, t - 86400]
  );
  const w = await db.all('SELECT status, COUNT(*) AS c, COALESCE(SUM(amount),0) AS s FROM withdrawals GROUP BY status');
  const wd = { pending: { c: 0, s: 0 }, approved: { c: 0, s: 0 }, rejected: { c: 0, s: 0 } };
  for (const r of w) wd[r.status] = { c: r.c, s: r.s };
  const fraud = (await db.first('SELECT COUNT(*) AS c FROM fraud_logs WHERE created_at >= ?', [t - 86400])).c;
  return { users: u, wd, fraud24: fraud };
}

const joinsByDay = (days = 14) =>
  db.all(
    `SELECT (created_at + 19800) / 86400 AS d, COUNT(*) AS c FROM users WHERE created_at >= ? GROUP BY d ORDER BY d`,
    [now() - days * 86400]
  );

const recentUsers = (limit = 8) => db.all('SELECT * FROM users ORDER BY created_at DESC LIMIT ?', [limit]);

/* ───────────────────────────── broadcasts ───────────────────────────── */
const createBroadcast = async (b) =>
  (
    await db.run(
      `INSERT INTO broadcasts (text, image_key, button_text, button_url, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)`,
      [b.text, b.image_key || null, b.button_text || null, b.button_url || null, now()]
    )
  ).lastId;
const updateBroadcast = (id, f) => {
  const keys = Object.keys(f);
  return db.run(`UPDATE broadcasts SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [
    ...keys.map((k) => f[k]),
    id,
  ]);
};
const listBroadcasts = () => db.all('SELECT * FROM broadcasts ORDER BY id DESC LIMIT 30');
const getBroadcast = (id) => db.first('SELECT * FROM broadcasts WHERE id = ?', [id]);
const broadcastBatch = (afterId, limit) =>
  db.all('SELECT id FROM users WHERE id > ? AND is_banned = 0 AND is_blocked = 0 ORDER BY id LIMIT ?', [afterId, limit]);
const reachableCount = async () =>
  (await db.first('SELECT COUNT(*) AS c FROM users WHERE is_banned = 0 AND is_blocked = 0')).c;
const markBlocked = (id) => {
  invalidate(id);
  return db.run('UPDATE users SET is_blocked = 1 WHERE id = ?', [id]);
};

/* ───────────────────────────── backups ───────────────────────────── */
const BACKUP_TABLES = ['users', 'devices', 'withdrawals', 'transactions', 'settings', 'codes', 'code_redemptions', 'fraud_logs', 'broadcasts'];
async function dumpTable(table) {
  const out = [];
  let offset = 0;
  for (;;) {
    const rows = await db.all(`SELECT * FROM ${table} LIMIT 5000 OFFSET ?`, [offset]);
    out.push(...rows);
    if (rows.length < 5000) break;
    offset += 5000;
  }
  return out;
}

module.exports = {
  now,
  migrate,
  DEFAULTS,
  settings,
  saveSettings,
  parseMilestones,
  getUser,
  createUser,
  touchUser,
  setState,
  updateUser,
  markVerified,
  invalidate,
  addBalance,
  addTx,
  creditReferral,
  rejectReferral,
  myReferrals,
  referralCounts,
  leaderboard,
  userRank,
  claimDaily,
  findDeviceConflict,
  countIp,
  saveDevice,
  getDevice,
  resetDevice,
  logFraud,
  fraudLogs,
  fraudCount,
  pendingWithdrawal,
  createWithdrawal,
  getWithdrawal,
  approveWithdrawal,
  rejectWithdrawal,
  listWithdrawals,
  countWithdrawals,
  userWithdrawals,
  userTx,
  allTx,
  txCount,
  redeemCode,
  listCodes,
  createCode,
  deleteCode,
  listUsers,
  stats,
  joinsByDay,
  recentUsers,
  createBroadcast,
  updateBroadcast,
  listBroadcasts,
  getBroadcast,
  broadcastBatch,
  reachableCount,
  markBlocked,
  BACKUP_TABLES,
  dumpTable,
};
