#!/usr/bin/env node
'use strict';
const os = require('os');
const { spawnSync } = require('child_process');
const { parseArgs, cli, fs, path } = require('./_util');

const ROOT = path.join(__dirname, '..');
// Claude Code's skills, the office's own, and each team's skills that agents proposed and the user approved.
const teamDirs = () => { try { return fs.readdirSync(path.join(ROOT, 'teams')).map((t) => ({ dir: path.join(ROOT, 'teams', t, 'skills'), scope: `team:${t}` })); } catch { return []; } };
const DIRS = [{ dir: path.join(os.homedir(), '.claude', 'skills'), scope: 'claude-code' }, { dir: path.join(ROOT, 'skills'), scope: 'office' }, ...teamDirs()];

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

function typeOf(fm, text, files) {
  if (fm['arms-type']) return fm['arms-type'];
  if (files.some((f) => /^(references?|examples?|data)(\.md|$)/i.test(f)) || /\breferences?\.md\b/.test(text)) return 'database';
  if (/\b(html|pdf|deck|slides|infographic|brand book)\b/i.test(fm.description || '')) return 'artifact';
  return 'procedure';
}

function usageCounts() {
  const counts = {};
  const r = spawnSync('grep', ['-rhoE', '"skill":"[^"]+"', path.join(os.homedir(), '.claude', 'projects')], { encoding: 'utf8', maxBuffer: 256 << 20 });
  for (const m of (r.stdout || '').split('\n')) { const k = (m.match(/"skill":"([^"]+)"/) || [])[1]; if (k) counts[k] = (counts[k] || 0) + 1; }
  try {
    for (const l of fs.readFileSync(path.join(os.homedir(), '.claude', 'history.jsonl'), 'utf8').split('\n')) {
      const k = ((l.match(/"display":"\/([\w:-]+)/) || [])[1]);
      if (k) counts[k] = (counts[k] || 0) + 1;
    }
  } catch {}
  return counts;
}

function scan() {
  const counts = usageCounts();
  let buttons = {};
  try { buttons = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'arms', 'buttons.json'), 'utf8')); } catch {}
  const skills = [];
  for (const { dir, scope } of DIRS) {
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => d.name); } catch {}
    for (const name of names) {
      const file = path.join(dir, name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      const files = fs.readdirSync(path.join(dir, name));
      const fm = frontmatter(text);
      const key = fm.name || name;
      let notes = 0;
      try { notes = (fs.readFileSync(path.join(dir, name, 'NOTES.md'), 'utf8').match(/^- /gm) || []).length; } catch {}
      skills.push({ name: key, dir: path.join(dir, name), file, scope, description: fm.description || '', type: typeOf(fm, text, files),
        model: fm.model || null, effort: fm.effort || null, wildcards: /wildcard/i.test(text), tokens: Math.round(text.length / 4),
        files: files.length, uses: counts[key] || counts[name] || 0, button: buttons[key] || null, parkedNotes: notes,
        changelog: fs.existsSync(path.join(dir, name, 'CHANGELOG.md')) });
    }
  }
  return skills.sort((a, b) => b.uses - a.uses || b.tokens - a.tokens);
}

function run(argv) {
  const { opt } = parseArgs(argv);
  const list = scan();
  if (opt.json) return JSON.stringify(list, null, 1);
  return [`${list.length} skills (most used first):`, 'uses  tokens  type        model    name', ...list.map((s) => `${String(s.uses).padStart(4)}  ${String(s.tokens).padStart(6)}  ${s.type.padEnd(10)}  ${(s.model || '-').padEnd(7)}  ${s.name}${s.scope === 'office' ? ' (office)' : s.scope.startsWith('team:') ? ` (${s.scope.slice(5)} team)` : ''}`)].join('\n');
}

module.exports = { scan, frontmatter };
if (require.main === module) cli(run);
