// Entry point: Express server (webhook + verify Mini App + admin panel) for Render.
const express = require('express');
const cfg = require('./config');
const repo = require('./db/repo');
const bot = require('./bot/instance');
const { COMMANDS } = require('./bot/handlers');
const r2 = require('./storage/r2');
const backup = require('./services/backup');

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

const ALLOWED_UPDATES = ['message', 'callback_query', 'my_chat_member'];

async function main() {
  console.log('⏳ Running database migrations…');
  await repo.migrate();
  // Broadcasts interrupted by a restart
  await repo.listBroadcasts().then((list) =>
    Promise.all(list.filter((b) => b.status === 'running' || b.status === 'queued').map((b) => repo.updateBroadcast(b.id, { status: 'interrupted', finished_at: repo.now() })))
  );
  await repo.settings(true);

  bot.botInfo = await bot.telegram.getMe();
  console.log(`🤖 Bot: @${bot.botInfo.username}`);

  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  // Telegram webhook (mounted before body parsers; telegraf parses the body itself)
  app.use(bot.webhookCallback(cfg.WEBHOOK_PATH, { secretToken: cfg.WEBHOOK_SECRET }));

  app.get('/', (req, res) =>
    res.type('html').send(
      `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Refer Bot</title>
       <body style="font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#0b1020;color:#e5e7eb">
       <div style="text-align:center"><div style="font-size:54px">₹</div><h2>@${bot.botInfo.username} is running ✅</h2>
       <a style="color:#818cf8" href="https://t.me/${bot.botInfo.username}">Open in Telegram →</a></div></body>`
    )
  );
  app.get('/health', (req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()), r2: r2.enabled }));

  app.use(require('./web/verify'));
  app.use('/admin', require('./admin/routes'));
  app.use((req, res) => res.status(404).send('Not found'));

  app.listen(cfg.PORT, () => console.log(`🌐 HTTP server on :${cfg.PORT}`));

  await bot.telegram.setMyCommands(COMMANDS).catch((e) => console.warn('setMyCommands:', e.message));

  if (cfg.PUBLIC_URL) {
    const url = cfg.PUBLIC_URL + cfg.WEBHOOK_PATH;
    await bot.telegram.setWebhook(url, {
      secret_token: cfg.WEBHOOK_SECRET,
      allowed_updates: ALLOWED_UPDATES,
      max_connections: 40,
    });
    // Menu button opens the bot normally; verification uses inline web_app buttons.
    console.log(`🔗 Webhook set → ${cfg.PUBLIC_URL}/tg/…`);
    console.log(`🖥  Admin panel → ${cfg.PUBLIC_URL}/admin`);
  } else {
    console.warn('⚠️ PUBLIC_URL not set → using long polling (local dev). Device verification needs a public HTTPS URL.');
    await bot.telegram.deleteWebhook({ drop_pending_updates: false });
    bot.launch({ allowedUpdates: ALLOWED_UPDATES }).catch((e) => {
      console.error('Polling failed:', e);
      process.exit(1);
    });
    console.log(`🖥  Admin panel → http://localhost:${cfg.PORT}/admin`);
  }

  backup.scheduleAuto();
  console.log(`✅ Ready. R2 storage: ${r2.enabled ? 'enabled' : 'disabled'}. D1 via ${cfg.D1_PROXY_URL ? 'proxy worker' : 'REST API'}.`);
}

main().catch((e) => {
  console.error('❌ Fatal startup error:', e);
  process.exit(1);
});

const stop = (sig) => {
  console.log(`${sig} received, shutting down…`);
  try {
    bot.stop(sig);
  } catch {
    /* not polling */
  }
  setTimeout(() => process.exit(0), 500);
};
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
