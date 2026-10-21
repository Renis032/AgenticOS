#!/usr/bin/env node
'use strict';
const { parseArgs, home, grep, rel, cli, path } = require('./_util');
const { classify, target, LANGS } = require('./find-def');

function run(argv, { cwd }) {
  const { pos, opt } = parseArgs(argv);
  if (!pos.length) return 'usage: call-sites <symbol> [dir] [--lang cpp|js|py|java|xml] [--max 80] [--with-defs]';
  const dir = path.resolve(cwd, home(pos[1] || '.'));
  const max = Number(opt.max) || 80;
  const tg = target(dir);
  const inc = opt.lang && tg.arg === '.' ? (LANGS[opt.lang] || []).map((g) => `--include=${g}`) : [];
  const hits = grep([...inc, '-w', '-e', pos[0], tg.arg], tg.dir).map((h) => ({ ...h, file: path.resolve(tg.dir, h.file) }));
  const member = new RegExp(`^[\\w:<>,*&\\s]*\\b${pos[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}::~?\\w+\\s*\\([^;]*$`);
  const own = hits.filter((h) => member.test(h.text) && !/^\s/.test(h.text));
  const uses = opt['with-defs'] ? hits : hits.filter((h) => !classify(h.text, pos[0], h.file) && !own.includes(h) && !/^\s*(\/\/|\*|#\s*include)/.test(h.text));
  if (!uses.length) return `No uses of ${pos[0]} under ${dir}.`;
  const byFile = new Map();
  for (const u of uses) { if (!byFile.has(u.file)) byFile.set(u.file, []); byFile.get(u.file).push(u); }
  const files = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const out = [`${uses.length} use${uses.length === 1 ? '' : 's'} of ${pos[0]} in ${files.length} file${files.length === 1 ? '' : 's'} under ${dir}${opt['with-defs'] ? '' : ` (definitions, ${own.length} member definition${own.length === 1 ? '' : 's'} and comments left out)`}:`];
  let shown = 0;
  for (const [f, list] of files) {
    out.push(`\n${rel(f, cwd)} (${list.length})`);
    for (const u of list) {
      if (shown++ >= max) break;
      out.push(`  ${u.line}: ${u.text.trim().slice(0, 160)}`);
    }
    if (shown >= max && uses.length > max) { out.push(`\n… ${uses.length - max} more not shown (use --max).`); break; }
  }
  return out.join('\n');
}

module.exports = { run };
if (require.main === module) cli(run);
