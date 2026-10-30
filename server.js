#!/usr/bin/env node
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = __dirname;
const PORT = Number(process.env.WORKPLACE_PORT || 4747);
// A throwaway office started by a check (ui-check, api-check, agent-eval) shuts itself down once that check is gone,
// even when the check was killed before its own clean-up could run.
if (process.env.AGENTOS_TEST_PARENT) setInterval(() => { try { process.kill(Number(process.env.AGENTOS_TEST_PARENT), 0); } catch { process.kill(process.pid, 'SIGTERM'); } }, 3000).unref();
const MAX_RUNNING = Number(process.env.WORKPLACE_MAX_RUNNING || 8);
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const DATA = path.join(ROOT, 'data');
const EVENTS_DIR = path.join(DATA, 'events');
const EVENTS_IN_MEMORY = 1500;
const SNAP_DIR = path.join(DATA, 'snapshots');
const UPLOADS = path.join(DATA, 'uploads');
const HOST = '127.0.0.1';
const SCRIPTS = path.join(ROOT, 'scripts');
const { route: routeByRules } = require('./scripts/route');
const libraryCheck = require('./scripts/library-check');
const weeklyReport = require('./scripts/weekly-report');
const { choose: chooseModel } = require('./scripts/choose-model');
const usageIndex = require('./scripts/usage-index');
fs.mkdirSync(EVENTS_DIR, { recursive: true });

const home = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
// Whether a folder is inside the work repository (defaults.workArea.repo in the local roster), where staff get the edit preset without web access.
const inWorkRepo = (dir) => { const repo = require('./lib/work-area').workArea(ROOT).repo; return !!(repo && dir && home(dir).startsWith(path.dirname(repo))); };
// roster.json and projects.json are local (git ignores them; they may name the user's employer). A fresh clone starts from the examples.
for (const f of ['roster.json', 'projects.json']) {
  const ex = path.join(ROOT, f.replace('.json', '.example.json'));
  if (!fs.existsSync(path.join(ROOT, f)) && fs.existsSync(ex)) fs.copyFileSync(ex, path.join(ROOT, f));
}
// Team libraries (teams/) are local too; make sure each team's folder exists.
for (const def of Object.values(readJson('roster.json').roles)) if (def.team && def.team.docs) fs.mkdirSync(path.join(ROOT, def.team.docs), { recursive: true });
const now = () => Date.now();
// A live view of an object held in a variable that may be replaced (passed to lib/ modules): reads and writes reach whatever it holds now.
const live = (get) => new Proxy({}, {
  get: (_, k) => get()[k], set: (_, k, v) => { get()[k] = v; return true; }, has: (_, k) => k in get(), deleteProperty: (_, k) => delete get()[k],
  ownKeys: () => Reflect.ownKeys(get()), getOwnPropertyDescriptor: (_, k) => { const d = Object.getOwnPropertyDescriptor(get(), k); if (d) d.configurable = true; return d; },
});
const newId = () => crypto.randomBytes(4).toString('hex');
const ACTIVE = ['running', 'queued', 'delegating'];

// ---------------------------------------------------------------- state

