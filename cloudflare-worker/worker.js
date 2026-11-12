// OPTIONAL D1 proxy Worker — use it for high traffic (avoids Cloudflare REST API rate limits).
// Deploy:  cd cloudflare-worker && npx wrangler deploy && npx wrangler secret put PROXY_SECRET
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/query') {
      return Response.json({ error: 'not found' }, { status: 404 });
    }
    const auth = request.headers.get('authorization') || '';
    if (!env.PROXY_SECRET || auth !== `Bearer ${env.PROXY_SECRET}`) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    try {
      const { sql, params } = await request.json();
      if (typeof sql !== 'string' || !sql.trim()) return Response.json({ error: 'sql required' }, { status: 400 });
      const r = await env.DB.prepare(sql).bind(...(Array.isArray(params) ? params : [])).all();
      return Response.json({ results: r.results || [], meta: r.meta || {} });
    } catch (e) {
      return Response.json({ error: String((e && e.message) || e) }, { status: 400 });
    }
  },
};
