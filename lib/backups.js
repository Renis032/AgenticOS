'use strict';
// Backups of the office's data: everything in data/ (agents, jobs, memories, events, undo snapshots, uploads) except
// caches that rebuild themselves (data/usage) and old code copies (data/backups). One compressed snapshot a day in
// backups/ (next to data/, not inside it, so a restore can replace data/), the newest defaults.keepDataBackups (7) kept,
// plus "Back up now" in Preferences.
//
// Restoring happens at start-up: the request is saved, the office restarts as soon as nothing runs, and before anything is
// loaded the current data is backed up as before-restore-<time>.tgz and replaced by the chosen backup. The app token and
// the server log stay, so the open window keeps working.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DAY = 86400000;
const KEEP_IN_PLACE = ['app-token', 'server.log', 'usage', 'backups'];
const dirOf = (ROOT) => path.join(ROOT, 'backups');
const pendingFile = (ROOT) => path.join(dirOf(ROOT), 'restore-pending.json');
const stamp = (t) => new Date(t).toISOString().slice(0, 16).replace('T', '_').replace(':', '');

function tarData(ROOT, file) {
  const tmp = `${file}.tmp`;
  const r = spawnSync('tar', ['-czf', tmp, '-C', ROOT, '--exclude=data/usage', '--exclude=data/backups', '--exclude=data/*.tmp', '--exclude=data/app-token', 'data'], { encoding: 'utf8' });
  // tar exits 1 when a file changed while it was read (an event log being appended); the archive is still good.
  if (r.status > 1 || !fs.existsSync(tmp)) { try { fs.rmSync(tmp, { force: true }); } catch {} throw new Error(`tar failed: ${(r.stderr || '').trim().slice(0, 300)}`); }
  fs.renameSync(tmp, file);
  return file;
}

// Called by server.js before it loads any state.
function applyPendingRestore(ROOT, DATA) {
  let req;
  try { req = JSON.parse(fs.readFileSync(pendingFile(ROOT), 'utf8')); } catch { return null; }
  fs.rmSync(pendingFile(ROOT), { force: true });
  const src = path.join(dirOf(ROOT), path.basename(String(req.name || '')));
  if (!fs.existsSync(src)) { console.error(`Restore skipped: ${src} is missing.`); return null; }
  const t = Date.now();
  tarData(ROOT, path.join(dirOf(ROOT), `before-restore-${stamp(t)}.tgz`));
  const old = path.join(dirOf(ROOT), `.old-data-${t}`);
  fs.mkdirSync(old, { recursive: true });
  for (const f of fs.readdirSync(DATA)) if (!KEEP_IN_PLACE.includes(f)) fs.renameSync(path.join(DATA, f), path.join(old, f));
  const r = spawnSync('tar', ['-xzf', src, '-C', ROOT, '--exclude=data/app-token', '--exclude=data/server.log'], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`Restore failed, keeping the current data: ${(r.stderr || '').trim().slice(0, 300)}`);
    for (const f of fs.readdirSync(DATA)) if (!KEEP_IN_PLACE.includes(f)) fs.rmSync(path.join(DATA, f), { recursive: true, force: true });
    for (const f of fs.readdirSync(old)) fs.renameSync(path.join(old, f), path.join(DATA, f));
    fs.rmSync(old, { recursive: true, force: true });
    return { ok: false };
  }
  fs.rmSync(old, { recursive: true, force: true });
  console.log(`Restored data from ${path.basename(src)} (the data it replaced is in before-restore-${stamp(t)}.tgz).`);
  return { ok: true, name: path.basename(src) };
}

function install(ctx) {
  const { ROOT, readJson, saveNow, requestRestart, broadcast } = ctx;
  const dir = dirOf(ROOT);
  const keep = () => Math.max(1, Number((readJson('roster.json').defaults || {}).keepDataBackups) || 7);

  function list() {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.tgz')); } catch {}
    return files.map((name) => { const st = fs.statSync(path.join(dir, name)); return { name, size: st.size, t: st.mtimeMs, kind: name.startsWith('before-restore-') ? 'before-restore' : name.includes('-manual') ? 'manual' : 'daily' }; })
      .sort((a, b) => b.t - a.t);
  }
  function prune() {
    const all = list();
    const drop = [...all.filter((b) => b.kind !== 'before-restore').slice(keep()), ...all.filter((b) => b.kind === 'before-restore').slice(3)];
    for (const b of drop) fs.rmSync(path.join(dir, b.name), { force: true });
  }
  function backupNow(manual) {
    fs.mkdirSync(dir, { recursive: true });
    saveNow();
    const file = tarData(ROOT, path.join(dir, `agentos-data-${stamp(Date.now())}${manual ? '-manual' : ''}.tgz`));
    prune();
    if (broadcast) broadcast({ type: 'backups' });
    return { ok: true, name: path.basename(file), list: list() };
  }
  // Once a day: after start-up and then hourly, back up if the newest daily or manual backup is older than a day.
  function maybeDaily() {
    const last = list().find((b) => b.kind !== 'before-restore');
    if (last && Date.now() - last.t < DAY) return null;
    try { return backupNow(false); } catch (e) { console.error(`Daily backup failed: ${e.message}`); return null; }
  }
  function requestRestore(name) {
    const b = list().find((x) => x.name === path.basename(String(name || '')));
    if (!b) return { error: 'No such backup.' };
    fs.writeFileSync(pendingFile(ROOT), JSON.stringify({ name: b.name, at: Date.now() }));
    requestRestart(true, { check: false });
    return { ok: true, message: `Restoring ${b.name}: the office restarts as soon as nothing is running.` };
  }
  function view() { return { list: list(), keep: keep(), dir, pending: fs.existsSync(pendingFile(ROOT)) }; }

  async function route(req, res, p, body, json) {
    if (req.method === 'GET' && p === '/api/backups') { json(res, 200, view()); return true; }
    if (req.method === 'POST' && p === '/api/backups') {
      try { json(res, 200, backupNow(true)); } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    if (req.method === 'POST' && p === '/api/backups/restore') { const b = await body(req); const r = requestRestore(b.name); json(res, r.error ? 400 : 200, r); return true; }
    return false;
  }
  return { list, backupNow, maybeDaily, requestRestore, view, route };
}

module.exports = { install, applyPendingRestore };
