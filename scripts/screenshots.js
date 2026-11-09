#!/usr/bin/env node
'use strict';
// Development command: regenerates the README screenshots in docs/screenshots/ from the demo office (made-up projects,
// stand-in agents, nothing spent), in the same WebKitGTK engine as the window, on a virtual screen.
// usage: node scripts/screenshots.js [--only name,name] [--out dir]      needs Xvfb and python3-gi with WebKit2 4.0
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const W = 1440, H = 900;
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const OUT = path.resolve(opt('--out') || path.join(ROOT, 'docs', 'screenshots'));
const only = opt('--only') ? new Set(opt('--only').split(',')) : null;

// Each shot: a name (the file) and the page code that sets it up. They run in order in one window.
const find = (re) => `Object.values(S.tickets).find((x) => ${re}.test(x.title))`;
const SHOTS = [
  { name: 'today', wait: 14000, js: "document.getElementById('toasts').style.display = 'none'; setPref('setupHidden', '1'); setPref('theme', 'dark'); setLook('champagne'); openApp('today')" },
  { name: 'job-plan', js: `const t = ${find('/dark mode/i')}; S.job = t.id; S.jtab = 'thread'; openApp('jobs')`, wait: 1500 },
  { name: 'job-checks', js: `const t = ${find('/Summarise/i')}; S.job = t.id; S.jtab = 'thread'; S.jbodyKey = null; openApp('jobs'); setTimeout(() => { const b = document.querySelector('#jbody'); b.scrollTop = b.scrollHeight; }, 400)`, wait: 1500 },
  { name: 'processes', js: "openApp('processes')", wait: 1200 },
  { name: 'brain', js: "openApp('brain'); ACT.brainTab({ tab: 'knowledge' })", wait: 4500 },
  { name: 'projects', js: "openApp('projects'); setTimeout(() => { const e = document.querySelector('.page'); if (e) e.scrollTop = 0; }, 900)", wait: 2200 },
  { name: 'usage', js: "openApp('usage'); setTimeout(() => { const e = document.querySelector('.ostats'); if (e) e.closest('.card').scrollIntoView(); }, 2000)", wait: 2800 },
  { name: 'talk-lead', wait: 1500, js: `const k = leads()[0], at = Date.now(), p = who(k); S.chatTeam = k; S.talk = { [k]: { list: [
    { id: 'a', from: 'user', t: at - 240000, text: 'Is anything of yours stuck, and can you add a job to tidy the release notes?' },
    { id: 'b', from: 'agent', t: at - 200000, text: 'Nothing is stuck: one plan is waiting for your approval and everything else has finished. Here is a draft for the release notes job to confirm.', actions: [{ id: 'x', type: 'create', status: 'pending', text: 'Tidy the release notes for the next version: group the changes by feature, remove duplicates and link each entry to its job.' }] }] } }; S.chatMode = 'talk'; S.chatKey = null; openApp('messages')` },
  { name: 'new-job', wait: 1500, js: "openApp('newjob'); setTimeout(() => { $('#njText').value = 'Fix the failing date tests on the recipe app and add one for leap years.'; $('#njPriority').value = 'urgent'; }, 400)" },
  { name: 'job-timeline', wait: 2500, js: `const t = ${find('/Summarise/i')}; S.job = t.id; S.jtab = 'timeline'; S.jbodyKey = null; openApp('jobs')` },
  { name: 'overnight', wait: 2500, js: "Promise.all(['Upgrade the recipe app to the new router and fix what breaks', 'Add offline support to the trail log'].map((text) => api('POST', '/api/tasks', { text, project: 'Recipe Box', overnight: true }))).then(() => setTimeout(() => openApp('overnight'), 600))" },
  { name: 'reliability', wait: 2000, js: `const at = Date.now(); S.ops = { breaker: { state: 'closed', recentFailures: 0, why: null }, maxLeadJobs: 4, retrieval: { engine: 'hybrid', embedded: 412 }, audit: { ok: true, entries: 38, recent: [
    { actor: 'user', action: 'lead-chat.job-created', job: 41, detail: 'Tidy the release notes for the next version', t: at - 120000 },
    { actor: 'user', action: 'command.approved', job: 40, detail: 'npm test', t: at - 900000 },
    { actor: 'office', action: 'plan.approved', job: 39, detail: 'auto-approved under the plan limit', t: at - 3600000 },
    { actor: 'user', action: 'edit-access.allowed', job: 38, detail: '~/projects/recipe-box/docs', t: at - 7200000 }] } }; S.opsAt = at + 600000; S.hKey = null; openApp('health'); setTimeout(() => { const c = document.querySelector('#hBody .cards'); if (c) c.style.display = 'none'; }, 700)` },
  { name: 'lead-wizard', js: "setLook('graphite'); openApp('settings'); setTimeout(() => { $('#lw_purpose').value = 'Look after my home server: the Docker containers, nightly backups and the Raspberry Pi. Keep things running, explain what changed, and never expose a service to the internet.'; $('#lw_persona').value = 'Hale'; $('#lw_room').value = 'Homelab'; ACT.lwDraft({}); setTimeout(() => { const e = document.querySelector('.lwiz'); if (e) e.scrollIntoView(); }, 2500); }, 1500)", wait: 5500 },
  { name: 'jobs-light', js: `S.lw = null; S.cfg = null; setLook('champagne'); setTheme('light'); const t = ${find('/release notes/i')}; S.job = t.id; S.jtab = 'thread'; openApp('jobs')`, wait: 1500 },
];

