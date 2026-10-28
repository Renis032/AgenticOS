'use strict';
// Residents: the always-alive lead processes, their inbox, one message per turn, fresh sessions and restarts. Moved out of server.js unchanged.
// Twins: when a lead is busy and a job for another ticket waits in its inbox, a temporary second desk of that lead (same role,
// instructions and memory, read-only) takes that ticket, so new jobs don't queue behind long ones. Idle twins retire.

function install(ctx) {
  const { addEvent, agents, arms, broadcast, buildArgs, childEnv, CLAUDE_BIN, fs, handoffBrief, handoffsOf, home, isRestartPending,
    isShuttingDown, lessons, limits, maybeRefresh, maybeTidy, modelOf, now, onStreamMessage, path, pendingFeedback, procs,
    projectsMentioned, readJson, readLines, spawn, thread, tickets, touch, touchTicket } = ctx;

  const PERSONAS = ['Ben', 'Chloe', 'Dmitri', 'Elena', 'Felix', 'Greta', 'Hugo', 'Iris', 'Jonas', 'Kira', 'Leo',
    'Mila', 'Nikolai', 'Olga', 'Pavel', 'Quinn', 'Rosa', 'Stefan', 'Tara', 'Uma', 'Wren', 'Xenia', 'Yuri', 'Zoe',
    'Anya', 'Boris', 'Clara', 'Dario', 'Eva', 'Filip', 'Gaia', 'Hana', 'Ivo', 'Jade', 'Kostas', 'Lena', 'Marco',
    'Oskar', 'Petra', 'Raya', 'Sami', 'Teo', 'Vera', 'Willa', 'Yana', 'Zlatan', 'Alba', 'Bruno', 'Daria', 'Emil', 'Ines'];

  function baseAgent(fields) {
    return { status: 'queued', progress: null, percent: null, sessionId: null, result: null, error: null,
      costUsd: 0, turns: 0, createdAt: now(), startedAt: null, endedAt: null, updatedAt: now(),
      children: [], events: [], ...fields };
  }

  function ensureResident(roster, key) {
    let a = agents.get(key);
    const def = roster.roles[a && a.twinOf ? a.twinOf : key];
    if (!a) {
      a = baseAgent({ id: key, role: key, resident: true, depth: key === roster.root ? 0 : 1, parentId: null,
        inbox: [], current: null, ticketsHandled: 0, status: 'offline' });
      agents.set(key, a);
    }
    Object.assign(a, { name: def.name, persona: a.twinOf ? `${def.persona} ·${a.twinNo}` : def.persona, title: def.description, room: def.room, cwd: home(def.cwd || '~'),
      ...modelOf(roster, a) });
    return a;
  }

  function startResident(key) {
    if (isShuttingDown()) return;
    const roster = readJson('roster.json');
    const a = ensureResident(roster, key);
    if (procs.get(key)) return;
    const args = [...buildArgs(roster, a), '--input-format', 'stream-json'];
    if (a.sessionId) args.push('--resume', a.sessionId);
    const child = spawn(CLAUDE_BIN, args, { cwd: a.cwd, env: childEnv(a), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const started = now();
    a.procStartedAt = started;
    procs.set(key, child);
    a.status = 'idle';
    a.startedAt = a.startedAt || now();
    a.pid = child.pid;
    if (!a.sessionId) { a.sessionTickets = []; a.lastTicketId = null; }
    addEvent(a, { kind: 'system', text: a.sessionId ? 'Back at the desk (memory restored).' : 'Started a fresh session.' });
    touch(a);
    readLines(child.stdout, (line) => {
      let m;
      try { m = JSON.parse(line); } catch { return addEvent(a, { kind: 'log', text: line }); }
      const r = onStreamMessage(a, m);
      if (r && r.done) finishResidentTurn(a, r.text, r.isError);
    });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; if (stderr.length > 20000) stderr = stderr.slice(-8000); });
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      procs.delete(key);
      if (stderr.trim()) addEvent(a, { kind: 'log', text: stderr.trim().slice(-3000) });
      if (isShuttingDown()) return;
      if (a.retired) { a.status = 'offline'; a.killing = false; touch(a); return; }
      const planned = a.killing || a.resetting;
      const quick = now() - started < 15000;
      if (quick && code && a.sessionId && !a.resetting && !a.killing) {
        addEvent(a, { kind: 'system', text: 'Could not resume the previous session; starting fresh.' });
        a.sessionId = null;
      }
      if (a.current && a.pausing && a.current.ticketId === a.pausing) {
        addEvent(a, { kind: 'system', text: 'Paused by the user mid-ticket.' });
        a.current = null;
      } else if (a.current) finishResidentTurn(a, `INTERRUPTED: my process stopped (exit ${code}) before I finished.`, true);
      a.pausing = null;
      a.status = 'offline';
      a.resetting = false;
      a.killing = false;
      touch(a);
      a.restarts = quick && !planned ? (a.restarts || 0) + 1 : 0;
      if (!isShuttingDown()) setTimeout(() => startResident(key), planned ? 200 : Math.min(60000, 1000 * 2 ** Math.min(a.restarts, 6)));
    });
    pumpResident(a);
  }

  function enqueueResident(key, item) {
    let a = agents.get(key);
    if (a.twinOf && a.retired) a = agents.get(a.twinOf);
    a.inbox.push(item);
    touch(a);
    pumpResident(a);
    return a.inbox.length - (a.current ? 0 : 1);
  }

  function effortFor(roster, a, item) {
    if (a.id === roster.root || item.kind === 'message' || item.kind === 'chore') return null;
    const t = tickets.get(item.ticketId);
    return (t && t.leadEffort) || roster.defaults.residentEffort || 'high';
  }

  function pumpResident(a) {
    maybeTwin(a);
    const p = procs.get(a.id);
    if (!p || a.current || !a.inbox.length || a.killing || limits.hold || isRestartPending()) return;
    const idx = a.inbox.findIndex((i) => { const tk = i.ticketId && tickets.get(i.ticketId); return !tk || tk.status !== 'paused'; });
    if (idx < 0) return;
    if (idx > 0) a.inbox.unshift(...a.inbox.splice(idx, 1));
    const roster = readJson('roster.json');
    const want = effortFor(roster, a, a.inbox[0]);
    const next = a.inbox[0];
    if (a.id !== roster.root && roster.defaults.leadFreshPerTicket !== false && a.sessionId && next.ticketId && a.lastTicketId && next.ticketId !== a.lastTicketId) {
      const t = tickets.get(next.ticketId);
      if (want) a.runEffort = want;
      a.sessionId = null;
      a.lastTicketId = null;
      a.resetting = true;
      addEvent(a, { kind: 'system', text: `Fresh session for ticket #${t ? t.n : '?'}: earlier tickets stay out of the context (your memory file carries over).` });
      restartResident(a.id);
      return;
    }
    if (want && want !== a.effort) {
      const t = tickets.get(a.inbox[0].ticketId);
      a.runEffort = want;
      addEvent(a, { kind: 'system', text: `Switching to ${want} effort for ticket #${t ? t.n : '?'} (same session).` });
      restartResident(a.id);
      return;
    }
    const item = a.inbox.shift();
    if (item.ticketId && a.id !== roster.root) {
      const t = tickets.get(item.ticketId);
      a.sessionTickets = a.sessionTickets || [];
      if (t && t.answer && !a.sessionTickets.includes(item.ticketId)) {
        const said = t.thread.filter((e) => e.kind === 'user' || e.kind === 'reply').slice(-3).map((e) => `- ${String(e.text || '').slice(0, 400)}`).join('\n');
        item.text = `[Context: you answered ticket #${t.n} in an earlier session; this session starts without it]\nYour last answer:\n${String(t.answer).slice(0, 4000)}${said ? `\n\nThe user's recent messages on it:\n${said}` : ''}\nReuse what you can; ask specialists again only for what this follow-up really needs.\n\n${item.text}`;
      }
      const handoffs = t && !a.sessionTickets.includes(item.ticketId) && handoffsOf(roster, a);
      if (handoffs) {
        item.text = handoffBrief(handoffs, t, item.text);
        const names = projectsMentioned(handoffs, `${t.text}\n${item.text}`).filter((n) => fs.existsSync(path.join(handoffs.dir, `${n}.md`)));
        if (names.length) { t.handoffs = [...new Set([...(t.handoffs || []), ...names])]; touchTicket(t); }
      }
      // When the user says they are wrapping up, the lead is told explicitly to save the project handoff before answering.
      const ho = t && handoffsOf(roster, a);
      if (ho && /\b(wrap(ping)?\s+up|that'?s all for (today|now)|done for (today|now|the day)|last message|end of (the |our )?session|see you tomorrow|stop here for today|call it a day)\b/i.test(String(item.text).slice(-2000))) {
        const names = projectsMentioned(ho, `${t.title}\n${t.text}\n${item.text}`);
        if (names.length) item.text += `\n\n[The user is wrapping up: before you answer, call save_project_handoff for ${names.join(', ')} (run the handoff-facts script first for the facts).]`;
      }
      if (!a.sessionTickets.includes(item.ticketId)) a.sessionTickets.push(item.ticketId);
      a.lastTicketId = item.ticketId;
    }
    const fb = pendingFeedback(a);
    if (fb.length && item.kind !== 'chore') {
      item.text = `[Feedback you received since your last ticket]\n${fb.map((f) => `- From ${f.fromPersona}${f.ticketN ? ` (ticket #${f.ticketN})` : ''}: ${f.text}`).join('\n')}\nFold the lesson into how you work and into your memory.\n\n${item.text}`;
      fb.forEach((f) => { f.seen = true; });
    }
    a.current = item;
    a.liveUsd = 0;
    a.ctxNudgedAt = 0;
    a.draft = null;
    a.status = 'running';
    a.progress = null;
    a.percent = null;
    if (item.kind !== 'message') addEvent(a, { kind: item.kind === 'followup' ? 'followup' : 'brief', text: item.text, ticketId: item.ticketId, chore: item.kind === 'chore', label: item.label });
    touch(a);
    p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: item.text } }) + '\n');
    // Jobs that arrived while the lead was between turns (a fresh-session restart) can now go to a parallel desk.
    maybeTwin(a);
  }

  function finishResidentTurn(a, text, isError) {
    const item = a.current;
    a.current = null;
    a.lastActiveAt = now();
    a.status = procs.get(a.id) ? 'idle' : 'offline';
    if (item && item.refresh) {
      a.sessionId = null;
      a.resetting = true;
      a.contextTokens = 0;
      a.lastRefreshAt = now();
      addEvent(a, { kind: 'system', text: 'Saved what matters to memory; starting a fresh session.' });
      touch(a);
      restartResident(a.id);
      return;
    }
    if (item && (item.kind === 'message' || item.kind === 'chore')) {
      if (item.kind === 'chore') { a.result = text; addEvent(a, { kind: 'system', text: 'Finished tidying the team library.' }); broadcast({ type: 'docs', team: a.id, by: a.id, page: 'INDEX.md' }); }
      touch(a);
      pumpResident(a);
      if (!a.twinOf) maybeTidy(a.id);
      return;
    }
    a.result = text;
    if (item) a.ticketsHandled = (a.ticketsHandled || 0) + 1;
    touch(a);
    if (item) onResidentReply(a, item, text, isError);
    const roster = readJson('roster.json');
    const every = roster.defaults.rootFreshEvery || 0;
    if (a.id === roster.root && item && every && a.ticketsHandled % every === 0) {
      a.sessionId = null;
      a.resetting = true;
      addEvent(a, { kind: 'system', text: `Starting a fresh session (every ${every} tickets, so routing stays cheap).` });
      restartResident(a.id);
      return;
    }
    if (a.restartWhenIdle && !a.inbox.length) { a.restartWhenIdle = false; restartResident(a.id); return; }
    maybeRefresh(a);
    pumpResident(a);
    if (!a.twinOf) maybeTidy(a.id);
  }

  function onResidentReply(a, item, text, isError) {
    const roster = readJson('roster.json');
    const t = tickets.get(item.ticketId);
    if (!t || t.status === 'stopped') return;
    if (a.id === roster.root) {
      t.pending = t.pending.filter((k) => k !== a.id);
      if (t.pending.length) {
        thread(t, { from: a.id, kind: 'note', text });
      } else {
        t.answer = text;
        t.status = isError ? 'failed' : 'done';
        t.closedAt = now();
        thread(t, { from: a.id, kind: 'answer', text });
      }
      return;
    }
    t.pending = t.pending.filter((k) => k !== a.id);
    t.answer = t.answer && t.assignees.length > 1 ? `${t.answer}\n\n---\n\n${text}` : text;
    const silent = arms.onAnswer(t, text);
    thread(t, { from: a.id, to: 'user', kind: 'answer', text, silent });
    if (!t.pending.length) {
      t.status = isError ? 'failed' : 'done';
      t.closedAt = now();
      if (isError) lessons.ask(t, 'failed');
      touchTicket(t);
    }
  }

  function restartResident(key) {
    const p = procs.get(key);
    const a = agents.get(key);
    if (a) a.killing = true;
    if (p) { try { process.kill(-p.pid, 'SIGTERM'); } catch { try { p.kill('SIGTERM'); } catch {} } }
    else startResident(key);
  }

  // ---------------------------------------------------------------- twins: a second desk for a busy lead

  const twinsOf = (lead) => [...agents.values()].filter((x) => x.twinOf === lead.id);
  const liveTwin = (x) => x && x.twinOf && !x.retired;

  // A busy lead hands each waiting job for another ticket to a twin: the ticket's own live twin if it has one, else an
  // idle twin, else a new one while fewer than defaults.leadTwins are alive. Follow-ups on the lead's current ticket,
  // mail and housekeeping stay with the lead.
  function maybeTwin(a) {
    if (a.twinOf || !a.current || !a.inbox.length || limits.hold || isRestartPending() || isShuttingDown()) return;
    const roster = readJson('roster.json');
    if (a.id === roster.root || !roster.residents.includes(a.id)) return;
    const max = Math.max(0, Number(roster.defaults.leadTwins ?? 1) || 0);
    if (!max) return;
    const busyOn = a.current.ticketId;
    for (;;) {
      const item = a.inbox.find((i) => i.ticketId && i.ticketId !== busyOn && (i.kind === 'direct' || i.kind === 'ticket') && (tickets.get(i.ticketId) || {}).status !== 'paused');
      if (!item) return;
      const t = tickets.get(item.ticketId);
      const live = twinsOf(a).filter(liveTwin);
      let tw = (t && t.twin && live.find((x) => x.id === t.twin)) || live.find((x) => !x.current && !x.inbox.length);
      if (!tw && live.length < max) {
        const taken = new Set(live.map((x) => x.twinNo));
        let no = 2;
        while (taken.has(no)) no++;
        const id = `${a.id}~${no}`;
        tw = agents.get(id) || baseAgent({ id, role: a.id, resident: true, twinOf: a.id, twinNo: no, depth: a.depth, parentId: a.parentId,
          inbox: [], current: null, ticketsHandled: 0, status: 'offline' });
        Object.assign(tw, { retired: false, sessionId: null, lastActiveAt: now(), runEffort: effortFor(roster, tw, item) || undefined });
        agents.set(id, tw);
        ensureResident(roster, id);
      }
      if (!tw) return;
      const moving = a.inbox.filter((i) => i.ticketId === item.ticketId);
      a.inbox = a.inbox.filter((i) => i.ticketId !== item.ticketId);
      tw.inbox.push(...moving);
      tw.lastActiveAt = now();
      if (t) {
        t.twin = tw.id;
        t.pending = [...new Set(t.pending.map((k) => (k === a.id ? tw.id : k)))];
        touchTicket(t);
      }
      addEvent(a, { kind: 'system', text: `Busy on ticket #${(tickets.get(busyOn) || {}).n || '?'}, so ${tw.persona} takes ticket #${t ? t.n : '?'}.` });
      touch(a);
      touch(tw);
      if (procs.get(tw.id)) pumpResident(tw); else startResident(tw.id);
    }
  }

  function retireTwin(tw, why) {
    const lead = agents.get(tw.twinOf);
    tw.retired = true;
    if (lead && tw.inbox.length) { lead.inbox.push(...tw.inbox); tw.inbox = []; }
    for (const t of tickets.values()) if (t.twin === tw.id) { delete t.twin; touchTicket(t); }
    addEvent(tw, { kind: 'system', text: why });
    const p = procs.get(tw.id);
    if (p) { try { process.kill(-p.pid, 'SIGTERM'); } catch { try { p.kill('SIGTERM'); } catch {} } }
    else tw.status = 'offline';
    touch(tw);
    if (lead) pumpResident(lead);
  }

  // Twins idle for defaults.twinIdleMinutes (20) retire, and so do idle twins beyond defaults.leadTwins.
  function retireIdleTwins() {
    if (isShuttingDown()) return;
    const roster = readJson('roster.json');
    const idleMs = Math.max(1, Number(roster.defaults.twinIdleMinutes) || 20) * 60000;
    const max = Math.max(0, Number(roster.defaults.leadTwins ?? 1) || 0);
    const byLead = {};
    for (const tw of agents.values()) if (liveTwin(tw)) (byLead[tw.twinOf] = byLead[tw.twinOf] || []).push(tw);
    for (const list of Object.values(byLead)) {
      let alive = list.length;
      for (const tw of list) {
        if (tw.current || tw.inbox.length) continue;
        const waitedOn = [...tickets.values()].some((t) => t.status === 'open' && t.pending.includes(tw.id));
        if (waitedOn) continue;
        if (alive > max) { retireTwin(tw, 'Retired: fewer second desks are allowed now.'); alive--; }
        else if (now() - (tw.lastActiveAt || 0) > idleMs) { retireTwin(tw, `Retired after ${Math.round(idleMs / 60000)} idle minutes; later messages on my tickets go to the lead.`); alive--; }
      }
    }
  }
  setInterval(retireIdleTwins, 30000).unref();

  return { PERSONAS, baseAgent, startResident, enqueueResident, pumpResident, restartResident, retireTwin };
}

module.exports = { install };
