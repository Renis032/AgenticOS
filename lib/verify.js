'use strict';
// Checks before done. A lead saying "done" doesn't close a job by itself: when the job has checks (a project's
// `verify` commands in projects.json, or ones given with the job), the office runs them itself after the lead answers,
// in the job's folder, and only real exit codes decide. All pass → done. One fails → the output goes back to the lead
// to fix (up to `verifyRetries` times, default 1), then the job ends as failed with the evidence in the thread.
// Every job also gets its evidence summarised: the commands run on it and their exit codes, so a job whose last test
// run failed is flagged even without checks.
//
// t.verify = { cmds, status: 'running' | 'passed' | 'failed', attempt, runs: [{ cmd, code, ms, out, at }] }

const RUN_TIMEOUT_MS = 10 * 60000;
const OUT_TAIL = 3000;

function install(ctx) {
  const { blockedCommand, broadcast, closeTicket, enqueueResident, lessons, now, readJson, spawn, thread, touchTicket, workdirOf } = ctx;
  const running = new Map(); // ticketId → child process

  const clean = (list) => (Array.isArray(list) ? list : String(list || '').split(/\n|;;/)).map((c) => String(c).trim()).filter(Boolean).slice(0, 6);

  function checksFor(t) {
    if (Array.isArray(t.verifyCmds)) return t.verifyCmds;
    const p = t.project && readJson('projects.json').find((x) => x.name === t.project);
    return clean(p && p.verify);
  }

  // A line for the lead's brief, so it knows the bar before it starts.
  function briefLine(t) {
    const c = checksFor(t);
    return c.length ? `\n\nDone means these pass; the office runs them itself after your answer and sends failures back to you: ${c.map((x) => '`' + x + '`').join(', ')}. Run them yourself before you answer.` : '';
  }

  function runOne(t, cmd) {
    return new Promise((resolve) => {
      const started = now();
      const bad = blockedCommand(readJson('roster.json'), cmd);
      if (bad) return resolve({ cmd, code: 126, ms: 0, out: `Blocked: "${bad}" is on the block list.`, at: started });
      let out = '';
      const child = spawn('bash', ['-lc', cmd], { cwd: workdirOf(t), detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } });
      running.set(t.id, child);
      const keep = (d) => { out = (out + d).slice(-OUT_TAIL * 2); };
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      const timer = setTimeout(() => { out += `\n[stopped after ${RUN_TIMEOUT_MS / 60000} minutes]`; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, RUN_TIMEOUT_MS);
      child.on('error', (e) => { clearTimeout(timer); running.delete(t.id); resolve({ cmd, code: 127, ms: now() - started, out: e.message, at: started }); });
      child.on('close', (code, sig) => {
        clearTimeout(timer);
        running.delete(t.id);
        resolve({ cmd, code: code == null ? (sig ? 128 : 1) : code, ms: now() - started, out: out.slice(-OUT_TAIL), at: started });
      });
    });
  }

  // Called when the lead's answer would close the job. Returns true when checks took over closing it.
  function start(t, leadId) {
    const cmds = checksFor(t);
    if (!cmds.length || t.status === 'stopped') return false;
    const attempt = (t.verify && t.verify.status === 'failed' && t.verify.cmdsKey === cmds.join('\n') ? t.verify.attempt : 0) + 1;
    t.verify = { cmds, cmdsKey: cmds.join('\n'), status: 'running', attempt, runs: [], startedAt: now() };
    t.status = 'open';
    touchTicket(t);
    thread(t, { from: 'system', kind: 'system', text: `Checking the work before closing the job: ${cmds.map((c) => '`' + c + '`').join(', ')}.` });
    (async () => {
      for (const cmd of cmds) {
        if (t.status === 'stopped') return;
        broadcast({ type: 'verify', ticketId: t.id, cmd });
        const r = await runOne(t, cmd);
        t.verify.runs.push(r);
        touchTicket(t);
        if (r.code !== 0) break;
      }
      if (t.status === 'stopped') return;
      const failed = t.verify.runs.find((r) => r.code !== 0);
      t.verify.endedAt = now();
      if (!failed) {
        t.verify.status = 'passed';
        thread(t, { from: 'system', kind: 'verify', ok: true, text: `Checks passed: ${t.verify.runs.map((r) => `\`${r.cmd}\` (exit 0, ${(r.ms / 1000).toFixed(1)} s)`).join(', ')}.` });
        closeTicket(t, false);
        return;
      }
      t.verify.status = 'failed';
      const retries = Math.max(0, Number(readJson('roster.json').defaults.verifyRetries ?? 1));
      thread(t, { from: 'system', kind: 'verify', ok: false, text: `\`${failed.cmd}\` failed (exit ${failed.code}, ${(failed.ms / 1000).toFixed(1)} s).`, out: failed.out });
      if (attempt <= retries && leadId) {
        thread(t, { from: 'system', kind: 'system', text: `Sent back to the lead to fix (attempt ${attempt + 1} of ${retries + 1}).` });
        if (!t.pending.includes(leadId)) t.pending.push(leadId);
        touchTicket(t);
        enqueueResident(leadId, { ticketId: t.id, kind: 'direct',
          text: `[Ticket #${t.n}: the office's checks failed after your answer]\n\`${failed.cmd}\` exited with ${failed.code}. The end of its output:\n\`\`\`\n${failed.out.slice(-2000)}\n\`\`\`\nFix the cause (not the check), run it yourself until it passes, then answer again. The office re-runs the checks after your answer.` });
        return;
      }
      closeTicket(t, true);
      lessons.ask(t, 'failed', `the checks failed: ${failed.cmd} exited ${failed.code}`);
    })().catch((e) => { t.verify.status = 'failed'; thread(t, { from: 'system', kind: 'system', text: `The checks could not run: ${e.message}` }); closeTicket(t, true); });
    return true;
  }

  function stop(t) {
    const child = running.get(t.id);
    if (child) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  }

  // Evidence for any job: the commands run on it, and whether the last run of each one failed.
  function evidence(t) {
    const last = new Map();
    for (const c of t.commands || []) if (c.exitCode != null || c.status === 'failed') last.set(c.command, c);
    const cmds = [...last.values()].map((c) => ({ command: c.command, exitCode: c.exitCode, at: c.endedAt || c.startedAt }));
    return { commands: cmds, failing: cmds.filter((c) => c.exitCode !== 0 && c.exitCode != null) };
  }

  return { briefLine, checksFor, clean, evidence, start, stop };
}

module.exports = { install };
