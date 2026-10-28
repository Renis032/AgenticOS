'use strict';
// The Health app's report: server and login, residents, recent errors and failed tasks, limits, self-test and script use. Moved out of server.js unchanged.

function install(ctx) {
  const { agents, CLAUDE_BIN, DATA, eventsOf, fs, HOST, limits, needsRefresh, now, os, path, procs, readJson, selftestNow, SERVER_STARTED,
    spawnSync } = ctx;

  let claudeVersion = null;
  function healthView() {
    const roster = readJson('roster.json');
    if (!claudeVersion) { try { claudeVersion = (spawnSync(CLAUDE_BIN, ['--version'], { encoding: 'utf8', timeout: 8000 }).stdout || '').trim(); } catch { claudeVersion = '?'; } }
    let login = null;
    try {
      const o = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8')).claudeAiOauth || {};
      login = { plan: o.subscriptionType || null, accessExpiresAt: o.expiresAt || null, refreshExpiresAt: o.refreshTokenExpiresAt || null };
    } catch {}
    const since = now() - 48 * 3600000;
    const errors = [];
    for (const a of agents.values()) {
      for (const e of eventsOf(a)) {
        if (e.t < since) continue;
        if (e.kind === 'log' && /error|fail|denied|ENOENT|EACCES|panic/i.test(e.text || '')) errors.push({ t: e.t, who: a.persona, id: a.id, text: String(e.text).slice(0, 400) });
        else if (e.kind === 'result' && e.isError) errors.push({ t: e.t, who: a.persona, id: a.id, text: String(e.text || 'failed').slice(0, 400) });
      }
    }
    const failed = [];
    for (const a of agents.values()) for (const h of a.history || []) if (h.t >= now() - 7 * 86400000 && !['done', 'paused'].includes(h.outcome)) failed.push({ t: h.t, who: a.persona, id: a.id, n: h.n, title: h.title, outcome: h.outcome });
    let logTail = '';
    try { logTail = fs.readFileSync(path.join(DATA, 'server.log'), 'utf8').split('\n').slice(-60).join('\n'); } catch {}
    let dataKb = null;
    try { dataKb = Number((spawnSync('du', ['-sk', DATA], { encoding: 'utf8' }).stdout || '').split(/\s/)[0]) || null; } catch {}
    const residents = roster.residents.map((k) => {
      const a = agents.get(k);
      return a && { id: a.id, persona: a.persona, status: a.status, pid: procs.get(k) ? procs.get(k).pid : null, restarts: a.restarts || 0,
        upSince: a.procStartedAt || null, contextTokens: a.contextTokens || 0, sessionStartedAt: a.sessionStartedAt || null,
        inbox: a.inbox.length, model: a.model, effort: a.effort, needsRefresh: needsRefresh(roster, a) };
    }).filter(Boolean);
    const offline = residents.filter((x) => x.status === 'offline');
    const loginBad = login && login.refreshExpiresAt && login.refreshExpiresAt < now() + 3 * 86400000;
    const level = offline.length || (login && login.refreshExpiresAt && login.refreshExpiresAt < now()) ? 'bad'
      : loginBad || errors.filter((e) => e.t > now() - 24 * 3600000).length || failed.length ? 'warn' : 'ok';
    return { level, server: { startedAt: SERVER_STARTED, node: process.version, claude: claudeVersion, dataKb, host: HOST },
      login, residents, errors: errors.sort((x, y) => y.t - x.t).slice(0, 40), failed: failed.sort((x, y) => y.t - x.t).slice(0, 20),
      limits: { status: limits.status, hold: limits.hold || null, updatedAt: limits.updatedAt },
      refresh: { contextTokens: roster.defaults.refreshContextTokens || 150000, days: roster.defaults.refreshDays || 7 },
      selftest: selftestNow(), logTail,
      scripts: [...agents.values()].filter((x) => x.scriptRuns || x.scriptNudges).map((x) => ({ id: x.id, who: x.persona, runs: x.scriptRuns || 0, nudges: x.scriptNudges || 0 })).sort((x, y) => y.runs - x.runs) };
  }

  return { healthView };
}

module.exports = { install };
