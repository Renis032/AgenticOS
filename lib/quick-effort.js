'use strict';
// Quick questions get a lower lead effort, so short answers come back faster. Only used when nobody chose an effort
// (not the user, not the project, not God). A follow-up that asks for real work puts the ticket back on the default.

const QUICK_EFFORT = 'medium';
const MAX_CHARS = 280;

const QUESTION = /\?\s*$|^((and|so|ok|okay)[, ]+)?(what|where|which|who|when|is|are|does|do|did|can|could|should|how (much|many|long|do i|can i|to))\b/i;
// Word stems, so "implementing" or "fixes" count too.
const WORK = /\b(implement|build|creat|add|writ|fix|debug|refactor|design|review|migrat|deploy|set ?up|install|continu|plan|investigat|analy[sz]|compar|research|why|error|bug|crash|broken|fail|chang|updat|mak|rewrit|optimi[sz]|test|recommend|suggest|improv)/i;

// Returns the effort for a quick question, or null when the text looks like real work.
function quickEffort(text, attachments) {
  const s = String(text || '').trim();
  if (!s || s.length > MAX_CHARS || (attachments && attachments.length)) return null;
  if (s.includes('```') || s.split('\n').length > 3) return null;
  if (!QUESTION.test(s) || WORK.test(s)) return null;
  return QUICK_EFFORT;
}

module.exports = { quickEffort, QUICK_EFFORT };
