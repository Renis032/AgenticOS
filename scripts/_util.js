'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const SKIP_DIRS = ['.git', 'node_modules', '.cache', 'out', 'dist', '__pycache__', '.idea', '.vscode', 'build', 'cmake-build-debug', 'cmake-build-release'];

const home = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) opt[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) opt[k] = argv[++i];
      else opt[k] = true;
    } else pos.push(a);
  }
  return { pos, opt };
}

function expand(patterns, cwd) {
  const out = [];
  for (const raw of patterns) {
    const p = home(raw);
    if (!/[*?[]/.test(p)) { out.push(path.resolve(cwd, p)); continue; }
    const abs = path.resolve(cwd, p);
    const base = abs.split(/[*?[]/)[0].replace(/[^/]*$/, '') || '/';
    const r = spawnSync('find', [base, ...pruneArgs(), '-type', 'f', '-path', abs.replace(/\*\*\//g, '*'), '-print'], { encoding: 'utf8', maxBuffer: 64 << 20 });
    out.push(...(r.stdout || '').split('\n').filter(Boolean).sort());
  }
  return [...new Set(out)];
}

function pruneArgs() {
  return ['(', ...SKIP_DIRS.flatMap((d, i) => (i ? ['-o', '-name', d] : ['-name', d])), ')', '-prune', '-o'];
}

function grep(args, cwd) {
  const r = spawnSync('grep', ['-rnIH', ...SKIP_DIRS.map((d) => `--exclude-dir=${d}`), '--exclude=*.jsonl', '--exclude=*.min.js', '--exclude=*.map', ...args], { cwd, encoding: 'utf8', maxBuffer: 128 << 20 });
  return (r.stdout || '').split('\n').filter(Boolean).map((l) => {
    const m = l.match(/^(.*?):(\d+):(.*)$/);
    return m ? { file: m[1], line: Number(m[2]), text: m[3] } : null;
  }).filter(Boolean);
}

const rel = (f, cwd) => { const r = path.relative(cwd, f); return r.startsWith('..') ? f : r; };

function cli(run) {
  try {
    process.stdout.write(String(run(process.argv.slice(2), { cwd: process.cwd() })).replace(/\n*$/, '\n'));
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(2);
  }
}

module.exports = { SKIP_DIRS, home, parseArgs, expand, grep, rel, cli, fs, path };
