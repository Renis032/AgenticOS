#!/usr/bin/env node
'use strict';
// Development check (not an agent script): every tracked JavaScript file parses (node --check) and every shell script
// parses (bash -n). Used by `npm test` and CI.
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const files = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
const bad = [];
for (const f of files) {
  const cmd = /\.(js|cjs|mjs)$/.test(f) ? [process.execPath, ['--check', f]] : /\.sh$/.test(f) || f === 'agentos' ? ['bash', ['-n', f]] : null;
  if (!cmd) continue;
  const r = spawnSync(cmd[0], cmd[1], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) bad.push(`${f}\n${(r.stderr || '').trim()}`);
}
const n = files.filter((f) => /\.(js|cjs|mjs|sh)$/.test(f) || f === 'agentos').length;
if (bad.length) { console.error(`Syntax errors in ${bad.length} of ${n} files:\n\n${bad.join('\n\n')}`); process.exit(1); }
console.log(`Syntax OK: ${n} files.`);
