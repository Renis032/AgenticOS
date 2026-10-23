#!/usr/bin/env node
'use strict';
const os = require('os');
const { workArea } = require('../lib/work-area');
const { spawnSync } = require('child_process');
const { parseArgs, cli, fs, path } = require('./_util');

const HOME = os.homedir();
const ROOT = path.join(__dirname, '..');
const CLAUDE_MD = path.join(HOME, '.claude', 'CLAUDE.md');
const DEPTS = path.join(HOME, '.claude', 'departments');
const OUT = path.join(ROOT, 'data', 'arms', 'proposals', 'memory-map');
const IMG = /\.(png|jpe?g|webp|gif)$/i;
const SKIP = ['node_modules', '.git', 'build', 'dist', 'venv', '.venv', 'target', '__pycache__', '.cache', 'out'];

function describe(dir) {
  for (const f of ['README.md', 'readme.md', 'README']) {
    try {
      const line = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#') && !l.startsWith('!') && !l.startsWith('<') && !l.startsWith('['));
      if (line) return line.replace(/\*\*/g, '').slice(0, 140);
    } catch {}
  }
  try { const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); if (p.description) return p.description.slice(0, 140); } catch {}
  try { const x = fs.readFileSync(path.join(dir, 'pom.xml'), 'utf8'); const d = (x.match(/<description>([^<]+)<\/description>/) || [])[1]; if (d) return d.trim().slice(0, 140); } catch {}
  const kinds = [];
  if (fs.existsSync(path.join(dir, 'pom.xml')) || fs.existsSync(path.join(dir, 'build.gradle'))) kinds.push('Java');
  if (fs.existsSync(path.join(dir, 'package.json'))) kinds.push('Node/JS');
  if (fs.existsSync(path.join(dir, 'requirements.txt')) || fs.existsSync(path.join(dir, 'pyproject.toml'))) kinds.push('Python');
  return kinds.length ? `${kinds.join(' + ')} project (no README description yet)` : '(no description yet)';
}

function imagesWithoutCaptions(root) {
  const prune = ['(', ...SKIP.flatMap((d, i) => (i ? ['-o', '-name', d] : ['-name', d])), ')', '-prune', '-o'];
  const r = spawnSync('find', [root, ...prune, '-type', 'f', '-print'], { encoding: 'utf8', maxBuffer: 256 << 20 });
  const byDir = {};
  for (const f of (r.stdout || '').split('\n')) {
    if (!IMG.test(f)) continue;
    const d = path.dirname(f);
    if (!byDir[d]) {
      let cap = '';
      try { cap = fs.readFileSync(path.join(d, 'CAPTIONS.md'), 'utf8'); } catch {}
      byDir[d] = { dir: d, images: 0, uncaptioned: 0, cap };
    }
    byDir[d].images++;
    if (!byDir[d].cap.includes(path.basename(f))) byDir[d].uncaptioned++;
  }
  const dirs = Object.values(byDir).map(({ cap, ...x }) => x).filter((x) => x.uncaptioned).sort((a, b) => b.uncaptioned - a.uncaptioned);
  return { total: dirs.reduce((s, x) => s + x.uncaptioned, 0), dirs };
}

