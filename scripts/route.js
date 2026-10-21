#!/usr/bin/env node
'use strict';
const { home, cli, fs, path } = require('./_util');

const ROOT = path.join(__dirname, '..');
const norm = (s) => String(s || '').toLowerCase();

function keywordsOf(p) {
  const kw = (p.keywords || []).map(norm).filter(Boolean);
  if (p.keywordsFromSubfolders) {
    try {
      for (const d of fs.readdirSync(home(p.path), { withFileTypes: true })) if (d.isDirectory() && !d.name.startsWith('.')) kw.push(norm(d.name));
    } catch {}
  }
  return [...new Set(kw)];
}

function hasWord(text, w) {
  if (/[^\p{L}\p{N}_]/u.test(w)) return text.includes(w);
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}_])`, 'u').test(text);
}

function route(text, projects, roster) {
  const t = norm(text);
  const leads = new Set((roster.residents || []).filter((k) => k !== roster.root));
  const score = {};
  const why = {};
  const best = {};
  const add = (lead, pts, reason, project) => {
    if (!leads.has(lead)) return;
    score[lead] = (score[lead] || 0) + pts;
    (why[lead] = why[lead] || []).push(reason);
    if (project && (!best[lead] || pts > best[lead].pts)) best[lead] = { project, pts };
  };
  for (const p of projects) {
    const full = norm(home(p.path));
    const tilde = full.replace(norm(require('os').homedir()), '~');
    if (t.includes(full) || t.includes(tilde)) add(p.department, 10, `mentions ${p.path}`, p);
    for (const w of keywordsOf(p)) if (hasWord(t, w)) add(p.department, 2, `“${w}”`, p);
  }
  for (const k of leads) {
    for (const w of ((roster.roles[k] || {}).keywords || []).map(norm)) if (hasWord(t, w)) add(k, 2, `“${w}”`);
  }
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return { lead: null, reason: 'no rule matched', scores: score };
  const [top, second] = ranked;
  if (top[1] < 2 || (second && second[1] * 2 > top[1])) return { lead: null, reason: `ambiguous (${ranked.map(([k, v]) => `${k} ${v}`).join(', ')})`, scores: score };
  return { lead: top[0], project: best[top[0]] ? best[top[0]].project.name : null, reason: why[top[0]].slice(0, 6).join(', '), scores: score };
}

function run(argv) {
  const text = argv.join(' ');
  if (!text.trim()) return 'usage: route "<ticket text>"   (prints which lead the rules pick, or that God should decide)';
  const r = route(text, JSON.parse(fs.readFileSync(path.join(ROOT, 'projects.json'), 'utf8')), JSON.parse(fs.readFileSync(path.join(ROOT, 'roster.json'), 'utf8')));
  return r.lead ? `→ ${r.lead}${r.project ? ` (project: ${r.project})` : ''}\nbecause: ${r.reason}` : `→ God decides (${r.reason})`;
}

module.exports = { route };
if (require.main === module) cli(run);
