'use strict';
// Fresh sessions for leads: save what matters to memory and start a new conversation when one grows too long.

function install(ctx) {
  const { agents, now, readJson, restartResident, touch } = ctx;

  const REFRESH_PROMPT = `[Housekeeping from the workplace — not a ticket]
  Your conversation has grown long, so the office will start you on a fresh session after this turn. Your memory file carries over; this conversation does not.
  Call \`update_memory\` now with your full revised memory: keep what still matters from this session (how the user likes things, open threads, lessons, where things live). Put durable code facts in the team library instead. Then reply with one line.`;

  function needsRefresh(roster, a) {
    if (!a.resident || a.id === roster.root || !a.sessionId) return false;
    const maxTok = roster.defaults.refreshContextTokens || 150000;
    const maxDays = roster.defaults.refreshDays || 7;
    return (a.contextTokens || 0) > maxTok || (a.sessionStartedAt && now() - a.sessionStartedAt > maxDays * 86400000);
  }

  function maybeRefresh(a, force) {
    const roster = readJson('roster.json');
    if (!a.resident || a.id === roster.root) return false;
    if (!force && !needsRefresh(roster, a)) return false;
    if (a.inbox.some((i) => i.refresh)) return false;
    a.inbox.push({ kind: 'chore', refresh: true, label: 'Writing my memory before a fresh session.', text: REFRESH_PROMPT });
    touch(a);
    return true;
  }

  function restartWhenIdle(key) {
    const a = agents.get(key);
    if (!a) return;
    if (!a.current && !a.inbox.length) restartResident(key);
    else a.restartWhenIdle = true;
  }

  return { maybeRefresh, restartWhenIdle, needsRefresh };
}

module.exports = { install };
