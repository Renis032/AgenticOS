'use strict';
// Tickets (jobs): creating and routing them, attachments, the schedule, questions to the user, stop, pause and resume, follow-up recall, rating and search. Moved out of server.js unchanged.
const { suggest: suggestAnswers } = require('./suggest-answers');

function install(ctx) {
  const { ACTIVE, addEvent, agents, broadcast, checkHold, EFFORTS, endAccess, endCommands, enqueueResident, fs, giveFeedback, lessons,
    limits, maybeWeeklyReviews, newId, nextTicketN, now, path, planWaiters, probeLimits, pumpResident, quickEffort, readJson, releaseBudget,
    restartResident, routeByRules, stopTree, thread, ticketBudget, ticketOfAgent, tickets, touch, touchTicket, UPLOADS, userAskWaiters } = ctx;

  function newTicket({ text, project, direct, leadEffort }) {
    const t = { id: newId(), n: nextTicketN(), title: text.split('\n')[0].slice(0, 90), text, project: project || null,
      direct: direct || null, leadEffort: leadEffort || null, leadEffortBy: leadEffort ? 'user' : null, status: 'open', pending: [], assignees: [], thread: [], answer: null,
      costUsd: 0, budgetUsd: ticketBudget(), overBudget: false,
      createdAt: now(), updatedAt: now(), closedAt: null };
    tickets.set(t.id, t);
    return t;
  }

  function reopen(t) {
    if (t.status !== 'open') { t.status = 'open'; t.closedAt = null; }
  }

  function stopTicket(t) {
    endCommands(t);
    endAccess(t);
    releaseBudget(t, false);
    if (t.waiting) {
      const w = userAskWaiters.get(t.waiting.id);
      userAskWaiters.delete(t.waiting.id);
      t.waiting = null;
      if (w) w.resolve({ message: 'The user stopped this ticket. Stop working on it.' });
    }
    if (t.plan && t.plan.status === 'pending') {
      const w = planWaiters.get(t.plan.id);
      planWaiters.delete(t.plan.id);
      t.plan.status = 'stopped';
      if (w) w.resolve({ message: 'The user stopped this ticket. Stop working on it.' });
    }
    t.status = 'stopped';
    t.pending = [];
    t.closedAt = now();
    for (const a of agents.values()) {
      if (a.resident) {
        const before = a.inbox.length;
        a.inbox = a.inbox.filter((i) => i.ticketId !== t.id);
        if (before !== a.inbox.length) touch(a);
        if (a.current && a.current.ticketId === t.id) restartResident(a.id);
      } else if (a.ticketId === t.id) {
        stopTree(a.id);
      }
    }
    thread(t, { from: 'system', kind: 'system', text: 'Stopped by you.' });
  }

  function cleanAttachments(list) {
    return (Array.isArray(list) ? list : []).map(String)
      .filter((f) => path.resolve(f).startsWith(UPLOADS + path.sep) && fs.existsSync(f)).slice(0, 20);
  }

  function attachText(files) {
    return files && files.length ? `\n\nAttached files (open them with Read; images are shown to you):\n${files.map((f) => `- ${f}`).join('\n')}` : '';
  }

  function saveUpload(name, buf) {
    const safe = String(name || 'file').replace(/[^\w.\-]+/g, '_').slice(-80) || 'file';
    const dir = path.join(UPLOADS, newId());
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, safe);
    fs.writeFileSync(file, buf);
    return { path: file, name: safe, size: buf.length };
  }

  function rawBody(req, max) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let n = 0;
      req.on('data', (c) => {
        n += c.length;
        if (n > max) { reject(new Error('File too large (max 25 MB).')); req.destroy(); } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  function createTicket(b) {
    const roster = readJson('roster.json');
    const projects = readJson('projects.json');
    let project = projects.find((x) => x.name === b.project);
    let lead = project && project.department !== roster.root && roster.residents.includes(project.department) && agents.get(project.department);
    let routed = null;
    if (!b.project) {
      const r = routeByRules(b.text, projects, roster);
      if (r.lead && agents.get(r.lead)) {
        lead = agents.get(r.lead);
        project = r.project ? projects.find((x) => x.name === r.project) : null;
        routed = r.reason;
      }
    }
    const chosen = EFFORTS.includes(b.effort) ? b.effort : null;
    const t = newTicket({ text: b.text.trim(), project: project ? project.name : null, direct: lead ? lead.id : null, leadEffort: chosen });
    if (lead && !chosen && project && EFFORTS.includes(project.leadEffort)) { t.leadEffort = project.leadEffort; t.leadEffortBy = 'project'; }
    const quick = lead && !t.leadEffort && quickEffort(b.text, b.attachments);
    if (quick) { t.leadEffort = quick; t.leadEffortBy = 'auto'; }
    t.attachments = cleanAttachments(b.attachments);
    if (b.after === 'reset') {
      const w = limits.windows.five_hour;
      t.status = 'scheduled';
      t.scheduledFor = (w && w.resetsAt > now() ? w.resetsAt : now()) + 60000;
    }
    thread(t, { from: 'user', to: lead ? lead.id : undefined, kind: 'user', text: t.text, attachments: t.attachments });
    if (routed) thread(t, { from: 'system', kind: 'system', text: `Routed to ${lead.persona} by the routing rules (matched ${routed}); God was not needed.` });
    if (quick) thread(t, { from: 'system', kind: 'system', text: `Quick question, so ${lead.persona} answers at ${quick} effort for a faster reply. Pick an effort to override.` });
    if (t.status !== 'scheduled') dispatchTicket(t);
    return t;
  }

  function dispatchTicket(t) {
    const roster = readJson('roster.json');
    const project = t.project && readJson('projects.json').find((x) => x.name === t.project);
    const lead = t.direct && agents.get(t.direct);
    t.status = 'open';
    t.scheduledFor = null;
    const att = attachText(t.attachments);
    if (lead) {
      if (!t.pending.includes(lead.id)) t.pending.push(lead.id);
      if (!t.assignees.includes(lead.id)) t.assignees.push(lead.id);
      touchTicket(t);
      enqueueResident(lead.id, { ticketId: t.id, kind: 'direct',
        text: `[Ticket #${t.n} from the user, sent straight to you${project ? ` (project: ${project.name}, ${project.path})` : ''}]\n${t.text}${att}\n\n(Your final message goes directly to the user as the answer, so write it for them.)` });
    } else {
      if (!t.pending.includes(roster.root)) t.pending.push(roster.root);
      touchTicket(t);
      enqueueResident(roster.root, { ticketId: t.id, kind: 'ticket',
        text: `[Ticket #${t.n} from the user]${project ? ` (project: ${project.name}, ${project.path}, owner ${project.department})` : ''}\n${t.text}${att}` });
    }
  }

  function runSchedule() {
    maybeWeeklyReviews().catch(() => {});
    for (const t of tickets.values()) {
      if (t.status !== 'scheduled' || !t.scheduledFor || t.scheduledFor > now()) continue;
      thread(t, { from: 'system', kind: 'system', text: 'Started after the limit reset.' });
      dispatchTicket(t);
      if (!limits.updatedAt || now() - limits.updatedAt > 300000) probeLimits();
    }
    if (limits.hold && limits.hold.resetsAt < now()) { checkHold(); probeLimits(); }
  }

  // ---------------------------------------------------------------- tickets: questions to the user

  function askUser(agentId, question, options) {
    const a = agents.get(agentId);
    const t = a && ticketOfAgent(a);
    if (!t) return Promise.resolve({ error: 'You have no current ticket to ask about.' });
    if (t.waiting) return Promise.resolve({ error: 'There is already an open question to the user on this ticket. Wait for that answer.' });
    const q = { id: newId(), from: a.id, text: String(question || '').slice(0, 4000),
      options: (Array.isArray(options) ? options : []).slice(0, 6).map((o) => String(o).slice(0, 200)), at: now() };
    // No choices given: suggest some from the question's wording (lib/suggest-answers.js), marked as suggested.
    if (!q.options.length) { q.options = suggestAnswers(q.text); if (q.options.length) q.suggested = true; }
    t.waiting = q;
    thread(t, { from: a.id, to: 'user', kind: 'question', text: q.text, options: q.options, suggested: q.suggested, qid: q.id });
    broadcast({ type: 'notify', kind: 'question', ticketId: t.id, title: `${a.persona} has a question on #${t.n}`, text: q.text });
    a.progress = `Waiting for your answer on ticket #${t.n}.`;
    addEvent(a, { kind: 'progress', text: a.progress });
    touch(a);
    return new Promise((resolve) => userAskWaiters.set(q.id, { resolve }));
  }

  function answerUser(t, text) {
    const q = t.waiting;
    if (!q) return false;
    t.waiting = null;
    const w = userAskWaiters.get(q.id);
    userAskWaiters.delete(q.id);
    thread(t, { from: 'user', to: q.from, kind: 'reply', text });
    if (w) w.resolve({ message: `The user answered:\n${text}` });
    return true;
  }

  // Takes the user's latest follow-up on a ticket back out of the lead's inbox, so they can edit it and send it again.
  function recallFollowup(t) {
    const last = [...t.thread].reverse().find((e) => e.kind === 'followup');
    if (!last || !last.fid) return { error: 'There is no message to edit.' };
    for (const a of agents.values()) {
      const i = (a.inbox || []).findIndex((x) => x.fid === last.fid);
      if (i < 0) continue;
      const [item] = a.inbox.splice(i, 1);
      t.thread.splice(t.thread.indexOf(last), 1);
      const stillQueued = a.inbox.some((x) => x.ticketId === t.id) || (a.current && a.current.ticketId === t.id);
      if (!stillQueued) {
        t.pending = t.pending.filter((k) => k !== a.id || (item.before && item.before.pending.includes(k)));
        if (item.before && !['open', 'paused'].includes(item.before.status) && !t.pending.length) { t.status = item.before.status; t.closedAt = item.before.closedAt; }
      }
      touch(a);
      touchTicket(t);
      return { text: item.userText != null ? item.userText : last.text, attachments: item.userFiles || last.attachments || [] };
    }
    return { error: 'Already delivered: the agent is reading it, so it can no longer be edited.' };
  }

  // ---------------------------------------------------------------- tickets: rating, search, archive

  function rateTicket(t, score, note) {
    const roster = readJson('roster.json');
    t.rating = { score: score > 0 ? 1 : -1, note: String(note || '').slice(0, 2000), at: now() };
    thread(t, { from: 'user', kind: 'rating', score: t.rating.score, text: t.rating.note });
    if (t.rating.score < 0) return lessons.ask(t, 'rated', t.rating.note);
    const leads = [...new Set([t.direct, ...t.assignees].filter(Boolean))].filter((k) => k !== roster.root);
    const text = `The user rated your answer on ticket #${t.n} ("${t.title}") as ${t.rating.score > 0 ? 'GOOD 👍' : 'NOT GOOD 👎'}` +
      (t.rating.note ? `: ${t.rating.note}` : '.') + ' Take the lesson into how you handle similar tickets, and pass it on to teammates where it concerns their part.';
    for (const k of leads) giveFeedback('user', k, text);
  }

  function searchTickets(query, excludeId, limit) {
    const terms = [...new Set(String(query || '').toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) || [])];
    if (!terms.length) return [];
    const scored = [];
    for (const t of tickets.values()) {
      if (t.id === excludeId || t.status === 'scheduled') continue;
      const title = t.title.toLowerCase();
      const text = [t.text, t.answer || '', ...t.thread.map((e) => e.text || ''), ...(t.changes || []).map((c) => c.path)].join('\n').toLowerCase();
      let score = 0;
      for (const w of terms) {
        if (title.includes(w)) score += 3;
        score += Math.min(text.split(w).length - 1, 5);
      }
      if (score) scored.push({ t, score });
    }
    return scored.sort((x, y) => y.score - x.score).slice(0, limit || 5).map((x) => x.t);
  }

  function searchText(query, agentId) {
    const a = agents.get(agentId);
    const cur = a && ticketOfAgent(a);
    const hits = searchTickets(query, cur && cur.id, 5);
    if (!hits.length) return 'No earlier tickets match.';
    return hits.map((t) => {
      const lead = [t.direct, ...t.assignees].filter(Boolean).map((k) => (agents.get(k) || {}).persona).filter(Boolean)[0];
      const files = (t.changes || []).map((c) => c.path).slice(0, 8);
      return `### Ticket #${t.n}: ${t.title}\n${t.status}, ${new Date(t.createdAt).toISOString().slice(0, 10)}` +
        `${t.project ? `, ${t.project}` : ''}${lead ? `, handled by ${lead}` : ''}` +
        `${t.rating ? `, user rated it ${t.rating.score > 0 ? 'good' : 'NOT good'}${t.rating.note ? ` ("${t.rating.note}")` : ''}` : ''}\n` +
        `Request: ${t.text.slice(0, 500)}\n` + (t.answer ? `Answer: ${t.answer.slice(0, 1500)}\n` : '') +
        (files.length ? `Files changed: ${files.join(', ')}\n` : '');
    }).join('\n');
  }

  function pauseTicket(t) {
    if (t.status !== 'open') return { error: 'Only a ticket in progress can be paused.' };
    endCommands(t);
    endAccess(t);
    t.status = 'paused';
    t.pausedAt = now();
    t.pausedLeads = [];
    releaseBudget(t, false);
    if (t.waiting) {
      userAskWaiters.delete(t.waiting.id);
      t.waiting = null;
    }
    if (t.plan && t.plan.status === 'pending') { planWaiters.delete(t.plan.id); t.plan.status = 'interrupted'; }
    for (const a of agents.values()) {
      if (a.resident && a.current && a.current.ticketId === t.id) {
        t.pausedLeads.push(a.id);
        a.pausing = t.id;
        restartResident(a.id);
      } else if (!a.resident && a.ticketId === t.id && ACTIVE.includes(a.status)) {
        a.pauseStop = true;
        stopTree(a.id);
      }
    }
    thread(t, { from: 'system', kind: 'system', text: 'Paused by you. Nothing runs on this ticket until you resume it.' });
    return { ok: true };
  }

  function resumeTicket(t) {
    if (t.status !== 'paused') return { error: 'This ticket is not paused.' };
    t.status = 'open';
    const files = (t.changes || []).map((c) => c.path);
    for (const k of t.pausedLeads || []) {
      if (!t.pending.includes(k)) t.pending.push(k);
      enqueueResident(k, { ticketId: t.id, kind: 'direct',
        text: `[Ticket #${t.n} resumed by the user]\nThe user paused this ticket while you were working on it; your teammates were stopped. ` +
          `Continue from where you left off. Re-delegate only what is unfinished (check \`staff\`).` +
          (files.length ? ` Files already changed on this ticket: ${files.join(', ')}.` : '') +
          (t.plan && t.plan.status === 'interrupted' ? ' Your plan was not decided yet; propose it again if you still need it.' : '') });
    }
    t.pausedLeads = [];
    thread(t, { from: 'system', kind: 'system', text: 'Resumed by you.' });
    for (const a of agents.values()) if (a.resident) pumpResident(a);
    return { ok: true };
  }

  return { newTicket, reopen, stopTicket, cleanAttachments, attachText, saveUpload, rawBody, createTicket, dispatchTicket, runSchedule,
    askUser, answerUser, recallFollowup, rateTicket, searchTickets, searchText, pauseTicket, resumeTicket };
}

module.exports = { install };
