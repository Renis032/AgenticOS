#!/usr/bin/env node
'use strict';
// How each model pick turned out: Jev vs EV vs overrides vs pins, joined from routing.jsonl and outcomes.jsonl.
const { parseArgs, cli, fs, path } = require('./_util');

const ROOT = path.join(__dirname, '..');
const LABEL = { jev: 'Jev', 'jev-cache': 'Jev (reused)', ev: 'EV model', 'ev-override': 'EV overruled Jev', pin: 'Pinned by lead' };
const readJsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };

function report({ days, dir, tickets, homeId } = {}) {
  const D = dir || path.join(ROOT, 'data', 'arms');
  const since = Date.now() - (days || 7) * 86400000;
  const picks = new Map(readJsonl(path.join(D, 'routing.jsonl')).filter((p) => p.pickId && p.t >= since && !p.error).map((p) => [p.pickId, p]));
  const T = new Map((tickets || []).map((t) => [t.id, t]));
  const outs = readJsonl(path.join(D, 'outcomes.jsonl')).filter((o) => picks.has(o.pickId) && (!homeId || o.homeId === homeId));
  const tries = new Map();
  for (const o of outs) { const k = `${o.ticketId}|${o.role}`; tries.set(k, (tries.get(k) || 0) + 1); }
  const by = {};
  for (const o of outs) {
    const p = picks.get(o.pickId);
    const src = p.source || o.source || '?';
    const g = by[src] || (by[src] = { source: src, label: LABEL[src] || src, n: 0, done: 0, cost: 0, ms: 0, msN: 0, good: 0, bad: 0, sentBack: 0, retried: 0, models: {} });
    const t = T.get(o.ticketId);
    g.n++;
    if (o.outcome === 'done') g.done++;
    g.cost += o.costUsd || 0;
    if (o.ms) { g.ms += o.ms; g.msN++; }
    if (t && t.rating) { if (t.rating.score > 0) g.good++; else g.bad++; }
    if (t && (t.thread || []).some((e, i, all) => e.kind === 'user' && all.slice(0, i).some((x) => x.kind === 'answer'))) g.sentBack++;
    if ((tries.get(`${o.ticketId}|${o.role}`) || 0) > 1) g.retried++;
    const m = `${o.model}/${o.effort}`;
    g.models[m] = (g.models[m] || 0) + 1;
  }
  const rows = Object.values(by).map((g) => ({ ...g, doneRate: g.n ? g.done / g.n : 0, avgCost: g.n ? g.cost / g.n : 0, avgMin: g.msN ? g.ms / g.msN / 60000 : null,
    sentBackRate: g.n ? g.sentBack / g.n : 0, retryRate: g.n ? g.retried / g.n : 0 })).sort((a, b) => b.n - a.n);
  const pending = [...picks.values()].filter((p) => !outs.some((o) => o.pickId === p.pickId)).length;
  return { days: days || 7, rows, picks: picks.size, finished: outs.length, pending, verdict: verdict(rows) };
}

function verdict(rows) {
  const j = rows.filter((r) => r.source === 'jev' || r.source === 'jev-cache');
  const e = rows.find((r) => r.source === 'ev');
  const jn = j.reduce((a, r) => a + r.n, 0);
  if (!jn || !e || jn < 5 || e.n < 5) return 'Not enough finished tasks yet to compare Jev and the EV model (needs 5 of each).';
  const jd = j.reduce((a, r) => a + r.done, 0) / jn, jc = j.reduce((a, r) => a + r.cost, 0) / jn;
  const better = jd >= e.doneRate - 0.05 && jc <= e.avgCost * 1.1 ? 'Jev is doing at least as well as the EV model' : jd < e.doneRate - 0.1 ? 'Jev finishes fewer tasks than the EV model' : 'Jev costs more per task than the EV model';
  return `${better}: Jev ${Math.round(jd * 100)}% done at $${jc.toFixed(2)}/task vs EV ${Math.round(e.doneRate * 100)}% at $${e.avgCost.toFixed(2)}/task.`;
}

function text(r) {
  const L = [`Model picks, last ${r.days} days: ${r.picks} picks, ${r.finished} finished tasks${r.pending ? `, ${r.pending} still running or never started` : ''}.`];
  for (const g of r.rows) {
    L.push(`- ${g.label}: ${g.n} tasks, ${Math.round(g.doneRate * 100)}% done, $${g.avgCost.toFixed(2)}/task${g.avgMin != null ? `, ${g.avgMin.toFixed(1)} min` : ''}` +
      `, rated ${g.good}👍/${g.bad}👎, sent back ${Math.round(g.sentBackRate * 100)}%, retried ${Math.round(g.retryRate * 100)}% · ${Object.entries(g.models).map(([m, n]) => `${m}×${n}`).join(' ')}`);
  }
  L.push(r.verdict);
  return L.join('\n');
}

function run(argv) {
  const { opt } = parseArgs(argv);
  let tickets = [];
  try { tickets = Object.values(JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tickets.json'), 'utf8')).tickets || {}); } catch {}
  const r = report({ days: Number(opt.days) || 7, tickets, homeId: opt.lead });
  return opt.json ? JSON.stringify(r, null, 1) : text(r);
}

module.exports = { report, text };
if (require.main === module) cli(run);
