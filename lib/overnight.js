'use strict';
// Overnight mode: queue up jobs, press "Work while I sleep", and the office works through them, a few at a time, around
// the plan's usage limits and a spending cap for the run. A job that needs the user waits and frees its slot, so the rest
// carry on. In the morning there is one report: what's done, what's waiting, what never started and what it cost.
//
// Queued jobs are scheduled jobs with no start time (heldBy 'night'). The run ends when nothing is left that can start and
// nothing is working, when the finish time passes and the jobs in progress are done, or when the user stops it. Reaching
// the cap pauses the jobs in progress (Resume continues them), so spending can pass the cap by what was in flight when
// the last check ran. Spend is measured at API prices, the same figure jobs show.
//
// Limits and the daily spending limit don't end a run: nothing new starts until they clear, or the finish time passes.

const MAX_PAST = 10;
const MAX_CONCURRENCY = 4;
const REPORT_TITLE_CHARS = 70;

// A job that can't move until the user does something. It spends nothing and doesn't take a slot.
const needsUser = (t) => !!(t.waiting || (t.plan && t.plan.status === 'pending') || (t.overBudget && t.status === 'open')
  || (t.commands || []).some((c) => c.status === 'pending') || (t.access || []).some((r) => r.status === 'pending'));

const whyWaiting = (t) => (t.waiting ? 'a question' : t.plan && t.plan.status === 'pending' ? 'a plan to approve' : t.overBudget ? 'over its budget'
  : (t.commands || []).some((c) => c.status === 'pending') ? 'a command to approve' : (t.access || []).some((r) => r.status === 'pending') ? 'edit access to approve' : 'something from you');

