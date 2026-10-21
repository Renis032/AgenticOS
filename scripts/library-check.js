#!/usr/bin/env node
'use strict';
const { parseArgs, home, cli, fs, path } = require('./_util');

const START = '<!-- pages:start (kept up to date by scripts/library-check.js) -->';
const END = '<!-- pages:end -->';
const REF = /(?:^|[\s`(\[])((?:~|\/|\.{0,2}\/)?[\w.\-]+(?:\/[\w.\-]+)*\.(?:cpp|cc|cxx|h|hpp|hh|inl|xml|json|js|mjs|ts|py|java|kt|cmake|txt|md|yaml|yml|ini|cfg))(?::(\d+)(?:-(\d+))?)?/g;

function pagesOf(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'INDEX.md').sort().map((f) => {
    const file = path.join(dir, f);
    const text = fs.readFileSync(file, 'utf8');
    const title = (text.match(/^#\s+(.+)$/m) || [null, f.replace(/\.md$/, '')])[1].trim();
    const st = fs.statSync(file);
    return { name: f, file, text, title, bytes: st.size, mtime: st.mtimeMs, entries: (text.match(/^###\s/gm) || []).length };
  });
}

function entriesOf(page) {
  return page.text.split(/\n(?=###\s|-\s|\*\s|\d+\.\s)|\n\s*\n/).map((x) => x.trim()).filter((x) => x.length > 80 && !/^#\s/.test(x));
}

const shingles = (s) => {
  const w = s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const out = new Set();
  for (let i = 0; i + 2 < w.length; i++) out.add(w.slice(i, i + 3).join(' '));
  return out;
};

function duplicates(pages, threshold) {
  const all = [];
  for (const p of pages) for (const e of entriesOf(p)) all.push({ page: p.name, text: e, sh: shingles(e) });
  const dups = [];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i].sh, b = all[j].sh;
      if (!a.size || !b.size) continue;
      let inter = 0;
      for (const x of a) if (b.has(x)) inter++;
      const sim = inter / (a.size + b.size - inter);
      if (sim >= threshold) dups.push({ a: all[i], b: all[j], sim });
    }
  }
  return dups.sort((x, y) => y.sim - x.sim);
}

function lineCount(file) {
  const t = fs.readFileSync(file, 'utf8');
  return (t.match(/\n/g) || []).length + (t.endsWith('\n') || !t ? 0 : 1);
}

const subdirCache = new Map();
function subdirs(r) {
  if (!subdirCache.has(r)) {
    let list = [];
    try { list = fs.readdirSync(r, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).slice(0, 200).map((d) => path.join(r, d.name)); } catch {}
    subdirCache.set(r, list);
  }
  return subdirCache.get(r);
}

function resolveRef(ref, roots, near) {
  const p = home(ref);
  if (path.isAbsolute(p)) return fs.existsSync(p) ? p : null;
  for (const r of [...near, ...roots]) {
    const f = path.resolve(r, p);
    if (fs.existsSync(f)) return f;
  }
  for (const r of roots) for (const sd of subdirs(r)) {
    const f = path.resolve(sd, p);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function badRefs(pages, roots) {
  const out = [];
  const seen = new Set();
  for (const p of pages) {
    const near = [];
    const refsHere = [...p.text.matchAll(REF)];
    for (const m of refsHere) {
      const f = m[1].includes('/') && resolveRef(m[1], roots, []);
      if (f) { const d = path.dirname(f); near.push(path.dirname(d), path.dirname(path.dirname(d))); }
    }
    for (const m of refsHere) {
      const [, ref, l1, l2] = m;
      if (!ref.includes('/') && !l1) continue;
      const key = p.name + ref + (l1 || '');
      if (seen.has(key)) continue;
      seen.add(key);
      const f = resolveRef(ref, roots, [...new Set(near)]);
      if (!f) { if (ref.includes('/')) out.push({ page: p.name, ref: ref + (l1 ? `:${l1}` : ''), problem: 'file not found' }); continue; }
      if (l1 && fs.statSync(f).isFile()) {
        const n = lineCount(f);
        const hi = Number(l2 || l1);
        if (hi > n) out.push({ page: p.name, ref: `${ref}:${l1}${l2 ? '-' + l2 : ''}`, problem: `line ${hi} is past the end (file has ${n} lines)` });
      }
    }
  }
  return out;
}

function writeIndex(dir, pages) {
  const idx = path.join(dir, 'INDEX.md');
  let text = fs.existsSync(idx) ? fs.readFileSync(idx, 'utf8') : `# Library\n`;
  const block = [START, '## All pages', '', ...pages.map((p) => `- [${p.title}](${p.name}) — ${p.entries ? `${p.entries} entr${p.entries === 1 ? 'y' : 'ies'}, ` : ''}${(p.bytes / 1024).toFixed(1)} KB, updated ${new Date(p.mtime).toISOString().slice(0, 10)}`), END].join('\n');
  const i = text.indexOf(START), j = text.indexOf(END);
  text = i >= 0 && j > i ? text.slice(0, i) + block + text.slice(j + END.length) : text.replace(/\n*$/, '\n\n') + block + '\n';
  fs.writeFileSync(idx, text);
}

function check(dir, roots, opts) {
  const pages = pagesOf(dir);
  if (opts && opts.writeIndex) writeIndex(dir, pages);
  const idxText = fs.existsSync(path.join(dir, 'INDEX.md')) ? fs.readFileSync(path.join(dir, 'INDEX.md'), 'utf8').split(START)[0] : '';
  const notInIndex = pages.filter((p) => !idxText.includes(p.name)).map((p) => p.name);
  const dups = duplicates(pages, (opts && opts.threshold) || 0.55);
  const refs = badRefs(pages, [...(roots || []), dir]);
  return { pages, dups, refs, notInIndex };
}

function report(r) {
  const out = [`${r.pages.length} pages, ${r.pages.reduce((x, p) => x + p.entries, 0)} dated entries.`];
  out.push(r.dups.length ? `\nPossible duplicates (${r.dups.length}):` : '\nNo duplicate notes found.');
  for (const d of r.dups.slice(0, 15)) out.push(`- ${Math.round(d.sim * 100)}% alike: ${d.a.page} “${d.a.text.slice(0, 90).replace(/\s+/g, ' ')}…” ↔ ${d.b.page} “${d.b.text.slice(0, 90).replace(/\s+/g, ' ')}…”`);
  out.push(r.refs.length ? `\nReferences that no longer match the code (${r.refs.length}):` : '\nAll file:line references still point at real files and lines.');
  for (const x of r.refs.slice(0, 30)) out.push(`- ${x.page}: ${x.ref} — ${x.problem}`);
  if (r.notInIndex.length) out.push(`\nPages not described in the hand-written part of INDEX.md: ${r.notInIndex.join(', ')}`);
  return out.join('\n');
}

function run(argv, { cwd }) {
  const { pos, opt } = parseArgs(argv);
  if (!pos.length) return 'usage: library-check <team-docs-dir> [--roots dir1,dir2] [--write-index]';
  const dir = path.resolve(cwd, home(pos[0]));
  const roots = String(opt.roots || '').split(',').filter(Boolean).map((r) => path.resolve(cwd, home(r)));
  return report(check(dir, roots, { writeIndex: !!opt['write-index'] }));
}

module.exports = { check, report, writeIndex, pagesOf };
if (require.main === module) cli(run);
