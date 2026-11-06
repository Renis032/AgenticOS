'use strict';
// The job's live preview: the app the agent is building, shown on the job page, where the user can point at something and
// say what to change.
//
// The app runs on its own dev server (a URL, or a command the office starts in the job's folder). The window can't reach
// into another origin's page, so each preview gets a small proxy on its own port, which adds a script to HTML pages. The
// script reports what the user clicks to the window with postMessage. It never sends anything else, and the proxy
// is served from "localhost" on purpose: the office is on 127.0.0.1, so the two are different sites, and the office's
// session cookie is not sent to the proxy, nor to the app behind it. (The proxy strips it anyway.)
//
// Only loopback targets are allowed, never the office itself, and the proxy only answers its own Host, so another site
// can't reach through it by rebinding a DNS name. It stops by itself when nobody has used it for a while.
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');

const HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);
const SCRIPT_PATH = '/__agentos_preview.js';
const IDLE_MS = 30 * 60000;
const START_WAIT_MS = 120000;
const HTML_MAX = 30 << 20;
const LOG_CHARS = 4000;
const DROP_RESPONSE = ['content-security-policy', 'content-security-policy-report-only', 'x-frame-options', 'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy', 'strict-transport-security'];

// Runs inside the previewed page. Listens only to the window that embeds it; reports what the user points at.
const PAGE_SCRIPT = `(() => {
  if (window.__agentosPreview || window.parent === window) return;
  window.__agentosPreview = true;
  let on = false, box = null, last = null;
  const say = (m) => window.parent.postMessage({ agentosPreview: 1, ...m }, '*');
  const cut = (s, n) => String(s || '').replace(/\\s+/g, ' ').trim().slice(0, n);
  function selector(el) {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && e !== document.documentElement && parts.length < 6; e = e.parentElement) {
      const test = e.getAttribute('data-testid') || e.getAttribute('data-test');
      if (test) { parts.unshift('[data-testid="' + test + '"]'); break; }
      if (e.id && document.querySelectorAll('#' + CSS.escape(e.id)).length === 1) { parts.unshift('#' + CSS.escape(e.id)); break; }
      let s = e.tagName.toLowerCase();
      const cls = [...e.classList].filter((c) => !/^(css-|sc-|jsx-)|[0-9a-f]{6}/.test(c)).slice(0, 2);
      if (cls.length) s += '.' + cls.map((c) => CSS.escape(c)).join('.');
      const same = e.parentElement ? [...e.parentElement.children].filter((c) => c.tagName === e.tagName) : [];
      if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(e) + 1) + ')';
      parts.unshift(s);
    }
    return parts.join(' > ');
  }
  function describe(el) {
    const r = el.getBoundingClientRect(), c = getComputedStyle(el);
    return { selector: selector(el), tag: el.tagName.toLowerCase(), text: cut(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('alt'), 200), html: String(el.outerHTML || '').slice(0, 800),
      rect: { x: r.x, y: r.y, w: r.width, h: r.height }, viewport: { w: innerWidth, h: innerHeight }, url: location.pathname + location.search + location.hash,
      style: { fontSize: c.fontSize, fontWeight: c.fontWeight, color: c.color, background: c.backgroundColor, padding: c.padding, margin: c.margin, display: c.display } };
  }
  function outline(el) {
    if (!box) { box = document.createElement('div'); box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #e8a33d;background:rgba(232,163,61,.15);border-radius:2px;box-sizing:border-box'; document.documentElement.appendChild(box); }
    const r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px'; box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
  }
  const hide = () => { if (box) box.style.display = 'none'; };
  const move = (e) => { if (e.target !== last) { last = e.target; outline(e.target); } };
  const swallow = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
  const click = (e) => { swallow(e); setPick(false, true); outline(e.target); say({ type: 'picked', element: describe(e.target) }); };
  const key = (e) => { if (e.key === 'Escape') { swallow(e); setPick(false); say({ type: 'cancelled' }); } };
  function setPick(v, keepBox) {
    if (v === on) return;
    on = v;
    const f = v ? 'addEventListener' : 'removeEventListener';
    window[f]('mousemove', move, true); window[f]('click', click, true); window[f]('mousedown', swallow, true); window[f]('mouseup', swallow, true); window[f]('keydown', key, true);
    document.documentElement.style.cursor = v ? 'crosshair' : '';
    if (!v && !keepBox) hide();
  }
  addEventListener('message', (e) => {
    if (e.source !== window.parent || !e.data || !e.data.agentosPreview) return;
    if (e.data.type === 'pick') { last = null; setPick(!!e.data.on); }
    else if (e.data.type === 'clear') hide();
  });
  say({ type: 'ready', url: location.pathname + location.search + location.hash, title: document.title });
})();`;

