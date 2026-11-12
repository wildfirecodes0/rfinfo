// Screens & keyboards shared by the bot handlers and the web (device verification) flow.
const { Markup } = require('telegraf');
const cfg = require('../config');
const bot = require('./instance');
const { inr, esc, displayName } = require('../utils');

const BTN = {
  balance: '💰 Balance',
  refer: '👥 Refer & Earn',
  daily: '🎁 Daily Bonus',
  withdraw: '💸 Withdraw',
  wallet: '🏦 Wallet',
  top: '🏆 Leaderboard',
  redeem: '🎟 Redeem Code',
  stats: '📊 Statistics',
  support: '🆘 Support',
};

const mainKeyboard = () =>
  Markup.keyboard([
    [BTN.balance, BTN.refer],
    [BTN.daily, BTN.withdraw],
    [BTN.wallet, BTN.top],
    [BTN.redeem, BTN.stats],
    [BTN.support],
  ])
    .resize()
    .persistent();

const refLink = (id) => `https://t.me/${bot.botInfo ? bot.botInfo.username : 'bot'}?start=${id}`;

async function sendWelcome(userId, S, u) {
  const name = esc(displayName(u));
  const lines = [
    `👋 <b>Welcome, ${name}!</b>`,
    '',
    S.welcome_text,
    '',
    `🎯 <b>Per referral:</b> ${inr(S.refer_bonus)}`,
    `💸 <b>Min. withdrawal:</b> ${inr(S.min_withdraw)}`,
    S.daily_bonus_enabled ? `🎁 <b>Daily bonus:</b> up to ${inr(S.daily_bonus_max)}` : null,
    '',
    `👇 <i>Use the menu below to get started.</i>`,
  ].filter((l) => l !== null);
  const text = lines.join('\n');
  const extra = { parse_mode: 'HTML', ...mainKeyboard() };
  if (S.welcome_photo_url) {
    try {
      return await bot.telegram.sendPhoto(userId, S.welcome_photo_url, { caption: text, ...extra });
    } catch (e) {
      console.warn('[welcome] photo failed, sending text:', e.description || e.message);
    }
  }
  return bot.telegram.sendMessage(userId, text, { ...extra, link_preview_options: { is_disabled: true } });
}

function joinScreen(missing) {
  const text = [
    '📢 <b>Join Required</b>',
    '',
    'To use this bot and start earning, please join all of our official channels below 👇',
    '',
    ...missing.map((c, i) => `${i + 1}. <b>${esc(c.title || c.id)}</b>`),
    '',
    '✅ After joining, tap <b>“I’ve Joined”</b>.',
  ].join('\n');
  const rows = missing.map((c) => [Markup.button.url(`➕ Join ${c.title || c.id}`, c.url || `https://t.me/${String(c.id).replace('@', '')}`)]);
  rows.push([Markup.button.callback('✅ I’ve Joined', 'check_join')]);
  return { text, extra: { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) } };
}

function verifyScreen() {
  const text = [
    '🛡 <b>Device Verification</b>',
    '',
    'To keep rewards fair, every user must verify their device <b>once</b>.',
    '',
    '🔹 One device = one account',
    '🔹 Takes less than 3 seconds',
    '🔹 No personal data is collected',
    '',
    '👇 Tap the button below to verify.',
  ].join('\n');
  const kb = cfg.PUBLIC_URL
    ? Markup.inlineKeyboard([[Markup.button.webApp('🔐 Verify My Device', `${cfg.PUBLIC_URL}/verify`)]])
    : Markup.inlineKeyboard([[Markup.button.callback('⚠️ Verification unavailable', 'noop')]]);
  return { text, extra: { parse_mode: 'HTML', ...kb } };
}

module.exports = { BTN, mainKeyboard, sendWelcome, joinScreen, verifyScreen, refLink };
