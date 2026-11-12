// Stateless signed-cookie sessions + brute-force protection for the admin panel.
const crypto = require('crypto');
const cfg = require('../config');

const COOKIE = 'rb_admin';
const MAX_AGE = 7 * 24 * 3600;

const hmac = (s) => crypto.createHmac('sha256', cfg.SESSION_SECRET).update(s).digest('base64url');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

function sign(payload) {
  const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${b}.${hmac(b)}`;
}

function verifyToken(tok) {
  if (!tok || typeof tok !== 'string' || !tok.includes('.')) return null;
  const [b, s] = tok.split('.');
  const expect = hmac(b);
  if (s.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expect))) return null;
  try {
    const p = JSON.parse(Buffer.from(b, 'base64url').toString());
    if (!p.exp || p.exp < Date.now() / 1000) return null;
    return p;
  } catch {
    return null;
  }
}

function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}

function setSession(req, res, user) {
  const tok = sign({ u: user, exp: Math.floor(Date.now() / 1000) + MAX_AGE });
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${encodeURIComponent(tok)}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE}${req.secure ? '; Secure' : ''}`
  );
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0`);
}

function checkCredentials(user, pass) {
  const a = crypto.timingSafeEqual(sha(user), sha(cfg.ADMIN_USERNAME));
  const b = crypto.timingSafeEqual(sha(pass), sha(cfg.ADMIN_PASSWORD));
  return a && b;
}

// brute force: 5 failures / 15 minutes per IP
const fails = new Map();
function isLocked(ip) {
  const f = fails.get(ip);
  return f && f.count >= 5 && Date.now() - f.at < 15 * 60 * 1000;
}
function recordFail(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.at > 15 * 60 * 1000) fails.set(ip, { count: 1, at: Date.now() });
  else f.count++;
}
const clearFails = (ip) => fails.delete(ip);

function requireAdmin(req, res, next) {
  const s = verifyToken(cookies(req)[COOKIE]);
  if (!s) return res.redirect('/admin/login');
  req.admin = s.u;
  // Extra CSRF guard on state-changing requests (cookie is already SameSite=Strict).
  if (req.method === 'POST') {
    const origin = req.get('origin');
    if (origin && cfg.PUBLIC_URL && origin !== cfg.PUBLIC_URL && origin !== `${req.protocol}://${req.get('host')}`) {
      return res.status(403).send('Bad origin');
    }
  }
  next();
}

module.exports = { requireAdmin, setSession, clearSession, checkCredentials, isLocked, recordFail, clearFails };
