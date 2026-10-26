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
let teamState = {};
let ticketSeq = 0;
let shuttingDown = false;

function assignPids() {
  const roster = readJson('roster.json');
  roster.residents.forEach((k, i) => { const a = agents.get(k); if (a) a.no = i + 1; });
  let next = Math.max(99, ...[...agents.values()].filter((a) => !a.resident && a.no).map((a) => a.no)) + 1;
  for (const a of [...agents.values()].filter((x) => !x.resident && !x.no).sort((x, y) => (x.hiredAt || x.createdAt) - (y.hiredAt || y.createdAt))) a.no = next++;
}

function summary(a) {
  const { events, ...rest } = a;
  return rest;
}

function loadState() {
  try {
    for (const a of JSON.parse(fs.readFileSync(path.join(DATA, 'agents.json'), 'utf8'))) {
      if (!a.resident) {
        if (!a.homeId) continue;
        if (!a.staff) {
          const outcome = a.status === 'done' ? 'done' : ACTIVE.includes(a.status) ? 'interrupted' : a.status;
          Object.assign(a, { staff: true, tickets: a.ticketId ? [a.ticketId] : [], feedback: [], lastOutcome: outcome,
            tasksDone: outcome === 'done' ? 1 : 0, tasksFailed: outcome === 'done' ? 0 : 1, hiredAt: a.createdAt,
            history: a.ticketId ? [{ ticketId: a.ticketId, n: a.ticketN, title: a.title, outcome, costUsd: a.costUsd, model: a.model ? `${a.model}/${a.effort}` : null, t: a.endedAt || a.updatedAt }] : [] });
        } else if (ACTIVE.includes(a.status)) {
          a.lastOutcome = 'interrupted';
        }
        a.status = 'idle';
      }
      if (a.resident) {
        a.status = 'offline';
        if (a.current) { a.inbox.unshift({ ...a.current, text: '(Re-sent after a workplace restart; you may have already started on this.)\n' + a.current.text }); a.current = null; }
      }
      a.events = null;
      agents.set(a.id, a);
    }
  } catch { /* first run */ }
  try { teamState = JSON.parse(fs.readFileSync(path.join(DATA, 'teams.json'), 'utf8')); } catch { teamState = {}; }
  try {
    const t = JSON.parse(fs.readFileSync(path.join(DATA, 'tickets.json'), 'utf8'));
    ticketSeq = t.seq || 0;
    for (const k of t.tickets) tickets.set(k.id, k);
  } catch { /* first run */ }
}

let saveTimer = null;
function saveNow() {
  clearTimeout(saveTimer);
  fs.writeFileSync(path.join(DATA, 'agents.json'), JSON.stringify([...agents.values()].map(summary), null, 1));
  fs.writeFileSync(path.join(DATA, 'tickets.json'), JSON.stringify({ seq: ticketSeq, tickets: [...tickets.values()] }, null, 1));
  fs.writeFileSync(path.join(DATA, 'teams.json'), JSON.stringify(teamState, null, 1));
}
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}

function eventsOf(a) {
  if (!a.events) {
    try {
      a.events = fs.readFileSync(path.join(EVENTS_DIR, a.id + '.jsonl'), 'utf8')
        .split('\n').filter(Boolean).slice(-EVENTS_IN_MEMORY).map((l) => JSON.parse(l));
    } catch { a.events = []; }
  }
  return a.events;
}

// ---------------------------------------------------------------- plan usage limits

const LIMITS_FILE = path.join(DATA, 'limits.json');
let limits = { windows: {}, status: null, samples: [], spend: 0, tokens: 0, updatedAt: null };
try { limits = { ...limits, ...JSON.parse(fs.readFileSync(LIMITS_FILE, 'utf8')) }; } catch {}
try { limits.plan = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8')).claudeAiOauth.subscriptionType || null; } catch { limits.plan = null; }
let limitsTimer = null;
let probing = null;

function saveLimits() {
  clearTimeout(limitsTimer);
  limitsTimer = setTimeout(() => { try { fs.writeFileSync(LIMITS_FILE, JSON.stringify(limits)); } catch {} }, 500);
}

function noteSpend(usd, usage) {
  const u = usage || {};
  limits.spend += usd || 0;
  limits.tokens += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
  saveLimits();
}

function onRateLimit(info) {
  if (!info) return;
  const w = { ...(info.unifiedWindows || {}) };
  if (!Object.keys(w).length && info.rateLimitType && info.utilization != null) w[info.rateLimitType] = { utilization: info.utilization, resetsAt: info.resetsAt };
  for (const [k, v] of Object.entries(w)) {
    if (v && v.utilization != null) limits.windows[k] = { utilization: v.utilization, resetsAt: v.resetsAt ? v.resetsAt * 1000 : null };
  }
  limits.status = info.status || null;
  limits.limitedBy = info.rateLimitType || null;
  limits.usingOverage = !!info.isUsingOverage;
  limits.updatedAt = now();
  limits.samples.push({ t: now(), spend: limits.spend, tokens: limits.tokens,
    w: Object.fromEntries(Object.entries(limits.windows).map(([k, v]) => [k, [v.utilization, v.resetsAt]])) });
  if (limits.samples.length > 3000) limits.samples = limits.samples.slice(-2000);
  checkHold();
  saveLimits();
  broadcast({ type: 'limits', limits: limitsView() });
}

function windowEstimate(k) {
  const cur = limits.windows[k];
  let du = 0, ds = 0, dt = 0, prev = null;
  for (const sm of limits.samples) {
    const v = sm.w[k];
    if (!v) { prev = null; continue; }
    if (prev && prev.v[1] === v[1] && sm.t - prev.t <= 900000) {
      const u = v[0] - prev.v[0], sp = sm.spend - prev.spend;
      if (u >= 0 && sp > 0.02) { du += u; ds += sp; dt += sm.tokens - prev.tokens; }
    }
    prev = { v, t: sm.t, spend: sm.spend, tokens: sm.tokens };
  }
  const est = { calibratedOnUsd: ds, calibratedOnPoints: Math.round(du * 100) };
  if (du >= 0.03 && ds >= 1) {
    est.pctPerUsd = du / ds;
    est.fullUsd = ds / du;
    est.fullTokens = dt > 0 ? dt / du : null;
  }
  if (cur) {
    const live = cur.resetsAt && cur.resetsAt < now() ? 0 : cur.utilization;
    if (est.fullUsd) {
      est.remainingUsd = Math.max(0, 1 - live) * est.fullUsd;
      if (est.fullTokens) est.remainingTokens = Math.max(0, 1 - live) * est.fullTokens;
    }
    const recent = limits.samples.filter((sm) => sm.w[k] && sm.w[k][1] === cur.resetsAt && sm.t > now() - 3600000);
    if (recent.length > 1 && live > 0) {
      const a = recent[0], b = recent[recent.length - 1];
      const hours = (b.t - a.t) / 3600000;
      const rate = hours > 0.25 ? (b.w[k][0] - a.w[k][0]) / hours : null;
      if (rate > 0) { est.perHour = rate; est.hitsAt = now() + ((1 - live) / rate) * 3600000; }
    }
  }
  return est;
}

function limitHold() {
  const pauseAt = readJson('roster.json').defaults.limitPauseAt || 0.85;
  limits.approved = limits.approved || {};
  for (const [k, w] of Object.entries(limits.windows)) {
    if (!w.resetsAt || w.resetsAt < now()) continue;
    const ok = limits.approved[k];
    const bar = ok && ok.resetsAt === w.resetsAt ? Math.min(1, Math.max(pauseAt, ok.at + 0.1)) : pauseAt;
    if (w.utilization >= bar) return { window: k, utilization: w.utilization, resetsAt: w.resetsAt };
  }
  return null;
}

function checkHold() {
  const was = limits.hold;
  const h = limitHold();
  limits.hold = h;
  if (h && (!was || was.window !== h.window || was.resetsAt !== h.resetsAt)) {
    const label = h.window === 'five_hour' ? '5-hour' : h.window === 'seven_day' ? 'weekly' : h.window.replace(/_/g, ' ');
    broadcast({ type: 'notify', kind: 'limit', title: `Your ${label} limit is at ${Math.round(h.utilization * 100)}%`,
      text: 'New work is paused. Continue anyway, or let it wait for the reset.' });
  }
  if (!h && was) kickAll();
}

function continuePastLimit() {
  limits.approved = limits.approved || {};
  for (const [k, w] of Object.entries(limits.windows)) {
    if (w.resetsAt && w.resetsAt > now()) limits.approved[k] = { resetsAt: w.resetsAt, at: w.utilization };
  }
  saveLimits();
  checkHold();
  broadcast({ type: 'limits', limits: limitsView() });
}

function kickAll() {
  pump();
  for (const a of agents.values()) if (a.resident) pumpResident(a);
}

function limitsView() {
  return { plan: limits.plan, hold: limits.hold || null, pauseAt: readJson('roster.json').defaults.limitPauseAt || 0.85, status: limits.status, limitedBy: limits.limitedBy, usingOverage: limits.usingOverage,
    updatedAt: limits.updatedAt, spend: limits.spend, tokens: limits.tokens, probing: !!probing,
    windows: Object.fromEntries(Object.entries(limits.windows).map(([k, v]) => [k, { ...v, est: windowEstimate(k) }])) };
}

function probeLimits() {
  if (probing) return probing;
  probing = new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, ['-p', 'Reply with: ok', '--model', 'haiku', '--effort', 'low', '--output-format', 'stream-json', '--verbose',
      '--strict-mcp-config', '--max-turns', '1'],
      { cwd: DATA, env: childEnv({ id: 'limits-probe' }), stdio: ['ignore', 'pipe', 'ignore'] });
    readLines(child.stdout, (line) => {
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (m.type === 'rate_limit_event') onRateLimit(m.rate_limit_info);
      else if (m.type === 'result') noteSpend(m.total_cost_usd || 0, m.usage);
    });
    const done = () => { probing = null; broadcast({ type: 'limits', limits: limitsView() }); resolve(); };
    child.on('close', done);
    child.on('error', done);
  });
  broadcast({ type: 'limits', limits: limitsView() });
  return probing;
}

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

// ---------------------------------------------------------------- roster / prompts

function expandTools(roster, preset) {
  const out = [];
  for (const t of roster.toolPresets[preset] || []) {
    if (t.startsWith('@')) out.push(...expandTools(roster, t.slice(1)));
    else out.push(t);
  }
  return out;
}

function defOf(roster, a) {
  return a.customDef || roster.roles[a.role];
}

function childRolesFor(roster, a) {
  const def = defOf(roster, a);
  if (a.depth + 1 > (def.maxDepth || roster.defaults.maxDepth)) return [];
  const roles = (def.children || []).map((c) => (c === 'self' ? a.role : c)).filter((c) => roster.roles[c]);
  if (def.allowCustom !== false && a.role !== roster.root) roles.push('custom');
  return [...new Set(roles)];
}

function rolePrompt(def) {
  if (def.agentFile) {
    const body = fs.readFileSync(home(def.agentFile), 'utf8');
    const m = body.match(/^---\n[\s\S]*?\n---\n?/);
    return (m ? body.slice(m[0].length) : body).trim() + (def.prompt ? '\n\n' + def.prompt : '');
  }
  return def.prompt || '';
}

const MEMORY_DIR = path.join(DATA, 'memory');
fs.mkdirSync(MEMORY_DIR, { recursive: true });
const MEMORY_MAX = 6000;

function readMemory(id) {
  try { return fs.readFileSync(path.join(MEMORY_DIR, id + '.md'), 'utf8'); } catch { return ''; }
}

function writeMemory(agentId, content) {
  const a = agents.get(agentId);
  if (!a) return { error: 'Unknown agent.' };
  let text = String(content || '').trim();
  if (!text) return { error: 'Empty memory; send the full revised text.' };
  const secret = require('./lib/secrets').findSecret(text);
  if (secret) return { error: require('./lib/secrets').refusal(secret) };
  const cut = text.length > MEMORY_MAX;
  if (cut) text = text.slice(0, MEMORY_MAX);
  const file = path.join(MEMORY_DIR, agentId + '.md');
  const prev = readMemory(agentId);
  if (prev) fs.writeFileSync(path.join(MEMORY_DIR, agentId + '.prev.md'), prev);
  fs.writeFileSync(file, text + '\n');
  a.memoryVersion = (a.memoryVersion || 0) + 1;
  a.memoryUpdatedAt = now();
  addEvent(a, { kind: 'memory', text, version: a.memoryVersion });
  touch(a);
  return { message: `Memory saved (version ${a.memoryVersion}${cut ? `, cut to ${MEMORY_MAX} characters — keep it shorter` : ''}).` };
}

function giveFeedback(fromId, toName, text) {
  const n = String(toName || '').trim().toLowerCase();
  const to = [...agents.values()].find((x) => x.id.toLowerCase() === n || (x.persona || '').toLowerCase() === n);
  if (!to) return { error: `No one called "${toName}".` };
  const from = fromId === 'user' ? null : agents.get(fromId);
  const t = from && ticketOfAgent(from);
  const fb = { from: from ? from.id : 'user', fromPersona: from ? from.persona : 'the user', text: String(text || '').slice(0, 4000), ticketN: t ? t.n : null, t: now(), seen: false };
  to.feedback = to.feedback || [];
  to.feedback.push(fb);
  if (to.feedback.length > 30) to.feedback.splice(0, to.feedback.length - 30);
  addEvent(to, { kind: 'feedback', from: fb.from, fromPersona: fb.fromPersona, text: fb.text });
  if (from) addEvent(from, { kind: 'msg_out', to: to.id, toPersona: to.persona, text: '(feedback) ' + fb.text });
  touch(to);
  return { message: `${to.persona} will get this at the start of their next task.` };
}

function pendingFeedback(a) {
  return (a.feedback || []).filter((f) => !f.seen);
}

function teamOf(roster, a) {
  const key = a.resident ? a.id : a.homeId;
  const def = key && roster.roles[key];
  if (!def || !def.team) return null;
  return { key, room: def.room, dir: path.join(ROOT, def.team.docs), references: (def.team.references || []).map(home), router: def.team.router ? home(def.team.router) : null };
}

