'use strict';
const { findSecret, refusal } = require('./secrets');
// Personal projects: handoff files (where each project stands, so the next chat continues from there), the Projects board,
// and opening files that answers mention in VS Code.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function install(ctx) {
  const { ROOT, agents, tickets, readJson, home, broadcast, addEvent, thread, ticketOfAgent } = ctx;

  function handoffsOf(roster, a) {
    const h = a && a.resident && (roster.roles[a.twinOf || a.id] || {}).handoffs;
    return h ? { dir: path.join(ROOT, h.dir), root: home(h.projectsRoot) } : null;
  }

  function projectFolders(h) {
    try { return fs.readdirSync(h.root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name); } catch { return []; }
  }

  function savedHandoffs(h) {
    try { return fs.readdirSync(h.dir).filter((f) => f.endsWith('.md')).map((f) => ({ name: f.slice(0, -3), mtime: fs.statSync(path.join(h.dir, f)).mtimeMs })); } catch { return []; }
  }

  // Folders a text names: "RecipeBox", "recipe-box" and "Recipe Box" all match.
  function projectsMentioned(h, text) {
    const words = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const t = ` ${words(String(text || ''))} `;
    const hits = projectFolders(h).filter((name) => {
      const spaced = words(name.replace(/([a-z0-9])([A-Z])/g, '$1 $2'));
      return [words(name), spaced, spaced.replace(/ /g, '')].some((v) => v && t.includes(` ${v} `));
    });
    return hits.filter((x) => !hits.some((y) => y !== x && y.toLowerCase().includes(x.toLowerCase())));
  }

  function handoffBrief(h, t, text) {
    const names = projectsMentioned(h, `${t.text}\n${text}`);
    if (!names.length) return text;
    const parts = names.map((name) => {
      const file = path.join(h.dir, `${name}.md`);
      if (!fs.existsSync(file)) return `[No handoff for ${name} yet: this is the first session on it here. Save one with save_project_handoff when you finish.]`;
      return `[Project handoff: ${name} — where you left off last time (${file})]\n${fs.readFileSync(file, 'utf8').slice(0, 12000)}`;
    });
    return `${parts.join('\n\n')}\n\n${text}`;
  }

  function handoffParts(text) {
    const section = (h) => (text.split(new RegExp(`^## ${h}$`, 'm'))[1] || '').split(/^## /m)[0].trim();
    const log = section('Session log').split(/^(?=### )/m).map((x) => x.trim()).filter(Boolean);
    return { state: section('Current state'), updated: (text.match(/^Updated (\S+)/m) || [])[1] || null, sessions: log.length, last: log[0] || null };
  }

  // One card per project folder for the Projects app: its handoff and the jobs that touched it.
  function projectsBoard() {
    const roster = readJson('roster.json');
    const out = [];
    for (const key of roster.residents) {
      const a = agents.get(key);
      const h = a && handoffsOf(roster, a);
      if (!h) continue;
      const tks = [...tickets.values()];
      for (const name of projectFolders(h)) {
        const file = path.join(h.dir, `${name}.md`);
        const ho = fs.existsSync(file) ? handoffParts(fs.readFileSync(file, 'utf8')) : null;
        let about = '';
        try { about = (fs.readFileSync(path.join(h.root, name, 'README.md'), 'utf8').slice(0, 3000).split('\n').find((l) => l.trim() && !/^[#!<\[]|^```|^[-=]+$/.test(l.trim())) || '').trim().slice(0, 200); } catch {}
        const jobs = tks.filter((t) => (t.handoffs || []).includes(name) || projectsMentioned(h, t.text).includes(name));
        const last = jobs.reduce((m, t) => (!m || (t.updatedAt || t.createdAt) > (m.updatedAt || m.createdAt) ? t : m), null);
        out.push({ name, lead: key, path: path.join(h.root, name), about, handoff: ho, file: ho ? file : null,
          jobs: jobs.length, open: jobs.filter((t) => ['open', 'paused', 'scheduled'].includes(t.status)).length,
          costUsd: jobs.reduce((s, t) => s + (t.costUsd || 0), 0),
          lastAt: Math.max(last ? last.updatedAt || last.createdAt : 0, ho ? fs.statSync(file).mtimeMs : 0) || null,
          lastJob: last ? { id: last.id, n: last.n, title: last.title, status: last.status } : null });
      }
    }
    return out.sort((x, y) => (y.lastAt || 0) - (x.lastAt || 0) || x.name.localeCompare(y.name));
  }

  // Opens a file an answer mentions (absolute, ~/…, or relative to the job's changed files and project folders) in VS Code at the line.
  function openFile(ref, ticketId) {
    const m = String(ref || '').trim().match(/^(.+?)(?::(\d+))?(?::\d+)?$/);
    if (!m) return { error: 'No file given.' };
    const rel = m[1].replace(/^\.\//, '');
    const t = ticketId && tickets.get(ticketId);
    const roster = readJson('roster.json');
    const projects = readJson('projects.json');
    const roots = [];
    if (t) {
      const p = projects.find((x) => x.name === t.project);
      if (p) roots.push(home(p.path));
      for (const key of t.assignees || []) {
        const h = agents.get(key) && handoffsOf(roster, agents.get(key));
        if (h) roots.push(...[...(t.handoffs || []), ...projectsMentioned(h, t.text)].map((n) => path.join(h.root, n)));
      }
    }
    roots.push(ROOT, os.homedir());
    const changed = t ? (t.changes || []).map((c) => c.path).filter((p) => p === rel || p.endsWith('/' + rel)) : [];
    const cands = rel.startsWith('/') ? [rel] : rel.startsWith('~') ? [home(rel)] : [...changed, ...roots.map((r) => path.join(r, rel))];
    const file = cands.map((c) => path.resolve(c)).find((c) => c.startsWith(os.homedir() + path.sep) && fs.existsSync(c) && fs.statSync(c).isFile());
    if (!file) return { error: `Could not find ${rel} in this job's files or project folders.` };
    const code = ['/usr/bin/code', '/snap/bin/code'].find((c) => fs.existsSync(c));
    const child = code ? spawn(code, ['-g', `${file}:${m[2] || 1}`], { detached: true, stdio: 'ignore' }) : spawn('xdg-open', [file], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return { message: `Opened ${file}${m[2] ? ` at line ${m[2]}` : ''}.`, path: file };
  }

  function saveHandoff(agentId, project, state, session) {
    const secret = findSecret(`${state}\n${session}`);
    if (secret) return { error: refusal(secret) };
    const roster = readJson('roster.json');
    const a = agents.get(agentId);
    const h = a && handoffsOf(roster, a);
    if (!h) return { error: 'Project handoffs are kept only for the Personal Projects team.' };
    const name = projectFolders(h).find((n) => n.toLowerCase() === String(project || '').trim().toLowerCase());
    if (!name) return { error: `No folder "${project}" in ${h.root}. Use the project's folder name.` };
    if (!String(state || '').trim() || !String(session || '').trim()) return { error: 'Both state and session are required.' };
    const file = path.join(h.dir, `${name}.md`);
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const log = (old.split(/^## Session log\n/m)[1] || '').split(/^(?=### )/m).map((s) => s.trim()).filter(Boolean);
    const t = ticketOfAgent(a);
    const stamp = new Date().toISOString().slice(0, 10);
    log.unshift(`### ${stamp}${t ? ` — ticket #${t.n}: ${t.title}` : ''}\n\n${String(session).trim()}`);
    fs.mkdirSync(h.dir, { recursive: true });
    // Commands that ran successfully in this project's jobs, so the next session knows how to install, build and test.
    const worked = new Map();
    for (const x of [...tickets.values()].sort((p, q) => p.createdAt - q.createdAt)) {
      if (!(x.handoffs || []).includes(name) && !projectsMentioned(h, x.text).includes(name)) continue;
      for (const c of x.commands || []) if (c.status === 'done') worked.set(`${c.cwd}|${c.command.replace(/\d{4,}/g, '#')}`, c);
    }
    const cmds = [...worked.values()].slice(-12).map((c) => `- \`${c.cwd.replace(os.homedir(), '~')}$ ${c.command.replace(/\s+/g, ' ').slice(0, 200)}\``);
    fs.writeFileSync(file, `# ${name} — handoff\n\nProject folder: ${path.join(h.root, name)}\nUpdated ${stamp} by ${a.persona}.\n\n` +
      `## Current state\n\n${String(state).trim()}\n\n` +
      (cmds.length ? `## Commands that worked (recorded automatically)\n\n${cmds.join('\n')}\n\n` : '') +
      `## Session log\n\n${log.slice(0, roster.defaults.handoffSessions || 12).join('\n\n')}\n`);
    addEvent(a, { kind: 'doc', page: `projects/${name}.md`, text: String(session).trim() });
    if (t) {
      t.handoffs = [...new Set([...(t.handoffs || []), name])];
      thread(t, { from: 'system', kind: 'system', text: `${a.persona} saved the ${name} handoff: the next chat about it continues from here.` });
    }
    broadcast({ type: 'docs', team: a.id, by: a.id, page: `projects/${name}.md` });
    return { message: `Saved handoff for ${name} (${file}).` };
  }

  return { handoffsOf, projectFolders, savedHandoffs, projectsMentioned, handoffBrief, handoffParts, projectsBoard, openFile, saveHandoff };
}

module.exports = { install };
