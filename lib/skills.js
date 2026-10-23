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
      return { name: fm.name || n, description: fm.description || '', for: fm.for || 'team', file, text };
    });
  }

  // The prompt section an agent gets: the skills that apply to it, and how to propose new ones.
  function promptFor(roster, a) {
    const team = teamOf(roster, a);
    if (!team) return [];
    const mine = installed(team.dir).filter((s) => s.for === 'team' || s.for === a.id);
    return ['', '## Skills',
      mine.length ? 'Approved skills for you and your team. When a task matches one, Read its SKILL.md before you start and follow it:\n' +
        mine.map((s) => `- ${s.name} (${s.for === 'team' ? 'team' : 'yours'}): ${s.description} — ${s.file}`).join('\n') : 'No team skills yet.',
      'Something that would make you or your team better or cheaper next time (a procedure you keep re-deriving, a checklist that would ' +
      'have caught a mistake): `propose_skill` with the evidence. Same name = an update. The user decides; you do not wait.'];
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

  return { route, promptFor, propose, decide, installed, pending: () => load().filter((x) => x.status === 'pending').length };
}

module.exports = { install };
