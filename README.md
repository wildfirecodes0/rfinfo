# 💸 INR Refer & Earn Telegram Bot

Node.js mein bana ek advanced refer-and-earn bot. Isme yeh sab hai: INR (₹) wallet, UPI se withdrawal, **ek device par ek hi account** wala anti-fraud system, aur ek pura web admin panel. Hosting **Render** par hoti hai, database **Cloudflare D1** hai aur storage **Cloudflare R2** hai.

---

## ✨ Features

### 🤖 Bot (user side)
- 👥 **Refer & Earn**: har user ka apna referral link aur Share button. Bonus tabhi milta hai jab naya user channel join kare **aur** apna device verify kare.
- 🛡 **One Device = One Account**: Telegram Mini App device ka fingerprint leta hai (canvas, WebGL, audio, screen, hardware, timezone ka SHA-256 hash) aur saath mein ek persistent device token bhi. Agar wahi device kisi doosre account par mile, to referral reject ho jata hai aur (setting ke hisaab se) naya account auto-ban ho jata hai.
- 🌐 IP limit optional hai (max accounts per IP).
- 📢 **Force-join channels**: kitne bhi channels/groups, "I've Joined" button ke saath.
- 💰 **Wallet**: balance, total earned, withdrawn, pending referrals aur transaction history.
- 💸 **UPI withdrawal**: min/max limit, kam se kam kitne referrals chahiye, fee %, quick-amount buttons aur confirm screen. Ek time par ek hi pending request ho sakti hai.
- 🎁 **Daily bonus**: random amount (min–max), 24 ghante ka cooldown.
- 🏅 **Milestone bonus**: jaise 10 refs → ₹20, 50 refs → ₹150.
- 🎟 **Gift / promo codes**: amount, max uses aur expiry ke saath.
- 🏆 **Leaderboard** (aapke rank ke saath) aur 📊 bot statistics.
- 🔔 Notifications: koi aapke link se join kare, referral confirm ho, payment ho jaye ya reject ho.
- 🛠 Maintenance mode, ban system, aur bot block karne wale users ki tracking.

### 🖥 Admin panel (`/admin`)
- 📊 Dashboard: users, verified, active 24h, referrals, pending/paid payouts, liability, fraud count, 14 din ka chart.
- 👥 Users: search (ID / @username / naam / UPI), filters, sorting, aur detail page. Detail page par balance add/deduct, ban/unban, device reset, UPI edit, message bhejna, referrals, transactions aur withdrawals.
- 💸 Withdrawals: Pending/Paid/Rejected tabs, UTR ke saath "Mark paid", reject + refund, aur **CSV export** (bulk payment ke liye).
- 📣 Broadcast: text + image + button, admins ko test send, live progress, aur stop button. Blocked users apne aap skip ho jate hain, aur Telegram rate-limit (429) handle hota hai.
- 🎟 Gift codes, 🕵️ anti-fraud logs, 📜 saare transactions.
- ⚙️ Settings: saare rewards, limits, channels, security, welcome text aur banner (banner R2 par upload hota hai).
- ☁️ Backups: poore database ka gzip JSON R2 mein jata hai (har 24 ghante automatic + manual), signed download link ke saath.
- 🔐 Signed HttpOnly cookie session, brute-force lock (5 galat try → 15 minute block), SameSite + origin check.

Bot ke andar bhi admin tools hain: `/admin` stats dikhata hai, aur har naye withdrawal ka alert **✅ Mark Paid / ❌ Reject** buttons ke saath aata hai.

---

## 🚀 Setup (step by step)