// A URL the proxy may stand in front of: http(s) on this computer, not the office.
function checkTarget(raw, officePort) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return { error: 'That is not a URL. Try something like http://localhost:5173.' }; }
  if (!['http:', 'https:'].includes(u.protocol)) return { error: 'Only http and https addresses can be previewed.' };
  if (!HOSTS.has(u.hostname.toLowerCase())) return { error: 'Only an app on this computer can be previewed (localhost or 127.0.0.1).' };
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  if (port === Number(officePort)) return { error: 'That is the office itself.' };
  return { url: u, host: u.hostname === '0.0.0.0' ? '127.0.0.1' : u.hostname.replace(/^\[|\]$/g, ''), port, tls: u.protocol === 'https:' };
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

function stripOfficeCookie(header) {
  if (!header) return header;
  const left = String(header).split(/;\s*/).filter((c) => !c.startsWith('agentos='));
  return left.length ? left.join('; ') : undefined;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const end = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(1000, () => end(false));
    s.on('connect', () => end(true));
    s.on('error', () => end(false));
  });
}

function install(ctx) {
  const { blockedCommand, broadcast, killGroup, now, PORT, readJson, spawn, thread, tickets, touchTicket, workdirOf } = ctx;
  const live = new Map(); // ticketId → { server, port, origin, target, child, status, error, log, lastUsed, cmd }

  // ---------------------------------------------------------------- the proxy

  function inject(html) {
    const tag = `<script src="${SCRIPT_PATH}"></script>`;
    const m = /<head(\s[^>]*)?>/i.exec(html);
    if (m) return html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length);
    return tag + html;
  }

  function proxyHeaders(req, rec) {
    const h = { ...req.headers };
    const cookie = stripOfficeCookie(h.cookie);
    if (cookie) h.cookie = cookie; else delete h.cookie;
    delete h['x-agentos-token'];
    h.host = rec.target.url.host;
    if (h.origin) h.origin = rec.target.url.origin;
    if (h.referer) h.referer = String(h.referer).replace(rec.origin, rec.target.url.origin);
    return h;
  }

  function respond(rec, res, up, method) {
    const headers = { ...up.headers };
    // The request asked for no compression; a server that compresses anyway gets its page passed on without the script.
    const html = /text\/html/i.test(String(headers['content-type'] || '')) && method !== 'HEAD' && !headers['content-encoding'];
    for (const k of DROP_RESPONSE) delete headers[k];
    // The page is sent whole with its new length, so neither of the ways the app framed it still holds.
    if (html) { delete headers['content-length']; delete headers['transfer-encoding']; }
    // A redirect to the app's own address stays in the frame, whichever name for this computer it uses.
    if (headers.location) headers.location = String(headers.location).replace(new RegExp(`^https?://(?:localhost|127\\.0\\.0\\.1|\\[::1\\]):${rec.target.port}(?=/|$)`), rec.origin);
    if (headers['set-cookie']) {
      headers['set-cookie'] = [].concat(headers['set-cookie']).filter((c) => !/^agentos=/i.test(c)).map((c) => c.replace(/;\s*domain=[^;]*/i, '').replace(/;\s*secure/i, ''));
      if (!headers['set-cookie'].length) delete headers['set-cookie'];
    }
    if (!html) { res.writeHead(up.statusCode, headers); up.pipe(res); return; }
    const chunks = [];
    let n = 0, tooBig = false;
    up.on('data', (c) => {
      if (tooBig) { res.write(c); return; }
      n += c.length;
      chunks.push(c);
      if (n > HTML_MAX) { tooBig = true; res.writeHead(up.statusCode, headers); for (const x of chunks) res.write(x); chunks.length = 0; }
    });
    up.on('end', () => {
      if (tooBig) { res.end(); return; }
      const out = Buffer.from(inject(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(up.statusCode, { ...headers, 'content-length': out.length });
      res.end(out);
    });
    up.on('error', () => { try { res.destroy(); } catch {} });
  }

  function handle(rec, req, res) {
    if (String(req.headers.host || '').toLowerCase() !== `localhost:${rec.port}`) { res.writeHead(403); return res.end('Blocked.'); }
    rec.lastUsed = now();
    if (req.url === SCRIPT_PATH) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(PAGE_SCRIPT);
    }
    const T = rec.target;
    const headers = { ...proxyHeaders(req, rec), 'accept-encoding': 'identity' };
    const up = (T.tls ? https : http).request({ host: T.host, port: T.port, method: req.method, path: req.url, headers, rejectUnauthorized: false }, (r) => respond(rec, res, r, req.method));
    up.on('error', (e) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>Not running</title><body style="font:15px system-ui;padding:32px;color:#555"><h3>The app isn't answering at ${T.url.origin}</h3><p>${String(e.message).replace(/</g, '&lt;')}</p><p>It may still be starting. Reload the preview in a moment.</p>`);
    });
    req.pipe(up);
  }

  // Hot reload and other websockets, passed through untouched apart from the same header rules.
  function upgrade(rec, req, socket, head) {
    if (String(req.headers.host || '').toLowerCase() !== `localhost:${rec.port}`) return socket.destroy();
    const T = rec.target;
    const up = T.tls ? tls.connect({ host: T.host, port: T.port, rejectUnauthorized: false, servername: T.host }) : net.connect({ host: T.host, port: T.port });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
    up.once(T.tls ? 'secureConnect' : 'connect', () => {
      const h = proxyHeaders(req, rec);
      const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(h).flatMap(([k, v]) => [].concat(v).map((x) => `${k}: ${x}`))];
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head && head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
  }

  async function openProxy(rec) {
    rec.port = await freePort();
    rec.origin = `http://localhost:${rec.port}`;
    rec.server = http.createServer((req, res) => handle(rec, req, res));
    rec.server.on('upgrade', (req, socket, head) => upgrade(rec, req, socket, head));
    await new Promise((resolve, reject) => { rec.server.on('error', reject); rec.server.listen(rec.port, '127.0.0.1', resolve); });
  }

  // ---------------------------------------------------------------- starting and stopping

  const announce = (id) => broadcast({ type: 'preview', ticketId: id });
  const sandboxed = (t) => { const p = t.project && readJson('projects.json').find((x) => x.name === t.project); return !!(p && p.sandbox); };

  function stop(id) {
    const rec = live.get(id);
    if (!rec) return;
    live.delete(id);
    try { rec.server && rec.server.close(); if (rec.server && rec.server.closeAllConnections) rec.server.closeAllConnections(); } catch {}
    if (rec.child) { try { killGroup(rec.child); } catch {} }
    clearTimeout(rec.waitTimer);
    announce(id);
  }

  function status(t) {
    const rec = live.get(t.id);
    const p = t.preview || {};
    return { url: p.url || '', cmd: p.cmd || '', running: !!rec, status: rec ? rec.status : 'stopped', origin: rec ? rec.origin : null, error: (rec && rec.error) || p.error || null, log: rec ? rec.log.slice(-LOG_CHARS) : '', sandboxed: sandboxed(t) };
  }

  function waitForServer(id, rec) {
    const until = now() + START_WAIT_MS;
    const check = async () => {
      if (live.get(id) !== rec) return;
      if (!rec.target) {
        const seen = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+[^\s"']*/.exec(stripAnsi(rec.log));
        const T = seen && checkTarget(seen[0], PORT);
        if (T && !T.error) rec.target = T;
      }
      const T = rec.target || checkTarget(`http://127.0.0.1:${rec.envPort}`, PORT);
      if (await canConnect(T.host, T.port)) {
        if (live.get(id) !== rec) return;
        rec.target = T;
        rec.status = 'ready';
        const t = tickets.get(id);
        if (t) { t.preview = { ...t.preview, url: T.url.href, error: null }; touchTicket(t); }
        announce(id);
        return;
      }
      if (rec.childGone || now() > until) {
        rec.status = 'failed';
        rec.error = rec.childGone ? 'The command ended before an app answered.' : 'No app answered after two minutes. Check the command and its output.';
        announce(id);
        return;
      }
      rec.waitTimer = setTimeout(check, 700);
    };
    check();
  }

  async function start(t, b) {
    stop(t.id);
    const cmd = String(b.cmd || '').trim();
    const rawUrl = String(b.url || '').trim();
    if (!cmd && !rawUrl) return { error: 'Give the address of the app, or a command that starts it.' };
    const target = rawUrl ? checkTarget(rawUrl, PORT) : null;
    if (target && target.error) return target;
    if (cmd) {
      if (sandboxed(t)) return { error: 'A sandboxed job\'s container isn\'t reachable from here, so give the address instead.' };
      const bad = blockedCommand(readJson('roster.json'), cmd);
      if (bad) return { error: `"${bad}" is on the block list.` };
    }
    const rec = { target, status: cmd ? 'starting' : 'ready', log: '', lastUsed: now(), cmd };
    live.set(t.id, rec);
    t.preview = { url: rawUrl, cmd, error: null };
    try {
      await openProxy(rec);
    } catch (e) {
      live.delete(t.id);
      return { error: `Could not open the preview: ${e.message}` };
    }
    if (cmd) {
      rec.envPort = await freePort();
      const env = { ...process.env, PORT: String(rec.envPort), HOST: '127.0.0.1', BROWSER: 'none', ELECTRON_RUN_AS_NODE: undefined };
      const child = spawn('bash', ['-lc', cmd], { cwd: workdirOf(t), detached: true, stdio: ['ignore', 'pipe', 'pipe'], env });
      rec.child = child;
      const keep = (d) => { rec.log = (rec.log + d).slice(-LOG_CHARS * 2); };
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      child.on('error', (e) => { keep(`\n${e.message}`); rec.childGone = true; });
      child.on('close', () => { rec.childGone = true; rec.child = null; if (rec.status === 'ready' && live.get(t.id) === rec) { rec.status = 'failed'; rec.error = 'The app\'s command ended.'; announce(t.id); } });
      waitForServer(t.id, rec);
    }
    touchTicket(t);
    announce(t.id);
    return status(t);
  }

  // The lead says where the app it built is running (the show_preview tool). Nothing starts until the user opens it.
  function offer(t, by, rawUrl) {
    const T = checkTarget(rawUrl, PORT);
    if (T.error) return T;
    t.preview = { ...(t.preview || {}), url: T.url.href, error: null };
    thread(t, { from: by, to: 'user', kind: 'system', text: `The app is running at ${T.url.href}: open the Preview tab to see it and point at what to change.` });
    touchTicket(t);
    announce(t.id);
    return { message: 'The Preview tab now points there. The user can click anything in it and send you a comment, which arrives as a follow-up.' };
  }

  function sweep() {
    for (const [id, rec] of live) if (now() - rec.lastUsed > IDLE_MS) stop(id);
  }
  setInterval(sweep, 60000).unref();

  async function route(req, res, url, p, body, json) {
    if (req.method === 'POST' && p === '/api/show-preview') {
      const b = await body(req);
      const a = ctx.agents.get(b.agentId);
      const t = a && ctx.ticketOfAgent(a);
      return json(res, 200, t ? offer(t, a.id, b.url) : { error: 'You have no current ticket.' }), true;
    }
    const m = p.match(/^\/api\/tickets\/(\w+)\/preview(?:\/(stop))?$/);
    if (!m) return false;
    const t = tickets.get(m[1]);
    if (!t) return json(res, 404, { error: 'not found' }), true;
    if (req.method === 'GET' && !m[2]) return json(res, 200, status(t)), true;
    if (req.method !== 'POST') return false;
    if (m[2]) { stop(t.id); return json(res, 200, status(t)), true; }
    const r = await start(t, await body(req));
    return json(res, r.error ? 400 : 200, r), true;
  }

  return { offer, route, status, stop, stopAll: () => { for (const id of [...live.keys()]) stop(id); } };
}

module.exports = { install, checkTarget, PAGE_SCRIPT };
