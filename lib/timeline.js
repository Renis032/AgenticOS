'use strict';
// A job's timeline (who worked when, at what cost) and spend by day, team and model.

function install(ctx) {
  const { EVENTS_DIR, agents, eventsOf, fs, now, path } = ctx;

  function timelineOf(t) {
    const rows = [];
    const end = t.closedAt || now();
    for (const a of agents.values()) {
      if (!a.resident && !(a.tickets || []).includes(t.id)) continue;
      const spans = [];
      let open = null;
      for (const e of eventsOf(a)) {
        if (e.t < t.createdAt - 1000 || e.t > end + 600000) continue;
        if (e.kind === 'brief' || e.kind === 'followup') {
          open = (e.ticketId ? e.ticketId === t.id : !a.resident) ? { start: e.t } : null;
        } else if (e.kind === 'result' && open) {
          spans.push({ start: open.start, end: e.t, costUsd: e.costUsd || 0, ok: !e.isError });
          open = null;
        }
      }
      if (open && (a.status === 'running' || (a.current && a.current.ticketId === t.id))) spans.push({ start: open.start, end: null, costUsd: 0, running: true });
      if (spans.length) rows.push({ id: a.id, persona: a.persona, name: a.name, resident: !!a.resident, model: `${a.model}/${a.effort}`, spans });
    }
    return { start: t.createdAt, end: t.closedAt || null, rows };
  }

  let spendCache = null;
  function spendStats() {
    if (spendCache && now() - spendCache.at < 30000) return spendCache.data;
    const days = {};
    const teams = {};
    const models = {};
    const since = now() - 14 * 86400000;
    for (const a of agents.values()) {
      const team = a.resident ? a.twinOf || a.id : a.homeId || 'other';
      let lines = [];
      try { lines = fs.readFileSync(path.join(EVENTS_DIR, a.id + '.jsonl'), 'utf8').split('\n'); } catch {}
      for (const l of lines) {
        if (!l.includes('"kind":"result"')) continue;
        let e;
        try { e = JSON.parse(l); } catch { continue; }
        if (!e.costUsd) continue;
        if (e.t >= since) { const d = new Date(e.t).toLocaleDateString('sv'); days[d] = (days[d] || 0) + e.costUsd; }
        teams[team] = (teams[team] || 0) + e.costUsd;
        const m = e.model || 'not recorded (older work)';
        models[m] = (models[m] || 0) + e.costUsd;
      }
    }
    const day = [];
    for (let i = 13; i >= 0; i--) { const d = new Date(now() - i * 86400000).toLocaleDateString('sv'); day.push({ day: d, usd: days[d] || 0 }); }
    const data = { days: day,
      teams: Object.entries(teams).map(([k, usd]) => ({ key: k, label: agents.get(k) ? agents.get(k).persona : k, usd })).sort((x, y) => y.usd - x.usd),
      models: Object.entries(models).map(([k, usd]) => ({ key: k, usd })).sort((x, y) => y.usd - x.usd) };
    spendCache = { at: now(), data };
    return data;
  }

  return { spendStats, timelineOf };
}

module.exports = { install };
