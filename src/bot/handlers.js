// All Telegram bot logic.
const { Markup } = require('telegraf');
const cfg = require('../config');
const bot = require('./instance');
const repo = require('../db/repo');
const { missingChannels } = require('../services/channels');
const { onCleared, safeSend } = require('../services/referral');
const wdService = require('../services/withdrawals');
const { BTN, mainKeyboard, sendWelcome, joinScreen, verifyScreen, refLink } = require('./ui');
const { inr, parseRupees, esc, duration, dateIST, isUpi, displayName, maskUpi } = require('../utils');

const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
const LINE = '━━━━━━━━━━━━━━━━━━';
const cancelKb = Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'cancel')]]);

/* ───────────── helpers ───────────── */
async function editOrReply(ctx, text, extra = {}) {
  if (ctx.callbackQuery && ctx.callbackQuery.message && !ctx.callbackQuery.message.photo) {
    try {
      return await ctx.editMessageText(text, { ...HTML, ...extra });
    } catch (e) {
      if (String(e.description || '').includes('not modified')) return;
    }
  }
  return ctx.reply(text, { ...HTML, ...extra });
}

const answer = (ctx, text, alert = false) =>
  ctx.callbackQuery ? ctx.answerCbQuery(text, { show_alert: alert }).catch(() => {}) : Promise.resolve();

async function clearState(ctx) {
  if (ctx.u && ctx.u.state) {
    await repo.setState(ctx.u.id, null);
    ctx.u = { ...ctx.u, state: null };
  }
}

/** Channel + device gate. Returns true when the user may use the bot. */
async function gate(ctx) {
  const S = ctx.S;
  const u = ctx.u;
  const missing = await missingChannels(u.id, S.channelList);
  if (missing.length) {
    const s = joinScreen(missing);
    await ctx.reply(s.text, s.extra);
    return false;
  }
  if (!u.verified) {
    if (S.device_verify) {
      const s = verifyScreen();
      await ctx.reply(s.text, s.extra);
      return false;
    }
    if (await repo.markVerified(u.id)) await onCleared(u.id);
    ctx.u = await repo.getUser(u.id, true);
  }
  return true;
}

/** Wrap a handler: clears pending input state and enforces the gate. */
const guarded = (fn) => async (ctx) => {
  await clearState(ctx);
  if (ctx.callbackQuery) await answer(ctx);
  if (!(await gate(ctx))) return;
  return fn(ctx);
};

/* ───────────── global middleware ───────────── */
bot.use(async (ctx, next) => {
  const from = ctx.from;
  if (!from || from.is_bot) return;
  if (ctx.chat && ctx.chat.type !== 'private') return;

  // Track users who block / unblock the bot.
  if (ctx.myChatMember) {
    const st = ctx.myChatMember.new_chat_member.status;
    if (st === 'kicked') await repo.markBlocked(from.id).catch(() => {});
    else if (st === 'member') await repo.updateUser(from.id, { is_blocked: 0 }).catch(() => {});
    return;
  }

  ctx.S = await repo.settings();
  let u = await repo.getUser(from.id);

  if (!u) {
    let refId = null;
    const text = ctx.message && ctx.message.text;
    const m = text && text.match(/^\/start(?:@\w+)?\s+(?:ref_?)?(\d{1,16})$/i);
    if (m) {
      const rid = Number(m[1]);
      if (rid !== from.id) {
        const r = await repo.getUser(rid);
        if (r && !r.is_banned) refId = rid;
      }
    }
    const created = await repo.createUser({
      id: from.id,
      username: from.username,
      first_name: from.first_name,
      referred_by: refId,
    });
    u = await repo.getUser(from.id, true);
    if (created && refId && ctx.S.notify_new_ref) {
      safeSend(
        refId,
        `👀 <b>New user joined via your link!</b>\n\n👤 ${esc(from.first_name || 'User')}\n` +
          `⏳ You'll get <b>${inr(ctx.S.refer_bonus)}</b> as soon as they join the channels and verify their device.`
      );
    }
  } else {
    await repo.touchUser(u, from).catch(() => {});
  }
  ctx.u = u;

  const admin = cfg.isAdmin(from.id);
  if (u.is_banned && !admin) {
    const msg = `🚫 <b>Your account has been suspended.</b>${u.ban_reason ? `\n\n📝 Reason: <i>${esc(u.ban_reason)}</i>` : ''}`;
    if (ctx.callbackQuery) return answer(ctx, '🚫 Your account is suspended.', true);
    return ctx.reply(msg, { ...HTML, reply_markup: { remove_keyboard: true } });
  }
  if (ctx.S.maintenance && !admin) {
    if (ctx.callbackQuery) return answer(ctx, '🛠 Bot is under maintenance. Please come back soon!', true);
    return ctx.reply('🛠 <b>Under Maintenance</b>\n\nWe are upgrading the bot. Please check back in a little while 🙏', HTML);
  }
  return next();
});

