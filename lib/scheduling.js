'use strict';
// Which waiting job goes next: urgent before normal before low, oldest first within each. defaults.maxLeadJobs limits
// how many jobs leads work on at once. Only a job's first start waits: a lead's running job, its follow-ups and messages
// always go through, because a running lead may be waiting on them and holding them back could deadlock the office.
// Specialists are limited separately (WORKPLACE_MAX_RUNNING). 0 turns the limit off; an urgent job ignores it.

const RANK = { urgent: 0, normal: 1, low: 2 };
const rank = (t) => (t && RANK[t.priority] != null ? RANK[t.priority] : 1);
const cleanPriority = (p, fallback = 'normal') => (RANK[p] != null ? p : fallback);
const notStarted = (t) => !!t && !t.startedAt && !t.answer;

function capFull(agents, roster) {
  const cap = Number(roster.defaults.maxLeadJobs ?? 4);
  if (!cap) return false;
  let n = 0;
  for (const a of agents.values()) if (a.resident && a.id !== roster.root && a.current && a.current.ticketId) n++;
  return n >= cap;
}

// The inbox position to work on next, or -1.
function pickInbox(inbox, tickets, full) {
  let best = -1, bestRank = 9;
  inbox.forEach((item, i) => {
    const t = item.ticketId && tickets.get(item.ticketId);
    if (t && t.status === 'paused') return;
    const r = rank(t);
    if (full && r > 0 && notStarted(t) && !['message', 'chore'].includes(item.kind)) return;
    if (r < bestRank) { best = i; bestRank = r; }
  });
  return best;
}

// The staff queue position to launch next, or -1. Retries wait for their notBefore time.
function pickQueue(queue, tickets, at) {
  let best = -1, bestRank = 9;
  queue.forEach((q, i) => {
    if (q.notBefore && q.notBefore > at) return;
    const r = rank(tickets.get(q.a.ticketId));
    if (r < bestRank) { best = i; bestRank = r; }
  });
  return best;
}

module.exports = { capFull, cleanPriority, pickInbox, pickQueue, rank };
