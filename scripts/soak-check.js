#!/usr/bin/env node
'use strict';
// Development check (not an agent script): `npm run test:soak [rounds]`. Looks for memory leaks: a throwaway office
// (stand-in agents, nothing spent) works through round after round of jobs, live-update connections that open and
// close, and the heavy views (state, brain, changes, reports, hardware, projects), then deletes the jobs. After each
// round the server collects garbage and reports what it still holds. With nothing kept between rounds, the heap,
// open handles and live connections must level off; steady growth round after round is a leak.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ROUNDS = Math.max(4, Number(process.argv[2]) || 8);
const JOBS = 40;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// SOAK_SNAPSHOTS=1: heap snapshots halfway through and after the last round, compared by what grew (for finding a leak).
const SNAP = process.env.SOAK_SNAPSHOTS === '1';

// Objects in a V8 heap snapshot, counted and sized by constructor name (and by string text for strings).
function heapByType(file) {
  const h = JSON.parse(fs.readFileSync(file, 'utf8'));
  const f = h.snapshot.meta.node_fields, types = h.snapshot.meta.node_types[0];
  const iT = f.indexOf('type'), iN = f.indexOf('name'), iS = f.indexOf('self_size'), n = f.length;
  const out = new Map();
  for (let i = 0; i < h.nodes.length; i += n) {
    const type = types[h.nodes[i + iT]];
    if (type === 'hidden' || type === 'code' || type === 'synthetic') continue;
    const name = h.strings[h.nodes[i + iN]];
    const key = type === 'string' || type === 'concatenated string' || type === 'sliced string' ? `string: ${String(name).slice(0, 70).replace(/\s+/g, ' ')}` : `${type}: ${name}`;
    const e = out.get(key) || { n: 0, bytes: 0 };
    e.n++; e.bytes += h.nodes[i + iS];
    out.set(key, e);
  }
  return out;
}