/* ───────────── start & gates ───────────── */
bot.start(async (ctx) => {
  await clearState(ctx);
  if (await gate(ctx)) await sendWelcome(ctx.from.id, ctx.S, ctx.u);
});

bot.command('menu', guarded((ctx) => ctx.reply('📋 <b>Main Menu</b>', { ...HTML, ...mainKeyboard() })));

bot.action('check_join', async (ctx) => {
  const missing = await missingChannels(ctx.from.id, ctx.S.channelList, { fresh: true });
  if (missing.length) return answer(ctx, '❌ You have not joined all channels yet!', true);
  await answer(ctx, '✅ Thanks for joining!');
  await ctx.deleteMessage().catch(() => {});
  if (await gate(ctx)) await sendWelcome(ctx.from.id, ctx.S, ctx.u);
});

bot.action('noop', (ctx) => answer(ctx));

bot.action('cancel', async (ctx) => {
  await clearState(ctx);
  await answer(ctx, 'Cancelled');
  await editOrReply(ctx, '❌ <b>Cancelled.</b>');
});

/* ───────────── balance ───────────── */
async function showBalance(ctx) {
  const u = await repo.getUser(ctx.from.id, true);
  const rc = await repo.referralCounts(u.id);
  const text = [
    '💰 <b>My Wallet</b>',
    LINE,
    `💳 <b>Available Balance:</b>  <b>${inr(u.balance)}</b>`,
    '',
    `📈 Total Earned:  ${inr(u.total_earned)}`,
    `💸 Total Withdrawn:  ${inr(u.total_withdrawn)}`,
    `👥 Referrals:  <b>${u.referrals}</b>${rc.pending ? `  (⏳ ${rc.pending} pending)` : ''}`,
    `🏦 UPI:  ${u.upi ? `<code>${esc(maskUpi(u.upi))}</code>` : '<i>Not set</i>'}`,
    LINE,
    `🆔 <code>${u.id}</code>  •  Joined ${dateIST(u.created_at, false)}`,
  ].join('\n');
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('💸 Withdraw', 'wd'), Markup.button.callback('📜 History', 'hist')],
    [Markup.button.callback('👥 My Referrals', 'myrefs'), Markup.button.callback('🔄 Refresh', 'bal')],
  ]);
  return editOrReply(ctx, text, kb);
}
bot.hears(BTN.balance, guarded(showBalance));
bot.command('balance', guarded(showBalance));
bot.action('bal', guarded(showBalance));

/* ───────────── refer & earn ───────────── */
async function showRefer(ctx) {
  const S = ctx.S;
  const u = await repo.getUser(ctx.from.id, true);
  const link = refLink(u.id);
  const rank = u.referrals ? await repo.userRank(u.id, u.referrals) : null;
  const ms = Object.entries(S.milestoneMap)
    .map(([n, amt]) => [Number(n), amt])
    .sort((a, b) => a[0] - b[0]);
  const next = ms.find(([n]) => n > u.referrals);

  const lines = [
    '👥 <b>Refer & Earn</b>',
    LINE,
    `🎯 Earn <b>${inr(S.refer_bonus)}</b> for every friend who joins &amp; verifies!`,
    '',
    '🔗 <b>Your personal link</b> (tap to copy):',
    `<code>${link}</code>`,
    '',
    '📊 <b>Your Stats</b>',
    `• Referrals: <b>${u.referrals}</b>`,
    `• Earned from referrals: <b>${inr(u.ref_earned)}</b>`,
    rank ? `• Leaderboard rank: <b>#${rank}</b>` : null,
  ];
  if (ms.length) {
    lines.push('', '🏅 <b>Milestone Bonuses</b>');
    for (const [n, amt] of ms) lines.push(`${u.referrals >= n ? '✅' : '▫️'} ${n} referrals → <b>+${inr(amt)}</b>`);
    if (next) {
      const pct = Math.min(10, Math.floor((u.referrals / next[0]) * 10));
      lines.push('', `Next: ${'🟩'.repeat(pct)}${'⬜'.repeat(10 - pct)} ${u.referrals}/${next[0]}`);
    }
  }
  lines.push(LINE, '⚠️ <i>Only real users on unique devices are counted.</i>');

  const shareText = `💸 Earn real money on Telegram! Join with my link and get paid via UPI 👇`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.url('📤 Share with Friends', `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(shareText)}`)],
    [Markup.button.callback('👥 My Referrals', 'myrefs'), Markup.button.callback('🏆 Leaderboard', 'top')],
  ]);
  return editOrReply(ctx, lines.filter((l) => l !== null).join('\n'), kb);
}
bot.hears(BTN.refer, guarded(showRefer));
bot.command('refer', guarded(showRefer));
bot.action('refer', guarded(showRefer));