function systemPrompt(roster, a, childRoles) {
  const def = defOf(roster, a);
  const parent = a.parentId && agents.get(a.parentId);
  const parts = [rolePrompt(def)];
  for (const doc of def.preload || []) {
    try { parts.push('', `## Reference: ${doc} (already loaded for you; do not Read it again)`, '', fs.readFileSync(home(doc), 'utf8').slice(0, 20000)); } catch {}
  }
  if (def.reportStyle === 'short') {
    parts.push('', '## Report format',
      'Your report goes into your lead\'s context, so keep it under ~300 words: the direct answer first, then the evidence as file:line ' +
      'with one line each on what it shows, then the likely root cause and where a fix belongs, then open questions. Never paste whole ' +
      'files or long listings; quote at most a few lines when the exact code matters.');
  }
  parts.push('', '## Workplace',
    `Your name is ${a.persona}. You are the ${def.name} (agent ${a.id}) in the user's office of AI agents.`);
  if (a.resident) {
    parts.push('You are permanent staff: this process stays alive between tickets and you remember earlier tickets. ' +
      'Each message starts with a header saying who it is from and which ticket it belongs to. Handle one message per turn.');
  } else {
    const lead = agents.get(a.homeId);
    parts.push(`You are permanent staff on ${lead ? `${lead.persona}'s team (${lead.room})` : 'the team'}. Between tasks you sit idle at your desk; ` +
      'each task starts a fresh conversation, so your memory (below) is how you carry experience from one task to the next.');
    parts.push(`This task comes from ${parent.persona}, the ${parent.name}, for ticket #${a.ticketN}. ` +
      'Your final message is your report back to them: make it complete and self-contained, they see nothing else of your work.');
  }
  parts.push('The user watches a live view of the office. Call `report_progress` at each meaningful step with one or two plain sentences.');
  if (childRoles.length) {
    parts.push('You may start sub-agents with `delegate` (several in parallel in one call). It is your call whether a task needs them: ' +
      'do small things yourself, split broad or parallel work across specialists. The built-in Agent/Task tool is disabled.');
    parts.push('', '## Model and effort for sub-agents',
      'You do not pick models. The office decides each sub-agent\'s model and effort with an expected-value model: it estimates the task\'s ' +
      'difficulty from the role and your brief, the chance each model/effort succeeds (from this office\'s real track record), the cost, ' +
      'and the price of a failure, and takes the best value. So write briefs that make the difficulty clear (what is hard about it, what ' +
      'is at stake). The choice and its numbers come back to you in the delegation result. Only if you have concrete evidence the choice ' +
      `is wrong for this task, set \`pin_model: true\` with \`model\`, \`effort\` and a one-line \`pin_reason\`. You cannot go above ${modelOf(roster, a).model}. ` +
      (ticketBudget() != null ? 'Each ticket has a budget; if it runs out, new sub-agents wait until the user raises it.' : 'Jobs have no dollar budget; the user\'s plan usage limits are what count, so do not spend on teammates you do not need.'));
  } else if (!def.assignTo) {
    parts.push('You cannot start sub-agents: do the work yourself.');
  }
  const memory = readMemory(a.id);
  parts.push('', '## Your memory', memory.trim() || '(Empty — this is your first task. Start building it at the end.)');
  if (a.staff) {
    const recent = (a.history || []).slice(-5).map((h) => `#${h.n || '?'} ${h.title} — ${h.outcome}`).join('; ');
    parts.push(`Track record: ${a.tasksDone || 0} tasks done, ${a.tasksFailed || 0} not completed.${recent ? ` Recent: ${recent}.` : ''}`);
  }
  const fb = pendingFeedback(a);
  if (fb.length) {
    parts.push('', '## Feedback since your last task', ...fb.map((f) => `- From ${f.fromPersona}${f.ticketN ? ` (ticket #${f.ticketN})` : ''}: ${f.text}`),
      'Take it seriously: change how you work, and fold the lesson into your memory.');
  }
  parts.push('', '## Learning from your work',
    (a.resident ? 'When you finish a ticket' : 'Before your final report') + ', call `update_memory` with your full revised memory if you learned anything about doing your job better. ' +
    'Rewrite it rather than append: keep it under ~500 words, concrete and current. Good entries: approaches that worked or wasted time, ' +
    'checks you should always do, mistakes to avoid, how your lead wants things reported, where to look first. ' +
    'Drop entries that turned out wrong or no longer matter. Facts about the code or project that the whole team needs belong in the ' +
    'team library (`add_to_team_docs`), not in your memory. ' +
    (childRoles.length ? 'When someone you delegated to did notably good or weak work, tell them with `give_feedback` so they improve.' : ''));
  parts.push('', '## Scripts first',
    'Mechanical work (counting, finding files or definitions, call sites, comparing, checking XML, uncommitted changes) is done with the ' +
    '`script` tool: exact, instant, free. Never do it by hand or delegate it. Read in parts: `outline`, `search` or `find-def` to find the ' +
    'lines, then `show file:from-to` (several files at once) or Read with offset/limit. Everything you read is re-read on every later call. ' +
    'A mechanical step no script covers goes on the "script-ideas" page (`add_to_team_docs`).');
  parts.push('', '## Past tickets',
    'Before non-trivial work, call `search_tickets` with the key terms (component, error text, file name). An earlier ticket may ' +
    'already hold the root cause, the fix that was made, or the user\'s verdict on a similar answer. Do not redo solved work blindly.');
  if (a.resident && !def.assignTo && childRoles.length) {
    parts.push('', '## You manage; teammates do the long work',
      'Your conversation lasts the whole job and is re-read on every call, so it is the most expensive context in the office. Keep it small: ' +
      'read only what you need to decide, plan, write precise briefs (goal, files with line numbers, constraints, how to check), and review ' +
      'short reports. Hand long reading, searching, multi-file edits, test runs and fix loops to teammates, who start fresh each time and ' +
      'usually run on cheaper models. Do small, quick things yourself.');
    parts.push('', '## Plans for big tickets',
      'Before a big piece of work (two or more teammates at once, any opus teammate, or work you expect to cost more than ' +
      `$${roster.defaults.planOverUsd || 2}), call \`propose_plan\` with a short plan: the steps, who does what on which model and effort, ` +
      'and an honest cost estimate in USD. The user approves, adjusts or rejects it; follow their adjustments. ' +
      'The office refuses a big delegation until the plan is approved. Small tickets need no plan. ' +
      'Write the plan\'s steps as a numbered list; while you work through an approved plan, pass `step` (the number of the step you are on) to `report_progress` so the user sees the plan tick off.');
  }
  if (a.resident && !def.assignTo) {
    parts.push('', '## Asking the user',
      'If the ticket is ambiguous in a way that changes what you would do, or you need something only the user has (a log, a ' +
      'screenshot, a decision between options), call `ask_user`. The ticket waits for their reply. Do not ask for things you can ' +
      'find out yourself, and ask everything you need in one question. Files the user attaches are listed in the ticket; open them with Read.');
  }
  parts.push('', '## Shared files',
    'Change files only with Edit/MultiEdit (just the changed lines) or Write (new files, full rewrites), never sed or redirection: the ' +
    'user reviews and can undo those changes. If another agent edits the same file you both get a heads-up; agree with `ask`/`send_message` ' +
    'who changes what.');
  parts.push('', '## Colleagues',
    '`colleagues` lists who is here; `send_message` leaves a short note; `ask` asks and waits. Messages to you arrive after your tool calls ' +
    'marked [Mail]; answer an `ask` with `send_message` and its reply_to id.');
  const team = teamOf(roster, a);
  // The area router: for leads, and for staff too when the team says it holds working knowledge (team.routerForStaff).
  if (team && team.router && fs.existsSync(team.router) && (a.resident || (roster.roles[team.key].team || {}).routerForStaff)) {
    parts.push('', '## Your area (router)', `From ${team.router}, loaded for you because CLAUDE.md is only a map:`, '', fs.readFileSync(team.router, 'utf8').slice(0, 20000));
  }
  if (team) {
    parts.push('', '## Team library',
      `Your team (${team.room}) keeps documentation in ${team.dir} — start with INDEX.md there.` +
      (team.references.length ? ` Reference docs also live in: ${team.references.join(', ')}.` : '') +
      ' Read the pages relevant to your task before you decide on an approach. When you learn something durable that future ' +
      'teammates would need (a verified fact with file:line evidence, a pitfall, where something lives, a decision and why), ' +
      'record it with `add_to_team_docs`. Do not record guesses.');
  }
  if (canRunCommands(roster, a) && commandMode(roster) !== 'off') {
    parts.push('', '## Terminal commands',
      'Your Bash tool only allows a short list of commands. For anything else (builds, test runs, installs, starting or checking a program, ' +
      'scripts with arguments), use `run_command`: it runs `bash -lc` in the folder you give, shows the command and its live output to the user, ' +
      'and returns the exit code and output. ' +
      (commandMode(roster) === 'ask' ? 'The user approves each command before it runs, so put related steps in one command (joined with &&) and say why in `reason`. ' : 'Commands run without asking, so be careful. ') +
      'Commit, push, sudo, system upgrades and rm -rf are blocked; when one of those is needed, tell the user what to run. ' +
      'Commands cannot read input: use non-interactive flags (-y, --yes, CI=1). Set `timeout_sec` for long builds (default 300, max 1800).');
  }
  parts.push(...skillProposals.promptFor(roster, a));
  const ccSkills = claudeSkillsFor(roster, a);
  if (ccSkills.length) {
    parts.push('', '## Claude Code skills for your team',
      'These skills from ~/.claude/skills hold the team\'s proven procedures. When a task matches one, call the `Skill` tool with its name before you start, and follow it:',
      ...ccSkills.map((s) => `- ${s.name}: ${s.description}`),
      'A skill may tell you to start a subagent with the Agent tool. That tool is not available here: use `delegate` with the matching roster role instead ' +
      '(or do the step yourself if you cannot delegate).');
  }
  const handoffs = handoffsOf(roster, a);
  if (handoffs) {
    const saved = savedHandoffs(handoffs).sort((x, y) => y.mtime - x.mtime)
      .map((s) => `${s.name} (${new Date(s.mtime).toISOString().slice(0, 10)})`);
    parts.push('', '## Project handoffs (continuing work across chats)',
      `Each project in ${handoffs.root} can have a handoff file in ${handoffs.dir}/<Folder>.md: the project's current state and a log ` +
      'of past sessions. When a ticket names a project, its handoff is put at the top of the ticket for you; when the user refers to a ' +
      'project only indirectly ("the GIF app", "continue where we stopped"), Read its file yourself. Treat it as your own notes from last ' +
      'time: continue from its next steps instead of exploring again, and check details against the code before relying on them.',
      'When you finish work on a project, and whenever the user says they are wrapping up or asks for a summary, call ' +
      '`save_project_handoff` before your final answer, once per project you worked on. `state` is the full current state, rewritten ' +
      'each time (what the project is and how to run it, what works, decisions and why, open problems, next steps in order, key files). ' +
      '`session` is this chat: what the user asked, what you did, files changed, what the user decided or corrected. Run the `handoff-facts` script first (job number or project folder) for the facts, and `project-info` when you start on a project. Write both so a ' +
      'fresh session with no other context can carry on.',
      `Handoffs saved so far: ${saved.length ? saved.join(', ') : 'none yet'}.`);
  }
  if (def.assignTo) {
    const projects = readJson('projects.json');
    parts.push('', '## Known projects', ...projects.map((p) =>
      `- ${p.name} — ${p.path} — owner: ${p.department}. ${p.description || ''}`));
  }
  return parts.join('\n');
}

function modelOf(roster, a) {
  const def = defOf(roster, a);
  if (a.resident) return { model: def.model || roster.defaults.residentModel || 'opus',
    effort: (a.id !== roster.root && a.runEffort) || def.effort || roster.defaults.residentEffort || 'high' };
  return { model: a.model || def.model || roster.defaults.model, effort: a.effort || def.effort || roster.defaults.effort };
}

// How big each role's fixed instructions and tool definitions are (scripts/prompt-size.js): what every call of that role re-sends.
async function promptSizes() {
  const roster = readJson('roster.json');
  const out = [];
  const leadsList = roster.residents.filter((k) => k !== roster.root);
  const sample = [roster.root, ...leadsList, ...[...new Set(leadsList.flatMap((k) => roster.roles[k].children || []))].filter((r) => r !== 'custom')];
  for (const role of sample) {
    const def = roster.roles[role];
    if (!def) continue;
    const resident = roster.residents.includes(role);
    const home = resident ? role : leadsList.find((k) => (roster.roles[k].children || []).includes(role));
    const a = resident ? { id: role, role, resident: true, persona: def.persona || role, name: def.name, inbox: [] }
      : { id: `size-${role}`, role, staff: true, homeId: home, parentId: home, persona: 'Sample', name: def.name, ticketN: 0, history: [] };
    let text = '';
    try { text = systemPrompt(roster, a, childRolesFor(roster, a)); } catch (e) { out.push({ role, error: e.message }); continue; }
    const sections = text.split(/\n(?=## )/).map((x) => ({ name: (x.match(/^## (.*)/) || [null, '(role instructions)'])[1], chars: x.length }));
    const args = buildArgs(roster, a);
    const mcpEnv = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers.workplace.env;
    const toolsJson = await new Promise((resolve) => {
      const c = spawn(process.execPath, [path.join(ROOT, 'mcp-delegate.js')], { env: { ...process.env, ...mcpEnv }, stdio: ['pipe', 'pipe', 'ignore'] });
      let buf = '';
      const done = (v) => { try { c.kill(); } catch {} resolve(v); };
      c.stdout.on('data', (d) => { buf += d; const line = buf.split('\n').find((l) => /"id":\s*2\b/.test(l)); if (line) done(line); });
      c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'size', version: '1' } } }) + '\n');
      c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
      setTimeout(() => done(''), 4000);
    });
    let tools = [];
    try { tools = JSON.parse(toolsJson).result.tools.map((t) => ({ name: t.name, chars: JSON.stringify(t).length })); } catch {}
    out.push({ role, resident, promptChars: text.length, sections, toolChars: tools.reduce((n, t) => n + t.chars, 0), tools });
  }
  return out;
}

