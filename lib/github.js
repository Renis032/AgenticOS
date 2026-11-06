'use strict';
// GitHub connector, over GitHub's REST API with a token (no gh or other tool needed). Projects are linked to their
// repositories (found from `git remote`), and then:
// - issues with a chosen label (default "agentos") on a linked repository open as jobs, and any issue can be imported;
// - "when CI fails" routines are fired for new failed GitHub Actions runs (lib/arms.js);
// - from a finished job the user can post its answer as a comment on its issue, or open a draft pull request with its
//   changes. Both only ever happen on the user's click in the window: agents cannot publish. The pull request commit is
//   built in a throwaway index from HEAD plus the files the job changed, so the user's branch, index and working files
//   are never touched; the token reaches git through the environment, never in a URL or on a command line.
// Settings, links and the token live in data/github.json (git-ignored, mode 0600).
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawnSync } = require('child_process');

const POLL_MS = 120000;

function install(ctx) {
  const { DATA, arms, createTicket, findSecret, home, now, readJson, thread, tickets, touchTicket } = ctx;
  const FILE = path.join(DATA, 'github.json');
  const API = (process.env.AGENTOS_GITHUB_API || 'https://api.github.com').replace(/\/$/, '');
  let cfg = load();
  let lastError = null, polling = false;

  function load() { try { return { links: {}, seen: {}, ci: {}, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { return { links: {}, seen: {}, ci: {} }; } }
  function save() { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 }); try { fs.chmodSync(FILE, 0o600); } catch {} }

  // ---------------------------------------------------------------- the API
  function api(method, p, body, token = cfg.token) {
    return new Promise((resolve, reject) => {
      if (!token) return reject(new Error('GitHub is not connected.'));
      const u = new URL(API + p);
      const data = body ? Buffer.from(JSON.stringify(body)) : null;
      const req = (u.protocol === 'http:' ? http : https).request(u, { method, timeout: 20000, headers: {
        authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'agentic-os',
        ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) } }, (res) => {
        let s = '';
        res.on('data', (c) => (s += c));
        res.on('end', () => {
          let j = null; try { j = s ? JSON.parse(s) : null; } catch {}
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(j);
          const e = new Error(res.statusCode === 401 ? 'GitHub refused the token (it may be expired or revoked).' : res.statusCode === 403 || res.statusCode === 404 ? `GitHub said ${res.statusCode}: the token may not have access to this repository, or lacks a permission. ${(j && j.message) || ''}`.trim() : `GitHub answered ${res.statusCode}: ${(j && j.message) || s.slice(0, 200)}`);
          e.code = res.statusCode;
          reject(e);
        });
      });
      req.on('timeout', () => req.destroy(new Error('GitHub did not answer in time.')));
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  // ---------------------------------------------------------------- projects and their repositories
  const git = (cwd, args, opts = {}) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20, ...opts, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(opts.env || {}) } });
  const projects = () => readJson('projects.json').filter((p) => !p.keywordsFromSubfolders);
  function repoDirOf(p) { const r = git(home(p.path), ['rev-parse', '--show-toplevel']); return r.status === 0 ? r.stdout.trim() : null; }
  // owner/repo from a remote URL: git@github.com:o/r.git, https://github.com/o/r, ssh://git@github.com/o/r.git
  function slugOf(url) {
    const m = /github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(url || '').trim());
    return m ? `${m[1]}/${m[2]}` : null;
  }
  function detected(p) {
    const dir = repoDirOf(p);
    if (!dir) return null;
    return slugOf(git(dir, ['remote', 'get-url', 'origin']).stdout);
  }
  const linkOf = (name) => cfg.links[name] || null;
  const projectOfRepo = (repo) => Object.entries(cfg.links).find(([, l]) => l.repo.toLowerCase() === String(repo).toLowerCase());

  function view() {
    return { configured: !!cfg.token, login: cfg.login || null, name: cfg.name || null, lastError, ghToken: !cfg.token && !!ghToken(),
      projects: projects().map((p) => {
        const l = linkOf(p.name);
        return { name: p.name, detected: detected(p), git: !!repoDirOf(p), repo: l ? l.repo : null, error: l && l.error || null, issues: l ? l.issues !== false : false, label: l ? l.label || 'agentos' : 'agentos', ci: l ? l.ci !== false : false };
      }) };
  }

  // A token the user's gh already holds, offered so they need not paste one.
  function ghToken() {
    const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 5000 });
    return r.status === 0 ? r.stdout.trim() : null;
  }

  async function connect(token) {
    token = String(token || '').trim();
    if (token === 'gh') token = ghToken() || '';
    if (!/^(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{40,})$/.test(token)) return { error: 'That does not look like a GitHub token (it starts with github_pat_ or ghp_). Create a fine-grained one at github.com → Settings → Developer settings.' };
    let me;
    try { me = await api('GET', '/user', null, token); } catch (e) { return { error: e.message }; }
    cfg = { ...cfg, token, login: me.login, name: me.name || null, connectedAt: now() };
    lastError = null;
    // Link every project whose origin is on GitHub.
    for (const p of projects()) { const d = detected(p); if (d && !cfg.links[p.name]) cfg.links[p.name] = { repo: d, issues: true, label: 'agentos', ci: true, since: now() }; }
    save();
    poll().catch(() => {});
    return view();
  }

  function setLink(b) {
    const p = projects().find((x) => x.name === b.project);
    if (!p) return { error: 'No such project.' };
    if (b.repo === null || b.repo === '') { delete cfg.links[p.name]; save(); return view(); }
    const repo = String(b.repo || (cfg.links[p.name] || {}).repo || detected(p) || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { error: 'Give the repository as owner/name.' };
    const was = cfg.links[p.name] || { since: now() };
    const label = String(b.label ?? was.label ?? 'agentos').trim().slice(0, 50) || 'agentos';
    cfg.links[p.name] = { ...was, repo, label, issues: b.issues ?? was.issues ?? true, ci: b.ci ?? was.ci ?? true };
    if (was.repo !== repo || was.label !== label) { delete cfg.seen[p.name]; delete cfg.ci[p.name]; }
    save();
    return view();
  }

  // ---------------------------------------------------------------- issues in, CI failures as triggers
  function jobFromIssue(projectName, repo, issue) {
    const body = String(issue.body || '').slice(0, 8000);
    const t = createTicket({ text: `GitHub issue ${repo}#${issue.number}: ${issue.title}\n\n${body || '(no description)'}\n\n${issue.html_url}`, project: projectName });
    t.title = `#${issue.number} ${String(issue.title).slice(0, 100)}`;
    t.github = { repo, issue: issue.number, url: issue.html_url };
    touchTicket(t);
    return t;
  }

  async function importIssue(projectName, number) {
    const l = linkOf(projectName);
    if (!l) return { error: 'Link this project to a repository first.' };
    const existing = [...tickets.values()].find((t) => t.github && t.github.repo === l.repo && t.github.issue === Number(number) && !['done', 'failed', 'stopped'].includes(t.status));
    if (existing) return { id: existing.id, existing: true };
    let issue;
    try { issue = await api('GET', `/repos/${l.repo}/issues/${Number(number)}`); } catch (e) { return { error: e.message }; }
    if (issue.pull_request) return { error: `#${number} is a pull request, not an issue.` };
    const t = jobFromIssue(projectName, l.repo, issue);
    (cfg.seen[projectName] = cfg.seen[projectName] || []).push(issue.number);
    save();
    return { id: t.id };
  }

  async function poll() {
    if (!cfg.token || polling) return;
    polling = true;
    try {
      const problems = [];
      for (const [name, l] of Object.entries(cfg.links)) {
       // One repository the token cannot reach must not stop the others.
       try {
        if (l.issues !== false) {
          const list = await api('GET', `/repos/${l.repo}/issues?state=open&labels=${encodeURIComponent(l.label || 'agentos')}&sort=created&direction=desc&per_page=30`);
          const first = !cfg.seen[name];
          const seen = new Set(cfg.seen[name] || []);
          // The first look only notes what is already labelled; later ones open a job for each new issue (5 at most).
          let opened = 0;
          for (const i of (list || []).filter((x) => !x.pull_request).reverse()) {
            if (seen.has(i.number)) continue;
            seen.add(i.number);
            if (!first && opened < 5) { jobFromIssue(name, l.repo, i); opened++; }
          }
          cfg.seen[name] = [...seen].slice(-500);
        }
        if (l.ci !== false) {
          const runs = await api('GET', `/repos/${l.repo}/actions/runs?status=failure&per_page=10`).catch((e) => (e.code === 404 ? { workflow_runs: [] } : Promise.reject(e)));
          const first = !cfg.ci[name];
          const seen = new Set(cfg.ci[name] || []);
          for (const r of ((runs && runs.workflow_runs) || []).reverse()) {
            if (seen.has(r.id)) continue;
            seen.add(r.id);
            if (!first && arms) arms.fire('ci-failed', { project: name, why: `GitHub Actions failed on ${l.repo}: "${r.name}" on branch ${r.head_branch} (${String(r.head_commit && r.head_commit.message || '').split('\n')[0].slice(0, 120)}). ${r.html_url}` });
          }
          cfg.ci[name] = [...seen].slice(-200);
        }
        delete l.error;
       } catch (e) { l.error = e.message; problems.push(`${l.repo}: ${e.message}`); }
      }
      lastError = problems.length ? problems.join(' · ') : null;
    } catch (e) { lastError = e.message; }
    finally { save(); polling = false; }
  }

  // ---------------------------------------------------------------- back to GitHub, on the user's click
  const footer = (t) => `\n\n---\n_From Agentic OS, job #${t.n}._`;

  async function comment(t) {
    if (!t.github || !t.github.issue) return { error: 'This job did not come from a GitHub issue.' };
    if (!t.answer) return { error: 'The job has no answer yet.' };
    const secret = findSecret(t.answer);
    if (secret) return { error: `Not posted: the answer looks like it contains ${secret}. Edit it out first.` };
    let c;
    try { c = await api('POST', `/repos/${t.github.repo}/issues/${t.github.issue}/comments`, { body: String(t.answer).slice(0, 60000) + footer(t) }); } catch (e) { return { error: e.message }; }
    t.github.commentUrl = c.html_url;
    t.github.commentedAt = now();
    thread(t, { from: 'system', kind: 'system', text: `Posted the answer on ${t.github.repo}#${t.github.issue}: ${c.html_url}` });
    touchTicket(t);
    return { ok: true, url: c.html_url };
  }

  // The files the job changed, relative to the repository, with where their content is now.
  function filesOf(t, repoDir) {
    const W = t.workspace && ['active', 'conflicts'].includes(t.workspace.status) ? t.workspace : null;
    const base = W ? W.worktree : repoDir;
    const out = [];
    for (const c of t.changes || []) {
      if (c.revertedAt) continue;
      const rel = path.relative(base, c.path);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      out.push({ rel, abs: c.path });
    }
    return out;
  }

  function prPlan(t) {
    const l = t.project && linkOf(t.project);
    if (!l) return { error: 'Link this job\'s project to a GitHub repository first (Preferences → Connectors).' };
    const p = projects().find((x) => x.name === t.project);
    const repoDir = p && repoDirOf(p);
    if (!repoDir) return { error: 'The project is not a git repository.' };
    const files = filesOf(t, repoDir);
    if (!files.length) return { error: 'This job did not change any files in the repository.' };
    return { l, repoDir, files };
  }

  async function openPr(t, b = {}) {
    if (['open', 'paused'].includes(t.status)) return { error: 'Let the job finish (or stop it) before opening a pull request.' };
    if (t.github && t.github.prUrl) return { ok: true, url: t.github.prUrl, existing: true };
    const plan = prPlan(t);
    if (plan.error) return plan;
    const { l, repoDir, files } = plan;
    for (const f of files) {
      let text = '';
      try { text = fs.readFileSync(f.abs, 'utf8'); } catch {}
      const s = findSecret(text);
      if (s) return { error: `Not opened: ${f.rel} looks like it contains ${s}.` };
    }
    let info;
    try { info = await api('GET', `/repos/${l.repo}`); } catch (e) { return { error: e.message }; }
    const baseBranch = info.default_branch || 'main';
    // A commit of HEAD plus the job's files, built in a throwaway index.
    const idx = path.join(DATA, `.gh-index-${process.pid}-${Date.now()}`);
    const env = { GIT_INDEX_FILE: idx };
    const branch = `agentos/job-${t.n}`;
    let sha;
    try {
      const head = git(repoDir, ['rev-parse', 'HEAD']).stdout.trim();
      if (!head) return { error: 'The repository has no commits yet.' };
      if (git(repoDir, ['read-tree', 'HEAD'], { env }).status !== 0) return { error: 'Could not read the repository.' };
      for (const f of files) {
        if (fs.existsSync(f.abs)) {
          const h = git(repoDir, ['hash-object', '-w', f.abs]).stdout.trim();
          let mode = '100644'; try { if (fs.statSync(f.abs).mode & 0o111) mode = '100755'; } catch {}
          git(repoDir, ['update-index', '--add', '--cacheinfo', `${mode},${h},${f.rel}`], { env });
        } else git(repoDir, ['update-index', '--force-remove', f.rel], { env });
      }
      const tree = git(repoDir, ['write-tree'], { env }).stdout.trim();
      if (tree === git(repoDir, ['rev-parse', 'HEAD^{tree}']).stdout.trim()) return { error: 'The job\'s files are the same as in HEAD: nothing to propose.' };
      const title = String(b.title || t.title || `Job #${t.n}`).slice(0, 200);
      const c = git(repoDir, ['commit-tree', tree, '-p', head, '-m', `${title}\n\nFrom Agentic OS, job #${t.n}.`]);
      sha = c.stdout.trim();
      if (c.status !== 0 || !sha) return { error: `Could not make the commit: ${c.stderr.trim().slice(0, 300)}` };
    } finally { try { fs.unlinkSync(idx); } catch {} }
    // Push the commit to a new branch on origin; over HTTPS the token goes in an environment-only header.
    const auth = Buffer.from(`x-access-token:${cfg.token}`).toString('base64');
    // To origin when it is the linked repository (or not on GitHub at all); otherwise straight to the linked repository.
    const originSlug = slugOf(git(repoDir, ['remote', 'get-url', 'origin']).stdout);
    const target = !originSlug || originSlug.toLowerCase() === l.repo.toLowerCase() ? 'origin' : `https://github.com/${l.repo}.git`;
    const push = git(repoDir, ['push', target, `${sha}:refs/heads/${branch}`], { env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${auth}` }, timeout: 120000 });
    if (push.status !== 0) return { error: `Could not push the branch ${branch}: ${(push.stderr || '').replace(/x-access-token:[^@\s]+/g, '***').trim().slice(0, 400)}` };
    const issueLine = t.github && t.github.issue ? `\n\nCloses #${t.github.issue}.` : '';
    let pr;
    try {
      pr = await api('POST', `/repos/${l.repo}/pulls`, { title: String(b.title || t.title || `Job #${t.n}`).slice(0, 200), head: branch, base: baseBranch, draft: true,
        body: `${String(t.answer || '').slice(0, 20000)}${issueLine}\n\nFiles: ${files.map((f) => `\`${f.rel}\``).join(', ')}${footer(t)}` });
    } catch (e) { return { error: `The branch ${branch} is pushed, but the pull request was not opened: ${e.message}` }; }
    t.github = { ...(t.github || {}), repo: l.repo, prUrl: pr.html_url, pr: pr.number, branch, prAt: now() };
    thread(t, { from: 'system', kind: 'system', text: `Opened a draft pull request on ${l.repo}: ${pr.html_url} (branch ${branch}, ${files.length} file${files.length === 1 ? '' : 's'}).` });
    touchTicket(t);
    return { ok: true, url: pr.html_url, branch, files: files.map((f) => f.rel) };
  }

  // What the window needs to offer the buttons on a job.
  function jobView(t) {
    const l = t.project && linkOf(t.project);
    const plan = l && !['open', 'paused'].includes(t.status) ? prPlan(t) : null;
    return { linked: !!l, repo: l ? l.repo : null, issue: t.github && t.github.issue ? t.github : null, prUrl: t.github && t.github.prUrl || null, commentUrl: t.github && t.github.commentUrl || null,
      canComment: !!(cfg.token && t.github && t.github.issue && t.answer && !t.github.commentUrl), canPr: !!(cfg.token && plan && !plan.error && !(t.github && t.github.prUrl)),
      prFiles: plan && plan.files ? plan.files.map((f) => f.rel) : [], prWhyNot: plan && plan.error ? plan.error : null };
  }

  // ---------------------------------------------------------------- HTTP
  async function route(req, res, url, p, body, json) {
    if (!p.startsWith('/api/github')) return false;
    if (p === '/api/github' && req.method === 'GET') return json(res, 200, view()), true;
    if (p === '/api/github' && req.method === 'POST') { const r = await connect((await body(req)).token); return json(res, r.error ? 400 : 200, r), true; }
    if (p === '/api/github' && req.method === 'DELETE') { cfg = { links: {}, seen: {}, ci: {} }; lastError = null; save(); return json(res, 200, view()), true; }
    if (p === '/api/github/link' && req.method === 'POST') { const r = setLink(await body(req)); return json(res, r.error ? 400 : 200, r), true; }
    if (p === '/api/github/poll' && req.method === 'POST') { await poll(); return json(res, lastError ? 400 : 200, lastError ? { error: lastError } : view()), true; }
    if (p === '/api/github/import' && req.method === 'POST') { const b = await body(req); const r = await importIssue(b.project, b.number); return json(res, r.error ? 400 : 200, r), true; }
    const m = p.match(/^\/api\/github\/job\/([\w-]+)(?:\/(comment|pr))?$/);
    if (m) {
      const t = tickets.get(m[1]);
      if (!t) return json(res, 404, { error: 'No such job.' }), true;
      if (!m[2] && req.method === 'GET') return json(res, 200, jobView(t)), true;
      if (m[2] === 'comment' && req.method === 'POST') { const r = await comment(t); return json(res, r.error ? 400 : 200, r), true; }
      if (m[2] === 'pr' && req.method === 'POST') { const r = await openPr(t, await body(req)); return json(res, r.error ? 400 : 200, r), true; }
    }
    return false;
  }

  setInterval(() => { poll().catch(() => {}); }, Number(process.env.AGENTOS_GITHUB_POLL_MS) || POLL_MS).unref();
  return { route, poll, view, slugOf, projectOfRepo };
}

module.exports = { install };
