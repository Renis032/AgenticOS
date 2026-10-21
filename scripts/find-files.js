#!/usr/bin/env node
'use strict';
const { spawnSync } = require('child_process');
const { parseArgs, home, rel, cli, path, SKIP_DIRS } = require('./_util');

function run(argv, { cwd }) {
  const { pos, opt } = parseArgs(argv);
  if (!pos.length) return 'usage: find-files <name-pattern> [dir] [--max 200]   (e.g. find-files "*FreeRound*View*" games)';
  const dir = path.resolve(cwd, home(pos[1] || '.'));
  const max = Number(opt.max) || 200;
  const prune = ['(', ...SKIP_DIRS.flatMap((d, i) => (i ? ['-o', '-name', d] : ['-name', d])), ')', '-prune', '-o'];
  const r = spawnSync('find', [dir, ...prune, '-iname', pos[0], '-print'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const list = (r.stdout || '').split('\n').filter(Boolean).sort();
  if (!list.length) return `No files named ${pos[0]} under ${dir}.`;
  return [`${list.length} match${list.length === 1 ? '' : 'es'} under ${dir}${list.length > max ? ` (showing ${max})` : ''}:`, ...list.slice(0, max).map((f) => rel(f, cwd))].join('\n');
}

module.exports = { run };
if (require.main === module) cli(run);