function buildArgs(roster, a) {
  const def = defOf(roster, a);
  const me = modelOf(roster, a);
  const childRoles = childRolesFor(roster, a);
  const team = teamOf(roster, a);
  const help = childRoles.filter((r) => r !== 'custom').map((r) => {
    const d = roster.roles[r];
    return `- ${r}: ${d.name} — ${d.description} (usual: ${d.model || roster.defaults.model}/${d.effort || roster.defaults.effort})`;
  }).join('\n');
  const assignTo = def.assignTo || [];
  const assignHelp = assignTo.map((r) => `- ${r}: ${roster.roles[r].persona}, ${roster.roles[r].name} — ${roster.roles[r].description}`).join('\n');
  const mcp = { mcpServers: { workplace: {
    type: 'stdio', command: process.execPath, args: [path.join(ROOT, 'mcp-delegate.js')],
    env: { WORKPLACE_AGENT_ID: a.id, WORKPLACE_PORT: String(PORT),
           WORKPLACE_CHILD_ROLES: childRoles.join(','), WORKPLACE_CHILD_ROLES_HELP: help,
           WORKPLACE_ASSIGN_TO: assignTo.join(','), WORKPLACE_ASSIGN_HELP: assignHelp,
           WORKPLACE_HAS_TEAM: teamOf(roster, a) ? '1' : '',
           WORKPLACE_HANDOFFS: handoffsOf(roster, a) ? '1' : '',
           WORKPLACE_CAN_EDIT: canRunCommands(roster, a) ? '1' : '',
           WORKPLACE_CAN_RUN: canRunCommands(roster, a) && commandMode(roster) !== 'off' ? commandMode(roster) : '',
           WORKPLACE_SCRIPTS: ['all', ...(a.resident && a.id !== roster.root ? ['lead'] : []), ...(team && roster.roles[team.key].team.office ? ['office'] : [])].join(','),
           WORKPLACE_MAX_MODEL: me.model,
           WORKPLACE_CAN_ASK_USER: a.resident && a.id !== roster.root ? '1' : '' } } } };
  const allowed = [...expandTools(roster, def.tools || 'readonly'), 'mcp__workplace__report_progress',
    ...(childRoles.length ? ['mcp__workplace__delegate', 'mcp__workplace__wait_for_team'] : []), ...(assignTo.length ? ['mcp__workplace__assign'] : []),
    'mcp__workplace__colleagues', 'mcp__workplace__send_message', 'mcp__workplace__ask', ...(team ? ['mcp__workplace__add_to_team_docs', 'mcp__workplace__propose_skill'] : []),
    ...(handoffsOf(roster, a) ? ['mcp__workplace__save_project_handoff'] : []),
    ...(canRunCommands(roster, a) && commandMode(roster) !== 'off' ? ['mcp__workplace__run_command'] : []),
    ...(canRunCommands(roster, a) ? ['mcp__workplace__request_edit_access'] : []),
    'mcp__workplace__update_memory', 'mcp__workplace__give_feedback', ...(childRoles.length ? ['mcp__workplace__staff'] : []),
    ...(claudeSkillsFor(roster, a).length ? ['Skill'] : []),
    'mcp__workplace__search_tickets', 'mcp__workplace__script', ...(a.resident && a.id !== roster.root ? ['mcp__workplace__ask_user', 'mcp__workplace__propose_plan'] : []), `Read(/${UPLOADS}/**)`];
  const addDirs = [...(team ? [team.dir, ...team.references] : []), UPLOADS];
  if (a.resident && team) allowed.push(`Edit(/${team.dir}/**)`, `Write(/${team.dir}/**)`, `MultiEdit(/${team.dir}/**)`);
  const hook = [{ type: 'command', command: `${process.execPath} ${path.join(ROOT, 'mail-hook.js')}` }];
  const settings = { autoMemoryEnabled: false, hooks: { PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|Read', hooks: hook }], PostToolUse: [{ matcher: '*', hooks: hook }] } };
  return ['-p', '--output-format', 'stream-json', '--verbose',
    '--settings', JSON.stringify(settings),
    ...(addDirs.length ? ['--add-dir', ...addDirs] : []),
    ...(a.resident ? ['--include-partial-messages'] : []),
    '--model', me.model,
    '--effort', me.effort,
    '--thinking-display', roster.defaults.thinkingDisplay || 'summarized',
    '--permission-mode', def.permissionMode || 'default',
    '--mcp-config', JSON.stringify(mcp), '--strict-mcp-config',
    '--tools', ...builtinTools(allowed),
    '--append-system-prompt', systemPrompt(roster, a, childRoles),
    '--allowedTools', ...allowed,
    '--disallowedTools', ...roster.alwaysDisallowed];
}

const BUILTIN_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LSP', 'Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebSearch', 'WebFetch', 'Skill']);

// Claude Code skills (~/.claude/skills) a team may use, from its team.claudeSkills: a list of names, "*" for all, or
// "work-area" for every skill that mentions the work repository (defaults.workArea.repo), so new ones join by themselves.
function claudeSkillsFor(roster, a) {
  const key = a.resident ? a.id : a.homeId;
  const want = key && roster.roles[key] && roster.roles[key].team && roster.roles[key].team.claudeSkills;
  if (!want) return [];
  const dir = path.join(os.homedir(), '.claude', 'skills');
  const W = require('./lib/work-area').workArea(ROOT);
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  for (const n of names) {
    let text;
    try { text = fs.readFileSync(path.join(dir, n, 'SKILL.md'), 'utf8'); } catch { continue; }
    const desc = ((text.match(/^description:\s*(.*)$/m) || [])[1] || '').trim();
    const ok = want === '*' || (Array.isArray(want) && want.includes(n)) || (want === 'work-area' && W.repo && (text.includes(W.repo) || text.includes(W.tilde(W.repo))));
    const first = desc.split(/(?<=[.;—])\s/)[0].replace(/\s+in \/home\/\S+/, '');
    if (ok) out.push({ name: n, description: first.length > 110 ? first.slice(0, 107) + '…' : first });
  }
  return out;
}
function builtinTools(allowed) {
  return [...new Set(allowed.map((t) => t.split('(')[0]).filter((t) => BUILTIN_TOOLS.has(t)))];
}

function childEnv(a) {
  const compact = Number(readJson('roster.json').defaults.autoCompactTokens) || 0;
  const env = { ...process.env, ...(compact > 0 ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(compact) } : {}), MCP_TOOL_TIMEOUT: '86400000', MCP_TIMEOUT: '30000', WORKPLACE_AGENT_ID: a.id, WORKPLACE_PORT: String(PORT), ENABLE_TOOL_SEARCH: 'false', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

function readLines(stream, onLine) {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  });
}

function blockText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  return JSON.stringify(content);
}

function onStreamMessage(a, m) {
  if (m.type === 'system' && m.subtype === 'init') {
    if (a.sessionId !== m.session_id) {
      a.sessionId = m.session_id;
      a.sessionStartedAt = now();
      a.contextTokens = 0;
      addEvent(a, { kind: 'system', text: `Session ${m.session_id.slice(0, 8)} · ${m.model} · ${m.cwd}` });
      try { fs.appendFileSync(path.join(DATA, 'sessions.jsonl'), JSON.stringify({ t: now(), sid: m.session_id, agentId: a.id, persona: a.persona, role: a.role, name: a.name, homeId: a.resident ? a.id : a.homeId, ticketId: a.resident ? (a.current && a.current.ticketId) || null : a.ticketId || null }) + '\n'); } catch {}
      touch(a);
    }
  } else if (m.type === 'stream_event' && m.event) {
    const e = m.event;
    if (e.type === 'content_block_start') setDraft(a, e.content_block && e.content_block.type === 'text' ? '' : null);
    else if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta' && a.draft != null) setDraft(a, a.draft + e.delta.text);
  } else if (m.type === 'assistant' && m.message) {
    const u = m.message.usage;
    if (u && m.message.id && m.message.id !== a.liveMsgId) {
      // Estimate of this turn's spend so far; the exact figure replaces it when the turn ends.
      const cc = u.cache_creation || {};
      a.liveMsgId = m.message.id;
      contextNudge(a, (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0));
      a.liveUsd = (a.liveUsd || 0) + usageIndex.cost({ model: m.message.model || a.model, in: u.input_tokens || 0, r: u.cache_read_input_tokens || 0,
        w5: cc.ephemeral_5m_input_tokens != null ? cc.ephemeral_5m_input_tokens : u.cache_creation_input_tokens || 0, w1: cc.ephemeral_1h_input_tokens || 0, out: u.output_tokens || 0 }).total;
      touch(a);
    }
    for (const b of m.message.content || []) {
      if (b.type === 'thinking' && b.thinking) addEvent(a, { kind: 'thinking', text: b.thinking });
      else if (b.type === 'text' && b.text.trim()) addEvent(a, { kind: 'text', text: b.text });
      else if (b.type === 'tool_use') addEvent(a, { kind: 'tool_use', id: b.id, name: b.name, input: b.input });
    }
  } else if (m.type === 'user' && m.message && Array.isArray(m.message.content)) {
    for (const b of m.message.content) {
      if (b.type === 'tool_result') {
        const text = blockText(b.content);
        addEvent(a, { kind: 'tool_result', toolUseId: b.tool_use_id, isError: !!b.is_error,
          text: text.length > 6000 ? text.slice(0, 6000) + `\n… (${text.length - 6000} more chars)` : text });
      }
    }
  } else if (m.type === 'rate_limit_event') {
    onRateLimit(m.rate_limit_info);
  } else if (m.type === 'result') {
    const cum = m.total_cost_usd || 0;
    const sid = m.session_id || a.sessionId;
    const prev = a.costSid === sid ? a.costCum || 0 : 0;
    const cost = cum >= prev ? cum - prev : cum;
    a.costSid = sid;
    a.costCum = cum;
    a.costUsd += cost;
    a.liveUsd = 0;
    setDraft(a, null);
    refreshExactSoon();
    chargeTicket(a, cost);
    noteSpend(cost, m.usage);
    const it = m.usage && Array.isArray(m.usage.iterations) && m.usage.iterations.length ? m.usage.iterations[m.usage.iterations.length - 1] : m.usage;
    if (it) a.contextTokens = (it.input_tokens || 0) + (it.cache_read_input_tokens || 0) + (it.cache_creation_input_tokens || 0) + (it.output_tokens || 0);
    if (a.resident && !a.sessionStartedAt) a.sessionStartedAt = now();
    a.turns += m.num_turns || 0;
    addEvent(a, { kind: 'result', text: m.result || '', isError: !!m.is_error, subtype: m.subtype,
      costUsd: cost, sessionCostUsd: cum, model: a.model, durationMs: m.duration_ms, turns: m.num_turns, ticketId: a.current && a.current.ticketId });
    return { done: true, text: m.result || '', isError: !!m.is_error || m.subtype !== 'success' };
  }
  return null;
}

// The text block an agent is writing right now, sent to the window a few times a second (never saved).
const draftTimers = new Map();
function setDraft(a, text) {
  a.draft = text;
  if (draftTimers.has(a.id)) return;
  draftTimers.set(a.id, setTimeout(() => {
    draftTimers.delete(a.id);
    broadcast({ type: 'draft', agentId: a.id, text: a.draft || null });
  }, 150));
}

// The per-job budget in USD, or null when jobs have no budget (defaults.ticketBudgetUsd null or 0; the plan's usage limits still apply).
function ticketBudget() {
  const v = readJson('roster.json').defaults.ticketBudgetUsd;
  return typeof v === 'number' && v > 0 ? v : null;
}

