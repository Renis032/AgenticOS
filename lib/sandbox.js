'use strict';
// Sandboxed jobs: a project with `"sandbox": true` in projects.json (Teams & roles → Projects) has its jobs worked on
// inside Docker. The job gets its own desk (a twin of its lead, lib/residents.js) and every agent on the job runs in a
// container that sees only: the project folder (or the job's worktree) at its real path, the team's library, and
// read-only the office's agent tools, the job's attachments, and the user's Claude skills and instructions. The rest of
// the home folder (other projects, ~/.ssh, ~/.config, …) is not there. Terminal commands and project checks for the job
// run in a throwaway container with the same folders. Each desk has its own HOME (data/sandbox/<agent>) holding its
// Claude sessions; the Claude Code login is copied into it at start, an API key is passed by name. The image is
// agentos-sandbox:<Claude Code version>, built from sandbox/Dockerfile on first use.
// Known limit: the office's agent tools read the office's token, so a sandboxed agent can too (as any agent can today).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

function install(ctx) {
  const { CLAUDE_BIN, DATA, PORT, ROOT, UPLOADS, broadcast, home, readJson, tickets } = ctx;
  const DOCKER = process.env.AGENTOS_DOCKER || 'docker';
  const MAC = process.platform === 'darwin';
  const HOMES = path.join(DATA, 'sandbox');
  const UID = typeof process.getuid === 'function' ? `${process.getuid()}:${process.getgid()}` : null;
  let building = null, buildLog = '', lastBuildError = null, versionCache = null, startedAny = false;

  // ---------------------------------------------------------------- which jobs
  const projectOf = (t) => t && t.project && readJson('projects.json').find((p) => p.name === t.project);
  function projectFor(t) { const p = projectOf(t); return p && p.sandbox ? p : null; }
  // The job an agent works for: a sandboxed desk's own job, or a specialist's current task.
  function jobOf(a) { const t = tickets.get((a.sandbox && a.sandbox.ticketId) || a.ticketId); return projectFor(t) ? t : null; }

  function repoRoot(dir) { const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; }
  // Where the job's agents work inside the container (the same path as on the computer).
  function workdirOf(t) {
    if (t.workspace && ['active', 'conflicts'].includes(t.workspace.status)) return t.workspace.path;
    return home(projectFor(t).path);
  }

  // ---------------------------------------------------------------- the image
  // Everything that asks Docker or Claude Code runs asynchronously: Docker can take seconds to answer (snap's wakes up
  // slowly), and a synchronous call would hold up the whole office meanwhile.
  function run(bin, args, timeout = 20000) {
    return new Promise((resolve) => {
      let out = '', done = false;
      let c;
      try { c = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return resolve({ status: -1, stdout: '' }); }
      const finish = (status) => { if (done) return; done = true; clearTimeout(timer); resolve({ status, stdout: out }); };
      const timer = setTimeout(() => { try { c.kill('SIGKILL'); } catch {} finish(-1); }, timeout);
      c.stdout.on('data', (d) => (out += d));
      c.on('close', finish);
      c.on('error', () => finish(-1));
    });
  }
  async function claudeVersion() {
    if (versionCache) return versionCache;
    const r = await run(CLAUDE_BIN, ['--version']);
    versionCache = ((r.stdout || '').match(/\d+\.\d+\.\d+/) || [])[0] || 'latest';
    return versionCache;
  }
  // The image name, once the Claude Code version is known (looked up at start, in the background).
  const image = () => process.env.AGENTOS_SANDBOX_IMAGE || `agentos-sandbox:${versionCache || 'latest'}`;
  // Docker's state is cached for half a minute.
  let dockerSeen = { at: 0, v: null };
  async function dockerOk() {
    if (Date.now() - dockerSeen.at < 30000) return dockerSeen.v;
    const r = await run(DOCKER, ['info', '--format', '{{.ServerVersion}}']);
    dockerSeen = { at: Date.now(), v: r.status === 0 ? r.stdout.trim() : null };
    return dockerSeen.v;
  }
  async function imageReady() { await claudeVersion(); return (await run(DOCKER, ['image', 'inspect', image()])).status === 0; }
  async function status() {
    const server = await dockerOk();
    return { docker: !!server, server, image: (await claudeVersion(), image()), ready: server ? await imageReady() : false, building: !!building, lastError: lastBuildError, log: buildLog.slice(-4000),
      projects: readJson('projects.json').filter((p) => p.sandbox).map((p) => p.name) };
  }
  // Builds the image (a few minutes the first time; it downloads Node and Claude Code).
  async function build() {
    if (building) return building;
    if (!(await dockerOk())) return { error: 'Docker is not running, or this user may not use it (add yourself to the docker group).' };
    await claudeVersion();
    if (building) return building;
    buildLog = ''; lastBuildError = null;
    building = new Promise((resolve) => {
      const c = spawn(DOCKER, ['build', '-t', image(), '--build-arg', `CLAUDE_VERSION=${versionCache}`, path.join(ROOT, 'sandbox')], { stdio: ['ignore', 'pipe', 'pipe'] });
      const add = (d) => { buildLog = (buildLog + d).slice(-20000); };
      c.stdout.on('data', add); c.stderr.on('data', add);
      c.on('close', (code) => {
        building = null;
        if (code !== 0) lastBuildError = `docker build failed (exit ${code}).`;
        broadcast({ type: 'sandbox' });
        resolve(code === 0 ? { ok: true, image: image() } : { error: lastBuildError, log: buildLog.slice(-3000) });
      });
      c.on('error', (e) => { building = null; lastBuildError = e.message; resolve({ error: e.message }); });
    });
    broadcast({ type: 'sandbox' });
    return building;
  }

  // ---------------------------------------------------------------- the folders a job's container sees
  function mounts(t, args, a) {
    const m = new Map(); // host path -> 'rw' | 'ro'
    const add = (p, mode) => { if (!p || !fs.existsSync(p)) return; if (m.get(p) === 'rw') return; m.set(p, mode); };
    const proj = home(projectFor(t).path);
    add(repoRoot(proj) || proj, 'rw');
    if (t.workspace && ['active', 'conflicts'].includes(t.workspace.status)) { add(t.workspace.worktree, 'rw'); if (t.workspace.repo) add(t.workspace.repo, 'rw'); }
    // The agent's extra folders: its team library (it writes there), references and attachments (read only).
    const i = (args || []).indexOf('--add-dir');
    if (i >= 0) for (let k = i + 1; k < args.length && !String(args[k]).startsWith('--'); k++) add(args[k], String(args[k]).startsWith(path.join(ROOT, 'teams') + path.sep) && a && a.resident ? 'rw' : 'ro');
    add(UPLOADS, 'ro');
    add(path.join(ROOT, 'lib'), 'ro');
    add(path.join(DATA, 'app-token'), 'ro');
    return m;
  }

  // The desk's own HOME: its Claude sessions, a copy of the login, and the user's skills and instructions (read only).
  function deskHome(a) {
    const dir = path.join(HOMES, String(a.id).replace(/[^\w~.-]/g, '_'));
    const cdir = path.join(dir, '.claude');
    fs.mkdirSync(cdir, { recursive: true, mode: 0o700 });
    const real = process.env.AGENTOS_CLAUDE_CREDENTIALS || path.join(os.homedir(), '.claude', '.credentials.json');
    try { if (fs.existsSync(real)) fs.copyFileSync(real, path.join(cdir, '.credentials.json')); fs.chmodSync(path.join(cdir, '.credentials.json'), 0o600); } catch {}
    const cfg = path.join(dir, '.claude.json');
    if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, JSON.stringify({ hasCompletedOnboarding: true, bypassPermissionsModeAccepted: false }), { mode: 0o600 });
    return dir;
  }

  const nameOf = (a) => `agentos-${PORT}-${String(a.id).replace(/[^\w.-]/g, '-')}`.slice(0, 120);
  const net = () => (MAC || process.platform === 'win32' ? [] : ['--network', 'host']);
  const envNames = (env, extra) => [...new Set([...Object.keys(env).filter((k) => /^(WORKPLACE_|ANTHROPIC_|CLAUDE_CODE_|MCP_|ENABLE_TOOL_SEARCH|DISABLE_)/.test(k)), ...(extra || [])])];

  // The office's own helpers run on the container's node, not the computer's (or Electron's) binary.
  function containerArgs(args) {
    const out = [...args];
    const mi = out.indexOf('--mcp-config');
    if (mi >= 0) {
      try {
        const j = JSON.parse(out[mi + 1]);
        for (const s of Object.values(j.mcpServers || {})) { s.command = 'node'; if (s.env) { delete s.env.ELECTRON_RUN_AS_NODE; if (MAC) s.env.WORKPLACE_HOST = 'host.docker.internal'; } }
        out[mi + 1] = JSON.stringify(j);
      } catch {}
    }
    const si = out.indexOf('--settings');
    if (si >= 0) {
      try {
        const j = JSON.parse(out[si + 1]);
        const cmd = `${MAC ? 'WORKPLACE_HOST=host.docker.internal ' : ''}node '${path.join(ROOT, 'lib', 'mail-hook.js').replace(/'/g, `'\\''`)}'`;
        for (const list of Object.values(j.hooks || {})) for (const h of list) for (const x of h.hooks || []) x.command = cmd;
        out[si + 1] = JSON.stringify(j);
      } catch {}
    }
    return out;
  }

  // How to start an agent: on the computer, or for a sandboxed job inside its container. Returns { bin, args, cwd, env, name }.
  function claude(a, args, env) {
    const t = jobOf(a);
    if (!t) return { bin: CLAUDE_BIN, args, cwd: a.cwd, env };
    const cwd = workdirOf(t);
    a.cwd = cwd;
    const h = deskHome(a);
    const vols = [...mounts(t, args, a)].flatMap(([p, mode]) => ['-v', `${p}:${p}:${mode}`]);
    const name = `${nameOf(a)}-${Date.now().toString(36)}`;
    startedAny = true;
    // The values reach the container by name from the docker client's environment, never on its command line.
    const e = { ...env };
    delete e.ELECTRON_RUN_AS_NODE;
    const dargs = ['run', '--rm', '-i', '--init', '--name', name, ...(UID ? ['--user', UID] : []), ...net(),
      '-e', 'HOME=/home/agent', ...envNames(e).flatMap((k) => ['-e', k]), '-v', `${h}:/home/agent:rw`, ...vols, '-w', cwd,
      '--label', `agentos.port=${PORT}`, '--label', `agentos.ticket=${t.id}`, image(), 'claude', ...containerArgs(args)];
    return { bin: DOCKER, args: dargs, cwd: h, env: e, name, sandboxed: true };
  }

  // A terminal command or a check for a sandboxed job: a throwaway container with the job's folders. Or null.
  function command(t, cmd, cwd, env) {
    if (!projectFor(t)) return null;
    startedAny = true;
    const e = { ...env };
    delete e.ELECTRON_RUN_AS_NODE;
    const h = path.join(HOMES, `cmd-${t.id}`);
    fs.mkdirSync(h, { recursive: true, mode: 0o700 });
    const vols = [...mounts(t, [], null)].filter(([p]) => !p.endsWith('app-token')).flatMap(([p, mode]) => ['-v', `${p}:${p}:${mode}`]);
    const names = ['TERM', 'NO_COLOR', 'CI', 'GIT_TERMINAL_PROMPT', 'DEBIAN_FRONTEND'].filter((k) => e[k] !== undefined);
    return { bin: DOCKER, args: ['run', '--rm', '-i', '--init', ...(UID ? ['--user', UID] : []), ...net(), '-e', 'HOME=/home/agent', ...names.flatMap((k) => ['-e', k]), '-v', `${h}:/home/agent:rw`, ...vols,
      '-w', cwd || workdirOf(t), '--label', `agentos.port=${PORT}`, '--label', `agentos.ticket=${t.id}`, image(), 'bash', '-lc', cmd], env: e, sandboxed: true };
  }

  // Containers outlive a killed `docker run` client, so the office removes them itself when the client ends.
  function watch(child, s) {
    if (!s || !s.name) return;
    child.on('exit', () => { spawn(DOCKER, ['rm', '-f', s.name], { stdio: 'ignore', detached: true }).unref(); });
  }
  // At start and shutdown: containers of this office left from before.
  function cleanup() {
    const r = spawnSync(DOCKER, ['ps', '-aq', '--filter', `label=agentos.port=${PORT}`], { encoding: 'utf8', timeout: 15000 });
    const ids = (r.stdout || '').trim().split('\n').filter(Boolean);
    if (ids.length) spawnSync(DOCKER, ['rm', '-f', ...ids], { stdio: 'ignore', timeout: 30000 });
    return ids.length;
  }

  // Ready to start a sandboxed agent? Explains what is missing, for the job's thread.
  // Docker from snap can only mount visible folders in the home directory (not /tmp, not ~/.config and the like).
  let snapCache = null;
  async function snapDocker() {
    if (snapCache !== null) return snapCache;
    const w = (await run('sh', ['-c', `command -v ${DOCKER}`])).stdout.trim();
    try { snapCache = fs.realpathSync(w).startsWith('/snap/') || w.startsWith('/snap/'); } catch { snapCache = w.startsWith('/snap/'); }
    return snapCache;
  }
  function hiddenFor(p) { const rel = path.relative(os.homedir(), p); return rel.startsWith('..') || path.isAbsolute(rel) ? !p.startsWith(os.homedir()) : rel.split(path.sep).some((x) => x.startsWith('.')); }
  async function readiness(t) {
    if (t && projectFor(t) && await snapDocker()) {
      const bad = [ROOT, home(projectFor(t).path)].filter(hiddenFor);
      if (bad.length) return `Docker here comes from snap, which can only see visible folders in your home directory, and ${bad.join(' and ')} ${bad.length > 1 ? 'are' : 'is'} not one. Move ${bad.length > 1 ? 'them' : 'it'} to a visible folder, or install Docker from docker.com.`;
    }
    if (!(await dockerOk())) return 'Docker is not running, or this user may not use it. Start Docker (and add yourself to the docker group), then resume the job.';
    if (!(await imageReady())) return building ? 'The sandbox image is still being built (Preferences → Agents & teams → Sandbox).' : `The sandbox image ${image()} is not built yet. Build it in Preferences → Agents & teams → Sandbox, then resume the job.`;
    return null;
  }

  async function route(req, res, url, p, body, json) {
    if (p === '/api/sandbox' && req.method === 'GET') return json(res, 200, await status()), true;
    if (p === '/api/sandbox/build' && req.method === 'POST') { const r = await build(); return json(res, r.error ? 400 : 200, r.error ? r : await status()), true; }
    return false;
  }

  claudeVersion().catch(() => {});
  // Containers this office left behind (after a crash): removed in the background, so a slow Docker never delays the start.
  if (process.env.AGENTOS_SANDBOX_NO_CLEANUP !== '1') {
    setTimeout(() => {
      const c = spawn(DOCKER, ['ps', '-aq', '--filter', `label=agentos.port=${PORT}`], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      c.stdout.on('data', (d) => (out += d));
      c.on('close', () => { const ids = out.trim().split('\n').filter(Boolean); if (ids.length) spawn(DOCKER, ['rm', '-f', ...ids], { stdio: 'ignore' }); });
      c.on('error', () => {});
    }, 3000).unref();
  }
  return { build, claude, cleanup, started: () => startedAny, command, containerArgs, jobOf, mounts, projectFor, readiness, route, status, watch, workdirOf };
}

module.exports = { install };