function proposal() {
  const current = fs.readFileSync(CLAUDE_MD, 'utf8');
  const W = workArea(ROOT);
  const cut = W.heading ? current.search(new RegExp(`^${W.heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm')) : -1;
  const globalRules = (cut > 0 ? current.slice(0, cut) : current).replace(/\n-{3,}\s*$/, '').trimEnd();
  const workNotes = cut > 0 ? current.slice(cut).trim() : '';
  const projects = path.join(HOME, 'Personal', 'Projects');
  let rows = [];
  try { rows = fs.readdirSync(projects, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => `| \`${d.name}\` | ${describe(path.join(projects, d.name)).replace(/\|/g, '/')} |`); } catch {}
  const files = {};
  if (workNotes) files[`departments/${path.basename(W.router)}`] = `# ${W.label} — router\n\nRead this before any work in \`${W.tilde(W.repo || '')}\`. Moved here word for word from the top-level CLAUDE.md so it is only loaded when ${W.name} work needs it.\n\n${workNotes}\n`;
  files['departments/personal.md'] = `# Personal projects — router\n\nEverything lives in \`~/Personal/Projects/<name>\`. Open only the project the task is about; read its README first.\n\n| Folder | What it is |\n|---|---|\n${rows.join('\n')}\n`;
  files['departments/agentic-os.md'] = `# Agentic OS — router\n\nThe user's multi-agent office: \`~/agent-workplace\` (Node, no npm deps). Start with its README.md.\n\n- Server and agents: \`server.js\`, \`mcp-delegate.js\`, \`mail-hook.js\`; UI: \`public/os.html\`; scripts: \`scripts/\` (\`manifest.json\` lists them).\n- Config: \`roster.json\` (teams, roles, defaults), \`projects.json\`; state and logs: \`data/\`.\n- Run: \`./agentos\` (opens the app), \`./agentos stop\`.\n- Rule: anything deterministic is a script that agents call, never model work.\n`;
  files['CLAUDE.md'] = `${globalRules}\n\n---\n\n# Map of my work\n\nThis file is a map, not a rulebook. Before working in an area, read its router; each router points to the folders and docs for that area. Open the router, then only the files the task needs.\n\n| Area | Router | Covers |\n|---|---|---|\n${workNotes ? `| ${W.label} | \`${W.tilde(W.router)}\` | ${W.covers} |\n` : ''}| Personal projects | \`~/.claude/departments/personal.md\` | \`~/Personal/Projects/*\` |\n| Agentic OS | \`~/.claude/departments/agentic-os.md\` | \`~/agent-workplace\`, the user's agent office |\n\nMemories: \`MEMORY.md\` in the project memory folder holds one line per memory, each linked to its file. Check it before searching.\n\n# When a chat compacts, always keep\n\n- decisions made and the reason for each\n- templates, formats and naming the user agreed to\n- open questions and what is still to do\n- exact file paths, commands and settings that worked\n- every correction the user gave\n`;
  return { current, files };
}

function writeProposal() {
  const p = proposal();
  fs.rmSync(OUT, { recursive: true, force: true });
  for (const [rel, text] of Object.entries(p.files)) { fs.mkdirSync(path.dirname(path.join(OUT, rel)), { recursive: true }); fs.writeFileSync(path.join(OUT, rel), text); }
  const diff = spawnSync('diff', ['-u', '--label', 'CLAUDE.md (now)', '--label', 'CLAUDE.md (proposed)', CLAUDE_MD, path.join(OUT, 'CLAUDE.md')], { encoding: 'utf8' }).stdout;
  return { dir: OUT, files: Object.keys(p.files), diff, sizes: { now: p.current.length, proposed: p.files['CLAUDE.md'].length } };
}

function apply() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(HOME, '.claude', 'backups', `CLAUDE.md.${stamp}`);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.copyFileSync(CLAUDE_MD, backup);
  const p = proposal();
  for (const [rel, text] of Object.entries(p.files)) {
    const dest = rel === 'CLAUDE.md' ? CLAUDE_MD : path.join(HOME, '.claude', rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (rel !== 'CLAUDE.md' && fs.existsSync(dest)) fs.copyFileSync(dest, `${backup}.${path.basename(rel)}`);
    fs.writeFileSync(dest, text);
  }
  return { backup, written: Object.keys(p.files).map((r) => (r === 'CLAUDE.md' ? CLAUDE_MD : path.join(HOME, '.claude', r))) };
}

function run(argv) {
  const { opt } = parseArgs(argv);
  if (opt.images) {
    const r = imagesWithoutCaptions(path.join(HOME, 'Personal', 'Projects'));
    return [`${r.total} images without a text description in ${r.dirs.length} folders (≈ $${(r.total * 0.001).toFixed(2)} to caption with a cheap model):`, ...r.dirs.slice(0, 15).map((d) => `${String(d.uncaptioned).padStart(6)}  ${d.dir}`)].join('\n');
  }
  const w = writeProposal();
  return `Proposal written to ${w.dir} (nothing changed in ~/.claude):\n${w.files.map((f) => '  ' + f).join('\n')}\nCLAUDE.md: ${w.sizes.now} → ${w.sizes.proposed} characters loaded at the start of every chat.`;
}

module.exports = { writeProposal, apply, imagesWithoutCaptions, DEPTS };
if (require.main === module) cli(run);
