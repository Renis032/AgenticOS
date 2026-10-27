'use strict';
// The brain: everything the agents know (knowledge graph), how work moves through the office (decision flow), and what to
// improve in both (optimizer findings with one-click fixes). Built from what the office already records: agents, jobs, memory
// files, team libraries, skills, handoffs, routers, each agent's event log and the model-routing log. Nothing new is logged.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tok = (chars) => Math.round((chars || 0) / 4);
const DAY = 86400000;
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
// When a file (or a project folder) first appeared: its birth time where the file system keeps one, else its oldest known time.
const born = (f) => { try { const st = fs.statSync(f); return Math.min(...[st.birthtimeMs, st.ctimeMs, st.mtimeMs].filter((x) => x > 0)); } catch { return 0; } };
const tilde = (p) => String(p || '').replace(os.homedir(), '~');

function install(ctx) {
  const { ROOT, DATA, agents, tickets, readJson, home, now, teamOf, handoffsOf, projectFolders, claudeSkillsFor, eventsOf, giveFeedback, maybeTidy, broadcast } = ctx;
  const cache = { knowledge: null, flow: {}, usage: {}, usageRunning: {} };

  // Every event an agent logged in the window, from its event file (the in-memory list only keeps the latest).
  function eventsSince(a, since) {
    const out = [];
    const f = path.join(DATA, 'events', `${a.id}.jsonl`);
    const text = read(f);
    if (!text) return eventsOf(a).filter((e) => e.t >= since);
    for (const l of text.split('\n')) {
      if (!l || l.length < 10) continue;
      const tm = l.match(/"t":(\d{13})/);
      if (tm && Number(tm[1]) < since) continue;
      try { const e = JSON.parse(l); if (e.t >= since) out.push(e); } catch {}
    }
    return out;
  }
  const realAgents = () => [...agents.values()].filter((a) => !/^size-/.test(a.id) && a.persona);

  // ---------------------------------------------------------------- knowledge graph
  function buildKnowledge() {
    const roster = readJson('roster.json');
    // God only routes jobs and retired staff are gone; the knowledge map is about the teams, so both are left out.
    const members = () => realAgents().filter((a) => a.id !== roster.root && !a.retired);
    const nodes = new Map();
    const edges = [];
    // createdAt drives the map's time slider: a node shows from the moment it existed.
    const add = (n) => { if (!nodes.has(n.id)) nodes.set(n.id, { reads: 0, carriedBy: [], ...n, createdAt: n.createdAt || (n.file ? born(n.file) : 0) }); return nodes.get(n.id); };
    const link = (from, to, kind, extra) => { if (nodes.has(from) && nodes.has(to) && from !== to) edges.push({ from, to, kind, ...(extra || {}) }); };
    const byPersona = new Map(members().map((a) => [String(a.persona).toLowerCase(), a.id]));
    const fileNode = new Map();
    const since30 = now() - 30 * DAY;

    // Agents, and who reports to whom.
    for (const a of members()) {
      const def = roster.roles[a.resident ? a.id : a.role] || {};
      add({ id: `agent:${a.id}`, type: 'agent', createdAt: a.hiredAt || a.createdAt || 0, label: a.persona, sub: a.resident ? (def.name || a.name) : `${a.name || a.role}${a.onCall ? ` · on call for ${a.onCall.project || 'a past job'}` : ''}`, resident: !!a.resident, onCall: a.onCall ? a.onCall.project || '' : undefined,
        team: a.resident ? a.id : a.homeId, model: a.resident ? def.model || roster.defaults.residentModel : a.model, tasks: a.resident ? a.ticketsHandled || 0 : a.tasksDone || 0,
        failed: a.tasksFailed || 0, costUsd: a.costUsd || 0, updatedAt: a.updatedAt || 0 });
    }
    // On-call specialists belong to their project, not the team (linked further down, once the projects exist).
    for (const a of members()) if (!a.resident && a.homeId && !(a.onCall && a.onCall.project)) link(`agent:${a.id}`, `agent:${a.homeId}`, 'reports to');

    // Memory: carried in every call of its agent.
    for (const a of members()) {
      const f = path.join(DATA, 'memory', `${a.id}.md`);
      const text = read(f);
      if (!text.trim()) continue;
      const n = add({ id: `memory:${a.id}`, type: 'memory', label: `${a.persona}'s memory`, file: f, tokens: tok(text.length), updatedAt: mtime(f), carried: true, version: a.memoryVersion || null });
      n.carriedBy.push(a.id);
      link(`agent:${a.id}`, n.id, 'remembers');
      fileNode.set(f, n.id);
    }

    // Instructions: routers and role files, carried in every call of the agents that get them.
    const leads = roster.residents.filter((k) => k !== roster.root);
    for (const k of leads) {
      const def = roster.roles[k];
      const router = def.team && def.team.router && home(def.team.router);
      if (router && fs.existsSync(router)) {
        const text = read(router);
        const n = add({ id: `instr:${tilde(router)}`, type: 'instructions', label: path.basename(router), sub: 'area router', file: router, tokens: tok(text.length), updatedAt: mtime(router), carried: true });
        fileNode.set(router, n.id);
        for (const a of members()) if ((a.resident ? a.id : a.homeId) === k && (a.resident || def.team.routerForStaff)) { n.carriedBy.push(a.id); link(`agent:${a.id}`, n.id, 'follows'); }
      }
    }
    for (const [key, def] of Object.entries(roster.roles)) {
      if (!def.agentFile) continue;
      const f = home(def.agentFile);
      const text = read(f);
      if (!text) continue;
      const n = add({ id: `instr:${tilde(f)}`, type: 'instructions', label: path.basename(f), sub: `role instructions (${def.name || key})`, file: f, tokens: tok(text.length), updatedAt: mtime(f), carried: true });
      fileNode.set(f, n.id);
      for (const a of members()) if (!a.resident && a.role === key) { n.carriedBy.push(a.id); link(`agent:${a.id}`, n.id, 'follows'); }
    }

    // Team libraries: pages, who wrote each entry, and the job it came from.
    const jobRefs = [];
    for (const k of leads) {
      const def = roster.roles[k];
      if (!def.team || !def.team.docs) continue;
      const dir = path.join(ROOT, def.team.docs);
      let files = [];
      try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch {}
      for (const f of files) {
        const file = path.join(dir, f);
        const text = read(file);
        const entries = [...text.matchAll(/^###\s+(\d{4}-\d{2}-\d{2})\s+—\s+([^\n(,]+?)\s*(?:\(([^)]*)\))?(?:,\s*ticket #(\d+))?\s*$/gm)];
        const n = add({ id: `page:${k}/${f}`, type: 'page', label: f.replace(/\.md$/, ''), sub: `${def.room || k} library`, file, tokens: tok(text.length), updatedAt: mtime(file), entries: entries.length, team: k });
        fileNode.set(file, n.id);
        link(`agent:${k}`, n.id, 'library');
        for (const e of entries) {
          const who = byPersona.get(e[2].trim().toLowerCase());
          if (who) link(`agent:${who}`, n.id, 'wrote', { at: Date.parse(e[1]) });
          if (e[4]) jobRefs.push([n.id, Number(e[4])]);
        }
      }
      // Team skills that agents proposed and the user approved.
      const sdir = path.join(dir, 'skills');
      let skills = [];
      try { skills = fs.readdirSync(sdir).filter((s) => fs.existsSync(path.join(sdir, s, 'SKILL.md'))); } catch {}
      for (const s of skills) {
        const file = path.join(sdir, s, 'SKILL.md');
        const text = read(file);
        const fm = Object.fromEntries(((text.match(/^---\n([\s\S]*?)\n---/) || ['', ''])[1]).split('\n').map((l) => l.match(/^([\w-]+):\s*(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
        const n = add({ id: `skill:${k}/${s}`, type: 'skill', label: s, sub: `team skill · ${fm.for === 'team' ? 'whole team' : 'one agent'}`, file, tokens: tok(text.length), updatedAt: mtime(file), description: fm.description || '', team: k });
        fileNode.set(file, n.id);
        const target = fm.for && fm.for !== 'team' ? `agent:${fm.for}` : `agent:${k}`;
        link(n.id, target, 'guides');
        const by = fm['proposed-by'] && byPersona.get(fm['proposed-by'].split(' ')[0].toLowerCase());
        if (by) link(`agent:${by}`, n.id, 'proposed');
        const job = fm['proposed-by'] && (fm['proposed-by'].match(/#(\d+)/) || [])[1];
        if (job) jobRefs.push([n.id, Number(job)]);
      }
      // Claude Code skills the team may use.
      const lead = agents.get(k);
      for (const s of lead ? claudeSkillsFor(roster, lead) : []) {
        const file = path.join(os.homedir(), '.claude', 'skills', s.name, 'SKILL.md');
        const n = add({ id: `ccskill:${s.name}`, type: 'skill', label: s.name, sub: 'Claude Code skill', file, tokens: tok(read(file).length), updatedAt: mtime(file), description: s.description });
        fileNode.set(file, n.id);
        link(n.id, `agent:${k}`, 'available to');
      }
    }

    // Projects and their handoffs.
    const lead = members().find((a) => a.resident && handoffsOf(roster, a));
    const h = lead && handoffsOf(roster, lead);
    if (h) {
      for (const name of projectFolders(h)) {
        const file = path.join(h.dir, `${name}.md`);
        const text = read(file);
        const jobsFor = [...tickets.values()].filter((t) => (t.handoffs || []).includes(name));
        if (!text && !jobsFor.length) continue;
        add({ id: `project:${name}`, type: 'project', label: name, sub: tilde(path.join(h.root, name)), file: path.join(h.root, name, 'README.md'), createdAt: born(path.join(h.root, name)) });
        if (text) {
          const sessions = ((text.split(/^## Session log$/m)[1] || '').match(/^### /gm) || []).length;
          const n = add({ id: `handoff:${name}`, type: 'handoff', label: `${name} handoff`, file, tokens: tok(text.length), updatedAt: mtime(file), sessions });
          fileNode.set(file, n.id);
          link(n.id, `project:${name}`, 'describes');
          link(`agent:${lead.id}`, n.id, 'keeps');
        }
      }
    }
    for (const p of readJson('projects.json')) if (!p.keywordsFromSubfolders) add({ id: `project:${p.name}`, type: 'project', label: p.name, sub: tilde(home(p.path)), file: null });

    // Recent jobs: who worked on them, which project, what knowledge came out of them.
    const recent = [...tickets.values()].filter((t) => !t.review && !/self-test/i.test(t.title)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 40);
    for (const t of recent) {
      add({ id: `job:${t.n}`, type: 'job', createdAt: t.createdAt, label: `#${t.n}`, sub: t.title, status: t.status, costUsd: t.costUsd || 0, updatedAt: t.closedAt || t.updatedAt || t.createdAt, ticketId: t.id });
      for (const k of t.assignees || []) link(`agent:${k}`, `job:${t.n}`, 'led');
      for (const name of t.handoffs || []) link(`job:${t.n}`, `project:${name}`, 'on');
      if (t.project) link(`job:${t.n}`, `project:${t.project}`, 'on');
    }
    for (const a of members()) if (!a.resident) for (const hx of (a.history || []).slice(-15)) if (hx.n) link(`agent:${a.id}`, `job:${hx.n}`, 'worked on');
    for (const [nodeId, n] of jobRefs) link(`job:${n}`, nodeId, 'taught');

    // Reads in the last 30 days: which agent opened which piece of knowledge, and Skill tool uses.
    const readCount = new Map();
    for (const a of members()) {
      for (const e of eventsSince(a, since30)) {
        if (e.kind !== 'tool_use') continue;
        let id = null;
        if (e.name === 'Read' && e.input && e.input.file_path) id = fileNode.get(path.resolve(home(e.input.file_path)));
        else if (e.name === 'Skill' && e.input && e.input.skill) id = `ccskill:${e.input.skill}`;
        if (!id || !nodes.has(id)) continue;
        nodes.get(id).reads++;
        const key = `${a.id}|${id}`;
        readCount.set(key, (readCount.get(key) || 0) + 1);
      }
    }
    for (const [key, count] of readCount) { const [aid, id] = key.split('|'); link(`agent:${aid}`, id, 'read', { count }); }

    // Calls per agent in the last 7 days (tool calls + turns), to weigh what is carried in every call.
    const since7 = now() - 7 * DAY;
    const calls = {};
    for (const a of members()) calls[a.id] = eventsSince(a, since7).filter((e) => e.kind === 'tool_use' || e.kind === 'result').length;
    for (const n of nodes.values()) if (n.carried) n.carriedWeekTokens = n.carriedBy.reduce((s, id) => s + (calls[id] || 0) * n.tokens, 0);
    for (const a of members()) {
      if (!(a.onCall && a.onCall.project)) continue;
      if (nodes.has(`project:${a.onCall.project}`)) link(`agent:${a.id}`, `project:${a.onCall.project}`, 'on call for');
      else link(`agent:${a.id}`, `agent:${a.homeId}`, 'reports to');
    }
    const out = { at: now(), nodes: [...nodes.values()], edges, calls };
    cache.knowledge = out;
    return out;
  }
  const knowledge = (fresh) => (!fresh && cache.knowledge && now() - cache.knowledge.at < 60000 ? cache.knowledge : buildKnowledge());

  // ---------------------------------------------------------------- per-agent usage from the transcripts (in a child process)
  function usageFor(days) {
    const c = cache.usage[days];
    if ((!c || now() - c.at > 10 * 60000) && !cache.usageRunning[days]) {
      cache.usageRunning[days] = true;
      const child = spawn(process.execPath, ['-e', `require(${JSON.stringify(path.join(ROOT, 'scripts', 'usage-index.js'))}).overview({ days: ${Number(days)} }).then((o) => process.stdout.write(JSON.stringify({ agent: o.dims.agent, model: o.dims.model, role: o.dims.role, total: o.total, context: o.context.slice(0, 10), tools: o.tools.slice(0, 12) })))`], { stdio: ['ignore', 'pipe', 'ignore'] });
      let s = '';
      child.stdout.on('data', (d) => { s += d; });
      child.on('close', () => { cache.usageRunning[days] = false; try { cache.usage[days] = { at: now(), data: JSON.parse(s) }; cache.flow = {}; broadcast({ type: 'brain' }); } catch {} });
    }
    return c ? c.data : null;
  }

  // ---------------------------------------------------------------- decision flow
  const TOOL_GROUP = (e) => {
    const n = String(e.name || '').replace(/^mcp__workplace__/, '');
    if (['Read', 'Grep', 'Glob', 'LSP'].includes(n)) return 'Read & search';
    if (n === 'script') return ['show', 'outline', 'search', 'find-def', 'call-sites', 'find-files'].includes(e.input && e.input.name) ? 'Read & search' : 'Scripts';
    if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(n)) return 'Edit files';
    if (n === 'Bash') return 'Shell';
    if (n === 'run_command') return 'Terminal commands';
    if (['WebSearch', 'WebFetch'].includes(n)) return 'Web';
    if (['ask', 'send_message', 'colleagues', 'give_feedback', 'staff'].includes(n)) return 'Talk';
    if (['delegate', 'wait_for_team', 'assign'].includes(n)) return 'Delegate';
    if (['ask_user', 'propose_plan', 'request_edit_access'].includes(n)) return 'Ask you';
    if (['update_memory', 'add_to_team_docs', 'propose_skill', 'save_project_handoff'].includes(n)) return 'Learn';
    if (n === 'Skill') return 'Skills';
    return null;
  };

  function buildFlow(days) {
    const roster = readJson('roster.json');
    const since = now() - days * DAY;
    const all = [...tickets.values()].filter((t) => t.createdAt >= since);
    const nodes = new Map();
    const edges = new Map();
    const node = (id, col, label, extra) => { if (!nodes.has(id)) nodes.set(id, { id, col, label, value: 0, costUsd: 0, ...(extra || {}) }); return nodes.get(id); };
    const flow = (from, to, value, costUsd) => {
      if (!value) return;
      const k = `${from}>${to}`;
      const e = edges.get(k) || { from, to, value: 0, costUsd: 0 };
      e.value += value; e.costUsd += costUsd || 0;
      edges.set(k, e);
      nodes.get(from).value = Math.max(nodes.get(from).value, 0);
    };
    const leads = roster.residents.filter((k) => k !== roster.root);
    const persona = (k) => (agents.get(k) || {}).persona || (roster.roles[k] || {}).persona || k;

    // 1 → 2: where jobs come from, and how they reach a lead.
    for (const t of all) {
      const src = t.review ? 'Weekly reviews' : /self-test/i.test(t.title) ? 'Self-tests' : t.routine ? 'Routines' : 'Your jobs';
      const via = t.thread.some((e) => e.kind === 'assign') ? 'God decided' : t.thread.some((e) => e.kind === 'system' && /routing rules/.test(e.text || '')) ? 'Routing rules' : 'You picked the project';
      const lead = t.direct || (t.assignees || []).find((k) => k !== roster.root) || 'unassigned';
      const cost = t.costUsd || 0;
      node(`src:${src}`, 0, src).value += 1; node(`src:${src}`, 0, src).costUsd += cost;
      node(`via:${via}`, 1, via).value += 1; node(`via:${via}`, 1, via).costUsd += cost;
      node(`lead:${lead}`, 2, lead === 'unassigned' ? 'Not assigned' : persona(lead), { agent: lead }).value += 1; node(`lead:${lead}`, 2, persona(lead)).costUsd += cost;
      flow(`src:${src}`, `via:${via}`, 1, cost);
      flow(`via:${via}`, `lead:${lead}`, 1, cost);
      const out = ['done'].includes(t.status) ? 'Done' : ['failed', 'interrupted'].includes(t.status) ? 'Failed or cut off' : t.status === 'stopped' ? 'Stopped by you' : 'Still open';
      node(`out:${out}`, 6, out).value += 1; node(`out:${out}`, 6, out).costUsd += cost;
      flow(`lead:${lead}`, `out:${out}`, 1, cost);
      const signals = [t.rating && t.rating.score > 0 && '👍 Good', t.rating && t.rating.score < 0 && '👎 Not good', t.rework && 'Rework (follow-up within 2 h)', t.undone && 'Changes undone'].filter(Boolean);
      for (const s of signals) { node(`sig:${s}`, 7, s).value += 1; flow(`out:${out}`, `sig:${s}`, 1, 0); }
    }

    // 3 → 4: how teammates' models were chosen, and which roles did the work.
    const picks = read(path.join(DATA, 'arms', 'routing.jsonl')).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((p) => p && p.t >= since && p.kind !== 'teach');
    const outcomes = read(path.join(DATA, 'arms', 'outcomes.jsonl')).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((o) => o && o.t >= since);
    // The routing log records custom specialists only as "custom"; their outcome (same pickId) carries the name.
    const byPick = new Map(outcomes.map((o) => [o.pickId, o]));
    for (const p of picks) if (p.role === 'custom' && byPick.has(p.pickId)) p.role = byPick.get(p.pickId).role;
    // Role keys differ in case between the two logs for custom specialists; compare them lower-cased, label them as written.
    const rk = (r) => String(r || 'other').toLowerCase();
    const labels = {};
    for (const x of [...picks, ...outcomes]) if (x.role && !labels[rk(x.role)]) labels[rk(x.role)] = x.role;
    const roleLabel = (k) => { const r = labels[k] || k; return String(r).startsWith('custom:') ? `${r.slice(7)} (custom)` : (roster.roles[r] || {}).name || r; };
    const roleStats = {};
    for (const o of outcomes) {
      const r = rk(o.role);
      const s = roleStats[r] || (roleStats[r] = { n: 0, ok: 0, cost: 0, models: {} });
      s.n++; if (o.outcome === 'done') s.ok++; s.cost += o.costUsd || 0; s.models[o.model] = (s.models[o.model] || 0) + 1;
    }
    const pickCount = {};
    for (const p of picks) pickCount[rk(p.role)] = (pickCount[rk(p.role)] || 0) + 1;
    const topRoles = Object.entries(pickCount).sort((a, b) => b[1] - a[1]).slice(0, 9).map(([r]) => r);
    for (const p of picks) {
      const how = { ev: 'Expected-value model', jev: 'Jev (router model)', cache: 'Reused decision', pin: 'Pinned by the lead', override: 'Track record overruled' }[p.source] || `Other (${p.source})`;
      node(`pick:${how}`, 3, how).value += 1;
      const homeLead = (agents.get(p.agentId) || {}).homeId;
      const leadId = homeLead && nodes.has(`lead:${homeLead}`) ? `lead:${homeLead}` : null;
      if (leadId) flow(leadId, `pick:${how}`, 1, 0);
      const r = topRoles.includes(rk(p.role)) ? rk(p.role) : 'other';
      const rn = node(`role:${r}`, 4, r === 'other' ? 'Other roles' : roleLabel(r), { role: r });
      rn.value += 1;
      flow(`pick:${how}`, `role:${r}`, 1, 0);
    }
    for (const [r, s] of Object.entries(roleStats)) {
      const id = `role:${topRoles.includes(r) ? r : 'other'}`;
      const n = nodes.get(id) || node(id, 4, r === 'other' ? 'Other roles' : roleLabel(r), { role: r });
      n.costUsd += s.cost; n.tasks = (n.tasks || 0) + s.n; n.ok = (n.ok || 0) + s.ok;
      n.models = { ...(n.models || {}) }; for (const [m, c] of Object.entries(s.models)) n.models[m] = (n.models[m] || 0) + c;
    }

    // 5: what the work was, by tool group, for leads and teammates; 7: what the office learned.
    const learnKinds = { memory: 'Memory updated', doc: 'Library notes added' };
    for (const a of realAgents()) {
      const from = a.resident ? (nodes.has(`lead:${a.id}`) ? `lead:${a.id}` : null) : (() => { const r0 = rk(a.role === 'custom' ? `custom:${a.name}` : a.role); const r = topRoles.includes(r0) ? r0 : 'other'; return nodes.has(`role:${r}`) ? `role:${r}` : null; })();
      if (!from) continue;
      const groups = {};
      for (const e of eventsSince(a, since)) {
        if (e.kind === 'tool_use') { const g = TOOL_GROUP(e); if (g) groups[g] = (groups[g] || 0) + 1; }
        if (learnKinds[e.kind]) { const l = learnKinds[e.kind]; node(`learn:${l}`, 7, l).value += 1; flow(from, `learn:${l}`, 1, 0); }
        if (e.kind === 'tool_use' && /save_project_handoff$/.test(e.name)) { node('learn:Handoffs saved', 7, 'Handoffs saved').value += 1; flow(from, 'learn:Handoffs saved', 1, 0); }
        if (e.kind === 'tool_use' && /propose_skill$/.test(e.name)) { node('learn:Skills proposed', 7, 'Skills proposed').value += 1; flow(from, 'learn:Skills proposed', 1, 0); }
      }
      for (const [g, c] of Object.entries(groups)) { node(`work:${g}`, 5, g).value += c; flow(from, `work:${g}`, c, 0); }
    }
    const usage = usageFor(days);
    if (usage) for (const r of usage.agent) {
      const a = realAgents().find((x) => x.persona === r.key);
      if (!a) continue;
      const id = a.resident ? `lead:${a.id}` : null;
      if (id && nodes.has(id)) Object.assign(nodes.get(id), { calls: r.calls, avgContext: Math.round((r.in + r.w5 + r.w1 + r.r) / Math.max(1, r.calls)), usageUsd: r.usd });
    }
    const out = { at: now(), days, nodes: [...nodes.values()], edges: [...edges.values()], usageReady: !!usage, columns: ['Comes in', 'Routed by', 'Lead', 'Teammate model picked by', 'Teammate roles', 'Work done', 'Outcome', 'Signals & learning'] };
    cache.flow[days] = out;
    return out;
  }
  const flowFor = (days) => { const c = cache.flow[days]; return c && now() - c.at < 60000 ? c : buildFlow(days); };

  // ---------------------------------------------------------------- optimizer
  function shingles(text) {
    const w = String(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
    const s = new Set();
    for (let i = 0; i + 4 < w.length; i++) s.add(w.slice(i, i + 5).join(' '));
    return s;
  }
  function findings() {
    const K = knowledge();
    const roster = readJson('roster.json');
    const out = [];
    const nodes = new Map(K.nodes.map((n) => [n.id, n]));
    const f = (x) => out.push({ severity: 'warning', ...x });

    // Cost: knowledge carried in every call.
    for (const n of K.nodes.filter((x) => x.carried && x.carriedWeekTokens > 0).sort((a, b) => b.carriedWeekTokens - a.carriedWeekTokens).slice(0, 8)) {
      const big = n.type === 'memory' ? n.tokens > 700 : n.tokens > 1500;
      if (!big) continue;
      f({ id: `carry:${n.id}`, group: 'Cost', severity: n.carriedWeekTokens > 2e6 ? 'serious' : 'warning', node: n.id,
        title: `${n.label} is ${n.tokens.toLocaleString()} tokens, carried in every call`,
        detail: `It went into about ${(n.carriedWeekTokens / 1e6).toFixed(1)}M tokens of calls in the last 7 days (${n.carriedBy.map((id) => (agents.get(id) || {}).persona || id).join(', ')}). ${n.type === 'memory' ? 'A memory over ~500 words usually holds things that belong in the team library or are out of date.' : 'Every token here is paid on every single call of these agents.'}`,
        saving: `≈ ${(n.carriedWeekTokens * 0.4 / 1e6).toFixed(1)}M tokens/week if cut by 40%`,
        actions: n.type === 'memory' ? [{ kind: 'trim-memory', target: n.id.slice(7), label: 'Ask the agent to trim it' }, { kind: 'open', target: n.file, label: 'Open' }] : [{ kind: 'open', target: n.file, label: 'Open' }] });
    }
    // Hygiene: pages and skills nobody reads or updates.
    for (const n of K.nodes) {
      const age = n.updatedAt ? Math.floor((now() - n.updatedAt) / DAY) : 0;
      if (n.type === 'page' && !/^INDEX$/.test(n.label) && age > 21 && !n.reads)
        f({ id: `stale:${n.id}`, group: 'Knowledge', node: n.id, title: `Library page “${n.label}” looks stale`, detail: `Not updated for ${age} days and not read in the last 30. Old notes mislead as much as they help.`, actions: [{ kind: 'archive', target: n.id, label: 'Archive it' }, { kind: 'open', target: n.file, label: 'Open' }] });
      if (n.type === 'skill' && n.id.startsWith('skill:') && age > 7 && !n.reads)
        f({ id: `unused:${n.id}`, group: 'Knowledge', node: n.id, title: `Skill “${n.label}” has not been used`, detail: `Approved ${age} days ago and not read since. Either the description does not match the tasks it should trigger on, or it is not needed.`, actions: [{ kind: 'archive', target: n.id, label: 'Archive it' }, { kind: 'open', target: n.file, label: 'Open' }] });
    }
    // Handoffs behind the work done on their project.
    for (const n of K.nodes.filter((x) => x.type === 'handoff')) {
      const name = n.id.slice(8);
      const later = [...tickets.values()].filter((t) => (t.handoffs || []).includes(name) && (t.closedAt || 0) > n.updatedAt + 3600000 && t.status === 'done');
      if (later.length) f({ id: `handoff:${name}`, group: 'Knowledge', node: n.id, title: `The ${name} handoff is behind`, detail: `Job${later.length > 1 ? 's' : ''} ${later.map((t) => `#${t.n}`).join(', ')} finished after the handoff was last saved, so the next chat starts from older notes.`, actions: [{ kind: 'update-handoff', target: name, label: 'Ask the lead to update it' }] });
    }
    // Duplicates across library pages and memories.
    const texts = K.nodes.filter((n) => ['page', 'memory', 'handoff'].includes(n.type) && n.file).map((n) => ({ n, paras: read(n.file).split(/\n\s*\n/).filter((p) => p.length > 160).map((p) => ({ p, s: shingles(p) })) }));
    const seen = new Set();
    for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
      for (const a of texts[i].paras) for (const b of texts[j].paras) {
        let inter = 0; for (const x of a.s) if (b.s.has(x)) inter++;
        const jac = inter / Math.max(1, a.s.size + b.s.size - inter);
        const key = `${texts[i].n.id}|${texts[j].n.id}`;
        if (jac >= 0.5 && !seen.has(key)) {
          seen.add(key);
          const team = texts[i].n.team || texts[j].n.team;
          f({ id: `dup:${key}`, group: 'Knowledge', node: texts[i].n.id, title: `“${texts[i].n.label}” and “${texts[j].n.label}” repeat each other`, detail: `A paragraph is ${Math.round(jac * 100)}% the same: “${a.p.replace(/\s+/g, ' ').slice(0, 140)}…”. Keep it in one place.`,
            actions: [...(team ? [{ kind: 'tidy', target: team, label: 'Tidy the library' }] : []), { kind: 'open', target: texts[i].n.file, label: 'Open first' }, { kind: 'open', target: texts[j].n.file, label: 'Open second' }] });
        }
      }
    }
    // Flow: how jobs are routed and worked.
    const F = flowFor(30);
    const viaGod = (F.nodes.find((n) => n.id === 'via:God decided') || {}).value || 0;
    const jobs = F.nodes.filter((n) => n.col === 0).reduce((s, n) => s + n.value, 0);
    if (jobs >= 5 && viaGod / jobs > 0.2) f({ id: 'flow:god', group: 'Flow', title: `${Math.round((viaGod / jobs) * 100)}% of jobs needed God to route them`, detail: 'Each of those is an extra model call before work starts. Add keywords to your projects (Teams & roles → projects) so the routing rules place them directly.', actions: [{ kind: 'app', target: 'settings', label: 'Open Teams & roles' }] });
    for (const n of F.nodes.filter((x) => x.col === 2 && x.avgContext > 100000)) f({ id: `flow:ctx:${n.id}`, group: 'Cost', severity: n.avgContext > 150000 ? 'serious' : 'warning', title: `${n.label} averaged ${Math.round(n.avgContext / 1000)}k tokens of context per call`, detail: `Over ${n.calls} calls in 30 days. The lead's conversation is re-read on every call; delegating long reading and editing keeps it small (Preferences → Agents & teams: delegate reminders and compaction).`, actions: [{ kind: 'prefs', target: 'agents', label: 'Open the settings' }] });
    for (const n of F.nodes.filter((x) => x.col === 4 && x.tasks >= 3 && x.ok / x.tasks < 0.7)) f({ id: `flow:role:${n.id}`, group: 'Flow', severity: 'serious', title: `${n.label}: ${Math.round((n.ok / n.tasks) * 100)}% of tasks finished`, detail: `${n.ok} of ${n.tasks} in 30 days. Check its instructions, or whether it is being given work it is not suited to.`, actions: [{ kind: 'app', target: 'settings', label: 'Open Teams & roles' }] });
    const opusStaff = F.nodes.filter((x) => x.col === 4 && x.models).reduce((s, x) => s + (Object.entries(x.models).filter(([m]) => /opus/.test(m)).reduce((a, [, c]) => a + c, 0)), 0);
    const staffTasks = F.nodes.filter((x) => x.col === 4).reduce((s, x) => s + (x.tasks || 0), 0);
    if (staffTasks >= 6 && opusStaff / staffTasks > 0.5) f({ id: 'flow:opus', group: 'Cost', title: `${Math.round((opusStaff / staffTasks) * 100)}% of teammate tasks ran on Opus`, detail: 'The expected-value model picks Opus when it thinks cheaper models fail too often. Rate answers and keep jobs focused so the track record can justify Sonnet.', actions: [{ kind: 'app', target: 'usage', label: 'Open Usage' }] });
    const rework = (F.nodes.find((n) => n.id === 'sig:Rework (follow-up within 2 h)') || {}).value || 0;
    const undone = (F.nodes.find((n) => n.id === 'sig:Changes undone') || {}).value || 0;
    if (rework + undone >= 2) f({ id: 'flow:rework', group: 'Flow', title: `${rework} answers needed rework and ${undone} jobs had changes undone`, detail: 'These count against the models chosen for those jobs. Look at the jobs to see what was missed.', actions: [{ kind: 'app', target: 'jobs', label: 'Open Jobs' }] });
    const order = { serious: 0, warning: 1, info: 2 };
    return out.sort((a, b) => order[a.severity] - order[b.severity]);
  }

  // ---------------------------------------------------------------- details and actions
  function nodeDetail(id) {
    const K = knowledge();
    const n = K.nodes.find((x) => x.id === id);
    if (!n) return { error: 'No such node.' };
    const text = n.file && fs.existsSync(n.file) && fs.statSync(n.file).isFile() ? read(n.file) : '';
    const t = n.ticketId && tickets.get(n.ticketId);
    return { ...n, file: n.file || null, fileTilde: tilde(n.file), content: text.slice(0, 12000), contentTruncated: text.length > 12000,
      answer: t ? String(t.answer || '').slice(0, 3000) : null,
      links: K.edges.filter((e) => e.from === id || e.to === id).map((e) => ({ ...e, other: e.from === id ? e.to : e.from, dir: e.from === id ? 'out' : 'in' })) };
  }

  function action(b) {
    const K = knowledge();
    const roster = readJson('roster.json');
    if (b.kind === 'archive') {
      const n = K.nodes.find((x) => x.id === b.target);
      if (!n || !n.file) return { error: 'Nothing to archive.' };
      const src = n.type === 'skill' ? path.dirname(n.file) : n.file;
      if (!src.startsWith(path.join(ROOT, 'teams') + path.sep)) return { error: 'Only library pages and team skills can be archived here.' };
      const team = src.slice(path.join(ROOT, 'teams').length + 1).split(path.sep)[0];
      const dest = path.join(ROOT, 'teams', team, 'archive', `${new Date().toISOString().slice(0, 10)}-${path.basename(src)}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(src, dest);
      cache.knowledge = null;
      return { message: `Moved to ${tilde(dest)}. It no longer shows in the library or the agents' instructions; move it back to restore it.` };
    }
    if (b.kind === 'trim-memory') {
      const a = agents.get(b.target);
      if (!a) return { error: 'No such agent.' };
      giveFeedback('user', a.persona, 'Your memory file has grown large, and it is re-sent with every call you make. At the start of your next task, rewrite it with update_memory to under 400 words: keep only what changes how you work; move facts about code or projects to the team library; drop anything out of date.');
      return { message: `${a.persona} will trim their memory at the start of their next task.` };
    }
    if (b.kind === 'update-handoff') {
      const lead = realAgents().find((a) => a.resident && handoffsOf(roster, a));
      if (!lead) return { error: 'No lead keeps handoffs.' };
      giveFeedback('user', lead.persona, `The ${b.target} handoff is older than the last job on that project. Next time you are idle or start a job, run handoff-facts ${b.target} and save an updated handoff with save_project_handoff.`);
      return { message: `${lead.persona} will update the ${b.target} handoff.` };
    }
    if (b.kind === 'tidy') {
      const queued = maybeTidy(b.target, true);
      return { message: queued ? 'The lead is tidying the library (merging duplicates, fixing stale references).' : 'The library check found nothing that needs the lead.' };
    }
    return { error: 'Unknown action.' };
  }

  async function route(req, res, url, p, body, json) {
    if (req.method === 'GET' && p === '/api/brain/knowledge') { json(res, 200, knowledge(url.searchParams.get('fresh') === '1')); return true; }
    if (req.method === 'GET' && p === '/api/brain/flow') { json(res, 200, flowFor(Math.max(1, Math.min(365, Number(url.searchParams.get('days')) || 30)))); return true; }
    if (req.method === 'GET' && p === '/api/brain/findings') { json(res, 200, findings()); return true; }
    if (req.method === 'GET' && p === '/api/brain/node') { json(res, 200, nodeDetail(url.searchParams.get('id'))); return true; }
    if (req.method === 'POST' && p === '/api/brain/action') { const b = await body(req); json(res, 200, action(b)); return true; }
    return false;
  }

  return { route, knowledge, flowFor, findings };
}

module.exports = { install };