// Job costs from the exact per-call token counts in Claude Code's transcripts, priced per model (scripts/job-cost.js --all).
// Claude Code's own running total, which chargeTicket adds up live, undercounts some cache writes; this replaces it every 10 minutes
// and shortly after a turn ends. The live figure is kept as costRecordedUsd.
let exactRunning = false;
function refreshExactCosts() {
  if (exactRunning) return;
  exactRunning = true;
  const child = spawn(process.execPath, [path.join(SCRIPTS, 'job-cost.js'), '--all'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.on('close', () => {
    exactRunning = false;
    let rows = [];
    try { rows = JSON.parse(out); } catch { return; }
    const byN = new Map(rows.map((r) => [r.n, r]));
    for (const t of tickets.values()) {
      const r = byN.get(t.n);
      if (!r || !(r.usd > 0) || Math.abs((t.costUsd || 0) - r.usd) < 0.01) continue;
      if (t.costRecordedUsd == null) t.costRecordedUsd = t.costUsd || 0;
      t.costUsd = r.usd;
      t.costExact = true;
      touchTicket(t);
    }
  });
}
setInterval(refreshExactCosts, 10 * 60000);
setTimeout(refreshExactCosts, 60000);
let exactSoon = null;
const refreshExactSoon = () => { clearTimeout(exactSoon); exactSoon = setTimeout(refreshExactCosts, 45000); };

// A lead whose own conversation grows past defaults.leadContextNudge (100k tokens) is reminded, then again every 50k more, to keep
// itself to planning and review and hand the long reading and editing to teammates with fresh contexts. Its context is re-read
// on every call, so this is the biggest cost on long jobs.
function contextNudge(a, ctx) {
  a.liveContext = ctx;
  const roster = readJson('roster.json');
  const at = Number(roster.defaults.leadContextNudge ?? 100000);
  if (!at || !a.resident || a.id === roster.root || !childRolesFor(roster, a).length) return;
  if (ctx < Math.max(at, (a.ctxNudgedAt || 0) + 50000)) return;
  a.ctxNudgedAt = ctx;
  officeNote(a.id, `Your own context is now ${Math.round(ctx / 1000)}k tokens, and every call re-reads all of it. From here, keep yourself to ` +
    'planning, briefing and review: hand the remaining reading, searching and editing to a teammate with a fresh context (`delegate`, with a ' +
    'precise brief and the file:line pointers you already have), and ask for a short report back. Read only what you need to decide.');
  addEvent(a, { kind: 'system', text: `Context ${Math.round(ctx / 1000)}k: reminded to delegate the remaining long work.` });
}

function chargeTicket(a, usd) {
  const t = a.resident ? (a.current && tickets.get(a.current.ticketId)) : tickets.get(a.ticketId);
  if (!t || !usd) return;
  t.costUsd = (t.costUsd || 0) + usd;
  const limit = ticketBudget();
  if (limit == null) {
    if (t.overBudget) { t.overBudget = false; releaseBudget(t, true); }
    touchTicket(t);
    return;
  }
  if (t.budgetUsd == null) t.budgetUsd = limit;
  if (!t.overBudget && t.costUsd >= t.budgetUsd && t.status === 'open') {
    t.overBudget = true;
    thread(t, { from: 'system', kind: 'system', text: `Reached the $${t.budgetUsd.toFixed(2)} budget ($${t.costUsd.toFixed(2)} spent). New sub-agents wait until you raise it.` });
  }
  touchTicket(t);
}

function waitForBudget(t) {
  if (!t || !t.overBudget || t.status !== 'open' || ticketBudget() == null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const list = budgetWaiters.get(t.id) || [];
    list.push(resolve);
    budgetWaiters.set(t.id, list);
  });
}

function releaseBudget(t, ok) {
  const list = budgetWaiters.get(t.id) || [];
  budgetWaiters.delete(t.id);
  list.forEach((r) => r(ok));
}

// ---------------------------------------------------------------- residents (always-alive agents)

const PERSONAS = ['Ben', 'Chloe', 'Dmitri', 'Elena', 'Felix', 'Greta', 'Hugo', 'Iris', 'Jonas', 'Kira', 'Leo',
  'Mila', 'Nikolai', 'Olga', 'Pavel', 'Quinn', 'Rosa', 'Stefan', 'Tara', 'Uma', 'Wren', 'Xenia', 'Yuri', 'Zoe',
  'Anya', 'Boris', 'Clara', 'Dario', 'Eva', 'Filip', 'Gaia', 'Hana', 'Ivo', 'Jade', 'Kostas', 'Lena', 'Marco',
  'Oskar', 'Petra', 'Raya', 'Sami', 'Teo', 'Vera', 'Willa', 'Yana', 'Zlatan', 'Alba', 'Bruno', 'Daria', 'Emil', 'Ines'];

function baseAgent(fields) {
  return { status: 'queued', progress: null, percent: null, sessionId: null, result: null, error: null,
    costUsd: 0, turns: 0, createdAt: now(), startedAt: null, endedAt: null, updatedAt: now(),
    children: [], events: [], ...fields };
}

function ensureResident(roster, key) {
  const def = roster.roles[key];
  let a = agents.get(key);
  if (!a) {
    a = baseAgent({ id: key, role: key, resident: true, depth: key === roster.root ? 0 : 1, parentId: null,
      inbox: [], current: null, ticketsHandled: 0, status: 'offline' });
    agents.set(key, a);
  }
  Object.assign(a, { name: def.name, persona: def.persona, title: def.description, room: def.room, cwd: home(def.cwd || '~'),
    ...modelOf(roster, a) });
  return a;
}

function startResident(key) {
  if (shuttingDown) return;
  const roster = readJson('roster.json');
  const a = ensureResident(roster, key);
  if (procs.get(key)) return;
  const args = [...buildArgs(roster, a), '--input-format', 'stream-json'];
  if (a.sessionId) args.push('--resume', a.sessionId);
  const child = spawn(CLAUDE_BIN, args, { cwd: a.cwd, env: childEnv(a), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const started = now();
  a.procStartedAt = started;
  procs.set(key, child);
  a.status = 'idle';
  a.startedAt = a.startedAt || now();
  a.pid = child.pid;
  if (!a.sessionId) { a.sessionTickets = []; a.lastTicketId = null; }
  addEvent(a, { kind: 'system', text: a.sessionId ? 'Back at the desk (memory restored).' : 'Started a fresh session.' });
  touch(a);
  readLines(child.stdout, (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return addEvent(a, { kind: 'log', text: line }); }
    const r = onStreamMessage(a, m);
    if (r && r.done) finishResidentTurn(a, r.text, r.isError);
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; if (stderr.length > 20000) stderr = stderr.slice(-8000); });
  child.stdin.on('error', () => {});
  child.on('close', (code) => {
    procs.delete(key);
    if (stderr.trim()) addEvent(a, { kind: 'log', text: stderr.trim().slice(-3000) });
    if (shuttingDown) return;
    const planned = a.killing || a.resetting;
    const quick = now() - started < 15000;
    if (quick && code && a.sessionId && !a.resetting && !a.killing) {
      addEvent(a, { kind: 'system', text: 'Could not resume the previous session; starting fresh.' });
      a.sessionId = null;
    }
    if (a.current && a.pausing && a.current.ticketId === a.pausing) {
      addEvent(a, { kind: 'system', text: 'Paused by the user mid-ticket.' });
      a.current = null;
    } else if (a.current) finishResidentTurn(a, `INTERRUPTED: my process stopped (exit ${code}) before I finished.`, true);
    a.pausing = null;
    a.status = 'offline';
    a.resetting = false;
    a.killing = false;
    touch(a);
    a.restarts = quick && !planned ? (a.restarts || 0) + 1 : 0;
    if (!shuttingDown) setTimeout(() => startResident(key), planned ? 200 : Math.min(60000, 1000 * 2 ** Math.min(a.restarts, 6)));
  });
  pumpResident(a);
}

function enqueueResident(key, item) {
  const a = agents.get(key);
  a.inbox.push(item);
  touch(a);
  pumpResident(a);
  return a.inbox.length - (a.current ? 0 : 1);
}

function effortFor(roster, a, item) {
  if (a.id === roster.root || item.kind === 'message' || item.kind === 'chore') return null;
  const t = tickets.get(item.ticketId);
  return (t && t.leadEffort) || roster.defaults.residentEffort || 'high';
}

function pumpResident(a) {
  const p = procs.get(a.id);
  if (!p || a.current || !a.inbox.length || a.killing || limits.hold || isRestartPending()) return;
  const idx = a.inbox.findIndex((i) => { const tk = i.ticketId && tickets.get(i.ticketId); return !tk || tk.status !== 'paused'; });
  if (idx < 0) return;
  if (idx > 0) a.inbox.unshift(...a.inbox.splice(idx, 1));
  const roster = readJson('roster.json');
  const want = effortFor(roster, a, a.inbox[0]);
  const next = a.inbox[0];
  if (a.id !== roster.root && roster.defaults.leadFreshPerTicket !== false && a.sessionId && next.ticketId && a.lastTicketId && next.ticketId !== a.lastTicketId) {
    const t = tickets.get(next.ticketId);
    if (want) a.runEffort = want;
    a.sessionId = null;
    a.lastTicketId = null;
    a.resetting = true;
    addEvent(a, { kind: 'system', text: `Fresh session for ticket #${t ? t.n : '?'}: earlier tickets stay out of the context (your memory file carries over).` });
    restartResident(a.id);
    return;
  }
  if (want && want !== a.effort) {
    const t = tickets.get(a.inbox[0].ticketId);
    a.runEffort = want;
    addEvent(a, { kind: 'system', text: `Switching to ${want} effort for ticket #${t ? t.n : '?'} (same session).` });
    restartResident(a.id);
    return;
  }
  const item = a.inbox.shift();
  if (item.ticketId && a.id !== roster.root) {
    const t = tickets.get(item.ticketId);
    a.sessionTickets = a.sessionTickets || [];
    if (t && t.answer && !a.sessionTickets.includes(item.ticketId)) {
      const said = t.thread.filter((e) => e.kind === 'user' || e.kind === 'reply').slice(-3).map((e) => `- ${String(e.text || '').slice(0, 400)}`).join('\n');
      item.text = `[Context: you answered ticket #${t.n} in an earlier session; this session starts without it]\nYour last answer:\n${String(t.answer).slice(0, 4000)}${said ? `\n\nThe user's recent messages on it:\n${said}` : ''}\nReuse what you can; ask specialists again only for what this follow-up really needs.\n\n${item.text}`;
    }
    const handoffs = t && !a.sessionTickets.includes(item.ticketId) && handoffsOf(roster, a);
    if (handoffs) {
      item.text = handoffBrief(handoffs, t, item.text);
      const names = projectsMentioned(handoffs, `${t.text}\n${item.text}`).filter((n) => fs.existsSync(path.join(handoffs.dir, `${n}.md`)));
      if (names.length) { t.handoffs = [...new Set([...(t.handoffs || []), ...names])]; touchTicket(t); }
    }
    // When the user says they are wrapping up, the lead is told explicitly to save the project handoff before answering.
    const ho = t && handoffsOf(roster, a);
    if (ho && /\b(wrap(ping)?\s+up|that'?s all for (today|now)|done for (today|now|the day)|last message|end of (the |our )?session|see you tomorrow|stop here for today|call it a day)\b/i.test(String(item.text).slice(-2000))) {
      const names = projectsMentioned(ho, `${t.title}\n${t.text}\n${item.text}`);
      if (names.length) item.text += `\n\n[The user is wrapping up: before you answer, call save_project_handoff for ${names.join(', ')} (run the handoff-facts script first for the facts).]`;
    }
    if (!a.sessionTickets.includes(item.ticketId)) a.sessionTickets.push(item.ticketId);
    a.lastTicketId = item.ticketId;
  }
  const fb = pendingFeedback(a);
  if (fb.length && item.kind !== 'chore') {
    item.text = `[Feedback you received since your last ticket]\n${fb.map((f) => `- From ${f.fromPersona}${f.ticketN ? ` (ticket #${f.ticketN})` : ''}: ${f.text}`).join('\n')}\nFold the lesson into how you work and into your memory.\n\n${item.text}`;
    fb.forEach((f) => { f.seen = true; });
  }
  a.current = item;
  a.liveUsd = 0;
  a.ctxNudgedAt = 0;
  a.draft = null;
  a.status = 'running';
  a.progress = null;
  a.percent = null;
  if (item.kind !== 'message') addEvent(a, { kind: item.kind === 'followup' ? 'followup' : 'brief', text: item.text, ticketId: item.ticketId, chore: item.kind === 'chore', label: item.label });
  touch(a);
  p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: item.text } }) + '\n');
}

function finishResidentTurn(a, text, isError) {
  const item = a.current;
  a.current = null;
  a.status = procs.get(a.id) ? 'idle' : 'offline';
  if (item && item.refresh) {
    a.sessionId = null;
    a.resetting = true;
    a.contextTokens = 0;
    a.lastRefreshAt = now();
    addEvent(a, { kind: 'system', text: 'Saved what matters to memory; starting a fresh session.' });
    touch(a);
    restartResident(a.id);
    return;
  }
  if (item && (item.kind === 'message' || item.kind === 'chore')) {
    if (item.kind === 'chore') { a.result = text; addEvent(a, { kind: 'system', text: 'Finished tidying the team library.' }); broadcast({ type: 'docs', team: a.id, by: a.id, page: 'INDEX.md' }); }
    touch(a);
    pumpResident(a);
    maybeTidy(a.id);
    return;
  }
  a.result = text;
  if (item) a.ticketsHandled = (a.ticketsHandled || 0) + 1;
  touch(a);
  if (item) onResidentReply(a, item, text, isError);
  const roster = readJson('roster.json');
  const every = roster.defaults.rootFreshEvery || 0;
  if (a.id === roster.root && item && every && a.ticketsHandled % every === 0) {
    a.sessionId = null;
    a.resetting = true;
    addEvent(a, { kind: 'system', text: `Starting a fresh session (every ${every} tickets, so routing stays cheap).` });
    restartResident(a.id);
    return;
  }
  if (a.restartWhenIdle && !a.inbox.length) { a.restartWhenIdle = false; restartResident(a.id); return; }
  maybeRefresh(a);
  pumpResident(a);
  maybeTidy(a.id);
}

function onResidentReply(a, item, text, isError) {
  const roster = readJson('roster.json');
  const t = tickets.get(item.ticketId);
  if (!t || t.status === 'stopped') return;
  if (a.id === roster.root) {
    t.pending = t.pending.filter((k) => k !== a.id);
    if (t.pending.length) {
      thread(t, { from: a.id, kind: 'note', text });
    } else {
      t.answer = text;
      t.status = isError ? 'failed' : 'done';
      t.closedAt = now();
      thread(t, { from: a.id, kind: 'answer', text });
    }
    return;
  }
  t.pending = t.pending.filter((k) => k !== a.id);
  t.answer = t.answer && t.assignees.length > 1 ? `${t.answer}\n\n---\n\n${text}` : text;
  const silent = arms.onAnswer(t, text);
  thread(t, { from: a.id, to: 'user', kind: 'answer', text, silent });
  if (!t.pending.length) {
    t.status = isError ? 'failed' : 'done';
    t.closedAt = now();
    touchTicket(t);
  }
}

function restartResident(key) {
  const p = procs.get(key);
  const a = agents.get(key);
  if (a) a.killing = true;
  if (p) { try { process.kill(-p.pid, 'SIGTERM'); } catch { try { p.kill('SIGTERM'); } catch {} } }
  else startResident(key);
}

// ---------------------------------------------------------------- tickets

function newTicket({ text, project, direct, leadEffort }) {
  const t = { id: newId(), n: ++ticketSeq, title: text.split('\n')[0].slice(0, 90), text, project: project || null,
    direct: direct || null, leadEffort: leadEffort || null, leadEffortBy: leadEffort ? 'user' : null, status: 'open', pending: [], assignees: [], thread: [], answer: null,
    costUsd: 0, budgetUsd: ticketBudget(), overBudget: false,
    createdAt: now(), updatedAt: now(), closedAt: null };
  tickets.set(t.id, t);
  return t;
}

function reopen(t) {
  if (t.status !== 'open') { t.status = 'open'; t.closedAt = null; }
}

function stopTicket(t) {
  endCommands(t);
  endAccess(t);
  releaseBudget(t, false);
  if (t.waiting) {
    const w = userAskWaiters.get(t.waiting.id);
    userAskWaiters.delete(t.waiting.id);
    t.waiting = null;
    if (w) w.resolve({ message: 'The user stopped this ticket. Stop working on it.' });
  }
  if (t.plan && t.plan.status === 'pending') {
    const w = planWaiters.get(t.plan.id);
    planWaiters.delete(t.plan.id);
    t.plan.status = 'stopped';
    if (w) w.resolve({ message: 'The user stopped this ticket. Stop working on it.' });
  }
  t.status = 'stopped';
  t.pending = [];
  t.closedAt = now();
  for (const a of agents.values()) {
    if (a.resident) {
      const before = a.inbox.length;
      a.inbox = a.inbox.filter((i) => i.ticketId !== t.id);
      if (before !== a.inbox.length) touch(a);
      if (a.current && a.current.ticketId === t.id) restartResident(a.id);
    } else if (a.ticketId === t.id) {
      stopTree(a.id);
    }
  }
  thread(t, { from: 'system', kind: 'system', text: 'Stopped by you.' });
}

// ---------------------------------------------------------------- temporary sub-agents

function runningCount() {
  let n = 0;
  for (const a of agents.values()) if (!a.resident && a.status === 'running') n++;
  return n;
}

function pump() {
  if (limits.hold || isRestartPending()) return;
  while (queue.length && runningCount() < MAX_RUNNING) {
    const { a, prompt, resume } = queue.shift();
    if (a.status === 'queued') launch(a, prompt, resume);
  }
}

function pickPersona() {
  const taken = new Set([...agents.values()].map((x) => x.persona));
  const free = PERSONAS.filter((n) => !taken.has(n));
  if (free.length) return free[crypto.randomInt(free.length)];
  for (let i = 2; ; i++) {
    const n = PERSONAS[crypto.randomInt(PERSONAS.length)] + ' ' + i;
    if (!taken.has(n)) return n;
  }
}

function findStaff(roster, homeId, x, t) {
  const pool = [...agents.values()].filter((s) => s.staff && s.homeId === homeId && s.status === 'idle');
  const sameRole = (s) => (x.role === 'custom'
    ? s.role === 'custom' && s.name.toLowerCase() === String(x.name || 'Specialist').slice(0, 40).toLowerCase() &&
      (s.customDef.permissionMode === 'acceptEdits') === (x.access === 'edit')
    : s.role === x.role);
  if (x.who) {
    const w = pool.find((s) => s.persona.toLowerCase() === String(x.who).toLowerCase());
    if (w && sameRole(w)) return w;
  }
  return pool.filter((s) => onCall.available(s, t) && sameRole(s)).sort((p, q) => (q.tasksDone || 0) - (p.tasksDone || 0))[0] || null;
}