const agents = new Map();
const tickets = new Map();
const procs = new Map();
const waiters = new Map();
const queue = [];
const mail = [];
const askWaiters = new Map();
const mailWake = new Map();
const batches = new Map();
const fileTouches = new Map();
const budgetWaiters = new Map();
const userAskWaiters = new Map();
const planWaiters = new Map();
const SERVER_STARTED = Date.now();
const MODELS = ['haiku', 'sonnet', 'opus'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const { quickEffort } = require('./lib/quick-effort');
let shuttingDown = false;

// ---------------------------------------------------------------- state on disk (lib/state.js)

const { assignPids, summary, loadState, saveNow, saveState, eventsOf, getTeamState, nextTicketN } = require('./lib/state').install({
  ACTIVE, DATA, EVENTS_DIR, EVENTS_IN_MEMORY, agents, fs, path, readJson, tickets,
});

// ---------------------------------------------------------------- plan usage limits (lib/limits.js)

const { LIMITS_FILE, limits, noteSpend, onRateLimit, checkHold, continuePastLimit, limitsView, probeLimits } = require('./lib/limits').install({
  DATA, fs, os, path, spawn, CLAUDE_BIN, now, readJson, agents,
  broadcast: (...a) => broadcast(...a), childEnv: (...a) => childEnv(...a), readLines: (...a) => readLines(...a),
  pump: () => pump(), pumpResident: (a) => pumpResident(a),
});

// ---------------------------------------------------------------- live stream to the office

const clients = new Set();
function broadcast(msg) {
  const line = 'data: ' + JSON.stringify(msg) + '\n\n';
  for (const res of clients) res.write(line);
}
function touch(a) {
  a.updatedAt = now();
  broadcast({ type: 'agent', agent: summary(a) });
  saveState();
}
function touchTicket(t) {
  t.updatedAt = now();
  broadcast({ type: 'ticket', ticket: t });
  saveState();
}
function addEvent(a, ev) {
  ev.t = now();
  const list = eventsOf(a);
  list.push(ev);
  if (list.length > EVENTS_IN_MEMORY * 1.2) list.splice(0, list.length - EVENTS_IN_MEMORY);
  fs.appendFileSync(path.join(EVENTS_DIR, a.id + '.jsonl'), JSON.stringify(ev) + '\n');
  broadcast({ type: 'event', agentId: a.id, event: ev });
}
function thread(t, entry) {
  entry.t = now();
  t.thread.push(entry);
  touchTicket(t);
}

// ---------------------------------------------------------------- roster, memory, prompts and the agent command line (lib/prompts.js)

const { expandTools, defOf, childRolesFor, MEMORY_DIR, readMemory, writeMemory, giveFeedback, pendingFeedback, standingLines, standingVersion, setStanding, teamOf, modelOf, promptSizes, buildArgs, claudeSkillsFor, childEnv } = require('./lib/prompts').install({
  DATA, PORT, ROOT, UPLOADS, addEvent, agents, fs, home, now, os, path, readJson, spawn, touch,
  canRunCommands: (...a) => canRunCommands(...a), commandMode: (...a) => commandMode(...a),
  handoffsOf: (...a) => handoffsOf(...a), savedHandoffs: (...a) => savedHandoffs(...a),
  lessons: live(() => lessons), skillProposals: live(() => skillProposals),
  ticketBudget: (...a) => ticketBudget(...a), ticketOfAgent: (...a) => ticketOfAgent(...a),
});
// ---------------------------------------------------------------- agent output streams, job costs and budgets (lib/agent-stream.js)

const { readLines, onStreamMessage, ticketBudget, waitForBudget, releaseBudget } = require('./lib/agent-stream').install({
  DATA, SCRIPTS, addEvent, broadcast, budgetWaiters, childRolesFor, fs, noteSpend, now, onRateLimit, path, readJson, spawn, thread, tickets, touch, touchTicket, usageIndex,
  officeNote: (...a) => officeNote(...a),
});
// ---------------------------------------------------------------- residents, the always-alive agents (lib/residents.js)

const { PERSONAS, baseAgent, startResident, enqueueResident, pumpResident, restartResident } = require('./lib/residents').install({
  CLAUDE_BIN, addEvent, agents, broadcast, buildArgs, childEnv, fs, home, limits, modelOf, now, onStreamMessage, path, pendingFeedback, procs, readJson, readLines, spawn, standingLines, standingVersion, thread, tickets, touch, touchTicket,
  isShuttingDown: () => shuttingDown, arms: live(() => arms), lessons: live(() => lessons), verify: live(() => verify), closeTicket: (...a) => closeTicket(...a), recovery: live(() => recovery),
  handoffBrief: (...a) => handoffBrief(...a), handoffsOf: (...a) => handoffsOf(...a), projectsMentioned: (...a) => projectsMentioned(...a),
  isRestartPending: (...a) => isRestartPending(...a), maybeRefresh: (...a) => maybeRefresh(...a), maybeTidy: (...a) => maybeTidy(...a),
});
// ---------------------------------------------------------------- tickets (lib/tickets.js)

const { newTicket, stopTicket, cleanAttachments, attachText, saveUpload, rawBody, createTicket, dispatchTicket, runSchedule, askUser, answerUser, followUp, recallFollowup, rateTicket, searchTickets, searchText, pauseTicket, resumeTicket } = require('./lib/tickets').install({
  ACTIVE, EFFORTS, UPLOADS, addEvent, agents, broadcast, checkHold, enqueueResident, fs, giveFeedback, limits, newId, nextTicketN, now, path, planWaiters,
  probeLimits, pumpResident, quickEffort, readJson, releaseBudget, restartResident, routeByRules, thread, ticketBudget, tickets, touch, touchTicket, userAskWaiters,
  endAccess: (...a) => endAccess(...a), endCommands: (...a) => endCommands(...a), lessons: live(() => lessons),
  maybeWeeklyReviews: (...a) => maybeWeeklyReviews(...a), stopTree: (...a) => stopTree(...a), ticketOfAgent: (...a) => ticketOfAgent(...a),
  verify: live(() => verify), workspaces: live(() => workspaces), briefExtras: (...a) => briefExtras(...a),
});
// ---------------------------------------------------------------- staff: sub-agents and delegation (lib/staff.js)

const { pump, staffList, ticketOfAgent, enqueue, stopTree, delegate, waitForTeam, assign } = require('./lib/staff').install({
  ACTIVE, CLAUDE_BIN, EFFORTS, MAX_RUNNING, MODELS, PERSONAS, addEvent, agents, assignPids, attachText, baseAgent, batches, broadcast, buildArgs, childEnv,
  childRolesFor, chooseModel, crypto, enqueueResident, home, inWorkRepo, limits, mail, mailWake, modelOf, newId, now, onStreamMessage, pendingFeedback, procs,
  queue, readJson, readLines, readMemory, restartResident, spawn, thread, tickets, touch, waitForBudget, waiters,
  arms: live(() => arms), onCall: live(() => onCall), isRestartPending: (...a) => isRestartPending(...a), planGate: (...a) => planGate(...a),
  takeUnread: (...a) => takeUnread(...a), briefExtras: (...a) => briefExtras(...a),
});
// ---------------------------------------------------------------- terminal commands (lib/commands.js)

const { commandMode, canRunCommands, blockedCommand, runCommand, decideCommand, stopCommand, endCommands, running: commandsRunning } = require('./lib/commands').install({
  agents, tickets, readJson, home, now, newId, broadcast, addEvent,
  touch: (a) => touch(a), touchTicket: (t) => touchTicket(t), thread: (t, e) => thread(t, e), ticketOfAgent: (a) => ticketOfAgent(a),
  defOf: (r, a) => defOf(r, a), expandTools: (r, p) => expandTools(r, p),
});

// ---------------------------------------------------------------- tickets: code changes and undo (lib/changes.js)

const { changesOf, revertChanges, snapshotBefore } = require('./lib/changes').install({
  DATA,
  SNAP_DIR,
  agents,
  crypto,
  fs,
  now,
  path,
  spawnSync,
  thread: (...a) => thread(...a),
  ticketOfAgent: (...a) => ticketOfAgent(...a),
  touchTicket: (...a) => touchTicket(...a)
});

// ---------------------------------------------------------------- tickets: timeline, spend (lib/timeline.js)

const { spendStats, timelineOf } = require('./lib/timeline').install({
  EVENTS_DIR,
  agents,
  eventsOf: (...a) => eventsOf(...a),
  fs,
  now,
  path
});

// ---------------------------------------------------------------- app-only access (lib/access.js)

const { guard } = require('./lib/access').install({
  DATA, PORT, crypto, fs, path,
});
// ---------------------------------------------------------------- plans for big tickets (lib/plans.js)

const { decidePlan, proposePlan, planGate } = require('./lib/plans').install({
  addEvent: (...a) => addEvent(...a),
  agents,
  broadcast: (...a) => broadcast(...a),
  limits: live(() => limits),
  newId,
  now,
  planWaiters,
  readJson,
  releaseBudget: (...a) => releaseBudget(...a),
  thread: (...a) => thread(...a),
  ticketBudget: (...a) => ticketBudget(...a),
  ticketOfAgent: (...a) => ticketOfAgent(...a),
  touch: (...a) => touch(...a)
});

// ---------------------------------------------------------------- fresh sessions for leads (lib/fresh-sessions.js)

const { maybeRefresh, restartWhenIdle, needsRefresh } = require('./lib/fresh-sessions').install({
  agents,
  now,
  readJson,
  restartResident: (...a) => restartResident(...a),
  touch: (...a) => touch(...a)
});

// ---------------------------------------------------------------- weekly review (lib/weekly-review.js)

const { runReview, maybeWeeklyReviews } = require('./lib/weekly-review').install({
  agents,
  enqueueResident: (...a) => enqueueResident(...a),
  newTicket: (...a) => newTicket(...a),
  now,
  readJson,
  saveState: (...a) => saveState(...a),
  teamState: live(() => getTeamState()),
  thread: (...a) => thread(...a),
  tickets,
  touchTicket: (...a) => touchTicket(...a),
  usageIndex,
  weeklyReport
});

// ---------------------------------------------------------------- teams and roles from the UI (lib/teams-config.js)

const { configView, createTeam, deleteRole, saveRole, writeRoster } = require('./lib/teams-config').install({
  EFFORTS,
  MODELS,
  ROOT,
  agents,
  broadcast: (...a) => broadcast(...a),
  fs,
  home,
  inWorkRepo,
  path,
  readJson,
  restartWhenIdle: (...a) => restartWhenIdle(...a),
  startResident: (...a) => startResident(...a)
});

// ---------------------------------------------------------------- team chat (meeting room) (lib/team-chat.js)

const { askTeam, teamChat } = require('./lib/team-chat').install({
  agents,
  ask: (...a) => ask(...a),
  enqueueResident: (...a) => enqueueResident(...a),
  eventsOf: (...a) => eventsOf(...a),
  newTicket: (...a) => newTicket(...a),
  readJson,
  thread: (...a) => thread(...a),
  tickets,
  touchTicket: (...a) => touchTicket(...a)
});

// ---------------------------------------------------------------- health (lib/health.js)

const { healthView } = require('./lib/health').install({
  CLAUDE_BIN, DATA, HOST, SERVER_STARTED, agents, eventsOf, fs, limits, needsRefresh, now, os, path, procs, readJson, spawnSync,
  selftestNow: (...a) => selftestNow(...a),
});
// ---------------------------------------------------------------- self-test (lib/selftest.js)

const { runSelfTest, selftestNow } = require('./lib/selftest').install({
  DATA,
  agents,
  answerUser: (...a) => answerUser(...a),
  broadcast: (...a) => broadcast(...a),
  changesOf,
  createTicket: (...a) => createTicket(...a),
  decidePlan,
  eventsOf: (...a) => eventsOf(...a),
  fs,
  limits: live(() => limits),
  now,
  os,
  path,
  readJson,
  revertChanges,
  stopTicket: (...a) => stopTicket(...a),
  touchTicket: (...a) => touchTicket(...a)
});

// ---------------------------------------------------------------- office scripts (lib/office-scripts.js)

const { runScript, scriptManifest } = require('./lib/office-scripts').install({
  SCRIPTS,
  teamScriptsDir: (a) => { const t = teamOf(readJson('roster.json'), a); return t ? path.join(t.dir, 'scripts') : null; },
  addEvent: (...a) => addEvent(...a),
  agents,
  fs,
  home,
  os,
  path,
  spawn
});

// ---------------------------------------------------------------- talking between agents (lib/mail.js)

const { ask, colleagues, sendMail, takeUnread, officeNote } = require('./lib/mail').install({
  ACTIVE,
  addEvent: (...a) => addEvent(...a),
  agents,
  askWaiters,
  broadcast: (...a) => broadcast(...a),
  enqueueResident: (...a) => enqueueResident(...a),
  filesOf: (...a) => filesOf(...a),
  mail,
  mailWake,
  newId,
  now,
  procs,
  thread: (...a) => thread(...a),
  ticketOfAgent: (...a) => ticketOfAgent(...a),
  tickets
});

// ---------------------------------------------------------------- shared files (lib/shared-files.js)

const { filesOf, touchFile } = require('./lib/shared-files').install({
  ACTIVE,
  agents,
  fileTouches,
  now,
  path,
  sendMail
,
  ticketOfAgent: (...a) => ticketOfAgent(...a)
});

// ---------------------------------------------------------------- team libraries (lib/libraries.js)

const { addToDocs, libraryRoots, maybeTidy, refreshLibraryIndex, teamsList } = require('./lib/libraries').install({
  ROOT,
  addEvent: (...a) => addEvent(...a),
  agents,
  broadcast: (...a) => broadcast(...a),
  enqueueResident: (...a) => enqueueResident(...a),
  fs,
  home,
  libraryCheck,
  now,
  path,
  procs,
  readJson,
  saveState: (...a) => saveState(...a),
  teamOf: (...a) => teamOf(...a),
  teamState: live(() => getTeamState()),
  ticketOfAgent: (...a) => ticketOfAgent(...a)
});

// ---------------------------------------------------------------- personal projects: handoffs, board, opening files (lib/projects.js)

const { handoffsOf, savedHandoffs, projectsMentioned, handoffBrief, projectsBoard, openFile, saveHandoff, projectFolders } = require('./lib/projects').install({
  ROOT, agents, tickets, readJson, home, broadcast, addEvent, thread: (t, e) => thread(t, e), ticketOfAgent: (a) => ticketOfAgent(a),
});

// ---------------------------------------------------------------- skills agents propose (lib/skills.js)

const skillProposals = require('./lib/skills').install({
  ROOT, DATA, agents, now, newId, broadcast, addEvent, readJson,
  teamOf: (r, a) => teamOf(r, a), giveFeedback: (f, t, x) => giveFeedback(f, t, x), ticketOfAgent: (a) => ticketOfAgent(a),
});

// ---------------------------------------------------------------- the brain: knowledge graph, decision flow, optimizer (lib/brain.js)

// ---------------------------------------------------------------- lessons from jobs that went wrong (lib/lessons.js)

const lessons = require('./lib/lessons').install({
  agents, readJson, now, newId, findSecret: require('./lib/secrets').findSecret,
  touch: (...a) => touch(...a), addEvent: (...a) => addEvent(...a), giveFeedback: (...a) => giveFeedback(...a),
  broadcast: (...a) => broadcast(...a), oneShot: (...a) => askOffice.oneShot(...a),
});

const onCall = require('./lib/on-call').install({ agents, tickets, now, DATA, touch: (...a) => touch(...a) });

const brain = require('./lib/brain').install({
  ROOT, DATA, agents, tickets, readJson, home, now, broadcast,
  teamOf: (...a) => teamOf(...a), handoffsOf: (...a) => handoffsOf(...a), projectFolders: (...a) => projectFolders(...a),
  claudeSkillsFor: (...a) => claudeSkillsFor(...a), eventsOf: (...a) => eventsOf(...a), giveFeedback: (...a) => giveFeedback(...a), maybeTidy: (...a) => maybeTidy(...a),
});

// ---------------------------------------------------------------- ARMS (skills, routines, memory, apps)

const arms = require('./lib/arms').install({
  ROOT, DATA, PORT, CLAUDE_BIN, agents, tickets, readJson, broadcast, touchTicket, childEnv, eventsOf,
  limits: () => limits, createTicket: (b) => createTicket(b), giveFeedback: (from, to, text) => giveFeedback(from, to, text),
  notify: (kind, title, text, ticketId) => broadcast({ type: 'notify', kind, title, text, ticketId }),
});

// ---------------------------------------------------------------- HTTP

function body(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}
function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (!guard(req, res, url)) return;
  try {
    if (await arms.route(req, res, url, p, body, json)) return;
    if (await skillProposals.route(req, res, url, p, body, json)) return;
    if (await brain.route(req, res, url, p, body, json)) return;
    if (await backups.route(req, res, p, body, json)) return;
    if (await evals.route(req, res, p, body, json)) return;
    if (await telegram.route(req, res, url, p, body, json)) return;
    if (await askOffice.route(req, res, url, p, body, json)) return;
    if (await leadWizard.route(req, res, url, p, body, json)) return;
    if (await projectMemory.route(req, res, url, p, body, json)) return;
    if (await workspaces.route(req, res, url, p, body, json)) return;
    if (await recovery.route(req, res, url, p, body, json)) return;
    if (req.method === 'GET' && p === '/api/outcomes') return json(res, 200, outcomes.report(Math.max(1, Math.min(365, Number(url.searchParams.get('days')) || 30))));
    for (const r of routeModules) if (await r.route(req, res, url, p, body, json)) return;
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});
server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;

