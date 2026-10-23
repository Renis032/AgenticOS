#!/usr/bin/env node
'use strict';
const { parseArgs, cli, fs, path } = require('./_util');

const ROOT = path.join(__dirname, '..');
const routingReport = require('./routing-report');
const money = (x) => `$${(x || 0).toFixed(2)}`;
const day = (t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const mins = (ms) => (ms < 3600000 ? `${Math.round(ms / 60000)} min` : `${(ms / 3600000).toFixed(1)} h`);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

function tokenSection(usage) {
  if (!usage || !usage.cur.length) return [];
  const prev = new Map(usage.prev.map((r) => [r.key, r]));
  const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
  const ctx = (r) => (r.calls ? (r.in + r.w5 + r.w1 + r.r) / r.calls : 0);
  const L = ['', '**Tokens per teammate** (API prices; cache read = context re-read on every call)'];
  const flags = [];
  for (const r of usage.cur) {
    const p = prev.get(r.key);
    const c = ctx(r), pc = p ? ctx(p) : null;
    L.push(`- ${r.key}: ${r.calls} calls · ${money(r.usd)} total · cache read ${money(r.usdR)} (${r.usd ? Math.round((r.usdR / r.usd) * 100) : 0}%) · avg context ${k(c)}` +
      (p ? ` (previous period ${k(pc)}, cache read ${money(p.usdR)})` : ' (new this period)'));
    if (c > 120000) flags.push(`${r.key} works with a large context (avg ${k(c)} per call)`);
    else if (pc && c > pc * 1.5 && c > 60000) flags.push(`${r.key}'s context grew from ${k(pc)} to ${k(c)} per call`);
  }
  if (flags.length) L.push(`Worth a look: ${flags.join('; ')}.`);
  return L;
}

function build(leadId, since, { tickets, agents, usage }) {
  const lead = agents.find((a) => a.id === leadId) || { persona: leadId };
  const mine = (t) => !t.review && (t.direct === leadId || (t.assignees || []).includes(leadId));
  const week = tickets.filter((t) => mine(t) && t.createdAt >= since);
  const before = tickets.filter((t) => mine(t) && t.createdAt < since && t.createdAt >= since - 30 * 86400000 && t.costUsd > 0);
  const staff = agents.filter((a) => a.staff && a.homeId === leadId);
  const cost = week.reduce((x, t) => x + (t.costUsd || 0), 0);
  const done = week.filter((t) => t.status === 'done');
  const bad = week.filter((t) => ['failed', 'interrupted', 'stopped'].includes(t.status));
  const up = week.filter((t) => t.rating && t.rating.score > 0), down = week.filter((t) => t.rating && t.rating.score < 0);
  const closed = week.filter((t) => t.closedAt);
  const typical = median(before.map((t) => t.costUsd));
  const spikes = week.filter((t) => t.costUsd > 2 && typical > 0 && t.costUsd > typical * 3);
  const staffWeek = staff.map((a) => ({ a, h: (a.history || []).filter((h) => h.t >= since) })).filter((x) => x.h.length);
  const staffFails = staffWeek.flatMap(({ a, h }) => h.filter((x) => !['done', 'paused'].includes(x.outcome)).map((x) => ({ a, x })));

  const reasons = [];
  if (down.length) reasons.push(`${down.length} answer${down.length > 1 ? 's' : ''} rated not good`);
  if (bad.length) reasons.push(`${bad.length} ticket${bad.length > 1 ? 's' : ''} not finished`);
  if (staffFails.length) reasons.push(`${staffFails.length} teammate task${staffFails.length > 1 ? 's' : ''} not completed`);
  const rework = week.filter((t) => t.rework), undone = week.filter((t) => t.undone);
  if (rework.length) reasons.push(`${rework.length} answer${rework.length > 1 ? 's' : ''} followed up within 2 hours (rework)`);
  if (undone.length) reasons.push(`${undone.length} job${undone.length > 1 ? 's' : ''} with changes undone`);
  if (spikes.length) reasons.push(`${spikes.length} ticket${spikes.length > 1 ? 's' : ''} cost over 3× the usual ${money(typical)}`);

  const L = [];
  L.push(`**${lead.persona}'s week, ${day(since)} – ${day(Date.now())}**`, '');
  L.push(`**Numbers:** ${week.length} ticket${week.length === 1 ? '' : 's'}, ${done.length} done${bad.length ? `, ${bad.length} not finished` : ''} · ${money(cost)} in total` +
    `${closed.length ? ` · typical time ${mins(median(closed.map((t) => t.closedAt - t.createdAt)))}` : ''}` +
    ` · rated ${up.length} 👍 / ${down.length} 👎 / ${week.length - up.length - down.length} not rated.`);
  if (typical) L.push(`Typical ticket over the previous 30 days: ${money(typical)}.`);
  if (week.length) {
    L.push('', '**Tickets**');
    for (const t of [...week].sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0)).slice(0, 10)) {
      L.push(`- #${t.n} ${t.title} — ${t.status}, ${money(t.costUsd)}${t.closedAt ? `, ${mins(t.closedAt - t.createdAt)}` : ''}${t.rating ? ` ${t.rating.score > 0 ? '👍' : '👎'}${t.rating.note ? ` “${t.rating.note}”` : ''}` : ''}${(t.changes || []).length ? `, ${t.changes.length} file${t.changes.length === 1 ? '' : 's'} changed` : ''}`);
    }
    if (week.length > 10) L.push(`- … and ${week.length - 10} more`);
  }
  if (staffWeek.length) {
    L.push('', '**Team**');
    for (const { a, h } of staffWeek.sort((x, y) => y.h.length - x.h.length)) {
      const ok = h.filter((x) => x.outcome === 'done').length;
      const usd = h.reduce((x, y) => x + (y.costUsd || 0), 0);
      L.push(`- ${a.persona} (${a.name}): ${h.length} task${h.length === 1 ? '' : 's'}, ${ok} done, ${money(usd)}`);
    }
    const idle = staff.filter((a) => !staffWeek.some((x) => x.a.id === a.id)).map((a) => a.persona);
    if (idle.length) L.push(`- No tasks this week: ${idle.join(', ')}`);
  }
  if (reasons.length) {
    L.push('', `**Needs a look:** ${reasons.join('; ')}.`);
    for (const t of down) L.push(`- #${t.n} rated 👎${t.rating.note ? `: “${t.rating.note}”` : ''}`);
    for (const t of bad) L.push(`- #${t.n} ${t.status}`);
    for (const { a, x } of staffFails) L.push(`- ${a.persona}: #${x.n || '?'} ${x.title} — ${x.outcome}`);
    for (const t of spikes) L.push(`- #${t.n} cost ${money(t.costUsd)}`);
    for (const t of rework) L.push(`- #${t.n} needed ${t.rework} follow-up${t.rework > 1 ? 's' : ''} soon after the answer`);
    for (const t of undone) L.push(`- #${t.n} had changes undone`);
  } else {
    L.push('', 'Nothing went wrong this week: no bad ratings, nothing unfinished, no cost spikes.');
  }
  L.push(...tokenSection(usage));
  const picks = routingReport.report({ days: Math.max(1, Math.round((Date.now() - since) / 86400000)), tickets: Object.values(tickets), homeId: leadId });
  if (picks.finished) L.push('', '**Model picks for this team**', ...routingReport.text(picks).split('\n').slice(1));
  return { text: L.join('\n'), needsLead: reasons.length > 0, reasons, count: week.length };
}

function run(argv) {
  const { pos, opt } = parseArgs(argv);
  if (!pos.length) return 'usage: weekly-report <lead-id> [--days 7]';
  const tickets = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tickets.json'), 'utf8')).tickets;
  const agents = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'agents.json'), 'utf8'));
  const r = build(pos[0], Date.now() - (Number(opt.days) || 7) * 86400000, { tickets, agents });
  return `${r.text}\n\n(${r.needsLead ? `the lead would be asked to review: ${r.reasons.join('; ')}` : 'no lead review needed; this report is the whole review'})`;
}

module.exports = { build };
if (require.main === module) cli(run);
