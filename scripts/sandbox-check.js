#!/usr/bin/env node
'use strict';
// Development check (not an agent script): `npm run test:sandbox`. Runs a real sandboxed job in Docker on a throwaway
// office and checks what the container could and could not see. The office, project and a "private" folder live under
// ~/agentos-sandbox-check (snap Docker can only mount visible folders in the home directory); all of it is removed after.
// The agent is a stand-in `claude` in a small test image: inside the container it looks around, writes a file in the
// project through the office's edit hook, reports progress and runs a terminal command through the office's own tools,
// and answers with what it found. Nothing reaches Anthropic; nothing outside the check folder is touched.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BASE = path.join(os.homedir(), 'agentos-sandbox-check');
const IMAGE = 'agentos-sandbox-check:1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The stand-in agent, run inside the container. On a message that says SANDBOXPROBE it probes, then answers.
const FAKE = String.raw`#!/usr/bin/env node
const fs = require('fs'), os = require('os'), path = require('path'), { spawn, spawnSync } = require('child_process');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sid = 'sbx-' + process.pid;
const argv = process.argv.slice(2);
if (!argv.includes('--input-format')) { out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: sid, total_cost_usd: 0, num_turns: 1, usage: {} }); process.exit(0); }
out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5-5', cwd: process.cwd() });
const mcp = JSON.parse(argv[argv.indexOf('--mcp-config') + 1]).mcpServers.workplace;
const hook = JSON.parse(argv[argv.indexOf('--settings') + 1]).hooks.PreToolUse[0].hooks[0].command;
function mcpCall(name, args) {
  return new Promise((resolve) => {
    const c = spawn(mcp.command, mcp.args, { env: { ...process.env, ...mcp.env }, stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = '';
    c.stdout.on('data', (d) => { buf += d; for (const line of buf.split('\n').slice(0, -1)) { try { const m = JSON.parse(line); if (m.id === 2) { c.kill(); resolve(m.result || m.error); } } catch {} } buf = buf.split('\n').pop(); });
    c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } }) + '\n');
    c.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    setTimeout(() => { c.kill(); resolve({ error: 'timeout' }); }, 60000);
  });
}
let busy = false;
process.stdin.on('data', async (d) => {
  if (busy || !String(d).includes('SANDBOXPROBE')) return;
  busy = true;
  const marker = String(d).match(/OUTSIDE=(\S+?)(?:\\n|\s|")/);
  const file = path.join(process.cwd(), 'made-in-sandbox.txt');
  const h = spawnSync('sh', ['-c', hook], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file, content: 'x' } }), encoding: 'utf8' });
  fs.writeFileSync(file, 'written inside the container\n');
  const progress = await mcpCall('report_progress', { status: 'probe from inside the container' });
  const cmd = await mcpCall('run_command', { command: 'echo CMD-RAN; cat /etc/hostname; test -e ' + (marker ? marker[1] : '/nonexistent') + ' && echo SAW-OUTSIDE || echo NO-OUTSIDE', reason: 'sandbox check' });
  const report = { cwd: process.cwd(), uid: process.getuid(), hostname: os.hostname(), dockerenv: fs.existsSync('/.dockerenv'),
    sawOutside: marker ? fs.existsSync(marker[1]) : null, sawHostHome: fs.existsSync(path.join('${os.homedir()}', '.bashrc')), home: process.env.HOME,
    hookExit: h.status, hookOut: (h.stdout || '').slice(0, 200), progress, cmd: JSON.stringify(cmd).slice(0, 600), apiKeyByName: process.env.ANTHROPIC_API_KEY || null };
  out({ type: 'result', subtype: 'success', is_error: false, result: 'SANDBOX-REPORT ' + JSON.stringify(report), session_id: sid, total_cost_usd: 0, num_turns: 1, usage: {} });
  busy = false;
});
setInterval(() => {}, 1 << 30);
`;

