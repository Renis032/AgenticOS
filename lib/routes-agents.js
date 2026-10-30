'use strict';
// HTTP routes for agents and the tools they call (delegate, assign, mail, memory, lessons, feedback, standing instructions, progress, commands, edit access).
// Moved out of server.js unchanged; server.js passes in what they use and asks each module in turn (see routeModules there).

function install(ctx) {
  const {
    ACTIVE, MEMORY_DIR, addEvent, addToDocs, agents, ask, assign, colleagues, decideAccess, decideCommand, delegate, denyEdit,
    enqueue, enqueueResident, eventsOf, fs, giveFeedback, lessons, maybeRefresh, newTicket, onCall, path, pumpResident,
    readMemory, requestAccess, restartResident, runCommand, runReview, saveHandoff, sendMail, setStanding, snapshotBefore, staffList,
    stopCommand, stopTree, takeUnread, thread, ticketOfAgent, tickets, touch, touchFile, touchTicket, waitForTeam, writeMemory
  } = ctx;

  // Returns true once a route has answered.
  async function route(req, res, url, p, body, json) {
    await handle(req, res, url, p, body, json);
    return res.headersSent;
  }
  async function handle(req, res, url, p, body, json) {
    let m;
    if (req.method === 'GET' && (m = p.match(/^\/api\/agents\/(\w[\w-]*)\/events$/))) {
      const a = agents.get(m[1]);
      const limit = Number(url.searchParams.get('limit') || 400);
      return a ? json(res, 200, eventsOf(a).slice(-limit)) : json(res, 404, { error: 'not found' });
    }
    if (req.method === 'POST' && p === '/api/files/before') {
      const b = await body(req);
      const deny = denyEdit(b.agentId, b.file);
      if (deny) return json(res, 200, { deny });
      snapshotBefore(b.agentId, b.file);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/agents\/(\w[\w-]*)\/review$/))) {
      const r = await runReview(m[1]);
      return json(res, r.error ? 400 : 200, r);
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/agents\/(\w[\w-]*)\/scope$/))) {
      const b = await body(req);
      const r = onCall.setScope(m[1], !!b.team, !!b.restore);
      return json(res, r.error ? 400 : 200, r);
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/agents\/(\w[\w-]*)\/refresh$/))) {
      const a = agents.get(m[1]);
      if (!a || !a.resident) return json(res, 404, { error: 'not a lead' });
      const queued = maybeRefresh(a, true);
      pumpResident(a);
      return json(res, 200, { ok: queued });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/agents\/(\w[\w-]*)\/message$/))) {
      const a = agents.get(m[1]);
      const b = await body(req);
      if (!a || !b.text) return json(res, 404, { error: 'not found' });
      if (a.resident) {
        const t = newTicket({ text: b.text.trim(), direct: a.id });
        thread(t, { from: 'user', to: a.id, kind: 'user', text: t.text });
        t.pending.push(a.id);
        t.assignees.push(a.id);
        touchTicket(t);
        enqueueResident(a.id, { ticketId: t.id, kind: 'direct', text: `[Direct message from the user, ticket #${t.n}]\n${t.text}` });
        return json(res, 200, { ticketId: t.id });
      }
      if (ACTIVE.includes(a.status)) return json(res, 409, { error: `${a.persona} is busy; wait or stop them first.` });
      if (!a.sessionId) return json(res, 409, { error: 'No session to continue.' });
      a.taskCostStart = a.costUsd;
      enqueue(a, b.text, true);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/agents\/(\w[\w-]*)\/stop$/))) {
      stopTree(m[1]);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/agents\/(\w[\w-]*)\/reset$/))) {
      const a = agents.get(m[1]);
      if (!a || !a.resident) return json(res, 404, { error: 'not a resident' });
      a.sessionId = null;
      a.resetting = true;
      addEvent(a, { kind: 'system', text: 'Memory reset by the user.' });
      restartResident(a.id);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/memory') {
      const b = await body(req);
      return json(res, 200, writeMemory(b.agentId, b.content));
    }
    if (req.method === 'GET' && (m = p.match(/^\/api\/agents\/(\w[\w-]*)\/memory$/))) {
      // A retired teammate's memory is kept in data/memory/archive/ until they come back.
      let text = readMemory(m[1]);
      if (!text) try { text = fs.readFileSync(path.join(MEMORY_DIR, 'archive', m[1] + '.md'), 'utf8'); } catch { /* none */ }
      return json(res, 200, { text });
    }
    if (req.method === 'POST' && p === '/api/feedback') {
      const b = await body(req);
      return json(res, 200, giveFeedback(b.agentId, b.to, b.text));
    }
    if (req.method === 'POST' && p === '/api/lessons') {
      const b = await body(req);
      const a = agents.get(b.agentId);
      const t = a && ticketOfAgent(a);
      return json(res, 200, lessons.add(b.agentId, b.text, t, b.reasoning));
    }
    if (req.method === 'DELETE' && (m = p.match(/^\/api\/agents\/(\w[\w-]*)\/lessons\/(\w+)$/))) {
      const r = lessons.remove(m[1], m[2]);
      return json(res, r.error ? 404 : 200, r);
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/agents\/(\w[\w-]*)\/lesson-drafts\/(\w+)$/))) {
      const b = await body(req);
      const r = lessons.approve(m[1], m[2], b.text);
      return json(res, r.error ? 400 : 200, r);
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/agents\/(\w[\w-]*)\/lesson-drafts\/(\w+)\/chat$/))) {
      const b = await body(req);
      const r = await lessons.discuss(m[1], m[2], b.text);
      return json(res, r.error && !r.draft ? 400 : 200, r);
    }
    if (req.method === 'DELETE' && (m = p.match(/^\/api\/agents\/(\w[\w-]*)\/lesson-drafts\/(\w+)$/))) {
      const r = lessons.drop(m[1], m[2]);
      return json(res, r.error ? 404 : 200, r);
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/agents\/(\w[\w-]*)\/feedback$/))) {
      const b = await body(req);
      const r = giveFeedback('user', m[1], b.text);
      return json(res, r.error ? 400 : 200, r);
    }
    if ((m = p.match(/^\/api\/agents\/(\w[\w-]*)\/standing(?:\/(\w+))?$/))) {
      const a = agents.get(m[1]);
      if (req.method === 'GET' && !m[2]) return json(res, a ? 200 : 404, a ? { standing: a.standing || [] } : { error: 'Unknown agent.' });
      if (req.method === 'POST' && !m[2]) { const r = setStanding(m[1], 'add', (await body(req)).text); return json(res, r.error ? 400 : 200, r); }
      if (req.method === 'DELETE' && m[2]) { const r = setStanding(m[1], 'remove', null, m[2]); return json(res, r.error ? 404 : 200, r); }
    }
    if (req.method === 'GET' && p === '/api/staff') {
      return json(res, 200, { text: staffList(url.searchParams.get('agentId')) });
    }
    if (req.method === 'POST' && p === '/api/files/touch') {
      const b = await body(req);
      return json(res, 200, { warning: touchFile(b.agentId, b.file) });
    }
    if (req.method === 'GET' && p === '/api/mail/unread') {
      return json(res, 200, { text: takeUnread(url.searchParams.get('agentId')) });
    }
    if (req.method === 'POST' && p === '/api/mail/send') {
      const b = await body(req);
      const r = sendMail(b.agentId, b.to, b.text, b.replyTo, false);
      return json(res, 200, r.error ? { error: r.error } : { message: `Delivered to ${r.to.persona}.` });
    }
    if (req.method === 'POST' && p === '/api/mail/ask') {
      const b = await body(req);
      return json(res, 200, await ask(b.agentId, b.to, b.question, b.timeoutSec));
    }
    if (req.method === 'GET' && p === '/api/colleagues') {
      return json(res, 200, { text: colleagues(url.searchParams.get('agentId')) });
    }
    if (req.method === 'POST' && p === '/api/docs/add') {
      const b = await body(req);
      return json(res, 200, addToDocs(b.agentId, b.page, b.text || ''));
    }
    if (req.method === 'POST' && p === '/api/command/run') {
      const b = await body(req);
      return json(res, 200, await runCommand(b.agentId, b));
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/commands\/(\w+)\/(decide|stop)$/))) {
      const b = await body(req);
      return json(res, 200, m[2] === 'stop' ? stopCommand(m[1]) : decideCommand(m[1], b.decision === 'run' ? 'run' : 'deny', b.note, !!b.allowAll));
    }
    if (req.method === 'POST' && p === '/api/edit-access/request') {
      const b = await body(req);
      return json(res, 200, await requestAccess(b.agentId, b.folder, b.reason));
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/edit-access\/(\w+)\/decide$/))) {
      const b = await body(req);
      return json(res, 200, decideAccess(tickets, m[1], b.decision === 'allow'));
    }
    if (req.method === 'POST' && p === '/api/handoff/save') {
      const b = await body(req);
      return json(res, 200, saveHandoff(b.agentId, b.project, b.state, b.session));
    }
    if (req.method === 'POST' && p === '/api/assign') {
      const b = await body(req);
      return json(res, 200, assign(b.agentId, b.to, b.brief || '', b.effort));
    }
    if (req.method === 'POST' && p === '/api/wait') {
      const b = await body(req);
      return json(res, 200, await waitForTeam(b.agentId, b.batchId));
    }
    if (req.method === 'POST' && p === '/api/delegate') {
      const b = await body(req);
      return json(res, 200, await delegate(b.parentId, b.assignments || []));
    }
    if (req.method === 'POST' && p === '/api/progress') {
      const b = await body(req);
      const a = agents.get(b.agentId);
      if (a) {
        a.progress = b.status;
        if (typeof b.percent === 'number') a.percent = Math.max(0, Math.min(100, b.percent));
        const pt = typeof b.step === 'number' && a.resident && ticketOfAgent(a);
        if (pt && pt.plan) { pt.plan.step = Math.max(1, Math.round(b.step)); touchTicket(pt); }
        addEvent(a, { kind: 'progress', text: b.status, percent: a.percent });
        touch(a);
      }
      return json(res, 200, { ok: true });
    }
  }
  return { route };
}

module.exports = { install };
