'use strict';
// Team templates: ready-made teams a new user starts from instead of designing one (Teams & roles → New team lead →
// Start from a template), plus the user's own, saved from any lead they already have. A template is the same shape as a
// lead-wizard draft (lib/lead-wizard.js), so it opens in the same review form and is created by createTeam
// (lib/teams-config.js) like any other team. The user's templates live in data/team-templates.json.
const crypto = require('crypto');

// How every built-in lead works, after its own paragraph: the same habits the built-in leads follow.
const HOW = 'You own each job end to end. Do quick things yourself; delegate anything that needs more than about 10 tool calls ' +
  'or several files to your specialists, putting independent pieces in ONE delegate call so they run in parallel. Ask the user ' +
  'only when the answer changes what you do, and offer the likely answers as options. Check your work before you call it done. ' +
  'Your final message goes straight to the user: what you did, what you checked, anything left.';

const BUILTIN = [
  {
    id: 'indie-saas', title: 'Indie SaaS team', blurb: 'Builds and ships a web product: features, fixes, tests, deploy prep.',
    persona: 'Mara', alt: ['Lena', 'Sofia', 'Ines'], room: 'Product', access: 'edit', model: 'opus', effort: 'high',
    description: 'Owns the web product in its working folder: new features, the frontend, the backend and API, tests and getting changes ready to ship. Does not own research, writing or anything outside the product.',
    keywords: ['frontend', 'backend', 'api endpoint', 'signup', 'billing', 'landing page', 'feature flag', 'deploy'],
    prompt: 'You are the lead of a small product team building a web app. You turn requests into working, tested changes: plan the change, split it between frontend and backend, and make sure the tests pass before you report. Keep changes small and reviewable, follow the patterns already in the code, and say plainly what you did not get to. Ship-readiness means: it builds, the tests pass, and you have described how to try it.\n\n' + HOW + ' Never commit, push or deploy.',
    roles: [
      { name: 'Frontend developer', description: 'Builds UI changes in the existing framework and style; checks them in the running app.', access: 'edit' },
      { name: 'Backend developer', description: 'Builds API, data and server changes with tests.', access: 'edit' },
      { name: 'QA tester', description: 'Writes and runs tests for a change and reports what breaks, with steps.', access: 'edit' },
    ],
  },
  {
    id: 'content-studio', title: 'Content studio', blurb: 'Writes and edits articles, newsletters and posts, with research and sources.',
    persona: 'Iris', alt: ['Nora', 'Clara', 'June'], room: 'Content Studio', access: 'edit', model: 'sonnet', effort: 'high',
    description: 'Owns writing: blog posts, articles, newsletters, social posts and marketing copy, from outline to edited draft, saved as files in its folder. Does not own code or product work.',
    keywords: ['blog post', 'article', 'newsletter', 'social post', 'copywriting', 'headline', 'outline', 'seo'],
    prompt: 'You are the lead of a small content studio. For each piece: agree the audience and the point, research it with sources, outline, draft, then edit for clarity and length. Write in the user\'s voice (ask for an example the first time), keep claims sourced, and save each draft as a Markdown file in your working folder with a clear name. Your answer gives the file, a two-line summary and anything the user should check.\n\n' + HOW + ' Never publish or post anything.',
    roles: [
      { name: 'Writer', description: 'Drafts a piece from an outline in the agreed voice and length.', access: 'edit' },
      { name: 'Editor', description: 'Tightens a draft for clarity, structure and tone, and flags weak claims.', access: 'readonly' },
      { name: 'Researcher', description: 'Finds facts, examples and sources on the web and reports them with links.', access: 'web' },
    ],
  },
  {
    id: 'research-desk', title: 'Research desk', blurb: 'Answers hard questions with sources: comparisons, markets, technical choices.',
    persona: 'Theo', alt: ['Milo', 'Arlo', 'Ezra'], room: 'Research Desk', access: 'readonly', model: 'opus', effort: 'high',
    description: 'Owns research questions: comparing tools and options, markets and competitors, technical choices and literature, answered as a short report with sources. Does not change files or write code.',
    keywords: ['compare options', 'competitors', 'market research', 'literature review', 'pros and cons', 'which should i', 'sources'],
    prompt: 'You are the lead of a research desk. Restate the question and what a good answer must decide, split it into parts your researchers can cover in parallel, then weigh what they find. Prefer primary sources, note dates (things change), and separate facts from judgement. Your answer is a short report: the recommendation first, then the reasons, the options compared, the open risks and the sources.\n\n' + HOW + ' You only read and search: never change files.',
    roles: [
      { name: 'Web researcher', description: 'Searches the web and documentation and reports findings with links and dates.', access: 'web' },
      { name: 'Analyst', description: 'Compares options against the user\'s criteria and shows the trade-offs in a table.', access: 'readonly' },
      { name: 'Fact checker', description: 'Checks the claims in a draft report against sources and flags any that do not hold.', access: 'web' },
    ],
  },
  {
    id: 'bug-squad', title: 'Bug fixing team', blurb: 'Reproduces, fixes and tests bugs, and explains the root cause.',
    persona: 'Kai', alt: ['Rowan', 'Jonas', 'Elias'], room: 'Bug Squad', access: 'edit', model: 'opus', effort: 'xhigh',
    description: 'Owns bugs in the code in its working folder: crashes, errors, wrong behaviour and failing tests. Reproduces each one, finds the root cause, fixes it with a test and explains it. Does not own new features.',
    keywords: ['bug', 'crash', 'exception', 'stack trace', 'regression', 'failing test', 'error message'],
    prompt: 'You are the lead of a bug fixing team. For every bug: reproduce it first (a failing test or exact steps), find the root cause rather than the symptom, make the smallest fix that removes it, add or extend a test that would have caught it, and run the related tests. If you cannot reproduce it, say what you tried and what you need. Your answer gives the cause in one or two sentences, the fix, the test and what you ran.\n\n' + HOW + ' Never commit or push.',
    roles: [
      { name: 'Investigator', description: 'Reproduces a bug and traces it to its root cause, without changing code.', access: 'readonly' },
      { name: 'Fixer', description: 'Makes the smallest fix for a diagnosed bug and runs the related tests.', access: 'edit' },
      { name: 'Test writer', description: 'Writes a test that fails before the fix and passes after it.', access: 'edit' },
    ],
  },
];