bot.action(
  'myrefs',
  guarded(async (ctx) => {
    const rows = await repo.myReferrals(ctx.from.id, 20);
    const rc = await repo.referralCounts(ctx.from.id);
    const lines = ['👥 <b>My Referrals</b>', LINE];
    if (!rows.length) lines.push('😕 No referrals yet.\n\nShare your link and start earning! 🚀');
    rows.forEach((r, i) => {
      const st = r.ref_credited === 1 ? '✅' : r.ref_credited === 2 ? '🚫' : '⏳';
      lines.push(`${i + 1}. ${st} ${esc(displayName(r))} — <i>${dateIST(r.created_at, false)}</i>`);
    });
    lines.push(LINE, `Total joined: <b>${rc.total}</b>  •  Pending: <b>${rc.pending}</b>`, '✅ Credited  ⏳ Pending verify  🚫 Rejected');
    return editOrReply(ctx, lines.join('\n'), Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'refer')]]));
  })
);

/* ───────────── history ───────────── */
const TX_ICON = { referral: '👥', daily: '🎁', join: '🎉', code: '🎟', milestone: '🏅', admin: '🛠', withdraw: '💸', refund: '↩️' };
bot.action(
  'hist',
  guarded(async (ctx) => {
    const tx = await repo.userTx(ctx.from.id, 12);
    const wds = await repo.userWithdrawals(ctx.from.id, 5);
    const lines = ['📜 <b>Transaction History</b>', LINE];
    if (!tx.length) lines.push('<i>No transactions yet.</i>');
    for (const t of tx) {
      lines.push(`${TX_ICON[t.type] || '•'} <b>${t.amount > 0 ? '+' : ''}${inr(t.amount)}</b> — ${esc(t.note || t.type)}\n     <i>${dateIST(t.created_at)}</i>`);
    }
    if (wds.length) {
      lines.push('', '💸 <b>Recent Withdrawals</b>');
      const ic = { pending: '⏳', approved: '✅', rejected: '❌' };
      for (const w of wds) lines.push(`${ic[w.status]} #${w.id} • ${inr(w.amount)} • ${w.status}`);
    }
    return editOrReply(ctx, lines.join('\n'), Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'bal')]]));
  })
);

/* ───────────── daily bonus ───────────── */
async function daily(ctx) {
  const S = ctx.S;
  if (!S.daily_bonus_enabled) return ctx.reply('🎁 Daily bonus is currently <b>disabled</b>.', HTML);
  const u = await repo.getUser(ctx.from.id, true);
  const wait = (u.last_bonus || 0) + 86400 - repo.now();
  if (wait > 0) {
    return ctx.reply(`⏳ <b>Already claimed!</b>\n\nYour next bonus unlocks in <b>${duration(wait)}</b>.`, HTML);
  }
  const min = Math.max(0, S.daily_bonus_min);
  const max = Math.max(min, S.daily_bonus_max);
  const amount = min + Math.floor(Math.random() * (max - min + 1));
  if (amount <= 0) return ctx.reply('🎁 Daily bonus is not configured yet.', HTML);
  const ok = await repo.claimDaily(u.id, amount);
  if (!ok) return ctx.reply('⏳ You have already claimed your bonus. Try again later.', HTML);
  const fresh = await repo.getUser(u.id, true);
  return ctx.reply(
    `🎁 <b>Daily Bonus Claimed!</b>\n\n✨ You received <b>${inr(amount)}</b>\n💳 New balance: <b>${inr(fresh.balance)}</b>\n\n🔁 Come back in 24 hours for more!`,
    HTML
  );
}
bot.hears(BTN.daily, guarded(daily));
bot.command('bonus', guarded(daily));

