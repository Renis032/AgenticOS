#!/usr/bin/env node
'use strict';
// Development command (not an agent script): `./agentos demo` opens a throwaway office to look around in. It uses the
// example roster, made-up projects and a stand-in for `claude` that writes canned answers, so it needs no Claude account
// and spends nothing. Three jobs are seeded: one finished, one waiting for you to approve its plan, and one that a second
// Renko desk (a parallel lead) picks up because Renko is busy. A lesson from Renko waits for review on Today.
// Closing the window (or Ctrl-C) stops the demo and deletes its folder; your own office and data are never touched.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The stand-in for `claude`: speaks the same stream-json as the real CLI. A job that mentions "dark mode" waits until
// the demo releases it (after you approve its plan), so the window has a job that needs you.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sid = 'demo-' + process.pid;
const usage = { input_tokens: 1200, cache_read_input_tokens: 18000, cache_creation_input_tokens: 900, output_tokens: 420 };
// One-off calls (-p): "Ask the office" gets a canned answer that cites the demo's jobs; anything else gets "ok".
if (!(process.argv.includes('stream-json') && process.argv.includes('--input-format'))) {
  let p = '';
  process.stdin.on('data', (d) => { p += d; });
  process.stdin.on('end', () => {
    const asked = /Agentic OS office/.test(p);
    const result = asked ? 'In this demo office, **Renko** answered #1 (what changed in Recipe Box) and a second Renko desk wrote the release notes in #3. #2, the dark mode, is waiting for you to approve its plan ($1.80). *(Demo: no model was called.)*' : 'ok';
    out({ type: 'result', subtype: 'success', is_error: false, result, session_id: sid, total_cost_usd: 0, num_turns: 1, usage: {} });
    process.exit(0);
  });
  setTimeout(() => process.stdin.emit('end'), 2000);
} else {
out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5-5', cwd: process.cwd() });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (content) => out({ type: 'assistant', message: { id: 'msg_' + Date.now() + Math.random(), model: 'claude-opus-5-5', content, usage } });
const ANSWERS = [
  [/summari[sz]e|what changed/i, '**What changed in Recipe Box this week**\\n\\n- Search now matches ingredients as well as titles.\\n- The shopping list groups items by aisle.\\n- Two bugs fixed: duplicate tags on import, and a crash on empty recipes.\\n\\nNothing is waiting on you. *(Demo office: no model was called and nothing was spent.)*'],
  [/dark mode/i, '**Dark mode is in.** Recipe Box now follows the system theme, with a toggle in Settings.\\n\\n- Files: \`src/theme.css\`, \`src/settings.js\`, \`src/App.js\`\\n- Checked: both themes at phone and desktop width, contrast AA on every text colour.\\n\\n*(Demo office: no model was called and nothing was spent.)*'],
  [/release notes/i, '**Release notes for Recipe Box 1.4**\\n\\n- New: dark mode that follows your system.\\n- Better: ingredient search, aisle-grouped shopping list.\\n- Fixed: duplicate tags on import; crash on empty recipes.\\n\\n*(Demo office: no model was called and nothing was spent.)*'],
];
let queue = Promise.resolve(), buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    const text = typeof m.message?.content === 'string' ? m.message.content : JSON.stringify(m.message?.content || '');
    queue = queue.then(() => turn(text));
  }
});
async function turn(text) {
  await sleep(900);
  say([{ type: 'thinking', thinking: 'Reading the request and the project handoff before I start.' }]);
  await sleep(1100);
  const id = 'toolu_demo_' + Date.now();
  say([{ type: 'tool_use', id, name: 'Read', input: { file_path: '~/Projects/recipe-box/README.md', limit: 80 } }]);
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: '# Recipe Box\\nA small recipe manager (React + SQLite).' }] } });
  if (/dark mode/i.test(text) && process.env.AGENTOS_DEMO_DIR) {
    while (!fs.existsSync(path.join(process.env.AGENTOS_DEMO_DIR, 'release'))) await sleep(500);
  }
  await sleep(1200);
  const hit = ANSWERS.find(([re]) => re.test(text));
  const answer = hit ? hit[1] : 'Done. *(Demo office: no model was called and nothing was spent.)*';
  say([{ type: 'text', text: answer }]);
  out({ type: 'result', subtype: 'success', is_error: false, result: answer, session_id: sid, total_cost_usd: 0, num_turns: 3, duration_ms: 3200, usage });
}
setInterval(() => {}, 1 << 30);
}
`;

function call(port, token, method, p, body, timeout = 8000) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'x-agentos-token': token, 'content-type': 'application/json', host: `127.0.0.1:${port}` } }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve(s); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeout, () => { req.destroy(); resolve(null); });
    if (data) req.write(data);
    req.end();
  });
}

const freePort = () => new Promise((resolve) => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('usage: ./agentos demo [--no-window] [--keep]\n  A throwaway office with made-up projects and stand-in agents: no Claude account, nothing spent.\n' +
      '  --no-window  print a browser link instead of opening the window\n  --keep       keep the demo folder afterwards');
    return;
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-demo-'));
  const office = path.join(work, 'office');
  spawnSync('rsync', ['-a', '--exclude', '.git', '--exclude', 'node_modules', '--exclude', 'data', '--exclude', 'teams', '--exclude', 'backups',
    '--exclude', 'roster.json', '--exclude', 'projects.json', '--exclude', 'inbox/*', '--exclude', 'artifacts/*', `${ROOT}/`, `${office}/`]);
  for (const [name, readme] of [['recipe-box', '# Recipe Box\nA small recipe manager (React + SQLite).\n'], ['trail-log', '# Trail Log\nGPS hikes on a map, with elevation charts.\n']]) {
    fs.mkdirSync(path.join(work, 'Projects', name), { recursive: true });
    fs.writeFileSync(path.join(work, 'Projects', name, 'README.md'), readme);
  }
  fs.copyFileSync(path.join(office, 'roster.example.json'), path.join(office, 'roster.json'));
  fs.writeFileSync(path.join(office, 'projects.json'), JSON.stringify([
    { name: 'Recipe Box', path: path.join(work, 'Projects', 'recipe-box'), department: 'personal-lead', description: 'A small recipe manager (React + SQLite).', keywords: ['recipe', 'recipes'] },
    { name: 'Trail Log', path: path.join(work, 'Projects', 'trail-log'), department: 'personal-lead', description: 'GPS hikes on a map.', keywords: ['trail', 'hike'] },
  ], null, 2));
  const claude = path.join(work, 'claude');
  fs.writeFileSync(claude, FAKE_CLAUDE, { mode: 0o755 });

  const port = await freePort();
  const env = { ...process.env, AGENTOS_TEST_PARENT: String(process.pid), WORKPLACE_PORT: String(port), CLAUDE_BIN: claude, AGENTOS_DEMO_DIR: work };
  const server = spawn(process.execPath, ['server.js'], { cwd: office, env, stdio: 'ignore', detached: true });
  let window = null;
  // The server saves its state as it stops, so the folder is removed only once it has exited.
  const stop = async () => {
    try { if (window) window.kill('SIGTERM'); } catch {}
    const exited = new Promise((r) => { if (server.exitCode !== null || server.signalCode) r(); else { server.once('exit', r); setTimeout(r, 4000); } });
    try { process.kill(-server.pid, 'SIGTERM'); } catch {}
    spawnSync('pkill', ['-f', claude]);
    await exited;
    try { process.kill(-server.pid, 'SIGKILL'); } catch {}
    await sleep(300);
    if (!args.includes('--keep')) fs.rmSync(work, { recursive: true, force: true });
    else console.log(`Demo folder kept: ${work}`);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => stop().then(() => process.exit(130)));

  const token = () => { try { return fs.readFileSync(path.join(office, 'data', 'app-token'), 'utf8').trim(); } catch { return ''; } };
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { await sleep(250); up = !!(token() && await call(port, token(), 'GET', '/api/limits')); }
  if (!up) { console.error('The demo office did not start.'); await stop(); process.exit(1); }
  const T = token();
  console.log('Demo office is up (stand-in agents, nothing spent). Setting up three jobs…');

  await call(port, T, 'POST', '/api/tasks', { text: 'Summarise what changed in Recipe Box this week.', project: 'Recipe Box' });
  await sleep(6500);
  await call(port, T, 'POST', '/api/tasks', { text: 'Add a dark mode to Recipe Box that follows the system theme, with a toggle in Settings.', project: 'Recipe Box' });
  await call(port, T, 'POST', '/api/tasks', { text: 'Write the release notes for Recipe Box 1.4.', project: 'Recipe Box' });
  await sleep(3000);
  const plan = '1. Add theme variables for light and dark to `src/theme.css`.\n2. Follow the system theme with `prefers-color-scheme`, overridable in Settings.\n' +
    '3. Add the toggle to `src/settings.js` and remember the choice.\n4. Check both themes at phone and desktop width, and contrast on every text colour.';
  // A lesson waiting for review on Today, as if an earlier job had gone wrong.
  await call(port, T, 'POST', '/api/lessons', { agentId: 'personal-lead', text: 'Check layout changes at phone width before reporting them as done.' });
  // The plan call waits for your decision; once you approve (or reject) it, the stand-in finishes the dark-mode job.
  call(port, T, 'POST', '/api/propose-plan', { agentId: 'personal-lead', plan, estimateUsd: 1.8 }, 24 * 3600000).then(() => fs.writeFileSync(path.join(work, 'release'), ''));

  if (args.includes('--no-window') || spawnSync('python3', ['-c', "import gi; gi.require_version('WebKit2', '4.0')"]).status !== 0) {
    console.log(`Open the demo in a browser: http://127.0.0.1:${port}/__app?t=${T}\nCtrl-C stops it.`);
    await new Promise(() => {});
  }
  window = spawn('python3', [path.join(office, 'app', 'agentos-window.py')], { cwd: office, env: { ...env, AGENTOS_TEST_PARENT: '' }, stdio: 'ignore' });
  console.log('The demo window is open. Approve the plan on the dark-mode job to see it finish; the release notes went to a second Renko desk. Close the window (or Ctrl-C) to end the demo.');
  await new Promise((r) => window.on('exit', r));
  await stop();
}

main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
