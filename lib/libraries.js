'use strict';
const { findSecret, refusal } = require('./secrets');
// Team libraries: add_to_team_docs, the INDEX page list, and tidying a library after new notes.

function install(ctx) {
  const { ROOT, addEvent, agents, broadcast, enqueueResident, fs, home, libraryCheck, now, path, procs, readJson, saveState, teamOf, teamState, ticketOfAgent } = ctx;

  function libraryRoots(roster, key) {
    const def = roster.roles[key] || {};
    const projects = readJson('projects.json').filter((p) => p.department === key).map((p) => home(p.path));
    return [...new Set([home(def.cwd || '~'), ...((def.team && def.team.references) || []).map(home), ...projects])];
  }

  function refreshLibraryIndex(dir) {
    try { libraryCheck.writeIndex(dir, libraryCheck.pagesOf(dir)); } catch {}
  }

  const TIDY_PROMPT = (team, found) => `[Housekeeping from the workplace — not a ticket]
  Tidy your team library at ${team.dir}. The office's library-check script found problems that need your judgement:

  ${found}

  Fix exactly these: merge the duplicate notes into one, and for each stale reference check the code and correct it or remove the claim.
  - Read INDEX.md and every page. Merge duplicates, group notes into clear topic pages, and remove entries that are superseded.
  - Where notes contradict each other or look doubtful, check the code or config before keeping either version. Never keep a guess.
  - Keep each fact's evidence (file:line, ticket number). Keep dated entries only where the date matters.
  - Keep the hand-written part of INDEX.md a short map of what each page covers. The "All pages" list at its end is maintained by a script; do not edit it.${team.references.length ? `
  - Do not edit the reference docs (${team.references.join(', ')}). If you find something wrong there, record it on a "corrections" page with evidence.` : ''}
  Use Edit/Write only inside ${team.dir}. Finish with a two-line summary of what changed.`;

  function maybeTidy(key, force) {
    const roster = readJson('roster.json');
    const a = agents.get(key);
    if (!a || !a.resident) return false;
    const team = teamOf(roster, a);
    if (!team) return false;
    const st = teamState[key] || (teamState[key] = { sinceTidy: 0, lastTidy: null });
    const threshold = roster.defaults.tidyAfterNotes || 6;
    if (!force && (st.sinceTidy < threshold || a.current || a.inbox.length || !procs.get(key))) return false;
    if (a.inbox.some((i) => i.kind === 'chore') || (a.current && a.current.kind === 'chore')) return false;
    refreshLibraryIndex(team.dir);
    const r = libraryCheck.check(team.dir, libraryRoots(roster, key));
    st.sinceTidy = 0;
    st.lastCheck = now();
    st.lastFound = { dups: r.dups.length, refs: r.refs.length };
    saveState();
    if (!r.dups.length && !r.refs.length) return false;
    st.lastTidy = now();
    enqueueResident(key, { ticketId: null, kind: 'chore', label: 'Fixing what the library check found.', text: TIDY_PROMPT(team, libraryCheck.report(r)) });
    return true;
  }

  function teamsList() {
    const roster = readJson('roster.json');
    return roster.residents.filter((k) => roster.roles[k].team).map((k) => {
      const def = roster.roles[k];
      const dir = path.join(ROOT, def.team.docs);
      const listDir = (d, label) => {
        try {
          return fs.readdirSync(d).filter((f) => f.endsWith('.md')).sort((x, y) => (x === 'INDEX.md' ? -1 : y === 'INDEX.md' ? 1 : x.localeCompare(y)))
            .map((f) => { const st = fs.statSync(path.join(d, f)); return { name: f, path: path.join(d, f), group: label, size: st.size, mtime: st.mtimeMs }; });
        } catch { return []; }
      };
      const handoffs = def.handoffs ? listDir(path.join(ROOT, def.handoffs.dir), 'Project handoffs') : [];
      return { key: k, room: def.room, dir, sinceTidy: (teamState[k] || {}).sinceTidy || 0, lastTidy: (teamState[k] || {}).lastTidy || null, pages: [...listDir(dir, 'Team library'), ...handoffs, ...(def.team.references || []).flatMap((r) => listDir(home(r), r))] };
    });
  }

  function addToDocs(agentId, page, text) {
    const secret = findSecret(text);
    if (secret) return { error: refusal(secret) };
    const roster = readJson('roster.json');
    const a = agents.get(agentId);
    const team = a && teamOf(roster, a);
    if (!team) return { error: 'You have no team library.' };
    const name = (String(page || 'notes').toLowerCase().replace(/\.md$/, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'notes') + '.md';
    if (name === 'index.md') return { error: 'INDEX.md is curated by hand; pick another page name.' };
    const file = path.join(team.dir, name);
    const t = ticketOfAgent(a);
    const isNew = !fs.existsSync(file);
    if (isNew) fs.writeFileSync(file, `# ${name.replace(/\.md$/, '').replace(/-/g, ' ')}\n`);
    const stamp = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(file, `\n### ${stamp} — ${a.persona} (${a.name})${t ? `, ticket #${t.n}` : ''}\n\n${String(text).trim()}\n`);
    refreshLibraryIndex(team.dir);
    addEvent(a, { kind: 'doc', page: name, text: String(text).trim() });
    const st = teamState[team.key] || (teamState[team.key] = { sinceTidy: 0, lastTidy: null });
    st.sinceTidy += 1;
    saveState();
    setTimeout(() => maybeTidy(team.key), 1000);
    broadcast({ type: 'docs', team: team.key, by: a.id, page: name });
    return { message: `Recorded in ${team.room} library: ${name}.` };
  }

  return { addToDocs, libraryRoots, maybeTidy, refreshLibraryIndex, teamsList };
}

module.exports = { install };