/* ───────────── wallet / UPI ───────────── */
async function showWallet(ctx) {
  const u = await repo.getUser(ctx.from.id, true);
  const text = [
    '🏦 <b>Withdrawal Wallet</b>',
    LINE,
    `💳 Method: <b>UPI</b>`,
    `🆔 UPI ID: ${u.upi ? `<code>${esc(u.upi)}</code>` : '<i>Not set</i>'}`,
    LINE,
    u.upi ? '✏️ You can change it anytime (if no withdrawal is pending).' : '👇 Set your UPI ID to receive payments.',
  ].join('\n');
  return editOrReply(ctx, text, Markup.inlineKeyboard([[Markup.button.callback(u.upi ? '✏️ Change UPI' : '➕ Set UPI', 'set_upi')]]));
}
bot.hears(BTN.wallet, guarded(showWallet));
bot.command('wallet', guarded(showWallet));

bot.action(
  'set_upi',
  guarded(async (ctx) => {
    const p = await repo.pendingWithdrawal(ctx.from.id);
    if (p) return ctx.reply(`⏳ You can't change UPI while withdrawal <b>#${p.id}</b> is pending.`, HTML);
    await repo.setState(ctx.from.id, 'set_upi');
    return ctx.reply(
      '✏️ <b>Send your UPI ID</b>\n\nExamples:\n• <code>9876543210@paytm</code>\n• <code>name@okaxis</code>\n• <code>name@ybl</code>',
      { ...HTML, ...cancelKb }
    );
  })
);

/* ───────────── withdraw ───────────── */
async function withdrawPrecheck(u, S) {
  if (!S.withdraw_enabled) return '🚫 <b>Withdrawals are temporarily disabled.</b>\nPlease try again later.';
  if (!u.upi) return 'NO_UPI';
  if (u.referrals < S.min_refs_withdraw) {
    return (
      `👥 <b>More referrals needed</b>\n\nYou need at least <b>${S.min_refs_withdraw}</b> verified referrals to withdraw.\n` +
      `You have <b>${u.referrals}</b> — invite <b>${S.min_refs_withdraw - u.referrals}</b> more! 🚀`
    );
  }
  if (u.balance < S.min_withdraw) {
    return `💰 <b>Insufficient balance</b>\n\nMinimum withdrawal: <b>${inr(S.min_withdraw)}</b>\nYour balance: <b>${inr(u.balance)}</b>\n\nKeep referring to reach the minimum! 💪`;
  }
  const p = await repo.pendingWithdrawal(u.id);
  if (p) return `⏳ You already have a pending request <b>#${p.id}</b> of <b>${inr(p.amount)}</b>.\nPlease wait until it is processed.`;
  return null;
}

function amountError(u, S, amt) {
  if (!amt || amt <= 0) return '⚠️ Please send a valid amount, e.g. <code>50</code>';
  if (amt < S.min_withdraw) return `⚠️ Minimum withdrawal is <b>${inr(S.min_withdraw)}</b>.`;
  if (S.max_withdraw > 0 && amt > S.max_withdraw) return `⚠️ Maximum withdrawal is <b>${inr(S.max_withdraw)}</b>.`;
  if (amt > u.balance) return `⚠️ Insufficient balance. You have <b>${inr(u.balance)}</b>.`;
  return null;
}

const feeOf = (S, amt) => Math.round((amt * Math.max(0, Math.min(100, S.withdraw_fee_percent))) / 100);

