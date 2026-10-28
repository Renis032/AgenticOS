#!/usr/bin/env node
'use strict';
// Code search grouped by file, skipping build and dependency folders, with an optional file type and context lines.
// Media and other binary assets, and files over --max-size MB, are never read: a repository with gigabytes of textures
// and videos is searched in seconds instead of minutes.
const { parseArgs, home, rel, cli, fs, path, SKIP_DIRS } = require('./_util');
const { spawnSync } = require('child_process');

const BINARY = ['dds', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'tga', 'webp', 'ico', 'psd', 'ktx', 'ktx2', 'astc', 'pvr', 'mov', 'mpg', 'mpeg', 'mp4', 'm2v',
  'avi', 'mkv', 'webm', 'fli', 'wav', 'ogg', 'mp3', 'flac', 'ttf', 'otf', 'woff', 'woff2', 'zip', 'gz', 'xz', '7z', 'tar', 'jar', 'so', 'a', 'o', 'obj',
  'dll', 'exe', 'lib', 'pdb', 'bin', 'pdf', 'xls', 'xlsx', 'doc', 'docx', 'pyc', 'class', 'jsonl', 'map'];
const DEFAULT_MAX_MB = 5;

const BINARY_EXT = new Set(BINARY);
const globRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');

// The files to search: find only lists names (no per-file stat), then extension and size are checked here, so grep
// never opens an asset and only the remaining text files are stat-ed.
function filesUnder(dirs, inc, maxMb) {
  const prune = ['(', ...[...SKIP_DIRS, '.venv', 'venv'].flatMap((d, i) => (i ? ['-o', '-name', d] : ['-name', d])), ')', '-prune', '-o'];
  const r = spawnSync('find', [...dirs, ...prune, '-type', 'f', '-print0'], { maxBuffer: 1 << 30 });
  const want = inc.map(globRe);
  const maxBytes = maxMb > 0 ? maxMb * 1048576 : Infinity;
  return String(r.stdout || '').split('\0').filter((f) => {
    if (!f) return false;
    const base = f.slice(f.lastIndexOf('/') + 1);
    if (want.length ? !want.some((re) => re.test(base)) : (BINARY_EXT.has(base.slice(base.lastIndexOf('.') + 1).toLowerCase()) || base.endsWith('.min.js'))) return false;
    if (maxBytes === Infinity) return true;
    try { return fs.statSync(f).size < maxBytes; } catch { return false; }
  });
}

// grep over a file list in batches, so the command line never gets too long.
function grepFiles(files, flags, pattern, deadline) {
  let out = '';
  for (let i = 0; i < files.length; i += 2000) {
    const left = deadline - Date.now();
    if (left <= 0) return { out, timedOut: true };
    const r = spawnSync('grep', [...flags, '-e', pattern, '--', ...files.slice(i, i + 2000)], { encoding: 'utf8', maxBuffer: 256 << 20, timeout: left });
    if (r.error && r.error.code === 'ETIMEDOUT') return { out: out + (r.stdout || ''), timedOut: true };
    if (r.status === 2 && !r.stdout && r.stderr && /regular expression|Unmatched|Invalid/i.test(r.stderr)) return { error: r.stderr.trim() };
    out += r.stdout || '';
  }
  return { out };
}

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
  if (!pos.length) return 'usage: search <regex> [dir...] [--lang cpp|js|py|java|xml|web|data|md] [--glob "*.ext"] [--ignore-case] [--files] [--context N] [--max N] [--max-size MB]\n' +
    `  Extended regex (grep -E). Several folders may follow the pattern. Skips .git, node_modules, build folders, media/binary files and files over ${DEFAULT_MAX_MB} MB (--max-size 0 searches every size).`;
  const [pattern, ...dirArgs] = pos;
  const dirs = (dirArgs.length ? dirArgs : ['.']).map((d) => path.resolve(cwd, home(d)));
  const missing = dirs.filter((d) => !fs.existsSync(d));
  if (missing.length) return `Not found: ${missing.map((d) => rel(d, cwd)).join(', ')}`;
  const inc = [...(opt.lang ? LANGS[opt.lang] || [] : []), ...(opt.glob ? String(opt.glob).split(',') : [])];
  if (opt.lang && !LANGS[opt.lang]) return `Unknown --lang ${opt.lang}. Use one of: ${Object.keys(LANGS).join(', ')}.`;
  const maxMb = opt['max-size'] !== undefined ? Number(opt['max-size']) || 0 : DEFAULT_MAX_MB;
  const timeout = Number(opt.timeout || 90) * 1000;
  const deadline = Date.now() + timeout;
  const files = filesUnder(dirs, inc, maxMb);
  const flags = ['-nIHE', ...(opt['ignore-case'] ? ['-i'] : []), ...(opt.files ? ['-l'] : [])];
  const r = grepFiles(files, flags, pattern, deadline);
  if (r.error) return `grep error: ${r.error}`;
  if (r.timedOut && !r.out) return `Search timed out after ${timeout / 1000}s; narrow the folder or add --lang.`;
  const where = dirs.map((d) => rel(d, cwd) || '.').join(' ');
  const lines = r.out.split('\n').filter(Boolean);
  if (!lines.length) return `No matches for /${pattern}/ in ${where}${inc.length ? ` (${inc.join(' ')})` : ''} (${files.length} files searched${maxMb > 0 ? `; files over ${maxMb} MB skipped, --max-size 0 to include them` : ''}).`;
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
  const out = [`${lines.length} matches in ${byFile.size} files${lines.length > max ? ` (showing ${max}; use --max or narrow it)` : ''}${r.timedOut ? ' (timed out: partial results)' : ''}:`];
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
