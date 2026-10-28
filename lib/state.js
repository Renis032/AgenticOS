'use strict';
// The office's state on disk: agents, tickets and team state, loaded at start and saved atomically with a .bak copy; agents' event logs. Moved out of server.js unchanged.

function install(ctx) {
  const { ACTIVE, agents, DATA, EVENTS_DIR, EVENTS_IN_MEMORY, fs, path, readJson, tickets } = ctx;

  // The ticket counter and the team state belong here: only loading replaces them.
  let teamState = {};
  let ticketSeq = 0;
  const getTeamState = () => teamState;
  const nextTicketN = () => ++ticketSeq;

  function assignPids() {
    const roster = readJson('roster.json');
    roster.residents.forEach((k, i) => { const a = agents.get(k); if (a) a.no = i + 1; });
    let next = Math.max(99, ...[...agents.values()].filter((a) => !a.resident && a.no).map((a) => a.no)) + 1;
    for (const a of [...agents.values()].filter((x) => !x.resident && !x.no).sort((x, y) => (x.hiredAt || x.createdAt) - (y.hiredAt || y.createdAt))) a.no = next++;
  }

  function summary(a) {
    const { events, ...rest } = a;
    return rest;
  }

  // State files are written atomically (temp file + rename) and copied to <file>.bak every 10 minutes. A file that
  // cannot be read is set aside as <file>.corrupt-<time> and its .bak loaded instead, so a damaged file never silently
  // starts the office empty.
  function readState(name) {
    const f = path.join(DATA, name);
    if (!fs.existsSync(f)) return null;
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {
      const aside = `${f}.corrupt-${Date.now()}`;
      try { fs.renameSync(f, aside); } catch { /* keep going */ }
      console.error(`${name} could not be read (${e.message}); moved it to ${path.basename(aside)}, loading ${name}.bak`);
      try { return JSON.parse(fs.readFileSync(`${f}.bak`, 'utf8')); } catch { console.error(`${name}.bak could not be read either; starting without it`); return null; }
    }
  }

  function loadState() {
    try {
      for (const a of readState('agents.json') || []) {
        if (!a.resident) {
          if (!a.homeId) continue;
          if (!a.staff) {
            const outcome = a.status === 'done' ? 'done' : ACTIVE.includes(a.status) ? 'interrupted' : a.status;
            Object.assign(a, { staff: true, tickets: a.ticketId ? [a.ticketId] : [], feedback: [], lastOutcome: outcome,
              tasksDone: outcome === 'done' ? 1 : 0, tasksFailed: outcome === 'done' ? 0 : 1, hiredAt: a.createdAt,
              history: a.ticketId ? [{ ticketId: a.ticketId, n: a.ticketN, title: a.title, outcome, costUsd: a.costUsd, model: a.model ? `${a.model}/${a.effort}` : null, t: a.endedAt || a.updatedAt }] : [] });
          } else if (ACTIVE.includes(a.status)) {
            a.lastOutcome = 'interrupted';
          }
          a.status = 'idle';
        }
        if (a.resident) {
          a.status = 'offline';
          if (a.current) { a.inbox.unshift({ ...a.current, text: '(Re-sent after a workplace restart; you may have already started on this.)\n' + a.current.text }); a.current = null; }
        }
        a.events = null;
        agents.set(a.id, a);
      }
    } catch { /* first run */ }
    teamState = readState('teams.json') || {};
    try {
      const t = readState('tickets.json');
      if (!t) throw new Error('first run');
      ticketSeq = t.seq || 0;
      for (const k of t.tickets) tickets.set(k.id, k);
    } catch { /* first run */ }
    // Twins (second desks) do not survive a restart: whatever they had queued or were doing goes back to their lead,
    // and their tickets belong to the lead again.
    for (const tw of agents.values()) {
      if (!tw.twinOf) continue;
      const lead = agents.get(tw.twinOf);
      if (lead && tw.inbox && tw.inbox.length) lead.inbox.push(...tw.inbox);
      Object.assign(tw, { inbox: [], current: null, retired: true, sessionId: null, status: 'offline' });
      const back = (k) => (k === tw.id ? tw.twinOf : k);
      for (const tk of tickets.values()) {
        if (tk.twin === tw.id) delete tk.twin;
        if (tk.pending && tk.pending.includes(tw.id)) tk.pending = [...new Set(tk.pending.map(back))];
        if (tk.pausedLeads && tk.pausedLeads.includes(tw.id)) tk.pausedLeads = [...new Set(tk.pausedLeads.map(back))];
      }
    }
  }

  let saveTimer = null;
  const lastWritten = {};
  let lastBak = 0;
  function writeState(name, text, bak) {
    const f = path.join(DATA, name);
    if (lastWritten[name] === text) return;
    if (bak && fs.existsSync(f)) fs.copyFileSync(f, `${f}.bak`);
    fs.writeFileSync(`${f}.tmp`, text);
    fs.renameSync(`${f}.tmp`, f);
    lastWritten[name] = text;
  }
  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    const bak = Date.now() - lastBak > 600000;
    if (bak) lastBak = Date.now();
    writeState('agents.json', JSON.stringify([...agents.values()].map(summary), null, 1), bak);
    writeState('tickets.json', JSON.stringify({ seq: ticketSeq, tickets: [...tickets.values()] }, null, 1), bak);
    writeState('teams.json', JSON.stringify(teamState, null, 1), bak);
  }
  // Changes are saved at most half a second after the first one, however busy the office is (the timer is not pushed back).
  function saveState() {
    if (!saveTimer) saveTimer = setTimeout(saveNow, 500);
  }

  function eventsOf(a) {
    if (!a.events) {
      try {
        a.events = fs.readFileSync(path.join(EVENTS_DIR, a.id + '.jsonl'), 'utf8')
          .split('\n').filter(Boolean).slice(-EVENTS_IN_MEMORY).map((l) => JSON.parse(l));
      } catch { a.events = []; }
    }
    return a.events;
  }

  return { assignPids, summary, loadState, saveNow, saveState, eventsOf, getTeamState, nextTicketN };
}

module.exports = { install };
