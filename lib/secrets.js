'use strict';
// Finds things that look like credentials in text an agent is about to save (handoffs, skills, team notes, memory), so they are
// refused instead of landing in plain files and backups.
const PATTERNS = [
  ['an Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['an OpenAI or OpenRouter key', /\bsk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{32,}/],
  ['a GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ['an AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['a Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['a private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ['a JSON web token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['a password or secret value', /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["']?(?!\$\{|<|\*{3}|your|xxx|example|changeme)[^\s"'`]{8,}/i],
];

// Returns a reason string when the text looks like it holds a credential, or null.
function findSecret(text) {
  const s = String(text || '');
  for (const [what, re] of PATTERNS) if (re.test(s)) return what;
  return null;
}

const refusal = (what) => `Not saved: the text looks like it contains ${what}. Remove it (refer to where the secret is kept, e.g. "the key in ~/.config/…", never the value) and try again.`;

module.exports = { findSecret, refusal };
