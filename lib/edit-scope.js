'use strict';
// Where an agent may edit files on a job: the job's project folder(s), its team library, scratch folders (/tmp, ~/*_test) and
// folders the user granted. Edits outside are blocked by the hook with a pointer to request_edit_access, which asks the user.
// defaults.editScope: "project" (default) or "home" (no limit). A job with no known project is not limited.
const os = require('os');
const path = require('path');

function install(ctx) {
  const { agents, readJson, home, now, newId, broadcast, addEvent, touch, touchTicket, thread, ticketOfAgent, teamOf, handoffsOf, projectsMentioned } = ctx;
  const waiters = new Map();
  const inside = (file, root) => file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  const tilde = (p) => p.replace(os.homedir(), '~');

  function rootsFor(a) {
    const roster = readJson('roster.json');
    if ((roster.defaults.editScope || 'project') === 'home') return null;
    const t = ticketOfAgent(a);
    if (!t) return null;
    const projectRoots = [];
    const project = readJson('projects.json').find((p) => p.name === t.project);
    if (project && !project.keywordsFromSubfolders) projectRoots.push(home(project.path));
    const lead = a.resident ? a : agents.get(a.homeId);
    const h = lead && handoffsOf(roster, lead);
    if (h) for (const n of new Set([...(t.handoffs || []), ...projectsMentioned(h, `${t.title}\n${t.text}`)])) projectRoots.push(path.join(h.root, n));
    if (!projectRoots.length) return null;
    const team = teamOf(roster, a);
    return { project: projectRoots, other: [...(team ? [team.dir] : []), os.tmpdir(), '/tmp', ...(t.editGrants || [])] };
  }

  // Why an edit is not allowed, or null when it is.
  function denyEdit(agentId, file) {
    const a = agents.get(agentId);
    if (!a || !file) return null;
    const roots = rootsFor(a);
    if (!roots) return null;
    const abs = path.resolve(home(String(file)));
    const scratch = abs.startsWith(os.homedir() + path.sep) && /_test$/.test(abs.slice(os.homedir().length + 1).split(path.sep)[0]);
    if (scratch || [...roots.project, ...roots.other].some((r) => inside(abs, path.resolve(r)))) return null;
    return `Office rule: this job's edit area is ${roots.project.map(tilde).join(', ')} (plus scratch folders such as ~/<name>_test and /tmp). ` +
      `${tilde(abs)} is outside it. If the job really needs changes there, call request_edit_access with the folder and why; the user decides. ` +
      'Otherwise keep your changes inside the project or a scratch folder.';
  }

  function requestAccess(agentId, folder, reason) {
    const a = agents.get(agentId);
    const t = a && ticketOfAgent(a);
    if (!t) return Promise.resolve({ error: 'You have no current ticket.' });
    const dir = path.resolve(home(String(folder || '').trim() || '~'));
    if (!(dir === os.homedir() || dir.startsWith(os.homedir() + path.sep))) return Promise.resolve({ error: 'Only folders inside the home folder can be granted.' });
    if ((t.editGrants || []).some((g) => inside(dir, g))) return Promise.resolve({ message: `You may already edit ${tilde(dir)} on this job.` });
    const r = { id: newId(), agentId: a.id, persona: a.persona, folder: dir, reason: String(reason || '').slice(0, 500), status: 'pending', at: now() };
    t.access = t.access || [];
    t.access.push(r);
    thread(t, { from: a.id, kind: 'access', aid: r.id, text: dir });
    a.progress = `Waiting for you to allow edits in ${tilde(dir)} on #${t.n}.`;
    addEvent(a, { kind: 'progress', text: a.progress });
    touch(a);
    broadcast({ type: 'notify', kind: 'question', ticketId: t.id, title: `${a.persona} asks to edit files in ${tilde(dir)} (#${t.n})`, text: r.reason });
    return new Promise((resolve) => waiters.set(r.id, (allow) => {
      r.status = allow ? 'allowed' : 'denied';
      if (allow) t.editGrants = [...(t.editGrants || []), dir];
      touchTicket(t);
      resolve(allow ? { message: `Allowed: you may edit files in ${tilde(dir)} on this job.` } : { error: `The user did not allow edits in ${tilde(dir)}. Keep your changes inside the job's project, or explain what you need.` });
    }));
  }

  function decideAccess(tickets, id, allow) {
    for (const t of tickets.values()) {
      const r = (t.access || []).find((x) => x.id === id);
      if (!r) continue;
      if (r.status !== 'pending') return { error: 'Already decided.' };
      const w = waiters.get(id);
      waiters.delete(id);
      if (w) w(!!allow); else { r.status = allow ? 'allowed' : 'denied'; if (allow) t.editGrants = [...(t.editGrants || []), r.folder]; touchTicket(t); }
      return { ok: true };
    }
    return { error: 'No such request.' };
  }

  // A paused or stopped job drops its open requests.
  function endAccess(t) { for (const r of t.access || []) if (r.status === 'pending') { const w = waiters.get(r.id); waiters.delete(r.id); if (w) w(false); else r.status = 'denied'; } }

  return { denyEdit, requestAccess, decideAccess, endAccess };
}

module.exports = { install };
