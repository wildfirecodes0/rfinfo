// Full JSON backup of all D1 tables → R2 (manual + automatic every 24h).
const zlib = require('zlib');
const repo = require('../db/repo');
const r2 = require('../storage/r2');

async function createBackup(label = 'manual') {
  if (!r2.enabled) throw new Error('R2 is not configured');
  const data = { created_at: new Date().toISOString(), label, tables: {} };
  for (const t of repo.BACKUP_TABLES) data.tables[t] = await repo.dumpTable(t);
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(data)));
  const key = `backups/${new Date().toISOString().replace(/[:.]/g, '-')}-${label}.json.gz`;
  await r2.put(key, gz, 'application/gzip');
  return { key, size: gz.length, rows: Object.fromEntries(Object.entries(data.tables).map(([k, v]) => [k, v.length])) };
}

function scheduleAuto() {
  if (!r2.enabled) return;
  const DAY = 24 * 3600 * 1000;
  setInterval(() => {
    createBackup('auto')
      .then((b) => console.log('[backup] auto backup saved', b.key))
      .catch((e) => console.error('[backup] auto failed', e.message));
  }, DAY).unref();
}

module.exports = { createBackup, scheduleAuto };