function staffList(agentId) {
  const me = agents.get(agentId);
  if (!me) return 'Unknown agent.';
  const homeId = me.resident ? me.id : me.homeId;
  const roster = readJson('roster.json');
  const list = [...agents.values()].filter((s) => s.staff && s.homeId === homeId).sort((p, q) => (q.tasksDone || 0) - (p.tasksDone || 0));
  const describe = (s) => {
    const last = (s.history || []).slice(-1)[0];
    return `- ${s.persona} — ${s.name} (${s.role === 'custom' ? 'custom' : s.role}) — ${s.status === 'idle' ? 'free' : 'busy: ' + s.title} — ` +
      `${s.tasksDone || 0} done, ${s.tasksFailed || 0} not completed${s.model ? ` — last ran on ${s.model}/${s.effort}` : ''}` +
      `${last ? ` — last task: #${last.n} ${last.title}` : ''}${readMemory(s.id) ? ' — has memory' : ''}`;
  };
  return onCall.staffLines(list, ticketOfAgent(me), describe) +
    '\n\nDelegating reuses a free teammate of that role (the most experienced, or the one you name with `who`). ' +
    'If nobody suitable is free, someone new is hired: roster roles join the team; custom specialists are on call for this ' +
    'project only, unless you set `stay: "team"` because the role is useful beyond it.';
}

function ticketOfAgent(a) {
  if (a.resident) return a.current && tickets.get(a.current.ticketId);
  return tickets.get(a.ticketId);
}

function pickModel(roster, parent, x, def) {
  if (x.__pick) return x.__pick;
  const cap = MODELS.indexOf(modelOf(roster, parent).model);
  if (x.pin_model && MODELS.includes(x.model)) {
    const model = MODELS[Math.min(cap, MODELS.indexOf(x.model))];
    const effort = EFFORTS.includes(x.effort) ? x.effort : (def.effort || roster.defaults.effort);
    return { model, effort, choice: `pinned by ${parent.persona}: ${String(x.pin_reason || 'no reason given').slice(0, 200)}` };
  }
  const util = Math.max(0, ...Object.values(limits.windows || {}).map((w) => (w.resetsAt > now() ? w.utilization : 0)));
  const r = chooseModel({ role: x.role, roleDef: x.role === 'custom' ? null : def, name: x.name || def.name, task: `${x.title || ''}\n${x.task || ''}`,
    agents: [...agents.values()], tickets: [...tickets.values()], capModel: MODELS[cap], values: roster.defaults.taskValueUsd, utilization: util });
  return { model: r.model, effort: r.effort, choice: `EV model: ${r.reason}` };
}

function createTemp(roster, parent, x) {
  const t = ticketOfAgent(parent);
  const homeId = parent.resident ? parent.id : parent.homeId;
  const existing = findStaff(roster, homeId, x, t);
  if (existing) {
    const def = existing.customDef || roster.roles[existing.role];
    const { model, effort, choice, pickId, source: pickSource } = pickModel(roster, parent, x, def);
    Object.assign(existing, { model, effort, choice, pickId, pickSource, title: x.title, task: x.task, parentId: parent.id,
      ticketId: t ? t.id : null, ticketN: t ? t.n : null, depth: parent.depth + 1, children: [],
      result: null, error: null, progress: null, percent: null, sessionId: null, startedAt: null, endedAt: null,
      taskCostStart: existing.costUsd, status: 'queued', newHire: false });
    onCall.onReuse(existing, x, t);
    if (t && !existing.tickets.includes(t.id)) existing.tickets.push(t.id);
    if (!parent.children.includes(existing.id)) parent.children.push(existing.id);
    touch(parent);
    touch(existing);
    return existing;
  }
  let customDef = null;
  if (x.role === 'custom') {
    const edit = x.access === 'edit';
    customDef = { name: (x.name || 'Specialist').slice(0, 40), description: 'Custom specialist',
      prompt: x.instructions || '', tools: edit ? (inWorkRepo(parent.cwd) ? 'edit' : 'personal') : 'readonly',
      permissionMode: edit ? 'acceptEdits' : 'default', children: [], cwd: parent.cwd };
  }
  const def = customDef || roster.roles[x.role];
  const { model, effort, choice, pickId, source: pickSource } = pickModel(roster, parent, x, def);
  const a = baseAgent({
    model, effort, choice, pickId, pickSource,
    id: newId(), role: x.role, customDef, name: def.name, persona: pickPersona(), title: x.title, task: x.task,
    parentId: parent.id, homeId,
    ticketId: t ? t.id : null, ticketN: t ? t.n : null, depth: parent.depth + 1,
    cwd: customDef ? parent.cwd : home(def.cwd || '~'),
    staff: true, tickets: t ? [t.id] : [], history: [], feedback: [], tasksDone: 0, tasksFailed: 0,
    taskCostStart: 0, hiredAt: now(), newHire: true, scopeChecked: true,
  });
  onCall.onHire(a, x, t);
  agents.set(a.id, a);
  assignPids();
  parent.children.push(a.id);
  touch(parent);
  touch(a);
  return a;
}

function enqueue(a, prompt, resume) {
  a.status = 'queued';
  touch(a);
  const done = new Promise((resolve) => waiters.set(a.id, resolve));
  queue.push({ a, prompt, resume });
  pump();
  return done;
}

function launch(a, prompt, resume) {
  const roster = readJson('roster.json');
  const args = buildArgs(roster, a);
  pendingFeedback(a).forEach((f) => { f.seen = true; });
  if (resume && a.sessionId) args.push('--resume', a.sessionId);
  a.liveUsd = 0;
  a.status = 'running';
  a.startedAt = a.startedAt || now();
  a.endedAt = null;
  a.error = null;
  touch(a);
  addEvent(a, { kind: resume ? 'followup' : 'brief', text: prompt, ticketId: a.ticketId });

  const child = spawn(CLAUDE_BIN, args, { cwd: a.cwd, env: childEnv(a), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  procs.set(a.id, child);
  child.stdin.end(prompt);
  readLines(child.stdout, (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return addEvent(a, { kind: 'log', text: line }); }
    const r = onStreamMessage(a, m);
    if (r && r.done) {
      a.result = r.text;
      if (r.isError) { a.status = 'failed'; a.error = r.text; } else a.status = 'done';
      touch(a);
    }
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.on('error', (e) => { stderr += e.message; });
  child.on('close', (code) => {
    procs.delete(a.id);
    if (ACTIVE.includes(a.status)) {
      a.status = code === 0 && !a.error ? 'done' : 'failed';
      if (a.status === 'failed' && !a.error) a.error = (stderr.trim() || `exit code ${code}`).slice(-2000);
    }
    if (stderr.trim()) addEvent(a, { kind: 'log', text: stderr.trim().slice(-4000) });
    a.endedAt = now();
    finishStaffTask(a);
    touch(a);
    const w = waiters.get(a.id);
    if (w) { waiters.delete(a.id); w(a); }
    pump();
  });
}

function finishStaffTask(a) {
  a.lastOutcome = a.status;
  try { arms.recordOutcome(a); } catch {}
  if (!a.staff) return;
  if (a.pauseStop) {
    a.pauseStop = false;
    a.lastOutcome = 'paused';
    a.status = 'idle';
    a.history = a.history || [];
    a.history.push({ ticketId: a.ticketId, n: a.ticketN, title: a.title, outcome: 'paused', costUsd: a.costUsd - (a.taskCostStart || 0), model: `${a.model}/${a.effort}`, t: now() });
    return;
  }
  a.history = a.history || [];
  a.history.push({ ticketId: a.ticketId, n: a.ticketN, title: a.title, outcome: a.lastOutcome,
    costUsd: a.costUsd - (a.taskCostStart || 0), model: `${a.model}/${a.effort}`, t: now() });
  if (a.history.length > 60) a.history.splice(0, a.history.length - 60);
  if (a.lastOutcome === 'done') a.tasksDone = (a.tasksDone || 0) + 1;
  else a.tasksFailed = (a.tasksFailed || 0) + 1;
  a.status = 'idle';
  a.newHire = false;
}

function stopTree(id) {
  const a = agents.get(id);
  if (!a) return;
  if (a.resident) {
    if (a.current) restartResident(a.id);
    return;
  }
  for (const c of a.children) stopTree(c);
  const qi = queue.findIndex((q) => q.a.id === id);
  if (qi >= 0) queue.splice(qi, 1);
  if (ACTIVE.includes(a.status)) {
    a.status = 'stopped';
    a.endedAt = now();
    touch(a);
  }
  const p = procs.get(id);
  if (p) { try { process.kill(-p.pid, 'SIGTERM'); } catch { try { p.kill('SIGTERM'); } catch {} } }
  const w = waiters.get(id);
  if (w && !p) { finishStaffTask(a); touch(a); waiters.delete(id); w(a); }
}

async function delegate(parentId, assignments) {
  const parent = agents.get(parentId);
  if (!parent) return { error: 'Unknown agent ' + parentId };
  if (['stopped', 'failed', 'offline'].includes(parent.status)) return { error: 'You are no longer active.' };
  const roster = readJson('roster.json');
  const allowed = childRolesFor(roster, parent);
  const bad = assignments.filter((x) => !allowed.includes(x.role));
  if (bad.length) return { error: `Not allowed to start: ${bad.map((b) => b.role).join(', ')}. Allowed: ${allowed.join(', ') || 'none'}.` };
  const t = ticketOfAgent(parent);
  if (t && t.status === 'stopped') return { error: 'This ticket was stopped by the user.' };
  if (t && t.status === 'paused') return { error: 'The user paused this ticket.' };
  const gate = planGate(roster, parent, t, assignments);
  if (gate) return { error: gate };
  if (t && t.overBudget) {
    parent.progress = `Paused: ticket #${t.n} hit its budget — waiting for the user.`;
    addEvent(parent, { kind: 'progress', text: parent.progress });
    parent.status = 'delegating';
    touch(parent);
    const ok = await waitForBudget(t);
    if (parent.status === 'delegating') { parent.status = 'running'; touch(parent); }
    if (!ok) return { error: 'The user stopped this ticket.' };
  }

  const picks = await Promise.all(assignments.map((x) => arms.decideModel({ roster, cap: modelOf(roster, parent).model, role: x.role,
    roleDef: x.role === 'custom' ? null : roster.roles[x.role], name: x.name, task: `${x.title || ''}\n${x.task || ''}`,
    pin: x.pin_model ? { model: x.model, effort: x.effort, reason: `pinned by ${parent.persona}: ${x.pin_reason || 'no reason given'}` } : null, kind: 'subagent', ticketId: t ? t.id : null })));
  assignments.forEach((x, i) => { x.__pick = picks[i]; });
  const kids = assignments.map((x) => createTemp(roster, parent, x));
  addEvent(parent, { kind: 'delegate', text: kids.map((k) => `${k.persona} (${k.name}) on ${k.model}/${k.effort}: ${k.title}\n  ${k.choice}`).join('\n'), children: kids.map((k) => k.id) });
  if (t) thread(t, { from: parent.id, kind: 'team', text: kids.map((k) => `${k.persona} (${k.name}${k.newHire ? ', new hire' : ''}${k.onCall ? `, on call for ${k.onCall.project || 'this job'}` : ''}) — ${k.title} · ${k.model}/${k.effort}`).join('\n'),
    choices: kids.map((k) => ({ id: k.id, model: `${k.model}/${k.effort}`, why: k.choice })), agents: kids.map((k) => k.id) });
  const batch = { id: newId(), parentId: parent.id, kids,
    all: Promise.all(kids.map((k) => enqueue(k, k.task, false))).then((finished) => finished.map((c) => ({
      id: c.id, role: c.role === 'custom' ? c.name : c.role, persona: c.persona, title: c.title, status: c.lastOutcome, model: `${c.model}/${c.effort}`, why: c.choice,
      result: c.lastOutcome === 'done' ? c.result : `${String(c.lastOutcome).toUpperCase()}: ${c.error || ''}\n${c.result || ''}` }))) };
  batches.set(batch.id, batch);
  return awaitBatch(parent, batch);
}

async function awaitBatch(parent, batch) {
  parent.status = 'delegating';
  touch(parent);
  const r = await new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; mailWake.delete(parent.id); resolve(v); };
    batch.all.then((results) => finish({ results }));
    if (mail.some((m) => m.to === parent.id && !m.read && m.ask)) return finish({ question: true });
    mailWake.set(parent.id, () => finish({ question: true }));
  });
  if (parent.status === 'delegating') { parent.status = 'running'; touch(parent); }
  if (r.results) { batches.delete(batch.id); return { results: r.results }; }
  const still = batch.kids.filter((k) => ACTIVE.includes(k.status)).map((k) => `${k.persona} (${k.name})`);
  return { batchId: batch.id, question: takeUnread(parent.id), waitingOn: still };
}

function waitForTeam(agentId, batchId) {
  const parent = agents.get(agentId);
  const batch = batches.get(batchId);
  if (!parent || !batch || batch.parentId !== agentId) return Promise.resolve({ error: `No team batch "${batchId}" is waiting for you.` });
  return awaitBatch(parent, batch);
}

function assign(agentId, to, brief, effort) {
  const roster = readJson('roster.json');
  const mgr = agents.get(agentId);
  const def = mgr && roster.roles[mgr.role];
  if (!def || !def.assignTo) return { error: 'Only the manager can assign tickets.' };
  if (!def.assignTo.includes(to)) return { error: `Unknown lead ${to}. Leads: ${def.assignTo.join(', ')}` };
  const t = mgr.current && tickets.get(mgr.current.ticketId);
  if (!t) return { error: 'No current ticket to assign.' };
  if (t.status === 'stopped') return { error: 'The user stopped this ticket.' };
  const lead = agents.get(to);
  if (EFFORTS.includes(effort) && t.leadEffortBy !== 'user') { t.leadEffort = effort; t.leadEffortBy = mgr.id; }
  if (!t.pending.includes(to)) t.pending.push(to);
  if (!t.assignees.includes(to)) t.assignees.push(to);
  thread(t, { from: mgr.id, to, kind: 'assign', text: brief });
  broadcast({ type: 'handoff', from: mgr.id, to, kind: 'assign', ticketId: t.id });
  const ahead = enqueueResident(to, { ticketId: t.id, kind: 'ticket',
    text: `[Ticket #${t.n} from ${mgr.persona} (${mgr.name})]\n${brief}${attachText(t.attachments)}\n\n(Your final message goes directly to the user as the answer.)` });
  const busy = ahead > 0 ? ` ${lead.persona} is busy; it is number ${ahead} in their inbox.` : '';
  return { message: `Ticket #${t.n} is with ${lead.persona} (${lead.name}).${busy} They will answer the user directly; you are done with this ticket.` };
}

