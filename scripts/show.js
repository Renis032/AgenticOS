#!/usr/bin/env node
'use strict';
// Prints line ranges from one or more files with line numbers, so reading parts of files is one call instead of several sed -n.
const { parseArgs, home, rel, cli, fs, path } = require('./_util');

const MAX_LINES = 1500;

function parseSpec(spec, ctx) {
  const m = spec.match(/^(.*?):(\d+)(?:-(\d+))?$/);
  if (!m || !fs.existsSync(home(m[1]))) return { file: spec, from: 1, to: null };
  const a = Number(m[2]);
  return m[3] ? { file: m[1], from: a, to: Number(m[3]) } : { file: m[1], from: Math.max(1, a - ctx), to: a + ctx, mark: a };
}

function run(argv, { cwd }) {
  const { pos, opt } = parseArgs(argv);
  if (!pos.length) return 'usage: show <file[:line | :from-to]>... [--context N]\n  e.g. show db.py:70-205 collector.py:131 README.md   (a bare file shows its first 150 lines)';
  const ctx = Number(opt.context) || 20;
  const out = [];
  let budget = MAX_LINES;
  for (const spec of pos) {
    const s = parseSpec(spec, ctx);
    const f = path.resolve(cwd, home(s.file));
    let lines;
    try { lines = fs.readFileSync(f, 'utf8').split('\n'); } catch (e) { out.push(`== ${spec}: ${e.code === 'ENOENT' ? 'not found' : e.message}`); continue; }
    if (lines[lines.length - 1] === '') lines.pop();
    const from = Math.max(1, s.from);
    const to = Math.min(lines.length, s.to || Math.min(lines.length, 150), from + budget - 1);
    if (budget <= 0) { out.push(`== ${rel(f, cwd)}: skipped (over ${MAX_LINES} lines shown; ask for smaller ranges)`); continue; }
    out.push(`== ${rel(f, cwd)}  lines ${from}-${to} of ${lines.length}${!s.to && lines.length > to ? '  (use file:from-to for more)' : ''}`);
    const w = String(to).length;
    for (let i = from; i <= to; i++) out.push(`${i === s.mark ? '>' : ' '}${String(i).padStart(w)}  ${lines[i - 1]}`);
    budget -= to - from + 1;
  }
  return out.join('\n');
}

module.exports = { run };
if (require.main === module) cli(run);
