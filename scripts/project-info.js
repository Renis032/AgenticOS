#!/usr/bin/env node
'use strict';
// What a project is and how to build, test and run it, worked out from its files, plus commands that already worked here.
const { parseArgs, home, cli, fs, path, SKIP_DIRS } = require('./_util');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const exists = (d, f) => fs.existsSync(path.join(d, f));
const read = (d, f, n) => { try { return fs.readFileSync(path.join(d, f), 'utf8').slice(0, n || 200000); } catch { return ''; } };

function languages(dir) {
  const count = {};
  let files = 0;
  const walk = (d, depth) => {
    if (depth > 6 || files > 20000) return;
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (e.name.startsWith('.') || SKIP_DIRS.includes(e.name) || ['venv', '.venv', 'node_modules', 'checkpoints'].includes(e.name)) continue;
      if (e.isDirectory()) walk(path.join(d, e.name), depth + 1);
      else { files++; const x = path.extname(e.name).toLowerCase() || e.name; count[x] = (count[x] || 0) + 1; }
    }
  };
  walk(dir, 0);
  return { files, top: Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 8) };
}

function commands(dir) {
  const out = [];
  const py = exists(dir, '.venv/bin/python') ? '.venv/bin/python' : exists(dir, 'venv/bin/python') ? 'venv/bin/python' : 'python3';
  const pkg = read(dir, 'package.json');
  if (pkg) {
    try {
      const j = JSON.parse(pkg);
      const pm = exists(dir, 'pnpm-lock.yaml') ? 'pnpm' : exists(dir, 'yarn.lock') ? 'yarn' : 'npm';
      out.push(['install', `${pm} install`]);
      for (const [k, v] of Object.entries(j.scripts || {})) out.push([['test', 'build', 'start', 'dev', 'lint'].includes(k) ? k : `script ${k}`, `${pm} run ${k}   # ${v}`]);
    } catch {}
  }
  for (const req of ['requirements.txt', 'requirements-dev.txt']) if (exists(dir, req)) out.push(['install', `${py} -m pip install -r ${req}`]);
  const pyproject = read(dir, 'pyproject.toml');
  if (pyproject && /\[project\]|\[tool\.poetry\]/.test(pyproject)) out.push(['install', exists(dir, 'poetry.lock') ? 'poetry install' : `${py} -m pip install -e .`]);
  if (exists(dir, 'run_tests.py')) out.push(['test', `${py} run_tests.py`]);
  else if (/pytest/.test(pyproject + read(dir, 'requirements-dev.txt') + read(dir, 'setup.cfg')) || exists(dir, 'pytest.ini') || exists(dir, 'conftest.py')) out.push(['test', `${py} -m pytest -q`]);
  else if (exists(dir, 'tests') && fs.readdirSync(path.join(dir, 'tests')).some((f) => /^test.*\.py$/.test(f))) out.push(['test', `${py} -m unittest discover -s tests`]);
  for (const f of ['main.py', 'run.py', 'app.py', 'manage.py']) if (exists(dir, f)) out.push(['run', `${py} ${f}`]);
  for (const d of fs.readdirSync(dir)) if (exists(dir, path.join(d, '__main__.py'))) out.push(['run', `${py} -m ${d}`]);
  const mk = read(dir, 'Makefile');
  if (mk) for (const m of mk.matchAll(/^([a-zA-Z][\w-]*):(?!=)/gm)) if (!['all', 'clean'].includes(m[1]) || out.length < 3) out.push([['test', 'build', 'run'].includes(m[1]) ? m[1] : `make ${m[1]}`, `make ${m[1]}`]);
  if (exists(dir, 'CMakeLists.txt')) out.push(['build', 'cmake -S . -B build && cmake --build build -j'], ['test', 'ctest --test-dir build --output-on-failure']);
  if (exists(dir, 'gradlew')) out.push(['build', './gradlew build'], ['test', './gradlew test']);
  else if (exists(dir, 'pom.xml')) out.push(['build', 'mvn -q package'], ['test', 'mvn -q test']);
  if (exists(dir, 'Cargo.toml')) out.push(['build', 'cargo build'], ['test', 'cargo test']);
  if (exists(dir, 'go.mod')) out.push(['build', 'go build ./...'], ['test', 'go test ./...']);
  if (exists(dir, 'docker-compose.yml') || exists(dir, 'compose.yaml')) out.push(['run', 'docker compose up --build']);
  else if (exists(dir, 'Dockerfile')) out.push(['build', `docker build -t ${path.basename(dir).toLowerCase()} .`]);
  for (const sub of ['backend', 'frontend', 'server', 'client', 'app', 'web']) {
    if (fs.existsSync(path.join(dir, sub)) && fs.statSync(path.join(dir, sub)).isDirectory()) for (const [k, c] of commands(path.join(dir, sub))) out.push([`${sub}: ${k}`, `cd ${sub} && ${c}`]);
  }
  return out;
}

