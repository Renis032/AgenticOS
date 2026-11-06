'use strict';
// Code changes on a job: copies saved before an agent's first edit of a file, the diff, and undo.

function install(ctx) {
  const { DATA, SNAP_DIR, agents, crypto, fs, now, path, spawnSync, thread, ticketOfAgent, touchTicket } = ctx;
  const { spawn } = require('child_process');

  function snapshotBefore(agentId, file) {
    const me = agents.get(agentId);
    if (!me || !file) return;
    const abs = path.resolve(me.cwd || '/', file);
    if (abs.startsWith(DATA + path.sep)) return;
    const t = ticketOfAgent(me);
    if (!t) return;
    t.changes = t.changes || [];
    let c = t.changes.find((x) => x.path === abs);
    if (!c) {
      const snap = crypto.createHash('sha1').update(abs).digest('hex').slice(0, 16);
      let existed = false;
      try {
        if (fs.statSync(abs).isFile()) {
          fs.mkdirSync(path.join(SNAP_DIR, t.id), { recursive: true });
          fs.copyFileSync(abs, path.join(SNAP_DIR, t.id, snap));
          existed = true;
        }
      } catch {}
      c = { path: abs, snap, existed, by: [], at: now() };
      t.changes.push(c);
    }
    delete c.revertedAt;
    if (!c.by.includes(agentId)) c.by.push(agentId);
    touchTicket(t);
  }

  // Diffs are cached until the file or its saved copy changes (size, time, inode): opening a job with many changed
  // files used to start one diff process per file on every request, holding the whole office up for seconds.
  const diffCache = new Map(); // "<job>|<path>" -> { sig, result }
  const sigOf = (f) => { try { const st = fs.statSync(f); return `${st.size}:${st.mtimeMs}:${st.ino}`; } catch { return '-'; } };
  const keyOf = (t, c) => `${t.id}|${c.path}`;
  const sigFor = (t, c) => `${sigOf(c.path)}|${c.existed ? sigOf(path.join(SNAP_DIR, t.id, c.snap)) : 'new'}|${c.revertedAt || 0}|${c.by.join(',')}`;
  function cached(t, c, sig) { const k = keyOf(t, c); const hit = diffCache.get(k); if (hit && hit.sig === sig) { diffCache.delete(k); diffCache.set(k, hit); return hit.result; } return null; }
  // Kept to 1,500 diffs and 32 MB, least recently used first out.
  let diffBytes = 0;
  const MAX_DIFF_BYTES = 32 << 20;
  function remember(t, c, sig, result) {
    const k = keyOf(t, c);
    const old = diffCache.get(k);
    if (old) { diffBytes -= old.bytes; diffCache.delete(k); }
    const bytes = (result.diff || '').length + 200;
    diffCache.set(k, { sig, result, bytes });
    diffBytes += bytes;
    while (diffCache.size > 1500 || diffBytes > MAX_DIFF_BYTES) { const [fk, fv] = diffCache.entries().next().value; diffCache.delete(fk); diffBytes -= fv.bytes; }
    return result;
  }
  const diffArgs = (t, c, exists) => ['-u', '--label', 'before', '--label', 'now', c.existed ? path.join(SNAP_DIR, t.id, c.snap) : '/dev/null', exists ? c.path : '/dev/null'];
  const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };

  // For code that needs the changes right away (the checks); the window uses changesOfAsync.
  function changesOf(t) {
    return (t.changes || []).map((c) => {
      const sig = sigFor(t, c);
      const hit = cached(t, c, sig);
      if (hit) return hit;
      const exists = isFile(c.path);
      return remember(t, c, sig, summarize(t, c, exists, spawnSync('diff', diffArgs(t, c, exists), { encoding: 'utf8', maxBuffer: 16 << 20 }).stdout || ''));
    });
  }
  // The same, with the diffs that are not cached yet run in parallel (8 at a time) without holding up the office.
  async function changesOfAsync(t) {
    const list = t.changes || [];
    const out = new Array(list.length);
    let next = 0;
    const one = (c) => new Promise((resolve) => {
      const exists = isFile(c.path);
      const child = spawn('diff', diffArgs(t, c, exists), { stdio: ['ignore', 'pipe', 'ignore'] });
      let buf = '';
      child.stdout.on('data', (d) => { if (buf.length < (16 << 20)) buf += d; });
      child.on('close', () => resolve(summarize(t, c, exists, buf)));
      child.on('error', () => resolve(summarize(t, c, exists, '')));
    });
    const worker = async () => {
      while (next < list.length) {
        const i = next++;
        const c = list[i];
        const sig = sigFor(t, c);
        out[i] = cached(t, c, sig) || remember(t, c, sig, await one(c));
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, list.length) }, worker));
    return out;
  }
  function summarize(t, c, exists, diffText) {
    {
      let diff = diffText;
      const added = (diff.match(/^\+(?!\+\+ )/gm) || []).length;
      const removed = (diff.match(/^-(?!-- )/gm) || []).length;
      if (diff.length > 150000) diff = diff.slice(0, 150000) + '\n… (diff truncated)';
      const state = !c.existed && !exists ? 'unchanged' : !c.existed ? 'added' : !exists ? 'deleted' : diff ? 'modified' : 'unchanged';
      return { path: c.path, state, added, removed, diff, revertedAt: c.revertedAt || null,
        by: c.by.map((id) => (agents.get(id) || {}).persona || id) };
    }
  }

  function revertChanges(t, file) {
    const done = [];
    for (const c of t.changes || []) {
      if (file && c.path !== file) continue;
      if (c.existed) {
        fs.mkdirSync(path.dirname(c.path), { recursive: true });
        fs.copyFileSync(path.join(SNAP_DIR, t.id, c.snap), c.path);
      } else {
        try { fs.unlinkSync(c.path); } catch {}
      }
      c.revertedAt = now();
      done.push(c.path);
    }
    if (done.length) thread(t, { from: 'system', kind: 'system', text: `You undid the agents' changes to ${done.length === 1 ? done[0] : `${done.length} files`}.` });
    return done;
  }

  return { changesOf, changesOfAsync, revertChanges, snapshotBefore };
}

module.exports = { install };
