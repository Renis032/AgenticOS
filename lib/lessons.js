'use strict';
// Lessons from jobs that went wrong. When a job fails, is rated 👎, needs rework (a follow-up within 2 hours) or has its
// changes undone, each lead on it is asked once to write ONE line with `add_lesson`: what to do differently next time.
// Lessons sit apart from the free-form memory, so they stay short: at most MAX per agent (the oldest drops off), one line
// each. They are shown in every new session's prompt and in the Memory app, where the user can remove one.
// With the reviewLessons office setting on (the default), a new lesson waits as a draft until the user keeps it (as
// written or edited) or drops it, so a wrong lesson never reaches the agents' prompts.
//
// Each draft carries the agent's reasoning (what went wrong and why this line would have prevented it) and what made
// the office ask, so the user can judge it; neither goes into the agents' prompts.
//
// a.lessons = [{ id, t, ticketN, why, text, reason }]
// a.lessonDrafts = [{ id, t, ticketN, text, reason, trigger, chat }]   waiting for the user's review
//
// Instead of only keeping or dropping a draft, the user can talk it over: they explain what they mean, the lead answers
// in its own voice and rewrites the line (one cheap model call per message). The user's explanation also reaches the
// lead as feedback once the lesson is kept, so the idea behind it is not lost.
// chat = [{ from: 'user' | 'agent', t, text }]

const MAX = 8;
const MAX_CHARS = 220;
const MAX_DRAFTS = 20;
const MAX_REASON = 600;
const WHY = {
  failed: 'it ended as failed',
  rated: 'the user rated the answer 👎',
  rework: 'the user had to follow up within 2 hours (the answer was not what they needed)',
  undone: 'the user undid its file changes',
};

