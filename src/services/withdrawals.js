// Withdrawal approval / rejection shared by the admin panel and in-bot admin buttons.
const { Markup } = require('telegraf');
const cfg = require('../config');
const repo = require('../db/repo');
const bot = require('../bot/instance');
const { safeSend } = require('./referral');
const { inr, esc, displayName, dateIST } = require('../utils');

function adminCard(w, u) {
  return (
    `🆕 <b>Withdrawal Request #${w.id}</b>\n\n` +
    `👤 ${esc(displayName(u))} ${u.username ? '(@' + esc(u.username) + ')' : ''}\n` +
    `🆔 <code>${u.id}</code>\n` +
    `👥 Referrals: <b>${u.referrals}</b>\n\n` +
    `💰 Amount: <b>${inr(w.amount)}</b>\n` +
    `🧾 Fee: ${inr(w.fee)}  •  Pay: <b>${inr(w.net)}</b>\n` +
    `🏦 UPI: <code>${esc(w.upi)}</code>\n` +
    `🕒 ${dateIST(w.created_at)}`
  );
}

async function notifyAdminsNew(id) {
  const w = await repo.getWithdrawal(id);
  const u = await repo.getUser(w.user_id, true);
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('✅ Mark Paid', `awa:${id}`), Markup.button.callback('❌ Reject + Refund', `awr:${id}`)],
    ...(cfg.PUBLIC_URL ? [[Markup.button.url('🖥 Open Panel', `${cfg.PUBLIC_URL}/admin/withdrawals`)]] : []),
  ]);
  for (const admin of cfg.ADMIN_IDS) {
    await bot.telegram.sendMessage(admin, adminCard(w, u), { parse_mode: 'HTML', ...kb }).catch(() => {});
  }
}

async function approve(id, utr) {
  const w = await repo.approveWithdrawal(id, utr);
  if (!w) return null;
  await safeSend(
    w.user_id,
    `✅ <b>Withdrawal Successful!</b>\n\n` +
      `💸 <b>${inr(w.net)}</b> has been sent to your UPI\n` +
      `🏦 <code>${esc(w.upi)}</code>\n` +
      (utr ? `🧾 UTR / Ref: <code>${esc(utr)}</code>\n` : '') +
      `🆔 Request: #${w.id}\n\n` +
      `🙏 Thank you! Keep referring and keep earning 🚀`
  );
  const S = await repo.settings();
  if (S.payout_channel) {
    const name = (w.first_name || 'User').slice(0, 2) + '•••';
    const link = `https://t.me/${bot.botInfo ? bot.botInfo.username : ''}`;
    await bot.telegram
      .sendMessage(
        S.payout_channel,
        `💸 <b>New Payment Sent!</b>\n\n` +
          `👤 User: <b>${esc(name)}</b> (<code>${String(w.user_id).slice(0, 4)}••••</code>)\n` +
          `💰 Amount: <b>${inr(w.net)}</b>\n` +
          `🏦 Method: UPI\n` +
          `✅ Status: Paid\n\n` +
          `🤖 Start earning: ${link}`,
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      )
      .catch((e) => console.warn('[payout channel]', e.description || e.message));
  }
  return w;
}

async function reject(id, reason, refund = true) {
  const w = await repo.rejectWithdrawal(id, reason, refund);
  if (!w) return null;
  await safeSend(
    w.user_id,
    `❌ <b>Withdrawal #${w.id} Rejected</b>\n\n` +
      `💰 Amount: ${inr(w.amount)}\n` +
      (reason ? `📝 Reason: <i>${esc(reason)}</i>\n` : '') +
      (refund ? `\n↩️ ${inr(w.amount)} has been refunded to your balance.` : '')
  );
  return w;
}

module.exports = { notifyAdminsNew, approve, reject, adminCard };