// A restore chosen in Preferences is applied before anything is loaded (lib/backups.js).
try { require('./lib/backups').applyPendingRestore(ROOT, DATA); } catch (e) { console.error(`Restore failed: ${e.message}`); }
loadState();
if (onCall.migrate()) saveState();
onCall.tidy();
setInterval(() => onCall.tidy(), 3600000).unref();
assignPids();
for (const t of tickets.values()) {
  if (t.costUsd != null) continue;
  let usd = 0;
  for (const a of agents.values()) {
    if (!a.resident && a.ticketId === t.id) usd += a.costUsd || 0;
    if (a.resident) for (const e of eventsOf(a)) if (e.kind === 'result' && e.ticketId === t.id) usd += e.costUsd || 0;
  }
  t.costUsd = usd;
  t.budgetUsd = t.budgetUsd || ticketBudget();
}
fs.mkdirSync(UPLOADS, { recursive: true });
for (const def of Object.values(readJson('roster.json').roles)) if (def.team && def.team.docs && fs.existsSync(path.join(ROOT, def.team.docs))) refreshLibraryIndex(path.join(ROOT, def.team.docs));
for (const t of tickets.values()) { t.waiting = null; if (t.plan && t.plan.status === 'pending') t.plan.status = 'interrupted'; if (ticketBudget() == null) { t.budgetUsd = null; t.overBudget = false; } }
if (selftestNow() && selftestNow().status === 'running') selftestNow().status = 'interrupted';
setInterval(runSchedule, 20000);
setInterval(() => arms.schedule(), 60000);
const longChatWarned = new Map();
setInterval(async () => {
  try {
    for (const c of await usageIndex.liveChats(300000)) {
      const step = c.tokens >= 800000 ? 800000 : c.tokens >= 500000 ? 500000 : 300000;
      if ((longChatWarned.get(c.sid) || 0) >= step) continue;
      longChatWarned.set(c.sid, step);
      broadcast({ type: 'notify', kind: 'warn', title: `Long chat: ${Math.round(c.tokens / 1000)}k tokens per message`,
        text: `“${c.label}” (${c.project}) re-sends ${Math.round(c.tokens / 1000)}k tokens with every message (about ${c.perCallUsd.toFixed(2)} each at API prices). When this task is done, start a new chat (/clear) or run /compact.` });
    }
  } catch {}
}, 300000);
setTimeout(() => arms.schedule(), 15000);
server.listen(PORT, HOST, () => {
  // Jobs that were running when the office stopped are interrupted, to be resumed (lib/recovery.js).
  for (const t of tickets.values()) {
    if (t.status === 'open') {
      const stillQueued = [...agents.values()].some((a) => a.resident && a.inbox.some((i) => i.ticketId === t.id));
      if (!stillQueued) recovery.markInterrupted(t, 'the office restarted while it was running');
    }
    if (t.verify && t.verify.status === 'running') t.verify.status = 'failed';
    if (t.reviewer && t.reviewer.status === 'running') t.reviewer.status = 'skipped';
  }
  console.log(`Agentic OS running at http://127.0.0.1:${PORT}`);
  for (const key of readJson('roster.json').residents) startResident(key);
  if (!limits.updatedAt || now() - limits.updatedAt > 600000) probeLimits();
});
// ---------------------------------------------------------------- where agents may edit (lib/edit-scope.js)

