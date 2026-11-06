'use strict';
// Reports you can share: what the team did over a period, for a client, a manager or your own records. One standalone
// HTML page (inline styles, prints cleanly, opens anywhere) or Markdown to paste into an email or a doc. You choose the
// period, a team or project, and whether costs and answer summaries are included. Nothing from inside a job's thread
// goes in beyond the first lines of its answer, and anything that looks like a credential is replaced by [redacted].
// Weekly reviews, routines that found nothing and the office's own checks are left out.
const { redact } = require('./secrets');

const DAY = 86400000;

function install(ctx) {
  const { agents, now, readJson, tickets } = ctx;

  const money = (x) => `$${(x || 0).toFixed(2)}`;
  const dateOf = (t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const hours = (ms) => (ms < 3600000 ? `${Math.max(1, Math.round(ms / 60000))} min` : `${(ms / 3600000).toFixed(1)} h`);
  const personaOf = (id) => ((agents.get(id) || {}).persona || id);
  const leadOf = (t, root) => t.direct || (t.assignees || []).find((a) => a !== root) || null;

  // The first real lines of an answer, as a one or two sentence summary.
  function summary(text, max = 280) {
    const lines = String(text || '').split('\n').map((l) => l.replace(/^#+\s*|^\s*[-*]\s+|\*\*/g, '').trim()).filter((l) => l && !/^```/.test(l));
    let out = '';
    for (const l of lines) { if (out.length > max * 0.6) break; out += (out ? ' ' : '') + l; }
    out = redact(out);
    return out.length > max ? out.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : out;
  }

  // b: { days | from, to (ms or YYYY-MM-DD), lead, project, costs, summaries, title }
  function build(b = {}) {
    const roster = readJson('roster.json');
    const parse = (v, end) => { if (!v) return null; const n = Number(v); if (n > 1e11) return n; const d = new Date(String(v)); if (isNaN(d)) return null; if (end) d.setHours(23, 59, 59, 999); else d.setHours(0, 0, 0, 0); return d.getTime(); };
    const to = parse(b.to, true) || now();
    const from = parse(b.from, false) || to - Math.max(1, Math.min(366, Number(b.days) || 7)) * DAY;
    const costs = b.costs !== false && b.costs !== '0' && b.costs !== 0;
    const summaries = b.summaries !== false && b.summaries !== '0' && b.summaries !== 0;
    const list = [...tickets.values()].filter((t) => t.createdAt <= to && (t.closedAt || t.createdAt) >= from && !t.review && !t.silent && !t.selftest
      && (!b.project || t.project === b.project) && (!b.lead || leadOf(t, roster.root) === b.lead || (t.assignees || []).includes(b.lead)));
    const finished = list.filter((t) => t.closedAt && t.closedAt >= from && t.closedAt <= to);
    const done = finished.filter((t) => t.status === 'done');
    const notDone = finished.filter((t) => ['failed', 'stopped', 'interrupted'].includes(t.status));
    const open = list.filter((t) => ['open', 'paused', 'scheduled'].includes(t.status));
    const spent = list.reduce((x, t) => x + (t.costUsd || 0), 0);
    const ok = done.filter((t) => !(t.rating && t.rating.score < 0) && !t.undone && !(t.verify && t.verify.status === 'failed'));
    const checked = done.filter((t) => t.verify && t.verify.status === 'passed').length;
    const group = (key) => {
      const m = new Map();
      for (const t of list) { const k = key(t); if (!k) continue; const g = m.get(k) || { name: k, jobs: 0, done: 0, cost: 0 }; g.jobs++; if (t.status === 'done') g.done++; g.cost += t.costUsd || 0; m.set(k, g); }
      return [...m.values()].sort((a, c) => c.jobs - a.jobs);
    };
    const roomOf = (l) => ((roster.roles[l] || roster.roles[(agents.get(l) || {}).role] || {}).room || '');
    const teams = group((t) => { const l = leadOf(t, roster.root); return l ? `${personaOf(l)} · ${roomOf(l)}`.replace(/ · $/, '') : null; });
    const projects = group((t) => t.project || null);
    const item = (t) => ({ n: t.n, title: redact(t.title || summary(t.text, 90)), project: t.project || null, lead: leadOf(t, roster.root) ? personaOf(leadOf(t, roster.root)) : null,
      status: t.status, closedAt: t.closedAt || null, took: t.closedAt ? hours(t.closedAt - t.createdAt) : null, checked: !!(t.verify && t.verify.status === 'passed'),
      cost: costs ? t.costUsd || 0 : undefined, summary: summaries ? summary(t.answer) : undefined, routine: !!t.routine });
    const scope = [b.lead ? `${personaOf(b.lead)}'s team` : null, b.project || null].filter(Boolean).join(' · ') || 'All teams';
    return {
      title: String(b.title || '').trim().slice(0, 120) || `What the team did · ${scope}`, scope, from, to, generatedAt: now(), costs, summaries,
      totals: { jobs: list.length, finished: finished.length, done: done.length, notDone: notDone.length, open: open.length, checked, succeeded: ok.length,
        ...(costs ? { cost: spent, perSuccess: ok.length ? spent / ok.length : null } : {}) },
      teams: teams.map((g) => ({ ...g, cost: costs ? g.cost : undefined })), projects: projects.map((g) => ({ ...g, cost: costs ? g.cost : undefined })),
      done: done.sort((a, c) => c.closedAt - a.closedAt).map(item), notDone: notDone.map(item), open: open.map(item),
    };
  }

  function markdown(r) {
    const L = [`# ${r.title}`, '', `${dateOf(r.from)} – ${dateOf(r.to)} · ${r.scope}`, ''];
    const T = r.totals;
    L.push(`**${T.done} done**${T.notDone ? ` · ${T.notDone} not finished` : ''}${T.open ? ` · ${T.open} in progress` : ''}${T.checked ? ` · ${T.checked} passed their checks` : ''}` +
      (r.costs ? ` · ${money(T.cost)} in total${T.perSuccess != null ? ` (${money(T.perSuccess)} per successful job)` : ''}` : ''), '');
    const row = (x) => `- **#${x.n} ${x.title}**${x.project ? ` · ${x.project}` : ''}${x.lead ? ` · ${x.lead}` : ''}${x.took ? ` · ${x.took}` : ''}${x.checked ? ' · checks passed' : ''}${r.costs ? ` · ${money(x.cost)}` : ''}${x.summary ? `\n  ${x.summary}` : ''}`;
    if (r.done.length) L.push('## Done', '', ...r.done.map(row), '');
    if (r.notDone.length) L.push('## Not finished', '', ...r.notDone.map((x) => `${row(x)} (${x.status})`), '');
    if (r.open.length) L.push('## In progress', '', ...r.open.map(row), '');
    if (r.teams.length > 1) L.push('## By team', '', ...r.teams.map((g) => `- ${g.name}: ${g.jobs} jobs, ${g.done} done${r.costs ? `, ${money(g.cost)}` : ''}`), '');
    if (r.projects.length > 1) L.push('## By project', '', ...r.projects.map((g) => `- ${g.name}: ${g.jobs} jobs, ${g.done} done${r.costs ? `, ${money(g.cost)}` : ''}`), '');
    if (!r.totals.jobs) L.push('No jobs in this period.', '');
    L.push(`_Made with Agentic OS on ${dateOf(r.generatedAt)}.${r.costs ? ' Costs are at Anthropic API prices.' : ''}_`);
    return L.join('\n');
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function html(r) {
    const T = r.totals;
    const stat = (v, l) => `<div class="stat"><b>${esc(v)}</b><span>${esc(l)}</span></div>`;
    const job = (x, tag) => `<li><div class="jt"><b>#${x.n} ${esc(x.title)}</b>${tag ? `<span class="tag ${esc(x.status)}">${esc(tag)}</span>` : ''}</div>
      <div class="meta">${[x.project, x.lead, x.took, x.checked ? 'checks passed' : null, r.costs ? money(x.cost) : null].filter(Boolean).map(esc).join(' · ')}</div>${x.summary ? `<p>${esc(x.summary)}</p>` : ''}</li>`;
    const sec = (h, items, tag) => (items.length ? `<section><h2>${esc(h)} <small>${items.length}</small></h2><ul class="jobs">${items.map((x) => job(x, tag && tag(x))).join('')}</ul></section>` : '');
    const tbl = (h, rows) => (rows.length > 1 ? `<section><h2>${esc(h)}</h2><table><thead><tr><th></th><th>Jobs</th><th>Done</th>${r.costs ? '<th>Cost</th>' : ''}</tr></thead><tbody>${rows.map((g) => `<tr><td>${esc(g.name)}</td><td>${g.jobs}</td><td>${g.done}</td>${r.costs ? `<td>${money(g.cost)}</td>` : ''}</tr>`).join('')}</tbody></table></section>` : '');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(r.title)}</title>
<style>
:root { --bg: #faf9f6; --panel: #fff; --text: #1d1c1a; --muted: #6b665e; --line: #e6e2da; --accent: #8a6a2f; --ok: #2f7a4b; --bad: #a33a2c; }
@media (prefers-color-scheme: dark) { :root { --bg: #17161a; --panel: #1f1e23; --text: #ecebe8; --muted: #a29d94; --line: #34323a; --accent: #d1b06b; --ok: #6cc28f; --bad: #e0806f; } }
* { box-sizing: border-box; } body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 40px 20px 60px; } h1 { font-size: 26px; margin: 0 0 4px; } .sub { color: var(--muted); margin: 0 0 24px; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin-bottom: 28px; }
.stat { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; } .stat b { display: block; font-size: 22px; } .stat span { color: var(--muted); font-size: 13px; }
h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 28px 0 10px; } h2 small { font-weight: 400; }
ul.jobs { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; } ul.jobs li { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
.jt { display: flex; gap: 8px; align-items: baseline; justify-content: space-between; } .meta { color: var(--muted); font-size: 13px; margin-top: 2px; } ul.jobs p { margin: 6px 0 0; }
.tag { font-size: 12px; border-radius: 99px; padding: 1px 8px; border: 1px solid var(--line); color: var(--muted); white-space: nowrap; } .tag.failed, .tag.stopped, .tag.interrupted { color: var(--bad); }
table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; } th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); } th { color: var(--muted); font-weight: 500; font-size: 13px; } tr:last-child td { border-bottom: 0; } td:not(:first-child), th:not(:first-child) { text-align: right; }
footer { color: var(--muted); font-size: 12px; margin-top: 36px; } @media print { body { background: #fff; } ul.jobs li, .stat, table { break-inside: avoid; } }
@media (max-width: 520px) { main { padding: 24px 16px 40px; } .jt { flex-direction: column; } }
</style></head><body><main>
<h1>${esc(r.title)}</h1><p class="sub">${esc(dateOf(r.from))} – ${esc(dateOf(r.to))} · ${esc(r.scope)}</p>
<div class="stats">${stat(T.done, 'done')}${T.notDone ? stat(T.notDone, 'not finished') : ''}${T.open ? stat(T.open, 'in progress') : ''}${T.checked ? stat(T.checked, 'passed their checks') : ''}${r.costs ? stat(money(T.cost), 'in total') + (T.perSuccess != null ? stat(money(T.perSuccess), 'per successful job') : '') : ''}</div>
${sec('Done', r.done)}${sec('Not finished', r.notDone, (x) => x.status)}${sec('In progress', r.open, (x) => x.status)}${tbl('By team', r.teams)}${tbl('By project', r.projects)}
${T.jobs ? '' : '<p>No jobs in this period.</p>'}
<footer>Made with Agentic OS on ${esc(dateOf(r.generatedAt))}.${r.costs ? ' Costs are at Anthropic API prices.' : ''}</footer>
</main></body></html>`;
  }

  async function route(req, res, url, p, body, json) {
    if (p !== '/api/reports' || req.method !== 'GET') return false;
    const q = Object.fromEntries(url.searchParams);
    const r = build(q);
    const fmt = q.format || 'json';
    if (fmt === 'json') return json(res, 200, r), true;
    const text = fmt === 'md' ? markdown(r) : html(r);
    const name = `agentos-report-${new Date(r.from).toISOString().slice(0, 10)}-to-${new Date(r.to).toISOString().slice(0, 10)}.${fmt === 'md' ? 'md' : 'html'}`;
    res.writeHead(200, { 'content-type': fmt === 'md' ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8',
      ...(q.download ? { 'content-disposition': `attachment; filename="${name}"` } : {}) });
    res.end(text);
    return true;
  }

  return { build, markdown, html, route };
}

module.exports = { install };
