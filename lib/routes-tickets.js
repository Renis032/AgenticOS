'use strict';
// HTTP routes for jobs: creating them, uploads, search, messages, questions, plans, budgets, pause, undo, rating, archive.
// Moved out of server.js unchanged; server.js passes in what they use and asks each module in turn (see routeModules there).

const { quickEffort } = require('./quick-effort');
const { route: routeByRules } = require('../scripts/route');

function install(ctx) {
  const {
    UPLOADS, agents, askUser, broadcast, changesOf, cleanAttachments, createTicket, decidePlan, dispatchTicket, followUp, fs, lessons,
    path, pauseTicket, proposePlan, rateTicket, rawBody, readJson, recallFollowup, sendFollowupNow, releaseBudget, resumeTicket, revertChanges, saveState,
    saveUpload, searchText, searchTickets, stopTicket, thread, ticketBudget, tickets, timelineOf, touch, touchTicket
  } = ctx;

  // What would happen to a job before it is sent: who gets it and why, at what effort, and what similar jobs cost.
  // Shown live on the New job page while the user types.
  function routePreview(b) {
    const roster = readJson('roster.json');
    const projects = readJson('projects.json');
    const text = String(b.text || '');
    let project = b.project ? projects.find((x) => x.name === b.project) : null;
    let lead = project ? project.department : null, via = project ? 'project' : null, reason = project ? `you picked ${project.name}` : null;
    if (!project && text.trim()) {
      const r = routeByRules(text, projects, roster);
      if (r.lead && agents.get(r.lead)) { lead = r.lead; via = 'rules'; reason = `matched ${r.reason}`; project = r.project ? projects.find((x) => x.name === r.project) : null; }
      else { via = 'god'; reason = r.reason === 'no rule matched' ? 'no project or keyword matched' : r.reason; }
    }
    if (lead === roster.root) { lead = null; via = 'god'; }
    let effort = null, effortWhy = null;
    if (b.effort) { effort = b.effort; effortWhy = 'you chose it'; }
    else if (lead && project && project.leadEffort) { effort = project.leadEffort; effortWhy = `${project.name}'s setting`; }
    else if (lead && quickEffort(text, b.attachments)) { effort = quickEffort(text, b.attachments); effortWhy = 'a quick question'; }
    else if (lead) { effort = roster.defaults.residentEffort || 'high'; effortWhy = 'the default'; }
    else effortWhy = 'God picks it';
    const done = [...tickets.values()].filter((t) => t.status === 'done' && t.costUsd > 0.02);
    const mine = lead ? done.filter((t) => t.direct === lead || (t.assignees || []).includes(lead)) : [];
    // The lead's own jobs if there are enough, narrowed to the same effort when that still leaves enough.
    const pool = mine.length >= 3 ? mine : done;
    const same = pool.filter((t) => effort && t.leadEffort === effort);
    const base = (same.length >= 3 ? same : pool).map((t) => t.costUsd).sort((x, y) => x - y);
    const a = lead && agents.get(lead);
    const busy = a && a.current && a.current.ticketId && tickets.get(a.current.ticketId);
    return { via, leadId: lead, persona: a ? a.persona : null, project: project ? project.name : null, reason, effort, effortWhy,
      estimateUsd: base.length ? base[Math.floor(base.length / 2)] : null, basedOn: base.length,
      busyWith: busy ? { n: busy.n, title: busy.title } : null, twins: Number(roster.defaults.leadTwins ?? 1) };
  }

  // Returns true once a route has answered.
  async function route(req, res, url, p, body, json) {
    await handle(req, res, url, p, body, json);
    return res.headersSent;
  }
  async function handle(req, res, url, p, body, json) {
    let m;
    if (req.method === 'POST' && p === '/api/tasks') {
      const b = await body(req);
      if (!b.text || !b.text.trim()) return json(res, 400, { error: 'empty task' });
      return json(res, 200, { id: createTicket(b).id });
    }
    if (req.method === 'POST' && p === '/api/route-preview') return json(res, 200, routePreview(await body(req)));
    if (req.method === 'POST' && p === '/api/uploads') {
      const buf = await rawBody(req, 25 << 20);
      return json(res, 200, saveUpload(url.searchParams.get('name'), buf));
    }
    if (req.method === 'GET' && p.startsWith('/api/uploads/')) {
      const file = path.resolve(UPLOADS, decodeURIComponent(p.slice('/api/uploads/'.length)));
      if (!file.startsWith(UPLOADS + path.sep) || !fs.existsSync(file)) return json(res, 404, { error: 'not found' });
      const ext = path.extname(file).toLowerCase();
      const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf' };
      res.writeHead(200, { 'content-type': types[ext] || 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff',
        'content-disposition': types[ext] ? 'inline' : `inline; filename="${path.basename(file)}"` });
      return res.end(fs.readFileSync(file));
    }
    if (req.method === 'GET' && p === '/api/search') {
      const hits = searchTickets(url.searchParams.get('q'), null, 20).map((t) => t.id);
      return json(res, 200, { ids: hits, text: url.searchParams.get('agentId') ? searchText(url.searchParams.get('q'), url.searchParams.get('agentId')) : undefined });
    }
    if (req.method === 'POST' && p === '/api/ask-user') {
      const b = await body(req);
      return json(res, 200, await askUser(b.agentId, b.question, b.options));
    }
    if (req.method === 'GET' && (m = p.match(/^\/api\/tickets\/(\w+)\/changes$/))) {
      const t = tickets.get(m[1]);
      return t ? json(res, 200, changesOf(t)) : json(res, 404, { error: 'not found' });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/tickets\/(\w+)\/revert$/))) {
      const t = tickets.get(m[1]);
      const b = await body(req);
      if (!t) return json(res, 404, { error: 'not found' });
      const reverted = revertChanges(t, b.path || null);
      if (reverted && (!Array.isArray(reverted) || reverted.length)) { t.undone = (t.undone || 0) + 1; lessons.ask(t, 'undone'); touchTicket(t); }
      return json(res, 200, { reverted });
    }
    if (req.method === 'GET' && (m = p.match(/^\/api\/tickets\/(\w+)\/timeline$/))) {
      const t = tickets.get(m[1]);
      return t ? json(res, 200, timelineOf(t)) : json(res, 404, { error: 'not found' });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/tickets\/(\w+)\/rate$/))) {
      const t = tickets.get(m[1]);
      const b = await body(req);
      if (!t) return json(res, 404, { error: 'not found' });
      rateTicket(t, Number(b.score) || 1, b.note);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/tickets\/(\w+)\/archive$/))) {
      const t = tickets.get(m[1]);
      const b = await body(req);
      if (!t) return json(res, 404, { error: 'not found' });
      t.archived = b.archived !== false;
      touchTicket(t);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/tickets\/(\w+)\/start$/))) {
      const t = tickets.get(m[1]);
      if (!t || t.status !== 'scheduled') return json(res, 404, { error: 'not a scheduled ticket' });
      thread(t, { from: 'system', kind: 'system', text: 'Started now by you.' });
      dispatchTicket(t);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/propose-plan') {
      const b = await body(req);
      return json(res, 200, await proposePlan(b.agentId, b.plan, b.estimateUsd));
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/tickets\/(\w+)\/plan$/))) {
      const t = tickets.get(m[1]);
      const b = await body(req);
      return t ? json(res, 200, decidePlan(t, b.decision, b.note)) : json(res, 404, { error: 'not found' });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/tickets\/(\w+)\/(pause|resume)$/))) {
      const t = tickets.get(m[1]);
      if (!t) return json(res, 404, { error: 'not found' });
      const r = m[2] === 'pause' ? pauseTicket(t) : resumeTicket(t);
      return json(res, r.error ? 400 : 200, r);
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/tickets\/(\w+)\/message$/))) {
      const t = tickets.get(m[1]);
      const b = await body(req);
      if (!t || !b.text) return json(res, 404, { error: 'not found' });
      return json(res, 200, followUp(t, b.text, cleanAttachments(b.attachments)));
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/tickets\/(\w+)\/recall$/))) {
      const t = tickets.get(m[1]);
      return json(res, 200, t ? recallFollowup(t) : { error: 'not found' });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/tickets\/(\w+)\/send-now$/))) {
      const t = tickets.get(m[1]);
      return json(res, 200, t ? sendFollowupNow(t) : { error: 'not found' });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/tickets\/(\w+)\/stop$/))) {
      const t = tickets.get(m[1]);
      if (t) stopTicket(t);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'DELETE' && (m = p.match(/^\/api\/tickets\/(\w+)$/))) {
      const t = tickets.get(m[1]);
      if (!t) return json(res, 404, { error: 'not found' });
      if (t.status === 'open') stopTicket(t);
      for (const a of agents.values()) {
        if (!a.staff) continue;
        a.tickets = (a.tickets || []).filter((id) => id !== t.id);
        if (a.ticketId === t.id) { a.ticketId = null; a.ticketN = null; }
        touch(a);
      }
      tickets.delete(t.id);
      saveState();
      broadcast({ type: 'ticketRemoved', id: t.id });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/tickets\/(\w+)\/budget$/))) {
      const t = tickets.get(m[1]);
      const b = await body(req);
      if (!t) return json(res, 404, { error: 'not found' });
      const add = Math.max(0, Number(b.add) || 0);
      t.budgetUsd = (t.budgetUsd || ticketBudget() || 0) + add;
      if (t.overBudget && (t.costUsd || 0) < t.budgetUsd) {
        t.overBudget = false;
        thread(t, { from: 'system', kind: 'system', text: `Budget raised to $${t.budgetUsd.toFixed(2)}. Work continues.` });
        releaseBudget(t, true);
      }
      touchTicket(t);
      return json(res, 200, { ok: true });
    }
  }
  return { route };
}

module.exports = { install };
