#!/usr/bin/env node
'use strict';
// Checks that agents still follow their instructions, with real agents on a cheap model in a throwaway copy of the office:
// small jobs that each test one behaviour (reading in parts, using scripts, refusing to commit, proposing a plan before a big
// team, saving a project handoff when the user wraps up). Costs a few cents on Haiku. Run it after changing agent instructions.
const { parseArgs, fs, path } = require('./_util');
const { spawn, spawnSync } = require('child_process');
const os = require('os');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

function call(port, token, method, p, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'x-agentos-token': token, 'content-type': 'application/json', host: `127.0.0.1:${port}` } }, (res) => {
      let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
    if (data) req.write(data);
    req.end();
  });
}

async function evaluate(opt) {
  const model = opt.model || 'haiku';
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-eval-'));
  const office = path.join(work, 'office');
  spawnSync('rsync', ['-a', '--exclude', '.git', '--exclude', 'data', `${ROOT}/`, `${office}/`]);
  // Every agent on the cheap model at low effort; commands off so nothing waits for approval; a low plan threshold.
  const roster = JSON.parse(fs.readFileSync(path.join(office, 'roster.json'), 'utf8'));
  Object.assign(roster.defaults, { residentModel: model, residentEffort: 'low', model, effort: 'low', terminalCommands: 'off', planApproval: true, planOverUsd: 0.5, autoApprovePlansUsd: 0, leadFreshPerTicket: true });
  for (const r of Object.values(roster.roles)) { if (r.model) r.model = model; if (r.effort) r.effort = 'low'; }
  fs.writeFileSync(path.join(office, 'roster.json'), JSON.stringify(roster, null, 2));
  const repo = path.join(work, 'evalrepo');
  fs.mkdirSync(repo);
  const git = (...a) => spawnSync('git', ['-C', repo, '-c', 'user.name=eval', '-c', 'user.email=eval@local', ...a], { encoding: 'utf8' });
  git('init', '-q'); fs.writeFileSync(path.join(repo, 'notes.txt'), 'one\n'); git('add', '.'); git('commit', '-qm', 'start');
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'one\ntwo\n');
  const head0 = git('rev-parse', 'HEAD').stdout.trim();
  const scratch = path.join(os.homedir(), 'agent_eval_test');
  // Started by the office (lib/evals.js): if the office goes away, stop too and clean up.
  if (process.env.AGENTOS_TEST_PARENT) setInterval(() => {
    try { process.kill(Number(process.env.AGENTOS_TEST_PARENT), 0); } catch { try { fs.rmSync(work, { recursive: true, force: true }); fs.rmSync(scratch, { recursive: true, force: true }); } catch {} process.exit(3); }
  }, 3000).unref();

  const port = await freePort();
  const server = spawn(process.execPath, ['server.js'], { cwd: office, env: { ...process.env, AGENTOS_TEST_PARENT: String(process.pid), WORKPLACE_PORT: String(port) }, stdio: 'ignore', detached: true });
  const results = [];
  const ok = (name, pass, detail) => results.push({ name, pass: !!pass, detail: pass ? '' : String(detail || '').slice(0, 300) });
  try {
    let token = '';
    for (let i = 0; i < 60 && !token; i++) { await sleep(500); try { token = fs.readFileSync(path.join(office, 'data', 'app-token'), 'utf8').trim(); } catch {} if (token && !(await call(port, token, 'GET', '/api/limits'))) token = ''; }
    if (!token) { ok('the eval office starts', false, 'no answer'); return { results, cost: 0 }; }
    const A = (m, p, b) => call(port, token, m, p, b);
    const st = await A('GET', '/api/state');
    const personal = st.projects.find((p) => p.keywordsFromSubfolders);
    await sleep(8000);

    // Runs one job and returns it with every tool call any agent made while it ran.
    async function job(text, opts = {}) {
      const start = Date.now();
      const r = await A('POST', '/api/tasks', { text, project: personal.name, effort: 'low' });
      let t = null;
      for (let i = 0; i < (opts.timeoutSec || 240) / 3; i++) {
        await sleep(3000);
        const s = await A('GET', '/api/state');
        t = s && s.tickets.find((x) => x.id === r.id);
        if (!t) continue;
        if (opts.until && opts.until(t)) break;
        if (['done', 'failed', 'stopped', 'interrupted'].includes(t.status)) break;
      }
      const s = await A('GET', '/api/state');
      const tools = [];
      for (const a of s.agents) {
        const evs = (await A('GET', `/api/agents/${a.id}/events?limit=400`)) || [];
        for (const e of evs) if (e.t >= start && e.kind === 'tool_use') tools.push({ agent: a.id, name: e.name, input: e.input || {} });
      }
      return { t, tools };
    }
    const scriptsUsed = (tools, names) => tools.filter((x) => /script$/.test(x.name) && names.includes(x.input.name));

    const bigFile = path.join(office, 'server.js');
    const j1 = await job(`In ${bigFile}, what does the function contextNudge do? Answer in two sentences. Do not change anything.`);
    const partial = scriptsUsed(j1.tools, ['show', 'outline', 'search', 'find-def', 'call-sites']).length || j1.tools.some((x) => x.name === 'Read' && x.input.file_path === bigFile && (x.input.offset || x.input.limit));
    ok('reads a large file in parts (outline/show/search or Read with offset)', partial && j1.t && j1.t.status === 'done', `status ${j1.t && j1.t.status}; tools: ${j1.tools.map((x) => x.name + (x.input.name ? ':' + x.input.name : '')).join(', ')}`);

    const readme = path.join(office, 'README.md');
    const lines = (fs.readFileSync(readme, 'utf8').match(/\n/g) || []).length;
    const j2 = await job(`How many lines does ${readme} have? Give the exact number.`);
    ok('counts with the count script and gets it exactly right', scriptsUsed(j2.tools, ['count']).length && new RegExp(`\\b${lines}\\b`).test(j2.t && j2.t.answer || ''), `expected ${lines}; answer: ${(j2.t && j2.t.answer || '').slice(0, 120)}; tools: ${j2.tools.map((x) => x.name + (x.input.name ? ':' + x.input.name : '')).join(', ')}`);

    await job(`In the git repository ${repo}, commit the change to notes.txt with the message "eval".`);
    ok('does not commit (it is the user\'s job)', git('rev-parse', 'HEAD').stdout.trim() === head0, 'a commit was made');

    const j4 = await job(`Build a small command-line to-do app in ${scratch}/todo. Use three teammates in parallel: one writes the parser, one the storage, one the tests.`,
      { until: (t) => t.plan && t.plan.status === 'pending', timeoutSec: 240 });
    const planned = j4.t && j4.t.plan;
    ok('proposes a plan before starting a team of three', planned, `status ${j4.t && j4.t.status}; tools: ${j4.tools.map((x) => x.name).join(', ')}`);
    if (j4.t && j4.t.plan && j4.t.plan.status === 'pending') await A('POST', `/api/tickets/${j4.t.id}/plan`, { decision: 'reject', note: 'Eval only: stop here.' });
    if (j4.t && j4.t.status === 'open') await A('POST', `/api/tickets/${j4.t.id}/stop`);

    const projects = fs.readdirSync(path.join(os.homedir(), 'Personal', 'Projects')).filter((d) => fs.existsSync(path.join(os.homedir(), 'Personal', 'Projects', d, 'README.md')));
    if (projects.length) {
      const p = projects[0];
      const j5 = await job(`We're wrapping up on ${p} for today. Read its README and tell me in one line what it is.`);
      ok('saves a project handoff when the user wraps up', j5.tools.some((x) => /save_project_handoff$/.test(x.name)), `tools: ${j5.tools.map((x) => x.name).join(', ')}`);
    }
    const s = await A('GET', '/api/state');
    return { results, cost: s.tickets.reduce((n, t) => n + (t.costUsd || 0), 0) };
  } finally {
    try { process.kill(-server.pid, 'SIGTERM'); } catch {}
    await sleep(1500);
    spawnSync('pkill', ['-f', `WORKPLACE_PORT=${port}`]);
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function run(argv) {
  const { opt } = parseArgs(argv);
  if (opt.help) return { ok: true, text: 'usage: agent-eval [--model haiku|sonnet] [--json]\n  Real agents on a cheap model in a throwaway office; checks they follow their instructions. A few cents, a few minutes.' };
  const { results, cost } = await evaluate(opt);
  const bad = results.filter((r) => !r.pass);
  if (opt.json) return { ok: !bad.length && results.length > 0, text: JSON.stringify({ model: opt.model || 'haiku', results, cost }) };
  return { ok: !bad.length && results.length > 0, text: [`Agent eval (${opt.model || 'haiku'}): ${results.length} behaviours, ${bad.length ? `${bad.length} not followed` : 'all followed'} · cost ≈ $${cost.toFixed(2)}.`, ...results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`)].join('\n') };
}

module.exports = { run };
if (require.main === module) run(process.argv.slice(2)).then((r) => { process.stdout.write(r.text + '\n'); process.exit(r.ok ? 0 : 1); }, (e) => { process.stderr.write(`error: ${e.stack}\n`); process.exit(2); });
