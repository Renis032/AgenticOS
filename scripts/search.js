#!/usr/bin/env node
'use strict';
// Code search grouped by file, skipping build and dependency folders, with an optional file type and context lines.
const { parseArgs, home, rel, cli, fs, path, SKIP_DIRS } = require('./_util');
const { spawnSync } = require('child_process');

const LANGS = {
  cpp: ['*.h', '*.hpp', '*.hh', '*.hxx', '*.cpp', '*.cc', '*.cxx', '*.inl', '*.ipp', '*.c'],
  js: ['*.js', '*.mjs', '*.cjs', '*.ts', '*.tsx', '*.jsx'],
  py: ['*.py'],
  java: ['*.java', '*.kt'],
  xml: ['*.xml'],
  web: ['*.html', '*.css', '*.js', '*.ts', '*.tsx', '*.jsx', '*.vue', '*.svelte'],
  data: ['*.json', '*.xml', '*.yaml', '*.yml', '*.toml', '*.csv', '*.ini'],
  md: ['*.md', '*.txt', '*.rst'],
};

function run(argv, { cwd }) {
  const { pos, opt } = parseArgs(argv.map((a) => (a === '-i' ? '--ignore-case' : a)));
  if (!pos.length) return 'usage: search <regex> [dir] [--lang cpp|js|py|java|xml|web|data|md] [--glob "*.ext"] [--ignore-case] [--files] [--context N] [--max N]\n  Extended regex (grep -E). Skips .git, node_modules, build folders and the like.';
  const [pattern, dirArg] = pos;
  const dir = path.resolve(cwd, home(dirArg || '.'));
  const inc = [...(opt.lang ? LANGS[opt.lang] || [] : []), ...(opt.glob ? String(opt.glob).split(',') : [])];
  if (opt.lang && !LANGS[opt.lang]) return `Unknown --lang ${opt.lang}. Use one of: ${Object.keys(LANGS).join(', ')}.`;
  // grep includes a file that matches no --include/--exclude unless the first such option is an --include, so includes go first.
  const args = ['-rnIHE', ...(opt['ignore-case'] ? ['-i'] : []), ...(opt.files ? ['-l'] : []), ...inc.map((g) => `--include=${g}`), ...SKIP_DIRS.map((d) => `--exclude-dir=${d}`), '--exclude-dir=.venv', '--exclude-dir=venv',
    ...(inc.length ? [] : ['--exclude=*.min.js', '--exclude=*.map', '--exclude=*.jsonl']), '-e', pattern, dir];
  const r = spawnSync('grep', args, { encoding: 'utf8', maxBuffer: 256 << 20, timeout: Number(opt.timeout || 90) * 1000 });
  if (r.error && r.error.code === 'ETIMEDOUT') return `Search timed out after ${opt.timeout || 90}s; narrow the folder or add --lang.`;
  if (r.status === 2 && !r.stdout) return `grep error: ${(r.stderr || '').trim()}`;
  const lines = (r.stdout || '').split('\n').filter(Boolean);
  if (!lines.length) return `No matches for /${pattern}/ in ${rel(dir, cwd) || '.'}${inc.length ? ` (${inc.join(' ')})` : ''}.`;
  if (opt.files) return `${lines.length} files:\n${lines.slice(0, Number(opt.max) || 300).map((f) => rel(f, cwd)).join('\n')}`;
  const max = Number(opt.max) || 200;
  const ctx = Math.min(10, Number(opt.context) || 0);
  const byFile = new Map();
  for (const l of lines) {
    const m = l.match(/^(.*?):(\d+):(.*)$/);
    if (!m) continue;
    if (!byFile.has(m[1])) byFile.set(m[1], []);
    byFile.get(m[1]).push({ line: Number(m[2]), text: m[3] });
  }
  const out = [`${lines.length} matches in ${byFile.size} files${lines.length > max ? ` (showing ${max}; use --max or narrow it)` : ''}:`];
  let shown = 0;
  for (const [f, hits] of byFile) {
    if (shown >= max) break;
    out.push(`== ${rel(f, cwd)} (${hits.length})`);
    let src = null;
    if (ctx) { try { src = fs.readFileSync(f, 'utf8').split('\n'); } catch {} }
    for (const h of hits) {
      if (shown++ >= max) break;
      if (src) {
        for (let i = Math.max(1, h.line - ctx); i <= Math.min(src.length, h.line + ctx); i++) out.push(`${i === h.line ? '>' : ' '}${String(i).padStart(6)}  ${src[i - 1].slice(0, 300)}`);
        out.push('   ---');
      } else out.push(`${String(h.line).padStart(7)}  ${h.text.trim().slice(0, 300)}`);
    }
  }
  return out.join('\n');
}

module.exports = { run };
if (require.main === module) cli(run);