// ---------------------------------------------------------------- tickets: creation, schedule, attachments

function cleanAttachments(list) {
  return (Array.isArray(list) ? list : []).map(String)
    .filter((f) => path.resolve(f).startsWith(UPLOADS + path.sep) && fs.existsSync(f)).slice(0, 20);
}

function attachText(files) {
  return files && files.length ? `\n\nAttached files (open them with Read; images are shown to you):\n${files.map((f) => `- ${f}`).join('\n')}` : '';
}

function saveUpload(name, buf) {
  const safe = String(name || 'file').replace(/[^\w.\-]+/g, '_').slice(-80) || 'file';
  const dir = path.join(UPLOADS, newId());
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, safe);
  fs.writeFileSync(file, buf);
  return { path: file, name: safe, size: buf.length };
}

function rawBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > max) { reject(new Error('File too large (max 25 MB).')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function createTicket(b) {
  const roster = readJson('roster.json');
  const projects = readJson('projects.json');
  let project = projects.find((x) => x.name === b.project);
  let lead = project && project.department !== roster.root && roster.residents.includes(project.department) && agents.get(project.department);
  let routed = null;
  if (!b.project) {
    const r = routeByRules(b.text, projects, roster);
    if (r.lead && agents.get(r.lead)) {
      lead = agents.get(r.lead);
      project = r.project ? projects.find((x) => x.name === r.project) : null;
      routed = r.reason;
    }
  }
  const chosen = EFFORTS.includes(b.effort) ? b.effort : null;
  const t = newTicket({ text: b.text.trim(), project: project ? project.name : null, direct: lead ? lead.id : null, leadEffort: chosen });
  if (lead && !chosen && EFFORTS.includes(project.leadEffort)) { t.leadEffort = project.leadEffort; t.leadEffortBy = 'project'; }
  t.attachments = cleanAttachments(b.attachments);
  if (b.after === 'reset') {
    const w = limits.windows.five_hour;
    t.status = 'scheduled';
    t.scheduledFor = (w && w.resetsAt > now() ? w.resetsAt : now()) + 60000;
  }
  thread(t, { from: 'user', to: lead ? lead.id : undefined, kind: 'user', text: t.text, attachments: t.attachments });
  if (routed) thread(t, { from: 'system', kind: 'system', text: `Routed to ${lead.persona} by the routing rules (matched ${routed}); God was not needed.` });
  if (t.status !== 'scheduled') dispatchTicket(t);
  return t;
}

function dispatchTicket(t) {
  const roster = readJson('roster.json');
  const project = t.project && readJson('projects.json').find((x) => x.name === t.project);
  const lead = t.direct && agents.get(t.direct);
  t.status = 'open';
  t.scheduledFor = null;
  const att = attachText(t.attachments);
  if (lead) {
    if (!t.pending.includes(lead.id)) t.pending.push(lead.id);
    if (!t.assignees.includes(lead.id)) t.assignees.push(lead.id);
    touchTicket(t);
    enqueueResident(lead.id, { ticketId: t.id, kind: 'direct',
      text: `[Ticket #${t.n} from the user, sent straight to you${project ? ` (project: ${project.name}, ${project.path})` : ''}]\n${t.text}${att}\n\n(Your final message goes directly to the user as the answer, so write it for them.)` });
  } else {
    if (!t.pending.includes(roster.root)) t.pending.push(roster.root);
    touchTicket(t);
    enqueueResident(roster.root, { ticketId: t.id, kind: 'ticket',
      text: `[Ticket #${t.n} from the user]${project ? ` (project: ${project.name}, ${project.path}, owner ${project.department})` : ''}\n${t.text}${att}` });
  }
}

function runSchedule() {
  maybeWeeklyReviews().catch(() => {});
  for (const t of tickets.values()) {
    if (t.status !== 'scheduled' || !t.scheduledFor || t.scheduledFor > now()) continue;
    thread(t, { from: 'system', kind: 'system', text: 'Started after the limit reset.' });
    dispatchTicket(t);
    if (!limits.updatedAt || now() - limits.updatedAt > 300000) probeLimits();
  }
  if (limits.hold && limits.hold.resetsAt < now()) { checkHold(); probeLimits(); }
}

// ---------------------------------------------------------------- tickets: questions to the user

function askUser(agentId, question, options) {
  const a = agents.get(agentId);
  const t = a && ticketOfAgent(a);
  if (!t) return Promise.resolve({ error: 'You have no current ticket to ask about.' });
  if (t.waiting) return Promise.resolve({ error: 'There is already an open question to the user on this ticket. Wait for that answer.' });
  const q = { id: newId(), from: a.id, text: String(question || '').slice(0, 4000),
    options: (Array.isArray(options) ? options : []).slice(0, 6).map((o) => String(o).slice(0, 200)), at: now() };
  t.waiting = q;
  thread(t, { from: a.id, to: 'user', kind: 'question', text: q.text, options: q.options, qid: q.id });
  broadcast({ type: 'notify', kind: 'question', ticketId: t.id, title: `${a.persona} has a question on #${t.n}`, text: q.text });
  a.progress = `Waiting for your answer on ticket #${t.n}.`;
  addEvent(a, { kind: 'progress', text: a.progress });
  touch(a);
  return new Promise((resolve) => userAskWaiters.set(q.id, { resolve }));
}

function answerUser(t, text) {
  const q = t.waiting;
  if (!q) return false;
  t.waiting = null;
  const w = userAskWaiters.get(q.id);
  userAskWaiters.delete(q.id);
  thread(t, { from: 'user', to: q.from, kind: 'reply', text });
  if (w) w.resolve({ message: `The user answered:\n${text}` });
  return true;
}

// ---------------------------------------------------------------- terminal commands (lib/commands.js)

const { commandMode, canRunCommands, runCommand, decideCommand, stopCommand, endCommands, running: commandsRunning } = require('./lib/commands').install({
  agents, tickets, readJson, home, now, newId, broadcast, addEvent,
  touch: (a) => touch(a), touchTicket: (t) => touchTicket(t), thread: (t, e) => thread(t, e), ticketOfAgent: (a) => ticketOfAgent(a),
  defOf: (r, a) => defOf(r, a), expandTools: (r, p) => expandTools(r, p),
});

// ---------------------------------------------------------------- recalling a follow-up the lead has not picked up yet

// Takes the user's latest follow-up on a ticket back out of the lead's inbox, so they can edit it and send it again.
function recallFollowup(t) {
  const last = [...t.thread].reverse().find((e) => e.kind === 'followup');
  if (!last || !last.fid) return { error: 'There is no message to edit.' };
  for (const a of agents.values()) {
    const i = (a.inbox || []).findIndex((x) => x.fid === last.fid);
    if (i < 0) continue;
    const [item] = a.inbox.splice(i, 1);
    t.thread.splice(t.thread.indexOf(last), 1);
    const stillQueued = a.inbox.some((x) => x.ticketId === t.id) || (a.current && a.current.ticketId === t.id);
    if (!stillQueued) {
      t.pending = t.pending.filter((k) => k !== a.id || (item.before && item.before.pending.includes(k)));
      if (item.before && !['open', 'paused'].includes(item.before.status) && !t.pending.length) { t.status = item.before.status; t.closedAt = item.before.closedAt; }
    }
    touch(a);
    touchTicket(t);
    return { text: item.userText != null ? item.userText : last.text, attachments: item.userFiles || last.attachments || [] };
  }
  return { error: 'Already delivered: the agent is reading it, so it can no longer be edited.' };
}

// ---------------------------------------------------------------- tickets: rating, search, archive

function rateTicket(t, score, note) {
  const roster = readJson('roster.json');
  t.rating = { score: score > 0 ? 1 : -1, note: String(note || '').slice(0, 2000), at: now() };
  const leads = [...new Set([t.direct, ...t.assignees].filter(Boolean))].filter((k) => k !== roster.root);
  const text = `The user rated your answer on ticket #${t.n} ("${t.title}") as ${t.rating.score > 0 ? 'GOOD 👍' : 'NOT GOOD 👎'}` +
    (t.rating.note ? `: ${t.rating.note}` : '.') + ' Take the lesson into how you handle similar tickets, and pass it on to teammates where it concerns their part.';
  for (const k of leads) giveFeedback('user', k, text);
  thread(t, { from: 'user', kind: 'rating', score: t.rating.score, text: t.rating.note });
}

function searchTickets(query, excludeId, limit) {
  const terms = [...new Set(String(query || '').toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) || [])];
  if (!terms.length) return [];
  const scored = [];
  for (const t of tickets.values()) {
    if (t.id === excludeId || t.status === 'scheduled') continue;
    const title = t.title.toLowerCase();
    const text = [t.text, t.answer || '', ...t.thread.map((e) => e.text || ''), ...(t.changes || []).map((c) => c.path)].join('\n').toLowerCase();
    let score = 0;
    for (const w of terms) {
      if (title.includes(w)) score += 3;
      score += Math.min(text.split(w).length - 1, 5);
    }
    if (score) scored.push({ t, score });
  }
  return scored.sort((x, y) => y.score - x.score).slice(0, limit || 5).map((x) => x.t);
}

function searchText(query, agentId) {
  const a = agents.get(agentId);
  const cur = a && ticketOfAgent(a);
  const hits = searchTickets(query, cur && cur.id, 5);
  if (!hits.length) return 'No earlier tickets match.';
  return hits.map((t) => {
    const lead = [t.direct, ...t.assignees].filter(Boolean).map((k) => (agents.get(k) || {}).persona).filter(Boolean)[0];
    const files = (t.changes || []).map((c) => c.path).slice(0, 8);
    return `### Ticket #${t.n}: ${t.title}\n${t.status}, ${new Date(t.createdAt).toISOString().slice(0, 10)}` +
      `${t.project ? `, ${t.project}` : ''}${lead ? `, handled by ${lead}` : ''}` +
      `${t.rating ? `, user rated it ${t.rating.score > 0 ? 'good' : 'NOT good'}${t.rating.note ? ` ("${t.rating.note}")` : ''}` : ''}\n` +
      `Request: ${t.text.slice(0, 500)}\n` + (t.answer ? `Answer: ${t.answer.slice(0, 1500)}\n` : '') +
      (files.length ? `Files changed: ${files.join(', ')}\n` : '');
  }).join('\n');
}

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

// ---------------------------------------------------------------- app-only access

const APP_TOKEN = (() => {
  const f = path.join(DATA, 'app-token');
  try { const t = fs.readFileSync(f, 'utf8').trim(); if (t) return t; } catch {}
  const t = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(f, t, { mode: 0o600 });
  return t;
})();
const LOCAL_HOSTS = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];

function tokenMatches(t) {
  const a = Buffer.from(String(t || '')), b = Buffer.from(APP_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function deny(res, code, text) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
  return false;
}

function guard(req, res, url) {
  if (!LOCAL_HOSTS.includes(String(req.headers.host || '').toLowerCase())) return deny(res, 403, 'Blocked.');
  if (url.pathname === '/__app') {
    if (!tokenMatches(url.searchParams.get('t'))) return deny(res, 403, 'Blocked.');
    res.writeHead(302, { 'set-cookie': `agentos=${APP_TOKEN}; Path=/; HttpOnly; SameSite=Strict`, location: '/' });
    res.end();
    return false;
  }
  const cookie = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith('agentos='));
  if (!tokenMatches(req.headers['x-agentos-token']) && !(cookie && tokenMatches(cookie.slice(8)))) {
    return deny(res, 403, 'Agentic OS only opens in its own window. Start it with ./agentos or from the applications menu.');
  }
  const origin = req.headers.origin;
  if (origin && req.method !== 'GET' && req.method !== 'HEAD' && !LOCAL_HOSTS.some((h) => origin === `http://${h}`)) return deny(res, 403, 'Blocked.');
  return true;
}

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

// ---------------------------------------------------------------- pause / resume

function pauseTicket(t) {
  if (t.status !== 'open') return { error: 'Only a ticket in progress can be paused.' };
  endCommands(t);
  endAccess(t);
  t.status = 'paused';
  t.pausedAt = now();
  t.pausedLeads = [];
  releaseBudget(t, false);
  if (t.waiting) {
    userAskWaiters.delete(t.waiting.id);
    t.waiting = null;
  }
  if (t.plan && t.plan.status === 'pending') { planWaiters.delete(t.plan.id); t.plan.status = 'interrupted'; }
  for (const a of agents.values()) {
    if (a.resident && a.current && a.current.ticketId === t.id) {
      t.pausedLeads.push(a.id);
      a.pausing = t.id;
      restartResident(a.id);
    } else if (!a.resident && a.ticketId === t.id && ACTIVE.includes(a.status)) {
      a.pauseStop = true;
      stopTree(a.id);
    }
  }
  thread(t, { from: 'system', kind: 'system', text: 'Paused by you. Nothing runs on this ticket until you resume it.' });
  return { ok: true };
}

function resumeTicket(t) {
  if (t.status !== 'paused') return { error: 'This ticket is not paused.' };
  t.status = 'open';
  const files = (t.changes || []).map((c) => c.path);
  for (const k of t.pausedLeads || []) {
    if (!t.pending.includes(k)) t.pending.push(k);
    enqueueResident(k, { ticketId: t.id, kind: 'direct',
      text: `[Ticket #${t.n} resumed by the user]\nThe user paused this ticket while you were working on it; your teammates were stopped. ` +
        `Continue from where you left off. Re-delegate only what is unfinished (check \`staff\`).` +
        (files.length ? ` Files already changed on this ticket: ${files.join(', ')}.` : '') +
        (t.plan && t.plan.status === 'interrupted' ? ' Your plan was not decided yet; propose it again if you still need it.' : '') });
  }
  t.pausedLeads = [];
  thread(t, { from: 'system', kind: 'system', text: 'Resumed by you.' });
  for (const a of agents.values()) if (a.resident) pumpResident(a);
  return { ok: true };
}

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
  teamState: live(() => teamState),
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

// ---------------------------------------------------------------- health

