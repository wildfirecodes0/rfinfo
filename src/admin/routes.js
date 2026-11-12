// Admin panel routes.
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const cfg = require('../config');
const repo = require('../db/repo');
const r2 = require('../storage/r2');
const bot = require('../bot/instance');
const wd = require('../services/withdrawals');
const broadcast = require('../services/broadcast');
const backup = require('../services/backup');
const { safeSend } = require('../services/referral');
const auth = require('./auth');
const { layout, loginPage, pager, statCard } = require('./layout');
const { inr, esc, dateIST, parseRupees, displayName, isUpi } = require('../utils');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)),
});
router.use(express.urlencoded({ extended: false, limit: '200kb' }));

const h = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    console.error('[admin]', e);
    res.status(500).send(
      layout({ title: 'Error', active: '', admin: req.admin, body: `<div class="card"><h3>⚠️ Something went wrong</h3><p class="mono">${esc(e.message)}</p><a class="btn ghost" href="javascript:history.back()">← Back</a></div>` })
    );
  }
};
const flash = (req) => ({ ok: req.query.ok, err: req.query.err });
const back = (res, url, type, msg) => res.redirect(`${url}${url.includes('?') ? '&' : '?'}${type}=${encodeURIComponent(msg)}`);
const page = (req) => Math.max(1, parseInt(req.query.page, 10) || 1);
const render = (req, res, title, active, body) => res.send(layout({ title, active, body, flash: flash(req), admin: req.admin }));
const userLink = (id, name) => `<a href="/admin/users/${id}">${esc(name || id)}</a>`;
const wdBadge = (s) => `<span class="b ${s === 'approved' ? 'ok' : s === 'rejected' ? 'bad' : 'warn'}">${esc(s)}</span>`;
const rupeesVal = (p) => (Number(p) / 100).toString();

/* ───────────── auth ───────────── */
router.get('/login', (req, res) => res.send(loginPage()));
router.post('/login', (req, res) => {
  const ip = req.ip;
  if (auth.isLocked(ip)) return res.status(429).send(loginPage('Too many failed attempts. Try again in 15 minutes.'));
  const { username = '', password = '' } = req.body || {};
  if (!auth.checkCredentials(username, password)) {
    auth.recordFail(ip);
    return res.status(401).send(loginPage('Invalid username or password'));
  }
  auth.clearFails(ip);
  auth.setSession(req, res, username);
  res.redirect('/admin');
});
router.post('/logout', (req, res) => {
  auth.clearSession(res);
  res.redirect('/admin/login');
});

router.use(auth.requireAdmin);

/* ───────────── dashboard ───────────── */
router.get(
  '/',
  h(async (req, res) => {
    const [s, days, recent, pending] = await Promise.all([
      repo.stats(),
      repo.joinsByDay(14),
      repo.recentUsers(8),
      repo.listWithdrawals('pending', 6, 0),
    ]);
    const map = Object.fromEntries(days.map((d) => [d.d, d.c]));
    const today = Math.floor((repo.now() + cfg.TZ_OFFSET_SEC) / 86400);
    const series = [];
    for (let d = today - 13; d <= today; d++) series.push({ d, c: map[d] || 0 });
    const max = Math.max(1, ...series.map((x) => x.c));
    const bars = series
      .map((x) => {
        const label = new Date(x.d * 86400000).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'UTC' });
        return `<div class="bar" title="${x.c} users"><b>${x.c}</b><i style="height:${Math.round((x.c / max) * 120)}px"></i><span>${label}</span></div>`;
      })
      .join('');
    const u = s.users;
    const body = `
<h1>Dashboard</h1><p class="sub">Live overview of @${esc(bot.botInfo ? bot.botInfo.username : 'bot')} · ${dateIST(repo.now())}</p>
<div class="grid g4">
 ${statCard('👥', 'Total Users', u.total.toLocaleString('en-IN'), `+${u.today} today`)}
 ${statCard('✅', 'Verified', u.verified.toLocaleString('en-IN'), `${u.total ? Math.round((u.verified / u.total) * 100) : 0}% of users`)}
 ${statCard('🟢', 'Active (24h)', u.active24.toLocaleString('en-IN'), `${u.blocked} blocked the bot`)}
 ${statCard('🤝', 'Referrals', u.referrals.toLocaleString('en-IN'), `${u.banned} banned users`)}
 ${statCard('⏳', 'Pending Payouts', inr(s.wd.pending.s), `${s.wd.pending.c} requests · <a href="/admin/withdrawals">review →</a>`)}
 ${statCard('💸', 'Total Paid', inr(s.wd.approved.s), `${s.wd.approved.c} payouts`)}
 ${statCard('💳', 'User Balances', inr(u.balance), `Liability · earned ${inr(u.earned)}`)}
 ${statCard('🕵️', 'Fraud (24h)', s.fraud24, `<a href="/admin/fraud">view logs →</a>`)}
</div>
<div class="grid g2" style="margin-top:16px">
 <div class="card"><h3>📈 New users — last 14 days</h3><div class="bars">${bars}</div></div>
 <div class="card"><h3>⏳ Pending withdrawals</h3><div class="tw"><table><tr><th>#</th><th>User</th><th>Amount</th><th>UPI</th><th></th></tr>
 ${pending.map((w) => `<tr><td>${w.id}</td><td>${userLink(w.user_id, w.first_name)}</td><td><b>${inr(w.net)}</b></td><td class="mono">${esc(w.upi)}</td>
 <td><form method="post" action="/admin/withdrawals/${w.id}/approve" class="inline"><button class="sm ok">✓ Paid</button></form></td></tr>`).join('') || '<tr><td colspan="5" class="muted">🎉 Nothing pending</td></tr>'}
 </table></div></div>
</div>
<div class="card" style="margin-top:16px"><h3>🆕 Recent users</h3><div class="tw"><table>
<tr><th>ID</th><th>Name</th><th>Referred by</th><th>Status</th><th>Joined</th></tr>
${recent.map((r) => `<tr><td class="mono">${r.id}</td><td>${userLink(r.id, displayName(r))}</td><td>${r.referred_by ? userLink(r.referred_by, r.referred_by) : '<span class="muted">—</span>'}</td>
<td>${r.is_banned ? '<span class="b bad">banned</span>' : r.verified ? '<span class="b ok">verified</span>' : '<span class="b mut">unverified</span>'}</td><td>${dateIST(r.created_at)}</td></tr>`).join('')}
</table></div></div>`;
    render(req, res, 'Dashboard', 'dash', body);
  })
);

