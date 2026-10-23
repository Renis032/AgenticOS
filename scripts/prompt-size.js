#!/usr/bin/env node
'use strict';
// How many tokens each role's fixed instructions and office tool definitions take: what every single call of that role re-sends.
const { parseArgs, cli, fs, path } = require('./_util');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const tok = (chars) => Math.round(chars / 4);

function fetchSizes(port, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/prompt-size', headers: { 'x-agentos-token': token, host: `127.0.0.1:${port}` } }, (res) => {
      let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(new Error(s.slice(0, 200))); } });
    });
    req.on('error', reject);
    req.end();
  });
}

async function run(argv) {
  const { opt } = parseArgs(argv);
  const port = Number(process.env.WORKPLACE_PORT || opt.port || 4747);
  const token = fs.readFileSync(path.join(ROOT, 'data', 'app-token'), 'utf8').trim();
  const rows = await fetchSizes(port, token);
  const out = ['Fixed size per call (≈ tokens; Claude Code adds its own system prompt and built-in tools on top):', ''];
  for (const r of rows) {
    if (r.error) { out.push(`${r.role}: error ${r.error}`); continue; }
    out.push(`${r.role.padEnd(22)} instructions ${String(tok(r.promptChars)).padStart(6)}   office tools ${String(tok(r.toolChars)).padStart(6)}   total ${String(tok(r.promptChars + r.toolChars)).padStart(6)}`);
    if (opt.detail || rows.length === 1) {
      for (const s of r.sections.sort((a, b) => b.chars - a.chars).slice(0, 12)) out.push(`    ${String(tok(s.chars)).padStart(5)}  ${s.name}`);
      for (const t of r.tools.sort((a, b) => b.chars - a.chars).slice(0, 6)) out.push(`    ${String(tok(t.chars)).padStart(5)}  tool ${t.name}`);
    }
  }
  return out.join('\n');
}

module.exports = { run };
if (require.main === module) run(process.argv.slice(2)).then((s) => process.stdout.write(s + '\n'), (e) => { process.stderr.write(`error: ${e.message}\n`); process.exit(2); });
