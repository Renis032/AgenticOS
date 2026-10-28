'use strict';
const { killGroup } = require('./kill-group');
// Staff: sub-agents a lead delegates to, hiring or reusing a teammate, model choice, the run queue, delegation batches and the manager's assign. Moved out of server.js unchanged.

function install(ctx) {
  const { ACTIVE, addEvent, agents, arms, assignPids, attachText, baseAgent, briefExtras, batches, broadcast, buildArgs, childEnv, childRolesFor,
    chooseModel, CLAUDE_BIN, crypto, EFFORTS, enqueueResident, home, inWorkRepo, isRestartPending, limits, mail, mailWake, MAX_RUNNING,
    modelOf, MODELS, newId, now, onCall, onStreamMessage, pendingFeedback, PERSONAS, planGate, procs, queue, readJson, readLines,
    readMemory, restartResident, spawn, takeUnread, thread, tickets, touch, waiters, waitForBudget } = ctx;

  function runningCount() {
    let n = 0;
    for (const a of agents.values()) if (!a.resident && a.status === 'running') n++;
    return n;
  }

  function pump() {
    if (limits.hold || isRestartPending()) return;
    while (queue.length && runningCount() < MAX_RUNNING) {
      const { a, prompt, resume } = queue.shift();
      if (a.status === 'queued') launch(a, prompt, resume);
    }
  }

  function pickPersona() {
    const taken = new Set([...agents.values()].map((x) => x.persona));
    const free = PERSONAS.filter((n) => !taken.has(n));
    if (free.length) return free[crypto.randomInt(free.length)];
    for (let i = 2; ; i++) {
      const n = PERSONAS[crypto.randomInt(PERSONAS.length)] + ' ' + i;
      if (!taken.has(n)) return n;
    }
  }

  function findStaff(roster, homeId, x, t) {
    const pool = [...agents.values()].filter((s) => s.staff && s.homeId === homeId && s.status === 'idle');
    const sameRole = (s) => (x.role === 'custom'
      ? s.role === 'custom' && s.name.toLowerCase() === String(x.name || 'Specialist').slice(0, 40).toLowerCase() &&
        (s.customDef.permissionMode === 'acceptEdits') === (x.access === 'edit')
      : s.role === x.role);
    if (x.who) {
      const w = pool.find((s) => s.persona.toLowerCase() === String(x.who).toLowerCase());
      if (w && sameRole(w)) return w;
    }
    return pool.filter((s) => onCall.available(s, t) && sameRole(s)).sort((p, q) => (q.tasksDone || 0) - (p.tasksDone || 0))[0] || null;
  }

  function staffList(agentId) {
    const me = agents.get(agentId);
    if (!me) return 'Unknown agent.';
    const homeId = me.resident ? me.twinOf || me.id : me.homeId;
    const list = [...agents.values()].filter((s) => s.staff && s.homeId === homeId).sort((p, q) => (q.tasksDone || 0) - (p.tasksDone || 0));
    const describe = (s) => {
      const last = (s.history || []).slice(-1)[0];
      return `- ${s.persona} — ${s.name} (${s.role === 'custom' ? 'custom' : s.role}) — ${s.status === 'idle' ? 'free' : 'busy: ' + s.title} — ` +
        `${s.tasksDone || 0} done, ${s.tasksFailed || 0} not completed${s.model ? ` — last ran on ${s.model}/${s.effort}` : ''}` +
        `${last ? ` — last task: #${last.n} ${last.title}` : ''}${readMemory(s.id) ? ' — has memory' : ''}`;
    };
    return onCall.staffLines(list, ticketOfAgent(me), describe) +
      '\n\nDelegating reuses a free teammate of that role (the most experienced, or the one you name with `who`). ' +
      'If nobody suitable is free, someone new is hired: roster roles join the team; custom specialists are on call for this ' +
      'project only, unless you set `stay: "team"` because the role is useful beyond it.';
  }

  function ticketOfAgent(a) {
    if (a.resident) return a.current && tickets.get(a.current.ticketId);
    return tickets.get(a.ticketId);
  }

  function pickModel(roster, parent, x, def) {
    if (x.__pick) return x.__pick;
    const cap = MODELS.indexOf(modelOf(roster, parent).model);
    if (x.pin_model && MODELS.includes(x.model)) {
      const model = MODELS[Math.min(cap, MODELS.indexOf(x.model))];
      const effort = EFFORTS.includes(x.effort) ? x.effort : (def.effort || roster.defaults.effort);
      return { model, effort, choice: `pinned by ${parent.persona}: ${String(x.pin_reason || 'no reason given').slice(0, 200)}` };
    }
    const util = Math.max(0, ...Object.values(limits.windows || {}).map((w) => (w.resetsAt > now() ? w.utilization : 0)));
    const r = chooseModel({ role: x.role, roleDef: x.role === 'custom' ? null : def, name: x.name || def.name, task: `${x.title || ''}\n${x.task || ''}`,
      agents: [...agents.values()], tickets: [...tickets.values()], capModel: MODELS[cap], values: roster.defaults.taskValueUsd, utilization: util });
    return { model: r.model, effort: r.effort, choice: `EV model: ${r.reason}` };
  }

  function createTemp(roster, parent, x) {
    const t = ticketOfAgent(parent);
    const homeId = parent.resident ? parent.twinOf || parent.id : parent.homeId;
    const existing = findStaff(roster, homeId, x, t);
    if (existing) {
      const def = existing.customDef || roster.roles[existing.role];
      const { model, effort, choice, pickId, source: pickSource } = pickModel(roster, parent, x, def);
      Object.assign(existing, { model, effort, choice, pickId, pickSource, title: x.title, task: x.task, parentId: parent.id,
        ticketId: t ? t.id : null, ticketN: t ? t.n : null, depth: parent.depth + 1, children: [],
        result: null, error: null, progress: null, percent: null, sessionId: null, startedAt: null, endedAt: null,
        taskCostStart: existing.costUsd, status: 'queued', newHire: false });
      onCall.onReuse(existing, x, t);
      if (t && !existing.tickets.includes(t.id)) existing.tickets.push(t.id);
      if (!parent.children.includes(existing.id)) parent.children.push(existing.id);
      touch(parent);
      touch(existing);
      return existing;
    }
    let customDef = null;
    if (x.role === 'custom') {
      const edit = x.access === 'edit';
      customDef = { name: (x.name || 'Specialist').slice(0, 40), description: 'Custom specialist',
        prompt: x.instructions || '', tools: edit ? (inWorkRepo(parent.cwd) ? 'edit' : 'personal') : 'readonly',
        permissionMode: edit ? 'acceptEdits' : 'default', children: [], cwd: parent.cwd };
    }
    const def = customDef || roster.roles[x.role];
    const { model, effort, choice, pickId, source: pickSource } = pickModel(roster, parent, x, def);
    const a = baseAgent({
      model, effort, choice, pickId, pickSource,
      id: newId(), role: x.role, customDef, name: def.name, persona: pickPersona(), title: x.title, task: x.task,
      parentId: parent.id, homeId,
      ticketId: t ? t.id : null, ticketN: t ? t.n : null, depth: parent.depth + 1,
      cwd: customDef ? parent.cwd : home(def.cwd || '~'),
      staff: true, tickets: t ? [t.id] : [], history: [], feedback: [], tasksDone: 0, tasksFailed: 0,
      taskCostStart: 0, hiredAt: now(), newHire: true, scopeChecked: true,
    });
    onCall.onHire(a, x, t);
    agents.set(a.id, a);
    assignPids();
    parent.children.push(a.id);
    touch(parent);
    touch(a);
    return a;
  }

  function enqueue(a, prompt, resume) {
    a.status = 'queued';
    touch(a);
    const done = new Promise((resolve) => waiters.set(a.id, resolve));
    queue.push({ a, prompt, resume });
    pump();
    return done;
  }

  function launch(a, prompt, resume) {
    const roster = readJson('roster.json');
    const args = buildArgs(roster, a);
    pendingFeedback(a).forEach((f) => { f.seen = true; });
    if (resume && a.sessionId) args.push('--resume', a.sessionId);
    a.liveUsd = 0;
    a.status = 'running';
    a.startedAt = a.startedAt || now();
    a.endedAt = null;
    a.error = null;
    touch(a);
    addEvent(a, { kind: resume ? 'followup' : 'brief', text: prompt, ticketId: a.ticketId });

    const child = spawn(CLAUDE_BIN, args, { cwd: a.cwd, env: childEnv(a), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    procs.set(a.id, child);
    child.stdin.end(prompt);
    readLines(child.stdout, (line) => {
      let m;
      try { m = JSON.parse(line); } catch { return addEvent(a, { kind: 'log', text: line }); }
      const r = onStreamMessage(a, m);
      if (r && r.done) {
        a.result = r.text;
        if (r.isError) { a.status = 'failed'; a.error = r.text; } else a.status = 'done';
        touch(a);
      }
    });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (e) => { stderr += e.message; });
    child.on('close', (code) => {
      procs.delete(a.id);
      if (ACTIVE.includes(a.status)) {
        a.status = code === 0 && !a.error ? 'done' : 'failed';
        if (a.status === 'failed' && !a.error) a.error = (stderr.trim() || `exit code ${code}`).slice(-2000);
      }
      if (stderr.trim()) addEvent(a, { kind: 'log', text: stderr.trim().slice(-4000) });
      a.endedAt = now();
      finishStaffTask(a);
      touch(a);
      const w = waiters.get(a.id);
      if (w) { waiters.delete(a.id); w(a); }
      pump();
    });
  }

  function finishStaffTask(a) {
    a.lastOutcome = a.status;
    try { arms.recordOutcome(a); } catch {}
    if (!a.staff) return;
    if (a.pauseStop) {
      a.pauseStop = false;
      a.lastOutcome = 'paused';
      a.status = 'idle';
      a.history = a.history || [];
      a.history.push({ ticketId: a.ticketId, n: a.ticketN, title: a.title, outcome: 'paused', costUsd: a.costUsd - (a.taskCostStart || 0), model: `${a.model}/${a.effort}`, t: now() });
      return;
    }
    a.history = a.history || [];
    a.history.push({ ticketId: a.ticketId, n: a.ticketN, title: a.title, outcome: a.lastOutcome,
      costUsd: a.costUsd - (a.taskCostStart || 0), model: `${a.model}/${a.effort}`, t: now() });
    if (a.history.length > 60) a.history.splice(0, a.history.length - 60);
    if (a.lastOutcome === 'done') a.tasksDone = (a.tasksDone || 0) + 1;
    else a.tasksFailed = (a.tasksFailed || 0) + 1;
    a.status = 'idle';
    a.newHire = false;
  }

  function stopTree(id) {
    const a = agents.get(id);
    if (!a) return;
    if (a.resident) {
      if (a.current) restartResident(a.id);
      return;
    }
    for (const c of a.children) stopTree(c);
    const qi = queue.findIndex((q) => q.a.id === id);
    if (qi >= 0) queue.splice(qi, 1);
    if (ACTIVE.includes(a.status)) {
      a.status = 'stopped';
      a.endedAt = now();
      touch(a);
    }
    const p = procs.get(id);
    if (p) killGroup(p);
    const w = waiters.get(id);
    if (w && !p) { finishStaffTask(a); touch(a); waiters.delete(id); w(a); }
  }

  async function delegate(parentId, assignments) {
    const parent = agents.get(parentId);
    if (!parent) return { error: 'Unknown agent ' + parentId };
    if (['stopped', 'failed', 'offline'].includes(parent.status)) return { error: 'You are no longer active.' };
    const roster = readJson('roster.json');
    const allowed = childRolesFor(roster, parent);
    const bad = assignments.filter((x) => !allowed.includes(x.role));
    if (bad.length) return { error: `Not allowed to start: ${bad.map((b) => b.role).join(', ')}. Allowed: ${allowed.join(', ') || 'none'}.` };
    const t = ticketOfAgent(parent);
    if (t && t.status === 'stopped') return { error: 'This ticket was stopped by the user.' };
    if (t && t.status === 'paused') return { error: 'The user paused this ticket.' };
    const gate = planGate(roster, parent, t, assignments);
    if (gate) return { error: gate };
    if (t && t.overBudget) {
      parent.progress = `Paused: ticket #${t.n} hit its budget — waiting for the user.`;
      addEvent(parent, { kind: 'progress', text: parent.progress });
      parent.status = 'delegating';
      touch(parent);
      const ok = await waitForBudget(t);
      if (parent.status === 'delegating') { parent.status = 'running'; touch(parent); }
      if (!ok) return { error: 'The user stopped this ticket.' };
    }

    const picks = await Promise.all(assignments.map((x) => arms.decideModel({ roster, cap: modelOf(roster, parent).model, role: x.role,
      roleDef: x.role === 'custom' ? null : roster.roles[x.role], name: x.name, task: `${x.title || ''}\n${x.task || ''}`,
      pin: x.pin_model ? { model: x.model, effort: x.effort, reason: `pinned by ${parent.persona}: ${x.pin_reason || 'no reason given'}` } : null, kind: 'subagent', ticketId: t ? t.id : null })));
    assignments.forEach((x, i) => { x.__pick = picks[i]; });
    const kids = assignments.map((x) => createTemp(roster, parent, x));
    addEvent(parent, { kind: 'delegate', text: kids.map((k) => `${k.persona} (${k.name}) on ${k.model}/${k.effort}: ${k.title}\n  ${k.choice}`).join('\n'), children: kids.map((k) => k.id) });
    if (t) thread(t, { from: parent.id, kind: 'team', text: kids.map((k) => `${k.persona} (${k.name}${k.newHire ? ', new hire' : ''}${k.onCall ? `, on call for ${k.onCall.project || 'this job'}` : ''}) — ${k.title} · ${k.model}/${k.effort}`).join('\n'),
      choices: kids.map((k) => ({ id: k.id, model: `${k.model}/${k.effort}`, why: k.choice })), agents: kids.map((k) => k.id) });
    const batch = { id: newId(), parentId: parent.id, kids,
      all: Promise.all(kids.map((k) => enqueue(k, k.task, false))).then((finished) => finished.map((c) => ({
        id: c.id, role: c.role === 'custom' ? c.name : c.role, persona: c.persona, title: c.title, status: c.lastOutcome, model: `${c.model}/${c.effort}`, why: c.choice,
        result: c.lastOutcome === 'done' ? c.result : `${String(c.lastOutcome).toUpperCase()}: ${c.error || ''}\n${c.result || ''}` }))) };
    batches.set(batch.id, batch);
    return awaitBatch(parent, batch);
  }

  async function awaitBatch(parent, batch) {
    parent.status = 'delegating';
    touch(parent);
    const r = await new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (settled) return; settled = true; mailWake.delete(parent.id); resolve(v); };
      batch.all.then((results) => finish({ results }));
      if (mail.some((m) => m.to === parent.id && !m.read && m.ask)) return finish({ question: true });
      mailWake.set(parent.id, () => finish({ question: true }));
    });
    if (parent.status === 'delegating') { parent.status = 'running'; touch(parent); }
    if (r.results) { batches.delete(batch.id); return { results: r.results }; }
    const still = batch.kids.filter((k) => ACTIVE.includes(k.status)).map((k) => `${k.persona} (${k.name})`);
    return { batchId: batch.id, question: takeUnread(parent.id), waitingOn: still };
  }

  function waitForTeam(agentId, batchId) {
    const parent = agents.get(agentId);
    const batch = batches.get(batchId);
    if (!parent || !batch || batch.parentId !== agentId) return Promise.resolve({ error: `No team batch "${batchId}" is waiting for you.` });
    return awaitBatch(parent, batch);
  }

  function assign(agentId, to, brief, effort) {
    const roster = readJson('roster.json');
    const mgr = agents.get(agentId);
    const def = mgr && roster.roles[mgr.role];
    if (!def || !def.assignTo) return { error: 'Only the manager can assign tickets.' };
    if (!def.assignTo.includes(to)) return { error: `Unknown lead ${to}. Leads: ${def.assignTo.join(', ')}` };
    const t = mgr.current && tickets.get(mgr.current.ticketId);
    if (!t) return { error: 'No current ticket to assign.' };
    if (t.status === 'stopped') return { error: 'The user stopped this ticket.' };
    const lead = agents.get(to);
    if (EFFORTS.includes(effort) && t.leadEffortBy !== 'user') { t.leadEffort = effort; t.leadEffortBy = mgr.id; }
    if (!t.pending.includes(to)) t.pending.push(to);
    if (!t.assignees.includes(to)) t.assignees.push(to);
    thread(t, { from: mgr.id, to, kind: 'assign', text: brief });
    broadcast({ type: 'handoff', from: mgr.id, to, kind: 'assign', ticketId: t.id });
    const ahead = enqueueResident(to, { ticketId: t.id, kind: 'ticket',
      text: `[Ticket #${t.n} from ${mgr.persona} (${mgr.name})]\n${brief}${attachText(t.attachments)}${briefExtras(t)}\n\n(Your final message goes directly to the user as the answer.)` });
    const busy = ahead > 0 ? ` ${lead.persona} is busy; it is number ${ahead} in their inbox.` : '';
    return { message: `Ticket #${t.n} is with ${lead.persona} (${lead.name}).${busy} They will answer the user directly; you are done with this ticket.` };
  }

  return { pump, staffList, ticketOfAgent, enqueue, stopTree, delegate, waitForTeam, assign };
}

module.exports = { install };
