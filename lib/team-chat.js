'use strict';
// Team rooms: what teammates say to each other, and the user's questions to a whole team.

function install(ctx) {
  const { agents, ask, enqueueResident, eventsOf, newTicket, readJson, thread, tickets, touchTicket } = ctx;

  function floorOfAgent(a) {
    return a.resident ? a.id : a.homeId;
  }

  function teamChat(key) {
    const out = [];
    for (const a of agents.values()) {
      if (floorOfAgent(a) !== key) continue;
      for (const e of eventsOf(a)) {
        if (e.kind === 'msg_out') out.push({ t: e.t, from: a.persona, fromId: a.id, to: e.toPersona, toId: e.to, text: e.text, ask: !!e.ask });
      }
    }
    for (const t of tickets.values()) {
      if (!t.teamAsk || t.direct !== key) continue;
      out.push({ t: t.createdAt, from: 'You', fromId: 'user', to: 'the team', text: t.text, ticketId: t.id });
      if (t.answer) out.push({ t: t.closedAt || t.updatedAt, from: (agents.get(key) || {}).persona, fromId: key, to: 'You', text: t.answer, ticketId: t.id });
    }
    return out.sort((x, y) => x.t - y.t).slice(-150);
  }

  function askTeam(key, text) {
    const lead = agents.get(key);
    const roster = readJson('roster.json');
    if (!lead || !lead.resident || key === roster.root) return { error: 'No such team.' };
    const t = newTicket({ text: String(text).trim(), direct: key });
    t.teamAsk = true;
    thread(t, { from: 'user', to: key, kind: 'user', text: t.text });
    t.pending.push(key);
    t.assignees.push(key);
    touchTicket(t);
    enqueueResident(key, { ticketId: t.id, kind: 'direct', text: `[The user asks your whole team, ticket #${t.n}]\n${t.text}\n\n` +
      'Collect input from the teammates whose experience matters (a quick, cheap delegate to the right staff, or ask those who are busy), then answer the user directly with the team\'s view.' });
    return { id: t.id };
  }

  return { askTeam, teamChat };
}

module.exports = { install };
