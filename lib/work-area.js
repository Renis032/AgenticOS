'use strict';
// The user's work area (their day job), configured only in the local roster.json (defaults.workArea), which git ignores.
// Code asks this module instead of naming the employer, its repo or its notes.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tilde = (p) => (p ? p.replace(os.homedir(), '~') : p);
const expand = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

function workArea(root) {
  let w = null;
  try { w = JSON.parse(fs.readFileSync(path.join(root || path.join(__dirname, '..'), 'roster.json'), 'utf8')).defaults.workArea || null; } catch {}
  const name = (w && w.name) || 'Work';
  const slug = ((w && w.slug) || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'work';
  return {
    configured: !!(w && w.name),
    name,
    slug,
    label: (w && w.label) || `${name} (day job)`,
    repo: w && w.repo ? expand(w.repo) : null,
    router: expand((w && w.router) || `~/.claude/departments/${slug}.md`),
    heading: (w && w.heading) || null,
    covers: (w && w.covers) || 'your work repository and its notes',
    tilde,
  };
}

module.exports = { workArea, tilde };
