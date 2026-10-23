#!/usr/bin/env node
'use strict';
const { parseArgs, cli, fs, path } = require('./_util');

const ROOT = path.join(__dirname, '..');
const MODELS = ['haiku', 'sonnet', 'opus'];
const OPTIONS = [['haiku', 'low'], ['haiku', 'medium'], ['sonnet', 'medium'], ['sonnet', 'high'], ['opus', 'medium'], ['opus', 'high'], ['opus', 'xhigh']];
const PRIOR = {
  easy: { haiku: 0.85, sonnet: 0.93, opus: 0.96 },
  medium: { haiku: 0.55, sonnet: 0.85, opus: 0.92 },
  hard: { haiku: 0.25, sonnet: 0.65, opus: 0.88 },
};
const EFFORT_P = { low: -0.05, medium: 0, high: 0.03, xhigh: 0.05, max: 0.06 };
const EFFORT_COST = { low: 0.6, medium: 1, high: 1.4, xhigh: 1.9, max: 2.5 };
const MODEL_COST = { haiku: 0.2, sonnet: 0.6, opus: 1 };
const PRIOR_WEIGHT = 4;
const DEFAULT_VALUES = { easy: 1, medium: 4, hard: 12 };
const DAMAGE = { easy: 0.1, medium: 0.25, hard: 0.5 };

const HARD = /\b(root cause|design|architect|implement|refactor|review|regression|recovery|race condition|debug|fix|why does|why is|migrat|security|concurren)/i;
const EASY = /\b(find|list|count|locate|grep|read|summari[sz]e|collect|which file|where is|look up|check whether|enumerate)\b/i;

function difficulty(roleDef, text) {
  let d = !roleDef ? 1 : roleDef.model === 'opus' ? 2 : roleDef.model === 'haiku' ? 0 : roleDef.effort === 'high' ? 1.5 : 1;
  const t = String(text || '');
  if (HARD.test(t)) d += 0.75;
  if (EASY.test(t) && !HARD.test(t)) d -= 0.75;
  return d >= 1.75 ? 'hard' : d <= 0.5 ? 'easy' : 'medium';
}

const roleKey = (a) => (a.role === 'custom' ? `custom:${(a.name || '').toLowerCase()}` : a.role);

function records(agents, tickets, key) {
  const tk = new Map(tickets.map((t) => [t.id, t]));
  const out = [];
  for (const a of agents) {
    if (!a.staff) continue;
    for (const h of a.history || []) {
      if (!h.model || h.outcome === 'paused') continue;
      const [model, effort] = h.model.split('/');
      const t = tk.get(h.ticketId);
      let ok = h.outcome === 'done' ? 1 : 0;
      if (ok && t && t.rating && t.rating.score < 0) ok = 0.5;
      // Signals the user gives without rating: a follow-up soon after "done" means rework; undone changes mean the work was wrong.
      if (ok && t && t.undone) ok = Math.min(ok, 0.4);
      if (ok && t && t.rework) ok = Math.min(ok, 0.7);
      out.push({ role: roleKey(a), model, effort, ok, cost: h.costUsd || 0 });
    }
  }
  return { mine: out.filter((r) => r.role === key), all: out };
}

function choose({ role, roleDef, name, task, agents, tickets, capModel, values, utilization }) {
  const key = role === 'custom' ? `custom:${(name || '').toLowerCase()}` : role;
  const diff = difficulty(roleDef, task);
  const V = (values || DEFAULT_VALUES)[diff];
  const { mine, all } = records(agents || [], tickets || [], key);
  const opusCosts = all.filter((r) => r.model === 'opus' && r.cost > 0).map((r) => r.cost / EFFORT_COST[r.effort || 'high']).sort((a, b) => a - b);
  const base = opusCosts.length ? opusCosts[Math.floor(opusCosts.length / 2)] : 1.2;
  const pressure = utilization > 0.7 ? 1 + 2 * Math.min(1, (utilization - 0.7) / 0.3) : 1;
  const cap = MODELS.indexOf(capModel || 'opus');
  const rows = [];
  for (const [model, effort] of OPTIONS) {
    if (MODELS.indexOf(model) > cap) continue;
    const seen = mine.filter((r) => r.model === model);
    const prior = Math.min(0.98, PRIOR[diff][model] + (EFFORT_P[effort] || 0));
    const p = (prior * PRIOR_WEIGHT + seen.reduce((x, r) => x + r.ok, 0)) / (PRIOR_WEIGHT + seen.length);
    const seenCost = seen.filter((r) => r.cost > 0);
    const cost = (seenCost.length >= 2
      ? (seenCost.reduce((x, r) => x + r.cost / EFFORT_COST[r.effort || 'medium'], 0) / seenCost.length) * EFFORT_COST[effort]
      : base * MODEL_COST[model] * EFFORT_COST[effort]) * pressure;
    rows.push({ model, effort, p, cost, n: seen.length });
  }
  for (const r of rows) {
    const better = rows.filter((x) => x.p > r.p + 0.02).sort((a, b) => a.cost - b.cost)[0];
    const retry = better ? better.cost : r.cost;
    r.ev = r.p * V - r.cost - (1 - r.p) * (retry + DAMAGE[diff] * V);
  }
  rows.sort((a, b) => b.ev - a.ev || a.cost - b.cost);
  const best = rows[0];
  const runner = rows[1];
  const reason = `${diff} task worth ~$${V}; ${best.model}/${best.effort}: success ${Math.round(best.p * 100)}%${best.n ? ` (${best.n} past task${best.n === 1 ? '' : 's'} for this role)` : ' (no history yet, prior)'}, ~$${best.cost.toFixed(2)}, EV $${best.ev.toFixed(2)}` +
    (runner ? ` vs ${runner.model}/${runner.effort} EV $${runner.ev.toFixed(2)}` : '') + (pressure > 1 ? `; costs weighted ×${pressure.toFixed(1)} because the usage limit is at ${Math.round(utilization * 100)}%` : '');
  return { model: best.model, effort: best.effort, difficulty: diff, value: V, rows, reason };
}

function run(argv) {
  const { pos, opt } = parseArgs(argv);
  if (pos.length < 2) return 'usage: choose-model <role> "<task brief>" [--cap opus|sonnet|haiku] [--name <custom role name>]';
  const roster = JSON.parse(fs.readFileSync(path.join(ROOT, 'roster.json'), 'utf8'));
  const agents = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'agents.json'), 'utf8'));
  const tickets = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tickets.json'), 'utf8')).tickets;
  let utilization = 0;
  try { const l = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'limits.json'), 'utf8')); utilization = Math.max(0, ...Object.values(l.windows || {}).map((w) => (w.resetsAt > Date.now() ? w.utilization : 0))); } catch {}
  const r = choose({ role: pos[0], roleDef: roster.roles[pos[0]], name: opt.name, task: pos.slice(1).join(' '), agents, tickets, capModel: opt.cap, values: roster.defaults.taskValueUsd, utilization });
  return [`→ ${r.model}/${r.effort}  (${r.difficulty}, value of a good result $${r.value})`, r.reason, '',
    'option           success   cost     EV      history',
    ...r.rows.map((x) => `${(x.model + '/' + x.effort).padEnd(16)} ${String(Math.round(x.p * 100) + '%').padStart(6)}  $${x.cost.toFixed(2).padStart(5)}  ${(x.ev >= 0 ? ' ' : '') + '$' + x.ev.toFixed(2)}   ${x.n}`)].join('\n');
}

module.exports = { choose, difficulty };
if (require.main === module) cli(run);
