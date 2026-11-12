require('dotenv').config();
const crypto = require('crypto');

function need(key) {
  const v = (process.env[key] || '').trim();
  if (!v) throw new Error(`❌ Missing required env variable: ${key}`);
  return v;
}
const opt = (key, def = '') => (process.env[key] || def).trim();

const BOT_TOKEN = need('BOT_TOKEN');
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

const cfg = {
  BOT_TOKEN,
  ADMIN_IDS: opt('ADMIN_IDS')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0),
  ADMIN_USERNAME: opt('ADMIN_USERNAME', 'admin'),
  ADMIN_PASSWORD: need('ADMIN_PASSWORD'),
  SESSION_SECRET: opt('SESSION_SECRET') || hash('session:' + BOT_TOKEN),
  // Auto-detected on Render, Railway and Koyeb; set PUBLIC_URL manually on any other host.
  PUBLIC_URL: (
    opt('PUBLIC_URL') ||
    opt('RENDER_EXTERNAL_URL') ||
    (opt('RAILWAY_PUBLIC_DOMAIN') && `https://${opt('RAILWAY_PUBLIC_DOMAIN')}`) ||
    (opt('KOYEB_PUBLIC_DOMAIN') && `https://${opt('KOYEB_PUBLIC_DOMAIN')}`)
  ).replace(/\/+$/, ''),
  PORT: Number(opt('PORT', '3000')),
  TZ_OFFSET_SEC: 19800, // IST (+05:30) for daily charts

  // Cloudflare D1 (REST API)  — OR —  D1 proxy worker (recommended for high traffic)
  CF_ACCOUNT_ID: opt('CF_ACCOUNT_ID'),
  CF_API_TOKEN: opt('CF_API_TOKEN'),
  D1_DATABASE_ID: opt('D1_DATABASE_ID'),
  D1_PROXY_URL: opt('D1_PROXY_URL').replace(/\/+$/, ''),
  D1_PROXY_SECRET: opt('D1_PROXY_SECRET'),

  // Cloudflare R2 (S3 compatible)
  R2_ACCOUNT_ID: opt('R2_ACCOUNT_ID') || opt('CF_ACCOUNT_ID'),
  R2_ACCESS_KEY_ID: opt('R2_ACCESS_KEY_ID'),
  R2_SECRET_ACCESS_KEY: opt('R2_SECRET_ACCESS_KEY'),
  R2_BUCKET: opt('R2_BUCKET'),
  R2_PUBLIC_URL: opt('R2_PUBLIC_URL').replace(/\/+$/, ''),

  WEBHOOK_SECRET: hash('webhook:' + BOT_TOKEN).slice(0, 48),
  WEBHOOK_PATH: '/tg/' + hash('path:' + BOT_TOKEN).slice(0, 24),
};

if (!cfg.D1_PROXY_URL && !(cfg.CF_ACCOUNT_ID && cfg.CF_API_TOKEN && cfg.D1_DATABASE_ID)) {
  throw new Error(
    '❌ Database not configured. Set CF_ACCOUNT_ID + CF_API_TOKEN + D1_DATABASE_ID, or D1_PROXY_URL + D1_PROXY_SECRET'
  );
}
if (cfg.D1_PROXY_URL && !cfg.D1_PROXY_SECRET) throw new Error('❌ D1_PROXY_SECRET is required with D1_PROXY_URL');

cfg.isAdmin = (id) => cfg.ADMIN_IDS.includes(Number(id));

module.exports = cfg;
