'use strict';
// Teams and roles from the Settings app: reading and changing roles, models, instructions, projects and new teams.

function install(ctx) {
  const { EFFORTS, MODELS, ROOT, agents, broadcast, fs, home, inWorkRepo, path, readJson, restartWhenIdle, startResident } = ctx;

  function writeRoster(r) {
    fs.writeFileSync(path.join(ROOT, 'roster.json'), JSON.stringify(r, null, 2) + '\n');
  }

  function configView() {
    const r = readJson('roster.json');
    return { root: r.root, residents: r.residents, defaults: r.defaults, presets: Object.keys(r.toolPresets),
      roles: Object.entries(r.roles).map(([key, d]) => ({ key, name: d.name, persona: d.persona || null, room: d.room || null, description: d.description,
        prompt: d.prompt || '', model: d.model || null, effort: d.effort || null, tools: d.tools, children: d.children || [], createdInUi: !!d.createdInUi,
        resident: r.residents.includes(key), agentFile: d.agentFile || null })),
      projects: readJson('projects.json') };
  }

  const slug = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);

  function saveRole(b) {
    const r = readJson('roster.json');
    const lead = r.roles[b.team];
    if (!lead || !r.residents.includes(b.team) || b.team === r.root) return { error: 'Pick the team (lead) this role belongs to.' };
    let key = b.key && r.roles[b.key] ? b.key : null;
    if (!key) {
      if (!b.name) return { error: 'A role needs a name.' };
      key = `${b.team.replace(/-lead$/, '')}-${slug(b.name)}`;
      if (r.roles[key]) return { error: `A role "${key}" already exists.` };
      const access = ['edit', 'web', 'readonly'].includes(b.access) ? b.access : 'readonly';
      r.roles[key] = { name: b.name, description: b.description || '', cwd: lead.cwd || '~',
        tools: access === 'edit' ? (inWorkRepo(home(lead.cwd || '~')) ? 'edit' : 'personal') : access === 'web' ? 'web' : 'readonly',
        permissionMode: access === 'edit' ? 'acceptEdits' : 'default', children: [], prompt: b.prompt || '', createdInUi: true };
      lead.children = [...new Set([...(lead.children || []), key])];
    }
    const d = r.roles[key];
    for (const k of ['name', 'description', 'prompt']) if (typeof b[k] === 'string' && (b[k] || k !== 'name')) d[k] = b[k];
    if (MODELS.includes(b.model)) d.model = b.model;
    if (EFFORTS.includes(b.effort)) d.effort = b.effort;
    writeRoster(r);
    restartWhenIdle(b.team);
    return { ok: true, key };
  }

  function deleteRole(key) {
    const r = readJson('roster.json');
    const d = r.roles[key];
    if (!d || !d.createdInUi) return { error: 'Only roles created here can be removed.' };
    delete r.roles[key];
    for (const x of Object.values(r.roles)) if (x.children) x.children = x.children.filter((c) => c !== key);
    writeRoster(r);
    for (const k of r.residents) if (k !== r.root) restartWhenIdle(k);
    return { ok: true };
  }

  function createTeam(b) {
    const r = readJson('roster.json');
    const persona = String(b.persona || '').trim();
    const room = String(b.room || '').trim();
    if (!persona || !room) return { error: 'A team needs a lead name and a room name.' };
    if ([...agents.values()].some((x) => (x.persona || '').toLowerCase() === persona.toLowerCase())) return { error: `Someone called ${persona} already works here.` };
    const key = `${slug(room)}-lead`;
    if (r.roles[key]) return { error: 'That team already exists.' };
    const cwd = b.cwd && fs.existsSync(home(b.cwd)) ? b.cwd : '~';
    const edit = b.access === 'edit';
    const docs = `teams/${slug(room)}`;
    r.roles[key] = { name: `${room} Lead`, persona, room, description: b.description || `Owns ${room}.`, cwd,
      tools: edit ? 'personal' : 'readonly', permissionMode: edit ? 'acceptEdits' : 'default', children: ['researcher'],
      prompt: `You are ${persona}, the permanent lead for ${room}. ${b.description || ''} You own each ticket end to end: do small things yourself, ` +
        'and build a team with `delegate` (roster roles or a `custom` specialist) when work is broad or parallel. Post `report_progress` at each phase. ' +
        'Your final message goes directly to the user as the answer, so write it for them. Never commit or push. ' +
        'Your sub-agents are permanent staff who stay on your team and learn: check `staff` before delegating, name the teammate with `who`, and use `give_feedback` after notable work.',
      team: { docs }, createdInUi: true };
    r.residents.push(key);
    const mgr = r.roles[r.root];
    mgr.assignTo = [...new Set([...(mgr.assignTo || []), key])];
    writeRoster(r);
    fs.mkdirSync(path.join(ROOT, docs), { recursive: true });
    const idx = path.join(ROOT, docs, 'INDEX.md');
    if (!fs.existsSync(idx)) fs.writeFileSync(idx, `# ${room} library\n\n${b.description || ''}\n\nWorking folder: ${cwd}\n`);
    try { fs.appendFileSync(path.join(ROOT, 'teams/front-desk/INDEX.md'), `\n- ${room}: ${b.description || ''} → ${persona} (${key}).\n`); } catch {}
    startResident(key);
    restartWhenIdle(r.root);
    broadcast({ type: 'roster' });
    return { ok: true, key };
  }

  return { configView, createTeam, deleteRole, saveRole, writeRoster };
}

module.exports = { install };
