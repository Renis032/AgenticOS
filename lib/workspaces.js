'use strict';
// Isolated workspaces: a job on a git project can work in its own git worktree instead of the project folder, so two
// jobs on the same project never overwrite each other. The worktree starts from the project as it is now (HEAD plus
// uncommitted and untracked changes), detached, so no branch is created. The job's agents may edit only there (the
// hook blocks the original folder), checks run there, and when the job ends the user reviews the diff and applies it
// to the project (git apply, falling back to a 3-way merge with conflict markers) or discards it. Nothing is committed.
//
// defaults.isolateJobs: "shared" (default: only when another open job is on the same project), "always" or "off".
// t.workspace = { path, repo, sub, baseTree, status: 'active' | 'applied' | 'discarded' | 'conflicts', createdAt, files }

const { spawnSync } = require('child_process');

function install(ctx) {
  const { DATA, fs, home, now, path, readJson, thread, tickets, touchTicket } = ctx;
  const root = path.join(DATA, 'worktrees');
  const git = (cwd, args, input) => spawnSync('git', args, { cwd, input, encoding: 'utf8', maxBuffer: 256 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const ok = (r) => r.status === 0;
  const tilde = (p) => p.replace(require('os').homedir(), '~');

  function projectOf(t) {
    return t.project && readJson('projects.json').find((p) => p.name === t.project);
  }

  function repoOf(dir) {
    const r = git(dir, ['rev-parse', '--show-toplevel']);
    return ok(r) ? r.stdout.trim() : null;
  }

  function wanted(t) {
    const mode = readJson('roster.json').defaults.isolateJobs || 'shared';
    if (t.isolate === false || mode === 'off' && t.isolate !== true) return false;
    const p = projectOf(t);
    if (!p || p.keywordsFromSubfolders) return false;
    if (t.isolate === true || mode === 'always') return true;
    // "shared": only when another open job is on the same project.
    return [...tickets.values()].some((x) => x.id !== t.id && x.project === t.project && ['open', 'paused'].includes(x.status));
  }

  // The current state of a worktree as a tree object (staged in a throwaway index, so the worktree's index is untouched).
  function snapshotTree(w) {
    const idx = path.join(root, `.index-${process.pid}-${Date.now()}`);
    const env = { ...process.env, GIT_INDEX_FILE: idx };
    try {
      const add = spawnSync('git', ['add', '-A', '.'], { cwd: w, env, encoding: 'utf8' });
      if (add.status !== 0) return null;
      const r = spawnSync('git', ['write-tree'], { cwd: w, env, encoding: 'utf8' });
      return r.status === 0 ? r.stdout.trim() : null;
    } finally { try { fs.unlinkSync(idx); } catch {} }
  }

  function create(t) {
    if (t.workspace || !wanted(t)) return null;
    const p = projectOf(t);
    const dir = home(p.path);
    const repo = repoOf(dir);
    if (!repo) return null;
    const w = path.join(root, `job-${t.n}-${t.id}`);
    fs.mkdirSync(root, { recursive: true });
    if (!ok(git(repo, ['worktree', 'add', '--detach', '--quiet', w, 'HEAD']))) return null;
    // Bring over what isn't committed yet, so the job starts from the project as the user sees it.
    const diff = git(repo, ['diff', 'HEAD', '--binary']);
    if (diff.stdout) git(w, ['apply', '--binary', '--whitespace=nowarn'], diff.stdout);
    const untracked = git(repo, ['ls-files', '--others', '--exclude-standard', '-z']).stdout.split('\0').filter(Boolean).slice(0, 2000);
    for (const f of untracked) {
      try { const to = path.join(w, f); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(repo, f), to); } catch {}
    }
    const baseTree = snapshotTree(w);
    const sub = path.relative(repo, dir);
    t.workspace = { path: path.join(w, sub), worktree: w, repo, sub, baseTree, status: 'active', createdAt: now() };
    thread(t, { from: 'system', kind: 'system', text: `This job works in its own copy of ${p.name} (${tilde(t.workspace.path)}), because ${readJson('roster.json').defaults.isolateJobs === 'always' || t.isolate === true ? 'jobs are set to work isolated' : 'another job is working on the same project'}. You review and apply its changes when it ends; nothing is committed.` });
    touchTicket(t);
    return t.workspace;
  }

  function briefFor(t) {
    const W = t.workspace;
    if (!W || W.status !== 'active') return '';
    const p = projectOf(t);
    return `\n\nIsolated workspace: this job works in a separate git worktree of ${p ? p.name : 'the project'} at ${W.path} (another job may be changing the original). ` +
      `Read, edit, build and test ONLY there; edits in ${p ? p.path : 'the original folder'} are blocked. Don't commit, branch or push; the user reviews and applies your changes.`;
  }

  // The job's changes as a patch against where the worktree started.
  function patchOf(t) {
    const W = t.workspace;
    const now = snapshotTree(W.worktree);
    if (!now || !W.baseTree) return { error: 'Could not read the workspace.' };
    const stat = git(W.worktree, ['diff', '--stat', '--no-color', W.baseTree, now]).stdout;
    const names = git(W.worktree, ['diff', '--name-status', W.baseTree, now]).stdout.trim().split('\n').filter(Boolean);
    const patch = git(W.worktree, ['diff', '--binary', W.baseTree, now]).stdout;
    return { stat, names, patch, tree: now };
  }

  function review(t) {
    const W = t.workspace;
    if (!W) return { error: 'This job has no workspace.' };
    if (W.status !== 'active' && W.status !== 'conflicts') return { status: W.status, files: W.files || [] };
    if (!fs.existsSync(W.worktree)) return { error: 'The workspace folder is gone.' };
    const r = patchOf(t);
    if (r.error) return r;
    return { status: W.status, path: W.path, files: r.names.map((l) => { const [s, ...f] = l.split('\t'); return { status: s, path: f.join(' → ') }; }), stat: r.stat, diff: r.patch.slice(0, 400000) };
  }

  function removeWorktree(W) {
    git(W.repo, ['worktree', 'remove', '--force', W.worktree]);
    try { fs.rmSync(W.worktree, { recursive: true, force: true }); } catch {}
    git(W.repo, ['worktree', 'prune']);
  }

  function apply(t) {
    const W = t.workspace;
    if (!W || W.status !== 'active') return { error: 'Nothing to apply.' };
    if (['open', 'paused'].includes(t.status)) return { error: 'The job is still running; apply its changes when it has finished (or stop it first).' };
    const r = patchOf(t);
    if (r.error) return r;
    W.files = r.names;
    if (!r.patch.trim()) { W.status = 'applied'; removeWorktree(W); touchTicket(t); return { ok: true, files: 0 }; }
    // Plain apply to the working tree first; if the project moved on, a 3-way merge leaves conflict markers to resolve.
    let a = git(W.repo, ['apply', '--binary', '--whitespace=nowarn'], r.patch);
    let conflicts = false;
    if (!ok(a)) {
      a = git(W.repo, ['apply', '--3way', '--binary', '--whitespace=nowarn'], r.patch);
      if (!ok(a) && !/conflict/i.test(a.stderr)) return { error: `The changes no longer apply to ${tilde(W.repo)}: ${(a.stderr || '').trim().slice(0, 600)}` };
      conflicts = !ok(a) || /conflict/i.test(a.stderr);
    }
    W.status = conflicts ? 'conflicts' : 'applied';
    W.appliedAt = now();
    thread(t, { from: 'system', kind: 'system', text: conflicts
      ? `Applied ${r.names.length} file change${r.names.length === 1 ? '' : 's'} to ${tilde(W.repo)} with conflicts: the project changed meanwhile. Look for conflict markers (<<<<<<<) in: ${(a.stderr.match(/(?<=conflicts? in |with conflicts\.?\s*|U )\S+/g) || []).slice(0, 8).join(', ') || 'the files listed'}.`
      : `Applied ${r.names.length} file change${r.names.length === 1 ? '' : 's'} to ${tilde(W.repo)}. Nothing was committed.` });
    if (!conflicts) removeWorktree(W);
    touchTicket(t);
    return { ok: true, files: r.names.length, conflicts };
  }

  function discard(t) {
    const W = t.workspace;
    if (!W || !['active', 'conflicts'].includes(W.status)) return { error: 'Nothing to discard.' };
    if (['open', 'paused'].includes(t.status)) return { error: 'Stop the job before discarding its workspace.' };
    removeWorktree(W);
    W.status = W.status === 'conflicts' ? 'applied' : 'discarded';
    thread(t, { from: 'system', kind: 'system', text: W.status === 'discarded' ? 'Discarded the job\'s workspace; the project was not changed.' : 'Removed the job\'s workspace.' });
    touchTicket(t);
    return { ok: true };
  }

  // The original folder of a job that works isolated: edits there are refused (lib/edit-scope.js).
  function blockedRoot(t) {
    const W = t && t.workspace;
    return W && W.status === 'active' ? path.join(W.repo, W.sub) : null;
  }

  async function route(req, res, url, p, body, json) {
    const m = p.match(/^\/api\/tickets\/(\w+)\/workspace(?:\/(apply|discard))?$/);
    if (!m) return false;
    const t = tickets.get(m[1]);
    if (!t) return json(res, 404, { error: 'not found' }), true;
    if (req.method === 'GET' && !m[2]) return json(res, 200, review(t)), true;
    if (req.method === 'POST' && m[2]) { const r = m[2] === 'apply' ? apply(t) : discard(t); return json(res, r.error ? 400 : 200, r), true; }
    return false;
  }

  return { apply, blockedRoot, briefFor, create, discard, review, route, wanted };
}

module.exports = { install };
