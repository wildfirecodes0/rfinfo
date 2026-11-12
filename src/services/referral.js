// Runs once when a user passes all gates (channels joined + device verified).
const repo = require('../db/repo');
const bot = require('../bot/instance');
const { inr, esc, displayName } = require('../utils');

async function safeSend(id, text, extra = {}) {
  try {
    await bot.telegram.sendMessage(id, text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
  } catch (e) {
    if (e.code === 403) await repo.markBlocked(id).catch(() => {});
  }
}

async function onCleared(userId) {
  const S = await repo.settings();
  if (S.join_bonus > 0) await repo.addBalance(userId, S.join_bonus, 'join', 'Welcome bonus');

  const res = await repo.creditReferral(userId, S);
  if (res) {
    const u = await repo.getUser(userId);
    let msg =
      `🎉 <b>Referral Confirmed!</b>\n\n` +
      `👤 ${esc(displayName(u))} just verified using your link.\n` +
      `💰 <b>+${inr(res.bonus)}</b> added to your balance.\n\n` +
      `👥 Total referrals: <b>${res.count}</b>\n` +
      `💳 Balance: <b>${inr(res.referrer.balance)}</b>`;
    if (res.milestone) msg += `\n\n🏅 <b>Milestone unlocked!</b> ${res.count} referrals → <b>+${inr(res.milestone)}</b> bonus!`;
    await safeSend(res.referrer.id, msg);
  }
  return { joinBonus: S.join_bonus };
}

module.exports = { onCleared, safeSend };
