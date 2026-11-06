'use strict';
// Where the office lives for the desktop app, and keeping its code up to date.
// From a git checkout (npm start in desktop/) the office is the checkout itself. An installed app is read-only, so the
// office code is copied to the user's app-data folder and refreshed whenever the app's version changes; the user's own
// files there (data/, teams/, roster.json, projects.json) are never touched.
const fs = require('fs');
const path = require('path');

// The office's code: replaced on update. Everything else in the folder belongs to the user.
const CODE = ['server.js', 'agentos', 'package.json', 'LICENSE', 'README.md', 'roster.example.json', 'projects.example.json', 'lib', 'public', 'scripts', 'app', 'docs'];

function officeRoot({ packaged, userData, checkout }) {
  return packaged ? path.join(userData, 'office') : checkout;
}

// Copies the bundled office code into root when it is missing or from another version. Returns what it did.
function syncOffice(bundle, root, version) {
  const stamp = path.join(root, 'data', 'desktop-version');
  let had = null;
  try { had = fs.readFileSync(stamp, 'utf8').trim(); } catch {}
  if (had === version && fs.existsSync(path.join(root, 'server.js'))) return 'current';
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  for (const name of CODE) {
    const from = path.join(bundle, name), to = path.join(root, name);
    if (!fs.existsSync(from)) continue;
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true });
  }
  try { fs.chmodSync(path.join(root, 'agentos'), 0o755); } catch {}
  try { fs.chmodSync(path.join(root, 'lib', 'stop.sh'), 0o755); } catch {}
  fs.writeFileSync(stamp, version);
  return had ? 'updated' : 'installed';
}

module.exports = { CODE, officeRoot, syncOffice };
