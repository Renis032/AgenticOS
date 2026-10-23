#!/usr/bin/env node
'use strict';
// The facts for a project handoff, so the lead only writes the judgement: jobs, files changed, commands run, costs.
const { parseArgs, cli, fs, path } = require('./_util');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const PROJECTS = path.join(os.homedir(), 'Personal', 'Projects');
const tilde = (p) => String(p || '').replace(os.homedir(), '~');
const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : '?');

function tickets() {
  try { const t = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tickets.json'), 'utf8')); return Array.isArray(t) ? t : Object.values(t.tickets || t); } catch { return []; }
}
const words = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function mentions(t, name) {
  if ((t.handoffs || []).includes(name)) return true;
  const text = ` ${words(`${t.title} ${t.text}`)} `;
  const spaced = words(name.replace(/([a-z0-9])([A-Z])/g, '$1 $2'));
  return [words(name), spaced, spaced.replace(/ /g, '')].some((v) => v && text.includes(` ${v} `));
}

function jobFacts(t, out) {
  out.push(`#${t.n} ${t.title} · ${t.status} · opened ${day(t.createdAt)}${t.closedAt ? `, closed ${day(t.closedAt)}` : ''} · cost $${(t.costUsd || 0).toFixed(2)}`);
  const changed = (t.changes || []).filter((c) => !c.revertedAt);
  if (changed.length) out.push(`  files changed (${changed.length}): ${changed.slice(0, 25).map((c) => tilde(c.path)).join(', ')}${changed.length > 25 ? ', …' : ''}`);
  const cmds = (t.commands || []).filter((c) => c.status !== 'pending');
  for (const c of cmds.slice(-15)) out.push(`  $ ${c.command.replace(/\s+/g, ' ').slice(0, 160)}  [${c.status}${c.exitCode != null && c.exitCode !== 0 ? ` exit ${c.exitCode}` : ''}, in ${tilde(c.cwd)}]`);
  if (t.plan) out.push(`  plan: ${t.plan.status}, estimated $${(t.plan.estimateUsd || 0).toFixed(2)}`);
  if (t.answer) out.push(`  answer: ${String(t.answer).replace(/\s+/g, ' ').slice(0, 400)}${t.answer.length > 400 ? '…' : ''}`);
  const asked = t.thread.filter((e) => e.kind === 'question' || e.kind === 'reply').slice(-6);
  for (const e of asked) out.push(`  ${e.kind === 'question' ? 'asked' : 'you said'}: ${String(e.text).replace(/\s+/g, ' ').slice(0, 200)}`);
}

function run(argv) {
  const { pos } = parseArgs(argv);
  const arg = String(pos[0] || '').replace(/^#/, '');
  if (!arg) return 'usage: handoff-facts <#job | ProjectFolder>\n  The facts for save_project_handoff: jobs, files changed, commands and their results, questions and answers, costs.';
  const all = tickets().sort((a, b) => a.createdAt - b.createdAt);
  const out = [];
  if (/^\d+$/.test(arg)) {
    const t = all.find((x) => x.n === Number(arg));
    if (!t) return `No job #${arg}.`;
    jobFacts(t, out);
    return out.join('\n');
  }
  const name = (fs.existsSync(PROJECTS) ? fs.readdirSync(PROJECTS) : []).find((d) => d.toLowerCase() === arg.toLowerCase()) || arg;
  const jobs = all.filter((t) => mentions(t, name));
  out.push(`${name}: ${jobs.length} job${jobs.length === 1 ? '' : 's'}, $${jobs.reduce((s, t) => s + (t.costUsd || 0), 0).toFixed(2)} in total`);
  for (const t of jobs) { out.push(''); jobFacts(t, out); }
  const worked = new Map();
  for (const t of jobs) for (const c of t.commands || []) if (c.status === 'done') worked.set(`${c.cwd}|${c.command.replace(/\d{4,}/g, '#')}`, c);
  if (worked.size) out.push('', 'Commands that worked (most recent last):', ...[...worked.values()].slice(-12).map((c) => `  ${tilde(c.cwd)}$ ${c.command.replace(/\s+/g, ' ').slice(0, 200)}`));
  return out.join('\n');
}

module.exports = { run, mentions };
if (require.main === module) cli(run);
