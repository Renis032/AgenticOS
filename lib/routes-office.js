'use strict';
// HTTP routes for the window itself (static files, the live stream, state), office settings, teams and roles, usage limits, health and maintenance.
// Moved out of server.js unchanged; server.js passes in what they use and asks each module in turn (see routeModules there).

function install(ctx) {
  const {
    OFFICE_SETTINGS, ROOT, addEvent, agents, askTeam, broadcast, canRunCommands, clients, commandMode, configView,
    continuePastLimit, createTeam, deleteRole, fs, healthView, libraryCheck, libraryRoots, limitsView, maybeTidy, openFile, os,
    path, probeLimits, projectsBoard, promptSizes, readJson, requestRestart, restartView, restartWhenIdle, runScript,
    runSelfTest, saveRole, scriptManifest, selftestNow, shutdown, spendStats, summary, teamChat, teamState, teamsList, tickets,
    usageIndex, writeRoster
  } = ctx;

  // Ticket numbers waiting in an agent's inbox, in order.
  const inboxTickets = (a) => [...new Set((a.inbox || []).filter((i) => i.ticketId).map((i) => (tickets.get(i.ticketId) || {}).n).filter(Boolean))];

  // Where each queued ticket stands: whose inbox, how many tickets ahead, and what that agent is busy with. Computed
  // for the window on every state request; nothing is stored.
  function queueView() {
    const out = new Map();
    for (const a of agents.values()) {
      if (!a.resident || !(a.inbox || []).length) continue;
      const busy = a.current && a.current.ticketId && tickets.get(a.current.ticketId);
      const ids = [...new Set(a.inbox.filter((i) => i.ticketId).map((i) => i.ticketId))].filter((id) => !busy || busy.id !== id);
      ids.forEach((id, k) => {
        out.set(id, { behindTicketN: busy ? busy.n : null, behindTitle: busy ? busy.title : a.current ? a.current.label || null : null,
          agentPersona: a.persona, position: k + 1 });
      });
    }
    return out;
  }

  // Returns true once a route has answered.
  async function route(req, res, url, p, body, json) {
    await handle(req, res, url, p, body, json);
    return res.headersSent;
  }
  async function handle(req, res, url, p, body, json) {
    let m;
    if (req.method === 'POST' && p === '/api/shutdown') {
      json(res, 200, { ok: true });
      setTimeout(() => shutdown(), 150);
      return;
    }
    if (req.method === 'POST' && p === '/api/tokens/save-csv') {
      const q = await body(req);
      const dir = fs.existsSync(path.join(os.homedir(), 'Downloads')) ? path.join(os.homedir(), 'Downloads') : os.homedir();
      const file = path.join(dir, `agentic-os-tokens-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.csv`);
      fs.writeFileSync(file, await usageIndex.csv(q || {}));
      return json(res, 200, { file });
    }
    if (req.method === 'GET' && p.startsWith('/api/tokens/')) {
      const q = Object.fromEntries(url.searchParams);
      if (p === '/api/tokens/overview') return json(res, 200, await usageIndex.overview(q));
      if (p === '/api/tokens/calls') return json(res, 200, await usageIndex.calls(q));
      if (p === '/api/tokens/live') return json(res, 200, await usageIndex.liveChats(Number(q.min) || 300000));
      if (p === '/api/tokens/cache') return json(res, 200, await usageIndex.cacheRead(q));
      if (p === '/api/tokens/export.csv') { res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="agentic-os-tokens.csv"' }); return res.end(await usageIndex.csv(q)); }
      if ((m = p.match(/^\/api\/tokens\/session\/([0-9a-f-]{8,})$/))) { const r = await usageIndex.session(m[1], q); return r ? json(res, 200, r) : json(res, 404, { error: 'no such session' }); }
    }
    if (req.method === 'GET' && (p === '/review' || p.startsWith('/ui/'))) {
      const f = p === '/review' ? path.join(ROOT, 'public', 'review.html') : path.resolve(ROOT, 'public', p.slice(1));
      if (!f.startsWith(path.join(ROOT, 'public') + path.sep) || !fs.existsSync(f)) return json(res, 404, { error: 'not found' });
      const font = f.endsWith('.woff2');
      res.writeHead(200, { 'content-type': f.endsWith('.css') ? 'text/css' : f.endsWith('.js') ? 'text/javascript' : font ? 'font/woff2' : f.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8', 'cache-control': font ? 'max-age=31536000' : 'no-cache' });
      return res.end(fs.readFileSync(f));
    }
    if (req.method === 'GET' && p.startsWith('/artifacts/')) {
      const f = path.resolve(ROOT, 'artifacts', decodeURIComponent(p.slice('/artifacts/'.length)) || 'index.html');
      const target = fs.existsSync(f) && fs.statSync(f).isDirectory() ? path.join(f, 'index.html') : f;
      if (!target.startsWith(path.join(ROOT, 'artifacts') + path.sep) || !fs.existsSync(target)) return json(res, 404, { error: 'not found' });
      const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.pdf': 'application/pdf' };
      res.writeHead(200, { 'content-type': types[path.extname(target)] || 'text/plain; charset=utf-8' });
      return res.end(fs.readFileSync(target));
    }
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(fs.readFileSync(path.join(ROOT, 'public', 'os.html')));
    }
    if (req.method === 'GET' && p === '/icon.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=3600' });
      return res.end(fs.readFileSync(path.join(ROOT, 'public', 'icon.svg')));
    }
    if (req.method === 'GET' && p === '/api/scripts') return json(res, 200, scriptManifest());
    if (req.method === 'GET' && p === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': hi\n\n');
      clients.add(res);
      const ka = setInterval(() => res.write(': ka\n\n'), 20000);
      req.on('close', () => { clients.delete(res); clearInterval(ka); });
      return;
    }
    if (req.method === 'GET' && p === '/api/limits') return json(res, 200, limitsView());
    if (req.method === 'POST' && p === '/api/limits/refresh') {
      await probeLimits();
      return json(res, 200, limitsView());
    }
    if (req.method === 'GET' && p === '/api/state') {
      const roster = readJson('roster.json');
      const queues = queueView();
      return json(res, 200, {
        limits: limitsView(),
        agents: [...agents.values()].map((a) => ({ ...summary(a), inboxTickets: inboxTickets(a) })),
        tickets: [...tickets.values()].map((t) => ({ ...t, queue: queues.get(t.id) || null })),
        residents: roster.residents,
        root: roster.root,
        roles: Object.fromEntries(Object.entries(roster.roles).map(([k, v]) => [k, { name: v.name, persona: v.persona, room: v.room, description: v.description, handoffs: !!v.handoffs }])),
        projects: readJson('projects.json'),
        restart: restartView(),
      });
    }
    if (req.method === 'GET' && p === '/api/prompt-size') return json(res, 200, await promptSizes());
    if (req.method === 'GET' && p === '/api/restart') return json(res, 200, restartView());
    if (req.method === 'POST' && p === '/api/restart') {
      const b = await body(req);
      return json(res, 200, requestRestart(b.when !== 'cancel', { check: b.check !== false }));
    }
    if (req.method === 'GET' && p === '/api/office-settings') {
      const d = readJson('roster.json').defaults;
      return json(res, 200, Object.fromEntries(Object.keys(OFFICE_SETTINGS).map((k) => [k, d[k] ?? null])));
    }
    if (req.method === 'POST' && p === '/api/office-settings') {
      const b = await body(req);
      const r = readJson('roster.json');
      for (const [k, fix] of Object.entries(OFFICE_SETTINGS)) if (k in b) r.defaults[k] = fix(b[k]);
      writeRoster(r);
      return json(res, 200, Object.fromEntries(Object.keys(OFFICE_SETTINGS).map((k) => [k, r.defaults[k] ?? null])));
    }
    if (req.method === 'POST' && p === '/api/limits/continue') {
      continuePastLimit();
      return json(res, 200, limitsView());
    }
    if (req.method === 'GET' && p === '/api/spend') return json(res, 200, spendStats());
    if (req.method === 'GET' && p === '/api/config') return json(res, 200, configView());
    if (req.method === 'POST' && p === '/api/config/role') {
      const r = saveRole(await body(req));
      return json(res, r.error ? 400 : 200, r);
    }
    if (req.method === 'DELETE' && (m = p.match(/^\/api\/config\/role\/([\w-]+)$/))) {
      const r = deleteRole(m[1]);
      return json(res, r.error ? 400 : 200, r);
    }
    if (req.method === 'POST' && p === '/api/config/team') {
      const r = createTeam(await body(req));
      return json(res, r.error ? 400 : 200, r);
    }
    if (req.method === 'GET' && (m = p.match(/^\/api\/teams\/([\w-]+)\/chat$/))) return json(res, 200, teamChat(m[1]));
    if (req.method === 'POST' && (m = p.match(/^\/api\/teams\/([\w-]+)\/ask$/))) {
      const b = await body(req);
      if (!b.text || !b.text.trim()) return json(res, 400, { error: 'empty' });
      const r = askTeam(m[1], b.text);
      return json(res, r.error ? 400 : 200, r);
    }
    if (req.method === 'GET' && p === '/api/health') return json(res, 200, healthView());
    if (req.method === 'POST' && p === '/api/script-nudge') {
      const b = await body(req);
      const a = agents.get(b.agentId);
      if (a) { a.scriptNudges = (a.scriptNudges || 0) + 1; addEvent(a, { kind: 'script-nudge', name: b.script }); }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/script') {
      const b = await body(req);
      return json(res, 200, await runScript(b.agentId, b.name, b.args));
    }
    if (req.method === 'POST' && p === '/api/selftest') {
      if (selftestNow() && selftestNow().status === 'running') return json(res, 409, { error: 'A self-test is already running.' });
      runSelfTest();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'PUT' && p === '/api/projects') {
      const b = await body(req);
      if (!Array.isArray(b)) return json(res, 400, { error: 'expected array' });
      fs.writeFileSync(path.join(ROOT, 'projects.json'), JSON.stringify(b, null, 2) + '\n');
      broadcast({ type: 'roster' });
      restartWhenIdle(readJson('roster.json').root);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && (m = p.match(/^\/api\/teams\/([\w-]+)\/check$/))) {
      const roster = readJson('roster.json');
      const def = roster.roles[m[1]];
      if (!def || !def.team) return json(res, 404, { error: 'no library' });
      return json(res, 200, { text: libraryCheck.report(libraryCheck.check(path.join(ROOT, def.team.docs), libraryRoots(roster, m[1]))) });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/teams\/([\w-]+)\/tidy$/))) {
      const queued = maybeTidy(m[1], true);
      const st = teamState[m[1]] || {};
      return json(res, 200, queued ? { ok: true, message: 'The library check found problems; the lead is fixing them.' }
        : st.lastFound && !st.lastFound.dups && !st.lastFound.refs ? { ok: true, message: 'The library check found nothing to fix: no duplicates, all references still match the code.' }
        : { error: 'Could not run a tidy-up right now (the lead is busy, or one is already queued).' });
    }
    if (req.method === 'GET' && p === '/api/projects-board') {
      return json(res, 200, projectsBoard());
    }
    if (req.method === 'POST' && p === '/api/open-file') {
      const b = await body(req);
      return json(res, 200, openFile(b.path, b.ticketId));
    }
    if (req.method === 'GET' && p === '/api/terminal-mode') {
      return json(res, 200, { mode: commandMode(readJson('roster.json')) });
    }
    if (req.method === 'POST' && p === '/api/terminal-mode') {
      const b = await body(req);
      if (!['off', 'ask', 'allow'].includes(b.mode)) return json(res, 400, { error: 'mode must be off, ask or allow' });
      const r = readJson('roster.json');
      r.defaults.terminalCommands = b.mode;
      writeRoster(r);
      for (const a of agents.values()) if (a.resident && canRunCommands(r, a)) a.restartWhenIdle = true;
      return json(res, 200, { mode: b.mode });
    }
    if (req.method === 'GET' && p === '/api/teams') {
      return json(res, 200, teamsList());
    }
    if (req.method === 'GET' && p === '/api/teams/page') {
      const file = path.resolve(url.searchParams.get('path') || '');
      const ok = teamsList().some((t) => t.pages.some((pg) => pg.path === file));
      if (!ok) return json(res, 404, { error: 'not a library page' });
      return json(res, 200, { path: file, text: fs.readFileSync(file, 'utf8') });
    }
  }
  return { route };
}

module.exports = { install };