### 1. Telegram bot
1. [@BotFather](https://t.me/BotFather) par `/newbot` chalao aur **BOT_TOKEN** copy kar lo.
2. Apni numeric ID [@userinfobot](https://t.me/userinfobot) se lo. Yahi **ADMIN_IDS** hai.
3. Force-join channels mein bot ko **admin** banana zaroori hai.

### 2. Cloudflare D1 (database)
1. Cloudflare dashboard → **Storage & Databases → D1** → *Create database* (naam: `refer-bot`).
2. **Database ID** copy karo. Yahi `D1_DATABASE_ID` hai.
3. **Account ID** dashboard ke right side par milega. Yahi `CF_ACCOUNT_ID` hai.
4. **My Profile → API Tokens → Create Token → Custom**. Permission do: `Account → D1 → Edit`. Bana kar copy karo. Yahi `CF_API_TOKEN` hai.

Tables apne aap ban jaati hain, bot pehli baar start hote hi.

> ⚡ **High traffic ke liye (recommended):** Cloudflare REST API ki limit lagbhag 1200 requests / 5 minute hai. Agar bahut saare users aate hain to `cloudflare-worker/` wala proxy deploy karo:
> ```bash
> cd cloudflare-worker
> # wrangler.toml mein database_id daalo
> npx wrangler deploy
> npx wrangler secret put PROXY_SECRET
> ```
> Phir Render par `D1_PROXY_URL=https://refer-bot-d1-proxy.<you>.workers.dev` aur `D1_PROXY_SECRET` set karo.

### 3. Cloudflare R2 (storage)
1. **R2 → Create bucket** (naam: `refer-bot`). Yahi `R2_BUCKET` hai.
2. **R2 → Manage API Tokens → Create** (Object Read & Write). Isse `R2_ACCESS_KEY_ID` aur `R2_SECRET_ACCESS_KEY` milenge.
3. *(Optional)* Bucket → Settings → **Public access (r2.dev)** on karo aur URL ko `R2_PUBLIC_URL` mein daalo. Welcome banner upload ke liye yeh chahiye.

### 4. Render par deploy
1. Is folder ko GitHub repo mein push karo.
2. Render → **New → Blueprint** → repo select karo. `render.yaml` apne aap detect ho jayega.
   *(Ya **New → Web Service** banao: Build `npm install`, Start `npm start`.)*
3. Environment variables bharo (`.env.example` dekho). `PUBLIC_URL` **khaali chhodo**, kyunki Render khud `RENDER_EXTERNAL_URL` deta hai.
4. Deploy karo. Logs mein yeh dikhna chahiye:
   ```
   🤖 Bot: @YourBot
   🔗 Webhook set → https://your-app.onrender.com/tg/…
   🖥  Admin panel → https://your-app.onrender.com/admin
   ```
5. Admin panel kholo → **Settings** → channels, rewards aur limits set karo.

> ℹ️ Render ka free plan 15 minute idle rehne par so jata hai, to us ke baad pehla reply 30–50 second late aata hai. Smooth chalne ke liye **Starter** plan lo, ya UptimeRobot se har 10 minute `/health` ping karwao.

### 5. Local testing
```bash
cp .env.example .env    # values bharo, PUBLIC_URL khaali rakho
npm install
npm run check           # Telegram + D1 + R2 connection test
npm run dev
```
Local mein bot long-polling par chalta hai. Device verification ke liye public HTTPS URL chahiye, isliye local testing mein admin panel → Settings se "Require device verification" off kar do. Ya phir ngrok chalao aur `PUBLIC_URL` set kar do.

---

## 🔐 One-Device-One-Account kaise kaam karta hai
1. User `/start <referrer_id>` karta hai, to referral **pending** mein save hota hai.
2. User channels join karta hai, phir **🔐 Verify My Device** (Telegram Mini App) dabata hai.
3. Page ek hardware fingerprint aur device token bana kar bhejta hai. Server Telegram `initData` ka HMAC check karta hai, isliye koi fake request nahi bhej sakta.
4. Agar wahi fingerprint ya token kisi aur account par pehle se hai:
   - `block_duplicate = on` hai to naya account ban, aur referrer ko ₹0.
   - `block_duplicate = off` hai to user bot use kar sakta hai, lekin referrer ko ₹0.
   - Har case **Anti-Fraud** page par log hota hai.
5. Agar device naya hai to referrer ko bonus milta hai (milestone bonus bhi), aur dono ko notification jata hai.

Ek hi model ke do phone kabhi-kabhi same fingerprint de sakte hain. Aisa ho to admin us user ke page par **Unban + Reset device** kar sakta hai.

---

## 📁 Project structure
```
src/
  index.js              Express server, webhook, startup
  config.js             env config
  utils.js              ₹ formatting, escaping, UPI validation
  db/d1.js              D1 client (REST API or proxy worker, with retries)
  db/repo.js            all queries + atomic money operations + settings
  storage/r2.js         R2 (S3 API) client
  bot/handlers.js       all bot commands, menus, flows
  bot/ui.js             keyboards & shared screens
  services/*.js         referrals, withdrawals, broadcast, backups, channel check
  web/verify.js         device-verification Mini App + API
  admin/*.js            admin panel (auth, layout, routes)
schema.sql              D1 schema
cloudflare-worker/      optional D1 proxy worker
render.yaml             Render blueprint
```

Paisa hamesha **paise** (integer) mein store hota hai, isliye rounding errors nahi aate. Har balance change ek conditional SQL update hai: double-spend nahi ho sakta, balance negative nahi ho sakta, aur double claim nahi ho sakta.
