'use strict';
// Recovery: interrupted jobs and stuck agents.
// - A job is "interrupted" (not failed) when the office restarted while it ran, or its lead's process died mid-turn.
//   Resume sends the lead what already happened on the job (files changed, commands run and their exit codes, the
//   last progress note, the last messages), and tells it to check the current state before redoing anything, so a
//   resumed job doesn't install, migrate, send or delete twice.
// - The watchdog flags an agent that has been working on a job with no activity (no tool calls, output or progress)
//   for defaults.stuckMinutes (15), unless it is waiting on the user or an office command is running for it. The job
//   shows a banner with Nudge (a message asking for a status) and Restart (stop the lead's turn; the job becomes
//   interrupted and can be resumed).

function install(ctx) {
  const { ACTIVE, agents, broadcast, enqueueResident, eventsOf, now, readJson, restartResident, thread, tickets, touchTicket } = ctx;
  const tilde = (p) => String(p).replace(require('os').homedir(), '~');

  function leadOf(t) {
    const twin = t.twin && agents.get(t.twin);
    if (twin && !twin.retired) return twin;
    const root = readJson('roster.json').root;
    const k = t.direct || (t.assignees || []).find((x) => x !== root);
    return k && agents.get(k);
  }

  function markInterrupted(t, why) {
    if (!t || ['done', 'failed', 'stopped'].includes(t.status)) return;
    t.status = 'interrupted';
    t.pending = [];
    t.closedAt = now();
    t.interruptedWhy = why;
    t.stuck = null;
    thread(t, { from: 'system', kind: 'system', text: `Interrupted: ${why}. Press Resume to continue; the lead gets what already happened on the job, so nothing is done twice.` });
    broadcast({ type: 'notify', kind: 'warn', ticketId: t.id, title: `#${t.n} was interrupted`, text: `${why}. Open it to resume.` });
    touchTicket(t);
  }

  // What already happened on a job, for the lead that picks it up again.
  function resumeBrief(t, lead) {
    const lines = [`[Ticket #${t.n} resumed by the user after an interruption: ${t.interruptedWhy || 'the work stopped before it finished'}]`,
      `The task: ${t.text.slice(0, 1500)}`];
    const changes = (t.changes || []).slice(0, 40);
    if (changes.length) lines.push(`Files already changed on this job (they keep those changes): ${changes.map((c) => tilde(c.path)).join(', ')}`);
    const cmds = (t.commands || []).filter((c) => c.status !== 'pending').slice(-15);
    if (cmds.length) lines.push(`Commands already run on this job:\n${cmds.map((c) => `- \`${c.command.slice(0, 160)}\` → ${c.exitCode != null ? `exit ${c.exitCode}` : c.status}`).join('\n')}`);
    const ev = lead ? eventsOf(lead).filter((e) => e.ticketId === t.id || !e.ticketId).filter((e) => e.kind === 'progress').slice(-3) : [];
    if (ev.length) lines.push(`Your last progress notes: ${ev.map((e) => e.text).join(' / ')}`);
    const msgs = (t.thread || []).filter((e) => ['answer', 'followup', 'reply', 'note'].includes(e.kind)).slice(-3);
    if (msgs.length) lines.push(`Last messages on the job:\n${msgs.map((e) => `- ${e.from === 'user' ? 'User' : (agents.get(e.from) || {}).persona || e.from}: ${String(e.text).slice(0, 400)}`).join('\n')}`);
    lines.push('Before doing anything, check the current state (read the changed files, git status, whether the build or tests pass). ' +
      'Do NOT repeat actions that already happened (installs, migrations, deletions, messages sent, files written); continue from where the work stopped, ' +
      'then answer the user as usual.');
    return lines.join('\n\n');
  }

  function resume(t) {
    if (!t || t.status !== 'interrupted') return { error: 'Only an interrupted job can be resumed.' };
    const lead = leadOf(t);
    if (!lead) return { error: 'Nobody owns this job any more; send it as a new job instead.' };
    t.status = 'open';
    t.closedAt = null;
    t.resumes = (t.resumes || 0) + 1;
    if (!t.pending.includes(lead.id)) t.pending.push(lead.id);
    thread(t, { from: 'system', kind: 'system', text: `Resumed by you; ${lead.persona} gets what already happened on the job.` });
    touchTicket(t);
    enqueueResident(lead.id, { ticketId: t.id, kind: 'direct', text: resumeBrief(t, lead) });
    return { ok: true };
  }

  // ------------------------------------------------------------ the watchdog
  function lastActivity(a) {
    const evs = eventsOf(a);
    return Math.max(evs.length ? evs[evs.length - 1].t || 0 : 0, a.turnStartedAt || 0, a.startedAt || 0);
  }

  function watchdog() {
    const mins = Number(readJson('roster.json').defaults.stuckMinutes ?? 15);
    if (!mins) return;
    const limit = mins * 60000;
    const busy = new Map(); // ticketId → stuck agent
    for (const a of agents.values()) {
      const tid = a.resident ? a.current && a.current.ticketId : ACTIVE.includes(a.status) && a.ticketId;
      if (!tid) continue;
      const t = tickets.get(tid);
      if (!t || t.status !== 'open' || t.waiting || (t.plan && t.plan.status === 'pending')) continue;
      if ((t.access || []).some((r) => r.status === 'pending')) continue;
      if ((t.commands || []).some((c) => ['pending', 'running'].includes(c.status))) continue;
      if (t.verify && t.verify.status === 'running') continue;
      const idle = now() - lastActivity(a);
      if (idle > limit && !busy.has(tid)) busy.set(tid, { a, idle });
    }
    for (const t of tickets.values()) {
      const s = busy.get(t.id);
      if (s && !t.stuck) {
        t.stuck = { agentId: s.a.id, persona: s.a.persona, since: now() - s.idle };
        broadcast({ type: 'notify', kind: 'warn', ticketId: t.id, title: `${s.a.persona} looks stuck on #${t.n}`, text: `No activity for ${Math.round(s.idle / 60000)} minutes. Open the job to nudge or restart.` });
        touchTicket(t);
      } else if (!s && t.stuck) { t.stuck = null; touchTicket(t); }
    }
  }

  function nudge(t) {
    const s = t && t.stuck;
    const a = s && agents.get(s.agentId);
    if (!a) return { error: 'Nothing is stuck on this job.' };
    if (a.resident) enqueueResident(a.id, { ticketId: t.id, kind: 'direct', text: `[Office, ticket #${t.n}] You have shown no activity for a while. If you are waiting on something, say what; otherwise report progress with report_progress and carry on, or answer the user with where things stand.` });
    t.stuck = { ...s, nudgedAt: now() };
    thread(t, { from: 'system', kind: 'system', text: `Nudged ${a.persona} for a status update.` });
    touchTicket(t);
    return { ok: true };
  }

  function restart(t) {
    const s = t && t.stuck;
    const a = s && agents.get(s.agentId);
    if (!a) return { error: 'Nothing is stuck on this job.' };
    const lead = a.resident ? a : agents.get(a.homeId);
    markInterrupted(t, `${a.persona} was restarted after ${Math.round((now() - s.since) / 60000)} minutes without activity`);
    if (lead && lead.resident) restartResident(lead.id);
    return { ok: true };
  }

  async function route(req, res, url, p, body, json) {
    const m = req.method === 'POST' && p.match(/^\/api\/tickets\/(\w+)\/(continue|nudge|restart-stuck)$/);
    if (!m) return false;
    const t = tickets.get(m[1]);
    if (!t) return json(res, 404, { error: 'not found' }), true;
    const r = m[2] === 'continue' ? resume(t) : m[2] === 'nudge' ? nudge(t) : restart(t);
    return json(res, r.error ? 400 : 200, r), true;
  }

  return { leadOf, markInterrupted, nudge, restart, resume, resumeBrief, route, watchdog };
}

module.exports = { install };
