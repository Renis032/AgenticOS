#!/usr/bin/env node
'use strict';
// Development command (not an agent script): `./agentos setup`, the first-run wizard. Checks what Agentic OS needs,
// creates roster.json from the example, and builds projects.json from your answers instead of hand-editing JSON.
// `--yes` takes every default without asking. Existing files are kept unless you choose to replace them.
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HOME = os.homedir();
const tilde = (p) => (p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p);
const expand = (p) => (p.startsWith('~') ? path.join(HOME, p.slice(1)) : path.resolve(p));
const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const bad = (s, fix) => console.log(`  \x1b[31m✗\x1b[0m ${s}${fix ? `\n      ${fix}` : ''}`);
const opt = (s) => console.log(`  \x1b[33m–\x1b[0m ${s}`);

function checks() {
  console.log('\nWhat Agentic OS needs:');
  const [major] = process.versions.node.split('.').map(Number);
  if (major >= 18) ok(`Node.js ${process.versions.node}`); else bad(`Node.js ${process.versions.node} is too old`, 'Install Node.js 18 or newer.');
  const claude = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (claude.status === 0) ok(`Claude Code ${claude.stdout.trim()}`);
  else bad('Claude Code (`claude`) is not on your PATH', 'Install it from https://claude.com/claude-code and log in once with `claude`.');
  const gi = spawnSync('python3', ['-c', "import gi; gi.require_version('WebKit2', '4.0')"]);
  if (gi.status === 0) ok('The window (python3-gi, WebKitGTK)');
  else bad('The window needs python3-gi and WebKitGTK', 'sudo apt install python3-gi gir1.2-webkit2-4.0');
  if (spawnSync('which', ['Xvfb']).status === 0) ok('Xvfb, for `npm run test:ui` (optional)'); else opt('Xvfb is missing: only needed for `npm run test:ui` (sudo apt install xvfb)');
  if (spawnSync('which', ['rsync']).status === 0) ok('rsync, for the checks and the demo'); else opt('rsync is missing: needed for `npm test` and `./agentos demo` (sudo apt install rsync)');
  return claude.status === 0;
}

async function main() {
  const yes = process.argv.includes('--yes') || !process.stdin.isTTY;
  const rl = yes ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, def) => {
    if (yes) return def;
    const a = (await new Promise((r) => rl.question(`${q}${def !== undefined && def !== '' ? ` [${def}]` : ''} `, r))).trim();
    return a || def;
  };
  const yesNo = async (q, def) => /^y/i.test(await ask(`${q} (y/n)`, def ? 'y' : 'n'));

  console.log('\x1b[1mAgentic OS setup\x1b[0m');
  checks();

  console.log('\nYour team:');
  const roster = path.join(ROOT, 'roster.json');
  if (fs.existsSync(roster)) ok('roster.json already exists; keeping it (edit teams and roles later in the window: ⚙ Teams & roles).');
  else { fs.copyFileSync(path.join(ROOT, 'roster.example.json'), roster); ok('Created roster.json: God (the dispatcher) and Renko (your personal projects lead).'); }

  console.log('\nYour projects:');
  const projectsFile = path.join(ROOT, 'projects.json');
  if (fs.existsSync(projectsFile) && !(await yesNo('projects.json already exists. Replace it?', false))) {
    ok('Keeping your projects.json.');
  } else {
    const guesses = ['~/Personal/Projects', '~/Projects', '~/projects', '~/code', '~/src', '~/dev'].filter((d) => fs.existsSync(expand(d)));
    const folder = await ask('Where do your projects live? Each subfolder becomes a project.', guesses[0] || '~/Projects');
    const abs = expand(folder);
    if (!fs.existsSync(abs)) { fs.mkdirSync(abs, { recursive: true }); ok(`Created ${tilde(abs)}`); }
    const subs = fs.readdirSync(abs, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);
    const projects = [
      { name: 'Agent workplace', path: tilde(ROOT), department: 'personal-lead', description: 'This multi-agent office itself.', keywords: ['agent-workplace', 'agentic os', 'the office'] },
      { name: 'Personal projects', path: tilde(abs), department: 'personal-lead', description: `Everything in ${tilde(abs)} (each subfolder is a project).`, keywordsFromSubfolders: true, keywords: ['personal project', 'side project'] },
    ];
    fs.writeFileSync(projectsFile, JSON.stringify(projects, null, 2) + '\n');
    ok(`projects.json: ${tilde(abs)}${subs.length ? ` (${subs.length} projects: ${subs.slice(0, 6).join(', ')}${subs.length > 6 ? ', …' : ''})` : ''}. Jobs that name one go straight to Renko.`);
  }

  console.log('\nOn this computer:');
  const desktop = path.join(HOME, '.local', 'share', 'applications', 'agentos.desktop');
  if (fs.existsSync(desktop)) ok('Already in your applications menu.');
  else if (await yesNo('Add Agentic OS to your applications menu?', true)) { spawnSync(path.join(ROOT, 'agentos'), ['install'], { stdio: 'inherit' }); }
  const auto = path.join(HOME, '.config', 'autostart', 'agentos.desktop');
  if (!fs.existsSync(auto) && await yesNo('Start it at login, in the tray?', false)) spawnSync(path.join(ROOT, 'agentos'), ['autostart', 'on'], { stdio: 'inherit' });

  if (rl) rl.close();
  console.log(`\nDone. Next:\n  ./agentos          open the office\n  ./agentos demo     look around a throwaway office first (nothing spent)\n  docs/agents.md     how jobs, plans and teams work`);
}

main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