async function withdrawStart(ctx) {
  const S = ctx.S;
  const u = await repo.getUser(ctx.from.id, true);
  const err = await withdrawPrecheck(u, S);
  if (err === 'NO_UPI') {
    return ctx.reply('🏦 <b>Set your UPI ID first</b>\n\nWe pay directly to your UPI.', {
      ...HTML,
      ...Markup.inlineKeyboard([[Markup.button.callback('➕ Set UPI ID', 'set_upi')]]),
    });
  }
  if (err) return ctx.reply(err, HTML);

  const maxAmt = S.max_withdraw > 0 ? Math.min(S.max_withdraw, u.balance) : u.balance;
  await repo.setState(u.id, 'wd_amount');
  const text = [
    '💸 <b>Withdraw Money</b>',
    LINE,
    `💳 Balance: <b>${inr(u.balance)}</b>`,
    `🏦 UPI: <code>${esc(u.upi)}</code>`,
    `📉 Min: ${inr(S.min_withdraw)}  •  📈 Max: ${inr(maxAmt)}`,
    S.withdraw_fee_percent ? `🧾 Fee: ${S.withdraw_fee_percent}%` : '🧾 Fee: <b>FREE</b>',
    LINE,
    '✍️ <b>Send the amount</b> you want to withdraw (in ₹), or pick one below:',
  ].join('\n');
  const quick = [Markup.button.callback(`${inr(S.min_withdraw)}`, `wda:${S.min_withdraw}`)];
  if (maxAmt > S.min_withdraw) quick.push(Markup.button.callback(`All (${inr(maxAmt)})`, `wda:${maxAmt}`));
  return ctx.reply(text, { ...HTML, ...Markup.inlineKeyboard([quick, [Markup.button.callback('❌ Cancel', 'cancel')]]) });
}
bot.hears(BTN.withdraw, guarded(withdrawStart));
bot.command('withdraw', guarded(withdrawStart));
bot.action('wd', guarded(withdrawStart));

async function withdrawConfirm(ctx, amt) {
  const S = ctx.S;
  const u = await repo.getUser(ctx.from.id, true);
  const err = amountError(u, S, amt);
  if (err) return ctx.reply(err, { ...HTML, ...cancelKb });
  const fee = feeOf(S, amt);
  await repo.setState(u.id, null);
  const text = [
    '🧾 <b>Confirm Withdrawal</b>',
    LINE,
    `💰 Amount: <b>${inr(amt)}</b>`,
    `🧾 Fee: ${inr(fee)}`,
    `✅ You will receive: <b>${inr(amt - fee)}</b>`,
    `🏦 UPI: <code>${esc(u.upi)}</code>`,
    LINE,
    '⚠️ Please make sure your UPI ID is correct.',
  ].join('\n');
  return ctx.reply(text, {
    ...HTML,
    ...Markup.inlineKeyboard([[Markup.button.callback('✅ Confirm', `wdc:${amt}`), Markup.button.callback('❌ Cancel', 'cancel')]]),
  });
}

bot.action(/^wda:(\d+)$/, async (ctx) => {
  const u = await repo.getUser(ctx.from.id, true);
  if (u.state !== 'wd_amount') return answer(ctx, 'This menu has expired. Tap 💸 Withdraw again.', true);
  await answer(ctx);
  return withdrawConfirm(ctx, Number(ctx.match[1]));
});

const wdLocks = new Set();
bot.action(/^wdc:(\d+)$/, async (ctx) => {
  const id = ctx.from.id;
  if (wdLocks.has(id)) return answer(ctx, '⏳ Processing…');
  wdLocks.add(id);
  try {
    const S = ctx.S;
    const amt = Number(ctx.match[1]);
    const u = await repo.getUser(id, true);
    const err = (await withdrawPrecheck(u, S)) || amountError(u, S, amt);
    if (err) {
      await answer(ctx, 'Cannot process this request', true);
      return editOrReply(ctx, err === 'NO_UPI' ? '🏦 Please set your UPI ID first.' : err);
    }
    const fee = feeOf(S, amt);
    const wid = await repo.createWithdrawal(id, amt, fee, u.upi);
    if (!wid) {
      await answer(ctx, 'Insufficient balance', true);
      return editOrReply(ctx, '⚠️ Insufficient balance.');
    }
    await answer(ctx, '✅ Request submitted!');
    await editOrReply(
      ctx,
      [
        '✅ <b>Withdrawal Requested!</b>',
        LINE,
        `🆔 Request ID: <b>#${wid}</b>`,
        `💰 Amount: <b>${inr(amt)}</b>`,
        `✅ You'll receive: <b>${inr(amt - fee)}</b>`,
        `🏦 UPI: <code>${esc(u.upi)}</code>`,
        `⏳ Status: <b>Pending</b>`,
        LINE,
        '🕒 Payments are usually processed within 24 hours. You will be notified here.',
      ].join('\n')
    );
    wdService.notifyAdminsNew(wid).catch((e) => console.error('[notify admins]', e.message));
  } finally {
    wdLocks.delete(id);
  }
});

