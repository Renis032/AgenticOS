#!/usr/bin/env node
'use strict';
const { parseArgs, home, grep, rel, cli, path } = require('./_util');

const LANGS = {
  cpp: ['*.h', '*.hpp', '*.hh', '*.hxx', '*.cpp', '*.cc', '*.cxx', '*.inl', '*.ipp'],
  js: ['*.js', '*.mjs', '*.cjs', '*.ts', '*.tsx', '*.jsx'],
  py: ['*.py'],
  java: ['*.java', '*.kt'],
  xml: ['*.xml'],
};

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function classify(text, sym, file) {
  const s = esc(sym);
  const t = text.trim();
  const ext = path.extname(file).toLowerCase();
  if (new RegExp(`^#\\s*define\\s+${s}\\b`).test(t)) return 'macro';
  if (new RegExp(`\\b(class|struct|union|interface|enum(\\s+class)?)\\s+(\\w+\\s+)*${s}\\b`).test(t)) return /;\s*$/.test(t) ? 'forward declaration' : 'type';
  if (new RegExp(`\\bnamespace\\s+${s}\\b`).test(t)) return 'namespace';
  if (new RegExp(`\\b(using\\s+${s}\\s*=|typedef\\b.*\\b${s}\\s*;)`).test(t)) return 'alias';
  if (['.py'].includes(ext) && new RegExp(`^(async\\s+)?(def|class)\\s+${s}\\b`).test(t)) return 'definition';
  if (LANGS.js.some((g) => g.slice(1) === ext)) {
    if (new RegExp(`\\b(function\\*?\\s+${s}\\b|(const|let|var)\\s+${s}\\s*=|class\\s+${s}\\b)`).test(t)) return 'definition';
    if (new RegExp(`^(async\\s+|static\\s+|get\\s+|set\\s+)*${s}\\s*\\([^)]*\\)\\s*\\{`).test(t)) return 'method';
  }
  if (ext === '.xml' && new RegExp(`\\b(name|id|type|class)\\s*=\\s*"${s}"`).test(t)) return 'xml definition';
  if (LANGS.cpp.some((g) => g.slice(1) === ext) || LANGS.java.some((g) => g.slice(1) === ext)) {
    if (/^\s*(return|if|else|while|for|switch|case|throw|delete|new)\b/.test(text)) return null;
    if (new RegExp(`(::|\\s|\\*|&|^)~?${s}\\s*\\([^;]*$`).test(t) && !/^\s*[)}\],]/.test(t) && !/[=!<>]=?\s*$/.test(t)) {
      if (ext === '.h' || ext === '.hpp' || ext === '.hh') return /[;]\s*$/.test(t) ? 'declaration' : 'inline definition';
      return new RegExp(`::~?${s}\\s*\\(`).test(t) || /^[\w:<>,\s*&]+\s+[*&]?\w+\s*\(/.test(t) ? 'function definition' : null;
    }
    if (new RegExp(`(::|\\s|\\*|&)${s}\\s*\\([^)]*\\)\\s*(const\\s*)?(override\\s*)?(=\\s*0\\s*)?;\\s*$`).test(t) && /^\s*(virtual\s+|static\s+|inline\s+)?[\w:<>,\s*&]+\s/.test(text)) return 'declaration';
  }
  return null;
}

function target(p) {
  const { fs } = require('./_util');
  return fs.existsSync(p) && fs.statSync(p).isFile() ? { dir: path.dirname(p), arg: path.basename(p) } : { dir: p, arg: '.' };
}

function definitions(sym, where, lang) {
  const { dir, arg } = target(where);
  const inc = arg === '.' ? (lang ? LANGS[lang] || [] : Object.values(LANGS).flat()).map((g) => `--include=${g}`) : [];
  return grep([...inc, '-w', '-e', sym, arg], dir)
    .map((h) => ({ ...h, file: path.resolve(dir, h.file), kind: classify(h.text, sym, h.file) }))
    .filter((h) => h.kind);
}

function run(argv, { cwd }) {
  const { pos, opt } = parseArgs(argv);
  if (!pos.length) return 'usage: find-def <symbol> [dir] [--lang cpp|js|py|java|xml] [--max 60]';
  const dir = path.resolve(cwd, home(pos[1] || '.'));
  const max = Number(opt.max) || 60;
  const defs = definitions(pos[0], dir, opt.lang);
  if (!defs.length) return `No definition of ${pos[0]} found under ${dir}. (Try call-sites to see where it is used.)`;
  const order = ['type', 'macro', 'alias', 'namespace', 'definition', 'function definition', 'inline definition', 'method', 'xml definition', 'declaration', 'forward declaration'];
  defs.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.file.localeCompare(b.file) || a.line - b.line);
  return [`${defs.length} definition-like line${defs.length === 1 ? '' : 's'} for ${pos[0]} under ${dir}${defs.length > max ? ` (showing ${max})` : ''}:`,
    ...defs.slice(0, max).map((d) => `[${d.kind}] ${rel(d.file, cwd)}:${d.line}  ${d.text.trim().slice(0, 160)}`)].join('\n');
}

module.exports = { run, definitions, classify, target, LANGS };
if (require.main === module) cli(run);
