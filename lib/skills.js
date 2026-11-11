'use strict';
const { findSecret, refusal } = require('./secrets');
// Skills that agents propose for themselves or their team. The user approves or rejects each one; approved skills live in
// teams/<team>/skills/<name>/SKILL.md and are listed in the instructions of the agents they are for.
const fs = require('fs');
const path = require('path');

function install(ctx) {
  const { ROOT, DATA, agents, readJson, teamOf, broadcast, addEvent, giveFeedback, ticketOfAgent, now, newId } = ctx;
  const FILE = path.join(DATA, 'skill-proposals.json');
  const load = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; } };
  const save = (list) => fs.writeFileSync(FILE, JSON.stringify(list, null, 1));
  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

  // Skills installed for a team, read from SKILL.md frontmatter (name, description, for: team | <agent id>).
  function installed(teamDir) {
    const dir = path.join(teamDir, 'skills');
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => fs.existsSync(path.join(dir, n, 'SKILL.md'))); } catch { return []; }
    return names.map((n) => {
      const file = path.join(dir, n, 'SKILL.md');
      const text = fs.readFileSync(file, 'utf8');
      const fm = Object.fromEntries((text.match(/^---\n([\s\S]*?)\n---/) || ['', ''])[1].split('\n').map((l) => l.match(/^([\w-]+):\s*(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
      const list = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
      return { name: fm.name || n, slug: n, description: fm.description || '', for: fm.for || 'team', file, text,
        preload: list(fm.preload), source: fm.source || '' };
    });
  }

  const forAgent = (s, a) => s.for === 'team' || s.for === a.id || (!!a.role && s.for === a.role);
  const bodyOf = (text) => String(text || '').replace(/^---\n[\s\S]*?\n---\n*/, '').trim();
  const home = (p) => String(p || '').replace(/^~(?=\/|$)/, require('os').homedir());

  // Skills a lead hands a teammate with `delegate`: sorted, deduplicated folder names, or an error naming what exists.
  // Only the lead's own team skills, meant for the whole team or for the teammate's role.
  function resolve(roster, parent, role, names) {
    if (names == null || (Array.isArray(names) && !names.length)) return { skills: [] };
    if (!Array.isArray(names)) return { error: '`skills` must be a list of team skill names.' };
    const team = teamOf(roster, parent);
    if (!team) return { error: 'You have no team skills to hand out.' };
    const usable = installed(team.dir).filter((s) => s.for === 'team' || s.for === role);
    const out = [];
    for (const n of names) {
      const s = usable.find((x) => x.slug === slug(n) || slug(x.name) === slug(n));
      if (!s) return { error: `No team skill "${n}" for ${role}. Team skills: ${usable.map((x) => x.slug).join(', ') || 'none yet (propose one with propose_skill)'}.` };
      if (!out.includes(s.slug)) out.push(s.slug);
    }
    if (out.length > 3) return { error: 'At most 3 skills per teammate; split the work instead.' };
    return { skills: out.sort() };
  }

  // The skills a teammate was hired with, loaded into its system prompt in full: the skill text, the agent file it builds
  // on (`source:`) and its reference docs (`preload:`), so nothing depends on the agent choosing to read them.
  const PART_MAX = 20000;
  function loadedBlock(roster, a) {
    const team = teamOf(roster, a);
    if (!team || !(a.skills || []).length) return [];
    const all = installed(team.dir);
    const parts = [];
    for (const name of a.skills) {
      const s = all.find((x) => x.slug === name);
      if (!s) { parts.push('', `## Skill: ${name}`, '(This skill was removed from the team; work from your role instructions.)'); continue; }
      parts.push('', `## Skill: ${s.name} (loaded for you; follow it)`, s.description ? `When: ${s.description}` : '', '', bodyOf(s.text).slice(0, PART_MAX));
      if (s.source) {
        try { parts.push('', `### From ${s.source}`, '', bodyOf(fs.readFileSync(home(s.source), 'utf8')).slice(0, PART_MAX)); } catch { parts.push('', `(${s.source} is missing.)`); }
      }
      for (const doc of s.preload) {
        try { parts.push('', `### Reference: ${doc} (already loaded for you; do not Read it again)`, '', fs.readFileSync(home(doc), 'utf8').slice(0, PART_MAX)); } catch { /* a missing doc is skipped, as role preloads are */ }
      }
    }
    return parts.filter((x, i) => x !== '' || parts[i - 1] !== '');
  }

  // The prompt section an agent gets: the skills that apply to it, and how to propose new ones.
  function promptFor(roster, a) {
    const team = teamOf(roster, a);
    if (!team) return [];
    const loaded = a.skills || [];
    const mine = installed(team.dir).filter((s) => forAgent(s, a) && !loaded.includes(s.slug));
    const kind = (s) => (s.for === 'team' ? 'team' : s.for === a.id ? 'yours' : 'your role');
    return ['', '## Skills',
      loaded.length ? `Loaded above because you were hired with them: ${loaded.join(', ')}.` : '',
      mine.length ? 'Approved skills for you and your team. When a task matches one, Read its SKILL.md before you start and follow it:\n' +
        mine.map((s) => `- ${s.name} (${kind(s)}): ${s.description} — ${s.file}`).join('\n') : (loaded.length ? '' : 'No team skills yet.'),
      a.resident && !(roster.roles[a.twinOf || a.id] || {}).assignTo ? 'When you delegate, give a teammate the team skills its task needs with `skills` (names as above): they are loaded into its instructions, so the teammate keeps that expertise and its own track record for it.' : '',
      'Something that would make you or your team better or cheaper next time (a procedure you keep re-deriving, a checklist that would ' +
      'have caught a mistake): `propose_skill` with the evidence. Same name = an update. The user decides; you do not wait.'].filter((x, i) => x !== '' || i === 0);
  }

  function propose(agentId, b) {
    const secret = findSecret(`${b.content}\n${b.why}\n${b.description}`);
    if (secret) return { error: refusal(secret) };
    const roster = readJson('roster.json');
    const a = agents.get(agentId);
    const team = a && teamOf(roster, a);
    if (!team) return { error: 'You have no team to propose skills for.' };
    const name = slug(b.name);
    if (!name || !String(b.content || '').trim() || !String(b.description || '').trim()) return { error: 'name, description and content are required.' };
    const list = load();
    if (list.some((p) => p.status === 'pending' && p.team === team.key && p.name === name)) return { error: `A proposal for "${name}" is already waiting for the user.` };
    const current = installed(team.dir).find((s) => slug(s.name) === name);
    const t = ticketOfAgent(a);
    const p = { id: newId(), name, description: String(b.description).trim().slice(0, 400), why: String(b.why || '').trim().slice(0, 2000),
      scope: b.scope === 'me' ? 'me' : 'team', content: String(b.content).trim().slice(0, 20000), by: a.id, persona: a.persona, team: team.key, room: team.room,
      ticketN: t ? t.n : null, update: current ? current.text : null, status: 'pending', at: now() };
    list.unshift(p);
    save(list.slice(0, 200));
    addEvent(a, { kind: 'progress', text: `Proposed the skill “${name}” for ${p.scope === 'me' ? 'myself' : 'the team'}.` });
    broadcast({ type: 'notify', kind: 'question', title: `${a.persona} proposes a skill: ${name}`, text: p.description });
    broadcast({ type: 'skills' });
    return { message: `Proposed "${name}"${current ? ' (an update of the existing skill)' : ''}. The user approves or rejects it in the Skills app; carry on with your work.` };
  }

  function decide(id, decision, note) {
    const roster = readJson('roster.json');
    const list = load();
    const p = list.find((x) => x.id === id);
    if (!p || p.status !== 'pending') return { error: 'That proposal is not waiting.' };
    p.status = decision === 'approve' ? 'approved' : 'rejected';
    p.note = String(note || '').slice(0, 1000);
    p.decidedAt = now();
    if (p.status === 'approved') {
      const def = roster.roles[p.team];
      const dir = path.join(ROOT, def.team.docs, 'skills', p.name);
      fs.mkdirSync(dir, { recursive: true });
      const body = p.content.replace(/^---\n[\s\S]*?\n---\n*/, '');
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${p.name}\ndescription: ${p.description.replace(/\n/g, ' ')}\nfor: ${p.scope === 'me' ? p.by : 'team'}\nproposed-by: ${p.persona}${p.ticketN ? ` (job #${p.ticketN})` : ''}\napproved: ${new Date().toISOString().slice(0, 10)}\n---\n\n${body}\n`);
      p.file = path.join(dir, 'SKILL.md');
    }
    save(list);
    const a = agents.get(p.by);
    if (a) giveFeedback('user', a.persona, p.status === 'approved'
      ? `Your skill proposal "${p.name}" was approved and is now in ${p.file}; it is listed in your instructions from your next task.${p.note ? ` The user added: ${p.note}` : ''}`
      : `Your skill proposal "${p.name}" was rejected.${p.note ? ` The user's reason: ${p.note}` : ''} Take that into account before proposing similar skills.`);
    broadcast({ type: 'skills' });
    return { ok: true, proposal: p };
  }

  async function route(req, res, url, p, body, json) {
    if (req.method === 'GET' && p === '/api/skill-proposals') { json(res, 200, load()); return true; }
    if (req.method === 'POST' && p === '/api/skill-proposals/propose') { const b = await body(req); json(res, 200, propose(b.agentId, b)); return true; }
    const m = p.match(/^\/api\/skill-proposals\/(\w+)\/decide$/);
    if (req.method === 'POST' && m) { const b = await body(req); json(res, 200, decide(m[1], b.decision, b.note)); return true; }
    return false;
  }

  return { route, promptFor, loadedBlock, resolve, propose, decide, installed, pending: () => load().filter((x) => x.status === 'pending').length };
}

module.exports = { install };
