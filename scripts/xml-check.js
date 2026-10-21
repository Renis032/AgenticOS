#!/usr/bin/env node
'use strict';
const { spawnSync } = require('child_process');
const { parseArgs, expand, rel, cli } = require('./_util');

function run(argv, { cwd }) {
  const { pos } = parseArgs(argv);
  if (!pos.length) return 'usage: xml-check <file|glob>...   (well-formedness check with xmllint)';
  const files = expand(pos, cwd);
  if (!files.length) return 'No files matched.';
  const bad = [];
  for (const f of files) {
    const r = spawnSync('xmllint', ['--noout', f], { encoding: 'utf8' });
    if (r.error) return `xmllint is not available: ${r.error.message}`;
    if (r.status !== 0) bad.push(`✗ ${rel(f, cwd)}\n${(r.stderr || '').trim().split('\n').slice(0, 8).map((l) => '    ' + l).join('\n')}`);
  }
  return [`${files.length - bad.length} of ${files.length} file${files.length === 1 ? '' : 's'} well-formed.`, ...bad].join('\n');
}

module.exports = { run };
if (require.main === module) cli(run);