function main() {
  for (const bin of ['Xvfb', 'python3']) if (spawnSync('which', [bin]).status !== 0) { console.error(`${bin} is needed.`); process.exit(1); }
  const shots = SHOTS.filter((s) => !only || only.has(s.name));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-shots-'));
  const demo = spawn(process.execPath, [path.join(__dirname, 'demo.js'), '--no-window'], { env: { ...process.env, AGENTOS_DEMO_COST: '0.37' }, stdio: ['ignore', 'pipe', 'inherit'] });
  let buf = '', started = false;
  const done = (code) => { try { demo.kill('SIGTERM'); } catch {} setTimeout(() => { fs.rmSync(tmp, { recursive: true, force: true }); process.exit(code); }, 1500); };
  demo.stdout.on('data', (d) => {
    buf += d;
    const m = buf.match(/(http:\/\/127\.0\.0\.1:\d+\/__app\?t=\w+)/);
    if (!m || started) return;
    started = true;
    let display = 90;
    while (fs.existsSync(`/tmp/.X11-unix/X${display}`)) display++;
    const x = spawn('Xvfb', [`:${display}`, '-screen', '0', `${W + 40}x${H + 40}x24`], { stdio: 'ignore' });
    setTimeout(() => {
      const steps = path.join(tmp, 'steps.json');
      fs.writeFileSync(steps, JSON.stringify(shots));
      const r = spawnSync('python3', [path.join(__dirname, 'ui-check-driver.py'), m[1], steps, tmp, String(W), String(H)],
        { env: { ...process.env, DISPLAY: `:${display}` }, encoding: 'utf8', timeout: 300000 });
      x.kill();
      let bad = 0;
      fs.mkdirSync(OUT, { recursive: true });
      for (const l of (r.stdout || '').split('\n').filter((s) => s.startsWith('{'))) {
        const j = JSON.parse(l);
        if (j.problems.length) { bad++; console.log(`✕ ${j.step}: ${j.problems.join('; ')}`); continue; }
        fs.copyFileSync(j.shot, path.join(OUT, `${j.step}.png`));
        console.log(`✓ ${path.relative(ROOT, path.join(OUT, j.step + '.png'))}`);
      }
      if (!r.stdout) console.error((r.stderr || '').slice(-1500));
      done(bad || !r.stdout ? 1 : 0);
    }, 800);
  });
  demo.on('exit', () => { if (!started) { console.error('The demo office did not start.'); process.exit(1); } });
}

main();
