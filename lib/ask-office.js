'use strict';
// Ask the office: questions about the office itself ("what did Renko do yesterday?", "why did #37 cost $22?", "where
// are my notes on the RGB config?"). The facts are gathered here without a model: a snapshot of the office, recent and
// matching jobs, the cost breakdown of any job the question names, and matching memories and library pages. Haiku only
// words the answer from those facts and cites jobs as #N, so an answer costs about a cent.
const jobCost = require('../scripts/job-cost');

const STOP = new Set(['what', 'when', 'where', 'which', 'who', 'why', 'how', 'did', 'does', 'the', 'and', 'for', 'was', 'were', 'are', 'is',
  'that', 'this', 'with', 'from', 'have', 'has', 'about', 'much', 'many', 'yesterday', 'today', 'week', 'job', 'jobs', 'office', 'can', 'you', 'my']);
const FACTS_MAX = 24000;

function install(ctx) {
  const { CLAUDE_BIN, MEMORY_DIR, agents, childEnv, fs, noteSpend, now, path, readJson, searchTickets, spawn, teamsList, tickets } = ctx;

  const terms = (q) => [...new Set(String(q).toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) || [])].filter((w) => !STOP.has(w));
  const day = (t) => (t ? new Date(t).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '?');
  const money = (v) => `$${(v || 0).toFixed(2)}`;
  const owners = (t) => [...new Set([t.direct, ...(t.assignees || [])].filter(Boolean))].map((k) => (agents.get(k) || {}).persona || k).join(', ') || 'routing';
  const needsYou = (t) => !!(t.waiting || (t.plan && t.plan.status === 'pending') || (t.commands || []).some((c) => c.status === 'pending') || (t.access || []).some((r) => r.status === 'pending'));
  const jobLine = (t) => `#${t.n} “${t.title}” · ${t.status}${needsYou(t) ? ' (needs the user)' : ''} · ${owners(t)} · ${money(t.costUsd)} · opened ${day(t.createdAt)}${t.closedAt ? ` · closed ${day(t.closedAt)}` : ''}${(t.changes || []).length ? ` · ${t.changes.length} files changed` : ''}${t.project ? ` · project ${t.project}` : ''}`;

  function snapshot() {
    const roster = readJson('roster.json');
    const all = [...tickets.values()];
    const since = (ms) => all.filter((t) => (t.closedAt || t.createdAt) > now() - ms).reduce((s, t) => s + (t.costUsd || 0), 0);
    const leads = roster.residents.map((k) => agents.get(k)).filter(Boolean).concat([...agents.values()].filter((a) => a.twinOf && !a.retired));
    const out = [`Now: ${day(now())}.`, `Spend at API prices: last 24 h ${money(since(86400000))}, last 7 days ${money(since(7 * 86400000))}, all time ${money(all.reduce((s, t) => s + (t.costUsd || 0), 0))} over ${all.length} jobs.`, 'Leads:'];
    for (const a of leads) {
      const cur = a.current && a.current.ticketId && tickets.get(a.current.ticketId);
      out.push(`- ${a.persona} (${a.id === roster.root ? 'dispatcher' : (roster.roles[a.twinOf || a.id] || {}).name || a.id}${a.twinOf ? ', a parallel desk' : ''}): ${a.status}${cur ? `, working on #${cur.n}` : ''}${(a.inbox || []).length ? `, ${a.inbox.length} waiting in its inbox` : ''}; ${a.ticketsHandled || 0} jobs handled, ${money(a.costUsd)} spent`);
    }
    const open = all.filter((t) => ['open', 'paused', 'scheduled'].includes(t.status));
    out.push(`Open jobs (${open.length}):`, ...open.slice(0, 15).map((t) => `- ${jobLine(t)}`));
    const staff = [...agents.values()].filter((a) => a.staff && !a.retired);
    if (staff.length) out.push(`Staff (${staff.length}): ${staff.slice(0, 20).map((a) => `${a.persona} (${a.role === 'custom' ? a.name : a.role}, ${a.tasksDone || 0} done)`).join('; ')}`);
    return out.join('\n');
  }

  function recent() {
    const list = [...tickets.values()].filter((t) => (t.closedAt || t.updatedAt || t.createdAt) > now() - 3 * 86400000).sort((a, b) => (b.closedAt || b.createdAt) - (a.closedAt || a.createdAt));
    return list.length ? list.slice(0, 15).map((t) => `- ${jobLine(t)}`).join('\n') : '(none)';
  }

  async function named(t, aboutCost) {
    const team = [...agents.values()].filter((a) => (a.tickets || []).includes(t.id) || a.id === t.direct || (t.assignees || []).includes(a.id));
    const out = [jobLine(t), `Asked: ${String(t.text || '').slice(0, 500)}`,
      `Worked on by: ${team.map((a) => `${a.persona} (${a.role === 'custom' ? a.name : a.role}${a.model ? `, ${a.model}` : ''})`).join('; ') || 'nobody yet'}`];
    if ((t.changes || []).length) out.push(`Files changed: ${t.changes.slice(0, 15).map((c) => c.path).join(', ')}`);
    if (t.rating) out.push(`User rating: ${t.rating.score > 0 ? 'good' : 'not good'}${t.rating.note ? ` (“${t.rating.note}”)` : ''}`);
    if (t.plan) out.push(`Plan: ${t.plan.status}, estimated ${money(t.plan.estimateUsd)}`);
    if (t.answer) out.push(`Answer (start): ${String(t.answer).slice(0, 1500)}`);
    if (aboutCost) {
      const rep = await Promise.race([jobCost.report(t.n, 6).catch(() => ''), new Promise((r) => setTimeout(() => r(''), 15000))]);
      if (rep) out.push(`Cost breakdown (office script job-cost):\n${String(rep).slice(0, 3000)}`);
    }
    return out.join('\n');
  }

  // The best passages of text files for the question's words: each file split into paragraphs, scored by the words
  // it contains, highest first.
  function passages(files, words, limit) {
    const found = [];
    for (const f of files) {
      let text = '';
      try { if (fs.statSync(f.path).size > 400000) continue; text = fs.readFileSync(f.path, 'utf8'); } catch { continue; }
      for (const para of text.split(/\n\s*\n/)) {
        const low = para.toLowerCase();
        const score = words.reduce((s, w) => s + (low.includes(w) ? 1 + Math.min(3, low.split(w).length - 2) * 0.25 : 0), 0);
        if (score >= Math.min(2, words.length)) found.push({ score, label: f.label, text: para.trim().slice(0, 700) });
      }
    }
    return found.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async function facts(question) {
    const words = terms(question);
    const nums = [...new Set((String(question).match(/#(\d+)/g) || []).map((x) => Number(x.slice(1))))];
    const byN = (n) => [...tickets.values()].find((t) => t.n === n);
    const aboutCost = /cost|expensive|spen[dt]|price|\$|money|tokens?/i.test(question);
    const parts = [`## The office now\n${snapshot()}`, `## Jobs in the last 3 days\n${recent()}`];
    let sources = [];
    const namedJobs = nums.map(byN).filter(Boolean);
    // "Why was my most expensive job…": name it, so it gets the full breakdown too.
    if (!namedJobs.length && aboutCost && /most|expensive|biggest|highest/i.test(question)) {
      const top = [...tickets.values()].sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0))[0];
      if (top) namedJobs.push(top);
    }
    for (const t of namedJobs.slice(0, 3)) { parts.push(`## Job #${t.n} in detail\n${await named(t, aboutCost)}`); sources.push(t); }
    const matching = words.length ? searchTickets(words.join(' '), null, 8).filter((t) => !namedJobs.includes(t)) : [];
    if (matching.length) {
      parts.push(`## Jobs matching the question\n${matching.map((t) => `- ${jobLine(t)}${t.answer ? `\n  answer: ${String(t.answer).replace(/\s+/g, ' ').slice(0, 300)}` : ''}${(t.changes || []).length ? `\n  files: ${t.changes.slice(0, 6).map((c) => c.path).join(', ')}` : ''}`).join('\n')}`);
      sources.push(...matching);
    }
    if (words.length) {
      let mem = [];
      try { mem = fs.readdirSync(MEMORY_DIR).filter((f) => f.endsWith('.md')).map((f) => ({ path: path.join(MEMORY_DIR, f), label: `${(agents.get(f.replace(/\.md$/, '')) || {}).persona || f}'s memory` })); } catch {}
      const lib = teamsList().flatMap((tm) => tm.pages.map((pg) => ({ path: pg.path, label: `${tm.room} · ${pg.group === 'Project handoffs' ? 'handoff' : 'library'} · ${pg.name}` })));
      const hits = passages([...mem, ...lib], words, 6);
      if (hits.length) parts.push(`## Notes matching the question (memories, team libraries, project handoffs)\n${hits.map((h) => `[${h.label}]\n${h.text}`).join('\n\n')}`);
    }
    sources = [...new Map(sources.map((t) => [t.id, { id: t.id, n: t.n, title: t.title }])).values()].slice(0, 8);
    return { text: parts.join('\n\n').slice(0, FACTS_MAX), sources };
  }

  function haiku(prompt) {
    return new Promise((resolve) => {
      const child = spawn(CLAUDE_BIN, ['-p', '--output-format', 'json', '--model', 'haiku', '--effort', 'low', '--max-turns', '1', '--tools', ''],
        { cwd: path.dirname(MEMORY_DIR), env: childEnv({ id: 'ask-office' }), stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '';
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { if (err.length < 2000) err += c; });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
      const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
      child.on('error', (e) => { clearTimeout(timer); resolve({ error: e.message }); });
      child.on('close', (code) => {
        clearTimeout(timer);
        let j = null;
        try { j = JSON.parse(out); } catch {}
        if (!j || j.is_error) return resolve({ error: (j && j.result) || err.trim().slice(-500) || `exit ${code}` });
        noteSpend(j.total_cost_usd || 0, j.usage);
        resolve({ text: j.result || '', costUsd: j.total_cost_usd || 0 });
      });
    });
  }

  async function ask(b) {
    const question = String(b.question || '').trim().slice(0, 2000);
    if (!question) return { error: 'Ask something.' };
    const t0 = now();
    const F = await facts(question);
    const history = (Array.isArray(b.history) ? b.history : []).slice(-3).map((h) => `User: ${String(h.q || '').slice(0, 500)}\nYou: ${String(h.a || '').slice(0, 800)}`).join('\n\n');
    const prompt = `You answer the user's questions about their Agentic OS office: a team of Claude agents (God the dispatcher, permanent leads, specialists they hire) doing jobs for the user.
Use ONLY the facts below; never invent jobs, numbers, dates or files. Cite jobs as #N. Be brief: a few sentences or a short list, under 150 words unless asked for more. Plain language.
If the facts don't answer it, say so in one line and name where to look in the window (Jobs, Projects, Usage, Tokens, Brain, Memory, Library, Health).

# Facts (gathered just now by the office)
${F.text}
${history ? `\n# Conversation so far\n${history}\n` : ''}
# Question
${question}`;
    const r = await haiku(prompt);
    if (r.error) return { error: `Couldn't get an answer: ${r.error}`, sources: F.sources };
    // Sources are the jobs the answer cites (as #N), so the window can link straight to them.
    const cited = new Set((r.text.match(/#(\d+)/g) || []).map((x) => Number(x.slice(1))));
    const sources = F.sources.filter((s) => cited.has(s.n)).concat([...cited].filter((n) => !F.sources.some((s) => s.n === n)).map((n) => [...tickets.values()].find((t) => t.n === n)).filter(Boolean).map((t) => ({ id: t.id, n: t.n, title: t.title })));
    return { answer: r.text.trim(), sources, costUsd: r.costUsd, ms: now() - t0, factsChars: F.text.length };
  }

  async function route(req, res, url, p, body, json) {
    if (req.method === 'POST' && p === '/api/ask-office') { json(res, 200, await ask(await body(req))); return true; }
    return false;
  }

  return { ask, facts, route };
}

module.exports = { install };