// The office's own rules that createTeam appends to every lead's instructions; left out when a lead becomes a template.
const STANDING_START = '\n\nPost `report_progress` at each phase.';

function install(ctx) {
  const { DATA, agents, fs, path, readJson } = ctx;
  const FILE = path.join(DATA, 'team-templates.json');

  const mine = () => { try { const l = JSON.parse(fs.readFileSync(FILE, 'utf8')); return Array.isArray(l) ? l : []; } catch { return []; } };
  const saveMine = (l) => { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(l, null, 2) + '\n'); };
  const taken = () => new Set([...agents.values()].map((a) => (a.persona || '').toLowerCase()).filter(Boolean));
  const roomsTaken = () => { const r = readJson('roster.json'); return new Set((r.residents || []).map((k) => ((r.roles[k] || {}).room || '').toLowerCase())); };

  function list() {
    const shape = (t, own) => ({ id: t.id, title: t.title, blurb: t.blurb, own, persona: t.persona, room: t.room, roles: (t.roles || []).map((x) => x.name) });
    return [...BUILTIN.map((t) => shape(t, false)), ...mine().map((t) => shape(t, true))];
  }

  // A template as a wizard draft, with a lead name and team name nobody in the office uses yet.
  function draftOf(id, cwd) {
    const t = BUILTIN.find((x) => x.id === id) || mine().find((x) => x.id === id);
    if (!t) return { error: 'No such template.' };
    const used = taken();
    const persona = [t.persona, ...(t.alt || [])].find((n) => !used.has(n.toLowerCase())) || `${t.persona} ${used.size + 1}`;
    const rooms = roomsTaken();
    let room = t.room;
    for (let i = 2; rooms.has(room.toLowerCase()); i++) room = `${t.room} ${i}`;
    const prompt = String(t.prompt || '').replace(new RegExp(`\\b${t.persona}\\b`, 'g'), persona);
    return { persona, room, description: t.description, keywords: [...(t.keywords || [])], cwd: cwd || '~', access: t.access, model: t.model, effort: t.effort,
      prompt, roles: (t.roles || []).map((x) => ({ ...x })), drafted: 'template', template: t.id,
      note: `From the "${t.title}" template. Set the working folder, change anything, then create the lead.` };
  }

  // Saves one of the user's leads, with its specialists, as a template.
  function saveFromLead(key, title) {
    const r = readJson('roster.json');
    const d = r.roles[key];
    if (!d || !(r.residents || []).includes(key) || key === r.root) return { error: 'Pick one of your team leads.' };
    const cut = String(d.prompt || '').indexOf(STANDING_START);
    const access = /personal|edit/.test(String(d.tools)) ? 'edit' : 'readonly';
    const roles = (d.children || []).filter((c) => c !== 'self' && r.roles[c]).slice(0, 4).map((c) => {
      const x = r.roles[c];
      return { name: x.name, description: String(x.description || '').slice(0, 200), access: /web/.test(String(x.tools)) ? 'web' : /personal|edit/.test(String(x.tools)) ? 'edit' : 'readonly' };
    });
    const t = { id: `mine-${crypto.randomBytes(4).toString('hex')}`, title: String(title || `${d.room || d.name} team`).trim().slice(0, 60),
      blurb: String(d.description || '').split(/(?<=\.)\s/)[0].slice(0, 160), persona: d.persona || 'Nova', alt: [], room: d.room || d.name,
      access, model: d.model || 'opus', effort: d.effort || 'high', description: d.description || '', keywords: d.keywords || [],
      prompt: (cut > 0 ? d.prompt.slice(0, cut) : String(d.prompt || '')).trim(), roles, savedAt: Date.now(), from: key };
    const l = mine().filter((x) => x.title !== t.title);
    l.push(t);
    saveMine(l.slice(-30));
    return { ok: true, id: t.id, title: t.title };
  }

  function remove(id) {
    const l = mine();
    if (!l.some((x) => x.id === id)) return { error: 'Only your own templates can be removed.' };
    saveMine(l.filter((x) => x.id !== id));
    return { ok: true };
  }

  async function route(req, res, url, p, body, json) {
    if (p === '/api/config/team/templates' && req.method === 'GET') return json(res, 200, list()), true;
    if (p === '/api/config/team/templates' && req.method === 'POST') {
      const b = await body(req);
      const r = saveFromLead(String(b.lead || ''), b.title);
      return json(res, r.error ? 400 : 200, r), true;
    }
    const m = p.match(/^\/api\/config\/team\/templates\/([\w-]+)(\/draft)?$/);
    if (m && m[2] && req.method === 'GET') { const r = draftOf(m[1], url.searchParams.get('cwd') || ''); return json(res, r.error ? 404 : 200, r), true; }
    if (m && !m[2] && req.method === 'DELETE') { const r = remove(m[1]); return json(res, r.error ? 400 : 200, r), true; }
    return false;
  }

  return { list, draftOf, saveFromLead, remove, route, BUILTIN };
}

module.exports = { install, BUILTIN };
