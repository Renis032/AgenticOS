#!/usr/bin/env node
'use strict';
// The shape of a file without reading it: classes, functions, methods and headings with their line numbers.
const { parseArgs, expand, rel, cli, fs, path } = require('./_util');

const CONTROL = /^(if|for|while|switch|catch|return|else|do|try|sizeof|case|throw|new|delete|using|typedef|template|static_assert|elif|with|assert)\b/;

const RULES = {
  py: [
    [/^(\s*)(?:async\s+)?def\s+(\w+)/, 'def'],
    [/^(\s*)class\s+(\w+)/, 'class'],
  ],
  js: [
    [/^(\s*)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/, 'function'],
    [/^(\s*)(?:export\s+)?(?:default\s+)?class\s+(\w+)/, 'class'],
    [/^(\s*)(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|\w+\s*=>)/, 'function'],
    [/^(\s{2,})(?:static\s+|async\s+|get\s+|set\s+)*(\w+)\s*\([^)]*\)\s*\{\s*$/, 'method'],
    [/^(\s*)(\w+):\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>)/, 'method'],
    [/^(\s*)(?:export\s+)?(?:interface|type)\s+(\w+)/, 'type'],
  ],
  cpp: [
    [/^(\s*)(?:template\s*<[^>]*>\s*)?(class|struct|enum(?:\s+class)?|union|namespace)\s+(\w+)(?!.*;\s*$)/, null],
    [/^(\s*)(?!.*;\s*$)(?:[\w:<>,~*&\s]+?\s+[*&]*)?((?:\w+::)*~?\w+)\s*\([^;{]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:final\s*)?(?:->\s*[\w:<>]+\s*)?(?:\{.*)?$/, 'function'],
  ],
  java: [
    [/^(\s*)(?:public|private|protected|abstract|final|static|sealed|open|data|internal|\s)*(class|interface|enum|record|object)\s+(\w+)/, null],
    [/^(\s*)(?:public|private|protected|static|final|abstract|synchronized|override|suspend|\s)*(?:fun\s+|[\w<>\[\],\s]+\s+)(\w+)\s*\([^;]*\)\s*(?:throws [\w, ]+)?\s*[{=:]?[^;]*$/, 'method'],
  ],
  go: [[/^()func\s+(?:\([^)]*\)\s*)?(\w+)/, 'func'], [/^()type\s+(\w+)\s+(?:struct|interface)/, 'type']],
  rs: [[/^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/, 'fn'], [/^(\s*)(?:pub\s+)?(?:struct|enum|trait|impl)\s+(\w+)/, 'type']],
  md: [[/^()(#{1,6})\s+(.*)/, null]],
  sh: [[/^()(?:function\s+)?(\w[\w-]*)\s*\(\)\s*\{/, 'function']],
};
const EXT = { '.py': 'py', '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.ts': 'js', '.tsx': 'js', '.jsx': 'js', '.h': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.inl': 'cpp', '.c': 'cpp', '.java': 'java', '.kt': 'java', '.cs': 'java', '.go': 'go', '.rs': 'rs', '.md': 'md', '.sh': 'sh' };

function outline(file) {
  const lang = EXT[path.extname(file).toLowerCase()];
  if (!lang) return null;
  const rows = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (line.length > 400) return;
    const t = line.trim();
    if (!t || /^(\/\/|#(?!#)|\*|\/\*)/.test(t) && lang !== 'md') return;
    for (const [re, kind] of RULES[lang]) {
      const m = line.match(re);
      if (!m) continue;
      let name = m[m.length - 1];
      let k = kind;
      if (lang === 'md') { k = 'h' + m[2].length; name = m[3]; }
      else if (!k) { k = m[2].replace(/\s+/g, ' '); }
      if (lang !== 'md' && (CONTROL.test(name) || ((lang === 'cpp' || lang === 'java') && k !== 'class' && CONTROL.test(t)))) break;
      if (lang === 'cpp' && k === 'function' && (/^(return|else)\b/.test(t) || /[=!<>]=|\b(if|while|for)\s*\(/.test(t.split('(')[0]))) break;
      rows.push({ line: i + 1, depth: Math.floor((m[1] || '').replace(/\t/g, '    ').length / 2), kind: k, name });
      break;
    }
  });
  return { rows, total: lines.length };
}

function run(argv, { cwd }) {
  const { pos, opt } = parseArgs(argv);
  if (!pos.length) return 'usage: outline <file|glob>... [--max N]   classes, functions, methods and headings with line numbers (py, js/ts, c/c++, java/kotlin, go, rust, md, sh)';
  const max = Number(opt.max) || 400;
  const out = [];
  for (const f of expand(pos, cwd)) {
    let o;
    try { o = outline(f); } catch (e) { out.push(`== ${rel(f, cwd)}: ${e.message}`); continue; }
    if (!o) { out.push(`== ${rel(f, cwd)}: no outline rules for this file type`); continue; }
    out.push(`== ${rel(f, cwd)} (${o.total} lines, ${o.rows.length} items)`);
    for (const r of o.rows.slice(0, max)) out.push(`${String(r.line).padStart(6)}  ${'  '.repeat(Math.min(r.depth, 6))}${r.kind} ${r.name}`);
    if (o.rows.length > max) out.push(`  … ${o.rows.length - max} more (use --max)`);
  }
  return out.join('\n') || 'No files matched.';
}

module.exports = { run, outline };
if (require.main === module) cli(run);
