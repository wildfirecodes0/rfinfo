// Telegram Mini App: one-device-one-account verification.
const crypto = require('crypto');
const express = require('express');
const cfg = require('../config');
const repo = require('../db/repo');
const bot = require('../bot/instance');
const { missingChannels } = require('../services/channels');
const { onCleared, safeSend } = require('../services/referral');
const { sendWelcome } = require('../bot/ui');
const { esc } = require('../utils');

const router = express.Router();

function validateInitData(initData, maxAgeSec = 3600) {
  if (!initData || typeof initData !== 'string' || initData.length > 4096) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dcs = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(cfg.BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSec) return null;
  try {
    const user = JSON.parse(params.get('user') || 'null');
    return user && user.id ? user : null;
  } catch {
    return null;
  }
}

// simple per-IP rate limit
const hits = new Map();
function limited(ip) {
  const t = Date.now();
  const h = (hits.get(ip) || []).filter((x) => t - x < 60000);
  h.push(t);
  hits.set(ip, h);
  if (hits.size > 10000) hits.clear();
  return h.length > 15;
}

const locks = new Set();

router.post('/api/verify', express.json({ limit: '16kb' }), async (req, res) => {
  const ip = req.ip;
  if (limited(ip)) return res.status(429).json({ ok: false, message: 'Too many attempts. Please wait a minute.' });

  const tgUser = validateInitData(req.body && req.body.initData);
  if (!tgUser) return res.status(401).json({ ok: false, message: 'Session expired. Please reopen from the bot.' });

  const fp = String((req.body && req.body.fp) || '');
  const token = String((req.body && req.body.token) || '');
  if (!/^[a-f0-9]{64}$/.test(fp)) return res.status(400).json({ ok: false, message: 'Device check failed. Please try again.' });
  const cleanToken = /^[a-zA-Z0-9-]{16,64}$/.test(token) ? token : null;

  const uid = Number(tgUser.id);
  if (locks.has(uid)) return res.status(409).json({ ok: false, message: 'Verification in progress…' });
  locks.add(uid);
  try {
    const u = await repo.getUser(uid, true);
    if (!u) return res.json({ ok: false, message: 'Please press /start in the bot first.' });
    if (u.is_banned) return res.json({ ok: false, code: 'banned', message: 'Your account is suspended.' });
    if (u.verified) return res.json({ ok: true, already: true, message: 'Your device is already verified ✅' });

    const S = await repo.settings();
    const missing = await missingChannels(uid, S.channelList, { fresh: true });
    if (missing.length) return res.json({ ok: false, message: 'Please join all required channels first, then verify.' });

    const device = {
      fp,
      token: cleanToken,
      ip,
      ua: req.get('user-agent') || '',
      platform: String((req.body && req.body.platform) || '').slice(0, 40),
    };

    let conflict = await repo.findDeviceConflict(uid, fp, cleanToken);
    let reason = conflict ? 'same_device' : null;
    if (!conflict && S.max_per_ip > 0 && ip) {
      const c = await repo.countIp(ip, uid);
      if (c >= S.max_per_ip) {
        conflict = { user_id: null };
        reason = 'ip_limit';
      }
    }

    if (conflict) {
      await repo.logFraud(uid, conflict.user_id, reason, fp, ip);
      await repo.rejectReferral(uid);
      await repo.saveDevice(uid, device);
      if (S.block_duplicate) {
        await repo.updateUser(uid, { is_banned: 1, ban_reason: 'Multiple accounts detected on the same device / network' });
        await safeSend(
          uid,
          '🚫 <b>Verification Failed</b>\n\nThis device is already linked to another account.\n' +
            '<i>Only one account per device is allowed.</i>\n\nIf you think this is a mistake, please contact support.',
          { reply_markup: { remove_keyboard: true } }
        );
        return res.json({ ok: false, code: 'duplicate', message: 'This device is already linked to another account. Only one account per device is allowed.' });
      }
      // Allowed to use the bot, but no referral reward for the referrer.
      await repo.markVerified(uid);
      const fresh = await repo.getUser(uid, true);
      await sendWelcome(uid, S, fresh);
      return res.json({ ok: true, warn: true, message: 'Verified — but this device was used before, so no referral reward was given.' });
    }

    await repo.saveDevice(uid, device);
    if (await repo.markVerified(uid)) {
      const r = await onCleared(uid);
      const fresh = await repo.getUser(uid, true);
      await bot.telegram
        .sendMessage(uid, `✅ <b>Device verified successfully!</b>${r.joinBonus ? `\n🎉 Welcome bonus credited!` : ''}`, { parse_mode: 'HTML' })
        .catch(() => {});
      await sendWelcome(uid, S, fresh).catch(() => {});
    }
    return res.json({ ok: true, message: 'Device verified successfully!', name: esc(tgUser.first_name || '') });
  } catch (e) {
    console.error('[verify]', e);
    return res.status(500).json({ ok: false, message: 'Server error. Please try again.' });
  } finally {
    locks.delete(uid);
  }
});