const { denyEdit, requestAccess, decideAccess, endAccess } = require('./lib/edit-scope').install({
  workspaces: live(() => workspaces), agents, readJson, home, now, newId, broadcast, addEvent,
  touch: (...a) => touch(...a), touchTicket: (...a) => touchTicket(...a), thread: (...a) => thread(...a), ticketOfAgent: (...a) => ticketOfAgent(...a),
  teamOf: (...a) => teamOf(...a), handoffsOf: (...a) => handoffsOf(...a), projectsMentioned: (...a) => projectsMentioned(...a),
});

// ---------------------------------------------------------------- upkeep: reminders, restart when idle, office settings (lib/upkeep.js)

const { restartView, requestRestart, OFFICE_SETTINGS, isRestartPending } = require('./lib/upkeep').install({
  ROOT, agents, tickets, readJson, now, broadcast, ACTIVE, commandsRunning,
  pumpResident: (a) => pumpResident(a), pump: () => pump(), isShuttingDown: () => shuttingDown, shutdown: () => shutdown(),
});

const backups = require('./lib/backups').install({ ROOT, readJson, saveNow: () => saveNow(), requestRestart: (...a) => requestRestart(...a), broadcast });
setTimeout(() => backups.maybeDaily(), 60000).unref();

// The agent eval on a schedule, kept over time for the Health app (lib/evals.js).
const evals = require('./lib/evals').install({
  ROOT, DATA, readJson, now, broadcast,
  isIdle: () => ![...tickets.values()].some((t) => t.status === 'open') && ![...agents.values()].some((a) => ACTIVE.includes(a.status) || (a.resident && (a.current || a.inbox.length))),
  // Not near a limit: no hold, and the 5-hour and weekly windows below half.
  canSpend: () => !limits.hold && Object.entries(limits.windows).every(([, w]) => !w.resetsAt || w.resetsAt < now() || w.utilization < 0.5),
});
setInterval(() => evals.maybeScheduled(), 5 * 60000).unref();

