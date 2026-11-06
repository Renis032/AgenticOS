'use strict';
// App-only access: the backend answers only its own window (app token in a header or cookie, local host names, same origin).
// A browser is let in with a one-time launch code (./agentos --browser), so the token itself never lands in a URL or history.

function install(ctx) {
  const { crypto, DATA, fs, path, PORT } = ctx;

  const APP_TOKEN = (() => {
    const f = path.join(DATA, 'app-token');
    try { const t = fs.readFileSync(f, 'utf8').trim(); if (t) return t; } catch {}
    const t = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(f, t, { mode: 0o600 });
    return t;
  })();
  const LOCAL_HOSTS = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
  // One-time launch codes: code -> expiry. Issued only to a caller holding the token; each opens one browser once.
  const launchCodes = new Map();
  const LAUNCH_TTL = 60000;

  function tokenMatches(t) {
    const a = Buffer.from(String(t || '')), b = Buffer.from(APP_TOKEN);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function deny(res, code, text) {
    res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(text);
    return false;
  }

  function guard(req, res, url) {
    if (!LOCAL_HOSTS.includes(String(req.headers.host || '').toLowerCase())) return deny(res, 403, 'Blocked.');
    if (url.pathname === '/__launch' && req.method === 'POST') {
      if (!tokenMatches(req.headers['x-agentos-token'])) return deny(res, 403, 'Blocked.');
      for (const [c, exp] of launchCodes) if (exp < Date.now()) launchCodes.delete(c);
      const code = crypto.randomBytes(18).toString('hex');
      launchCodes.set(code, Date.now() + LAUNCH_TTL);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code, url: `http://127.0.0.1:${PORT}/__app?c=${code}` }));
      return false;
    }
    if (url.pathname === '/__app') {
      const c = url.searchParams.get('c');
      const viaCode = c && launchCodes.has(c) && launchCodes.get(c) >= Date.now();
      if (c) launchCodes.delete(c);
      if (!viaCode && !tokenMatches(url.searchParams.get('t'))) return deny(res, 403, c ? 'That launch link has expired or was already used. Run ./agentos --browser again.' : 'Blocked.');
      res.writeHead(302, { 'set-cookie': `agentos=${APP_TOKEN}; Path=/; HttpOnly; SameSite=Strict`, location: '/' });
      res.end();
      return false;
    }
    const cookie = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith('agentos='));
    if (!tokenMatches(req.headers['x-agentos-token']) && !(cookie && tokenMatches(cookie.slice(8)))) {
      return deny(res, 403, 'Agentic OS only opens in its own window. Start it with ./agentos or from the applications menu.');
    }
    const origin = req.headers.origin;
    if (origin && req.method !== 'GET' && req.method !== 'HEAD' && !LOCAL_HOSTS.some((h) => origin === `http://${h}`)) return deny(res, 403, 'Blocked.');
    return true;
  }

  return { guard };
}

module.exports = { install };
