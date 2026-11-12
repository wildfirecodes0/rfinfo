// Background broadcast engine: rate-limited (~25 msg/s), handles 429 + blocked users, progress saved to D1.
const repo = require('../db/repo');
const bot = require('../bot/instance');
const r2 = require('../storage/r2');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let running = null;

const isRunning = () => !!running;

async function sendOne(userId, b, media) {
  const extra = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
  if (b.button_text && b.button_url) {
    extra.reply_markup = { inline_keyboard: [[{ text: b.button_text, url: b.button_url }]] };
  }
  if (media.photo) {
    const msg = await bot.telegram.sendPhoto(
      userId,
      media.fileId || { source: media.photo, filename: 'image.jpg' },
      { caption: b.text || undefined, ...extra }
    );
    if (!media.fileId && msg.photo) media.fileId = msg.photo[msg.photo.length - 1].file_id;
    return;
  }
  await bot.telegram.sendMessage(userId, b.text, extra);
}

async function run(id, imageBuffer) {
  const b = await repo.getBroadcast(id);
  if (!b) return;
  const media = { photo: null, fileId: null };
  if (b.image_key) {
    media.photo = imageBuffer || (r2.enabled ? await r2.getBuffer(b.image_key).catch(() => null) : null);
  }
  const total = await repo.reachableCount();
  await repo.updateBroadcast(id, { status: 'running', total });

  let sent = 0;
  let failed = 0;
  let lastId = 0;
  let aborted = null;

  outer: for (;;) {
    const batch = await repo.broadcastBatch(lastId, 500);
    if (!batch.length) break;
    for (const { id: uid } of batch) {
      lastId = uid;
      if (running && running.cancel) {
        aborted = 'cancelled';
        break outer;
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await sendOne(uid, b, media);
          sent++;
          break;
        } catch (e) {
          const code = e.code || (e.response && e.response.error_code);
          const desc = (e.description || e.message || '').toLowerCase();
          if (code === 429) {
            const wait = ((e.parameters && e.parameters.retry_after) || 5) * 1000;
            await sleep(wait + 500);
            continue;
          }
          if (code === 400 && desc.includes('parse entities')) {
            aborted = 'failed: invalid HTML in message';
            break outer;
          }
          if (code === 403 || desc.includes('chat not found') || desc.includes('user is deactivated')) {
            await repo.markBlocked(uid).catch(() => {});
          }
          failed++;
          break;
        }
      }
      if ((sent + failed) % 50 === 0) await repo.updateBroadcast(id, { sent, failed }).catch(() => {});
      await sleep(40);
    }
  }
  await repo.updateBroadcast(id, {
    sent,
    failed,
    status: aborted || 'done',
    finished_at: repo.now(),
  });
}

function start(id, imageBuffer) {
  if (running) throw new Error('Another broadcast is already running');
  running = { id, cancel: false };
  run(id, imageBuffer)
    .catch(async (e) => {
      console.error('[broadcast]', e);
      await repo.updateBroadcast(id, { status: 'failed', finished_at: repo.now() }).catch(() => {});
    })
    .finally(() => {
      running = null;
    });
}

function cancel() {
  if (running) running.cancel = true;
}

module.exports = { start, cancel, isRunning, current: () => running && running.id };
