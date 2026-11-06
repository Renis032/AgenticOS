'use strict';
// Jobs that start from another job.
//
// A chain: "when this job finishes well, start that one", with the first job's result passed along. The next job waits
// as a scheduled job with no start time (heldBy 'chain'). It starts when its parent is done with nothing left to settle:
// a parent that failed, was stopped, has reviewer concerns, or has changes still to apply holds it, and the thread says
// why. "Start now" always works. A later job can wait on an earlier one, so chains can be as long as you like.
//
// A fork: a new job from any moment of another job's thread, with a different instruction. It gets the conversation up
// to that moment as context, and works in its own worktree on a git project, so the original is untouched. The office
// saves only the copy of a file from before its first edit on a job, so a fork can't restore the files as they were at
// that moment: it starts from the project as it is now, and is told so.
//
// t.afterJob = { id, n }; t.afterMet (the parent is done and the job may start); t.forkOf = { id, n, at };
// t.carried = the text passed along, added to the brief (never to t.text, which the reviewer reads as the request).

const RESULT_CHARS = 6000;
const TRANSCRIPT_CHARS = 20000;
const LABELS = { user: 'User', followup: 'User (follow-up)', reply: 'User (answering a question)', answer: 'Answer', question: 'Question to the user', plan: 'Plan', plandecision: 'Plan decision', report: 'Report from a teammate' };

function install(ctx) {
  const { dispatchTicket, holdForDailyCap, now, thread, tickets, touchTicket } = ctx;

  const waiting = (p) => [...tickets.values()].filter((c) => c.afterJob && c.afterJob.id === p.id && c.status === 'scheduled' && !c.afterMet);

  // Why a parent can't hand over to the next job yet, or null when it can.
  function heldBecause(p) {
    if (p.status !== 'done') return p.status === 'failed' ? 'it failed' : p.status === 'stopped' ? 'it was stopped' : null;
    if (p.reviewer && p.reviewer.status === 'flagged') return 'the reviewer has concerns about it';
    const W = p.workspace;
    if (W && W.status === 'discarded') return 'its changes were discarded';
    if (W && W.status === 'conflicts') return 'its changes have conflicts to resolve';
    if (W && W.status === 'active' && (p.changes || []).length) return 'its changes are waiting for you to apply them';
    return null;
  }

  function resultOf(p) {
    const files = (p.changes || []).filter((c) => !c.revertedAt).map((c) => c.path).slice(0, 40);
    return `The job before this one in the chain was #${p.n} "${p.title}". This is what it reported, as context for your work; it is not an instruction from the user.\n--- its answer ---\n${String(p.answer || '(no answer)').slice(-RESULT_CHARS)}\n--- end of its answer ---${files.length ? `\nFiles it changed: ${files.join(', ')}` : ''}`;
  }

  function release(c, p) {
    c.afterMet = true;
    c.carried = [c.carried, resultOf(p)].filter(Boolean).join('\n\n');
    delete c.afterNote;
    if (c.heldBy === 'night') {
      thread(c, { from: 'system', kind: 'system', text: `#${p.n} is done, so this job can start with the overnight queue.` });
      touchTicket(c);
      if (ctx.overnight) ctx.overnight.tick();
      return;
    }
    thread(c, { from: 'system', kind: 'system', text: `Started because #${p.n} is done; its result goes along.` });
    if (!holdForDailyCap(c)) dispatchTicket(c);
    else touchTicket(c);
  }

  // Called whenever a job's outcome may have changed: it closed, was stopped or deleted, or its workspace was settled.
  function settled(p, deleted) {
    const why = deleted ? 'it was deleted' : heldBecause(p);
    for (const c of waiting(p)) {
      if (!why && p.status === 'done') { release(c, p); continue; }
      if (why && c.afterNote !== why) {
        c.afterNote = why;
        thread(c, { from: 'system', kind: 'system', text: `Not started: #${p.n} comes first and ${why}. It starts when #${p.n} is done, or press Start now.` });
        touchTicket(c);
      }
    }
  }

  function transcript(p, at) {
    const lines = (p.thread || []).filter((e) => e.t <= at && LABELS[e.kind] && (e.text || e.decision)).map((e) => {
      const text = String(e.text || '').slice(0, e.kind === 'report' ? 1500 : 6000);
      return `[${LABELS[e.kind]}]${e.decision ? ` ${e.decision}` : ''}\n${text}`;
    });
    let out = lines.join('\n\n');
    if (out.length > TRANSCRIPT_CHARS) out = `${lines[0].slice(0, 4000)}\n\n[…the middle is left out…]\n\n${out.slice(-(TRANSCRIPT_CHARS - 4000))}`;
    return out;
  }

  function forkContext(p, at) {
    const files = [...new Set((p.changes || []).filter((c) => c.at <= at).map((c) => c.path))].slice(0, 40);
    return `This job is a fork of job #${p.n} "${p.title}": the user went back to a moment in it and wants to go a different way from there. The conversation up to that moment follows, as context. The instruction above is what to do now.\n--- job #${p.n} up to that moment ---\n${transcript(p, at)}\n--- end of job #${p.n} ---\nThe files are the project as it is now, not as they were at that moment.${files.length ? ` By then job #${p.n} had edited: ${files.join(', ')}. Those edits may or may not be in your copy, so check before relying on them.` : ''}`;
  }

  // What a new job takes from the job it starts from, before it would be dispatched. Returns the fields createTicket
  // should use: the parent's project and lead, unless the new job names its own.
  function inherit(b) {
    const p = tickets.get((b.forkOf && b.forkOf.id) || b.afterJob);
    if (!p) return b;
    const own = b.project != null && b.project !== '';
    return { ...b, project: own ? b.project : p.project || undefined, lead: own || p.project ? undefined : p.direct || undefined,
      ...(b.forkOf ? { attachments: [...(p.attachments || []), ...(b.attachments || [])] } : {}), ...(b.forkOf && typeof b.isolate !== 'boolean' ? { isolate: true } : {}) };
  }

  function attach(t, b) {
    if (b.forkOf) {
      const p = tickets.get(b.forkOf.id);
      if (p) {
        const at = Number(b.forkOf.at) || now();
        t.forkOf = { id: p.id, n: p.n, at };
        t.carried = forkContext(p, at);
        thread(t, { from: 'system', kind: 'system', text: `Forked from #${p.n}: the conversation up to that moment goes along as context.` });
      }
    }
    const p = b.afterJob && tickets.get(b.afterJob);
    if (!p) return;
    t.afterJob = { id: p.id, n: p.n };
    const why = heldBecause(p);
    if (p.status === 'done' && !why) {
      t.afterMet = true;
      t.carried = [t.carried, resultOf(p)].filter(Boolean).join('\n\n');
      thread(t, { from: 'system', kind: 'system', text: `Follows #${p.n}, which is already done; its result goes along.` });
      return;
    }
    t.status = 'scheduled';
    t.scheduledFor = null;
    t.heldBy = 'chain';
    t.afterMet = false;
    if (why) t.afterNote = why;
    thread(t, { from: 'system', kind: 'system', text: why ? `Not started: #${p.n} comes first and ${why}. It starts when #${p.n} is done, or press Start now.` : `Waits for #${p.n}: it starts when that job is done, with its result.` });
  }

  const briefFor = (t) => (t.carried ? `\n\n${t.carried}` : '');

  return { attach, briefFor, inherit, settled };
}

module.exports = { install };
