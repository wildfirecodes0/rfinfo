// HTML layout + small view helpers for the admin panel (no template engine, everything escaped).
const { esc } = require('../utils');

const NAV = [
  ['/admin', '📊', 'Dashboard', 'dash'],
  ['/admin/users', '👥', 'Users', 'users'],
  ['/admin/withdrawals', '💸', 'Withdrawals', 'wd'],
  ['/admin/transactions', '📜', 'Transactions', 'tx'],
  ['/admin/broadcast', '📣', 'Broadcast', 'bc'],
  ['/admin/codes', '🎟', 'Gift Codes', 'codes'],
  ['/admin/fraud', '🕵️', 'Anti-Fraud', 'fraud'],
  ['/admin/settings', '⚙️', 'Settings', 'settings'],
  ['/admin/backups', '☁️', 'Backups (R2)', 'backup'],
];

const CSS = `
:root{--bg:#f4f6fb;--panel:#fff;--side:#0f172a;--txt:#0f172a;--mut:#64748b;--line:#e2e8f0;--acc:#4f46e5;--acc2:#0891b2;--ok:#16a34a;--bad:#dc2626;--warn:#d97706;--soft:#eef2ff;--shadow:0 1px 2px rgba(15,23,42,.05),0 8px 24px rgba(15,23,42,.06)}
@media (prefers-color-scheme:dark){:root{--bg:#0b1020;--panel:#121a2f;--side:#070b16;--txt:#e5e7eb;--mut:#94a3b8;--line:#1f2a44;--soft:#1e1b4b;--shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.3)}}
*{box-sizing:border-box}body{margin:0;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--txt);font-size:14px}
a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
.wrap{display:flex;min-height:100vh}
aside{width:236px;background:var(--side);color:#cbd5e1;padding:20px 12px;position:sticky;top:0;height:100vh;flex:none;display:flex;flex-direction:column}
.brand{display:flex;align-items:center;gap:10px;padding:6px 10px 20px;color:#fff;font-weight:700;font-size:16px}
.brand .logo{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,var(--acc),var(--acc2));display:grid;place-items:center}
aside nav a{display:flex;gap:10px;align-items:center;padding:10px 12px;border-radius:10px;color:#cbd5e1;margin-bottom:2px;font-weight:500}
aside nav a:hover{background:rgba(255,255,255,.06);text-decoration:none}
aside nav a.on{background:linear-gradient(135deg,rgba(79,70,229,.9),rgba(8,145,178,.9));color:#fff}
aside .out{margin-top:auto}aside .out button{width:100%;background:rgba(255,255,255,.06);color:#cbd5e1;border:0}
main{flex:1;min-width:0;padding:26px 30px 60px}
h1{font-size:22px;margin:0 0 4px}.sub{color:var(--mut);margin:0 0 22px}
.grid{display:grid;gap:16px}.g4{grid-template-columns:repeat(auto-fill,minmax(210px,1fr))}.g2{grid-template-columns:repeat(auto-fit,minmax(340px,1fr))}
.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px;box-shadow:var(--shadow);min-width:0}
.card h3{margin:0 0 14px;font-size:15px}
.stat .k{color:var(--mut);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.stat .v{font-size:26px;font-weight:700;margin-top:6px}.stat .s{color:var(--mut);font-size:12px;margin-top:4px}
.stat .ic{float:right;width:40px;height:40px;border-radius:12px;background:var(--soft);display:grid;place-items:center;font-size:19px}
table{width:100%;border-collapse:collapse}th,td{padding:10px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle;white-space:nowrap}
th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--mut);font-weight:600}
tr:hover td{background:rgba(99,102,241,.04)}
.tw{overflow-x:auto;margin:0 -18px;padding:0 18px}
.b{display:inline-block;padding:3px 9px;border-radius:999px;font-size:11px;font-weight:600}
.b.ok{background:rgba(22,163,74,.12);color:var(--ok)}.b.bad{background:rgba(220,38,38,.12);color:var(--bad)}.b.warn{background:rgba(217,119,6,.14);color:var(--warn)}.b.mut{background:rgba(100,116,139,.14);color:var(--mut)}.b.acc{background:var(--soft);color:var(--acc)}
input,select,textarea{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--txt);font:inherit}
input:focus,select:focus,textarea:focus{outline:2px solid rgba(79,70,229,.35);border-color:var(--acc)}
textarea{min-height:110px;resize:vertical;font-family:ui-monospace,Consolas,monospace;font-size:13px}
label{display:block;font-weight:600;font-size:12px;margin:12px 0 6px;color:var(--mut)}
.chk{display:flex;align-items:center;gap:10px;margin:12px 0;font-weight:500;color:var(--txt);font-size:14px}.chk input{width:18px;height:18px}
button,.btn{display:inline-flex;align-items:center;gap:6px;padding:9px 16px;border-radius:10px;border:1px solid transparent;background:var(--acc);color:#fff;font-weight:600;cursor:pointer;font:inherit;font-weight:600}
.btn:hover,button:hover{filter:brightness(1.08);text-decoration:none}
.btn.sm,button.sm{padding:6px 11px;font-size:12px}.btn.ok,button.ok{background:var(--ok)}.btn.bad,button.bad{background:var(--bad)}.btn.ghost,button.ghost{background:transparent;color:var(--txt);border-color:var(--line)}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.row>*{flex:1;min-width:140px}.row>.nf{flex:none}
.toast{padding:12px 16px;border-radius:12px;margin-bottom:18px;font-weight:500}.toast.ok{background:rgba(22,163,74,.12);color:var(--ok);border:1px solid rgba(22,163,74,.3)}.toast.bad{background:rgba(220,38,38,.1);color:var(--bad);border:1px solid rgba(220,38,38,.3)}
.tabs{display:flex;gap:6px;margin-bottom:16px;flex-wrap:wrap}.tabs a{padding:8px 14px;border-radius:10px;background:var(--panel);border:1px solid var(--line);color:var(--txt);font-weight:600}.tabs a.on{background:var(--acc);color:#fff;border-color:var(--acc)}
.pg{display:flex;gap:6px;justify-content:flex-end;margin-top:14px;align-items:center;color:var(--mut)}
.bars{display:flex;align-items:flex-end;gap:6px;height:170px;padding-top:10px}.bar{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;height:100%;justify-content:flex-end}
.bar i{display:block;width:100%;border-radius:8px 8px 3px 3px;background:linear-gradient(180deg,var(--acc),var(--acc2));min-height:3px}.bar span{font-size:10px;color:var(--mut)}.bar b{font-size:11px}
.muted{color:var(--mut)}.mono{font-family:ui-monospace,Consolas,monospace}.right{text-align:right}
.kv{display:grid;grid-template-columns:140px 1fr;gap:8px 12px}.kv div:nth-child(odd){color:var(--mut)}
.inline{display:inline}.inline form{display:inline}
details summary{cursor:pointer;font-weight:600}
.progress{height:8px;background:var(--line);border-radius:99px;overflow:hidden}.progress i{display:block;height:100%;background:linear-gradient(90deg,var(--acc),var(--acc2))}
@media (max-width:860px){.wrap{flex-direction:column}aside{width:100%;height:auto;position:sticky;z-index:5;padding:10px;flex-direction:row;align-items:center;overflow-x:auto}
.brand{padding:0 10px 0 4px}.brand span{display:none}aside nav{display:flex;gap:4px}aside nav a{white-space:nowrap;margin:0;padding:8px 10px}aside nav a .t{display:none}aside .out{margin:0 0 0 6px}aside .out button{width:auto}
main{padding:16px}.kv{grid-template-columns:110px 1fr}}
`;