let claudeVersion = null;
function healthView() {
  const roster = readJson('roster.json');
  if (!claudeVersion) { try { claudeVersion = (spawnSync(CLAUDE_BIN, ['--version'], { encoding: 'utf8', timeout: 8000 }).stdout || '').trim(); } catch { claudeVersion = '?'; } }
  let login = null;
  try {
    const o = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8')).claudeAiOauth || {};
    login = { plan: o.subscriptionType || null, accessExpiresAt: o.expiresAt || null, refreshExpiresAt: o.refreshTokenExpiresAt || null };
  } catch {}
  const since = now() - 48 * 3600000;
  const errors = [];
  for (const a of agents.values()) {
    for (const e of eventsOf(a)) {
      if (e.t < since) continue;
      if (e.kind === 'log' && /error|fail|denied|ENOENT|EACCES|panic/i.test(e.text || '')) errors.push({ t: e.t, who: a.persona, id: a.id, text: String(e.text).slice(0, 400) });
      else if (e.kind === 'result' && e.isError) errors.push({ t: e.t, who: a.persona, id: a.id, text: String(e.text || 'failed').slice(0, 400) });
    }
  }
  const failed = [];
  for (const a of agents.values()) for (const h of a.history || []) if (h.t >= now() - 7 * 86400000 && !['done', 'paused'].includes(h.outcome)) failed.push({ t: h.t, who: a.persona, id: a.id, n: h.n, title: h.title, outcome: h.outcome });
  let logTail = '';
  try { logTail = fs.readFileSync(path.join(DATA, 'server.log'), 'utf8').split('\n').slice(-60).join('\n'); } catch {}
  let dataKb = null;
  try { dataKb = Number((spawnSync('du', ['-sk', DATA], { encoding: 'utf8' }).stdout || '').split(/\s/)[0]) || null; } catch {}
  const residents = roster.residents.map((k) => {
    const a = agents.get(k);
    return a && { id: a.id, persona: a.persona, status: a.status, pid: procs.get(k) ? procs.get(k).pid : null, restarts: a.restarts || 0,
      upSince: a.procStartedAt || null, contextTokens: a.contextTokens || 0, sessionStartedAt: a.sessionStartedAt || null,
      inbox: a.inbox.length, model: a.model, effort: a.effort, needsRefresh: needsRefresh(roster, a) };
  }).filter(Boolean);
  const offline = residents.filter((x) => x.status === 'offline');
  const loginBad = login && login.refreshExpiresAt && login.refreshExpiresAt < now() + 3 * 86400000;
  const level = offline.length || (login && login.refreshExpiresAt && login.refreshExpiresAt < now()) ? 'bad'
    : loginBad || errors.filter((e) => e.t > now() - 24 * 3600000).length || failed.length ? 'warn' : 'ok';
  return { level, server: { startedAt: SERVER_STARTED, node: process.version, claude: claudeVersion, dataKb, host: HOST },
    login, residents, errors: errors.sort((x, y) => y.t - x.t).slice(0, 40), failed: failed.sort((x, y) => y.t - x.t).slice(0, 20),
    limits: { status: limits.status, hold: limits.hold || null, updatedAt: limits.updatedAt },
    refresh: { contextTokens: roster.defaults.refreshContextTokens || 150000, days: roster.defaults.refreshDays || 7 },
    selftest: selftestNow(), logTail,
    scripts: [...agents.values()].filter((x) => x.scriptRuns || x.scriptNudges).map((x) => ({ id: x.id, who: x.persona, runs: x.scriptRuns || 0, nudges: x.scriptNudges || 0 })).sort((x, y) => y.runs - x.runs) };
}

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
  teamState: live(() => teamState),
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

const onCall = require('./lib/on-call').install({ agents, tickets, now, touch: (...a) => touch(...a) });

const brain = require('./lib/brain').install({
  ROOT, DATA, agents, tickets, readJson, home, now, broadcast,
  teamOf: (...a) => teamOf(...a), handoffsOf: (...a) => handoffsOf(...a), projectFolders: (...a) => projectFolders(...a),
  claudeSkillsFor: (...a) => claudeSkillsFor(...a), eventsOf: (...a) => eventsOf(...a), giveFeedback: (...a) => giveFeedback(...a), maybeTidy: (...a) => maybeTidy(...a),
});

// ---------------------------------------------------------------- ARMS (skills, routines, memory, apps)

