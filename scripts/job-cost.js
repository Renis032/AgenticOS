#!/usr/bin/env node
'use strict';
// Where a job's usage went: per agent and model, cache reads vs writes vs output, context size, and what filled the context.
const { parseArgs, cli, fs, path } = require('./_util');
const usage = require('./usage-index');

const ROOT = path.join(__dirname, '..');
const M = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const $ = (n) => `$${(n || 0).toFixed(2)}`;
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '0%');

function tickets() {
  try { const t = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tickets.json'), 'utf8')); return Array.isArray(t) ? t : Object.values(t.tickets || t); } catch { return []; }
}

async function report(n, top) {
  const t = tickets().find((x) => x.n === n);
  const o = await usage.overview({ ticket: n });
  const T = o.total;
  if (!T.calls) return `No model calls found for job #${n}${t ? ` (“${t.title}”)` : ''}. (Calls are matched through Claude Code's transcripts in ~/.claude/projects.)`;
  const ctxPer = (r) => Math.round((r.in + r.w5 + r.w1 + r.r) / Math.max(1, r.calls));
  const out = [`Job #${n}${t ? `: ${t.title} (${t.status})` : ''}`,
    `${T.calls} model calls · ${M(T.tokens)} tokens · ${$(T.usd)} at API prices${t && t.costUsd != null ? ` (the job header shows ${$(t.costUsd)})` : ''}`,
    `  re-reading cached context ${$(T.usdR)} (${pct(T.usdR, T.usd)}) · writing the cache ${$(T.usdW)} (${pct(T.usdW, T.usd)}) · output and thinking ${$(T.usdOut)} (${pct(T.usdOut, T.usd)})`,
    '', 'By agent:'];
  for (const r of o.dims.agent.slice(0, top)) out.push(`  ${r.key.padEnd(14)} ${String(r.calls).padStart(4)} calls  ${$(r.usd).padStart(8)}  avg context ${M(ctxPer(r)).padStart(5)}  read ${$(r.usdR)} · write ${$(r.usdW)} · out ${$(r.usdOut)}`);
  out.push('', 'By model:', ...o.dims.model.map((r) => `  ${r.key.padEnd(14)} ${String(r.calls).padStart(4)} calls  ${$(r.usd).padStart(8)}  (${pct(r.usd, T.usd)})`));
  out.push('', 'What filled the context (share of all tokens sent):', ...o.context.slice(0, 8).map((c) => `  ${pct(c.share, 1).padStart(4)}  ${c.label}`));
  out.push('', 'Tools by context they added (carried = re-read on every later call):', ...o.tools.slice(0, 8).map((x) => `  ${x.key.padEnd(30)} ${String(x.n).padStart(4)}×  added ${M(x.tokens).padStart(5)}  carried ${M(x.carried)}`));
  if (o.biggest && o.biggest.length) out.push('', 'Single items that cost the most to carry:', ...o.biggest.slice(0, 5).map((b) => `  ${M(b.tok).padStart(5)}  ${b.label}`));
  const advice = [];
  const lead = o.dims.role.find((r) => /lead/.test(r.key));
  if (T.usdR / T.usd > 0.4) advice.push(`Most of the spend is re-reading context. ${lead ? `The lead averaged ${M(ctxPer(lead))} per call; ` : ''}a fresh session sooner (defaults.refreshContextTokens) or delegating long reads would cut it.`);
  if (T.w1 > T.w5 && T.usdW / T.usd > 0.2) advice.push('Cache writes use the 1-hour cache (2× the price of the 5-minute one). Worth it only when calls are more than 5 minutes apart.');
  const write = o.context.find((c) => c.key === 'claude:input');
  if (write && write.share > 0.2) advice.push(`${pct(write.share, 1)} of the context is the agents' own Write/Edit text being carried along: prefer Edit over rewriting whole files.`);
  const read = o.tools.find((x) => x.key === 'Read');
  if (read && read.carried > T.tokens * 0.15) advice.push('Whole-file reads are a large share: use the show and outline scripts to read only the lines needed.');
  const opusStaff = o.dims.agent.filter((r) => !/lead/.test((o.dims.role.find((x) => x.key === r.key) || {}).key || '')).length;
  if (o.dims.model.find((m) => /opus/.test(m.key)) && o.dims.model.length > 1 && opusStaff) advice.push('Check whether the Opus teammates needed Opus; job-cost per teammate is listed above.');
  if (advice.length) out.push('', 'Where to save:', ...advice.map((a) => `  - ${a}`));
  return out.join('\n');
}

// Exact cost of every job in one pass (for the server's background refresh): [{ n, usd, calls }].
async function allJobs(days) {
  const o = await usage.overview({ days: days || 60 });
  return o.dims.ticket.map((r) => ({ n: Number(String(r.key).replace('#', '')), usd: Math.round(r.usd * 100) / 100, calls: r.calls })).filter((r) => r.n);
}

async function run(argv) {
  const { pos, opt } = parseArgs(argv);
  if (opt.all) return JSON.stringify(await allJobs(Number(opt.days) || 60));
  const n = Number(String(pos[0] || '').replace(/^#/, ''));
  if (!n) return 'usage: job-cost <#job> [--top N]   where a job\'s usage went, and where to save';
  return report(n, Number(opt.top) || 12);
}

module.exports = { run, report, allJobs };
if (require.main === module) run(process.argv.slice(2)).then((s) => process.stdout.write(s + '\n'), (e) => { process.stderr.write(`error: ${e.message}\n`); process.exit(2); });
