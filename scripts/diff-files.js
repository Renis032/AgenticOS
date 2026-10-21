#!/usr/bin/env node
'use strict';
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { parseArgs, home, rel, cli, fs, path } = require('./_util');

const sha = (b) => crypto.createHash('sha1').update(b).digest('hex').slice(0, 12);

function run(argv, { cwd }) {
  const { pos, opt } = parseArgs(argv);
  if (pos.length < 2) return 'usage: diff-files <a> <b> [--max-lines 300]   (files or directories)';
  const [a, b] = pos.slice(0, 2).map((p) => path.resolve(cwd, home(p)));
  for (const p of [a, b]) if (!fs.existsSync(p)) return `Not found: ${p}`;
  if (fs.statSync(a).isDirectory() || fs.statSync(b).isDirectory()) {
    const r = spawnSync('diff', ['-rq', a, b], { encoding: 'utf8', maxBuffer: 32 << 20 });
    const lines = (r.stdout || '').split('\n').filter(Boolean);
    return lines.length ? [`${lines.length} difference${lines.length === 1 ? '' : 's'}:`, ...lines.slice(0, 300)].join('\n') : 'Directories are identical.';
  }
  const A = fs.readFileSync(a), B = fs.readFileSync(b);
  const head = [`${rel(a, cwd)}: ${A.length} bytes, sha1 ${sha(A)}`, `${rel(b, cwd)}: ${B.length} bytes, sha1 ${sha(B)}`];
  if (A.equals(B)) return [...head, 'IDENTICAL (byte for byte).'].join('\n');
  const norm = (x) => x.toString('utf8').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\s+/g, ' ').trim();
  if (norm(A) === norm(B)) return [...head, 'DIFFERENT bytes, but only in whitespace or line endings.'].join('\n');
  const r = spawnSync('diff', ['-u', '--label', rel(a, cwd), '--label', rel(b, cwd), a, b], { encoding: 'utf8', maxBuffer: 32 << 20 });
  const lines = (r.stdout || '').split('\n');
  const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
  const max = Number(opt['max-lines']) || 300;
  return [...head, `DIFFERENT: +${added} −${removed} lines.`, '', ...lines.slice(0, max), lines.length > max ? `… ${lines.length - max} more diff lines (use --max-lines).` : ''].join('\n');
}

module.exports = { run };
if (require.main === module) cli(run);