function layout({ title, active, body, flash, admin }) {
  const nav = NAV.map(
    ([href, ic, label, key]) => `<a href="${href}" class="${key === active ? 'on' : ''}"><span>${ic}</span><span class="t">${label}</span></a>`
  ).join('');
  const toast = flash && flash.ok ? `<div class="toast ok">✅ ${esc(flash.ok)}</div>` : flash && flash.err ? `<div class="toast bad">⚠️ ${esc(flash.err)}</div>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Refer Bot Admin</title><style>${CSS}</style></head><body><div class="wrap">
<aside><div class="brand"><div class="logo">₹</div><span>Refer Bot Admin</span></div><nav>${nav}</nav>
<form class="out" method="post" action="/admin/logout"><button class="sm" title="${esc(admin || '')}">⎋ <span class="t">Logout</span></button></form></aside>
<main>${toast}${body}</main></div></body></html>`;
}

function loginPage(err) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin Login</title><style>${CSS}
body{display:grid;place-items:center;min-height:100vh;background:radial-gradient(900px 500px at 0 0,rgba(79,70,229,.25),transparent),radial-gradient(800px 500px at 100% 100%,rgba(8,145,178,.25),transparent),var(--bg)}
.card{width:100%;max-width:380px;padding:30px}</style></head><body><form class="card" method="post" action="/admin/login">
<div class="brand" style="color:var(--txt);padding:0 0 10px"><div class="logo" style="color:#fff">₹</div><span>Refer Bot Admin</span></div>
<p class="sub">Sign in to manage your bot</p>${err ? `<div class="toast bad">⚠️ ${esc(err)}</div>` : ''}
<label>Username</label><input name="username" autocomplete="username" required autofocus>
<label>Password</label><input name="password" type="password" autocomplete="current-password" required>
<button style="width:100%;justify-content:center;margin-top:18px;padding:12px">Sign in →</button></form></body></html>`;
}

function pager(base, page, total, perPage) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const sep = base.includes('?') ? '&' : '?';
  return `<div class="pg"><span>Page ${page} of ${pages} · ${total.toLocaleString('en-IN')} total</span>
  ${page > 1 ? `<a class="btn ghost sm" href="${base}${sep}page=${page - 1}">← Prev</a>` : ''}
  ${page < pages ? `<a class="btn ghost sm" href="${base}${sep}page=${page + 1}">Next →</a>` : ''}</div>`;
}

const statCard = (icon, k, v, s = '') =>
  `<div class="card stat"><div class="ic">${icon}</div><div class="k">${esc(k)}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;

module.exports = { layout, loginPage, pager, statCard };
