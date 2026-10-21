#!/usr/bin/env node
'use strict';
const { parseArgs, expand, rel, cli, fs } = require('./_util');

function run(argv, { cwd }) {
  const { pos } = parseArgs(argv);
  if (!pos.length) return 'usage: count <file|glob>...   (e.g. count README.md "src/**/*.cpp")';
  const files = expand(pos, cwd);
  const rows = [];
  let tot = { lines: 0, nonEmpty: 0, words: 0, bytes: 0 };
  for (const f of files) {
    let buf;
    try { buf = fs.readFileSync(f); } catch (e) { rows.push(`${rel(f, cwd)}: ${e.code === 'ENOENT' ? 'not found' : e.message}`); continue; }
    if (fs.statSync(f).isDirectory()) { rows.push(`${rel(f, cwd)}: is a directory`); continue; }
    const text = buf.toString('utf8');
    const lines = (text.match(/\n/g) || []).length;
    const nonEmpty = text.split('\n').filter((l) => l.trim()).length;
    const words = (text.match(/\S+/g) || []).length;
    tot = { lines: tot.lines + lines, nonEmpty: tot.nonEmpty + nonEmpty, words: tot.words + words, bytes: tot.bytes + buf.length };
    rows.push(`${rel(f, cwd)}: ${lines} lines (${nonEmpty} non-empty), ${words} words, ${buf.length} bytes`);
  }
  if (!files.length) return 'No files matched.';
  if (files.length > 1) rows.push(`TOTAL (${files.length} files): ${tot.lines} lines (${tot.nonEmpty} non-empty), ${tot.words} words, ${tot.bytes} bytes`);
  rows.push('(lines = newline count, same as wc -l)');
  return rows.join('\n');
}

module.exports = { run };
if (require.main === module) cli(run);
