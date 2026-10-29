#!/usr/bin/env node
'use strict';
// Exercises the server's API in a throwaway copy of the office (fake agents, empty data, nothing spent) and reports what broke:
// the token wall, jobs and follow-ups, recalling a queued message, terminal commands and the block list, plans and automatic
// approval, handoffs and the Projects board, skill proposals, office settings, restart and scripts. Then starts a second copy
// as a fresh clone (no roster.json, projects.json or teams/) to check it comes up from the examples.
const { parseArgs, fs, path } = require('./_util');
const { spawn, spawnSync } = require('child_process');
const os = require('os');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAKE_CLAUDE = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sid = 'apicheck-' + process.pid;
if (!(process.argv.includes('stream-json') && process.argv.includes('--input-format'))) { out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: sid, total_cost_usd: 0, num_turns: 1, usage: {} }); process.exit(0); }
out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5-5', cwd: process.cwd() });
// A job that says BIGCONTEXT makes the fake agent report a 150k-token context, to test the delegate reminder.
process.stdin.on('data', (d) => { if (String(d).includes('BIGCONTEXT')) out({ type: 'assistant', message: { id: 'msg_big_' + Date.now(), model: 'claude-opus-5-5', content: [{ type: 'text', text: 'reading' }], usage: { input_tokens: 10, cache_read_input_tokens: 150000, cache_creation_input_tokens: 0, output_tokens: 5 } } }); });
setInterval(() => {}, 1 << 30);
`;

function call(port, token, method, p, body, headers) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { ...(token ? { 'x-agentos-token': token } : {}), 'content-type': 'application/json', host: `127.0.0.1:${port}`, ...(headers || {}) } }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} resolve({ code: res.statusCode, body: j, text: s }); });
    });
    req.on('error', (e) => resolve({ code: 0, body: null, text: e.message }));
    req.setTimeout(/\/review$/.test(p) ? 120000 : 15000, () => { req.destroy(); resolve({ code: 0, body: null, text: 'timeout' }); });
    if (data) req.write(data);
    req.end();
  });
}
const freePort = () => new Promise((resolve) => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

async function startOffice(dir, claude, extraEnv) {
  const port = await freePort();
  const proc = spawn(process.execPath, ['server.js'], { cwd: dir, env: { ...process.env, AGENTOS_TEST_PARENT: String(process.pid), WORKPLACE_PORT: String(port), CLAUDE_BIN: claude, ...(extraEnv || {}) }, stdio: 'ignore', detached: true });
  const token = () => { try { return fs.readFileSync(path.join(dir, 'data', 'app-token'), 'utf8').trim(); } catch { return ''; } };
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    if (token() && (await call(port, token(), 'GET', '/api/limits')).code === 200) return { port, token: token(), proc };
  }
  return { port, token: token(), proc, failed: true };
}
// A stand-in for the Telegram Bot API: records every call, and serves pushed updates to long polling.
function fakeTelegram() {
  const calls = [], updates = [], waiting = [];
  let nextId = 1, nextMsg = 100;
  const server = http.createServer((req, res) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => {
      let b = {};
      try { b = JSON.parse(s || '{}'); } catch {}
      const method = req.url.split('/').pop();
      const reply = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result })); };
      if (method !== 'getUpdates') calls.push({ method, body: b });
      if (method === 'getMe') return reply({ id: 1, is_bot: true, username: 'agentos_check_bot', first_name: 'Check' });
      if (method === 'sendMessage') return reply({ message_id: nextMsg++, chat: { id: b.chat_id }, text: b.text });
      if (method !== 'getUpdates') return reply(true);
      const pick = () => (b.offset === -1 ? updates.slice(-1) : updates.filter((u) => u.update_id >= (b.offset || 0)));
      if (pick().length || !b.timeout) return reply(pick());
      const w = { done: () => { clearTimeout(w.timer); reply(pick()); } };
      w.timer = setTimeout(() => { waiting.splice(waiting.indexOf(w), 1); reply([]); }, Math.min(b.timeout, 25) * 1000);
      waiting.push(w);
    });
  });
  const push = (u) => { updates.push({ update_id: nextId++, ...u }); for (const w of waiting.splice(0)) w.done(); };
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, calls, push, close: () => server.close() })));
}

const stopOffice = (o) => { try { process.kill(-o.proc.pid, 'SIGTERM'); } catch {} };
async function until(fn, ms) { for (let t = 0; t < ms; t += 250) { const v = await fn(); if (v) return v; await sleep(250); } return null; }

async function check() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-apicheck-'));
  const office = path.join(work, 'office');
  const claude = path.join(work, 'claude');
  fs.writeFileSync(claude, FAKE_CLAUDE, { mode: 0o755 });
  spawnSync('rsync', ['-a', '--exclude', '.git', '--exclude', 'data', `${ROOT}/`, `${office}/`]);
  // The transcript index cache only makes usage reports fast; without it a weekly review re-reads every transcript.
  if (fs.existsSync(path.join(ROOT, 'data', 'usage'))) spawnSync('rsync', ['-a', path.join(ROOT, 'data', 'usage') + '/', path.join(office, 'data', 'usage') + '/']);
  const results = [];
  const ok = (name, pass, detail) => results.push({ name, pass: !!pass, detail: pass ? '' : String(detail || '').slice(0, 300) });

  // Who stays on a team (lib/on-call.js), checked directly: no agents needed.
  {
    const agents = new Map(), tickets = new Map([['t1', { id: 't1', handoffs: ['RecipeBox'] }], ['t2', { id: 't2', handoffs: ['trail-log'] }]]);
    const oc = require(path.join(ROOT, 'lib', 'on-call')).install({ agents, tickets, now: () => 1, touch: () => {} });
    const curator = { id: 'c', staff: true, role: 'custom', tickets: ['t1'] }, researcher = { id: 'r', staff: true, role: 'researcher', tickets: ['t1'] };
    agents.set('c', curator); agents.set('r', researcher);
    oc.onHire(curator, {}, tickets.get('t1')); oc.onHire(researcher, {}, tickets.get('t1'));
    ok('a custom hire is on call for its project; a roster role joins the team', curator.onCall && curator.onCall.project === 'RecipeBox' && !researcher.onCall, JSON.stringify([curator.onCall, researcher.onCall]));
    ok('an on-call specialist is only picked for their own project', oc.available(curator, tickets.get('t1')) && !oc.available(curator, tickets.get('t2')) && oc.available(researcher, tickets.get('t2')));
    oc.onReuse(curator, {}, tickets.get('t2')); curator.tickets.push('t2');
    ok('used on a second project, an on-call specialist joins the team', !curator.onCall && curator.joinedTeam, JSON.stringify(curator));
    const kept = { id: 'k', staff: true, role: 'custom', tickets: [] };
    oc.onHire(kept, { stay: 'team' }, tickets.get('t1'));
    oc.setScope('c', false);
    ok('`stay: "team"` keeps a custom hire; the user can switch someone back to project only', !kept.onCall && curator.onCall && curator.onCall.project === 'trail-log', JSON.stringify([kept.onCall, curator.onCall]));
    // Parallel duplicates merge once their job closes; long-unused specialists retire; memory moves to the archive and back.
    const mem = fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-oncall-'));
    fs.mkdirSync(path.join(mem, 'memory'));
    const t3 = { id: 't3', n: 3, closedAt: 5, handoffs: ['wow'] };
    const ag2 = new Map(), tk2 = new Map([['t3', t3]]);
    const oc2 = require(path.join(ROOT, 'lib', 'on-call')).install({ agents: ag2, tickets: tk2, now: () => 100 * 86400000, touch: () => {}, DATA: mem });
    const dup = (id, done) => ({ id, persona: id, name: 'Build Watcher', staff: true, role: 'custom', customDef: { name: 'Build Watcher' }, homeId: 'lead', status: 'idle', tickets: ['t3'], tasksDone: done, tasksFailed: 0, hiredAt: 99 * 86400000, onCall: { project: 'wow' } });
    ag2.set('w1', dup('w1', 1)); ag2.set('w2', dup('w2', 2)); ag2.set('old', { ...dup('old', 1), tickets: [], onCall: { project: null }, hiredAt: 1 });
    fs.writeFileSync(path.join(mem, 'memory', 'w1.md'), 'notes');
    oc2.tidy();
    ok('after a job, parallel duplicates merge into the best one', ag2.get('w1').retired && !ag2.get('w2').retired && fs.existsSync(path.join(mem, 'memory', 'archive', 'w1.md')), JSON.stringify([ag2.get('w1').retired, ag2.get('w2').retired]));
    ok('an on-call specialist unused for 30 days retires', ag2.get('old').retired && /30 days/.test(ag2.get('old').retired.why), JSON.stringify(ag2.get('old').retired));
    oc2.onReuse(ag2.get('w1'), {}, t3);
    ok('naming a retired teammate brings them back with their memory', !ag2.get('w1').retired && fs.existsSync(path.join(mem, 'memory', 'w1.md')));
    fs.rmSync(mem, { recursive: true, force: true });
  }
  // Lessons from jobs that went wrong (lib/lessons.js), checked directly.
  {
    const agents = new Map([['lead', { id: 'lead' }], ['god', { id: 'god' }]]);
    const fb = [];
    const L = require(path.join(ROOT, 'lib', 'lessons')).install({ agents, readJson: () => ({ root: 'god', defaults: { reviewLessons: 0 } }), now: () => 1, newId: (() => { let i = 0; return () => 'l' + ++i; })(),
      touch: () => {}, addEvent: () => {}, giveFeedback: (from, to, text) => fb.push({ to, text }), findSecret: require(path.join(ROOT, 'lib', 'secrets')).findSecret });
    const t = { n: 7, title: 'x', direct: 'lead', assignees: ['god', 'lead'] };
    L.ask(t, 'failed'); L.ask(t, 'failed'); L.ask(t, 'rated', 'wrong file');
    ok('a job that went wrong asks its lead (not the router) for a lesson, once per reason', fb.length === 2 && fb.every((f) => f.to === 'lead' && /add_lesson/.test(f.text)) && /wrong file/.test(fb[1].text), JSON.stringify(fb));
    for (let i = 1; i <= 9; i++) L.add('lead', `lesson number ${i}`);
    const ls = agents.get('lead').lessons;
    ok('lessons are capped at 8, the oldest dropping off', ls.length === 8 && ls[0].text === 'lesson number 2', JSON.stringify(ls.map((x) => x.text)));
    L.add('lead', 'Lesson number 5!');
    ok('a repeated lesson replaces the old one instead of adding a copy', agents.get('lead').lessons.filter((x) => /number 5/i.test(x.text)).length === 1, '');
    ok('a lesson must be one short line', /Too long/.test(L.add('lead', 'x'.repeat(300)).error || ''), 'accepted');
    ok('a lesson can be removed', L.remove('lead', ls[0].id).ok && !agents.get('lead').lessons.some((x) => x.id === ls[0].id), '');
    // With review on (the default), a lesson waits as a draft until the user keeps (or edits) or drops it.
    const ag = new Map([['lead', { id: 'lead', persona: 'Lead' }]]);
    const R = require(path.join(ROOT, 'lib', 'lessons')).install({ agents: ag, readJson: () => ({ root: 'god', defaults: {} }), now: () => 1, newId: (() => { let i = 0; return () => 'd' + ++i; })(),
      touch: () => {}, addEvent: () => {}, giveFeedback: () => {}, findSecret: () => null, broadcast: () => {} });
    const bare = R.add('lead', 'Run the tests before saying done.');
    ok('with review on, a lesson without its reasoning is refused', /reasoning/.test(bare.error || '') && !(ag.get('lead').lessonDrafts || []).length, JSON.stringify(bare));
    const sent = R.add('lead', 'Run the tests before saying done.', { n: 9, lessonAsked: ['rework'] }, 'I said the fix was done without running the tests; the user found it still broken.');
    R.add('lead', 'Ask before renaming files.', null, 'I renamed a file the user still imported elsewhere.');
    const [d1, d2] = ag.get('lead').lessonDrafts;
    ok('a lesson to review carries the agent\'s reasoning and what made the office ask', /without running the tests/.test(d1.reason) && /follow up/.test(d1.trigger || '') && d1.ticketN === 9 && !d2.trigger, JSON.stringify([d1, d2]));
    ok('with review on, a new lesson waits for the user instead of reaching the prompt', /review/.test(sent.message) && ag.get('lead').lessonDrafts.length === 2 && !(ag.get('lead').lessons || []).length && !R.promptBlock(ag.get('lead')).length, JSON.stringify(ag.get('lead')));
    const kept = R.approve('lead', d1.id, 'Run the tests before reporting a fix as done.');
    const dropped = R.drop('lead', d2.id);
    ok('the user keeps a lesson as edited, or drops one', kept.ok && kept.edited && dropped.ok && ag.get('lead').lessons.length === 1 && /reporting a fix/.test(R.promptBlock(ag.get('lead')).join('\n')) && !ag.get('lead').lessonDrafts.length, JSON.stringify(ag.get('lead')));
  }
  // Suggested answers for a question asked without choices (lib/suggest-answers.js).
  {
    const { suggest } = require(path.join(ROOT, 'lib', 'suggest-answers'));
    const cases = [['Should I also update the tests?', 'Yes|No'], ['Which database: Postgres, MySQL or SQLite?', 'Postgres|MySQL|SQLite'],
      ['Two ways:\n1. Patch the parser\n2. Rewrite the loader — slower\nWhich one?', 'Patch the parser|Rewrite the loader'],
      ['Can you send the log?', ''], ['What is the path to the log?', ''], ['Should I keep the old API or remove it?', '']];
    const bad = cases.filter(([q, want]) => suggest(q).join('|') !== want);
    ok('questions without choices get suggested answers from their wording (yes/no, A or B, a list), and none when unsure', !bad.length, JSON.stringify(bad.map(([q]) => [q, suggest(q)])));
  }
  // Checks before done (lib/verify.js): real exit codes decide; a failure goes back to the lead once, then the job fails.
  {
    const vdir = fs.mkdtempSync(path.join(work, 'verify-'));
    const closed = [], sent = [], th = [];
    const V = require(path.join(ROOT, 'lib', 'verify')).install({ blockedCommand: (r, c) => (/rm -rf/.test(c) ? 'rm -rf' : null), broadcast: () => {}, closeTicket: (t, failed) => { t.status = failed ? 'failed' : 'done'; closed.push([t.n, t.status]); },
      enqueueResident: (k, item) => sent.push([k, item.text]), lessons: { ask: () => {} }, now: Date.now, readJson: () => ({ defaults: { verifyRetries: 1 } }), spawn, thread: (t, e) => th.push(e), touchTicket: () => {}, workdirOf: () => vdir });
    const mk = (n, cmds) => ({ id: 'v' + n, n, status: 'open', pending: [], thread: [], verifyCmds: cmds });
    const good = mk(1, ['true', 'echo ok']);
    const bad = mk(2, ['echo failing >&2; exit 3']);
    V.start(good, 'lead'); V.start(bad, 'lead');
    await until(() => closed.length === 1 && sent.length === 1, 8000);
    ok('the office runs a job\'s checks itself: passing closes it done, a failure goes back to the lead with the output', good.status === 'done' && good.verify.status === 'passed' && bad.status === 'open' && /exited with 3/.test(sent[0][1]) && /failing/.test(sent[0][1]), JSON.stringify({ closed, sent, gv: good.verify, bv: bad.verify }).slice(0, 400));
    V.start(bad, 'lead');
    await until(() => closed.length === 2, 8000);
    ok('a check that fails again after the retry ends the job as failed, with the evidence in the thread', bad.status === 'failed' && bad.verify.attempt === 2 && th.some((e) => e.kind === 'verify' && e.ok === false), JSON.stringify(bad.verify).slice(0, 300));
    const ev = V.evidence({ commands: [{ command: 'npm test', exitCode: 1 }, { command: 'npm run lint', exitCode: 0 }, { command: 'npm test', exitCode: 0 }, { command: 'make', exitCode: 2 }] });
    ok('evidence keeps the last run of each command and flags the ones still failing', ev.commands.length === 3 && ev.failing.length === 1 && ev.failing[0].command === 'make', JSON.stringify(ev));
    ok('a job without checks is not held back', V.start(mk(3, []), 'lead') === false, '');
  }
  // The reviewer (lib/verify.js): a job without checks that changed files is read by a model before it closes.
  {
    const closed = [], sent = [], th = [], prompts = [];
    let replies = [];
    const mode = { reviewAnswers: 1 };
    const R = require(path.join(ROOT, 'lib', 'verify')).install({ blockedCommand: () => null, broadcast: () => {}, changesOf: (t) => (t.changes || []).map((c) => ({ ...c, state: 'modified', added: 1, removed: 0, diff: '+changed line' })),
      closeTicket: (t, failed) => { t.status = failed ? 'failed' : 'done'; closed.push([t.n, t.status]); }, enqueueResident: (k, item) => sent.push([k, item.text]), lessons: { ask: () => {} }, now: Date.now,
      oneShot: async (p) => { prompts.push(p); return replies.shift() || { error: 'no reply' }; }, readJson: () => ({ defaults: { verifyRetries: 1, ...mode } }), spawn, thread: (t, e) => th.push(e), touchTicket: () => {}, workdirOf: () => work });
    const mk = (n, extra) => ({ id: 'r' + n, n, status: 'open', pending: [], thread: [], verifyCmds: [], text: 'Fix the parser', answer: 'Fixed it; tests pass.', changes: [{ path: '/x/parser.js' }], ...extra });
    ok('a job without checks that changed nothing is not reviewed (unless set to every job), nor are routines', R.start(mk(1, { changes: [] }), 'lead') === false && R.start(mk(2, { routine: 'r1' }), 'lead') === false, '');
    replies = [{ text: 'PASS', costUsd: 0.02 }];
    const good = mk(3);
    const tookGood = R.start(good, 'lead');
    await until(() => closed.length === 1, 3000);
    ok('the reviewer reads the request, answer and diff; PASS closes the job done and adds its cost', tookGood && good.status === 'done' && good.reviewer.status === 'passed' && good.costUsd === 0.02 && /Fix the parser/.test(prompts[0]) && /tests pass/.test(prompts[0]) && /\+changed line/.test(prompts[0]), JSON.stringify(good.reviewer));
    replies = [{ text: 'FAIL\n- parser.js: the empty-input case still throws\nsome chatter', costUsd: 0.02 }];
    const bad = mk(4);
    R.start(bad, 'lead');
    await until(() => sent.length === 1, 3000);
    ok('a FAIL goes back to the lead with the problems, and the job stays open', bad.status === 'open' && bad.reviewer.status === 'failed' && /empty-input case/.test(sent[0][1]) && !/chatter/.test(sent[0][1]), JSON.stringify({ r: bad.reviewer, sent }).slice(0, 300));
    replies = [{ text: 'FAIL\n- parser.js: still throws', costUsd: 0.02 }];
    R.start(bad, 'lead');
    await until(() => closed.length === 2, 3000);
    ok('a second FAIL after the retry closes the job done with the concerns flagged, not failed', bad.status === 'done' && bad.reviewer.status === 'flagged' && bad.reviewer.attempt === 2 && th.some((e) => e.kind === 'verify' && e.ok === false && /still has concerns/.test(e.text)), JSON.stringify(bad.reviewer));
    replies = [{ error: 'model unavailable' }];
    const broken = mk(5);
    R.start(broken, 'lead');
    await until(() => closed.length === 3, 3000);
    mode.reviewAnswers = 0;
    ok('a reviewer that cannot answer never holds the job, and the setting turns it off', broken.status === 'done' && broken.reviewer.status === 'skipped' && R.start(mk(6), 'lead') === false, JSON.stringify(broken.reviewer));
  }
  // Isolated workspaces (lib/workspaces.js): a git worktree per job, applied back without commits, or discarded.
  if (spawnSync('git', ['--version']).status === 0) {
    const repo = fs.mkdtempSync(path.join(work, 'repo-'));
    const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    g('init', '-q'); fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n'); g('add', '.'); g('commit', '-qm', 'init');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\nuncommitted\n'); fs.writeFileSync(path.join(repo, 'new.txt'), 'untracked\n');
    const tk = new Map();
    const other = { id: 'o1', n: 1, project: 'Repo', status: 'open' };
    tk.set('o1', other);
    const Wk = require(path.join(ROOT, 'lib', 'workspaces')).install({ DATA: path.join(work, 'wsdata'), fs, home: (p) => p, now: Date.now, path, readJson: (f) => (f === 'projects.json' ? [{ name: 'Repo', path: repo }] : { defaults: {} }), thread: () => {}, tickets: tk, touchTicket: () => {} });
    const job = { id: 'w1', n: 2, project: 'Repo', status: 'open' };
    tk.set('w1', job);
    const W = Wk.create(job);
    const startsFromNow = W && fs.readFileSync(path.join(W.path, 'a.txt'), 'utf8').includes('uncommitted') && fs.existsSync(path.join(W.path, 'new.txt'));
    ok('a second job on the same git project works in its own worktree, starting from the project as it is now (uncommitted and untracked files too)', !!W && startsFromNow && Wk.blockedRoot(job) === repo, JSON.stringify(W));
    fs.writeFileSync(path.join(W.path, 'a.txt'), 'one\nuncommitted\nfrom the job\n'); fs.writeFileSync(path.join(W.path, 'b.txt'), 'added\n');
    const rv = Wk.review(job);
    job.status = 'done';
    const ap = Wk.apply(job);
    const log = g('log', '--oneline').stdout.trim().split('\n').length;
    ok('the user reviews the job\'s diff and applies it to the project: files change, nothing is committed, the worktree is removed', rv.files.length === 2 && ap.ok && !ap.conflicts && fs.readFileSync(path.join(repo, 'a.txt'), 'utf8').includes('from the job') && fs.existsSync(path.join(repo, 'b.txt')) && log === 1 && !fs.existsSync(W.worktree), JSON.stringify({ rv: rv.files, ap, log }));
    const job2 = { id: 'w2', n: 3, project: 'Repo', status: 'open' };
    tk.set('w2', job2);
    const W2 = Wk.create(job2);
    fs.writeFileSync(path.join(W2.path, 'c.txt'), 'nope\n');
    job2.status = 'done';
    ok('or discards it, leaving the project untouched', Wk.discard(job2).ok && !fs.existsSync(path.join(repo, 'c.txt')) && !fs.existsSync(W2.worktree), '');
  }
  // Project memory (lib/project-memory.js): instructions always, other entries only when relevant.
  {
    const P = require(path.join(ROOT, 'lib', 'project-memory')).install({ DATA: path.join(work, 'pmdata'), agents: new Map(), findSecret: () => null, fs, newId: (() => { let i = 0; return () => 'p' + ++i; })(), now: Date.now, path,
      readJson: () => [{ name: 'Shop', path: '~/shop' }], ticketOfAgent: () => null });
    P.add('Shop', 'instruction', 'Use pnpm, never npm, in this repository.', 'user');
    P.add('Shop', 'failure', 'Date tests fail outside UTC; jest.config.js sets TZ=UTC since #41.', 'lead', 41);
    P.add('Shop', 'decision', 'Payments go through the Stripe webhook handler in api/webhooks.ts, never from the client.', 'lead', 30);
    P.add('Shop', 'outcome', '"Fix checkout button colour" ended done.', 'office', 12);
    const brief = P.briefFor({ project: 'Shop', title: 'Date tests are failing', text: 'The date tests fail on CI again.' });
    ok('a job\'s brief gets the project\'s instructions and only the relevant memories', /pnpm/.test(brief) && /TZ=UTC/.test(brief) && !/Stripe/.test(brief) && !/checkout/.test(brief), brief);
    ok('project memory refuses unknown projects and empty notes', P.add('Nope', 'decision', 'something long enough').error && P.add('Shop', 'decision', 'short').error, '');
  }
  // Recovery (lib/recovery.js): an interrupted job resumes with what already happened, so nothing is done twice.
  {
    const ags = new Map([['lead', { id: 'lead', persona: 'Lead', resident: true }]]);
    const q = [];
    const Rc = require(path.join(ROOT, 'lib', 'recovery')).install({ ACTIVE: ['working'], agents: ags, broadcast: () => {}, enqueueResident: (k, i) => q.push([k, i.text]), eventsOf: () => [{ kind: 'progress', text: 'tests half fixed', t: 1 }], now: Date.now,
      readJson: () => ({ root: 'god' }), restartResident: () => {}, thread: () => {}, tickets: new Map(), touchTicket: () => {} });
    const t = { id: 'r1', n: 5, title: 'x', text: 'Fix the tests', status: 'open', pending: [], direct: 'lead', thread: [], changes: [{ path: '/tmp/a.js' }], commands: [{ command: 'npm install', exitCode: 0, status: 'done' }] };
    Rc.markInterrupted(t, 'the office restarted');
    const r = Rc.resume(t);
    ok('an interrupted job resumes with what already happened (files, commands, progress) and a warning not to repeat actions', t.status === 'open' && r.ok && /\/tmp\/a\.js/.test(q[0][1]) && /npm install` → exit 0/.test(q[0][1]) && /Do NOT repeat/.test(q[0][1]) && /half fixed/.test(q[0][1]), q[0] && q[0][1].slice(0, 300));
  }
  // Outcomes (lib/outcomes.js): cost per successful job, not per job.
  {
    const tk = new Map([
      ['a', { id: 'a', n: 1, status: 'done', createdAt: 0, closedAt: 600000, costUsd: 2, direct: 'lead', thread: [] }],
      ['b', { id: 'b', n: 2, status: 'done', createdAt: 0, closedAt: 600000, costUsd: 3, direct: 'lead', thread: [], rework: 1 }],
      ['c', { id: 'c', n: 3, status: 'failed', createdAt: 0, closedAt: 600000, costUsd: 1, direct: 'lead', thread: [{ kind: 'verify', ok: false }], verify: { status: 'failed', attempt: 2 } }],
    ]);
    const O = require(path.join(ROOT, 'lib', 'outcomes')).install({ agents: new Map([['lead', { id: 'lead', persona: 'Lead' }]]), now: () => 700000, readJson: () => ({ root: 'god' }), tickets: tk });
    const o = O.report(30).overall;
    ok('outcomes count only clean successes and give the cost per successful job', o.jobs === 3 && o.succeeded === 1 && o.costPerSuccess === 6 && o.checkFails === 1 && o.retries === 2, JSON.stringify(o));
  }
  // The agent eval over time (lib/evals.js), with a stand-in eval script so nothing is spent.
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-evals-'));
    fs.mkdirSync(path.join(root, 'scripts')); fs.mkdirSync(path.join(root, 'data'));
    fs.writeFileSync(path.join(root, 'roster.json'), '{}');
    fs.writeFileSync(path.join(root, 'scripts', 'agent-eval.js'), `const n = require('fs').readdirSync(${JSON.stringify(path.join(root, 'data'))}).length;
console.log(JSON.stringify({ model: 'haiku', cost: 0.05, results: [{ name: 'never commits', pass: true }, { name: 'plans first', pass: n === 0 }] }));`);
    const notes = [];
    const E = require(path.join(ROOT, 'lib', 'evals')).install({ ROOT: root, DATA: path.join(root, 'data'), readJson: () => ({ defaults: {} }), now: Date.now,
      broadcast: (m) => { if (m.type === 'notify') notes.push(m); }, isIdle: () => true, canSpend: () => true });
    const finished = async () => { for (let i = 0; i < 60 && E.view().running; i++) await sleep(100); };
    E.runNow('manual'); await finished();
    fs.writeFileSync(path.join(root, 'roster.json'), '{"changed":1}');
    E.runNow('manual'); await finished();
    const runs = E.history();
    ok('each agent eval run is kept, with whether the instructions changed since the run before', runs.length === 2 && runs[0].passed === 2 && runs[1].passed === 1 && !runs[0].instructionsChanged && runs[1].instructionsChanged, JSON.stringify(runs).slice(0, 300));
    ok('a behaviour that passed last time and fails now is notified', notes.some((n) => /no longer followed/.test(n.title) && /plans first/.test(n.text)), JSON.stringify(notes));
    fs.rmSync(root, { recursive: true, force: true });
  }
  const offices = [];
  const tg = await fakeTelegram();
  try {
    const O = await startOffice(office, claude, { TELEGRAM_API: tg.url });
    offices.push(O);
    ok('server starts with an empty data folder', !O.failed, 'no answer on /api/limits');
    if (O.failed) return results;
    const A = (m, p, b) => call(O.port, O.token, m, p, b);

    ok('requests without the token are refused', (await call(O.port, '', 'GET', '/api/state')).code === 403, 'expected 403');
    ok('requests from a web page (other Origin) are refused', (await call(O.port, O.token, 'POST', '/api/tasks', { text: 'x' }, { origin: 'http://evil.example' })).code === 403, 'expected 403');
    const st = (await A('GET', '/api/state')).body || {};
    ok('state lists agents and residents', (st.agents || []).length && (st.residents || []).length, JSON.stringify(Object.keys(st)));
    const projects = st.projects || [];
    const personal = projects.find((p) => p.keywordsFromSubfolders) || projects.find((p) => p.department && p.department !== st.root);
    const lead = personal ? personal.department : (st.residents || []).find((k) => k !== st.root);

    const t1 = (await A('POST', '/api/tasks', { text: 'API check job', project: personal && personal.name })).body || {};
    ok('a job can be created', t1.id, 'no id');
    const leadBusy = await until(async () => { const s = (await A('GET', '/api/state')).body; const a = s && s.agents.find((x) => x.id === lead); return a && a.current && a.current.ticketId === t1.id; }, 8000);
    ok('the lead picks the job up', leadBusy, `lead ${lead} did not start it`);

    ok('a follow-up is accepted', (await A('POST', `/api/tickets/${t1.id}/message`, { text: 'make it blue' })).body?.ok, 'no ok');
    const queued = await until(async () => { const s = (await A('GET', '/api/state')).body; return s.agents.some((a) => (a.inbox || []).some((i) => i.ticketId === t1.id && i.fid)); }, 3000);
    ok('the follow-up waits in the lead\'s inbox while it is busy', queued, 'not queued');
    const rc = (await A('POST', `/api/tickets/${t1.id}/recall`)).body || {};
    ok('a queued follow-up can be taken back', rc.text === 'make it blue', JSON.stringify(rc));
    const afterRecall = (await A('GET', '/api/state')).body;
    ok('taking it back removes it from the conversation and the inbox', !afterRecall.tickets.find((t) => t.id === t1.id).thread.some((e) => e.kind === 'followup') && !afterRecall.agents.some((a) => (a.inbox || []).some((i) => i.fid)), 'still there');

    await A('POST', '/api/terminal-mode', { mode: 'ask' });
    const cmdP = A('POST', '/api/command/run', { agentId: lead, command: 'echo api-check-ok', reason: 'check' });
    const cid = await until(async () => { const s = (await A('GET', '/api/state')).body; const c = s.tickets.flatMap((t) => t.commands || []).find((x) => x.status === 'pending'); return c && c.id; }, 4000);
    ok('a command waits for approval in "ask" mode', cid, 'no pending command');
    if (cid) await A('POST', `/api/commands/${cid}/decide`, { decision: 'run' });
    const cmd = (await cmdP).body || {};
    ok('an approved command runs and returns its output', /Exit code 0/.test(cmd.message || '') && /api-check-ok/.test(cmd.message || ''), JSON.stringify(cmd));
    const again2 = (await A('POST', '/api/command/run', { agentId: lead, command: 'echo  api-check-ok', reason: 'again' })).body || {};
    ok('a command that worked before in the same folder runs without asking', /api-check-ok/.test(again2.message || ''), JSON.stringify(again2));
    const blocked = (await A('POST', '/api/command/run', { agentId: lead, command: 'bash -c "git push origin main"', reason: 'x' })).body || {};
    ok('blocked commands are refused, even inside quotes', /Not allowed/.test(blocked.error || ''), JSON.stringify(blocked));
    const denyP = A('POST', '/api/command/run', { agentId: lead, command: 'echo nope', reason: 'x' });
    const cid2 = await until(async () => { const s = (await A('GET', '/api/state')).body; const c = s.tickets.flatMap((t) => t.commands || []).find((x) => x.status === 'pending'); return c && c.id; }, 4000);
    if (cid2) await A('POST', `/api/commands/${cid2}/decide`, { decision: 'deny' });
    ok('a denied command reports back as not run', /chose not to run/.test(((await denyP).body || {}).error || ''), 'no denial');

    // Telegram (lib/telegram.js) against the stand-in Bot API: linking, a foreign chat, approving a plan, deciding in the window.
    {
      const sent = (re) => tg.calls.filter((c) => c.method === 'sendMessage' && re.test(c.body.text || ''));
      const link = (await A('POST', '/api/telegram', { token: `123456:${'A'.repeat(32)}` })).body || {};
      ok('a Telegram bot token is checked and gives a pair code', link.ok && link.botName === '@agentos_check_bot' && /^\d{6}$/.test(link.pairCode || ''), JSON.stringify(link));
      tg.push({ message: { message_id: 1, chat: { id: 999, first_name: 'Stranger' }, text: '/start 000000' } });
      tg.push({ message: { message_id: 2, chat: { id: 4242, first_name: 'Me' }, text: `/start ${link.pairCode}` } });
      const linked = await until(async () => ((await A('GET', '/api/telegram')).body || {}).linked && (await A('GET', '/api/telegram')).body, 6000);
      ok('sending the pair code links that chat, not one with a wrong code', linked && linked.chatName === 'Me' && !JSON.stringify(linked).includes('AAAA'), JSON.stringify(linked));
      await A('POST', '/api/office-settings', { autoApprovePlansUsd: 0 });
      const tp = A('POST', '/api/propose-plan', { agentId: lead, plan: '1. telegram step', estimateUsd: 3 });
      const msg = await until(async () => sent(/telegram step/)[0], 6000);
      const kb = msg && msg.body.reply_markup && msg.body.reply_markup.inline_keyboard;
      const approve = kb && kb.flat().find((x) => /approve$/.test(x.callback_data));
      ok('a plan that needs you arrives in Telegram with Approve / Reject buttons', msg && msg.body.chat_id === 4242 && approve && kb.flat().some((x) => /reject$/.test(x.callback_data)), JSON.stringify(msg ? msg.body : tg.calls.map((c) => c.method + ':' + String(c.body.text || '').slice(0, 40))).slice(0, 400));
      if (approve) {
        tg.push({ callback_query: { id: 'cq1', data: approve.callback_data, message: { message_id: 7, chat: { id: 999 } } } });
        await sleep(1500);
        const still = (await A('GET', '/api/state')).body.tickets.find((x) => x.id === t1.id).plan.status;
        ok('a button press from another chat is ignored', still === 'pending', still);
        tg.push({ callback_query: { id: 'cq2', data: approve.callback_data, message: { message_id: 7, chat: { id: 4242 } } } });
        const res = await Promise.race([tp, sleep(6000).then(() => ({ body: {} }))]);
        const ed = await until(async () => tg.calls.some((c) => c.method === 'editMessageText' && /Approved in Telegram/.test(c.body.text)), 4000);
        ok('Approve in Telegram approves the plan and updates the message', /approved/.test((res.body || {}).message || '') && ed, JSON.stringify(res.body));
      }
      const wp = A('POST', '/api/propose-plan', { agentId: lead, plan: '1. window step', estimateUsd: 3 });
      await until(async () => sent(/window step/)[0], 6000);
      await A('POST', `/api/tickets/${t1.id}/plan`, { decision: 'reject' });
      await wp;
      const edited = await until(async () => tg.calls.find((c) => c.method === 'editMessageText' && /Decided in the window: plan rejected/.test(c.body.text)), 6000);
      ok('deciding in the window updates the Telegram message', edited, 'no edit');
      // Running jobs from the chat: /new, a follow-up by number, a plain message offered as a job, the job card's
      // buttons, and the status commands.
      let mid = 50;
      const say = (text, extra) => tg.push({ message: { message_id: mid++, chat: { id: 4242, first_name: 'Me' }, text, ...extra } });
      const press = (data) => tg.push({ callback_query: { id: `cq${mid++}`, data, message: { message_id: 7, chat: { id: 4242 } } } });
      const jobBy = async (text) => until(async () => ((await A('GET', '/api/state')).body.tickets || []).find((x) => x.text === text), 6000);
      ok('linking sets the bot\'s command menu', tg.calls.some((c) => c.method === 'setMyCommands' && (c.body.commands || []).some((x) => x.command === 'new')), 'no setMyCommands');
      say('/new telegram started job');
      const tj = await jobBy('telegram started job');
      const card = tj && await until(async () => sent(new RegExp(`#${tj.n} telegram started job`)).find((c) => JSON.stringify(c.body.reply_markup || {}).includes(`j|${tj.id}|`)), 4000);
      ok('/new starts a job and answers with its card and buttons', tj && card, tj ? 'no card' : 'no job');
      if (tj) {
        say(`#${tj.n} telegram follow-up`);
        const fu = await until(async () => ((await A('GET', '/api/state')).body.tickets.find((x) => x.id === tj.id).thread || []).some((e) => e.kind === 'followup' && e.text === 'telegram follow-up'), 4000);
        ok('"#N message" follows up on that job', fu, 'no follow-up');
        press(`j|${tj.id}|pause`);
        const paused = await until(async () => (await A('GET', '/api/state')).body.tickets.find((x) => x.id === tj.id).status === 'paused', 4000);
        press(`j|${tj.id}|resume`);
        const resumed = await until(async () => (await A('GET', '/api/state')).body.tickets.find((x) => x.id === tj.id).status === 'open', 4000);
        ok('Pause and Resume on the job card work', paused && resumed, `paused ${paused} resumed ${resumed}`);
        press(`j|${tj.id}|stop`);
        await sleep(800);
        ok('Stop on the job card asks first', (await A('GET', '/api/state')).body.tickets.find((x) => x.id === tj.id).status === 'open' &&
          tg.calls.some((c) => c.method === 'editMessageText' && JSON.stringify(c.body.reply_markup || {}).includes(`j|${tj.id}|stopyes`)), 'stopped without asking');
        press(`j|${tj.id}|stopyes`);
        ok('…and stops the job once confirmed', await until(async () => (await A('GET', '/api/state')).body.tickets.find((x) => x.id === tj.id).status === 'stopped', 4000), 'not stopped');
      }
      say('a plain telegram message');
      const offer = await until(async () => sent(/Start this as a new job\?/)[0], 4000);
      const go = offer && offer.body.reply_markup.inline_keyboard.flat().find((x) => /\|go$/.test(x.callback_data));
      ok('a plain message is offered as a new job, not started', offer && go && !((await A('GET', '/api/state')).body.tickets || []).some((x) => x.text === 'a plain telegram message'), 'no offer');
      if (go) {
        press(go.callback_data);
        const pj = await jobBy('a plain telegram message');
        ok('…and Start the job starts it', pj, 'not started');
        if (pj) await A('POST', `/api/tickets/${pj.id}/stop`);
      }
      for (const [cmd, re] of [['/ps', /Processes/], ['/usage', /Usage/], ['/jobs', /In progress|Nothing is in progress/], ['/help', /what I can do/]]) {
        say(cmd);
        ok(`${cmd} answers`, await until(async () => sent(re).length, 4000), 'no answer');
      }
      const back = await until(async () => ((await A('GET', '/api/state')).body.agents || []).filter((a) => a.resident).every((a) => a.status !== 'offline'), 15000);
      ok('every lead is back in the office after jobs it was routing were stopped', back, JSON.stringify(((await A('GET', '/api/state')).body.agents || []).filter((a) => a.resident).map((a) => [a.id, a.status, a.current && a.current.ticketId, (a.inbox || []).length])));
      const off = (await A('DELETE', '/api/telegram')).body || {};
      ok('Telegram can be disconnected', off.configured === false && off.linked === false, JSON.stringify(off));
    }

    await A('POST', '/api/office-settings', { autoApprovePlansUsd: 0 });
    const planP = A('POST', '/api/propose-plan', { agentId: lead, plan: '1. one\n2. two', estimateUsd: 9 });
    const pending = await until(async () => { const s = (await A('GET', '/api/state')).body; const t = s.tickets.find((x) => x.id === t1.id); return t && t.plan && t.plan.status === 'pending'; }, 4000);
    ok('a plan waits for the user', pending, 'not pending');
    await A('POST', `/api/tickets/${t1.id}/plan`, { decision: 'always' });
    ok('"approve, don\'t ask again here" approves the plan', /approved/.test(((await planP).body || {}).message || ''), 'no approval');
    const again = (await A('POST', '/api/propose-plan', { agentId: lead, plan: '1. three', estimateUsd: 50 })).body || {};
    ok('…and later plans on that job go ahead by themselves', /approved automatically/.test(again.message || ''), JSON.stringify(again));

    const before = (await A('GET', '/api/office-settings')).body || {};
    const set = (await A('POST', '/api/office-settings', { remindAfterMinutes: 30, autoCompactTokens: 120000 })).body || {};
    ok('office settings can be read and changed', set.remindAfterMinutes === 30 && set.autoCompactTokens === 120000, JSON.stringify(set));
    await A('POST', '/api/office-settings', before);

    const folders = (() => { try { return fs.readdirSync(path.join(os.homedir(), 'Personal', 'Projects')).filter((d) => !d.startsWith('.')); } catch { return []; } })();
    if (folders.length) {
      const hs = (await A('POST', '/api/handoff/save', { agentId: lead, project: folders[0], state: 'State from the API check', session: 'API check' })).body || {};
      ok('a project handoff can be saved', /Saved handoff/.test(hs.message || ''), JSON.stringify(hs));
      const board = (await A('GET', '/api/projects-board')).body || [];
      ok('the Projects board shows the handoff', board.some((c) => c.name === folders[0] && c.handoff && /API check/.test(c.handoff.state)), 'missing');
    }
    ok('opening a missing file fails clearly', /Could not find/.test(((await A('POST', '/api/open-file', { path: 'no-such-file.xyz' })).body || {}).error || ''), 'no error');

    const sp = (await A('POST', '/api/skill-proposals/propose', { agentId: lead, name: 'API check skill', description: 'Use in API checks.', why: 'test', scope: 'team', content: '1. Check.' })).body || {};
    ok('an agent can propose a skill', /Proposed/.test(sp.message || ''), JSON.stringify(sp));
    const props = (await A('GET', '/api/skill-proposals')).body || [];
    const prop = props.find((x) => x.name === 'api-check-skill');
    const dec = prop ? (await A('POST', `/api/skill-proposals/${prop.id}/decide`, { decision: 'approve' })).body || {} : {};
    ok('approving a skill installs it for the team', dec.proposal && fs.existsSync(dec.proposal.file || ''), JSON.stringify(dec).slice(0, 200));

    const rv = (await A('GET', '/api/restart')).body || {};
    ok('the restart view reports who is busy', Array.isArray(rv.busy) && rv.busy.length > 0, JSON.stringify(rv));
    const pend = (await A('POST', '/api/restart', { when: 'idle' })).body || {};
    const cancel = (await A('POST', '/api/restart', { when: 'cancel' })).body || {};
    ok('a restart waits while agents work, and can be cancelled', pend.pending && !cancel.pending, JSON.stringify({ pend, cancel }));

    const sc = (await A('POST', '/api/script', { name: 'outline', args: [path.join(office, 'lib', 'skills.js')] })).body || {};
    ok('office scripts run through the API', /function install/.test(JSON.stringify(sc)), JSON.stringify(sc).slice(0, 200));

    // Changes and undo: the hook saves a file before an agent's first edit; undo puts it back.
    const target = path.join(office, 'api-check-file.txt');
    fs.writeFileSync(target, 'before\n');
    await A('POST', '/api/files/before', { agentId: lead, file: target });
    await A('POST', '/api/files/touch', { agentId: lead, file: target });
    fs.writeFileSync(target, 'after\n');
    const changes = (await A('GET', `/api/tickets/${t1.id}/changes`)).body || [];
    ok('an agent\'s file edit shows up as a change with a diff', Array.isArray(changes) && changes.some((c) => c.path === target && /after/.test(c.diff || '')), JSON.stringify(changes).slice(0, 200));
    await A('POST', `/api/tickets/${t1.id}/revert`, { path: target });
    ok('undo puts the file back', fs.readFileSync(target, 'utf8') === 'before\n', fs.readFileSync(target, 'utf8'));
    const fbLead = ((await A('GET', '/api/state')).body.agents.find((a) => a.id === lead) || {}).feedback || [];
    ok('undoing a job\'s changes asks its lead for a lesson', fbLead.some((f) => /add_lesson/.test(f.text)), JSON.stringify(fbLead).slice(0, 200));
    const les = (await A('POST', '/api/lessons', { agentId: lead, text: 'Check the target file is the one the user meant before editing.', reasoning: 'I edited the wrong file and the user undid it.' })).body || {};
    const draft = (((await A('GET', '/api/state')).body.agents.find((a) => a.id === lead) || {}).lessonDrafts || [])[0];
    const keepL = draft ? (await A('POST', `/api/agents/${lead}/lesson-drafts/${draft.id}`, {})).code : 0;
    const withLesson = ((await A('GET', '/api/state')).body.agents.find((a) => a.id === lead) || {}).lessons || [];
    const delL = withLesson[0] ? (await A('DELETE', `/api/agents/${lead}/lessons/${withLesson[0].id}`)).code : 0;
    ok('an agent\'s lesson waits for review with its reasoning; the user keeps it through the API, and can remove it later', /review/.test(les.message || '') && draft && /wrong file/.test(draft.reason || '') && keepL === 200 && withLesson.length === 1 && delL === 200, JSON.stringify({ les, draft, keepL, withLesson, delL }));
    const stAdd = (await A('POST', `/api/agents/${lead}/standing`, { text: 'When you fix a bug, end with a short brief on why this fix and a commit message like the recent ones.' })).body || {};
    const stPrompt = stAdd.standing || [];
    const stDel = stPrompt[0] ? (await A('DELETE', `/api/agents/${lead}/standing/${stPrompt[0].id}`)).body || {} : {};
    const stEmpty = (await A('POST', `/api/agents/${lead}/standing`, { text: '  ' })).code;
    ok('a lead keeps a standing instruction from the user until it is removed', stPrompt.length === 1 && Array.isArray(stDel.standing) && stDel.standing.length === 0 && stEmpty === 400, JSON.stringify({ stAdd, stDel, stEmpty }).slice(0, 300));
    ok('undoing a job\'s changes is recorded as a signal for model choice', ((await A('GET', '/api/state')).body.tickets.find((t) => t.id === t1.id) || {}).undone >= 1, 'not recorded');
    const tl = (await A('GET', `/api/tickets/${t1.id}/timeline`)).body || {};
    ok('the job timeline lists who worked on it', Array.isArray(tl.rows) && tl.rows.length > 0, JSON.stringify(tl).slice(0, 200));
    ok('spend by day, team and model loads', (await A('GET', '/api/spend')).code === 200, 'no spend');
    const doc = (await A('POST', '/api/docs/add', { agentId: lead, page: 'api-check', text: 'A note from the API check.' })).body || {};
    ok('agents can add to their team library', /Recorded/.test(doc.message || ''), JSON.stringify(doc));
    const teams = (await A('GET', '/api/teams')).body || [];
    ok('the library lists the new page', teams.some((t) => t.pages.some((pg) => /api-check\.md$/.test(pg.path))), 'page missing');
    const others = (st.agents || []).filter((a) => a.id !== lead && a.resident);
    if (others.length) {
      const mail = (await A('POST', '/api/mail/send', { agentId: lead, to: others[0].persona, text: 'Hello from the API check.' })).body || {};
      ok('agents can send each other messages', mail && !mail.error, JSON.stringify(mail));
    }
    if (others.length) {
      await A('POST', '/api/files/touch', { agentId: lead, file: target });
      const warn = (await A('POST', '/api/files/touch', { agentId: others[0].id, file: target })).body || {};
      ok('two agents editing the same file both get a heads-up', /Heads-up/.test(warn.warning || ''), JSON.stringify(warn).slice(0, 200));
    }
    ok('colleagues lists who is in the office', /\w/.test(((await A('GET', `/api/colleagues?agentId=${lead}`)).body || {}).text || ''), 'empty');
    const chatAsk = (await A('POST', `/api/teams/${lead}/ask`, { text: 'Team question from the API check' })).body || {};
    const chat = (await A('GET', `/api/teams/${lead}/chat`)).body || [];
    ok('the team room takes questions and lists them', !chatAsk.error && Array.isArray(chat), JSON.stringify(chatAsk).slice(0, 200));
    const cfg = (await A('GET', '/api/config')).body || {};
    ok('Teams & roles loads the configuration', Array.isArray(cfg.roles) && cfg.roles.length > 0, JSON.stringify(Object.keys(cfg)));
    const asked = (await A('POST', '/api/ask-office', { question: 'What did Renko do today?' })).body || {};
    const askedEmpty = (await A('POST', '/api/ask-office', { question: '  ' })).body || {};
    ok('Ask the office answers from gathered facts, and refuses an empty question', asked.answer === 'ok' && Array.isArray(asked.sources) && asked.factsChars > 100 && askedEmpty.error, JSON.stringify({ asked, askedEmpty }).slice(0, 300));
    // The office for outside Claude Code sessions (lib/mcp-office.js): read-only tools over MCP, no model called.
    {
      const mcp = spawn(process.execPath, [path.join(office, 'lib', 'mcp-office.js')], { env: { ...process.env, WORKPLACE_PORT: String(O.port) }, stdio: ['pipe', 'pipe', 'ignore'] });
      const replies = new Map();
      let buf = '';
      mcp.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(line); replies.set(m.id, m); } catch {} } });
      const rpc = async (id, method, params) => { mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); await until(() => replies.has(id), 8000); return replies.get(id) || {}; };
      const text = (m) => (((m.result || {}).content || [])[0] || {}).text || '';
      await rpc(1, 'initialize', { protocolVersion: '2024-11-05' });
      const names = (((await rpc(2, 'tools/list')).result || {}).tools || []).map((x) => x.name);
      const recall = await rpc(3, 'tools/call', { name: 'office_recall', arguments: { query: 'what is Renko working on' } });
      const proj = await rpc(4, 'tools/call', { name: 'office_project', arguments: { name: 'no such project' } });
      const job = await rpc(5, 'tools/call', { name: 'office_job', arguments: { n: 99999 } });
      mcp.kill();
      ok('outside Claude Code sessions get read-only office tools over MCP: recall from gathered facts, projects, jobs', names.join() === 'office_recall,office_job,office_project' &&
        /The office now/.test(text(recall)) && !recall.result.isError && proj.result.isError && /Office projects:/.test(text(proj)) && job.result.isError && /No job/.test(text(job)), JSON.stringify({ names, recall: text(recall).slice(0, 120), proj: text(proj).slice(0, 120), job: text(job) }));
      const down = spawn(process.execPath, [path.join(office, 'lib', 'mcp-office.js')], { env: { ...process.env, WORKPLACE_PORT: String(await freePort()) }, stdio: ['pipe', 'pipe', 'ignore'] });
      let downOut = '';
      down.stdout.on('data', (c) => (downOut += c));
      down.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'office_recall', arguments: { query: 'x' } } }) + '\n');
      await until(() => /not running/.test(downOut), 5000);
      down.kill();
      ok('with the office stopped, the MCP tools say how to start it instead of failing obscurely', /not running/.test(downOut), downOut.slice(0, 200));
    }
    const team = (await A('POST', '/api/config/team', { persona: 'Vera', room: 'Research Desk', description: 'Owns research questions.' })).body || {};
    ok('a new team can be created from Teams & roles', team.ok && !team.error, JSON.stringify(team).slice(0, 200));
    // The new-lead wizard: a draft from the user's words (the stand-in model answers "ok", so the template is used), then a full lead.
    const dr = (await A('POST', '/api/config/team/draft', { purpose: 'Look after my home server: docker containers, nightly backups and the raspberry pi.', persona: 'Hale' })).body || {};
    const tooShort = (await A('POST', '/api/config/team/draft', { purpose: 'servers' })).body || {};
    ok('the lead wizard drafts a lead from a plain description, and asks for more when it is too short', dr.persona === 'Hale' && dr.prompt.length > 100 && dr.keywords.includes('docker') && tooShort.error, JSON.stringify({ dr, tooShort }).slice(0, 300));
    const made = (await A('POST', '/api/config/team', { ...dr, room: 'Homelab', keywords: ['homelab', 'docker'], roles: [{ name: 'Ops Engineer', description: 'Runs containers.', access: 'edit' }] })).body || {};
    const cfg2 = (await A('GET', '/api/config')).body || {};
    const leadRole = (cfg2.roles || []).find((r) => r.key === made.key) || {};
    const roster2 = { root: cfg2.root, residents: cfg2.residents, roles: Object.fromEntries((cfg2.roles || []).map((r) => [r.key, r])) };
    const routed = require(path.join(ROOT, 'scripts', 'route.js')).route('restart the docker containers on the homelab box', cfg2.projects || [], roster2);
    ok('a wizard lead gets its instructions, specialists and routing keywords, and matching jobs route to it', made.ok && /Never commit or push/.test(leadRole.prompt) && (leadRole.children || []).includes('homelab-ops-engineer') &&
      routed.lead === made.key, JSON.stringify({ made, routed, leadRole: { ...leadRole, prompt: (leadRole.prompt || '').slice(0, 80) } }).slice(0, 400));
    const ev = (await A('GET', '/api/evals')).body || {};
    const evSet = (await A('POST', '/api/office-settings', { agentEvalDays: 3 })).body || {};
    ok('the agent eval history loads, and how often it runs can be set', Array.isArray(ev.runs) && evSet.agentEvalDays === 3, JSON.stringify({ ev, evSet: evSet.agentEvalDays }));
    ok('the health report loads', ((await A('GET', '/api/health')).body || {}).level !== undefined, 'no level');
    const rev = (await A('POST', `/api/agents/${lead}/review`)).body || {};
    ok('a weekly review can be started', rev.id || /no tickets|nothing|week/i.test(JSON.stringify(rev)), JSON.stringify(rev).slice(0, 200));

    // Edit scope: a job about a project may edit inside it; outside needs the user's OK.
    if (folders.length) {
      const scoped = (await A('POST', '/api/tasks', { text: `Edit scope check for ${folders[0]}`, project: personal && personal.name })).body || {};
      for (const t of ((await A('GET', '/api/state')).body.tickets || []).filter((x) => x.status === 'open' && x.id !== scoped.id)) await A('POST', `/api/tickets/${t.id}/stop`);
      await until(async () => { const s4 = (await A('GET', '/api/state')).body; const a = s4.agents.find((x) => x.id === lead); return a && a.current && a.current.ticketId === scoped.id; }, 10000);
      const projDir = path.join(os.homedir(), 'Personal', 'Projects', folders[0]);
      const inProj = (await A('POST', '/api/files/before', { agentId: lead, file: path.join(projDir, 'no-such-file.txt') })).body || {};
      const outside = (await A('POST', '/api/files/before', { agentId: lead, file: path.join(os.homedir(), '.bashrc') })).body || {};
      const scratch = (await A('POST', '/api/files/before', { agentId: lead, file: path.join(os.homedir(), 'apicheck_test', 'x.txt') })).body || {};
      ok('edits inside the job\'s project and scratch folders are allowed', !inProj.deny && !scratch.deny, JSON.stringify({ inProj, scratch }).slice(0, 200));
      ok('edits outside the job\'s project are blocked with a way to ask', /request_edit_access/.test(outside.deny || ''), JSON.stringify(outside).slice(0, 200));
      const reqP = A('POST', '/api/edit-access/request', { agentId: lead, folder: '~/.config/apicheck', reason: 'check' });
      const aid = await until(async () => { const s5 = (await A('GET', '/api/state')).body; const r = s5.tickets.flatMap((x) => x.access || []).find((x) => x.status === 'pending'); return r && r.id; }, 4000);
      if (aid) await A('POST', `/api/edit-access/${aid}/decide`, { decision: 'allow' });
      const granted = (await reqP).body || {};
      const after = (await A('POST', '/api/files/before', { agentId: lead, file: path.join(os.homedir(), '.config', 'apicheck', 'x.txt') })).body || {};
      ok('the user can allow a folder, and edits there then go through', /Allowed/.test(granted.message || '') && !after.deny, JSON.stringify({ granted, after }).slice(0, 200));
      await A('POST', `/api/tickets/${scoped.id}/stop`);
    }
    // A lead whose context passes the threshold is reminded to delegate (delivered as mail after its next tool call).
    // Earlier checks (the job, the weekly review, the team-room question) left the lead with open jobs the fake agent never finishes.
    for (const t of ((await A('GET', '/api/state')).body.tickets || []).filter((x) => ['open', 'paused'].includes(x.status))) await A('POST', `/api/tickets/${t.id}/stop`);
    await until(async () => { const s2 = (await A('GET', '/api/state')).body; const a = s2.agents.find((x) => x.id === lead); return a && !a.current; }, 6000);
    const big = (await A('POST', '/api/tasks', { text: 'BIGCONTEXT check', project: personal && personal.name })).body || {};
    const nudged = await until(async () => { const u = (await A('GET', `/api/mail/unread?agentId=${lead}`)).body || {}; return /Your own context is now 150k/.test(u.text || '') ? u.text : null; }, 8000);
    let why = 'no reminder';
    if (!nudged) {
      const s3 = (await A('GET', '/api/state')).body; const a3 = s3.agents.find((x) => x.id === lead);
      const ev = ((await A('GET', `/api/agents/${lead}/events?limit=6`)).body || []).map((e) => `${e.kind}:${String(e.text || '').slice(0, 50)}`).join(' | ');
      why = `lead ${a3.status}, current ${a3.current && a3.current.ticketId}, inbox ${a3.inbox.length} (${a3.inbox.map((i) => i.kind).join(',')}), big ${big.id}; events: ${ev}`;
    }
    ok('a lead past the context threshold is reminded to delegate', nudged, why);
    const t1stop = big.id || t1.id;
    // The brain: knowledge graph, decision flow, optimizer and node details.
    const kg = (await A('GET', '/api/brain/knowledge')).body || {};
    ok('the brain builds a knowledge graph of agents, memories and libraries', Array.isArray(kg.nodes) && kg.nodes.some((n) => n.type === 'agent') && kg.nodes.some((n) => n.type === 'page') && Array.isArray(kg.edges) && kg.edges.length > 0, JSON.stringify(Object.keys(kg)));
    const fl = (await A('GET', '/api/brain/flow?days=30')).body || {};
    ok('the brain maps how jobs flow from routing to outcome', Array.isArray(fl.nodes) && fl.nodes.some((n) => n.col === 0) && fl.nodes.some((n) => n.col === 2) && Array.isArray(fl.columns) && fl.columns.length === 8, JSON.stringify(Object.keys(fl)));
    const fi = (await A('GET', '/api/brain/findings')).body;
    ok('the optimizer returns findings with actions', Array.isArray(fi) && fi.every((x) => x.title && Array.isArray(x.actions)), JSON.stringify(fi).slice(0, 200));
    const page = (kg.nodes || []).find((n) => n.type === 'page');
    const nd = page ? (await A('GET', `/api/brain/node?id=${encodeURIComponent(page.id)}`)).body || {} : {};
    ok('a knowledge node opens with its content and connections', page && typeof nd.content === 'string' && Array.isArray(nd.links), JSON.stringify(nd).slice(0, 200));
    const stop = (await A('POST', `/api/tickets/${t1stop}/stop`)).code === 200;
    const stopped = await until(async () => ((await A('GET', '/api/state')).body.tickets.find((t) => t.id === t1stop) || {}).status === 'stopped', 4000);
    ok('a job can be stopped', stop && stopped, 'not stopped');

    // Twins: a busy lead hands a job for another ticket to a second desk; with leadTwins 0 the job queues instead.
    {
      await A('POST', '/api/office-settings', { leadTwins: 1 });
      await until(async () => { const s = (await A('GET', '/api/state')).body; const a = s.agents.find((x) => x.id === lead); return a && !a.current; }, 6000);
      const j1 = (await A('POST', '/api/tasks', { text: 'Twin check one', project: personal && personal.name })).body || {};
      await until(async () => { const s = (await A('GET', '/api/state')).body; const a = s.agents.find((x) => x.id === lead); return a && a.current && a.current.ticketId === j1.id; }, 8000);
      const j2 = (await A('POST', '/api/tasks', { text: 'Twin check two', project: personal && personal.name })).body || {};
      const twin = await until(async () => {
        const s = (await A('GET', '/api/state')).body;
        const tw = s.agents.find((x) => x.twinOf === lead && !x.retired && ((x.current && x.current.ticketId === j2.id) || (x.inbox || []).some((i) => i.ticketId === j2.id)));
        return tw && (s.tickets.find((t) => t.id === j2.id) || {}).twin === tw.id ? tw : null;
      }, 8000);
      ok('a busy lead hands a job for another ticket to a second desk (twin)', twin && / ·2$/.test(twin.persona), twin ? twin.persona : 'no twin');
      await A('POST', `/api/tickets/${j2.id}/message`, { text: 'twin follow-up' });
      const reached = twin && await until(async () => { const s = (await A('GET', '/api/state')).body; const tw = s.agents.find((x) => x.id === twin.id); return tw && (tw.inbox || []).some((i) => i.ticketId === j2.id && i.fid); }, 3000);
      ok('a follow-up on the twin\'s ticket goes to the twin, not the lead', reached, 'not in the twin\'s inbox');
      const mem = twin ? (await A('POST', '/api/memory', { agentId: twin.id, content: 'overwrite' })).body || {} : {};
      ok('a twin cannot overwrite its lead\'s memory', /read-only/.test(mem.error || ''), JSON.stringify(mem));
      const set0 = (await A('POST', '/api/office-settings', { leadTwins: 0 })).body || {};
      const j3 = (await A('POST', '/api/tasks', { text: 'Twin check three', project: personal && personal.name })).body || {};
      const q = await until(async () => { const s = (await A('GET', '/api/state')).body; const t = s.tickets.find((x) => x.id === j3.id); return t && t.queue ? { q: t.queue, n1: (s.tickets.find((x) => x.id === j1.id) || {}).n, n3: t.n, lead: s.agents.find((x) => x.id === lead) } : null; }, 4000);
      ok('with leadTwins 0 a job waits in the lead\'s inbox and shows what it is queued behind',
        set0.leadTwins === 0 && q && q.q.position === 1 && q.q.behindTicketN === q.n1 && q.q.agentPersona === q.lead.persona && q.lead.inboxTickets.includes(q.n3),
        JSON.stringify(q && { q: q.q, n1: q.n1, n3: q.n3, inbox: q.lead.inboxTickets, set0: set0.leadTwins }));
      for (const j of [j1, j2, j3]) if (j.id) await A('POST', `/api/tickets/${j.id}/stop`);
      // With its job stopped and no second desks allowed, the twin retires, and says when and why (not just "offline").
      const gone = await until(async () => { const s = (await A('GET', '/api/state')).body; const x = s.agents.find((y) => y.twinOf === lead); return x && x.retired && !x.retiring && x.status === 'offline' ? x : null; }, 40000);
      ok('a twin with nothing to do retires with when and why, and stops retiring once its process is gone', gone && gone.retired.t && /second desks/.test(gone.retired.why || ''), JSON.stringify(gone && { retired: gone.retired, retiring: gone.retiring, status: gone.status }));
      await A('POST', '/api/office-settings', { leadTwins: 1 });
    }
    ok('a lead can be given a fresh session', (await A('POST', `/api/agents/${lead}/refresh`)).code === 200, 'refused');

    // A fresh clone: no local config, no team libraries, no data.
    const fresh = path.join(work, 'fresh');
    spawnSync('rsync', ['-a', '--exclude', '.git', '--exclude', 'data', '--exclude', 'teams', '--exclude', 'roster.json', '--exclude', 'projects.json', `${ROOT}/`, `${fresh}/`]);
    const F = await startOffice(fresh, claude);
    offices.push(F);
    const fs2 = F.failed ? {} : (await call(F.port, F.token, 'GET', '/api/state')).body || {};
    ok('a fresh clone starts from the example roster and projects', !F.failed && (fs2.residents || []).length && fs.existsSync(path.join(fresh, 'roster.json')), F.failed ? 'did not start' : 'no residents');

    // A damaged agents.json (a crash mid-write, a full disk) is set aside and the rolling backup loaded.
    if (!F.failed) {
      stopOffice(F);
      await sleep(1200);
      const af = path.join(fresh, 'data', 'agents.json'), good = fs.readFileSync(af, 'utf8');
      fs.writeFileSync(`${af}.bak`, good);
      fs.writeFileSync(af, good.slice(0, Math.floor(good.length / 2)));
      const G = await startOffice(fresh, claude);
      offices.push(G);
      const gs = G.failed ? {} : (await call(G.port, G.token, 'GET', '/api/state')).body || {};
      const aside = fs.readdirSync(path.join(fresh, 'data')).some((f) => f.startsWith('agents.json.corrupt-'));
      ok('a damaged agents.json is set aside and its backup loaded', !G.failed && aside && (gs.agents || []).length === JSON.parse(good).length, G.failed ? 'did not start' : `aside ${aside}, agents ${(gs.agents || []).length}/${JSON.parse(good).length}`);

      // Backups: back up, change something, restore; the office restarts onto the backup and keeps a before-restore copy.
      if (!G.failed) {
        const B = (await call(G.port, G.token, 'POST', '/api/backups')).body || {};
        const mark = path.join(fresh, 'data', 'memory', 'restore-check.md');
        fs.mkdirSync(path.dirname(mark), { recursive: true });
        fs.writeFileSync(mark, 'written after the backup');
        const R = (await call(G.port, G.token, 'POST', '/api/backups/restore', { name: B.name })).body || {};
        const back = await until(async () => {
          if (fs.existsSync(mark)) return null;
          const v = (await call(G.port, G.token, 'GET', '/api/backups')).body;
          return v && v.list ? v : null;
        }, 20000);
        ok('a backup can be made and restored (the office restarts onto it)', B.name && R.ok && back && back.list.some((b) => b.kind === 'before-restore'), JSON.stringify({ B: B.name || B.error, R, back: !!back }));
      }
    }
  } finally {
    for (const o of offices) stopOffice(o);
    tg.close();
    await sleep(600);
    spawnSync('pkill', ['-f', claude]);
    fs.rmSync(work, { recursive: true, force: true });
  }
  return results;
}

async function run(argv) {
  const { opt } = parseArgs(argv);
  if (opt.help) return { text: 'usage: api-check\n  Exercises the server API in a throwaway copy (fake agents, nothing spent) and lists what broke. About 20 s.', ok: true };
  const r = await check();
  const bad = r.filter((x) => !x.pass);
  return { ok: !bad.length && r.length > 0, text: [`API check: ${r.length} checks, ${bad.length ? `${bad.length} failed` : 'all passed'}.`, ...r.map((x) => `${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.detail ? `  (${x.detail})` : ''}`)].join('\n') };
}

module.exports = { run };
if (require.main === module) run(process.argv.slice(2)).then((r) => { process.stdout.write(r.text + '\n'); process.exit(r.ok ? 0 : 1); }, (e) => { process.stderr.write(`error: ${e.stack}\n`); process.exit(2); });