router.get('/verify', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(PAGE);
});

const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>Device Verification</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root{--bg:#0b1020;--card:rgba(255,255,255,.06);--line:rgba(255,255,255,.1);--txt:#eef2ff;--mut:#94a3b8;--ok:#22c55e;--bad:#ef4444;--acc:#6366f1;--acc2:#06b6d4}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:radial-gradient(1200px 600px at 10% -10%,#312e81 0,transparent 60%),radial-gradient(900px 500px at 110% 110%,#155e75 0,transparent 55%),var(--bg);color:var(--txt);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{width:100%;max-width:400px;background:var(--card);border:1px solid var(--line);border-radius:28px;padding:32px 24px;backdrop-filter:blur(20px);text-align:center;box-shadow:0 30px 80px rgba(0,0,0,.45)}
.shield{width:120px;height:120px;margin:0 auto 22px;position:relative;display:grid;place-items:center}
.ring{position:absolute;inset:0;border-radius:50%;border:3px solid transparent;border-top-color:var(--acc);border-right-color:var(--acc2);animation:spin 1.1s linear infinite}
.ring.r2{inset:12px;animation-duration:1.7s;animation-direction:reverse;border-top-color:var(--acc2);border-right-color:transparent;border-left-color:var(--acc)}
.core{width:72px;height:72px;border-radius:50%;background:linear-gradient(135deg,var(--acc),var(--acc2));display:grid;place-items:center;font-size:34px;box-shadow:0 0 40px rgba(99,102,241,.6);transition:.4s}
.done .ring{animation:none;border-color:var(--ok);opacity:.5}.done .core{background:var(--ok);box-shadow:0 0 50px rgba(34,197,94,.6);transform:scale(1.08)}
.fail .ring{animation:none;border-color:var(--bad);opacity:.5}.fail .core{background:var(--bad);box-shadow:0 0 50px rgba(239,68,68,.6)}
h1{font-size:22px;margin-bottom:6px}p.sub{color:var(--mut);font-size:14px;line-height:1.5}
.steps{margin:26px 0 8px;text-align:left;display:grid;gap:10px}
.step{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:14px;background:rgba(255,255,255,.04);border:1px solid var(--line);font-size:14px;color:var(--mut);transition:.3s}
.step .ic{width:22px;height:22px;border-radius:50%;border:2px solid var(--line);display:grid;place-items:center;font-size:12px;flex:none}
.step.active{color:var(--txt);border-color:rgba(99,102,241,.5)}.step.active .ic{border-color:var(--acc);border-top-color:transparent;animation:spin .8s linear infinite}
.step.ok{color:var(--txt)}.step.ok .ic{background:var(--ok);border-color:var(--ok)}.step.ok .ic:after{content:"✓";color:#fff;font-weight:700}
.step.err .ic{background:var(--bad);border-color:var(--bad)}.step.err .ic:after{content:"✕";color:#fff;font-weight:700}
.msg{margin-top:18px;padding:14px;border-radius:14px;font-size:14px;line-height:1.5;display:none}
.msg.show{display:block}.msg.ok{background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.35)}.msg.bad{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.35)}.msg.warn{background:rgba(234,179,8,.12);border:1px solid rgba(234,179,8,.35)}
button{margin-top:18px;width:100%;padding:15px;border:0;border-radius:14px;font-size:16px;font-weight:600;color:#fff;background:linear-gradient(135deg,var(--acc),var(--acc2));display:none;cursor:pointer}
button.show{display:block}
.foot{margin-top:18px;font-size:11px;color:var(--mut)}
@keyframes spin{to{transform:rotate(360deg)}}
</style></head>
<body><div class="card">
  <div class="shield" id="shield"><div class="ring"></div><div class="ring r2"></div><div class="core" id="core">🛡</div></div>
  <h1 id="title">Verifying your device</h1>
  <p class="sub" id="sub">Please keep this window open for a moment…</p>
  <div class="steps">
    <div class="step" id="s1"><span class="ic"></span>Checking Telegram session</div>
    <div class="step" id="s2"><span class="ic"></span>Scanning device signature</div>
    <div class="step" id="s3"><span class="ic"></span>Securing your account</div>
  </div>
  <div class="msg" id="msg"></div>
  <button id="btn">Back to Bot</button>
  <div class="foot">🔒 One device • One account • No personal data stored</div>
</div>
<script>
(function(){
  var tg = window.Telegram && window.Telegram.WebApp;
  var $ = function(id){return document.getElementById(id)};
  var sleep = function(ms){return new Promise(function(r){setTimeout(r,ms)})};
  function step(id, st){ var e=$(id); e.className='step '+st; }
  function finish(type, title, text){
    $('shield').className = 'shield ' + (type==='bad'?'fail':'done');
    $('core').textContent = type==='bad' ? '✕' : '✓';
    $('title').textContent = title; $('sub').textContent = '';
    var m=$('msg'); m.className='msg show '+type; m.textContent=text;
    $('btn').className='show';
    try{ tg.HapticFeedback.notificationOccurred(type==='bad'?'error':'success'); }catch(e){}
    if(type!=='bad') setTimeout(function(){ try{tg.close()}catch(e){} }, 2500);
  }
  $('btn').onclick=function(){ try{tg.close()}catch(e){ history.back() } };

  async function sha256(str){
    var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(function(b){return b.toString(16).padStart(2,'0')}).join('');
  }
  function canvasFp(){
    try{
      var c=document.createElement('canvas'); c.width=280; c.height=60; var x=c.getContext('2d');
      x.textBaseline='top'; x.font='16px Arial'; x.fillStyle='#f60'; x.fillRect(100,1,62,20);
      x.fillStyle='#069'; x.fillText('ReferBot \\u20B9 \\ud83d\\udee1 device',2,15);
      x.fillStyle='rgba(102,204,0,0.7)'; x.fillText('ReferBot \\u20B9 \\ud83d\\udee1 device',4,17);
      x.globalCompositeOperation='multiply'; x.fillStyle='rgb(255,0,255)'; x.beginPath(); x.arc(50,50,50,0,Math.PI*2,true); x.closePath(); x.fill();
      return c.toDataURL();
    }catch(e){ return 'nocanvas'; }
  }
  function webglFp(){
    try{
      var c=document.createElement('canvas'); var gl=c.getContext('webgl')||c.getContext('experimental-webgl'); if(!gl) return 'nogl';
      var d=gl.getExtension('WEBGL_debug_renderer_info');
      return [d?gl.getParameter(d.UNMASKED_VENDOR_WEBGL):'', d?gl.getParameter(d.UNMASKED_RENDERER_WEBGL):'', gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), (gl.getSupportedExtensions()||[]).length].join('|');
    }catch(e){ return 'glerr'; }
  }
  async function audioFp(){
    try{
      var A=window.OfflineAudioContext||window.webkitOfflineAudioContext; if(!A) return 'noaudio';
      var ctx=new A(1,5000,44100), o=ctx.createOscillator(), comp=ctx.createDynamicsCompressor();
      o.type='triangle'; o.frequency.value=10000; o.connect(comp); comp.connect(ctx.destination); o.start(0);
      var buf=await Promise.race([ctx.startRendering(), sleep(1500).then(function(){return null})]);
      if(!buf) return 'audiotimeout';
      var d=buf.getChannelData(0), s=0; for(var i=4500;i<5000;i++) s+=Math.abs(d[i]); return s.toFixed(6);
    }catch(e){ return 'audioerr'; }
  }
  function deviceToken(){
    try{
      var t=localStorage.getItem('rb_did');
      if(!t){ t=(crypto.randomUUID?crypto.randomUUID():(Date.now().toString(36)+Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2))); localStorage.setItem('rb_did',t); }
      return t;
    }catch(e){ return ''; }
  }

  async function main(){
    if(!tg || !tg.initData){ step('s1','err'); finish('bad','Open from Telegram','Please open this page using the “Verify My Device” button inside the bot.'); return; }
    tg.ready(); tg.expand();
    try{ tg.setHeaderColor('#0b1020'); tg.setBackgroundColor('#0b1020'); }catch(e){}
    step('s1','active'); await sleep(500); step('s1','ok');
    step('s2','active');
    var parts=[
      canvasFp(), webglFp(), await audioFp(),
      screen.width+'x'+screen.height+'x'+screen.colorDepth+'@'+(window.devicePixelRatio||1),
      navigator.hardwareConcurrency||0, navigator.deviceMemory||0, navigator.maxTouchPoints||0,
      navigator.platform||'', (Intl.DateTimeFormat().resolvedOptions().timeZone||''), tg.platform||''
    ];
    var fp=await sha256(parts.join('###'));
    await sleep(400); step('s2','ok');
    step('s3','active');
    try{
      var r=await fetch('/api/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({initData:tg.initData,fp:fp,token:deviceToken(),platform:tg.platform||''})});
      var j=await r.json().catch(function(){return {ok:false,message:'Server error'}});
      if(j.ok){ step('s3','ok'); finish(j.warn?'warn':'ok', j.already?'Already Verified':'Verified!', j.message+(j.warn?'':' Returning to the bot…')); }
      else { step('s3','err'); finish('bad','Verification Failed', j.message||'Please try again.'); }
    }catch(e){ step('s3','err'); finish('bad','Network Error','Could not reach the server. Please check your internet and try again.'); }
  }
  main();
})();
</script></body></html>`;

module.exports = router;