function install(ctx) {
  const { agents, readJson, now, newId, touch, addEvent, giveFeedback, findSecret, broadcast, oneShot } = ctx;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

  // The leads to ask: whoever answered the job, never the router.
  function leadsOf(t) {
    const root = readJson('roster.json').root;
    return [...new Set([t.direct, ...(t.assignees || [])].filter(Boolean))].filter((k) => k !== root && agents.has(k));
  }

  // Asks once per job and reason. Returns the leads asked.
  function ask(t, why, note) {
    if (!t || !WHY[why]) return [];
    t.lessonAsked = t.lessonAsked || [];
    if (t.lessonAsked.includes(why)) return [];
    const to = leadsOf(t);
    if (!to.length) return [];
    t.lessonAsked.push(why);
    for (const k of to) {
      giveFeedback('user', k, `Ticket #${t.n} ("${t.title}") went wrong: ${WHY[why]}${note ? ` — "${String(note).slice(0, 400)}"` : ''}. ` +
        'Work out what you would do differently, then call `add_lesson` with ONE line (under 200 characters) you can apply to similar jobs, ' +
        'and `reasoning`: what you did on this job that led to it and why the lesson would have prevented it, for the user to review. ' +
        'Skip it only if nothing in your approach was at fault.');
    }
    return to;
  }

  const reviewOn = () => (readJson('roster.json').defaults || {}).reviewLessons !== 0;

  function check(text) {
    const line = String(text || '').replace(/\s+/g, ' ').trim();
    if (!line) return { error: 'Empty lesson.' };
    if (line.length > MAX_CHARS) return { error: `Too long (${line.length} characters): one line under ${MAX_CHARS}, please.` };
    if (findSecret(line)) return { error: 'That looks like it contains a secret; leave it out.' };
    return { line };
  }

  // Puts a checked line into a.lessons, replacing a duplicate and dropping the oldest past MAX.
  function keep(a, line, ticketN, reason) {
    a.lessons = (a.lessons || []).filter((l) => norm(l.text) !== norm(line));
    a.lessons.push({ id: newId(), t: now(), ticketN: ticketN || null, text: line, ...(reason ? { reason } : {}) });
    const dropped = a.lessons.length > MAX ? a.lessons.splice(0, a.lessons.length - MAX) : [];
    addEvent(a, { kind: 'lesson', text: line });
    touch(a);
    return dropped;
  }

  // ticket: the job the agent is on, if any (its lessonAsked says what made the office ask).
  function add(agentId, text, ticket, reasoning) {
    const ticketN = ticket && ticket.n;
    const me = agents.get(agentId);
    const a = me && me.twinOf ? agents.get(me.twinOf) || me : me; // a twin's lessons belong to its lead
    if (!a) return { error: 'Unknown agent.' };
    const { line, error } = check(text);
    if (error) return { error };
    const reason = String(reasoning || '').replace(/\s+/g, ' ').trim().slice(0, MAX_REASON);
    if (reason && findSecret(reason)) return { error: 'The reasoning looks like it contains a secret; leave it out.' };
    if (reviewOn()) {
      if (!reason) return { error: 'Add `reasoning`: what happened on this job and why this lesson would have prevented it. The user reads it to decide whether to keep the lesson.' };
      if ((a.lessons || []).some((l) => norm(l.text) === norm(line))) return { message: 'You already have that lesson.' };
      const asked = ticket && (ticket.lessonAsked || []);
      const trigger = asked && asked.length ? WHY[asked[asked.length - 1]] : null;
      a.lessonDrafts = (a.lessonDrafts || []).filter((l) => norm(l.text) !== norm(line));
      a.lessonDrafts.push({ id: newId(), t: now(), ticketN: ticketN || null, text: line, reason, ...(trigger ? { trigger } : {}) });
      if (a.lessonDrafts.length > MAX_DRAFTS) a.lessonDrafts.splice(0, a.lessonDrafts.length - MAX_DRAFTS);
      touch(a);
      if (broadcast) broadcast({ type: 'notify', kind: 'lesson', title: `${a.persona} wrote a lesson to review`, text: line });
      return { message: 'Lesson sent to the user for review; it applies from your next session once they keep it. Carry on.' };
    }
    const dropped = keep(a, line, ticketN, reason);
    return { message: `Lesson saved (${a.lessons.length} of ${MAX})${dropped.length ? `; the oldest ("${dropped[0].text.slice(0, 60)}…") dropped off` : ''}.` };
  }

  // The user keeps a draft, as written or with their own wording.
  function approve(agentId, id, text) {
    const a = agents.get(agentId);
    const d = a && (a.lessonDrafts || []).find((l) => l.id === id);
    if (!d) return { error: 'No such lesson to review.' };
    const { line, error } = check(text == null ? d.text : text);
    if (error) return { error };
    a.lessonDrafts = a.lessonDrafts.filter((l) => l.id !== id);
    keep(a, line, d.ticketN, d.reason);
    const said = (d.chat || []).filter((m) => m.from === 'user').map((m) => m.text);
    if (said.length) giveFeedback('user', a.id, `About your lesson "${line}": ${said.join(' / ').slice(0, 1500)}`);
    return { ok: true, edited: line !== d.text };
  }

  // The user explains what they mean; the lead answers and rewrites the draft to match.
  async function discuss(agentId, id, text) {
    const a = agents.get(agentId);
    const d = a && (a.lessonDrafts || []).find((l) => l.id === id);
    if (!d) return { error: 'No such lesson to review.' };
    const said = String(text || '').trim().slice(0, 1500);
    if (!said) return { error: 'Say what you mean first.' };
    if (findSecret(said)) return { error: 'That looks like it contains a secret; leave it out.' };
    d.chat = d.chat || [];
    d.chat.push({ from: 'user', t: now(), text: said });
    touch(a);
    if (!oneShot) return { error: 'The lead cannot answer here right now.' };
    const roster = readJson('roster.json');
    const def = a.customDef || (roster.roles || {})[a.role] || {};
    const prompt = `You are ${a.persona}, ${def.description || 'a lead in the user\'s agent office'}. After job #${d.ticketN || '?'} went wrong you drafted a lesson: one line you will apply to similar jobs. The user is reviewing it with you.

Draft lesson: ${d.text}
${d.trigger ? `Why the office asked for it: ${d.trigger}.\n` : ''}Your reasoning: ${d.reason || '(none)'}

Conversation so far:
${d.chat.map((m) => `${m.from === 'user' ? 'User' : 'You'}: ${m.text}`).join('\n')}

Reply to the user in 1-3 plain sentences: say what you understood and how it changes the lesson, or ask one short question if their point is unclear. Then rewrite the lesson as ONE line under 200 characters that captures what the user means; keep the current line if they only asked a question.
Answer with JSON only: {"reply": "...", "lesson": "..."}`;
    const r = await oneShot(prompt, 'sonnet', 'low');
    let j = null;
    if (!r.error) { try { j = JSON.parse((r.text.match(/\{[\s\S]*\}/) || [''])[0]); } catch {} }
    if (!j || !j.reply) return { error: r.error ? `${a.persona} could not answer: ${r.error}` : `${a.persona}'s answer was unreadable; try again.`, draft: d };
    d.chat.push({ from: 'agent', t: now(), text: String(j.reply).slice(0, 1000) });
    const { line } = check(j.lesson);
    if (line && line !== d.text) { d.original = d.original || d.text; d.text = line; }
    touch(a);
    return { ok: true, draft: d, costUsd: r.costUsd };
  }

  function drop(agentId, id) {
    const a = agents.get(agentId);
    if (!a) return { error: 'Unknown agent.' };
    const before = (a.lessonDrafts || []).length;
    a.lessonDrafts = (a.lessonDrafts || []).filter((l) => l.id !== id);
    if (a.lessonDrafts.length === before) return { error: 'No such lesson to review.' };
    touch(a);
    return { ok: true };
  }

  function remove(agentId, id) {
    const a = agents.get(agentId);
    if (!a) return { error: 'Unknown agent.' };
    const before = (a.lessons || []).length;
    a.lessons = (a.lessons || []).filter((l) => l.id !== id);
    if (a.lessons.length === before) return { error: 'No such lesson.' };
    touch(a);
    return { ok: true };
  }

  function promptBlock(a) {
    const l = a.lessons || [];
    if (!l.length) return [];
    return ['', '## Lessons from jobs that went wrong', ...l.map((x) => `- ${x.text}${x.ticketN ? ` (#${x.ticketN})` : ''}`),
      'Apply them. When a new lesson replaces an old one, send the new one; the oldest drops off after ' + MAX + '.'];
  }

  return { ask, add, approve, discuss, drop, remove, promptBlock, MAX };
}

module.exports = { install, MAX, MAX_CHARS };
