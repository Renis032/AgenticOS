'use strict';
// Code changes on a job: copies saved before an agent's first edit of a file, the diff, and undo.

function install(ctx) {
  const { DATA, SNAP_DIR, agents, crypto, fs, now, path, spawnSync, thread, ticketOfAgent, touchTicket } = ctx;

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

  function changesOf(t) {
    return (t.changes || []).map((c) => {
      const snapFile = path.join(SNAP_DIR, t.id, c.snap);
      let exists = false;
      try { exists = fs.statSync(c.path).isFile(); } catch {}
      const r = spawnSync('diff', ['-u', '--label', 'before', '--label', 'now', c.existed ? snapFile : '/dev/null', exists ? c.path : '/dev/null'],
        { encoding: 'utf8', maxBuffer: 16 << 20 });
      let diff = r.stdout || '';
      const added = (diff.match(/^\+(?!\+\+ )/gm) || []).length;
      const removed = (diff.match(/^-(?!-- )/gm) || []).length;
      if (diff.length > 150000) diff = diff.slice(0, 150000) + '\n… (diff truncated)';
      const state = !c.existed && !exists ? 'unchanged' : !c.existed ? 'added' : !exists ? 'deleted' : diff ? 'modified' : 'unchanged';
      return { path: c.path, state, added, removed, diff, revertedAt: c.revertedAt || null,
        by: c.by.map((id) => (agents.get(id) || {}).persona || id) };
    });
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

  return { changesOf, revertChanges, snapshotBefore };
}

module.exports = { install };
