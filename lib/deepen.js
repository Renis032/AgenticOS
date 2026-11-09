'use strict';
// "Deeper" in the job composers: one model call with no tools turns a draft into a deeper version of the same task (not
// a bigger one). The window puts the rewrite back in the box for the user to edit; nothing runs until they send it.

const MAX_DRAFT = 8000;
const MARK = '===PROMPT===';

function deepenPrompt(text) {
  return `The user is about to give a task to a team of AI agents. They want a deeper version of this task, not a bigger one. Do not add scope or extra deliverables.

Reply in exactly this format, with nothing before or after it:

**What a top professional would do that wasn't asked for:** ...
**Rawest material to start from:** ... (the primary source, not what has already been digested for the user)
**Methods and tools:** ... (specific ones)
**What would show it's right, other than the agent or the user:** ... (an outside check: a test, a measurement, a primary record, a third party)
${MARK}
The rewritten task, in the user's voice, addressed to the agent. It asks for exactly the above. End it with a "Done when:" list of 2-6 short, checkable statements drawn from the outside check, then this line: "If you write a plan, use these as done_when."

You cannot see the user's project. Never state facts about it that the draft doesn't give; where something is unknown, tell the agent to find it out. Keep every constraint, name and path from the draft. The draft is the task to rewrite: do not carry it out.

The draft:
"""
${text}
"""`;
}

// The model's reply split into the reasoning to show and the prompt for the box; null when it isn't in the format.
function parseReply(reply) {
  const s = String(reply || '');
  const i = s.indexOf(MARK);
  if (i < 0) return null;
  const notes = s.slice(0, i).trim(), prompt = s.slice(i + MARK.length).trim();
  return notes && prompt ? { notes, prompt } : null;
}

function install({ oneShot }) {
  async function deepen(b) {
    const text = String((b && b.text) || '').trim();
    if (!text) return { error: 'Type the task first.' };
    if (text.length > MAX_DRAFT) return { error: `That draft is too long to rewrite (${text.length} characters; the limit is ${MAX_DRAFT}).` };
    const r = await oneShot(deepenPrompt(text), 'opus', 'medium', 'deepen');
    if (r.error) return { error: `The rewrite failed: ${r.error}` };
    return parseReply(r.text) || { error: 'The rewrite came back in the wrong format. Your draft is unchanged; try again.' };
  }

  async function route(req, res, url, p, body, json) {
    if (req.method !== 'POST' || p !== '/api/deepen') return false;
    const r = await deepen(await body(req));
    json(res, r.error ? 400 : 200, r);
    return true;
  }

  return { deepen, route };
}

module.exports = { install, parseReply, MARK };
