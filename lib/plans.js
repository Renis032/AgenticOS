'use strict';
// Plans for big jobs: when a lead must propose a plan, the user's decision, automatic approval, and the plan's acceptance
// criteria with the lead's evidence for each (lib/verify.js holds the job open until they are reported and reviewed).
//
// t.plan.criteria = [{ text, met?, evidence?, by?, at? }]; met stays unset until the lead reports on that criterion.

const MAX_CRITERIA = 12;
const CRITERION_CHARS = 300;
const EVIDENCE_CHARS = 1000;

function install(ctx) {
  const { addEvent, agents, broadcast, limits, newId, now, planWaiters, readJson, releaseBudget, thread, ticketBudget, ticketOfAgent, touch, touchTicket } = ctx;

  function planGate(roster, parent, t, assignments) {
    if (!t || !parent.resident || parent.id === roster.root || roster.defaults.planApproval === false) return null;
    if (t.plan && ['approved', 'changed'].includes(t.plan.status)) return null;
    const big = assignments.length >= 2 || assignments.some((x) => x.model === 'opus' || (!x.model && roster.roles[x.role] && roster.roles[x.role].model === 'opus'));
    if (!big) return null;
    if (t.plan && t.plan.status === 'rejected') return 'The user rejected the plan for this ticket. Do not start a team; answer the user.';
    return 'This is a big delegation (two or more teammates, or an opus teammate). Call `propose_plan` first with the steps, who does what on which model, and a cost estimate; delegate after the user approves.';
  }

  function proposePlan(agentId, plan, estimate, criteria) {
    const a = agents.get(agentId);
    const t = a && ticketOfAgent(a);
    if (!t) return Promise.resolve({ error: 'You have no current ticket.' });
    if (t.plan && t.plan.status === 'pending') return Promise.resolve({ error: 'A plan is already waiting for the user.' });
    const done = (Array.isArray(criteria) ? criteria : []).map((c) => String(c).trim().slice(0, CRITERION_CHARS)).filter(Boolean);
    if (done.length > MAX_CRITERIA) return Promise.resolve({ error: `At most ${MAX_CRITERIA} acceptance criteria; merge the smaller ones.` });
    const p = { id: newId(), from: a.id, text: String(plan || '').slice(0, 8000), estimateUsd: Math.max(0, Number(estimate) || 0), status: 'pending', at: now(), criteria: done.map((text) => ({ text })) };
    t.plan = p;
    thread(t, { from: a.id, to: 'user', kind: 'plan', text: p.text, estimateUsd: p.estimateUsd, criteria: done });
    const auto = autoApproveReason(t, p);
    if (auto) {
      const done = new Promise((resolve) => planWaiters.set(p.id, { resolve }));
      decidePlan(t, 'approve', '', auto);
      return done;
    }
    broadcast({ type: 'notify', kind: 'question', ticketId: t.id, title: `${a.persona} wants your OK on a plan (#${t.n})`, text: `Estimated $${p.estimateUsd.toFixed(2)}. ${p.text}` });
    a.progress = `Waiting for your OK on the plan for ticket #${t.n}.`;
    addEvent(a, { kind: 'progress', text: a.progress });
    touch(a);
    return new Promise((resolve) => planWaiters.set(p.id, { resolve }));
  }

  // The lead's evidence for the approved plan's acceptance criteria: [{ criterion: 1-based number, met, evidence }].
  // Nothing is recorded unless every item is valid, and a later report on a criterion replaces the earlier one.
  function reportEvidence(agentId, items) {
    const a = agents.get(agentId);
    const t = a && ticketOfAgent(a);
    if (!t) return { error: 'You have no current ticket.' };
    const p = t.plan;
    const list = p && ['approved', 'changed'].includes(p.status) ? p.criteria || [] : [];
    if (!list.length) return { error: 'This ticket has no approved plan with acceptance criteria.' };
    if (!Array.isArray(items) || !items.length) return { error: 'Report at least one criterion.' };
    for (const x of items) {
      if (!Number.isInteger(x && x.criterion) || !list[x.criterion - 1]) return { error: `There is no criterion ${x && x.criterion}; they are numbered 1 to ${list.length}.` };
      if (typeof x.met !== 'boolean') return { error: `Criterion ${x.criterion}: say whether it is met (true or false).` };
      if (!String(x.evidence || '').trim()) return { error: `Criterion ${x.criterion}: give the evidence (the command and its result, the file and line, or what you saw).` };
    }
    for (const x of items) Object.assign(list[x.criterion - 1], { met: x.met, evidence: String(x.evidence).trim().slice(0, EVIDENCE_CHARS), by: a.id, at: now() });
    touchTicket(t);
    const missing = list.map((c, i) => (c.met == null ? i + 1 : 0)).filter(Boolean);
    return { message: missing.length ? `Recorded. Still to report: ${missing.join(', ')}.` : 'Recorded. Every criterion has been reported.' };
  }

  // Why a plan can go ahead without the user, or null: they said so for this job, or it fits the auto-approve setting.
  function autoApproveReason(t, p) {
    if (t.autoPlans) return 'approved automatically: you said not to ask again on this job';
    const night = ctx.overnight && ctx.overnight.approves(t, p);
    if (night) return night;
    const d = readJson('roster.json').defaults;
    const max = Number(d.autoApprovePlansUsd) || 0;
    if (!(max > 0) || p.estimateUsd > max) return null;
    const w = limits.windows && limits.windows.five_hour;
    const used = w && !(w.resetsAt && w.resetsAt < now()) ? w.utilization || 0 : 0;
    const cap = Number(d.autoApproveUsageMax) || 0;
    if (cap > 0 && used >= cap) return null;
    return `approved automatically: estimate under $${max}${cap > 0 ? ` and 5-hour usage under ${Math.round(cap * 100)}%` : ''}`;
  }

  function decidePlan(t, decision, note, auto) {
    const p = t.plan;
    if (!p || p.status !== 'pending') return { error: 'No plan is waiting.' };
    if (decision === 'always') { t.autoPlans = true; decision = 'approve'; }
    p.auto = auto || null;
    if (ctx.audit) ctx.audit.record(auto ? 'office' : 'user', `plan.${decision === 'reject' ? 'rejected' : 'approved'}`, { job: t.n, detail: note || auto || '' });
    p.status = decision === 'reject' ? 'rejected' : note ? 'changed' : 'approved';
    p.note = String(note || '').slice(0, 4000);
    p.decidedAt = now();
    if (p.status !== 'rejected' && ticketBudget() != null && p.estimateUsd * 1.3 > (t.budgetUsd || 0)) {
      t.budgetUsd = Math.ceil(p.estimateUsd * 1.3);
      if (t.overBudget && t.costUsd < t.budgetUsd) { t.overBudget = false; releaseBudget(t, true); }
    }
    thread(t, { from: auto ? 'system' : 'user', to: p.from, kind: 'plandecision', decision: p.status, text: p.note, auto: auto || null });
    const w = planWaiters.get(p.id);
    planWaiters.delete(p.id);
    const evidence = (p.criteria || []).length ? ' Before your final answer, call `report_evidence` for every acceptance criterion.' : '';
    if (w) w.resolve({ message: p.status === 'rejected'
      ? `The user rejected the plan.${p.note ? ` Their note: ${p.note}` : ''} Do not start a team. Answer the user briefly with what you can say without it.`
      : p.status === 'changed'
        ? `The user approved the plan with changes: ${p.note}\nAdjust the plan accordingly and go ahead.${t.budgetUsd != null ? ` Budget is now $${t.budgetUsd.toFixed(2)}.` : ''}${evidence}`
        : `${auto ? `The plan was ${auto}.` : 'The user approved the plan.'} Go ahead.${t.budgetUsd != null ? ` Budget is now $${t.budgetUsd.toFixed(2)}.` : ''}${evidence}` });
    return { ok: true };
  }

  return { decidePlan, proposePlan, planGate, reportEvidence };
}

module.exports = { install };