/* ───────────── leaderboard ───────────── */
async function showTop(ctx) {
  const rows = await repo.leaderboard(10);
  const u = await repo.getUser(ctx.from.id);
  const medals = ['🥇', '🥈', '🥉'];
  const lines = ['🏆 <b>Top Referrers</b>', LINE];
  if (!rows.length) lines.push('<i>No referrals yet — be the first! 🚀</i>');
  rows.forEach((r, i) => {
    const me = r.id === u.id ? ' 👈 <b>You</b>' : '';
    lines.push(`${medals[i] || `<b>${i + 1}.</b>`} ${esc(displayName(r)).slice(0, 20)} — <b>${r.referrals}</b> refs${me}`);
  });
  if (u.referrals) lines.push(LINE, `📍 Your rank: <b>#${await repo.userRank(u.id, u.referrals)}</b> with <b>${u.referrals}</b> referrals`);
  else lines.push(LINE, '📍 Invite friends to enter the leaderboard!');
  return editOrReply(ctx, lines.join('\n'), Markup.inlineKeyboard([[Markup.button.callback('👥 Refer & Earn', 'refer')]]));
}
bot.hears(BTN.top, guarded(showTop));
bot.command('top', guarded(showTop));
bot.action('top', guarded(showTop));

/* ───────────── redeem code ───────────── */
async function redeemStart(ctx) {
  await repo.setState(ctx.from.id, 'redeem');
  return ctx.reply('🎟 <b>Redeem Gift Code</b>\n\nSend your gift code below 👇', { ...HTML, ...cancelKb });
}
bot.hears(BTN.redeem, guarded(redeemStart));
bot.command('redeem', guarded(redeemStart));

/* ───────────── statistics ───────────── */
let statsCache = { at: 0, data: null };
async function showStats(ctx) {
  if (Date.now() - statsCache.at > 60000) statsCache = { at: Date.now(), data: await repo.stats() };
  const s = statsCache.data;
  const text = [
    '📊 <b>Bot Statistics</b>',
    LINE,
    `👥 Total Users: <b>${s.users.total.toLocaleString('en-IN')}</b>`,
    `✅ Verified Users: <b>${s.users.verified.toLocaleString('en-IN')}</b>`,
    `🆕 Joined Today: <b>${s.users.today.toLocaleString('en-IN')}</b>`,
    `🤝 Total Referrals: <b>${s.users.referrals.toLocaleString('en-IN')}</b>`,
    `💸 Total Paid Out: <b>${inr(s.wd.approved.s)}</b>`,
    `🧾 Successful Payouts: <b>${s.wd.approved.c.toLocaleString('en-IN')}</b>`,
    LINE,
    '🔒 Secured with one-device-one-account protection',
  ].join('\n');
  return ctx.reply(text, HTML);
}
bot.hears(BTN.stats, guarded(showStats));
bot.command('stats', guarded(showStats));

/* ───────────── support / help ───────────── */
async function support(ctx) {
  const S = ctx.S;
  const user = String(S.support_username || '').replace('@', '');
  const text =
    '🆘 <b>Help &amp; Support</b>\n\n' +
    '❓ <b>How it works</b>\n' +
    `1️⃣ Share your referral link\n2️⃣ Friends join channels &amp; verify device\n3️⃣ You earn <b>${inr(S.refer_bonus)}</b> per friend\n4️⃣ Withdraw to UPI from <b>${inr(S.min_withdraw)}</b>\n\n` +
    '⚠️ Fake accounts / multiple accounts on the same device are not counted and may be banned.';
  const kb = user ? Markup.inlineKeyboard([[Markup.button.url('💬 Contact Support', `https://t.me/${user}`)]]) : {};
  return ctx.reply(text, { ...HTML, ...kb });
}
bot.hears(BTN.support, guarded(support));
bot.help(guarded(support));

/* ───────────── admin quick tools in bot ───────────── */
bot.command('admin', async (ctx) => {
  if (!cfg.isAdmin(ctx.from.id)) return;
  const s = await repo.stats();
  const text = [
    '🛠 <b>Admin Dashboard</b>',
    LINE,
    `👥 Users: <b>${s.users.total}</b>  (today +${s.users.today})`,
    `✅ Verified: <b>${s.users.verified}</b>  •  🚫 Banned: ${s.users.banned}`,
    `🟢 Active 24h: <b>${s.users.active24}</b>`,
    `⏳ Pending withdrawals: <b>${s.wd.pending.c}</b> (${inr(s.wd.pending.s)})`,
    `✅ Paid: <b>${inr(s.wd.approved.s)}</b>`,
    `💳 Users' balance: ${inr(s.users.balance)}`,
    `🕵️ Fraud attempts 24h: <b>${s.fraud24}</b>`,
  ].join('\n');
  const kb = cfg.PUBLIC_URL ? Markup.inlineKeyboard([[Markup.button.url('🖥 Open Admin Panel', `${cfg.PUBLIC_URL}/admin`)]]) : {};
  return ctx.reply(text, { ...HTML, ...kb });
});

