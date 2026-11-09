'use strict';
// The agent eval over time. scripts/agent-eval.js runs real agents on a cheap model in a throwaway copy of the office and
// checks a handful of behaviours (reads in parts, uses scripts, never commits, plans before a big team, saves handoffs).
// Here it runs on a schedule (defaults.agentEvalDays, 1 = daily, 0 = off) when the office has been idle for 20 minutes,
// and every run is kept in data/evals.jsonl, so the Health app can show which behaviours held over time. Each run notes
// whether the agents' instructions changed since the one before (roster.json, lib/mcp-delegate.js), so a behaviour that
// stops being followed points at the change that broke it. A behaviour that passed last time and fails now is notified.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const DAY = 86400000;
const KEEP = 120;
const IDLE_MS = 20 * 60000;

function install(ctx) {
  const { ROOT, DATA, readJson, now, broadcast, isIdle, canSpend } = ctx;
  const FILE = path.join(DATA, 'evals.jsonl');
  const GOOD = path.join(DATA, 'evals-good-prompts.json');
  const run_ = ctx.spawn || spawn;
  let changedHash = null, changedSince = 0;
  let running = null;
  let idleSince = null;

  function history() {
    let lines = [];
    try { lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean); } catch {}
    return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
  function append(run) {
    const all = [...history(), run].slice(-KEEP);
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, all.map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.renameSync(tmp, FILE);
  }
  function instructionsHash() {
    const h = crypto.createHash('sha1');
    for (const f of ['roster.json', 'lib/mcp-delegate.js']) { try { h.update(fs.readFileSync(path.join(ROOT, f))); } catch {} }
    return h.digest('hex').slice(0, 10);
  }
  // Only what agents are told: changing a preference or a model must not start an eval.
  function promptHash() {
    const r = readJson('roster.json');
    const h = crypto.createHash('sha1').update(JSON.stringify(Object.entries(r.roles || {}).map(([k, d]) => [k, d.prompt || '']).sort()));
    try { h.update(fs.readFileSync(path.join(ROOT, 'lib/mcp-delegate.js'))); } catch {}
    return h.digest('hex').slice(0, 10);
  }
  function saveGood(hash) {
    const r = readJson('roster.json');
    fs.writeFileSync(GOOD, JSON.stringify({ at: now(), hash, prompts: Object.fromEntries(Object.entries(r.roles || {}).map(([k, d]) => [k, d.prompt || ''])) }));
  }
  function readGood() { try { return JSON.parse(fs.readFileSync(GOOD, 'utf8')); } catch { return null; } }

  function gitHead() {
    const r = spawnSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
    const d = spawnSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8' });
    return r.status === 0 ? `${r.stdout.trim()}${(d.stdout || '').trim() ? '+' : ''}` : null;
  }

  function runNow(trigger) {
    if (running) return { error: 'The agent eval is already running.' };
    const model = readJson('roster.json').defaults.agentEvalModel || 'haiku';
    running = { startedAt: now(), trigger, model };
    broadcast({ type: 'evals' });
    const child = run_(process.execPath, [path.join(ROOT, 'scripts', 'agent-eval.js'), '--json', '--model', model],
      { cwd: ROOT, env: { ...process.env, AGENTOS_TEST_PARENT: String(process.pid) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('close', () => {
      const started = running.startedAt;
      running = null;
      let r = null;
      try { r = JSON.parse(out.trim().split('\n').pop()); } catch {}
      const prev = history().filter((x) => !x.error && !['failed', 'rechecking'].includes(x.gate)).pop();
      const earlier = history().pop();
      const run = r && Array.isArray(r.results)
        ? { t: started, ms: now() - started, trigger, model: r.model, cost: r.cost || 0, results: r.results, instructions: instructionsHash(), head: gitHead() }
        : { t: started, ms: now() - started, trigger, model, error: (err || out || 'no output').trim().slice(-400) };
      run.passed = (run.results || []).filter((x) => x.pass).length;
      run.total = (run.results || []).length;
      run.instructionsChanged = !!(prev && run.instructions && prev.instructions !== run.instructions);
      run.promptHash = promptHash();
      let broke = prev && run.results ? run.results.filter((x) => !x.pass && (prev.results || []).some((y) => y.name === x.name && y.pass)) : [];
      // The gate: agents on a cheap model are noisy, so a behaviour only counts as broken when it fails twice running.
      let recheck = false;
      if (['change', 'change-recheck'].includes(trigger) && !run.error) {
        if (trigger === 'change' && broke.length) { run.gate = 'rechecking'; recheck = true; }
        else {
          if (trigger === 'change-recheck' && earlier && earlier.gate === 'rechecking') broke = broke.filter((x) => (earlier.results || []).some((y) => y.name === x.name && !y.pass));
          run.gate = broke.length ? 'failed' : 'passed';
        }
      }
      if (!run.error && !broke.length && run.gate !== 'rechecking') { try { saveGood(run.promptHash); } catch {} }
      try { append(run); } catch (e) { console.error(`Could not save the eval run: ${e.message}`); }
      if (recheck) { broadcast({ type: 'evals' }); runNow('change-recheck'); return; }
      if (run.gate === 'failed') {
        broadcast({ type: 'notify', kind: 'warn', title: 'Changed instructions broke agent behaviour', text: `${broke.map((x) => x.name).join('; ')}. Health can restore the last good instructions.` });
        broadcast({ type: 'evals' });
        return;
      }
      if (run.error) broadcast({ type: 'notify', kind: 'warn', title: 'Agent eval could not run', text: run.error.slice(0, 200) });
      else if (broke.length) broadcast({ type: 'notify', kind: 'warn', title: `Agent eval: ${broke.length} behaviour${broke.length === 1 ? '' : 's'} no longer followed`,
        text: `${broke.map((x) => x.name).join('; ')}${run.instructionsChanged ? ' · the agents\' instructions changed since the last run' : ''}. See Health.` });
      broadcast({ type: 'evals' });
    });
    return { ok: true, message: `The agent eval is running on ${model} in a throwaway office (a few minutes, a few cents).` };
  }

  // Every few minutes: due, idle for 20 minutes, and allowed to spend.
  function maybeScheduled() {
    if (process.env.AGENTOS_TEST_PARENT) return null;
    const days = Number(readJson('roster.json').defaults.agentEvalDays ?? 1);
    if (!days || running) return null;
    if (!isIdle()) { idleSince = null; return null; }
    idleSince = idleSince || now();
    if (now() - idleSince < IDLE_MS || !canSpend()) return null;
    const last = history().pop();
    // A run that could not start is retried after 6 hours, not straight away.
    if (last && now() - last.t < (last.error ? 6 * 3600000 : days * DAY - 3600000)) return null;
    return runNow('scheduled');
  }

  // Every few minutes: the agents' instructions changed from the last run and have been left alone for 5 minutes.
  function maybeOnChange() {
    if (process.env.AGENTOS_TEST_PARENT) return null;
    if (readJson('roster.json').defaults.agentEvalOnChange === 0 || running) return null;
    const last = history().pop();
    const h = promptHash();
    if (!last || !last.promptHash || last.promptHash === h) { changedHash = null; return null; }
    if (changedHash !== h) { changedHash = h; changedSince = now(); return null; }
    if (now() - changedSince < 5 * 60000 || !canSpend()) return null;
    changedHash = null;
    return runNow('change');
  }

  // Back to the instructions of the last good run. Leads pick them up when they next restart.
  function restoreGood() {
    const g = readGood();
    if (!g) return { error: 'There is no good run to go back to yet.' };
    const r = readJson('roster.json');
    const changed = Object.keys(g.prompts).filter((k) => r.roles[k] && (r.roles[k].prompt || '') !== g.prompts[k]);
    for (const k of changed) r.roles[k].prompt = g.prompts[k];
    if (changed.length) ctx.writeRoster(r);
    if (ctx.audit) ctx.audit.record('user', 'instructions.restored', { detail: `from the run of ${new Date(g.at).toISOString()}: ${changed.join(', ') || 'nothing differed'}` });
    for (const k of changed) if ((r.residents || []).includes(k) && ctx.agents.get(k)) ctx.restartWhenIdle(k);
    return { ok: true, message: changed.length ? `Restored instructions for ${changed.length} role${changed.length === 1 ? '' : 's'}. Leads switch when they next go idle.` : 'The instructions already match the last good run.' };
  }

  function view() {
    const days = Number(readJson('roster.json').defaults.agentEvalDays ?? 1);
    const g = readGood();
    return { runs: history().slice(-30), running, everyDays: days, goodAt: g ? g.at : null };
  }

  async function route(req, res, p, body, json) {
    if (req.method === 'GET' && p === '/api/evals') { json(res, 200, view()); return true; }
    if (req.method === 'POST' && p === '/api/evals/restore') { const r = restoreGood(); json(res, r.error ? 400 : 200, r); return true; }
    if (req.method === 'POST' && p === '/api/evals/run') { const r = runNow('manual'); json(res, r.error ? 409 : 200, r); return true; }
    return false;
  }
  return { maybeOnChange, promptHash, restoreGood, runNow, maybeScheduled, view, route, history };
}

module.exports = { install };
