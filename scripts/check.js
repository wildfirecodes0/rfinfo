// Pre-flight check: verifies Telegram token, D1 connection and R2 access.
const cfg = require('../src/config');
const db = require('../src/db/d1');
const r2 = require('../src/storage/r2');
const { Telegram } = require('telegraf');

(async () => {
  let ok = true;
  try {
    const me = await new Telegram(cfg.BOT_TOKEN).getMe();
    console.log(`✅ Telegram: @${me.username}`);
  } catch (e) {
    ok = false;
    console.error('❌ Telegram:', e.description || e.message);
  }
  try {
    const r = await db.first('SELECT 1 AS one');
    console.log(`✅ D1 (${cfg.D1_PROXY_URL ? 'proxy' : 'REST API'}):`, r && r.one === 1 ? 'connected' : r);
  } catch (e) {
    ok = false;
    console.error('❌ D1:', e.message);
  }
  if (r2.enabled) {
    try {
      await r2.put('healthcheck.txt', 'ok', 'text/plain');
      await r2.del('healthcheck.txt');
      console.log('✅ R2: read/write OK');
    } catch (e) {
      ok = false;
      console.error('❌ R2:', e.message);
    }
  } else console.log('⚠️ R2: not configured (backups & image upload disabled)');
  if (!cfg.ADMIN_IDS.length) console.log('⚠️ ADMIN_IDS empty — you will not get withdrawal alerts in Telegram');
  process.exit(ok ? 0 : 1);
})();