// Commands that worked before in this project, from jobs' run_command history.
function knownCommands(dir) {
  let tickets = [];
  try { const t = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tickets.json'), 'utf8')); tickets = Array.isArray(t) ? t : Object.values(t.tickets || t); } catch {}
  const seen = new Map();
  for (const t of tickets) for (const c of t.commands || []) {
    if (c.status !== 'done' || !c.cwd || !(c.cwd === dir || c.cwd.startsWith(dir + path.sep) || c.command.includes(dir) || c.command.includes(dir.replace(require('os').homedir(), '~')))) continue;
    seen.set(`${c.cwd}|${c.command.replace(/\d+/g, "#")}`, { ...c, ticket: t.n });
  }
  return [...seen.values()].sort((a, b) => b.at - a.at).slice(0, 12);
}

function run(argv, { cwd }) {
  const { pos } = parseArgs(argv);
  const dir = path.resolve(cwd, home(pos[0] || '.'));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return `Not a folder: ${dir}`;
  const out = [`== ${path.basename(dir)}  (${dir})`];
  const readme = ['README.md', 'readme.md', 'README.rst', 'README.txt', 'README'].find((f) => exists(dir, f));
  if (readme) {
    const para = read(dir, readme, 4000).split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !/^(#|!\[|<|\[!\[|```)/.test(p));
    if (para) out.push(para.replace(/\s+/g, ' ').slice(0, 400));
  }
  const L = languages(dir);
  out.push('', `Files: ${L.files} (${L.top.map(([x, n]) => `${x} ${n}`).join(', ')})`);
  const top = fs.readdirSync(dir).filter((f) => !f.startsWith('.') && !SKIP_DIRS.includes(f)).slice(0, 40);
  out.push(`Top level: ${top.map((f) => (fs.statSync(path.join(dir, f)).isDirectory() ? f + '/' : f)).join('  ')}`);
  const cmds = commands(dir);
  out.push('', 'How to work with it (detected from its files; check before relying on it):', ...(cmds.length ? cmds.map(([k, c]) => `  ${k.padEnd(18)} ${c}`) : ['  nothing detected']));
  const known = knownCommands(dir);
  if (known.length) out.push('', 'Commands that worked in earlier jobs:', ...known.map((c) => `  #${c.ticket}  ${c.cwd.replace(require('os').homedir(), '~')}$ ${c.command.replace(/\s+/g, ' ').slice(0, 160)}`));
  const g = spawnSync('git', ['-C', dir, 'log', '-1', '--format=%h %cr: %s'], { encoding: 'utf8' });
  if (g.status === 0) {
    const st = spawnSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });
    const br = spawnSync('git', ['-C', dir, 'branch', '--show-current'], { encoding: 'utf8' });
    out.push('', `Git: ${br.stdout.trim() || '(detached)'} · last commit ${g.stdout.trim()} · ${(st.stdout || '').split('\n').filter(Boolean).length} uncommitted changes`);
  }
  const handoff = path.join(ROOT, 'teams', 'personal', 'projects', `${path.basename(dir)}.md`);
  if (fs.existsSync(handoff)) out.push(`Handoff: ${handoff} (updated ${new Date(fs.statSync(handoff).mtimeMs).toISOString().slice(0, 10)})`);
  return out.join('\n');
}

module.exports = { run, commands, knownCommands };
if (require.main === module) cli(run);