function defaultUntil(now) {
  const d = new Date(now);
  d.setHours(8, 0, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function install(ctx) {
  const { broadcast, DATA, dispatchTicket, fs, limits, now, path, pauseTicket, readJson, spawn, thread, tickets, touchTicket } = ctx;
  const FILE = path.join(DATA, 'overnight.json');
  let state = { queue: [], run: null, last: null, past: [] };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {}
  let awakeProc = null;
  let awakeFailed = false;

  function save() {
    try {
      fs.mkdirSync(DATA, { recursive: true });
      const tmp = `${FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, FILE);
    } catch (e) { console.error('overnight: could not save', e.message); }
  }

  function changed() {
    save();
    broadcast({ type: 'overnight', overnight: view() });
  }

  // ---------------------------------------------------------------- keeping the computer awake (best effort)

  function keepAwake(until) {
    if (awakeProc || ctx.noKeepAwake) return;
    const secs = String(Math.max(60, Math.ceil((until - now()) / 1000) + 3600));
    const cmd = process.platform === 'darwin' ? ['caffeinate', ['-i', '-t', secs]]
      : process.platform === 'linux' ? ['systemd-inhibit', ['--what=sleep:idle', '--who=Agentic OS', '--why=Working through the overnight queue', 'sleep', secs]] : null;
    if (!cmd) { awakeFailed = true; return; }
    try {
      const child = spawn(cmd[0], cmd[1], { stdio: 'ignore' });
      awakeProc = child;
      awakeFailed = false;
      child.on('error', () => { awakeFailed = true; awakeProc = null; changed(); });
      child.on('close', (code) => {
        if (awakeProc !== child) return;
        awakeProc = null;
        if (code && state.run) { awakeFailed = true; changed(); }
      });
    } catch { awakeFailed = true; }
  }
  function letSleep() {
    const p = awakeProc;
    awakeProc = null;
    if (p) { try { p.kill(); } catch {} }
  }

  // ---------------------------------------------------------------- the queue

  function enqueue(t) {
    t.status = 'scheduled';
    t.scheduledFor = null;
    t.heldBy = 'night';
    t.night = true;
    state.queue.push(t.id);
    thread(t, { from: 'system', kind: 'system', text: state.run ? 'Added to tonight\'s run.' : 'Queued for overnight. It starts when you press Work while I sleep, or Start now.' });
    changed();
    if (state.run) setImmediate(tick);
  }

  // Only jobs still waiting to start: one started by hand, stopped or deleted drops out.
  function tidyQueue() {
    state.queue = state.queue.filter((id) => { const t = tickets.get(id); return t && t.status === 'scheduled' && t.heldBy === 'night'; });
  }

  const blockedByChain = (t) => !!(t.afterJob && !t.afterMet);

  function move(id, dir) {
    tidyQueue();
    const i = state.queue.indexOf(id);
    const j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= state.queue.length) return { ok: true };
    [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
    changed();
    return { ok: true };
  }

  // ---------------------------------------------------------------- the run

  const spentOf = (r) => Object.keys(r.base || {}).reduce((n, id) => { const t = tickets.get(id); return n + (t ? Math.max(0, (t.costUsd || 0) - r.base[id]) : 0); }, 0);
  const started = (r) => Object.keys(r.base || {}).map((id) => tickets.get(id)).filter(Boolean);
  const working = (r) => started(r).filter((t) => t.status === 'open' && !needsUser(t));

  function holdReason() {
    if (limits.hold && limits.hold.resetsAt > now()) return { why: 'limit', until: limits.hold.resetsAt, window: limits.hold.window };
    const cap = Number(readJson('roster.json').defaults.dailySpendUsd) || 0;
    const today = limits.day === new Date(now()).toDateString() ? limits.daySpend || 0 : 0;
    if (cap && today >= cap) return { why: 'daily' };
    return null;
  }

  function start(b) {
    if (state.run) return { error: 'A run is already going.' };
    const capUsd = Number(b.capUsd);
    if (!(capUsd > 0)) return { error: 'Set a spending cap for the night.' };
    tidyQueue();
    if (!state.queue.length) return { error: 'The queue is empty. Add jobs to it first.' };
    const until = b.until ? Number(b.until) : defaultUntil(now());
    if (!(until > now())) return { error: 'The finish time has to be in the future.' };
    const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, Math.round(Number(b.concurrency) || 2)));
    state.run = { id: `n${now()}`, startedAt: now(), capUsd, until, concurrency, autoPlansUsd: Math.max(0, Number(b.autoPlansUsd) || 0), base: {}, capped: false, hold: null };
    keepAwake(until);
    changed();
    tick();
    return { ok: true };
  }

  function stop() {
    if (!state.run) return { error: 'Nothing is running.' };
    finish('stopped');
    return { ok: true };
  }

  function finish(reason) {
    const r = state.run;
    if (!r) return;
    r.endedAt = now();
    r.reason = reason;
    r.spentUsd = spentOf(r);
    state.last = r;
    state.past = [r, ...state.past].slice(0, MAX_PAST);
    state.run = null;
    letSleep();
    const rep = reportOf(r);
    const t = `${rep.done.length} done, ${rep.waiting.length} waiting for you, ${rep.notFinished.length} not finished, ${rep.notStarted.length} not started. $${rep.spentUsd.toFixed(2)} of $${r.capUsd.toFixed(2)}.`;
    broadcast({ type: 'notify', kind: 'overnight', title: 'The overnight run is finished', text: t });
    if (ctx.telegram && ctx.telegram.say) ctx.telegram.say(telegramText(rep));
    changed();
  }

  function pauseWorking(r) {
    for (const t of working(r)) {
      const res = pauseTicket(t);
      if (!res.error) thread(t, { from: 'system', kind: 'system', text: `Paused: the overnight run reached its $${r.capUsd.toFixed(2)} cap. Press Resume to continue this job.` });
      touchTicket(t);
    }
  }

  // Runs on the schedule timer, when a job closes or changes, and when the run starts. Safe to call at any time.
  function tick() {
    const r = state.run;
    if (!r) return;
    const atTime = now();
    tidyQueue();
    let dirty = false;
    if (!r.capped && spentOf(r) >= r.capUsd) {
      r.capped = true;
      dirty = true;
      pauseWorking(r);
    }
    const hold = holdReason();
    if (JSON.stringify(hold) !== JSON.stringify(r.hold)) { r.hold = hold; dirty = true; }
    const open = !r.capped && atTime < r.until;
    const ready = () => state.queue.filter((id) => !blockedByChain(tickets.get(id)));
    if (open && !hold) {
      let slots = r.concurrency - working(r).length;
      for (const id of ready()) {
        if (slots <= 0) break;
        const t = tickets.get(id);
        r.base[t.id] = t.costUsd || 0;
        state.queue = state.queue.filter((x) => x !== id);
        thread(t, { from: 'system', kind: 'system', text: 'Started by the overnight run.' });
        dispatchTicket(t);
        slots--;
        dirty = true;
      }
    }
    // A job waiting on the user frees its slot, but its lead may be holding the job meant for the next desk.
    if (ctx.kick) ctx.kick();
    const stillWorking = working(r).length > 0;
    const chainCanFinish = state.queue.some((id) => { const t = tickets.get(id); const p = t.afterJob && tickets.get(t.afterJob.id); return p && p.status === 'open' && !needsUser(p); });
    if (!stillWorking && !(open && (ready().length || chainCanFinish))) {
      finish(r.capped ? 'cap' : atTime >= r.until ? 'time' : 'empty');
      return;
    }
    if (dirty || stillWorking) changed();
  }

  // Plans under the amount the user chose for the night go ahead without them (lib/plans.js).
  function approves(t, p) {
    const r = state.run;
    if (!r || !t.night || r.base[t.id] == null || !r.autoPlansUsd || p.estimateUsd > r.autoPlansUsd) return null;
    if (spentOf(r) + p.estimateUsd > r.capUsd) return null;
    return `approved automatically: the overnight run approves plans up to $${r.autoPlansUsd}, and it fits under the cap`;
  }

  // ---------------------------------------------------------------- the report

  function row(t, r) {
    return { id: t.id, n: t.n, title: t.title, status: t.status, costUsd: Math.max(0, (t.costUsd || 0) - ((r && r.base[t.id]) || 0)), project: t.project || null };
  }

  // Worked out from the jobs as they are now, so what has been dealt with since no longer shows as waiting.
  function reportOf(r) {
    const jobs = started(r);
    const done = [], waiting = [], notFinished = [];
    for (const t of jobs) {
      if (needsUser(t)) waiting.push({ ...row(t, r), why: whyWaiting(t) });
      else if (t.status === 'done') {
        const toApply = t.workspace && t.workspace.status === 'active' && (t.changes || []).length;
        (toApply ? waiting : done).push({ ...row(t, r), ...(toApply ? { why: 'changes to apply' } : {}), concerns: !!(t.reviewer && t.reviewer.status === 'flagged') });
      } else if (t.status === 'open') waiting.push({ ...row(t, r), why: 'still working' });
      else notFinished.push({ ...row(t, r), why: t.status === 'paused' ? (r.capped ? 'paused at the cap' : 'paused') : t.status });
    }
    const notStarted = r.endedAt || state.run === r ? state.queue.map((id) => tickets.get(id)).filter(Boolean).map((t) => ({ ...row(t, null), why: blockedByChain(t) ? `waits for #${t.afterJob.n}` : '' })) : [];
    return { id: r.id, startedAt: r.startedAt, endedAt: r.endedAt || null, reason: r.reason || null, capUsd: r.capUsd, until: r.until, spentUsd: r.endedAt ? r.spentUsd : spentOf(r), capped: !!r.capped, done, waiting, notFinished, notStarted };
  }

  function telegramText(rep) {
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const list = (name, rows) => (rows.length ? `\n\n<b>${name}</b>\n${rows.slice(0, 12).map((x) => `#${x.n} ${esc(String(x.title).slice(0, REPORT_TITLE_CHARS))}${x.why ? ` · ${esc(x.why)}` : ''}`).join('\n')}${rows.length > 12 ? `\nand ${rows.length - 12} more` : ''}` : '');
    return `<b>Overnight report</b>\nSpent $${rep.spentUsd.toFixed(2)} of $${rep.capUsd.toFixed(2)}${rep.reason === 'cap' ? ', stopped at the cap' : ''}.${list('Waiting for you', rep.waiting)}${list('Done', rep.done)}${list('Not finished', rep.notFinished)}${list('Not started', rep.notStarted)}`;
  }

  function view() {
    tidyQueue();
    const r = state.run;
    return {
      queue: state.queue.map((id) => tickets.get(id)).filter(Boolean).map((t) => ({ id: t.id, n: t.n, title: t.title, project: t.project || null, waitsFor: blockedByChain(t) ? t.afterJob.n : null })),
      run: r ? { ...reportOf(r), concurrency: r.concurrency, autoPlansUsd: r.autoPlansUsd, hold: r.hold, working: working(r).length, awake: !!awakeProc && !awakeFailed, awakeFailed } : null,
      last: state.last ? reportOf(state.last) : null,
      defaultUntil: defaultUntil(now()),
    };
  }

  async function route(req, res, url, p, body, json) {
    if (!p.startsWith('/api/overnight')) return false;
    if (req.method === 'GET' && p === '/api/overnight') return json(res, 200, view()), true;
    if (req.method !== 'POST') return false;
    const b = await body(req);
    let r;
    if (p === '/api/overnight/start') r = start(b);
    else if (p === '/api/overnight/stop') r = stop();
    else if (p === '/api/overnight/move') r = move(String(b.id), Number(b.dir));
    else return false;
    return json(res, r.error ? 400 : 200, r), true;
  }

  // After a restart: the run carries on, and needs the computer awake again.
  if (state.run) keepAwake(state.run.until);
  process.on('exit', letSleep);

  return { approves, enqueue, move, route, start, stop, tick, view };
}

module.exports = { install, needsUser };
