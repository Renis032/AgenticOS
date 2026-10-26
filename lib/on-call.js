'use strict';
// Who stays on a team. Roster roles and specialists that proved generally useful are permanent staff. A custom specialist
// hired for one project is "on call" for that project: reused whenever that project is worked on again, off the team
// list otherwise (memory and track record are kept). Used on a second project, they have proven generally useful and join
// the team. Leads choose with `stay` when hiring; the user can switch it in Processes.
//
// a.onCall = { project: 'FridgeOracle' | null, since } on staff who are on call; absent on permanent staff.

function install(ctx) {
  const { agents, tickets, touch, now } = ctx;

  // The project a job is about: the project folder it names (from its handoff), else the configured project.
  function jobProject(t) {
    if (!t) return null;
    return (t.handoffs || [])[0] || t.project || null;
  }
  const projectsOf = (a) => [...new Set((a.tickets || []).map((id) => jobProject(tickets.get(id))).filter(Boolean))];

  // Can this teammate be picked for a job without being named? Permanent staff always; on-call staff only for their project.
  function available(a, t) {
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

  // The user's switch in Processes.
  function setScope(id, team) {
    const a = agents.get(id);
    if (!a || !a.staff) return { error: 'Not a teammate.' };
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
    const team = list.filter((s) => !s.onCall);
    const here = list.filter((s) => s.onCall && p && s.onCall.project === p);
    const away = list.filter((s) => s.onCall && !(p && s.onCall.project === p));
    const out = [];
    out.push(team.length ? `Your team:\n${team.map(describe).join('\n')}` : 'Your team has no permanent staff yet.');
    if (here.length) out.push(`On call for ${p} (hired for this project; reused when it needs them):\n${here.map(describe).join('\n')}`);
    if (away.length) out.push(`Off: ${away.length} specialist(s) on call for other projects (${[...new Set(away.map((s) => s.onCall.project || 'a past job'))].join(', ')}). Name one with \`who\` only if you really need them here.`);
    return out.join('\n\n');
  }

  return { jobProject, available, onHire, onReuse, setScope, migrate, staffLines };
}

module.exports = { install };
