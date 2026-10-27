'use strict';
// Who stays on a team. Roster roles and specialists that proved generally useful are permanent staff. A custom specialist
// hired for one project is "on call" for that project: reused whenever that project is worked on again, off the team
// list otherwise (memory and track record are kept). Used on a second project, they have proven generally useful and join
// the team. Leads choose with `stay` when hiring; the user can switch it in Processes.
//
// a.onCall = { project: 'FridgeOracle' | null, since } on staff who are on call; absent on permanent staff.
//
// Two clean-ups keep the list short:
// - Duplicates: a lead may hire several of the same specialist at once so a job finishes faster (they work in parallel).
//   Once that job is closed, the extras retire and the one with the best record stays on call.
// - Unused: an on-call specialist not used for 30 days (no project) or 90 days (with one) retires.
// Retired staff (a.retired = { t, why }) are off every list, their memory moves to data/memory/archive/, and they come
// back with it when a lead names them with `who` or you press "Bring back" in Processes.

const fs = require('fs');
const path = require('path');
const DAY = 86400000;

function install(ctx) {
  const { agents, tickets, touch, now, DATA } = ctx;
  const memFile = (a, archived) => path.join(DATA, 'memory', ...(archived ? ['archive'] : []), `${a.id}.md`);

  // The project a job is about: the project folder it names (from its handoff), else the configured project.
  function jobProject(t) {
    if (!t) return null;
    return (t.handoffs || [])[0] || t.project || null;
  }
  const projectsOf = (a) => [...new Set((a.tickets || []).map((id) => jobProject(tickets.get(id))).filter(Boolean))];

  // Can this teammate be picked for a job without being named? Permanent staff always; on-call staff only for their project.
  function available(a, t) {
    if (a.retired) return false;
    if (!a.onCall) return true;
    return !!a.onCall.project && a.onCall.project === jobProject(t);
  }

  // A new hire: roster roles join the team; custom specialists go on call for the job's project unless the lead says
  // `stay: "team"`.
  function onHire(a, x, t) {
    const stay = x.stay || (a.role === 'custom' ? 'project' : 'team');
    if (stay === 'project') a.onCall = { project: jobProject(t), since: now() };
  }

  // A teammate reused for a job: `stay` from the lead decides; otherwise an on-call teammate working on a second project joins
  // the team.
  function onReuse(a, x, t) {
    if (a.retired) bringBack(a);
    if (x.stay === 'team') return promote(a, 'kept by their lead');
    if (x.stay === 'project') { a.onCall = { project: jobProject(t), since: now() }; return; }
    const p = jobProject(t);
    if (a.onCall && p && a.onCall.project && p !== a.onCall.project) promote(a, `worked on ${a.onCall.project} and ${p}`);
    else if (a.onCall && p && !a.onCall.project) a.onCall.project = p;
  }
  function promote(a, why) {
    if (!a.onCall) return;
    delete a.onCall;
    a.joinedTeam = { t: now(), why };
  }

  function retire(a, why) {
    if (a.retired) return;
    a.retired = { t: now(), why };
    try { fs.mkdirSync(path.dirname(memFile(a, true)), { recursive: true }); fs.renameSync(memFile(a), memFile(a, true)); } catch { /* no memory yet */ }
    touch(a);
  }
  function bringBack(a) {
    if (!a.retired) return;
    delete a.retired;
    try { if (!fs.existsSync(memFile(a))) fs.renameSync(memFile(a, true), memFile(a)); } catch { /* nothing archived */ }
    touch(a);
  }
  const lastUsed = (a) => Math.max(a.hiredAt || 0, ...(a.history || []).map((h) => h.t || 0));

  // After a job closes: specialists hired for it at the same time, with the same job title, were extra hands for speed.
  // Keep the one with the best record; the rest retire.
  function mergeDuplicates() {
    let merged = 0;
    for (const t of tickets.values()) {
      if (!t.closedAt || t.staffMerged) continue;
      t.staffMerged = true;
      const groups = new Map();
      for (const a of agents.values()) {
        if (!a.staff || !a.onCall || a.retired || a.role !== 'custom' || (a.tickets || [])[0] !== t.id || a.status !== 'idle') continue;
        const key = `${a.homeId}|${String((a.customDef || {}).name || a.name).toLowerCase()}`;
        groups.set(key, [...(groups.get(key) || []), a]);
      }
      for (const list of groups.values()) {
        if (list.length < 2) continue;
        const score = (x) => (x.tasksDone || 0) - (x.tasksFailed || 0);
        list.sort((p, q) => score(q) - score(p) || (q.tasksDone || 0) - (p.tasksDone || 0) || (p.hiredAt || 0) - (q.hiredAt || 0));
        for (const a of list.slice(1)) { retire(a, `extra ${list[0].name} for job #${t.n}; ${list[0].persona} stays on call`); merged++; }
      }
    }
    return merged;
  }
  // On-call specialists nobody has used for a long time.
  function retireUnused() {
    let n = 0;
    for (const a of agents.values()) {
      if (!a.staff || !a.onCall || a.retired || a.status !== 'idle') continue;
      const days = a.onCall.project ? 90 : 30;
      if (now() - lastUsed(a) > days * DAY) { retire(a, `not used for ${days} days`); n++; }
    }
    return n;
  }

  // The user's switch in Processes.
  function setScope(id, team, restoreOnly) {
    const a = agents.get(id);
    if (!a || !a.staff) return { error: 'Not a teammate.' };
    if (a.retired) bringBack(a);
    if (restoreOnly) return { ok: true, onCall: a.onCall || null };
    if (team) promote(a, 'kept by you');
    else { const ps = projectsOf(a); a.onCall = { project: ps[ps.length - 1] || null, since: now() }; delete a.joinedTeam; }
    touch(a);
    return { ok: true, onCall: a.onCall || null };
  }

  // Staff hired before this existed: custom specialists used on one project (or none) go on call; the rest stay.
  function migrate() {
    let changed = 0;
    for (const a of agents.values()) {
      if (!a.staff || a.scopeChecked) continue;
      a.scopeChecked = true;
      changed++;
      if (a.role !== 'custom') continue;
      const ps = projectsOf(a);
      if (ps.length < 2) a.onCall = { project: ps[0] || null, since: now() };
    }
    return changed;
  }

  // How a lead's `staff` list describes the on-call people relevant to this job, and how many others are off.
  function staffLines(list, t, describe) {
    const p = jobProject(t);
    const retired = list.filter((s) => s.retired);
    list = list.filter((s) => !s.retired);
    const team = list.filter((s) => !s.onCall);
    const here = list.filter((s) => s.onCall && p && s.onCall.project === p);
    const away = list.filter((s) => s.onCall && !(p && s.onCall.project === p));
    const out = [];
    out.push(team.length ? `Your team:\n${team.map(describe).join('\n')}` : 'Your team has no permanent staff yet.');
    if (here.length) out.push(`On call for ${p} (hired for this project; reused when it needs them):\n${here.map(describe).join('\n')}`);
    if (retired.length) out.push(`Retired: ${retired.map((s) => `${s.persona} (${s.name})`).join(', ')}. Name one with \`who\` to bring them back with their memory.`);
    if (away.length) out.push(`Off: ${away.length} specialist(s) on call for other projects (${[...new Set(away.map((s) => s.onCall.project || 'a past job'))].join(', ')}). Name one with \`who\` only if you really need them here.`);
    return out.join('\n\n');
  }

  // Hourly (and at start-up): merge duplicates from closed jobs, retire the unused.
  function tidy() { return mergeDuplicates() + retireUnused(); }

  return { jobProject, available, onHire, onReuse, setScope, migrate, staffLines, tidy, bringBack };
}

module.exports = { install };