const HOST_FAKE = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sid = 'host-' + process.pid;
if (!process.argv.includes('--input-format')) { if (process.argv.includes('--version')) { console.log('2.1.318 (Claude Code)'); process.exit(0); } out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: sid, total_cost_usd: 0, num_turns: 1, usage: {} }); process.exit(0); }
out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5-5', cwd: process.cwd() });
setInterval(() => {}, 1 << 30);
`;

function call(port, token, method, p, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'x-agentos-token': token, 'content-type': 'application/json', host: `127.0.0.1:${port}` } }, (res) => {
      let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} resolve({ code: res.statusCode, body: j }); });
    });
    req.on('error', () => resolve({ code: 0, body: null }));
    if (data) req.write(data);
    req.end();
  });
}
async function until(fn, ms) { for (let t = 0; t < ms; t += 500) { const v = await fn(); if (v) return v; await sleep(500); } return null; }

async function main() {
  const results = [];
  const ok = (name, pass, detail) => { results.push({ name, pass: !!pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `  (${String(detail).slice(0, 600)})`}`); };
  if (spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 20000 }).status !== 0) { console.log('Docker is not available: nothing to check.'); return 0; }
  fs.rmSync(BASE, { recursive: true, force: true });
  const office = path.join(BASE, 'office'), proj = path.join(BASE, 'proj'), outside = path.join(BASE, 'private');
  for (const d of [office, proj, outside, path.join(BASE, 'image')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'only on the computer');
  // The test image: Node and the stand-in claude, nothing else.
  fs.writeFileSync(path.join(BASE, 'image', 'claude'), FAKE, { mode: 0o755 });
  fs.writeFileSync(path.join(BASE, 'image', 'Dockerfile'), 'FROM node:22-bookworm-slim\nCOPY claude /usr/local/bin/claude\nRUN chmod 755 /usr/local/bin/claude && mkdir -p /home/agent && chmod 1777 /home/agent\nENV HOME=/home/agent\n');
  const b = spawnSync('docker', ['build', '-q', '-t', IMAGE, path.join(BASE, 'image')], { encoding: 'utf8', timeout: 600000 });
  if (b.status !== 0) { console.log(`Could not build the test image: ${b.stderr}`); return 1; }
  spawnSync('rsync', ['-a', '--exclude', '.git', '--exclude', 'data', '--exclude', 'node_modules', '--exclude', 'desktop', `${ROOT}/`, `${office}/`]);
  for (const f of ['roster.json', 'projects.json']) fs.rmSync(path.join(office, f), { force: true });
  fs.copyFileSync(path.join(office, 'roster.example.json'), path.join(office, 'roster.json'));
  const roster = JSON.parse(fs.readFileSync(path.join(office, 'roster.json'), 'utf8'));
  const lead = roster.residents.find((k) => k !== roster.root);
  fs.writeFileSync(path.join(office, 'projects.json'), JSON.stringify([{ name: 'Boxed', path: proj, department: lead, description: 'Sandbox check project', keywords: ['boxed'], sandbox: true }], null, 2));
  spawnSync('git', ['init', '-q', proj]);
  fs.writeFileSync(path.join(proj, 'README.md'), 'boxed\n');
  const hostClaude = path.join(BASE, 'host-claude');
  fs.writeFileSync(hostClaude, HOST_FAKE, { mode: 0o755 });
  const port = await new Promise((r) => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const proc = spawn(process.execPath, ['server.js'], { cwd: office, stdio: 'ignore', detached: true,
    env: { ...process.env, AGENTOS_TEST_PARENT: String(process.pid), WORKPLACE_PORT: String(port), CLAUDE_BIN: hostClaude, AGENTOS_SANDBOX_IMAGE: IMAGE, ANTHROPIC_API_KEY: 'sk-ant-sandbox-check-not-real',
      AGENTOS_CLAUDE_CREDENTIALS: path.join(BASE, 'no-credentials.json') } });
  const token = await until(async () => { try { return fs.readFileSync(path.join(office, 'data', 'app-token'), 'utf8').trim(); } catch { return null; } }, 20000);
  const A = (m, p, body) => call(port, token, m, p, body);
  try {
    await until(async () => (await A('GET', '/api/limits')).code === 200, 20000);
    const st = (await A('GET', '/api/sandbox')).body || {};
    ok('the office sees Docker and the sandbox image', st.docker && st.ready && st.image === IMAGE && st.projects.includes('Boxed'), JSON.stringify(st).slice(0, 300));
    await A('POST', '/api/terminal-mode', { mode: 'allow' });
    const job = (await A('POST', '/api/tasks', { text: `SANDBOXPROBE OUTSIDE=${path.join(outside, 'secret.txt')} please look around`, project: 'Boxed' })).body || {};
    const done = await until(async () => { const t = ((await A('GET', '/api/state')).body.tickets || []).find((x) => x.id === job.id); return t && t.status === 'done' && t; }, 180000);
    const ans = done && /SANDBOX-REPORT (\{.*\})/s.exec(done.answer || '');
    const r = ans ? JSON.parse(ans[1]) : {};
    const tk = done || ((await A('GET', '/api/state')).body.tickets || []).find((x) => x.id === job.id) || {};
    ok('a job on a sandboxed project goes to its own desk, which answers from inside a container', done && tk.twin === `${lead}~s${tk.n}` && r.dockerenv === true && r.cwd === proj, JSON.stringify({ status: tk.status, twin: tk.twin, r, thread: (tk.thread || []).slice(-3).map((e) => e.text) }));
    ok('inside, the project is there and everything else of the home folder is not', r.sawOutside === false && r.sawHostHome === false && r.home === '/home/agent', JSON.stringify(r));
    ok('the agent runs as the user, so its files on the computer belong to the user', r.uid === process.getuid() && fs.statSync(path.join(proj, 'made-in-sandbox.txt')).uid === process.getuid() && fs.readFileSync(path.join(proj, 'made-in-sandbox.txt'), 'utf8').includes('inside the container'), JSON.stringify({ uid: r.uid }));
    ok('the edit hook works from inside, so the change is tracked and can be undone', r.hookExit === 0 && (tk.changes || []).some((c) => c.path === path.join(proj, 'made-in-sandbox.txt')), JSON.stringify({ hookExit: r.hookExit, changes: tk.changes }));
    const ev = ((await A('GET', `/api/agents/${encodeURIComponent(tk.twin || '')}/events?limit=40`)).body || []).map((e) => e.text || '').join(' | ');
    ok('the office\'s tools work from inside: progress reached the office', /probe from inside the container/.test(ev), ev.slice(0, 400));
    ok('a terminal command for the job ran in its own container, which could not see the private folder either', /CMD-RAN/.test(r.cmd) && /NO-OUTSIDE/.test(r.cmd) && (tk.commands || []).some((c) => c.sandboxed), r.cmd);
    ok('the API key reached the container by name', r.apiKeyByName === 'sk-ant-sandbox-check-not-real', String(r.apiKeyByName));
    await A('POST', '/api/shutdown');
    const gone = await until(async () => !spawnSync('docker', ['ps', '-aq', '--filter', `label=agentos.port=${port}`], { encoding: 'utf8' }).stdout.trim(), 30000);
    ok('when the office stops, its containers are gone', gone, spawnSync('docker', ['ps', '-a', '--filter', `label=agentos.port=${port}`], { encoding: 'utf8' }).stdout);
  } finally {
    try { process.kill(-proc.pid, 'SIGTERM'); } catch {}
    const left = spawnSync('docker', ['ps', '-aq', '--filter', `label=agentos.port=${port}`], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
    if (left.length) spawnSync('docker', ['rm', '-f', ...left], { stdio: 'ignore' });
    await sleep(500);
    fs.rmSync(BASE, { recursive: true, force: true });
  }
  const bad = results.filter((x) => !x.pass);
  console.log(`\nSandbox check: ${results.length} checks, ${bad.length ? `${bad.length} failed` : 'all passed'}.`);
  return bad.length ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
