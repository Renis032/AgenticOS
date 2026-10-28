'use strict';
// Stopping an agent stops everything it started. Each claude process leads its own process group (spawned detached),
// so its Bash commands, builds and test runners are in that group too. SIGTERM goes to the whole group first; whatever
// is still alive a few seconds later (a runner ignoring SIGTERM, a grandchild left behind after the agent exited) gets
// SIGKILL. The group is signalled even after the agent itself has exited, because its children may outlive it.

function killGroup(p, graceMs = 5000) {
  if (!p || !p.pid) return;
  try { process.kill(-p.pid, 'SIGTERM'); } catch { try { p.kill('SIGTERM'); } catch {} }
  setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL'); } catch {} }, graceMs).unref();
}

module.exports = { killGroup };
