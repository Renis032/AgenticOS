#!/usr/bin/env node
'use strict';
// Where a git repository stands, in one call: branch, HEAD, upstream, uncommitted changes, submodules with their own
// changes, and whether a commit named in a ticket is in the history (looked up in the submodules too). --diff adds the
// full diff, submodules included. Read-only.
const { spawnSync } = require('child_process');
const { parseArgs, home, cli, path } = require('./_util');

const git = (dir, args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
const out = (dir, args) => { const r = git(dir, args); return r.status === 0 ? r.stdout.trim() : null; };

function changes(dir) {
  const r = git(dir, ['status', '--porcelain=v1', '--untracked-files=normal']);
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
}

function submodules(root) {
  return (out(root, ['submodule', 'status']) || '').split('\n').filter(Boolean).map((l) => {
    const m = l.match(/^([ +\-U])([0-9a-f]+) (\S+)/);
    return m && { flag: m[1], sha: m[2], path: m[3] };
  }).filter(Boolean);
}

function findCommit(root, subs, sha) {
  for (const where of [{ path: '.', dir: root }, ...subs.map((s) => ({ path: s.path, dir: path.join(root, s.path) }))]) {
    if (out(where.dir, ['cat-file', '-t', sha]) !== 'commit') continue;
    const line = out(where.dir, ['log', '-1', '--format=%h %ad %an: %s', '--date=short', sha]);
    const anc = git(where.dir, ['merge-base', '--is-ancestor', sha, 'HEAD']).status === 0;
    const ahead = anc ? out(where.dir, ['rev-list', '--count', `${sha}..HEAD`]) : null;
    const base = anc ? null : out(where.dir, ['merge-base', sha, 'HEAD']);
    return `Commit ${sha} is in ${where.path === '.' ? 'this repository' : `submodule ${where.path}`}: ${line}\n  ` +
      (anc ? `It is in HEAD's history (HEAD is ${ahead} commit${ahead === '1' ? '' : 's'} ahead of it).` :
        `It is NOT in HEAD's history${base ? ` (they diverge at ${base.slice(0, 10)})` : ''}.`);
  }
  return `Commit ${sha} was not found in this repository or its submodules (maybe not fetched yet).`;
}

function run(argv, { cwd }) {
  const { pos, opt } = parseArgs(argv);
  const dir = path.resolve(cwd, home(pos[0] || '.'));
  const root = out(dir, ['rev-parse', '--show-toplevel']);
  if (!root) return `${dir} is not inside a git repository.`;
  const sup = out(root, ['rev-parse', '--show-superproject-working-tree']);
  const branch = out(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = out(root, ['log', '-1', '--format=%h %ad %an: %s', '--date=short']);
  const lines = [`${root}${sup ? ` (submodule of ${sup})` : ''}`, `  branch ${branch}, HEAD ${head}`];
  const up = out(root, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
  if (up) { const [behind, ahead] = up.split(/\s+/); lines.push(`  upstream ${out(root, ['rev-parse', '--abbrev-ref', '@{upstream}'])}: ${ahead} ahead, ${behind} behind (as of the last fetch)`); }

  const st = changes(root);
  const subs = submodules(root);
  const subPaths = new Set(subs.map((s) => s.path));
  const own = st.filter((l) => !subPaths.has(l.slice(3)));
  lines.push(own.length ? `  ${own.length} uncommitted change${own.length === 1 ? '' : 's'}:` : '  no uncommitted changes of its own');
  own.slice(0, 60).forEach((l) => lines.push(`    ${l.slice(0, 2)} ${l.slice(3)}`));
  if (own.length > 60) lines.push(`    … ${own.length - 60} more`);

  if (subs.length) {
    const rows = subs.map((s) => {
      const c = changes(path.join(root, s.path));
      const moved = s.flag === '+' ? ' (checked out at a different commit than recorded)' : s.flag === '-' ? ' (not initialised)' : s.flag === 'U' ? ' (merge conflict)' : '';
      return { s, c, text: `    ${s.path} @ ${s.sha.slice(0, 10)}${moved}${c.length ? ` — ${c.length} uncommitted change${c.length === 1 ? '' : 's'}` : ''}` };
    });
    const busy = rows.filter((r) => r.c.length || r.s.flag !== ' ');
    lines.push(`  ${subs.length} submodules${busy.length ? `, ${busy.length} with changes:` : ', all clean'}`);
    for (const r of opt.all ? rows : busy) {
      lines.push(r.text);
      r.c.slice(0, 30).forEach((l) => lines.push(`      ${l.slice(0, 2)} ${l.slice(3)}`));
    }
  }
  if (opt.commit) lines.push('', findCommit(root, subs, String(opt.commit)));
  if (opt.diff) {
    const max = Number(opt['max-lines']) || 400;
    const d = (out(root, ['diff', '--submodule=diff', 'HEAD']) || '').split('\n');
    lines.push('', d.length > 1 || d[0] ? `Diff (${d.length} lines${d.length > max ? `, first ${max}; --max-lines N for more` : ''}):` : 'No diff.', ...d.slice(0, max));
  }
  return lines.join('\n');
}

module.exports = { run };
if (require.main === module) cli(run);