// Plans, questions, commands and edit requests in a linked Telegram chat, with buttons; jobs, processes and usage from the chat (lib/telegram.js).
const telegram = require('./lib/telegram').install({ DATA, ACTIVE, agents, tickets, now, readJson, thread, limitsView, decidePlan, decideCommand,
  answerUser, decideAccess, createTicket, dispatchTicket, followUp, pauseTicket, resumeTicket, stopTicket, rateTicket });
// Questions about the office answered on Haiku from facts gathered without a model (lib/ask-office.js).
const askOffice = require('./lib/ask-office').install({ CLAUDE_BIN, MEMORY_DIR, agents, childEnv, fs, noteSpend, now, path,
  projectMemory: live(() => projectMemory), readJson, searchTickets, spawn, teamsList: (...a) => teamsList(...a), tickets });
// ---------------------------------------------------------------- checks before done (lib/verify.js)

// The folder a job works in: its isolated workspace, else its project's folder, else home.
function workdirOf(t) {
  if (t.workspace && t.workspace.path && fs.existsSync(t.workspace.path)) return t.workspace.path;
  const p = t.project && readJson('projects.json').find((x) => x.name === t.project);
  return home(p ? p.path : '~');
}
// Ends a job as done or failed. A job closed as done whose last run of some command failed (and that had no checks of
// its own to settle it) says so in the thread, so "done" is never just the agent's word.
function closeTicket(t, failed) {
  t.status = failed ? 'failed' : 'done';
  t.closedAt = now();
  const ev = verify.evidence(t);
  t.evidence = { commands: ev.commands.length, failing: ev.failing.map((c) => ({ command: c.command, exitCode: c.exitCode })) };
  if (!failed && !t.verify && ev.failing.length) {
    thread(t, { from: 'system', kind: 'system', text: `Heads-up: the last run of ${ev.failing.map((c) => `\`${c.command.slice(0, 80)}\` (exit ${c.exitCode})`).join(', ')} on this job failed, and nothing re-ran it after.` });
  }
  projectMemory.recordOutcome(t);
  touchTicket(t);
}
// Extra lines for a lead's brief on a new job: its checks, what the project remembers, and its workspace.
function briefExtras(t) {
  return verify.briefLine(t) + projectMemory.briefFor(t) + workspaces.briefFor(t);
}
// What the office remembers per project, retrieved per job (lib/project-memory.js).
const projectMemory = require('./lib/project-memory').install({ DATA, agents, findSecret: require('./lib/secrets').findSecret, fs, newId, now, path, readJson, ticketOfAgent });
// Jobs on the same git project work in their own worktrees (lib/workspaces.js).
const workspaces = require('./lib/workspaces').install({ DATA, fs, home, now, path, readJson, thread, tickets, touchTicket });
// Interrupted jobs and stuck agents (lib/recovery.js).
const recovery = require('./lib/recovery').install({ ACTIVE, agents, broadcast, enqueueResident, eventsOf, now, readJson, restartResident, thread, tickets, touchTicket });
setInterval(() => { try { recovery.watchdog(); } catch {} }, 60000).unref();
// What it costs to get a job done well (lib/outcomes.js).
const outcomes = require('./lib/outcomes').install({ agents, now, readJson, tickets });
const verify = require('./lib/verify').install({ blockedCommand, broadcast, changesOf, closeTicket, enqueueResident, lessons, now, oneShot: askOffice.oneShot, readJson, spawn, thread, touchTicket, workdirOf });

// The new-lead wizard: a lead drafted from the user's own words (lib/lead-wizard.js).
const leadWizard = require('./lib/lead-wizard').install({ fs, home, oneShot: askOffice.oneShot, readJson });
setInterval(() => backups.maybeDaily(), 3600000).unref();

const shutdown = () => {
  shuttingDown = true;
  telegram.stop();
  for (const p of procs.values()) { try { process.kill(-p.pid, 'SIGTERM'); } catch {} }
  saveNow();
  try { fs.writeFileSync(LIMITS_FILE, JSON.stringify(limits)); } catch {}
  setTimeout(() => process.exit(0), 400);
};
// ---------------------------------------------------------------- HTTP routes (lib/routes-*.js), asked in turn by the server above

const routeModules = [
  require('./lib/routes-tickets').install({
    UPLOADS, agents, askUser, broadcast, changesOf, cleanAttachments, createTicket, decidePlan, dispatchTicket, followUp, fs, lessons,
    path, pauseTicket, proposePlan, rateTicket, rawBody, readJson, recallFollowup, releaseBudget, resumeTicket, revertChanges, saveState,
    saveUpload, searchText, searchTickets, stopTicket, thread, ticketBudget, tickets, timelineOf, touch, touchTicket,
  }),
  require('./lib/routes-agents').install({
    ACTIVE, MEMORY_DIR, addEvent, addToDocs, agents, ask, assign, colleagues, decideAccess, decideCommand, delegate, denyEdit, enqueue,
    enqueueResident, eventsOf, fs, giveFeedback, lessons, maybeRefresh, newTicket, onCall, path, pumpResident, readMemory, requestAccess,
    restartResident, runCommand, runReview, saveHandoff, sendMail, setStanding, snapshotBefore, staffList, stopCommand, stopTree, takeUnread, thread,
    ticketOfAgent, tickets, touch, touchFile, touchTicket, waitForTeam, writeMemory,
  }),
  require('./lib/routes-office').install({
    OFFICE_SETTINGS, ROOT, addEvent, agents, askTeam, broadcast, canRunCommands, clients, commandMode, configView, continuePastLimit,
    createTeam, deleteRole, fs, healthView, libraryCheck, libraryRoots, limitsView, maybeTidy, openFile, os, path, probeLimits,
    projectsBoard, promptSizes, readJson, requestRestart, restartView, restartWhenIdle, runScript, runSelfTest, saveRole, scriptManifest,
    selftestNow, shutdown, spendStats, summary, teamChat, teamState: live(() => getTeamState()), teamsList, tickets, usageIndex, writeRoster,
  }),
];

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
