'use strict';
// OAuth for connectors: "Connect" opens the provider's consent page in the user's browser, and the provider sends the
// browser back to this office at http://127.0.0.1:<port>/oauth/<provider>/callback (a loopback redirect, the way desktop
// apps sign in). PKCE and a single-use state issued here mean only a sign-in this office started can complete it. Tokens
// are refreshed when they expire. Client credentials come from data/oauth-clients.json (set in Preferences), or the
// environment (AGENTOS_GOOGLE_CLIENT_ID / _SECRET) for a build that ships its own. Tokens live in data/oauth.json (0600).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const PROVIDERS = {
  google: {
    name: 'Google',
    authUrl: () => process.env.AGENTOS_GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: () => process.env.AGENTOS_GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
    extra: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    env: 'GOOGLE',
  },
};
const STATE_TTL = 10 * 60000;

function install({ DATA, PORT, broadcast, now }) {
  const FILE = path.join(DATA, 'oauth.json'), CLIENTS = path.join(DATA, 'oauth-clients.json');
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
  const write = (f, v) => { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2), { mode: 0o600 }); try { fs.chmodSync(f, 0o600); } catch {} };
  let tokens = read(FILE);
  const pending = new Map(); // state -> { provider, verifier, scopes, at, onDone }
  const listeners = {};      // provider -> [fn(tokens)] called after a sign-in completes

  function client(provider) {
    const P = PROVIDERS[provider];
    const c = read(CLIENTS)[provider] || {};
    const id = c.clientId || process.env[`AGENTOS_${P.env}_CLIENT_ID`] || '';
    const secret = c.clientSecret || process.env[`AGENTOS_${P.env}_CLIENT_SECRET`] || '';
    return id ? { id, secret, fromEnv: !c.clientId } : null;
  }
  function setClient(provider, b) {
    if (!PROVIDERS[provider]) return { error: 'Unknown provider.' };
    const all = read(CLIENTS);
    const id = String(b.clientId || '').trim(), secret = String(b.clientSecret || '').trim();
    if (!id) { delete all[provider]; write(CLIENTS, all); return { ok: true }; }
    if (provider === 'google' && !/^[\w-]+\.apps\.googleusercontent\.com$/.test(id)) return { error: 'A Google client ID ends in .apps.googleusercontent.com (Google Cloud → APIs & Services → Credentials → OAuth client ID, type "Desktop app").' };
    all[provider] = { clientId: id, clientSecret: secret };
    write(CLIENTS, all);
    return { ok: true };
  }

  const redirect = (provider) => `http://127.0.0.1:${PORT}/oauth/${provider}/callback`;
  const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  // The consent page to open in the user's browser.
  function start(provider, scopes) {
    const P = PROVIDERS[provider];
    const c = client(provider);
    if (!c) return { error: `Add a ${P.name} OAuth client ID first.` };
    for (const [s, v] of pending) if (now() - v.at > STATE_TTL) pending.delete(s);
    const state = b64url(crypto.randomBytes(24));
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    pending.set(state, { provider, verifier, scopes, at: now() });
    const u = new URL(P.authUrl());
    const q = { client_id: c.id, redirect_uri: redirect(provider), response_type: 'code', scope: scopes.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256', ...P.extra };
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
    return { url: u.toString(), state };
  }

  function post(url, form) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const data = Buffer.from(new URLSearchParams(form).toString());
      const req = (u.protocol === 'http:' ? http : https).request(u, { method: 'POST', timeout: 20000, headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': data.length, accept: 'application/json' } }, (res) => {
        let s = ''; res.on('data', (c) => (s += c));
        res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} if (res.statusCode === 200 && j && j.access_token) resolve(j); else reject(new Error((j && (j.error_description || j.error)) || `token endpoint answered ${res.statusCode}`)); });
      });
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', reject);
      req.end(data);
    });
  }

  function keep(provider, j, scopes) {
    const was = tokens[provider] || {};
    tokens[provider] = { access: j.access_token, refresh: j.refresh_token || was.refresh, expiresAt: now() + Math.max(30, Number(j.expires_in) || 3600) * 1000 - 30000,
      scopes: (j.scope ? String(j.scope).split(' ') : scopes || was.scopes || []), at: now() };
    write(FILE, tokens);
  }

  // A valid access token, refreshed when it has expired; null when not connected.
  async function accessToken(provider) {
    const T = tokens[provider];
    if (!T) return null;
    if (T.expiresAt > now()) return T.access;
    if (!T.refresh) return null;
    const c = client(provider);
    if (!c) return null;
    const j = await post(PROVIDERS[provider].tokenUrl(), { grant_type: 'refresh_token', refresh_token: T.refresh, client_id: c.id, ...(c.secret ? { client_secret: c.secret } : {}) });
    keep(provider, j);
    return tokens[provider].access;
  }

  function forget(provider) { delete tokens[provider]; write(FILE, tokens); }
  const connected = (provider) => !!(tokens[provider] && (tokens[provider].refresh || tokens[provider].expiresAt > now()));
  const scopesOf = (provider) => (tokens[provider] && tokens[provider].scopes) || [];
  function onConnect(provider, fn) { (listeners[provider] = listeners[provider] || []).push(fn); }

  const page = (title, text, ok) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:#faf9f6;color:#1d1c1a}@media(prefers-color-scheme:dark){body{background:#17161a;color:#ecebe8}}main{max-width:440px;padding:24px;text-align:center}h1{font-size:22px}b{color:${ok ? '#2f7a4b' : '#a33a2c'}}</style></head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;

  // The provider's redirect back. Runs before the token wall (the browser has no office cookie), so it only accepts a
  // state this office issued in the last ten minutes, once.
  async function callback(req, res, url) {
    const m = url.pathname.match(/^\/oauth\/(\w+)\/callback$/);
    if (!m || req.method !== 'GET') return false;
    const host = String(req.headers.host || '').toLowerCase();
    if (![`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(host)) { res.writeHead(403); res.end('Blocked.'); return true; }
    const send = (code, title, text, ok) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(page(title, text, ok)); };
    const provider = m[1];
    const state = url.searchParams.get('state') || '';
    const p = pending.get(state);
    pending.delete(state);
    if (!PROVIDERS[provider] || !p || p.provider !== provider || now() - p.at > STATE_TTL) { send(400, 'This sign-in link has expired', 'Start again from Agentic OS: Preferences → Connectors.', false); return true; }
    if (url.searchParams.get('error')) { send(400, 'Not connected', `${PROVIDERS[provider].name} said: ${String(url.searchParams.get('error')).replace(/[<>&"]/g, '')}. You can close this tab.`, false); return true; }
    const c = client(provider);
    try {
      const j = await post(PROVIDERS[provider].tokenUrl(), { grant_type: 'authorization_code', code: url.searchParams.get('code') || '', redirect_uri: redirect(provider), client_id: c.id, code_verifier: p.verifier, ...(c.secret ? { client_secret: c.secret } : {}) });
      keep(provider, j, p.scopes);
    } catch (e) { send(400, 'Not connected', `The sign-in could not be finished: ${String(e.message).replace(/[<>&"]/g, '')}. Start again from Agentic OS.`, false); return true; }
    for (const fn of listeners[provider] || []) { try { await fn(); } catch {} }
    broadcast({ type: 'connectors' });
    send(200, 'Connected', `<b>${PROVIDERS[provider].name} is connected to Agentic OS.</b> You can close this tab and go back to the office.`, true);
    return true;
  }

  return { accessToken, callback, client, connected, forget, onConnect, scopesOf, setClient, start, PROVIDERS };
}

module.exports = { install, PROVIDERS };
