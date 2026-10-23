'use strict';
// Weekly review: each team's week as a report job, and the lead looks into it only when something went wrong.

function install(ctx) {
  const { agents, enqueueResident, newTicket, now, readJson, saveState, teamState, thread, tickets, touchTicket, usageIndex, weeklyReport } = ctx;

  async function teamTokens(leadId, since) {
    const lead = agents.get(leadId);
    if (!lead) return null;
    const team = `${lead.persona} · ${lead.room || lead.name || ''}`.replace(/ · $/, '');
    const span = now() - since;
    const day = (t) => new Date(t).toLocaleDateString('sv');
    const [cur, prev] = await Promise.all([usageIndex.overview({ team, from: day(since), to: day(now()) }), usageIndex.overview({ team, from: day(since - span), to: day(since - 1) })]);
    return { cur: cur.dims.agent, prev: prev.dims.agent };
  }

  async function runReview(leadId) {
    const lead = agents.get(leadId);
    const roster = readJson('roster.json');
    if (!lead || !lead.resident || leadId === roster.root) return { error: 'Not a lead.' };
    teamState[leadId] = teamState[leadId] || {};
    const since = teamState[leadId].lastReview || now() - 7 * 86400000;
    let usage = null;
    try { usage = await teamTokens(leadId, since); } catch {}
    const rep = weeklyReport.build(leadId, since, { tickets: [...tickets.values()], agents: [...agents.values()], usage });
    const from = new Date(since).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const to = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const t = newTicket({ text: `Weekly review — ${lead.persona}, ${from} – ${to}`, direct: leadId });
    t.review = true;
    t.assignees.push(leadId);
    teamState[leadId].lastReview = now();
    saveState();
    if (!rep.needsLead) {
      t.answer = rep.text;
      t.status = 'done';
      t.closedAt = now();
      thread(t, { from: 'script', to: 'user', kind: 'answer', text: `${rep.text}

  _Written by the weekly-report script: nothing needed ${lead.persona}'s judgement, so no AI time was spent. Reply here if you want ${lead.persona} to dig deeper._` });
      return { id: t.id };
    }
    thread(t, { from: 'script', to: leadId, kind: 'system', text: `The weekly-report script found things that need ${lead.persona}'s judgement: ${rep.reasons.join('; ')}.` });
    t.pending.push(leadId);
    touchTicket(t);
    enqueueResident(leadId, { ticketId: t.id, kind: 'direct', text: `[Weekly review, ticket #${t.n}]
  The weekly-report script compiled your team's week since ${from} and flagged: ${rep.reasons.join('; ')}.

  ${rep.text}

  1. Look only at what was flagged (search_tickets, your team's feedback). Find the cause: what went wrong and why.
  2. Update your team library with durable lessons (add_to_team_docs), your own memory (update_memory), and give each teammate who needs it specific feedback (give_feedback).
  3. Your final message goes to the user: what went wrong, why, and what you changed so it goes better (under 200 words; the numbers above are already in the ticket). Do not start a team for this; keep it cheap.` });
    return { id: t.id };
  }

  async function maybeWeeklyReviews() {
    const roster = readJson('roster.json');
    const d = new Date();
    for (const k of roster.residents) {
      if (k === roster.root) continue;
      teamState[k] = teamState[k] || {};
      if (!teamState[k].lastReview) { teamState[k].lastReview = now(); saveState(); continue; }
      if (d.getDay() !== (roster.defaults.reviewDay ?? 1) || d.getHours() < (roster.defaults.reviewHour ?? 9)) continue;
      if (now() - teamState[k].lastReview < 3 * 86400000) continue;
      const lead = agents.get(k);
      if (!lead || weeklyReport.build(k, teamState[k].lastReview, { tickets: [...tickets.values()], agents: [...agents.values()] }).count === 0) { teamState[k].lastReview = now(); saveState(); continue; }
      await runReview(k);
    }
  }

  return { runReview, maybeWeeklyReviews };
}

module.exports = { install };
