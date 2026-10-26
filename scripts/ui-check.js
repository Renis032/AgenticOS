#!/usr/bin/env node
'use strict';
// Clicks through the whole Agentic OS window in a throwaway copy of the office (fake agents, virtual screen, nothing spent) and
// reports JavaScript errors, buttons that do nothing, buttons pushed off screen and layouts that overflow, with a screenshot per step.
const { parseArgs, cli, fs, path } = require('./_util');
const { spawn, spawnSync } = require('child_process');
const os = require('os');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FAKE_CLAUDE = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sid = 'uicheck-' + process.pid;
if (!(process.argv.includes('stream-json') && process.argv.includes('--input-format'))) { out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: sid, total_cost_usd: 0, num_turns: 1, usage: {} }); process.exit(0); }
out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5-5', cwd: process.cwd() });
let buf = '';
process.stdin.on('data', (d) => { buf += d; });
setInterval(() => {}, 1 << 30);
`;

function call(port, token, method, p, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'x-agentos-token': token, 'content-type': 'application/json', host: `127.0.0.1:${port}` } }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve(s); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    if (data) req.write(data);
    req.end();
  });
}

const freePort = () => new Promise((resolve) => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

async function check(opt) {
  const xvfb = spawnSync('which', ['Xvfb']).status === 0;
  if (!xvfb) return { text: 'Needs Xvfb (sudo apt install xvfb).', ok: false };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-uicheck-'));
  const office = path.join(work, 'office');
  const out = path.resolve(opt.out ? String(opt.out).replace(/^~/, os.homedir()) : path.join(work, 'shots'));
  fs.mkdirSync(out, { recursive: true });
  spawnSync('rsync', ['-a', '--exclude', '.git', '--exclude', 'data/backups', '--exclude', 'data/snapshots', '--exclude', 'data/usage', `${ROOT}/`, `${office}/`]);
  fs.writeFileSync(path.join(work, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  const port = await freePort();
  let display = 90;
  while (fs.existsSync(`/tmp/.X11-unix/X${display}`) || fs.existsSync(`/tmp/.X${display}-lock`)) display++;
  const procs = [];
  const env = { ...process.env, WORKPLACE_PORT: String(port), CLAUDE_BIN: path.join(work, 'claude'), DISPLAY: `:${display}`, HOME: process.env.HOME };
  try {
    procs.push(spawn('Xvfb', [`:${display}`, '-screen', '0', `${(opt.size || '1600x1000').replace('x', 'x')}x24`], { stdio: 'ignore' }));
    procs.push(spawn(process.execPath, ['server.js'], { cwd: office, env, stdio: 'ignore', detached: true }));
    const token = () => { try { return fs.readFileSync(path.join(office, 'data', 'app-token'), 'utf8').trim(); } catch { return ''; } };
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { await sleep(250); up = !!(token() && await call(port, token(), 'GET', '/api/limits')); }
    if (!up) return { text: 'The test server did not start.', ok: false };
    const T = token();
    // A job in every state the window has to show: a long plan waiting, a command waiting, a finished job with an answer.
    const state = await call(port, T, 'GET', '/api/state');
    const lead = (state.residents || []).find((k) => k !== state.root && /personal/.test(k)) || (state.residents || []).find((k) => k !== state.root);
    const proj = (state.projects || []).find((x) => x.department === lead);
    const job = await call(port, T, 'POST', '/api/tasks', { text: 'UI check: a job with a very long title that has to be cut off nicely in the header, the list and the title bar', project: proj && proj.name });
    await sleep(1500);
    const plan = Array.from({ length: 40 }, (_, i) => `${i + 1}. Step ${i + 1}: do something long enough to wrap onto a second line in the plan banner so that it really overflows.`).join('\n');
    call(port, T, 'POST', '/api/propose-plan', { agentId: lead, plan, estimateUsd: 14 });
    call(port, T, 'POST', '/api/command/run', { agentId: lead, command: 'echo ui-check', reason: 'UI check' });
    await sleep(1200);
    const now = await call(port, T, 'GET', '/api/state');
    const waiting = (now.tickets || []).find((t) => t.plan && t.plan.status === 'pending') || job;
    const done = (state.tickets || []).filter((t) => t.status === 'done' && t.answer).sort((a, b) => b.createdAt - a.createdAt)[0];
    const apps = (opt.quick ? ['today', 'brain', 'processes', 'jobs', 'projects', 'newjob'] : ['today', 'brain', 'processes', 'jobs', 'newjob', 'arms', 'skills', 'routines', 'recos', 'projects', 'messages', 'memory', 'library', 'terminal', 'usage', 'tokens', 'health', 'settings']);
    const steps = [
      ...apps.map((a) => ({ name: `app-${a}`, js: `openApp('${a}')`, wait: a === 'tokens' || a === 'usage' ? 1800 : 800 })),
      { name: 'job-waiting', js: `S.job = '${waiting && waiting.id}'; S.jtab = 'thread'; openApp('jobs')`, wait: 1000 },
      ...(done ? [{ name: 'job-done', js: `S.job = '${done.id}'; S.jtab = 'thread'; openApp('jobs')`, wait: 1000 }, { name: 'job-changes', js: `S.jtab = 'changes'; S.jviewFor = null; openApp('jobs')`, wait: 900 }, { name: 'job-timeline', js: `S.jtab = 'timeline'; openApp('jobs')`, wait: 900 }] : []),
      { name: 'brain-flow', js: `openApp('brain'); ACT.brainTab({ tab: 'flow' })`, wait: 2500 },
      { name: 'brain-optimize', js: `ACT.brainTab({ tab: 'optimize' })`, wait: 1500 },
      { name: 'brain-knowledge', js: `ACT.brainTab({ tab: 'knowledge' })`, wait: 2500 },
      // Drag the busiest agent 160px and hold it: its linked nodes must follow (physics), unlinked ones much less.
      { name: 'brain-map-drag', js: `(() => {
        const c = document.querySelector('canvas.bmap'), p0 = typeof BrainMap !== 'undefined' && BrainMap.positions();
        if (!c || !p0) return __uiErrors.push('brain map did not start');
        const id = Object.keys(p0).filter((k) => k.startsWith('agent:')).map((k) => [k, BrainMap.screenOf(k)]).filter(([, s]) => s).sort((a, b) => b[1].links.length - a[1].links.length)[0];
        if (!id) return __uiErrors.push('brain map: no agent on screen');
        const [aid, s] = id, r = c.getBoundingClientRect(), at = (x, y) => ({ clientX: r.left + x, clientY: r.top + y, bubbles: true });
        c.dispatchEvent(new MouseEvent('mousedown', at(s.x, s.y)));
        let i = 0; const t = setInterval(() => { i++; window.dispatchEvent(new MouseEvent('mousemove', at(s.x + i * 16, s.y))); if (i === 10) { clearInterval(t);
          setTimeout(() => {
            // Movement along the drag direction: the layout may still be settling, but that drift has no direction.
            const p1 = BrainMap.positions(), D = p1[aid].map((v, j) => v - p0[aid][j]), len = Math.hypot(...D) || 1;
            const along = (k) => p1[k].reduce((a, v, j) => a + (v - p0[k][j]) * D[j], 0) / len, avg = (ks) => ks.reduce((a, k) => a + along(k), 0) / Math.max(1, ks.length);
            const linked = s.links.filter((k) => p1[k]), far = Object.keys(p1).filter((k) => k !== aid && !s.links.includes(k));
            window.dispatchEvent(new MouseEvent('mouseup', at(s.x + 160, s.y)));
            window.__dragResult = { node: Math.round(len), linked: Math.round(avg(linked)), others: Math.round(avg(far)) };
            if (len < 60) __uiErrors.push('map drag: the node did not move (' + Math.round(len) + ')');
            else if (avg(linked) < 10 || avg(linked) < avg(far) + 8) __uiErrors.push('map drag: neighbours did not follow ' + JSON.stringify(window.__dragResult));
          }, 600); } }, 30);
      })()`, wait: 2000 },
      { name: 'main-menu', js: `ACT.appmenu({}, { target: document.querySelector('[data-act=appmenu]') })` },
      { name: 'palette', js: `closeMenu(); openPal()` },
      { name: 'notifications', js: `closePal(); ACT.ncenter()` },
      ...(opt.quick ? ['general', 'appearance'] : ['general', 'appearance', 'notifications', 'jobs', 'agents', 'keys', 'about']).map((sec) => ({ name: `prefs-${sec}`, js: `$('#ncenter').classList.remove('on'); openPrefs('${sec}')`, wait: 600 })),
      { name: 'light-theme', js: `closePrefs(); setTheme('light'); S.job = '${waiting && waiting.id}'; openApp('jobs')`, wait: 900 },
      { name: 'collapsed-sidebar', js: `setTheme('system'); toggleSidebar(); openApp('processes')` },
      { name: 'narrow-window', size: [820, 760], js: `toggleSidebar(); openApp('jobs')`, wait: 1200 },
    ];
    const stepsFile = path.join(work, 'steps.json');
    fs.writeFileSync(stepsFile, JSON.stringify(steps));
    const [w, h] = String(opt.size || '1600x1000').split('x').map(Number);
    const r = spawnSync('python3', [path.join(__dirname, 'ui-check-driver.py'), `http://127.0.0.1:${port}/__app?t=${T}`, stepsFile, out, String(w - 40), String(h - 40)],
      { env, encoding: 'utf8', timeout: 300000, maxBuffer: 16 << 20 });
    const results = (r.stdout || '').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
    if (!results.length) return { text: `The page driver produced no results.\n${(r.stderr || '').split('\n').filter((l) => !/Gtk-WARNING|gtk.css|^$/.test(l)).slice(-8).join('\n')}`, ok: false };
    const bad = results.filter((x) => x.problems.length);
    const lines = [`UI check: ${results.length} steps, ${bad.length ? `${bad.length} with problems` : 'no problems found'}. Screenshots: ${out}`];
    for (const x of bad) lines.push(`- ${x.step}: ${[...new Set(x.problems)].join('; ')}  (${path.basename(x.shot)})`);
    if (results.length < steps.length) lines.push(`- only ${results.length} of ${steps.length} steps ran (the driver stopped early)`);
    return { text: lines.join('\n'), ok: !bad.length && results.length === steps.length };
  } finally {
    for (const p of procs.reverse()) { try { process.kill(p.pid > 0 && p.spawnargs[0] === process.execPath ? -p.pid : p.pid, 'SIGTERM'); } catch {} }
    await sleep(800);
    spawnSync('pkill', ['-f', path.join(work, 'claude')]);
    if (!opt.keep) {
      if (!opt.out) { /* screenshots live inside the work folder; keep them, drop the copy of the office */ }
      fs.rmSync(office, { recursive: true, force: true });
    }
  }
}

async function run(argv) {
  const { opt } = parseArgs(argv);
  if (opt.help) return { text: 'usage: ui-check [--quick] [--out <dir>] [--size 1600x1000] [--keep]\n  Clicks through every app, the menus, Preferences and jobs in a throwaway copy and lists what is broken. About a minute; costs nothing.', ok: true };
  return check(opt);
}

module.exports = { run };
if (require.main === module) run(process.argv.slice(2)).then((r) => { process.stdout.write(r.text + '\n'); process.exit(r.ok ? 0 : 1); }, (e) => { process.stderr.write(`error: ${e.stack}\n`); process.exit(2); });
