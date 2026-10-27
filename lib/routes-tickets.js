'use strict';
// HTTP routes for jobs: creating them, uploads, search, messages, questions, plans, budgets, pause, undo, rating, archive.
// Moved out of server.js unchanged; server.js passes in what they use and asks each module in turn (see routeModules there).

function install(ctx) {
  const {
    UPLOADS, agents, answerUser, askUser, attachText, broadcast, changesOf, cleanAttachments, createTicket, decidePlan,
    dispatchTicket, enqueueResident, fs, lessons, newId, now, path, pauseTicket, proposePlan, rateTicket, rawBody, readJson,
    recallFollowup, releaseBudget, reopen, resumeTicket, revertChanges, saveState, saveUpload, searchText, searchTickets,
    stopTicket, thread, ticketBudget, tickets, timelineOf, touch, touchTicket
  } = ctx;

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
      const files = cleanAttachments(b.attachments);
      if (t.waiting) {
        answerUser(t, b.text + attachText(files));
        return json(res, 200, { ok: true, answered: true });
      }
      const roster = readJson('roster.json');
      const before = { status: t.status, closedAt: t.closedAt, pending: [...t.pending] };
      // A follow-up within 2 hours of the answer counts as rework: the answer was not what the user needed.
      if (['done', 'failed'].includes(t.status) && t.closedAt && now() - t.closedAt < 2 * 3600000) { t.rework = (t.rework || 0) + 1; lessons.ask(t, 'rework'); }
      reopen(t);
      const fid = newId();
      thread(t, { from: 'user', kind: 'followup', text: b.text, attachments: files, fid });
      const to = t.direct || (t.assignees.length === 1 ? t.assignees[0] : roster.root);
      if (!t.pending.includes(to)) t.pending.push(to);
      touchTicket(t);
      enqueueResident(to, { ticketId: t.id, fid, before, userText: b.text, userFiles: files, kind: to === roster.root ? 'followup' : 'direct',
        text: to === roster.root
          ? `[User follow-up on ticket #${t.n}: "${t.title}", handled by ${t.assignees.map((k) => agents.get(k).persona + ' (' + k + ')').join(', ') || 'nobody yet'}]\n${b.text}${attachText(files)}`
          : `[User follow-up on ticket #${t.n}]\n${b.text}${attachText(files)}` });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/tickets\/(\w+)\/recall$/))) {
      const t = tickets.get(m[1]);
      return json(res, 200, t ? recallFollowup(t) : { error: 'not found' });
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