const arms = require('./arms').install({
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
  let m;
  if (!guard(req, res, url)) return;
  try {
    if (await arms.route(req, res, url, p, body, json)) return;
    if (await skillProposals.route(req, res, url, p, body, json)) return;
    if (await brain.route(req, res, url, p, body, json)) return;
    if (req.method === 'POST' && p === '/api/shutdown') {
      json(res, 200, { ok: true });
      setTimeout(() => shutdown(), 150);
      return;
    }
    if (req.method === 'POST' && p === '/api/tokens/save-csv') {
      const q = await body(req);
      const dir = fs.existsSync(path.join(os.homedir(), 'Downloads')) ? path.join(os.homedir(), 'Downloads') : os.homedir();
      const file = path.join(dir, `agentic-os-tokens-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.csv`);
      fs.writeFileSync(file, await usageIndex.csv(q || {}));
      return json(res, 200, { file });
    }
    if (req.method === 'GET' && p.startsWith('/api/tokens/')) {
      const q = Object.fromEntries(url.searchParams);
      if (p === '/api/tokens/overview') return json(res, 200, await usageIndex.overview(q));
      if (p === '/api/tokens/calls') return json(res, 200, await usageIndex.calls(q));
      if (p === '/api/tokens/live') return json(res, 200, await usageIndex.liveChats(Number(q.min) || 300000));
      if (p === '/api/tokens/cache') return json(res, 200, await usageIndex.cacheRead(q));
      if (p === '/api/tokens/export.csv') { res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="agentic-os-tokens.csv"' }); return res.end(await usageIndex.csv(q)); }
      if ((m = p.match(/^\/api\/tokens\/session\/([0-9a-f-]{8,})$/))) { const r = await usageIndex.session(m[1], q); return r ? json(res, 200, r) : json(res, 404, { error: 'no such session' }); }
    }
    if (req.method === 'GET' && (p === '/review' || p.startsWith('/ui/'))) {
      const f = p === '/review' ? path.join(ROOT, 'public', 'review.html') : path.resolve(ROOT, 'public', p.slice(1));
      if (!f.startsWith(path.join(ROOT, 'public') + path.sep) || !fs.existsSync(f)) return json(res, 404, { error: 'not found' });
      const font = f.endsWith('.woff2');
      res.writeHead(200, { 'content-type': f.endsWith('.css') ? 'text/css' : f.endsWith('.js') ? 'text/javascript' : font ? 'font/woff2' : f.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8', 'cache-control': font ? 'max-age=31536000' : 'no-cache' });
      return res.end(fs.readFileSync(f));
    }
    if (req.method === 'GET' && p.startsWith('/artifacts/')) {
      const f = path.resolve(ROOT, 'artifacts', decodeURIComponent(p.slice('/artifacts/'.length)) || 'index.html');
      const target = fs.existsSync(f) && fs.statSync(f).isDirectory() ? path.join(f, 'index.html') : f;
      if (!target.startsWith(path.join(ROOT, 'artifacts') + path.sep) || !fs.existsSync(target)) return json(res, 404, { error: 'not found' });
      const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.pdf': 'application/pdf' };
      res.writeHead(200, { 'content-type': types[path.extname(target)] || 'text/plain; charset=utf-8' });
      return res.end(fs.readFileSync(target));
    }
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(fs.readFileSync(path.join(ROOT, 'public', 'os.html')));
    }
    if (req.method === 'GET' && p === '/icon.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=3600' });
      return res.end(fs.readFileSync(path.join(ROOT, 'public', 'icon.svg')));
    }
    if (req.method === 'GET' && p === '/api/scripts') return json(res, 200, scriptManifest());
    if (req.method === 'GET' && p === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': hi\n\n');
      clients.add(res);
      const ka = setInterval(() => res.write(': ka\n\n'), 20000);
      req.on('close', () => { clients.delete(res); clearInterval(ka); });
      return;
    }
    if (req.method === 'GET' && p === '/api/limits') return json(res, 200, limitsView());
    if (req.method === 'POST' && p === '/api/limits/refresh') {
      await probeLimits();
      return json(res, 200, limitsView());
    }
    if (req.method === 'GET' && p === '/api/state') {
      const roster = readJson('roster.json');
      return json(res, 200, {
        limits: limitsView(),
        agents: [...agents.values()].map(summary),
        tickets: [...tickets.values()],
        residents: roster.residents,
        root: roster.root,
        roles: Object.fromEntries(Object.entries(roster.roles).map(([k, v]) => [k, { name: v.name, persona: v.persona, room: v.room, description: v.description, handoffs: !!v.handoffs }])),
        projects: readJson('projects.json'),
        restart: restartView(),
      });
    }
    if (req.method === 'GET' && p === '/api/prompt-size') return json(res, 200, await promptSizes());
    if (req.method === 'GET' && p === '/api/restart') return json(res, 200, restartView());
    if (req.method === 'POST' && p === '/api/restart') {
      const b = await body(req);
      return json(res, 200, requestRestart(b.when !== 'cancel', { check: b.check !== false }));
    }
    if (req.method === 'GET' && p === '/api/office-settings') {
      const d = readJson('roster.json').defaults;
      return json(res, 200, Object.fromEntries(Object.keys(OFFICE_SETTINGS).map((k) => [k, d[k] ?? null])));
    }
    if (req.method === 'POST' && p === '/api/office-settings') {
      const b = await body(req);
      const r = readJson('roster.json');
      for (const [k, fix] of Object.entries(OFFICE_SETTINGS)) if (k in b) r.defaults[k] = fix(b[k]);
      writeRoster(r);
      return json(res, 200, Object.fromEntries(Object.keys(OFFICE_SETTINGS).map((k) => [k, r.defaults[k] ?? null])));
    }
    if (req.method === 'GET' && (m = p.match(/^\/api\/agents\/(\w[\w-]*)\/events$/))) {
      const a = agents.get(m[1]);
      const limit = Number(url.searchParams.get('limit') || 400);
      return a ? json(res, 200, eventsOf(a).slice(-limit)) : json(res, 404, { error: 'not found' });
    }
    if (req.method === 'POST' && p === '/api/tasks') {
      const b = await body(req);
      if (!b.text || !b.text.trim()) return json(res, 400, { error: 'empty task' });
      return json(res, 200, { id: createTicket(b).id });
    }
    if (req.method === 'POST' && p === '/api/uploads') {
      const buf = await rawBody(req, 25 << 20);
      return json(res, 200, saveUpload(url.searchParams.get('name'), buf));
    }
    if (req.method === 'GET' && p.startsWith('/api/uploads/')) {
      const file = path.resolve(UPLOADS, decodeURIComponent(p.slice('/api/uploads/'.length)));
      if (!file.startsWith(UPLOADS + path.sep) || !fs.existsSync(file)) return json(res, 404, { error: 'not found' });
      const ext = path.extname(file).toLowerCase();
      const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf' };
      res.writeHead(200, { 'content-type': types[ext] || 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff',
        'content-disposition': types[ext] ? 'inline' : `inline; filename="${path.basename(file)}"` });
      return res.end(fs.readFileSync(file));
    }
    if (req.method === 'GET' && p === '/api/search') {
      const hits = searchTickets(url.searchParams.get('q'), null, 20).map((t) => t.id);
      return json(res, 200, { ids: hits, text: url.searchParams.get('agentId') ? searchText(url.searchParams.get('q'), url.searchParams.get('agentId')) : undefined });
    }
    if (req.method === 'POST' && p === '/api/ask-user') {
      const b = await body(req);
      return json(res, 200, await askUser(b.agentId, b.question, b.options));
    }
    if (req.method === 'POST' && p === '/api/files/before') {
      const b = await body(req);
      const deny = denyEdit(b.agentId, b.file);
      if (deny) return json(res, 200, { deny });
      snapshotBefore(b.agentId, b.file);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && (m = p.match(/^\/api\/tickets\/(\w+)\/changes$/))) {
      const t = tickets.get(m[1]);
      return t ? json(res, 200, changesOf(t)) : json(res, 404, { error: 'not found' });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/tickets\/(\w+)\/revert$/))) {
      const t = tickets.get(m[1]);
      const b = await body(req);
      if (!t) return json(res, 404, { error: 'not found' });
      const reverted = revertChanges(t, b.path || null);
      if (reverted && (!Array.isArray(reverted) || reverted.length)) { t.undone = (t.undone || 0) + 1; touchTicket(t); }
      return json(res, 200, { reverted });
    }
    if (req.method === 'GET' && (m = p.match(/^\/api\/tickets\/(\w+)\/timeline$/))) {
      const t = tickets.get(m[1]);
      return t ? json(res, 200, timelineOf(t)) : json(res, 404, { error: 'not found' });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/tickets\/(\w+)\/rate$/))) {
      const t = tickets.get(m[1]);
      const b = await body(req);
      if (!t) return json(res, 404, { error: 'not found' });
      rateTicket(t, Number(b.score) || 1, b.note);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/tickets\/(\w+)\/archive$/))) {
      const t = tickets.get(m[1]);
      const b = await body(req);
      if (!t) return json(res, 404, { error: 'not found' });
      t.archived = b.archived !== false;
      touchTicket(t);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/tickets\/(\w+)\/start$/))) {
      const t = tickets.get(m[1]);
      if (!t || t.status !== 'scheduled') return json(res, 404, { error: 'not a scheduled ticket' });
      thread(t, { from: 'system', kind: 'system', text: 'Started now by you.' });
      dispatchTicket(t);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/limits/continue') {
      continuePastLimit();
      return json(res, 200, limitsView());
    }
    if (req.method === 'GET' && p === '/api/spend') return json(res, 200, spendStats());
    if (req.method === 'POST' && p === '/api/propose-plan') {
      const b = await body(req);
      return json(res, 200, await proposePlan(b.agentId, b.plan, b.estimateUsd));
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/tickets\/(\w+)\/plan$/))) {
      const t = tickets.get(m[1]);
      const b = await body(req);
      return t ? json(res, 200, decidePlan(t, b.decision, b.note)) : json(res, 404, { error: 'not found' });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/tickets\/(\w+)\/(pause|resume)$/))) {
      const t = tickets.get(m[1]);
      if (!t) return json(res, 404, { error: 'not found' });
      const r = m[2] === 'pause' ? pauseTicket(t) : resumeTicket(t);
      return json(res, r.error ? 400 : 200, r);
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/agents\/(\w[\w-]*)\/review$/))) {
      const r = await runReview(m[1]);
      return json(res, r.error ? 400 : 200, r);
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/agents\/(\w[\w-]*)\/scope$/))) {
      const r = onCall.setScope(m[1], !!(await body(req)).team);
      return json(res, r.error ? 400 : 200, r);
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/agents\/(\w[\w-]*)\/refresh$/))) {
      const a = agents.get(m[1]);
      if (!a || !a.resident) return json(res, 404, { error: 'not a lead' });
      const queued = maybeRefresh(a, true);
      pumpResident(a);
      return json(res, 200, { ok: queued });
    }
    if (req.method === 'GET' && p === '/api/config') return json(res, 200, configView());
    if (req.method === 'POST' && p === '/api/config/role') {
      const r = saveRole(await body(req));
      return json(res, r.error ? 400 : 200, r);
    }
    if (req.method === 'DELETE' && (m = p.match(/^\/api\/config\/role\/([\w-]+)$/))) {
      const r = deleteRole(m[1]);
      return json(res, r.error ? 400 : 200, r);
    }
    if (req.method === 'POST' && p === '/api/config/team') {
      const r = createTeam(await body(req));
      return json(res, r.error ? 400 : 200, r);
    }
    if (req.method === 'GET' && (m = p.match(/^\/api\/teams\/([\w-]+)\/chat$/))) return json(res, 200, teamChat(m[1]));
    if (req.method === 'POST' && (m = p.match(/^\/api\/teams\/([\w-]+)\/ask$/))) {
      const b = await body(req);
      if (!b.text || !b.text.trim()) return json(res, 400, { error: 'empty' });
      const r = askTeam(m[1], b.text);
      return json(res, r.error ? 400 : 200, r);
    }
    if (req.method === 'GET' && p === '/api/health') return json(res, 200, healthView());
    if (req.method === 'POST' && p === '/api/script-nudge') {
      const b = await body(req);
      const a = agents.get(b.agentId);
      if (a) { a.scriptNudges = (a.scriptNudges || 0) + 1; addEvent(a, { kind: 'script-nudge', name: b.script }); }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/script') {
      const b = await body(req);
      return json(res, 200, await runScript(b.agentId, b.name, b.args));
    }
    if (req.method === 'POST' && p === '/api/selftest') {
      if (selftestNow() && selftestNow().status === 'running') return json(res, 409, { error: 'A self-test is already running.' });
      runSelfTest();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/tickets\/(\w+)\/message$/))) {
      const t = tickets.get(m[1]);
      const b = await body(req);
      if (!t || !b.text) return json(res, 404, { error: 'not found' });
      const files = cleanAttachments(b.attachments);
      if (t.waiting) {
        answerUser(t, b.text + attachText(files));
        return json(res, 200, { ok: true, answered: true });
      }
      const roster = readJson('roster.json');
      const before = { status: t.status, closedAt: t.closedAt, pending: [...t.pending] };
      // A follow-up within 2 hours of the answer counts as rework: the answer was not what the user needed.
      if (['done', 'failed'].includes(t.status) && t.closedAt && now() - t.closedAt < 2 * 3600000) t.rework = (t.rework || 0) + 1;
      reopen(t);
      const fid = newId();
      thread(t, { from: 'user', kind: 'followup', text: b.text, attachments: files, fid });
      const to = t.direct || (t.assignees.length === 1 ? t.assignees[0] : roster.root);
      if (!t.pending.includes(to)) t.pending.push(to);
      touchTicket(t);
      enqueueResident(to, { ticketId: t.id, fid, before, userText: b.text, userFiles: files, kind: to === roster.root ? 'followup' : 'direct',
        text: to === roster.root
          ? `[User follow-up on ticket #${t.n}: "${t.title}", handled by ${t.assignees.map((k) => agents.get(k).persona + ' (' + k + ')').join(', ') || 'nobody yet'}]\n${b.text}${attachText(files)}`
          : `[User follow-up on ticket #${t.n}]\n${b.text}${attachText(files)}` });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/tickets\/(\w+)\/recall$/))) {
      const t = tickets.get(m[1]);
      return json(res, 200, t ? recallFollowup(t) : { error: 'not found' });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/tickets\/(\w+)\/stop$/))) {
      const t = tickets.get(m[1]);
      if (t) stopTicket(t);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'DELETE' && (m = p.match(/^\/api\/tickets\/(\w+)$/))) {
      const t = tickets.get(m[1]);
      if (!t) return json(res, 404, { error: 'not found' });
      if (t.status === 'open') stopTicket(t);
      for (const a of agents.values()) {
        if (!a.staff) continue;
        a.tickets = (a.tickets || []).filter((id) => id !== t.id);
        if (a.ticketId === t.id) { a.ticketId = null; a.ticketN = null; }
        touch(a);
      }
      tickets.delete(t.id);
      saveState();
      broadcast({ type: 'ticketRemoved', id: t.id });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/agents\/(\w[\w-]*)\/message$/))) {
      const a = agents.get(m[1]);
      const b = await body(req);
      if (!a || !b.text) return json(res, 404, { error: 'not found' });
      if (a.resident) {
        const t = newTicket({ text: b.text.trim(), direct: a.id });
        thread(t, { from: 'user', to: a.id, kind: 'user', text: t.text });
        t.pending.push(a.id);
        t.assignees.push(a.id);
        touchTicket(t);
        enqueueResident(a.id, { ticketId: t.id, kind: 'direct', text: `[Direct message from the user, ticket #${t.n}]\n${t.text}` });
        return json(res, 200, { ticketId: t.id });
      }
      if (ACTIVE.includes(a.status)) return json(res, 409, { error: `${a.persona} is busy; wait or stop them first.` });
      if (!a.sessionId) return json(res, 409, { error: 'No session to continue.' });
      a.taskCostStart = a.costUsd;
      enqueue(a, b.text, true);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/agents\/(\w[\w-]*)\/stop$/))) {
      stopTree(m[1]);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/agents\/(\w[\w-]*)\/reset$/))) {
      const a = agents.get(m[1]);
      if (!a || !a.resident) return json(res, 404, { error: 'not a resident' });
      a.sessionId = null;
      a.resetting = true;
      addEvent(a, { kind: 'system', text: 'Memory reset by the user.' });
      restartResident(a.id);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'PUT' && p === '/api/projects') {
      const b = await body(req);
      if (!Array.isArray(b)) return json(res, 400, { error: 'expected array' });
      fs.writeFileSync(path.join(ROOT, 'projects.json'), JSON.stringify(b, null, 2) + '\n');
      broadcast({ type: 'roster' });
      restartWhenIdle(readJson('roster.json').root);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/memory') {
      const b = await body(req);
      return json(res, 200, writeMemory(b.agentId, b.content));
    }
    if (req.method === 'GET' && (m = p.match(/^\/api\/agents\/(\w[\w-]*)\/memory$/))) {
      return json(res, 200, { text: readMemory(m[1]) });
    }
    if (req.method === 'POST' && p === '/api/feedback') {
      const b = await body(req);
      return json(res, 200, giveFeedback(b.agentId, b.to, b.text));
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/agents\/(\w[\w-]*)\/feedback$/))) {
      const b = await body(req);
      const r = giveFeedback('user', m[1], b.text);
      return json(res, r.error ? 400 : 200, r);
    }
    if (req.method === 'GET' && p === '/api/staff') {
      return json(res, 200, { text: staffList(url.searchParams.get('agentId')) });
    }
    if (req.method === 'POST' && p === '/api/files/touch') {
      const b = await body(req);
      return json(res, 200, { warning: touchFile(b.agentId, b.file) });
    }
    if (req.method === 'GET' && (m = p.match(/^\/api\/teams\/([\w-]+)\/check$/))) {
      const roster = readJson('roster.json');
      const def = roster.roles[m[1]];
      if (!def || !def.team) return json(res, 404, { error: 'no library' });
      return json(res, 200, { text: libraryCheck.report(libraryCheck.check(path.join(ROOT, def.team.docs), libraryRoots(roster, m[1]))) });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/teams\/([\w-]+)\/tidy$/))) {
      const queued = maybeTidy(m[1], true);
      const st = teamState[m[1]] || {};
      return json(res, 200, queued ? { ok: true, message: 'The library check found problems; the lead is fixing them.' }
        : st.lastFound && !st.lastFound.dups && !st.lastFound.refs ? { ok: true, message: 'The library check found nothing to fix: no duplicates, all references still match the code.' }
        : { error: 'Could not run a tidy-up right now (the lead is busy, or one is already queued).' });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/tickets\/(\w+)\/budget$/))) {
      const t = tickets.get(m[1]);
      const b = await body(req);
      if (!t) return json(res, 404, { error: 'not found' });
      const add = Math.max(0, Number(b.add) || 0);
      t.budgetUsd = (t.budgetUsd || ticketBudget() || 0) + add;
      if (t.overBudget && (t.costUsd || 0) < t.budgetUsd) {
        t.overBudget = false;
        thread(t, { from: 'system', kind: 'system', text: `Budget raised to $${t.budgetUsd.toFixed(2)}. Work continues.` });
        releaseBudget(t, true);
      }
      touchTicket(t);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && p === '/api/mail/unread') {
      return json(res, 200, { text: takeUnread(url.searchParams.get('agentId')) });
    }
    if (req.method === 'POST' && p === '/api/mail/send') {
      const b = await body(req);
      const r = sendMail(b.agentId, b.to, b.text, b.replyTo, false);
      return json(res, 200, r.error ? { error: r.error } : { message: `Delivered to ${r.to.persona}.` });
    }
    if (req.method === 'POST' && p === '/api/mail/ask') {
      const b = await body(req);
      return json(res, 200, await ask(b.agentId, b.to, b.question, b.timeoutSec));
    }
    if (req.method === 'GET' && p === '/api/colleagues') {
      return json(res, 200, { text: colleagues(url.searchParams.get('agentId')) });
    }
    if (req.method === 'POST' && p === '/api/docs/add') {
      const b = await body(req);
      return json(res, 200, addToDocs(b.agentId, b.page, b.text || ''));
    }
    if (req.method === 'GET' && p === '/api/projects-board') {
      return json(res, 200, projectsBoard());
    }
    if (req.method === 'POST' && p === '/api/open-file') {
      const b = await body(req);
      return json(res, 200, openFile(b.path, b.ticketId));
    }
    if (req.method === 'POST' && p === '/api/command/run') {
      const b = await body(req);
      return json(res, 200, await runCommand(b.agentId, b));
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/commands\/(\w+)\/(decide|stop)$/))) {
      const b = await body(req);
      return json(res, 200, m[2] === 'stop' ? stopCommand(m[1]) : decideCommand(m[1], b.decision === 'run' ? 'run' : 'deny', b.note, !!b.allowAll));
    }
    if (req.method === 'POST' && p === '/api/edit-access/request') {
      const b = await body(req);
      return json(res, 200, await requestAccess(b.agentId, b.folder, b.reason));
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/edit-access\/(\w+)\/decide$/))) {
      const b = await body(req);
      return json(res, 200, decideAccess(tickets, m[1], b.decision === 'allow'));
    }
    if (req.method === 'GET' && p === '/api/terminal-mode') {
      return json(res, 200, { mode: commandMode(readJson('roster.json')) });
    }
    if (req.method === 'POST' && p === '/api/terminal-mode') {
      const b = await body(req);
      if (!['off', 'ask', 'allow'].includes(b.mode)) return json(res, 400, { error: 'mode must be off, ask or allow' });
      const r = readJson('roster.json');
      r.defaults.terminalCommands = b.mode;
      writeRoster(r);
      for (const a of agents.values()) if (a.resident && canRunCommands(r, a)) a.restartWhenIdle = true;
      return json(res, 200, { mode: b.mode });
    }
    if (req.method === 'POST' && p === '/api/handoff/save') {
      const b = await body(req);
      return json(res, 200, saveHandoff(b.agentId, b.project, b.state, b.session));
    }
    if (req.method === 'GET' && p === '/api/teams') {
      return json(res, 200, teamsList());
    }
    if (req.method === 'GET' && p === '/api/teams/page') {
      const file = path.resolve(url.searchParams.get('path') || '');
      const ok = teamsList().some((t) => t.pages.some((pg) => pg.path === file));
      if (!ok) return json(res, 404, { error: 'not a library page' });
      return json(res, 200, { path: file, text: fs.readFileSync(file, 'utf8') });
    }
    if (req.method === 'POST' && p === '/api/assign') {
      const b = await body(req);
      return json(res, 200, assign(b.agentId, b.to, b.brief || '', b.effort));
    }
    if (req.method === 'POST' && p === '/api/wait') {
      const b = await body(req);
      return json(res, 200, await waitForTeam(b.agentId, b.batchId));
    }
    if (req.method === 'POST' && p === '/api/delegate') {
      const b = await body(req);
      return json(res, 200, await delegate(b.parentId, b.assignments || []));
    }
    if (req.method === 'POST' && p === '/api/progress') {
      const b = await body(req);
      const a = agents.get(b.agentId);
      if (a) {
        a.progress = b.status;
        if (typeof b.percent === 'number') a.percent = Math.max(0, Math.min(100, b.percent));
        const pt = typeof b.step === 'number' && a.resident && ticketOfAgent(a);
        if (pt && pt.plan) { pt.plan.step = Math.max(1, Math.round(b.step)); touchTicket(pt); }
        addEvent(a, { kind: 'progress', text: b.status, percent: a.percent });
        touch(a);
      }
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});
server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;

loadState();
if (onCall.migrate()) saveState();
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
for (const t of tickets.values()) {
  if (t.status === 'open') {
    const stillQueued = [...agents.values()].some((a) => a.resident && a.inbox.some((i) => i.ticketId === t.id));
    if (!stillQueued) { t.status = 'interrupted'; t.pending = []; }
  }
}
server.listen(PORT, HOST, () => {
  console.log(`Agentic OS running at http://127.0.0.1:${PORT}`);
  for (const key of readJson('roster.json').residents) startResident(key);
  if (!limits.updatedAt || now() - limits.updatedAt > 600000) probeLimits();
});
// ---------------------------------------------------------------- where agents may edit (lib/edit-scope.js)

const { denyEdit, requestAccess, decideAccess, endAccess } = require('./lib/edit-scope').install({
  agents, readJson, home, now, newId, broadcast, addEvent,
  touch: (...a) => touch(...a), touchTicket: (...a) => touchTicket(...a), thread: (...a) => thread(...a), ticketOfAgent: (...a) => ticketOfAgent(...a),
  teamOf: (...a) => teamOf(...a), handoffsOf: (...a) => handoffsOf(...a), projectsMentioned: (...a) => projectsMentioned(...a),
});

// ---------------------------------------------------------------- upkeep: reminders, restart when idle, office settings (lib/upkeep.js)

const { restartView, requestRestart, OFFICE_SETTINGS, isRestartPending } = require('./lib/upkeep').install({
  ROOT, agents, tickets, readJson, now, broadcast, ACTIVE, commandsRunning,
  pumpResident: (a) => pumpResident(a), pump: () => pump(), isShuttingDown: () => shuttingDown, shutdown: () => shutdown(),
});

const shutdown = () => {
  shuttingDown = true;
  for (const [id, p] of procs) { try { process.kill(-p.pid, 'SIGTERM'); } catch {} }
  saveNow();
  try { fs.writeFileSync(LIMITS_FILE, JSON.stringify(limits)); } catch {}
  setTimeout(() => process.exit(0), 400);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