// A stand-in agent that answers every message at once, and writes a file on the way (so jobs have changes).
const FAKE = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sid = 'soak-' + process.pid;
if (!process.argv.includes('--input-format')) { out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: sid, total_cost_usd: 0, num_turns: 1, usage: {} }); process.exit(0); }
out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5-5', cwd: process.cwd() });
let n = 0;
process.stdin.on('data', (d) => {
  for (const line of String(d).split('\\n')) {
    if (!line.trim()) continue;
    n++;
    out({ type: 'assistant', message: { id: 'm' + n, model: 'claude-opus-5-5', content: [{ type: 'text', text: 'working on it ' + 'x'.repeat(2000) }], usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 50 } } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'Done. ' + 'Here is the answer. '.repeat(40), session_id: sid, total_cost_usd: 0.001 * n, num_turns: 1, usage: { input_tokens: 10, output_tokens: 50 } });
  }
});
setInterval(() => {}, 1 << 30);
`;

function call(port, token, method, p, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'x-agentos-token': token, 'content-type': 'application/json', host: `127.0.0.1:${port}` } }, (res) => {
      let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} resolve({ code: res.statusCode, body: j }); });
    });
    req.on('error', () => resolve({ code: 0, body: null }));
    req.setTimeout(60000, () => { req.destroy(); resolve({ code: 0, body: null }); });
    if (data) req.write(data);
    req.end();
  });
}
// A live-update connection, closed again after a moment.
function stream(port, token, ms) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/stream', headers: { 'x-agentos-token': token, host: `127.0.0.1:${port}` } }, (res) => { res.on('data', () => {}); setTimeout(() => { req.destroy(); resolve(); }, ms); });
    req.on('error', () => resolve());
  });
}
async function until(fn, ms) { for (let t = 0; t < ms; t += 300) { const v = await fn(); if (v) return v; await sleep(300); } return null; }

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-soak-'));
  const office = path.join(work, 'office'), proj = path.join(work, 'proj');
  spawnSync('rsync', ['-a', '--exclude', '.git', '--exclude', 'data', '--exclude', 'node_modules', '--exclude', 'desktop', '--exclude', 'teams', '--exclude', 'roster.json', '--exclude', 'projects.json', `${ROOT}/`, `${office}/`]);
  fs.copyFileSync(path.join(office, 'roster.example.json'), path.join(office, 'roster.json'));
  const roster = JSON.parse(fs.readFileSync(path.join(office, 'roster.json'), 'utf8'));
  const lead = roster.residents.find((k) => k !== roster.root);
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(office, 'projects.json'), JSON.stringify([{ name: 'Soak', path: proj, department: lead, description: 'soak', keywords: ['soak'] }], null, 2));
  const claude = path.join(work, 'claude');
  fs.writeFileSync(claude, FAKE, { mode: 0o755 });
  const port = await new Promise((r) => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const proc = spawn(process.execPath, ['--expose-gc', 'server.js'], { cwd: office, stdio: ['ignore', 'ignore', fs.openSync(path.join(work, 'server.log'), 'a')], detached: true,
    env: { ...process.env, AGENTOS_TEST_PARENT: String(process.pid), WORKPLACE_PORT: String(port), CLAUDE_BIN: claude, AGENTOS_SANDBOX_NO_CLEANUP: '1', ...(process.env.SOAK_EVENTS ? { AGENTOS_EVENTS_IN_MEMORY: process.env.SOAK_EVENTS } : {}) } });
  const token = await until(async () => { try { return fs.readFileSync(path.join(office, 'data', 'app-token'), 'utf8').trim(); } catch { return null; } }, 20000);
  const A = (m, p, b) => call(port, token, m, p, b);
  const rows = [];
  const snaps = [];
  let failed = false;
  try {
    await until(async () => (await A('GET', '/api/limits')).code === 200, 20000);
    await A('POST', '/api/office-settings', { reviewAnswers: 0 });
    for (let round = 1; round <= ROUNDS; round++) {
      const t0 = Date.now();
      const ids = [];
      for (let i = 0; i < JOBS; i++) {
        const j = (await A('POST', '/api/tasks', { text: `Soak job ${round}.${i}: tidy something in the soak project`, project: 'Soak' })).body || {};
        if (j.id) ids.push(j.id);
      }
      await until(async () => { const s = (await A('GET', '/api/state')).body || {}; return ids.every((id) => (s.tickets || []).some((t) => t.id === id && ['done', 'failed'].includes(t.status))); }, 120000);
      await Promise.all(Array.from({ length: 25 }, () => stream(port, token, 300)));
      for (const p of ['/api/state', '/api/brain/knowledge?fresh=1', '/api/brain/findings', '/api/brain/flow?days=30', '/api/reports?days=7', '/api/reports?days=7&format=html', '/api/hardware', '/api/projects-board', '/api/health']) await A('GET', p);
      for (const id of ids.slice(0, 10)) { await A('GET', `/api/tickets/${id}/changes`); await A('GET', `/api/hardware/job/${id}`); }
      for (const id of ids) await A('DELETE', `/api/tickets/${id}`);
      await sleep(1500);
      const snapNow = SNAP && (round === Math.max(4, Math.floor(ROUNDS / 2)) || round === ROUNDS);
      const m = (await A('GET', `/api/health/memory?gc=1${snapNow ? '&snapshot=1' : ''}`)).body || {};
      if (m.snapshot) snaps.push(m.snapshot);
      rows.push({ round, ...m, secs: Math.round((Date.now() - t0) / 1000) });
      console.log(`round ${String(round).padStart(2)}: heap ${String(m.heapMb).padStart(6)} MB · rss ${String(m.rssMb).padStart(4)} MB · handles ${String(m.handles).padStart(3)} · live connections ${m.clients} · jobs ${m.tickets} · agents ${m.agents} · ${Math.round((Date.now() - t0) / 1000)} s`);
    }
  } finally {
    try { process.kill(-proc.pid, 'SIGTERM'); } catch {}
    await sleep(600);
    spawnSync('pkill', ['-f', claude]);
  }
  // The first two rounds warm caches and the JIT; after that, a leak shows as steady growth.
  const tail = rows.slice(2);
  const growth = tail.length > 1 ? (tail[tail.length - 1].heapMb - tail[0].heapMb) / (tail.length - 1) : 0;
  const handles = tail.map((r) => r.handles);
  const checks = [
    ['the heap levels off once the jobs are gone (under 1 MB more per round)', growth < 1, `${growth.toFixed(2)} MB per round after warm-up`],
    ['open handles do not pile up', Math.max(...handles) - Math.min(...handles) <= 6, handles.join(', ')],
    ['closed live-update connections are let go', tail.every((r) => r.clients === 0), tail.map((r) => r.clients).join(', ')],
    ['deleted jobs are gone from memory', tail.every((r) => r.tickets <= 2), tail.map((r) => r.tickets).join(', ')],
  ];
  console.log('');
  for (const [name, ok, detail] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`); if (!ok) failed = true; }
  if (snaps.length === 2) {
    const a = heapByType(snaps[0]), b = heapByType(snaps[1]);
    const grew = [...b].map(([k, v]) => ({ k, n: v.n - ((a.get(k) || {}).n || 0), bytes: v.bytes - ((a.get(k) || {}).bytes || 0) })).filter((x) => x.bytes > 0).sort((x, y) => y.bytes - x.bytes);
    console.log(`\nWhat grew between round ${Math.max(4, Math.floor(ROUNDS / 2))} and round ${ROUNDS} (by type):`);
    for (const x of grew.slice(0, 25)) console.log(`${String(Math.round(x.bytes / 1024)).padStart(7)} KB  +${String(x.n).padStart(6)}  ${x.k}`);
    console.log(`Snapshots: ${snaps.join(' ')}`);
    failed = true; // keep the folder with the snapshots
  }
  if (failed) console.log(`\nThe office's log: ${path.join(work, 'server.log')}`);
  else fs.rmSync(work, { recursive: true, force: true });
  return failed ? 1 : 0;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
