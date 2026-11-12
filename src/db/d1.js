// Cloudflare D1 client — works over the Cloudflare REST API or through the optional proxy Worker.
const cfg = require('../config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isRead = (sql) => /^\s*(select|pragma|with)\b/i.test(sql);

async function callOnce(sql, params) {
  let url, headers;
  if (cfg.D1_PROXY_URL) {
    url = cfg.D1_PROXY_URL + '/query';
    headers = { 'content-type': 'application/json', authorization: `Bearer ${cfg.D1_PROXY_SECRET}` };
  } else {
    url = `https://api.cloudflare.com/client/v4/accounts/${cfg.CF_ACCOUNT_ID}/d1/database/${cfg.D1_DATABASE_ID}/query`;
    headers = { 'content-type': 'application/json', authorization: `Bearer ${cfg.CF_API_TOKEN}` };
  }
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ sql, params }),
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => null);

  if (cfg.D1_PROXY_URL) {
    if (!res.ok || !json || json.error) {
      const e = new Error('D1 proxy error: ' + ((json && json.error) || `HTTP ${res.status}`));
      e.status = res.status;
      throw e;
    }
    return { results: json.results || [], meta: json.meta || {} };
  }

  if (!res.ok || !json || !json.success) {
    const msg = (json && json.errors && json.errors.map((x) => x.message).join('; ')) || `HTTP ${res.status}`;
    const e = new Error('D1 error: ' + msg);
    e.status = res.status;
    throw e;
  }
  const r = (json.result && json.result[0]) || {};
  if (r.success === false) throw new Error('D1 statement failed: ' + JSON.stringify(r.error || r));
  return { results: r.results || [], meta: r.meta || {} };
}

async function exec(sql, params = []) {
  params = params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
  const read = isRead(sql);
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await callOnce(sql, params);
    } catch (e) {
      last = e;
      // Retry only when it is safe: rate limits / gateway errors, or network errors on reads.
      const retryable =
        e.status === 429 || e.status === 502 || e.status === 503 || e.status === 504 ||
        (read && (e.name === 'TypeError' || e.name === 'TimeoutError'));
      if (!retryable || attempt === 3) break;
      await sleep(400 * 2 ** attempt);
    }
  }
  throw last;
}

module.exports = {
  exec,
  all: async (sql, params) => (await exec(sql, params)).results,
  first: async (sql, params) => (await exec(sql, params)).results[0] || null,
  run: async (sql, params) => {
    const { meta } = await exec(sql, params);
    return { changes: meta.changes || 0, lastId: meta.last_row_id || null };
  },
};
