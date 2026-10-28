'use strict';
// App-only access: the backend answers only its own window (app token in a header or cookie, local host names, same origin). Moved out of server.js unchanged.

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
    if (url.pathname === '/__app') {
      if (!tokenMatches(url.searchParams.get('t'))) return deny(res, 403, 'Blocked.');
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
