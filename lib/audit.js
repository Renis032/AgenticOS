'use strict';
// A record of who decided what: approved commands, edit access, plans, chat cards, restored instructions. Each line in
// data/audit.jsonl carries a hash of itself and the line before, so changing or removing an earlier line shows up when the
// chain is checked. It detects tampering; it cannot prevent someone with access to the folder from rewriting the whole file.
const crypto = require('crypto');
const { redact } = require('./secrets');

const MAX_DETAIL = 400;
const digest = (prev, e) => crypto.createHash('sha256').update(prev + JSON.stringify(e)).digest('hex');

function install({ DATA, fs, now, path }) {
  const FILE = path.join(DATA, 'audit.jsonl');
  const lines = () => { try { return fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  const lastLine = lines().pop();
  let head = '';
  try { head = lastLine ? JSON.parse(lastLine).hash : ''; } catch { head = 'damaged'; }

  // actor: 'user', or 'office' when a setting or rule decided by itself.
  function record(actor, action, info = {}) {
    const e = { t: now(), actor, action, job: info.job == null ? null : info.job, detail: redact(String(info.detail || '')).slice(0, MAX_DETAIL) };
    const hash = digest(head, e);
    try { fs.mkdirSync(DATA, { recursive: true }); fs.appendFileSync(FILE, JSON.stringify({ ...e, hash }) + '\n', { mode: 0o600 }); head = hash; } catch (err) { console.error(`audit: ${err.message}`); }
  }

  function check() {
    let prev = '', n = 0;
    for (const l of lines()) {
      n++;
      let e;
      try { e = JSON.parse(l); } catch { return { ok: false, entries: n, brokenAt: n }; }
      const { hash, ...rest } = e;
      if (digest(prev, rest) !== hash) return { ok: false, entries: n, brokenAt: n };
      prev = hash;
    }
    return { ok: true, entries: n };
  }

  const recent = (limit = 50) => lines().slice(-limit).reverse().map((l) => { try { const { hash, ...e } = JSON.parse(l); return e; } catch { return null; } }).filter(Boolean);
  return { check, recent, record };
}

module.exports = { install };
