'use strict';
// Suggested answers for a question an agent asks the user without giving choices: one-click buttons in the job, on
// Today and in Telegram. Exact and free, no model: the choices come from the question's own wording.
//   - a short list in the question ("1. Keep it", "- Remove it")           → those items
//   - "Which one: Postgres, MySQL or SQLite?"                             → Postgres · MySQL · SQLite
//   - a yes/no question ("Should I …?", "Do you want …?", "Is it OK …?")   → Yes · No
// Nothing is suggested when none of these fit; the user types the answer as before.

const MAX = 5;
const MAX_LEN = 60;

const tidy = (s) => s.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim().replace(/[.;,]$/, '');

function fromList(text) {
  const items = [];
  for (const l of text.split('\n')) {
    const m = l.match(/^\s*(?:\d{1,2}[.)]|[a-e][.)]|[-*•])\s+(.+)$/i);
    if (m) items.push(tidy(m[1].replace(/\s+[—–-]\s+.*$/, '').replace(/:\s.*$/, '')));
  }
  if (items.length < 2 || items.length > MAX || items.some((x) => !x || x.length > MAX_LEN)) return [];
  return items;
}

// The last sentence ending in "?".
function lastQuestion(text) {
  const m = text.replace(/\n+/g, ' ').match(/[^.?!]*\?(?=[^?]*$)/);
  return m ? m[0].trim() : '';
}

function fromOr(q) {
  const m = q.match(/[:—–]\s*([^:—–?]+?\sor\s[^?]+)\?$/);
  if (!m) return [];
  const parts = m[1].split(/,\s*(?:or\s+)?|\s+or\s+/).map(tidy).filter(Boolean);
  if (parts.length < 2 || parts.length > MAX || parts.some((x) => x.length > MAX_LEN || x.split(' ').length > 6)) return [];
  return parts.map((x) => x[0].toUpperCase() + x.slice(1));
}

const YES_NO = /^(?:so,?\s+|ok,?\s+|and\s+)?(?:should|shall|do|does|did|can|could|would|will|is|are|may|want me to|ok to|okay to)\b/i;
// "Can you send the log?" asks for something, not for a yes.
const REQUEST = /^(?:so,?\s+|ok,?\s+|and\s+)?(?:can|could|will|would) you\b(?!\s+(?:like|prefer|want|be ok))/i;

function suggest(text) {
  const s = String(text || '');
  if (!s.includes('?')) return [];
  const list = fromList(s);
  if (list.length) return list;
  const q = lastQuestion(s);
  const or = fromOr(q);
  if (or.length) return or;
  // "Should I keep X or Y?" without a colon is a choice in disguise; leave it to the user rather than offer Yes/No.
  if (YES_NO.test(q) && !REQUEST.test(q) && !/\sor\s/i.test(q)) return ['Yes', 'No'];
  return [];
}

module.exports = { suggest };
