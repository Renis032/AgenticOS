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
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'agent-eval.js'), '--json', '--model', model],
      { cwd: ROOT, env: { ...process.env, AGENTOS_TEST_PARENT: String(process.pid) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('close', () => {
      const started = running.startedAt;
      running = null;
      let r = null;
      try { r = JSON.parse(out.trim().split('\n').pop()); } catch {}
      const prev = history().filter((x) => !x.error).pop();
      const run = r && Array.isArray(r.results)
        ? { t: started, ms: now() - started, trigger, model: r.model, cost: r.cost || 0, results: r.results, instructions: instructionsHash(), head: gitHead() }
        : { t: started, ms: now() - started, trigger, model, error: (err || out || 'no output').trim().slice(-400) };
      run.passed = (run.results || []).filter((x) => x.pass).length;
      run.total = (run.results || []).length;
      run.instructionsChanged = !!(prev && run.instructions && prev.instructions !== run.instructions);
      try { append(run); } catch (e) { console.error(`Could not save the eval run: ${e.message}`); }
      const broke = prev && run.results ? run.results.filter((x) => !x.pass && (prev.results || []).some((y) => y.name === x.name && y.pass)) : [];
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

  function view() {
    const days = Number(readJson('roster.json').defaults.agentEvalDays ?? 1);
    return { runs: history().slice(-30), running, everyDays: days };
  }

  async function route(req, res, p, body, json) {
    if (req.method === 'GET' && p === '/api/evals') { json(res, 200, view()); return true; }
    if (req.method === 'POST' && p === '/api/evals/run') { const r = runNow('manual'); json(res, r.error ? 409 : 200, r); return true; }
    return false;
  }
  return { runNow, maybeScheduled, view, route, history };
}

module.exports = { install };
