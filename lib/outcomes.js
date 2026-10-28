'use strict';
// Outcomes: what it costs to get a job done well, from the jobs themselves (nothing new is logged).
// A job counts as a success when it ended done, its checks (if any) passed, it was not rated 👎, its changes were
// not undone and the user didn't have to follow up within two hours (rework). Per lead, per project and overall:
// jobs, successes, failures, interruptions, check failures, retries (checks sent back, rework, resumes), median
// duration, total cost and cost per successful job — the number that matters, not cost per job.

function install(ctx) {
  const { agents, now, readJson, tickets } = ctx;

  const success = (t) => t.status === 'done' && !(t.rating && t.rating.score < 0) && !t.undone && !t.rework && !(t.verify && t.verify.status === 'failed');
  const median = (xs) => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

  function summarize(list) {
    const ended = list.filter((t) => t.closedAt && ['done', 'failed', 'interrupted', 'stopped'].includes(t.status));
    const ok = ended.filter(success);
    const cost = ended.reduce((s, t) => s + (t.costUsd || 0), 0);
    const checkFails = ended.reduce((s, t) => s + (t.thread || []).filter((e) => e.kind === 'verify' && e.ok === false).length, 0);
    const checked = ended.filter((t) => t.verify).length;
    const retries = ended.reduce((s, t) => s + Math.max(0, ((t.verify && t.verify.attempt) || 1) - 1) + (t.rework || 0) + (t.resumes || 0), 0);
    return {
      jobs: ended.length, succeeded: ok.length, failed: ended.filter((t) => t.status === 'failed').length,
      interrupted: ended.filter((t) => t.status === 'interrupted').length, stopped: ended.filter((t) => t.status === 'stopped').length,
      reworked: ended.filter((t) => t.rework).length, undone: ended.filter((t) => t.undone).length, ratedDown: ended.filter((t) => t.rating && t.rating.score < 0).length,
      checked, checkFails, retries,
      successRate: ended.length ? ok.length / ended.length : null,
      medianMinutes: median(ended.map((t) => (t.closedAt - t.createdAt) / 60000)),
      costUsd: cost, costPerJob: ended.length ? cost / ended.length : null, costPerSuccess: ok.length ? cost / ok.length : null,
    };
  }

  function report(days = 30) {
    const since = now() - days * 86400000;
    const list = [...tickets.values()].filter((t) => (t.closedAt || t.createdAt) >= since);
    const root = readJson('roster.json').root;
    const leadOf = (t) => t.direct || (t.assignees || []).find((k) => k !== root) || root;
    const group = (keyOf, nameOf) => {
      const m = new Map();
      for (const t of list) { const k = keyOf(t); if (!k) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(t); }
      return [...m.entries()].map(([k, l]) => ({ key: k, name: nameOf(k), ...summarize(l) })).filter((g) => g.jobs).sort((a, b) => b.jobs - a.jobs);
    };
    const persona = (k) => { const a = agents.get(k); const lead = a && a.twinOf ? agents.get(a.twinOf) : a; return (lead && lead.persona) || k; };
    return {
      days, overall: summarize(list),
      byLead: group((t) => { const a = agents.get(leadOf(t)); return a && a.twinOf ? a.twinOf : leadOf(t); }, persona),
      byProject: group((t) => t.project || null, (k) => k),
      failing: list.filter((t) => t.closedAt && !success(t) && t.status !== 'stopped').sort((a, b) => b.closedAt - a.closedAt).slice(0, 8)
        .map((t) => ({ id: t.id, n: t.n, title: t.title, status: t.status, why: t.verify && t.verify.status === 'failed' ? 'checks failed' : t.rework ? 'needed rework' : t.undone ? 'changes undone' : t.rating && t.rating.score < 0 ? 'rated not good' : t.status, costUsd: t.costUsd || 0 })),
    };
  }

  return { report, success, summarize };
}

module.exports = { install };
