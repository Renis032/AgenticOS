#!/usr/bin/env node
'use strict';
// Runs the ARMS flows that change ~/.claude (approvals), keep-warm pings and Recos setup against a throwaway copy:
// a temporary HOME and a temporary copy of Agentic OS, with a fake `claude` that only records its arguments.
// Your real ~/.claude and data/ are checked before and after and must be byte-identical.
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { cli, fs, path } = require('./_util');

const ROOT = path.join(__dirname, '..');
const REAL_HOME = os.homedir();
const WATCH = [path.join(REAL_HOME, '.claude', 'CLAUDE.md'), path.join(REAL_HOME, '.claude', 'settings.json'), path.join(ROOT, 'data', 'arms', 'routines.json'), path.join(ROOT, 'data', 'arms', 'settings.json')];
const hash = (f) => { try { return crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex'); } catch { return 'missing'; } };

const HARNESS = String.raw`
const fs = require('fs'), path = require('path');
const [root, home] = process.argv.slice(2);
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail || '' });
const feedback = [];
const agents = new Map(JSON.parse(fs.readFileSync(path.join(root, 'data', 'agents.json'), 'utf8')).map((a) => [a.id, a]));
const arms = require(path.join(root, 'arms')).install({ ROOT: root, DATA: path.join(root, 'data'), PORT: 1, CLAUDE_BIN: path.join(home, 'fake-claude'),
  agents, tickets: new Map(), readJson: (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')), broadcast() {}, touchTicket() {}, childEnv: () => process.env,
  eventsOf: () => [], limits: () => ({ windows: {} }), createTicket() {}, giveFeedback: (from, to, text) => feedback.push({ from, to, text }), notify() {} });
async function call(method, p, b) {
  let out = null;
  const res = { setHeader() {}, writeHead() {}, end() {} };
  await arms.route({ method, headers: {} }, res, new URL('http://x' + p), p, async () => b || {}, (_r, code, obj) => { out = { code, obj }; });
  return out || { code: 404, obj: null };
}
(async () => {
  const C = path.join(home, '.claude');
  const before = fs.readFileSync(path.join(C, 'CLAUDE.md'), 'utf8');
  const st = await call('GET', '/api/arms');
  check('ARMS status loads', st.code === 200 && st.obj.approvals.length >= 6, st.code);
  const mm = await call('POST', '/api/arms/approve/memory-map', {});
  const work = fs.existsSync(path.join(C, 'departments', 'work.md')) ? fs.readFileSync(path.join(C, 'departments', 'work.md'), 'utf8') : '';
  const after = fs.readFileSync(path.join(C, 'CLAUDE.md'), 'utf8');
  const backups = fs.existsSync(path.join(C, 'backups')) ? fs.readdirSync(path.join(C, 'backups')) : [];
  check('Memory map: applied', mm.obj && mm.obj.ok, mm.obj && (mm.obj.message || mm.obj.error));
  check('Memory map: CLAUDE.md became the short map', after.length < before.length * 0.5, before.length + ' → ' + after.length + ' chars');
  check('Memory map: the old CLAUDE.md is backed up byte for byte', backups.some((b) => fs.readFileSync(path.join(C, 'backups', b), 'utf8') === before), backups.join(', '));
  const workStart = before.indexOf('# WORK baseline');
  check('Memory map: WORK notes moved word for word', workStart >= 0 && work.includes(before.slice(workStart).trim().split('\n').slice(0, 40).join('\n')), work.length + ' chars');
  check('Memory map: routers for personal projects and Agentic OS', ['personal.md', 'agentic-os.md'].every((f) => fs.existsSync(path.join(C, 'departments', f))));
  check('Memory map: global rules kept in CLAUDE.md', after.includes('Never run \x60git commit\x60') && after.includes('sudo apt upgrade'));
  for (const n of ['note', 'calibrate', 'search-connectors']) {
    const r = await call('POST', '/api/arms/approve/skill-' + n, {});
    check('Skill /' + n + ': installed', r.obj && r.obj.ok && fs.existsSync(path.join(C, 'skills', n, 'SKILL.md')), r.obj && (r.obj.message || r.obj.error));
  }
  fs.writeFileSync(path.join(C, 'skills', 'note', 'SKILL.md'), 'mine');
  const again = await call('POST', '/api/arms/approve/skill-note', {});
  check('Skill install never overwrites an existing skill', again.obj && again.obj.error && fs.readFileSync(path.join(C, 'skills', 'note', 'SKILL.md'), 'utf8') === 'mine', again.obj && again.obj.error);
  const sl = await call('POST', '/api/arms/approve/statusline', {});
  const s = JSON.parse(fs.readFileSync(path.join(C, 'settings.json'), 'utf8'));
  check('Status line: set in settings.json', s.statusLine && String(s.statusLine.command).endsWith('agentos-statusline.sh'), sl.obj && sl.obj.message);
  check('Status line: other settings kept', s.theme === 'dark' && s.permissions && s.permissions.allow.length === 1);
  check('Status line: settings.json backed up first', fs.readdirSync(C).some((f) => f.startsWith('settings.json.bak-')));
  const out = require('child_process').spawnSync('bash', [s.statusLine.command], { input: JSON.stringify({ workspace: { current_dir: home }, transcript_path: path.join(C, 'projects', '-tmp-proj', 'warm-session.jsonl') }), encoding: 'utf8', env: { ...process.env, HOME: home } });
  check('Status line: runs and shows context size', /ctx \d+k/.test(out.stdout || ''), (out.stdout || out.stderr || '').replace(/\x1b\[[0-9;]*m/g, '').slice(0, 120));
  const kw = await call('POST', '/api/arms/approve/keepwarm', {});
  check('Keep-warm: turned on', kw.obj && kw.obj.ok && JSON.parse(fs.readFileSync(path.join(root, 'data', 'arms', 'settings.json'), 'utf8')).keepWarm === true);
  await arms.schedule();
  const log = fs.existsSync(path.join(home, 'claude-calls.log')) ? fs.readFileSync(path.join(home, 'claude-calls.log'), 'utf8') : '';
  check('Keep-warm: pinged the idle chat (52 min) with --resume', /--resume warm-session/.test(log), log.split('\n').filter(Boolean).length + ' fake claude call(s)');
  check('Keep-warm: left the fresh chat (5 min) and the old chat (3 h) alone', !/fresh-session|old-session/.test(log));
  const k = JSON.parse(fs.readFileSync(path.join(root, 'data', 'arms', 'keepwarm.json'), 'utf8'));
  check('Keep-warm: counted the ping and its cost', k.pings === 1 && k.costUsd > 0, JSON.stringify({ pings: k.pings, costUsd: k.costUsd }));
  const rr = await call('POST', '/api/arms/recos/refresh', {});
  const cards = (rr.obj && rr.obj.cards) || [];
  const rc = cards.find((c) => c.kind === 'routine'), mc = cards.find((c) => c.kind === 'memory');
  check('Recos: found the repeated prompt', !!rc, cards.map((c) => c.title).join(' | '));
  check('Recos: found the repeated correction', !!mc);
  const su = await call('POST', '/api/arms/recos/setup', { ids: cards.map((c) => c.id) });
  const routines = JSON.parse(fs.readFileSync(path.join(root, 'data', 'arms', 'routines.json'), 'utf8'));
  check('Recos setup: created the routine with a $2/week cap', routines.length === 1 && routines[0].capUsdWeek === 2, su.obj && su.obj.done.join(', '));
  check('Recos setup: sent the calibration to the agent', feedback.length === 1 && feedback[0].to === 'staff1');
  const left = await call('GET', '/api/arms/recos');
  check('Recos setup: handled cards disappear', left.obj.cards.length === 0);
  process.stdout.write(JSON.stringify(results));
  process.exit(0);
})().catch((e) => { process.stdout.write(JSON.stringify([...results, { name: 'harness', ok: false, detail: e.stack }])); process.exit(0); });
`;

function fullClaudeMd() {
  const now = path.join(REAL_HOME, '.claude', 'CLAUDE.md');
  const text = fs.readFileSync(now, 'utf8');
  if (text.includes('# WORK baseline')) return text;
  const dir = path.join(REAL_HOME, '.claude', 'backups');
  const old = (() => { try { return fs.readdirSync(dir).filter((f) => /^CLAUDE\.md\.\d/.test(f)).sort().reverse(); } catch { return []; } })()
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).find((t) => t.includes('# WORK baseline'));
  if (!old) throw new Error('No pre-map CLAUDE.md to test with (the current one is already a map and no backup has the WORK notes).');
  return old;
}

function setup(tmp) {
  const root = path.join(tmp, 'agentos'), home = path.join(tmp, 'home'), C = path.join(home, '.claude');
  fs.cpSync(ROOT, root, { recursive: true, filter: (src) => !/\/(data|artifacts|inbox|node_modules|\.git)(\/|$)/.test(path.relative(ROOT, src) ? '/' + path.relative(ROOT, src) : '') });
  fs.mkdirSync(path.join(root, 'data', 'arms'), { recursive: true });
  const day = 86400000, now = Date.now();
  fs.writeFileSync(path.join(root, 'data', 'agents.json'), JSON.stringify([{ id: 'staff1', persona: 'Tess', role: 'work-fsm', staff: true, feedback: [
    { text: 'Your report pasted whole files again; quote only the relevant lines with file:line', t: now - day },
    { text: 'Report pasted whole files, quote only relevant lines with file:line please', t: now - 2 * day }] }]));
  fs.writeFileSync(path.join(root, 'data', 'tickets.json'), JSON.stringify({ seq: 0, tickets: [] }));
  fs.mkdirSync(path.join(C, 'projects', '-tmp-proj'), { recursive: true });
  fs.writeFileSync(path.join(C, 'CLAUDE.md'), fullClaudeMd());
  fs.writeFileSync(path.join(C, 'settings.json'), JSON.stringify({ theme: 'dark', permissions: { allow: ['Bash(ls:*)'] } }, null, 2));
  fs.writeFileSync(path.join(C, 'history.jsonl'), [1, 2, 3, 4].map((i) => JSON.stringify({ display: `read and execute the plan in @plan.md step ${i} for the bot`, timestamp: now - i * 3600000, project: '/tmp/proj' })).join('\n') + '\n');
  const usage = (n) => JSON.stringify({ type: 'assistant', cwd: home, message: { id: 'm' + n, model: 'claude-sonnet-5', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 5, cache_creation_input_tokens: 2000, cache_read_input_tokens: 60000, output_tokens: 10 } }, timestamp: new Date().toISOString() }) + '\n';
  for (const [sid, ageMin] of [['warm-session', 52], ['fresh-session', 5], ['old-session', 180]]) {
    const f = path.join(C, 'projects', '-tmp-proj', sid + '.jsonl');
    fs.writeFileSync(f, usage(sid));
    const t = (now - ageMin * 60000) / 1000;
    fs.utimesSync(f, t, t);
  }
  fs.writeFileSync(path.join(home, 'fake-claude'), `#!/bin/sh\necho "$@" >> "${path.join(home, 'claude-calls.log')}"\necho '{"result":"ok","total_cost_usd":0.0021,"is_error":false}'\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(tmp, 'harness.js'), HARNESS);
  return { root, home };
}

function run() {
  const before = WATCH.map(hash);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-armstest-'));
  let results;
  try {
    const { root, home } = setup(tmp);
    const r = spawnSync(process.execPath, [path.join(tmp, 'harness.js'), root, home], { cwd: root, env: { ...process.env, HOME: home, OPENROUTER_API_KEY: '' }, encoding: 'utf8', timeout: 120000 });
    try { results = JSON.parse(r.stdout); } catch { results = [{ name: 'harness', ok: false, detail: (r.stderr || r.stdout || '').slice(-1500) }]; }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const after = WATCH.map(hash);
  results.push({ name: 'Your real ~/.claude and Agentic OS data were not touched', ok: before.every((h, i) => h === after[i]), detail: WATCH.filter((f, i) => before[i] !== after[i]).join(', ') });
  const failed = results.filter((x) => !x.ok);
  return [...results.map((x) => `${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.detail && (!x.ok || process.argv.includes('--verbose')) ? `  (${x.detail})` : ''}`),
    '', failed.length ? `${failed.length} of ${results.length} checks failed.` : `All ${results.length} checks passed, in a throwaway copy.`].join('\n');
}

module.exports = { run };
if (require.main === module) cli(run);
