'use strict';
// Plans for big jobs: when a lead must propose a plan, the user's decision, and automatic approval.

function install(ctx) {
  const { addEvent, agents, broadcast, limits, newId, now, planWaiters, readJson, releaseBudget, thread, ticketBudget, ticketOfAgent, touch } = ctx;

  function planGate(roster, parent, t, assignments) {
    if (!t || !parent.resident || parent.id === roster.root || roster.defaults.planApproval === false) return null;
    if (t.plan && ['approved', 'changed'].includes(t.plan.status)) return null;
    const big = assignments.length >= 2 || assignments.some((x) => x.model === 'opus' || (!x.model && roster.roles[x.role] && roster.roles[x.role].model === 'opus'));
    if (!big) return null;
    if (t.plan && t.plan.status === 'rejected') return 'The user rejected the plan for this ticket. Do not start a team; answer the user.';
    return 'This is a big delegation (two or more teammates, or an opus teammate). Call `propose_plan` first with the steps, who does what on which model, and a cost estimate; delegate after the user approves.';
  }

  function proposePlan(agentId, plan, estimate) {
    const a = agents.get(agentId);
    const t = a && ticketOfAgent(a);
    if (!t) return Promise.resolve({ error: 'You have no current ticket.' });
    if (t.plan && t.plan.status === 'pending') return Promise.resolve({ error: 'A plan is already waiting for the user.' });
    const p = { id: newId(), from: a.id, text: String(plan || '').slice(0, 8000), estimateUsd: Math.max(0, Number(estimate) || 0), status: 'pending', at: now() };
    t.plan = p;
    thread(t, { from: a.id, to: 'user', kind: 'plan', text: p.text, estimateUsd: p.estimateUsd });
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

  // Why a plan can go ahead without the user, or null: they said so for this job, or it fits the auto-approve setting.
  function autoApproveReason(t, p) {
    if (t.autoPlans) return 'approved automatically: you said not to ask again on this job';
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
    if (w) w.resolve({ message: p.status === 'rejected'
      ? `The user rejected the plan.${p.note ? ` Their note: ${p.note}` : ''} Do not start a team. Answer the user briefly with what you can say without it.`
      : p.status === 'changed'
        ? `The user approved the plan with changes: ${p.note}\nAdjust the plan accordingly and go ahead.${t.budgetUsd != null ? ` Budget is now $${t.budgetUsd.toFixed(2)}.` : ''}`
        : `${auto ? `The plan was ${auto}.` : 'The user approved the plan.'} Go ahead.${t.budgetUsd != null ? ` Budget is now $${t.budgetUsd.toFixed(2)}.` : ''}` });
    return { ok: true };
  }

  return { decidePlan, proposePlan, planGate };
}

module.exports = { install };
