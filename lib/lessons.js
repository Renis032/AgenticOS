'use strict';
// Lessons from jobs that went wrong. When a job fails, is rated 👎, needs rework (a follow-up within 2 hours) or has its
// changes undone, each lead on it is asked once to write ONE line with `add_lesson`: what to do differently next time.
// Lessons sit apart from the free-form memory, so they stay short: at most MAX per agent (the oldest drops off), one line
// each. They are shown in every new session's prompt and in the Memory app, where the user can remove one.
//
// a.lessons = [{ id, t, ticketN, why, text }]

const MAX = 8;
const MAX_CHARS = 220;
const WHY = {
  failed: 'it ended as failed',
  rated: 'the user rated the answer 👎',
  rework: 'the user had to follow up within 2 hours (the answer was not what they needed)',
  undone: 'the user undid its file changes',
};

function install(ctx) {
  const { agents, readJson, now, newId, touch, addEvent, giveFeedback, findSecret } = ctx;
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
        'Work out what you would do differently, then call `add_lesson` with ONE line (under 200 characters) you can apply to similar jobs. ' +
        'Skip it only if nothing in your approach was at fault.');
    }
    return to;
  }

  function add(agentId, text, ticketN) {
    const a = agents.get(agentId);
    if (!a) return { error: 'Unknown agent.' };
    const line = String(text || '').replace(/\s+/g, ' ').trim();
    if (!line) return { error: 'Empty lesson.' };
    if (line.length > MAX_CHARS) return { error: `Too long (${line.length} characters): one line under ${MAX_CHARS}, please.` };
    const secret = findSecret(line);
    if (secret) return { error: 'That looks like it contains a secret; leave it out.' };
    a.lessons = (a.lessons || []).filter((l) => norm(l.text) !== norm(line));
    a.lessons.push({ id: newId(), t: now(), ticketN: ticketN || null, text: line });
    const dropped = a.lessons.length > MAX ? a.lessons.splice(0, a.lessons.length - MAX) : [];
    addEvent(a, { kind: 'lesson', text: line });
    touch(a);
    return { message: `Lesson saved (${a.lessons.length} of ${MAX})${dropped.length ? `; the oldest ("${dropped[0].text.slice(0, 60)}…") dropped off` : ''}.` };
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

  return { ask, add, remove, promptBlock, MAX };
}

module.exports = { install, MAX, MAX_CHARS };
