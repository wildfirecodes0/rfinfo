// Force-join channel checks with a short positive cache (keeps Telegram API calls low).
const bot = require('../bot/instance');

const cache = new Map(); // userId -> timestamp of last successful check
const TTL = 10 * 60 * 1000;
const OK = new Set(['member', 'administrator', 'creator']);

async function missingChannels(userId, channels, { fresh = false } = {}) {
  if (!channels || !channels.length) return [];
  const c = cache.get(userId);
  if (!fresh && c && Date.now() - c < TTL) return [];

  const missing = [];
  for (const ch of channels) {
    try {
      const m = await bot.telegram.getChatMember(ch.id, userId);
      const joined = OK.has(m.status) || (m.status === 'restricted' && m.is_member);
      if (!joined) missing.push(ch);
    } catch (e) {
      // Misconfigured channel (bot not admin / wrong id) must not lock users out.
      console.warn(`[channels] cannot check ${ch.id}: ${e.description || e.message}`);
    }
  }
  if (!missing.length) cache.set(userId, Date.now());
  else cache.delete(userId);
  if (cache.size > 20000) cache.clear();
  return missing;
}

const forget = (userId) => cache.delete(userId);

module.exports = { missingChannels, forget };
