'use strict';
// How agents sign in to Claude: the user's Claude Code login (the default, billed to their plan) or an Anthropic API
// key (billed per use, the supported route for a product). The key lives in data/auth.json (git-ignored, mode 0600);
// the window only ever sees its last four characters. Every claude process gets it through childEnv (lib/prompts.js).
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const KEY_RE = /^sk-ant-[A-Za-z0-9_-]{20,}$/;

function install({ DATA, broadcast, onChange }) {
  const FILE = path.join(DATA, 'auth.json');
  // Where a pasted key is checked; the API check points this at a stand-in.
  const BASE = (process.env.AGENTOS_ANTHROPIC_CHECK_URL || 'https://api.anthropic.com').replace(/\/$/, '');
  let cfg = load();

  function load() {
    try {
      const c = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      const apiKey = KEY_RE.test(c.apiKey || '') ? c.apiKey : null;
      return { mode: c.mode === 'apiKey' && apiKey ? 'apiKey' : 'login', apiKey, checkedAt: c.checkedAt || null };
    } catch { return { mode: 'login', apiKey: null, checkedAt: null }; }
  }
  function save() {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    try { fs.chmodSync(FILE, 0o600); } catch {}
  }

  // 'plan': the Claude Code login, with its 5-hour and weekly windows. 'api': an API key, billed per token, no windows.
  const billing = () => (cfg.mode === 'apiKey' && cfg.apiKey ? 'api' : 'plan');

  function view() {
    return { mode: billing() === 'api' ? 'apiKey' : 'login', billing: billing(), hasKey: !!cfg.apiKey,
      keyHint: cfg.apiKey ? `sk-ant-…${cfg.apiKey.slice(-4)}` : null, checkedAt: cfg.checkedAt,
      // A key in the environment the office started from: Claude Code uses it even in login mode.
      envKey: !!process.env.ANTHROPIC_API_KEY };
  }

  // Called on the environment of every claude process the office starts.
  function applyEnv(env) {
    if (billing() === 'api') {
      env.ANTHROPIC_API_KEY = cfg.apiKey;
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
      delete env.ANTHROPIC_AUTH_TOKEN;
    }
    return env;
  }

  // One free call (the model list) to see whether Anthropic accepts the key.
  function checkKey(key) {
    return new Promise((resolve) => {
      const u = new URL(`${BASE}/v1/models?limit=1`);
      const req = (u.protocol === 'http:' ? http : https).request(u, { method: 'GET', timeout: 15000,
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }, (res) => {
        res.resume();
        res.on('end', () => {
          if (res.statusCode === 200) resolve({ ok: true });
          else if (res.statusCode === 401 || res.statusCode === 403) resolve({ error: 'Anthropic refused the key. Check that you copied all of it and that it is not revoked.' });
          else resolve({ error: `Anthropic answered ${res.statusCode}; try again in a moment.` });
        });
      });
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', (e) => resolve({ error: `Could not reach Anthropic to check the key (${e.message}).` }));
      req.end();
    });
  }

  function changed() {
    broadcast({ type: 'auth', auth: view() });
    if (onChange) onChange();
  }

  async function route(req, res, url, p, body, json) {
    if (p !== '/api/auth' && p !== '/api/auth/mode') return false;
    if (p === '/api/auth' && req.method === 'GET') return json(res, 200, view()), true;
    if (p === '/api/auth' && req.method === 'POST') {
      const b = await body(req);
      const key = String(b.apiKey || '').trim();
      if (!KEY_RE.test(key)) return json(res, 400, { error: 'That does not look like an Anthropic API key (it starts with sk-ant-). Create one at console.anthropic.com → API keys.' }), true;
      const r = await checkKey(key);
      if (r.error) return json(res, 400, { error: r.error }), true;
      cfg = { mode: 'apiKey', apiKey: key, checkedAt: Date.now() };
      save();
      changed();
      return json(res, 200, view()), true;
    }
    if (p === '/api/auth/mode' && req.method === 'POST') {
      const b = await body(req);
      if (b.mode === 'apiKey' && !cfg.apiKey) return json(res, 400, { error: 'Add an API key first.' }), true;
      cfg.mode = b.mode === 'apiKey' ? 'apiKey' : 'login';
      save();
      changed();
      return json(res, 200, view()), true;
    }
    if (p === '/api/auth' && req.method === 'DELETE') {
      cfg = { mode: 'login', apiKey: null, checkedAt: null };
      save();
      changed();
      return json(res, 200, view()), true;
    }
    return false;
  }

  return { route, applyEnv, billing, view };
}

module.exports = { install, KEY_RE };