bot.action(/^aw([ar]):(\d+)$/, async (ctx) => {
  if (!cfg.isAdmin(ctx.from.id)) return answer(ctx, 'Not allowed', true);
  const id = Number(ctx.match[2]);
  const w = ctx.match[1] === 'a' ? await wdService.approve(id, null) : await wdService.reject(id, 'Rejected by admin', true);
  if (!w) return answer(ctx, 'Already processed', true);
  await answer(ctx, ctx.match[1] === 'a' ? '✅ Marked as paid' : '❌ Rejected & refunded');
  const original = ctx.callbackQuery.message.text || '';
  const status = ctx.match[1] === 'a' ? '✅ <b>PAID</b>' : '❌ <b>REJECTED (refunded)</b>';
  return ctx
    .editMessageText(`${esc(original)}\n\n${status} by ${esc(ctx.from.first_name)} • ${dateIST(repo.now())}`, HTML)
    .catch(() => {});
});

/* ───────────── free-text input (states) ───────────── */
bot.on('text', async (ctx) => {
  const st = ctx.u.state;
  const text = ctx.message.text.trim();

  if (st === 'set_upi') {
    if (!isUpi(text)) return ctx.reply('⚠️ <b>Invalid UPI ID.</b> Example: <code>name@okaxis</code>', { ...HTML, ...cancelKb });
    await repo.updateUser(ctx.from.id, { upi: text, state: null });
    return ctx.reply(`✅ <b>UPI saved!</b>\n\n🏦 <code>${esc(text)}</code>`, { ...HTML, ...mainKeyboard() });
  }

  if (st === 'wd_amount') {
    const amt = parseRupees(text);
    if (amt == null) return ctx.reply('⚠️ Send only the amount in rupees, e.g. <code>50</code>', { ...HTML, ...cancelKb });
    return withdrawConfirm(ctx, amt);
  }

  if (st === 'redeem') {
    await repo.setState(ctx.from.id, null);
    const r = await repo.redeemCode(ctx.from.id, text);
    const msgs = {
      invalid: '❌ <b>Invalid code.</b> Please check and try again.',
      expired: '⌛ <b>This code has expired.</b>',
      exhausted: '😕 <b>This code has been fully redeemed.</b>',
      used: '⚠️ <b>You have already used this code.</b>',
    };
    if (r.error) return ctx.reply(msgs[r.error], { ...HTML, ...mainKeyboard() });
    const u = await repo.getUser(ctx.from.id, true);
    return ctx.reply(`🎉 <b>Code Redeemed!</b>\n\n💰 <b>+${inr(r.amount)}</b> added\n💳 Balance: <b>${inr(u.balance)}</b>`, {
      ...HTML,
      ...mainKeyboard(),
    });
  }

  if (!(await gate(ctx))) return;
  return ctx.reply('🤖 Please use the menu buttons below 👇', mainKeyboard());
});

bot.catch(async (err, ctx) => {
  console.error('[bot error]', ctx && ctx.updateType, err);
  try {
    if (ctx && ctx.callbackQuery) await ctx.answerCbQuery('⚠️ Something went wrong. Please try again.', { show_alert: true });
    else if (ctx && ctx.chat) await ctx.reply('⚠️ Something went wrong. Please try again in a moment.');
  } catch {
    /* ignore */
  }
});

const COMMANDS = [
  { command: 'start', description: '🏠 Start / main menu' },
  { command: 'balance', description: '💰 My balance' },
  { command: 'refer', description: '👥 Refer & earn' },
  { command: 'withdraw', description: '💸 Withdraw to UPI' },
  { command: 'bonus', description: '🎁 Daily bonus' },
  { command: 'top', description: '🏆 Leaderboard' },
  { command: 'help', description: '🆘 Help & support' },
];

module.exports = { COMMANDS };