/* ───────────── users ───────────── */
router.get(
  '/users',
  h(async (req, res) => {
    const q = String(req.query.q || '').trim();
    const filter = String(req.query.filter || '');
    const sort = String(req.query.sort || 'new');
    const p = page(req);
    const { rows, total } = await repo.listUsers({ q, filter, sort, limit: 25, offset: (p - 1) * 25 });
    const opt = (v, cur, label) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${label}</option>`;
    const base = `/admin/users?q=${encodeURIComponent(q)}&filter=${encodeURIComponent(filter)}&sort=${encodeURIComponent(sort)}`;
    const body = `
<h1>Users</h1><p class="sub">Search, inspect and manage every user</p>
<form class="card row" method="get" style="margin-bottom:16px">
 <input name="q" value="${esc(q)}" placeholder="🔎 Search by ID, @username, name or UPI">
 <select name="filter" class="nf" style="width:160px">${opt('', filter, 'All users')}${opt('verified', filter, 'Verified')}${opt('unverified', filter, 'Unverified')}${opt('banned', filter, 'Banned')}${opt('blocked', filter, 'Blocked bot')}</select>
 <select name="sort" class="nf" style="width:160px">${opt('new', sort, 'Newest')}${opt('refs', sort, 'Most referrals')}${opt('balance', sort, 'Highest balance')}${opt('active', sort, 'Recently active')}</select>
 <button class="nf">Search</button></form>
<div class="card"><div class="tw"><table>
<tr><th>ID</th><th>Name</th><th>Username</th><th>Refs</th><th>Balance</th><th>Earned</th><th>Status</th><th>Joined</th></tr>
${rows.map((u) => `<tr><td class="mono"><a href="/admin/users/${u.id}">${u.id}</a></td><td>${userLink(u.id, u.first_name || '—')}</td>
<td>${u.username ? '@' + esc(u.username) : '<span class="muted">—</span>'}</td><td><b>${u.referrals}</b></td><td>${inr(u.balance)}</td><td>${inr(u.total_earned)}</td>
<td>${u.is_banned ? '<span class="b bad">banned</span>' : u.verified ? '<span class="b ok">verified</span>' : '<span class="b mut">unverified</span>'} ${u.is_blocked ? '<span class="b warn">blocked</span>' : ''}</td>
<td>${dateIST(u.created_at)}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No users found</td></tr>'}
</table></div>${pager(base, p, total, 25)}</div>`;
    render(req, res, 'Users', 'users', body);
  })
);

router.get(
  '/users/:id',
  h(async (req, res) => {
    const id = Number(req.params.id);
    const u = await repo.getUser(id, true);
    if (!u) return back(res, '/admin/users', 'err', 'User not found');
    const [refs, tx, wds, dev, rc, referrer] = await Promise.all([
      repo.myReferrals(id, 25),
      repo.userTx(id, 25),
      repo.userWithdrawals(id, 15),
      repo.getDevice(id),
      repo.referralCounts(id),
      u.referred_by ? repo.getUser(u.referred_by) : null,
    ]);
    const refSt = (r) => (r.ref_credited === 1 ? '<span class="b ok">credited</span>' : r.ref_credited === 2 ? '<span class="b bad">rejected</span>' : '<span class="b warn">pending</span>');
    const body = `
<p><a href="/admin/users">← All users</a></p>
<h1>${esc(displayName(u))} ${u.is_banned ? '<span class="b bad">banned</span>' : u.verified ? '<span class="b ok">verified</span>' : '<span class="b mut">unverified</span>'}</h1>
<p class="sub">ID <span class="mono">${u.id}</span>${u.username ? ` · <a href="https://t.me/${esc(u.username)}" target="_blank" rel="noopener">@${esc(u.username)}</a>` : ''} · joined ${dateIST(u.created_at)} · last active ${dateIST(u.last_active)}</p>
<div class="grid g4">
 ${statCard('💳', 'Balance', inr(u.balance))}
 ${statCard('📈', 'Total earned', inr(u.total_earned), `${inr(u.ref_earned)} from referrals`)}
 ${statCard('💸', 'Withdrawn', inr(u.total_withdrawn))}
 ${statCard('👥', 'Referrals', u.referrals, `${rc.total} joined · ${rc.pending} pending`)}
</div>
<div class="grid g2" style="margin-top:16px">
 <div class="card"><h3>👤 Profile</h3><div class="kv">
  <div>UPI</div><div class="mono">${esc(u.upi || '—')}</div>
  <div>Referred by</div><div>${referrer ? userLink(referrer.id, displayName(referrer)) : '—'} ${u.referred_by ? refSt(u) : ''}</div>
  <div>Ban reason</div><div>${esc(u.ban_reason || '—')}</div>
  <div>Bot blocked</div><div>${u.is_blocked ? 'Yes' : 'No'}</div>
  <div>Device IP</div><div class="mono">${esc(dev ? dev.ip : '—')}</div>
  <div>Platform</div><div>${esc(dev ? dev.platform : '—')}</div>
  <div>Fingerprint</div><div class="mono" style="word-break:break-all">${esc(dev ? dev.fp_hash.slice(0, 24) + '…' : '—')}</div>
  <div>User agent</div><div style="font-size:12px;word-break:break-all">${esc(dev ? dev.ua : '—')}</div>
 </div></div>
 <div class="card"><h3>🛠 Actions</h3>
  <form method="post" action="/admin/users/${id}/balance"><label>Adjust balance (₹)</label><div class="row">
   <select name="mode" class="nf" style="width:110px"><option value="add">➕ Add</option><option value="sub">➖ Deduct</option></select>
   <input name="amount" placeholder="Amount e.g. 10" required><input name="note" placeholder="Note (optional)"><button class="nf">Apply</button></div></form>
  <form method="post" action="/admin/users/${id}/upi"><label>UPI ID</label><div class="row"><input name="upi" value="${esc(u.upi || '')}" placeholder="name@bank"><button class="nf ghost">Save</button></div></form>
  <form method="post" action="/admin/users/${id}/message"><label>Send message (HTML allowed)</label><textarea name="text" style="min-height:70px" required></textarea><button style="margin-top:8px" class="ghost">📨 Send</button></form>
  <div class="row" style="margin-top:14px">
   ${u.is_banned
     ? `<form method="post" action="/admin/users/${id}/unban" class="nf"><button class="ok">✓ Unban</button></form>`
     : `<form method="post" action="/admin/users/${id}/ban" class="row nf"><input name="reason" placeholder="Ban reason" style="width:180px"><button class="bad nf">🚫 Ban</button></form>`}
   <form method="post" action="/admin/users/${id}/reset-device" class="nf" onsubmit="return confirm('Reset device link? The user will need to verify again.')"><button class="ghost">♻️ Reset device</button></form>
  </div>
 </div>
</div>
<div class="grid g2" style="margin-top:16px">
 <div class="card"><h3>👥 Referrals (latest 25)</h3><div class="tw"><table><tr><th>User</th><th>Status</th><th>Joined</th></tr>
 ${refs.map((r) => `<tr><td>${userLink(r.id, displayName(r))}</td><td>${refSt(r)}</td><td>${dateIST(r.created_at)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">None</td></tr>'}</table></div></div>
 <div class="card"><h3>💸 Withdrawals</h3><div class="tw"><table><tr><th>#</th><th>Amount</th><th>UPI</th><th>Status</th><th>Date</th></tr>
 ${wds.map((w) => `<tr><td>${w.id}</td><td>${inr(w.amount)}</td><td class="mono">${esc(w.upi)}</td><td>${wdBadge(w.status)}</td><td>${dateIST(w.created_at)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">None</td></tr>'}</table></div></div>
</div>
<div class="card" style="margin-top:16px"><h3>📜 Transactions (latest 25)</h3><div class="tw"><table><tr><th>#</th><th>Amount</th><th>Type</th><th>Note</th><th>Date</th></tr>
${tx.map((t) => `<tr><td>${t.id}</td><td style="color:${t.amount < 0 ? 'var(--bad)' : 'var(--ok)'}"><b>${t.amount > 0 ? '+' : ''}${inr(t.amount)}</b></td><td><span class="b acc">${esc(t.type)}</span></td><td>${esc(t.note || '')}</td><td>${dateIST(t.created_at)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">None</td></tr>'}
</table></div></div>`;
    render(req, res, displayName(u), 'users', body);
  })
);

router.post(
  '/users/:id/balance',
  h(async (req, res) => {
    const id = Number(req.params.id);
    const url = `/admin/users/${id}`;
    const amt = parseRupees(req.body.amount);
    if (!amt) return back(res, url, 'err', 'Enter a valid amount');
    const signed = req.body.mode === 'sub' ? -amt : amt;
    const note = String(req.body.note || '').slice(0, 200) || (signed > 0 ? 'Added by admin' : 'Deducted by admin');
    const ok = await repo.addBalance(id, signed, 'admin', note);
    if (!ok) return back(res, url, 'err', 'Failed — balance cannot go below zero');
    if (signed > 0) safeSend(id, `💰 <b>${inr(signed)}</b> has been credited to your balance.\n📝 ${esc(note)}`);
    back(res, url, 'ok', `${signed > 0 ? 'Added' : 'Deducted'} ${inr(Math.abs(signed))}`);
  })
);

router.post(
  '/users/:id/upi',
  h(async (req, res) => {
    const id = Number(req.params.id);
    const upi = String(req.body.upi || '').trim();
    if (upi && !isUpi(upi)) return back(res, `/admin/users/${id}`, 'err', 'Invalid UPI format');
    await repo.updateUser(id, { upi: upi || null });
    back(res, `/admin/users/${id}`, 'ok', 'UPI updated');
  })
);

router.post(
  '/users/:id/message',
  h(async (req, res) => {
    const id = Number(req.params.id);
    try {
      await bot.telegram.sendMessage(id, String(req.body.text || ''), { parse_mode: 'HTML' });
      back(res, `/admin/users/${id}`, 'ok', 'Message sent');
    } catch (e) {
      back(res, `/admin/users/${id}`, 'err', 'Telegram: ' + (e.description || e.message));
    }
  })
);

router.post(
  '/users/:id/ban',
  h(async (req, res) => {
    const id = Number(req.params.id);
    const reason = String(req.body.reason || '').slice(0, 200) || 'Violation of rules';
    await repo.updateUser(id, { is_banned: 1, ban_reason: reason });
    safeSend(id, `🚫 <b>Your account has been suspended.</b>\n📝 Reason: <i>${esc(reason)}</i>`, { reply_markup: { remove_keyboard: true } });
    back(res, `/admin/users/${id}`, 'ok', 'User banned');
  })
);

router.post(
  '/users/:id/unban',
  h(async (req, res) => {
    const id = Number(req.params.id);
    await repo.updateUser(id, { is_banned: 0, ban_reason: null });
    safeSend(id, '✅ <b>Your account has been restored.</b> Press /start to continue.');
    back(res, `/admin/users/${id}`, 'ok', 'User unbanned');
  })
);

router.post(
  '/users/:id/reset-device',
  h(async (req, res) => {
    const id = Number(req.params.id);
    await repo.resetDevice(id);
    back(res, `/admin/users/${id}`, 'ok', 'Device link removed — user must verify again');
  })
);

/* ───────────── withdrawals ───────────── */
router.get(
  '/withdrawals',
  h(async (req, res) => {
    const status = ['pending', 'approved', 'rejected', 'all'].includes(req.query.status) ? req.query.status : 'pending';
    const st = status === 'all' ? null : status;
    const p = page(req);
    const [rows, total, counts] = await Promise.all([
      repo.listWithdrawals(st, 30, (p - 1) * 30),
      repo.countWithdrawals(st),
      repo.stats(),
    ]);
    const tab = (s, label) => `<a href="/admin/withdrawals?status=${s}" class="${status === s ? 'on' : ''}">${label}</a>`;
    const body = `
<h1>Withdrawals</h1><p class="sub">Pay users via UPI, then mark as paid (with optional UTR). Rejected requests are refunded automatically.</p>
<div class="row" style="margin-bottom:6px"><div class="tabs nf" style="margin:0">${tab('pending', `⏳ Pending (${counts.wd.pending.c})`)}${tab('approved', '✅ Paid')}${tab('rejected', '❌ Rejected')}${tab('all', 'All')}</div>
<a class="btn ghost nf" href="/admin/withdrawals.csv?status=${status}">⬇️ Export CSV</a></div>
<div class="card" style="margin-top:12px"><div class="tw"><table>
<tr><th>#</th><th>User</th><th>Refs</th><th>Amount</th><th>Pay (net)</th><th>UPI</th><th>Status</th><th>Requested</th><th>Action / Info</th></tr>
${rows.map((w) => `<tr><td>${w.id}</td><td>${userLink(w.user_id, w.first_name || w.user_id)}${w.username ? `<div class="muted">@${esc(w.username)}</div>` : ''}</td><td>${w.referrals ?? '—'}</td>
<td>${inr(w.amount)}</td><td><b>${inr(w.net)}</b></td><td class="mono">${esc(w.upi)}</td><td>${wdBadge(w.status)}</td><td>${dateIST(w.created_at)}</td>
<td>${w.status === 'pending' ? `
 <form method="post" action="/admin/withdrawals/${w.id}/approve" class="row" style="min-width:330px"><input name="utr" placeholder="UTR (optional)"><button class="sm ok nf">✓ Paid</button></form>
 <form method="post" action="/admin/withdrawals/${w.id}/reject" class="row" style="min-width:330px;margin-top:6px"><input name="reason" placeholder="Reject reason"><label class="chk nf" style="margin:0"><input type="checkbox" name="refund" value="1" checked>Refund</label><button class="sm bad nf">✕ Reject</button></form>`
 : `<span class="muted">${w.utr ? 'UTR ' + esc(w.utr) : esc(w.note || '')} ${w.processed_at ? '· ' + dateIST(w.processed_at) : ''}</span>`}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">Nothing here</td></tr>'}
</table></div>${pager(`/admin/withdrawals?status=${status}`, p, total, 30)}</div>`;
    render(req, res, 'Withdrawals', 'wd', body);
  })
);

router.get(
  '/withdrawals.csv',
  h(async (req, res) => {
    const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : null;
    const rows = await repo.listWithdrawals(status, 10000, 0);
    const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const csv = ['id,user_id,name,amount_inr,fee_inr,net_inr,upi,status,utr,requested_at']
      .concat(rows.map((w) => [w.id, w.user_id, q(w.first_name), w.amount / 100, w.fee / 100, w.net / 100, q(w.upi), w.status, q(w.utr), q(dateIST(w.created_at))].join(',')))
      .join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="withdrawals-${status || 'all'}.csv"`);
    res.send('﻿' + csv);
  })
);

router.post(
  '/withdrawals/:id/approve',
  h(async (req, res) => {
    const utr = String(req.body.utr || '').trim().slice(0, 64);
    const w = await wd.approve(Number(req.params.id), utr || null);
    const from = (req.get('referer') || '').includes('/admin/withdrawals') ? '/admin/withdrawals' : '/admin';
    back(res, from, w ? 'ok' : 'err', w ? `Withdrawal #${w.id} marked as paid` : 'Already processed');
  })
);

router.post(
  '/withdrawals/:id/reject',
  h(async (req, res) => {
    const reason = String(req.body.reason || '').trim().slice(0, 200);
    const w = await wd.reject(Number(req.params.id), reason, req.body.refund === '1');
    back(res, '/admin/withdrawals', w ? 'ok' : 'err', w ? `Withdrawal #${w.id} rejected` : 'Already processed');
  })
);

/* ───────────── transactions ───────────── */
router.get(
  '/transactions',
  h(async (req, res) => {
    const p = page(req);
    const [rows, total] = await Promise.all([repo.allTx(50, (p - 1) * 50), repo.txCount()]);
    const body = `<h1>Transactions</h1><p class="sub">Every balance movement in the system</p>
<div class="card"><div class="tw"><table><tr><th>#</th><th>User</th><th>Amount</th><th>Type</th><th>Note</th><th>Date</th></tr>
${rows.map((t) => `<tr><td>${t.id}</td><td>${userLink(t.user_id, t.first_name || t.user_id)}</td><td style="color:${t.amount < 0 ? 'var(--bad)' : 'var(--ok)'}"><b>${t.amount > 0 ? '+' : ''}${inr(t.amount)}</b></td>
<td><span class="b acc">${esc(t.type)}</span></td><td>${esc(t.note || '')}</td><td>${dateIST(t.created_at)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No transactions</td></tr>'}
</table></div>${pager('/admin/transactions', p, total, 50)}</div>`;
    render(req, res, 'Transactions', 'tx', body);
  })
);

/* ───────────── settings ───────────── */
router.get(
  '/settings',
  h(async (req, res) => {
    const S = await repo.settings(true);
    const chLines = S.channelList.map((c) => [c.id, c.url || '', c.title || ''].join(' | ')).join('\n');
    const chk = (k, label) => `<label class="chk"><input type="checkbox" name="${k}" value="1" ${S[k] ? 'checked' : ''}>${label}</label>`;
    const money = (k, label) => `<div><label>${label} (₹)</label><input name="${k}" value="${rupeesVal(S[k])}" inputmode="decimal"></div>`;
    const num = (k, label) => `<div><label>${label}</label><input name="${k}" value="${S[k]}" inputmode="numeric"></div>`;
    const body = `
<h1>Settings</h1><p class="sub">Changes apply instantly (cached up to 30 seconds)</p>
<form method="post" action="/admin/settings" enctype="multipart/form-data">
<div class="grid g2">
 <div class="card"><h3>🎯 Rewards</h3><div class="row">${money('refer_bonus', 'Per referral')}${money('join_bonus', 'Welcome bonus')}</div>
  ${chk('daily_bonus_enabled', 'Enable daily bonus')}
  <div class="row">${money('daily_bonus_min', 'Daily bonus min')}${money('daily_bonus_max', 'Daily bonus max')}</div>
  <label>Milestone bonuses (referrals=₹bonus, comma separated)</label><input name="milestones" value="${esc(S.milestones)}" placeholder="10=20, 50=150">
  ${chk('notify_new_ref', 'Notify referrer when someone joins with their link')}
 </div>
 <div class="card"><h3>💸 Withdrawals</h3>${chk('withdraw_enabled', 'Withdrawals enabled')}
  <div class="row">${money('min_withdraw', 'Minimum')}${money('max_withdraw', 'Maximum (0 = no limit)')}</div>
  <div class="row">${num('min_refs_withdraw', 'Min. referrals to withdraw')}${num('withdraw_fee_percent', 'Fee %')}</div>
  <label>Payment proof channel (optional, bot must be admin)</label><input name="payout_channel" value="${esc(S.payout_channel)}" placeholder="@yourpayouts or -100123…">
 </div>
 <div class="card"><h3>🛡 Security &amp; Anti-fraud</h3>
  ${chk('device_verify', 'Require device verification (one device = one account)')}
  ${chk('block_duplicate', 'Auto-ban accounts on an already-used device (otherwise: allow, but no referral reward)')}
  ${num('max_per_ip', 'Max other accounts per IP (0 = off)')}
  <p class="muted" style="font-size:12px">Tip: keep IP limit off or high (≥5) — many Indian mobile users share carrier IPs.</p>
  ${chk('maintenance', '🛠 Maintenance mode (only admins can use the bot)')}
 </div>
 <div class="card"><h3>📢 Force-join channels</h3>
  <label>One per line: <span class="mono">chat_id | invite_url | title</span></label>
  <textarea name="channels" placeholder="@mychannel | https://t.me/mychannel | Official Channel&#10;-1001234567890 | https://t.me/+AbCdEf | VIP Group">${esc(chLines)}</textarea>
  <p class="muted" style="font-size:12px">The bot must be an <b>admin</b> in every channel to check membership.</p>
 </div>
 <div class="card" style="grid-column:1/-1"><h3>💬 Messages &amp; branding</h3>
  <label>Welcome text (Telegram HTML: &lt;b&gt;, &lt;i&gt;, &lt;a href&gt;, &lt;code&gt;)</label><textarea name="welcome_text">${esc(S.welcome_text)}</textarea>
  <div class="row"><div><label>Welcome banner image URL</label><input name="welcome_photo_url" value="${esc(S.welcome_photo_url)}" placeholder="https://…/banner.jpg"></div>
  <div><label>…or upload banner to R2 ${r2.enabled && cfg.R2_PUBLIC_URL ? '' : '<span class="b warn">needs R2_PUBLIC_URL</span>'}</label><input type="file" name="welcome_photo" accept="image/*"></div></div>
  <div class="row"><div><label>Support username</label><input name="support_username" value="${esc(S.support_username)}" placeholder="@support"></div></div>
 </div>
</div>
<div style="margin-top:16px;position:sticky;bottom:12px"><button style="padding:12px 26px;box-shadow:var(--shadow)">💾 Save all settings</button></div>
</form>`;
    render(req, res, 'Settings', 'settings', body);
  })
);

router.post(
  '/settings',
  upload.single('welcome_photo'),
  h(async (req, res) => {
    const b = req.body || {};
    const money = (k) => {
      const v = parseRupees(b[k] === '' || b[k] == null ? '0' : b[k]);
      if (v == null) throw new Error(`Invalid amount for ${k}`);
      return v;
    };
    const int = (k) => Math.max(0, parseInt(b[k], 10) || 0);
    const flag = (k) => (b[k] === '1' ? 1 : 0);

    const channels = String(b.channels || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [id, url, title] = l.split('|').map((x) => (x || '').trim());
        return { id, url: url || (id.startsWith('@') ? `https://t.me/${id.slice(1)}` : ''), title: title || id };
      })
      .filter((c) => /^(@[A-Za-z0-9_]{4,}|-100\d{5,})$/.test(c.id));

    const out = {
      refer_bonus: money('refer_bonus'),
      join_bonus: money('join_bonus'),
      daily_bonus_enabled: flag('daily_bonus_enabled'),
      daily_bonus_min: money('daily_bonus_min'),
      daily_bonus_max: money('daily_bonus_max'),
      milestones: Object.entries(repo.parseMilestones(b.milestones))
        .map(([n, p]) => `${n}=${p / 100}`)
        .join(', '),
      notify_new_ref: flag('notify_new_ref'),
      withdraw_enabled: flag('withdraw_enabled'),
      min_withdraw: money('min_withdraw'),
      max_withdraw: money('max_withdraw'),
      min_refs_withdraw: int('min_refs_withdraw'),
      withdraw_fee_percent: Math.min(100, int('withdraw_fee_percent')),
      payout_channel: String(b.payout_channel || '').trim(),
      device_verify: flag('device_verify'),
      block_duplicate: flag('block_duplicate'),
      max_per_ip: int('max_per_ip'),
      maintenance: flag('maintenance'),
      channels: JSON.stringify(channels),
      welcome_text: String(b.welcome_text || '').slice(0, 3000),
      welcome_photo_url: String(b.welcome_photo_url || '').trim(),
      support_username: String(b.support_username || '').trim().replace(/^@/, ''),
    };
    if (out.daily_bonus_max < out.daily_bonus_min) out.daily_bonus_max = out.daily_bonus_min;

    if (req.file) {
      if (!r2.enabled || !cfg.R2_PUBLIC_URL) return back(res, '/admin/settings', 'err', 'Upload needs R2 + R2_PUBLIC_URL configured');
      const ext = req.file.mimetype.split('/')[1].replace('jpeg', 'jpg');
      const key = `public/welcome-${Date.now()}.${ext}`;
      await r2.put(key, req.file.buffer, req.file.mimetype);
      out.welcome_photo_url = r2.publicUrl(key);
    }
    await repo.saveSettings(out);
    back(res, '/admin/settings', 'ok', 'Settings saved');
  })
);

/* ───────────── broadcast ───────────── */
router.get(
  '/broadcast',
  h(async (req, res) => {
    const [list, reach] = await Promise.all([repo.listBroadcasts(), repo.reachableCount()]);
    const running = broadcast.isRunning();
    const body = `
<h1>Broadcast</h1><p class="sub">Send a message to all <b>${reach.toLocaleString('en-IN')}</b> reachable users (~25 msgs/sec, blocked users auto-skipped)</p>
<div class="grid g2">
<form class="card" method="post" action="/admin/broadcast" enctype="multipart/form-data"><h3>📣 New broadcast</h3>
 <label>Message (Telegram HTML)</label><textarea name="text" placeholder="🔥 &lt;b&gt;Bonus weekend!&lt;/b&gt; Refer now and earn double…"></textarea>
 <label>Image (optional, max 5MB${r2.enabled ? ', stored in R2' : ''})</label><input type="file" name="image" accept="image/*">
 <div class="row"><div><label>Button text (optional)</label><input name="button_text" placeholder="🚀 Open"></div><div><label>Button URL</label><input name="button_url" placeholder="https://t.me/…"></div></div>
 <div class="row" style="margin-top:16px"><button name="action" value="test" class="ghost nf">🧪 Send test to admins</button>
 <button name="action" value="send" class="nf" ${running ? 'disabled' : ''} onclick="return confirm('Send this broadcast to all users?')">🚀 Send to everyone</button></div>
 ${running ? '<p class="muted">A broadcast is currently running…</p>' : ''}
</form>
<div class="card"><h3>📋 History</h3>${running ? `<form method="post" action="/admin/broadcast/cancel"><button class="sm bad">⏹ Stop running broadcast</button></form>` : ''}
<div class="tw"><table><tr><th>#</th><th>Message</th><th>Progress</th><th>Status</th><th>Date</th></tr>
${list.map((b) => {
  const pct = b.total ? Math.round(((b.sent + b.failed) / b.total) * 100) : 0;
  return `<tr><td>${b.id}</td><td style="max-width:220px;overflow:hidden;text-overflow:ellipsis">${b.image_key ? '🖼 ' : ''}${esc((b.text || '').slice(0, 60))}</td>
  <td style="min-width:140px"><div class="progress"><i style="width:${pct}%"></i></div><span class="muted" style="font-size:11px">✅ ${b.sent} · ❌ ${b.failed} / ${b.total}</span></td>
  <td><span class="b ${b.status === 'done' ? 'ok' : b.status === 'running' ? 'acc' : b.status === 'queued' ? 'mut' : 'bad'}">${esc(b.status)}</span></td><td>${dateIST(b.created_at)}</td></tr>`;
}).join('') || '<tr><td colspan="5" class="muted">No broadcasts yet</td></tr>'}
</table></div>${running ? '<p class="muted" style="font-size:12px">Refresh the page to update progress.</p>' : ''}</div></div>`;
    render(req, res, 'Broadcast', 'bc', body);
  })
);

router.post(
  '/broadcast',
  upload.single('image'),
  h(async (req, res) => {
    const text = String(req.body.text || '').trim();
    const button_text = String(req.body.button_text || '').trim().slice(0, 64);
    const button_url = String(req.body.button_url || '').trim();
    if (!text && !req.file) return back(res, '/admin/broadcast', 'err', 'Write a message or attach an image');
    if (text.length > (req.file ? 1024 : 4096)) return back(res, '/admin/broadcast', 'err', `Message too long (max ${req.file ? 1024 : 4096} chars)`);
    if (button_url && !/^https?:\/\/|^tg:\/\//.test(button_url)) return back(res, '/admin/broadcast', 'err', 'Button URL must start with https://');
    const kb = button_text && button_url ? { reply_markup: { inline_keyboard: [[{ text: button_text, url: button_url }]] } } : {};

    if (req.body.action === 'test') {
      let ok = 0;
      let lastErr = '';
      for (const admin of cfg.ADMIN_IDS) {
        try {
          if (req.file) await bot.telegram.sendPhoto(admin, { source: req.file.buffer }, { caption: text || undefined, parse_mode: 'HTML', ...kb });
          else await bot.telegram.sendMessage(admin, text, { parse_mode: 'HTML', ...kb });
          ok++;
        } catch (e) {
          lastErr = e.description || e.message;
        }
      }
      if (!cfg.ADMIN_IDS.length) return back(res, '/admin/broadcast', 'err', 'Set ADMIN_IDS env to receive test messages');
      return back(res, '/admin/broadcast', ok ? 'ok' : 'err', ok ? `Test sent to ${ok} admin(s)` : `Failed: ${lastErr}`);
    }

    if (broadcast.isRunning()) return back(res, '/admin/broadcast', 'err', 'A broadcast is already running');
    let image_key = null;
    if (req.file) {
      image_key = `broadcasts/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${req.file.mimetype.split('/')[1].replace('jpeg', 'jpg')}`;
      if (r2.enabled) await r2.put(image_key, req.file.buffer, req.file.mimetype);
    }
    const id = await repo.createBroadcast({ text, image_key, button_text, button_url });
    broadcast.start(id, req.file ? req.file.buffer : null);
    back(res, '/admin/broadcast', 'ok', `Broadcast #${id} started`);
  })
);

router.post('/broadcast/cancel', (req, res) => {
  broadcast.cancel();
  back(res, '/admin/broadcast', 'ok', 'Stopping broadcast…');
});

/* ───────────── gift codes ───────────── */
router.get(
  '/codes',
  h(async (req, res) => {
    const codes = await repo.listCodes();
    const t = repo.now();
    const body = `
<h1>Gift Codes</h1><p class="sub">Create promo codes users can redeem with 🎟 Redeem Code</p>
<div class="grid g2">
<form class="card" method="post" action="/admin/codes"><h3>➕ Create code</h3>
 <div class="row"><div><label>Code (blank = random)</label><input name="code" placeholder="DIWALI50" style="text-transform:uppercase"></div><div><label>Amount (₹)</label><input name="amount" required placeholder="10"></div></div>
 <div class="row"><div><label>Max uses</label><input name="max_uses" value="100"></div><div><label>Expires in (hours, 0 = never)</label><input name="hours" value="24"></div></div>
 <button style="margin-top:14px">Create code</button></form>
<div class="card"><h3>🎟 Codes</h3><div class="tw"><table><tr><th>Code</th><th>Amount</th><th>Used</th><th>Expires</th><th></th></tr>
${codes.map((c) => {
  const expired = c.expires_at && c.expires_at < t;
  return `<tr><td class="mono"><b>${esc(c.code)}</b></td><td>${inr(c.amount)}</td><td>${c.used}/${c.max_uses}</td>
  <td>${c.expires_at ? `<span class="b ${expired ? 'bad' : 'ok'}">${expired ? 'expired' : dateIST(c.expires_at)}</span>` : '<span class="b mut">never</span>'}</td>
  <td><form method="post" action="/admin/codes/${encodeURIComponent(c.code)}/delete" onsubmit="return confirm('Delete code?')"><button class="sm bad">Delete</button></form></td></tr>`;
}).join('') || '<tr><td colspan="5" class="muted">No codes</td></tr>'}</table></div></div></div>`;
    render(req, res, 'Gift Codes', 'codes', body);
  })
);

router.post(
  '/codes',
  h(async (req, res) => {
    let code = String(req.body.code || '').trim().toUpperCase();
    if (!code) code = crypto.randomBytes(4).toString('hex').toUpperCase();
    if (!/^[A-Z0-9_-]{3,32}$/.test(code)) return back(res, '/admin/codes', 'err', 'Code must be 3-32 chars: A-Z, 0-9, _ or -');
    const amount = parseRupees(req.body.amount);
    if (!amount) return back(res, '/admin/codes', 'err', 'Invalid amount');
    const maxUses = Math.max(1, parseInt(req.body.max_uses, 10) || 1);
    const hours = Math.max(0, Number(req.body.hours) || 0);
    try {
      await repo.createCode(code, amount, maxUses, hours ? repo.now() + Math.round(hours * 3600) : 0);
    } catch (e) {
      return back(res, '/admin/codes', 'err', /UNIQUE|constraint/i.test(e.message) ? 'Code already exists' : e.message);
    }
    back(res, '/admin/codes', 'ok', `Code ${code} created (${inr(amount)} × ${maxUses})`);
  })
);

router.post(
  '/codes/:code/delete',
  h(async (req, res) => {
    await repo.deleteCode(String(req.params.code));
    back(res, '/admin/codes', 'ok', 'Code deleted');
  })
);

/* ───────────── fraud ───────────── */
router.get(
  '/fraud',
  h(async (req, res) => {
    const p = page(req);
    const [rows, total] = await Promise.all([repo.fraudLogs(50, (p - 1) * 50), repo.fraudCount()]);
    const reasons = { same_device: '📱 Same device', ip_limit: '🌐 IP limit' };
    const body = `<h1>Anti-Fraud</h1><p class="sub">Accounts caught by the one-device-one-account system. Referrers of these users were <b>not</b> rewarded.</p>
<div class="card"><div class="tw"><table><tr><th>#</th><th>Account</th><th>Matched existing account</th><th>Reason</th><th>IP</th><th>Fingerprint</th><th>Date</th></tr>
${rows.map((f) => `<tr><td>${f.id}</td><td>${userLink(f.user_id, f.name || f.user_id)}${f.uname ? ` <span class="muted">@${esc(f.uname)}</span>` : ''}</td>
<td>${f.matched_user_id ? userLink(f.matched_user_id, f.mname || f.matched_user_id) : '<span class="muted">—</span>'}</td><td><span class="b bad">${reasons[f.reason] || esc(f.reason)}</span></td>
<td class="mono">${esc(f.ip || '')}</td><td class="mono">${esc((f.fp_hash || '').slice(0, 12))}…</td><td>${dateIST(f.created_at)}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">🎉 No fraud detected</td></tr>'}
</table></div>${pager('/admin/fraud', p, total, 50)}</div>`;
    render(req, res, 'Anti-Fraud', 'fraud', body);
  })
);

/* ───────────── backups (R2) ───────────── */
router.get(
  '/backups',
  h(async (req, res) => {
    let list = [];
    let err = '';
    if (r2.enabled) {
      try {
        list = await r2.list('backups/');
      } catch (e) {
        err = e.message;
      }
    }
    const body = `<h1>Backups</h1><p class="sub">Full database snapshots stored in Cloudflare R2 (automatic every 24h + manual)</p>
${!r2.enabled ? '<div class="toast bad">R2 is not configured. Set R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET.</div>' : ''}
${err ? `<div class="toast bad">R2 error: ${esc(err)}</div>` : ''}
<div class="card"><div class="row" style="margin-bottom:12px"><h3 style="margin:0">☁️ R2 bucket: <span class="mono">${esc(cfg.R2_BUCKET || '—')}</span></h3>
<form method="post" action="/admin/backups" class="nf"><button ${r2.enabled ? '' : 'disabled'}>➕ Create backup now</button></form></div>
<div class="tw"><table><tr><th>File</th><th>Size</th><th>Created</th><th></th></tr>
${list.map((o) => `<tr><td class="mono">${esc(o.key.replace('backups/', ''))}</td><td>${(o.size / 1024).toFixed(1)} KB</td><td>${dateIST(Math.floor(new Date(o.modified).getTime() / 1000))}</td>
<td><a class="btn sm ghost" href="/admin/backups/download?key=${encodeURIComponent(o.key)}">⬇️ Download</a></td></tr>`).join('') || '<tr><td colspan="4" class="muted">No backups yet</td></tr>'}
</table></div></div>`;
    render(req, res, 'Backups', 'backup', body);
  })
);

router.post(
  '/backups',
  h(async (req, res) => {
    const b = await backup.createBackup('manual');
    back(res, '/admin/backups', 'ok', `Backup saved (${(b.size / 1024).toFixed(1)} KB, ${b.rows.users} users)`);
  })
);

router.get(
  '/backups/download',
  h(async (req, res) => {
    const key = String(req.query.key || '');
    if (!/^backups\/[\w.\-]+$/.test(key)) return back(res, '/admin/backups', 'err', 'Invalid key');
    res.redirect(await r2.signedUrl(key, 600));
  })
);

module.exports = router;
