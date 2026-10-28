'use strict';
// Project memory: what the office knows about each project, kept per project and retrieved per job.
//   instruction  how the user wants work done here ("use pnpm", "never touch /legacy")   always in the brief
//   decision     an architectural or design choice and why                                 when relevant
//   failure      a known failure and its cause or workaround                               when relevant
//   outcome      one line per finished job, written by the office (status, checks, cost)   when relevant
// A new job's brief gets every instruction and only the few other entries most relevant to its text (word overlap,
// rarer words counting more, newer entries breaking ties), instead of the whole history. Agents add decisions and
// failures with `remember_for_project` and search with `recall_project`; the user adds instructions on the Projects page.
//
// data/project-memory/<project slug>.json = { project, entries: [{ id, t, kind, text, ticketN, by }] }

const KINDS = ['instruction', 'decision', 'failure', 'outcome'];
const MAX_ENTRIES = 300;
const MAX_OUTCOMES = 120;
const MAX_TEXT = 600;
const BRIEF_CHARS = 1800;

function install(ctx) {
  const { DATA, agents, findSecret, fs, newId, now, path, readJson, ticketOfAgent } = ctx;
  const dir = path.join(DATA, 'project-memory');
  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'project';
  const fileOf = (project) => path.join(dir, `${slug(project)}.json`);
  const STOP = new Set('the a an and or of to in on for with is are was were be it this that from by at as not no do does did can will should would could have has had my our your their its into about than then so if but just only also very more most some any all'.split(' '));
  const words = (s) => (String(s || '').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_./-]+/gu) || []).filter((w) => w.length > 2 && !STOP.has(w));

  function load(project) {
    try { return JSON.parse(fs.readFileSync(fileOf(project), 'utf8')); } catch { return { project, entries: [] }; }
  }
  function save(m) {
    fs.mkdirSync(dir, { recursive: true });
    const f = fileOf(m.project);
    fs.writeFileSync(f + '.tmp', JSON.stringify(m, null, 1));
    fs.renameSync(f + '.tmp', f);
  }
  const known = (project) => readJson('projects.json').some((p) => p.name === project);

  function add(project, kind, text, by, ticketN) {
    if (!project || !known(project)) return { error: 'No such project.' };
    if (!KINDS.includes(kind)) return { error: `Kind must be one of: ${KINDS.join(', ')}.` };
    const line = String(text || '').replace(/\s+/g, ' ').trim();
    if (line.length < 8) return { error: 'Too short to be useful.' };
    if (line.length > MAX_TEXT) return { error: `Too long (${line.length} characters); keep it under ${MAX_TEXT}.` };
    if (findSecret(line)) return { error: 'That looks like it contains a secret; leave it out.' };
    const m = load(project);
    const norm = (s) => words(s).join(' ');
    m.entries = m.entries.filter((e) => !(e.kind === kind && norm(e.text) === norm(line)));
    const e = { id: newId(), t: now(), kind, text: line, ticketN: ticketN || null, by: by || 'user' };
    m.entries.push(e);
    const outcomes = m.entries.filter((x) => x.kind === 'outcome');
    if (outcomes.length > MAX_OUTCOMES) { const drop = new Set(outcomes.slice(0, outcomes.length - MAX_OUTCOMES).map((x) => x.id)); m.entries = m.entries.filter((x) => !drop.has(x.id)); }
    if (m.entries.length > MAX_ENTRIES) m.entries = m.entries.slice(-MAX_ENTRIES);
    save(m);
    return { ok: true, entry: e };
  }

  function remove(project, id) {
    const m = load(project);
    const before = m.entries.length;
    m.entries = m.entries.filter((e) => e.id !== id);
    if (m.entries.length === before) return { error: 'No such entry.' };
    save(m);
    return { ok: true };
  }

  // Entries ranked by relevance to a text: shared words weighted by rarity across this project's entries.
  function rank(entries, text, limit) {
    const q = new Set(words(text));
    if (!q.size) return [];
    const df = new Map();
    for (const e of entries) for (const w of new Set(words(e.text))) df.set(w, (df.get(w) || 0) + 1);
    const N = entries.length || 1;
    return entries.map((e) => {
      let s = 0;
      for (const w of new Set(words(e.text))) if (q.has(w)) s += Math.log(1 + N / (df.get(w) || 1));
      if (e.kind === 'failure' || e.kind === 'decision') s *= 1.3;
      return { e, s: s + e.t / 1e15 };
    }).filter((x) => x.s >= 1).sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.e);
  }

  function relevant(project, text, limit = 6) {
    const m = load(project);
    const instructions = m.entries.filter((e) => e.kind === 'instruction').slice(-12);
    return { instructions, related: rank(m.entries.filter((e) => e.kind !== 'instruction'), text, limit) };
  }

  const label = { decision: 'decision', failure: 'known failure', outcome: 'past job' };
  function briefFor(t) {
    if (!t.project) return '';
    const { instructions, related } = relevant(t.project, `${t.title}\n${t.text}`);
    if (!instructions.length && !related.length) return '';
    let out = `\n\nWhat the office remembers about ${t.project}:`;
    for (const e of instructions) out += `\n- (the user's instruction) ${e.text}`;
    for (const e of related) out += `\n- (${label[e.kind]}${e.ticketN ? `, #${e.ticketN}` : ''}) ${e.text}`;
    if (out.length > BRIEF_CHARS) out = out.slice(0, BRIEF_CHARS) + '…';
    return out + '\nMore with `recall_project`; record new decisions and known failures with `remember_for_project`.';
  }

  // One line per finished job on a project, written by the office.
  function recordOutcome(t) {
    if (!t.project || !known(t.project) || t.outcomeSaved) return;
    const files = (t.changes || []).length;
    const v = t.verify ? `, checks ${t.verify.status}` : '';
    const rated = t.rating ? (t.rating.score > 0 ? ', rated good' : ', rated not good') : '';
    const text = `"${t.title}" ended ${t.status}${v}${files ? `, ${files} file${files === 1 ? '' : 's'} changed` : ''}${t.costUsd ? `, $${t.costUsd.toFixed(2)}` : ''}${rated}.` +
      (t.status === 'failed' && t.verify && t.verify.runs && t.verify.runs.length ? ` Failing: ${t.verify.runs[t.verify.runs.length - 1].cmd}.` : '');
    const r = add(t.project, 'outcome', text, 'office', t.n);
    if (r.ok) t.outcomeSaved = true;
  }

  function agentProject(agentId) {
    const a = agents.get(agentId);
    const t = a && ticketOfAgent(a);
    return { a, t, project: t && t.project };
  }

  async function route(req, res, url, p, body, json) {
    let m;
    if (req.method === 'POST' && p === '/api/project-memory') {
      const b = await body(req);
      const { a, t, project } = agentProject(b.agentId);
      if (!a) return json(res, 400, { error: 'Unknown agent.' }), true;
      if (!project) return json(res, 200, { error: 'Your current job has no project, so there is nowhere to remember this. Use the team library instead.' }), true;
      const r = add(project, b.kind, b.text, a.id, t.n);
      return json(res, 200, r.error ? r : { message: `Remembered for ${project} (${b.kind}).` }), true;
    }
    if (req.method === 'GET' && p === '/api/project-memory/search') {
      const { project } = agentProject(url.searchParams.get('agentId'));
      const q = url.searchParams.get('q') || '';
      if (!project) return json(res, 200, { message: 'Your current job has no project.' }), true;
      const { instructions, related } = relevant(project, q, 12);
      const lines = [...instructions.map((e) => `- (instruction) ${e.text}`), ...related.map((e) => `- (${label[e.kind]}${e.ticketN ? `, #${e.ticketN}` : ''}) ${e.text}`)];
      return json(res, 200, { message: lines.length ? lines.join('\n') : `Nothing remembered about ${project} matches that.` }), true;
    }
    if ((m = p.match(/^\/api\/projects\/([^/]+)\/memory(?:\/(\w+))?$/))) {
      const project = decodeURIComponent(m[1]);
      if (!known(project)) return json(res, 404, { error: 'No such project.' }), true;
      if (req.method === 'GET' && !m[2]) return json(res, 200, load(project).entries.slice().reverse()), true;
      if (req.method === 'POST' && !m[2]) { const b = await body(req); const r = add(project, b.kind || 'instruction', b.text, 'user'); return json(res, r.error ? 400 : 200, r), true; }
      if (req.method === 'DELETE' && m[2]) { const r = remove(project, m[2]); return json(res, r.error ? 404 : 200, r), true; }
    }
    return false;
  }

  return { add, briefFor, load, recordOutcome, relevant, remove, route, KINDS };
}

module.exports = { install };
