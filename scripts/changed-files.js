#!/usr/bin/env node
'use strict';
const { spawnSync } = require('child_process');
const { parseArgs, home, cli, path } = require('./_util');

const git = (dir, args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 32 << 20 });

function run(argv, { cwd }) {
  const { pos } = parseArgs(argv);
  const dir = path.resolve(cwd, home(pos[0] || '.'));
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) return `${dir} is not inside a git repository.`;
  const root = top.stdout.trim();
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  const st = git(root, ['status', '--porcelain=v1', '--untracked-files=normal']).stdout.split('\n').filter(Boolean);
  if (!st.length) return `${root} (${branch}): no uncommitted changes.`;
  const label = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'conflict', '?': 'untracked' };
  const rows = st.map((l) => {
    const x = l[0], y = l[1], f = l.slice(3);
    const k = x === '?' ? 'untracked' : `${x !== ' ' ? 'staged ' + (label[x] || x) : ''}${x !== ' ' && y !== ' ' ? ', ' : ''}${y !== ' ' ? (label[y] || y) : ''}`;
    return `  ${f}  [${k}]`;
  });
  const stat = git(root, ['diff', '--stat', 'HEAD']).stdout.trim().split('\n').pop();
  return [`${root} (${branch}): ${st.length} changed path${st.length === 1 ? '' : 's'}${stat ? ` — ${stat.trim()}` : ''}`, ...rows].join('\n');
}

module.exports = { run };
if (require.main === module) cli(run);
