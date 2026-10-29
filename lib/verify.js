'use strict';
// Checks before done. A lead saying "done" doesn't close a job by itself: when the job has checks (a project's
// `verify` commands in projects.json, or ones given with the job), the office runs them itself after the lead answers,
// in the job's folder, and only real exit codes decide. All pass → done. One fails → the output goes back to the lead
// to fix (up to `verifyRetries` times, default 1), then the job ends as failed with the evidence in the thread.
// Every job also gets its evidence summarised: the commands run on it and their exit codes, so a job whose last test
// run failed is flagged even without checks.
//
//
// A job with no checks can get a reviewer instead (defaults.reviewAnswers: 0 never, 1 jobs that changed files, the
// default, 2 every job): one model call with no tools reads the request, the lead's answer, the diff and the commands
// run, and says PASS or FAIL with concrete problems. A FAIL goes back to the lead like a failed check; a reviewer is a
// model, not an exit code, so when it still objects after the retries the job closes done with its concerns flagged
// instead of failing.
//
// t.verify = { cmds, status: 'running' | 'passed' | 'failed', attempt, runs: [{ cmd, code, ms, out, at }] }
// t.reviewer = { status: 'running' | 'passed' | 'failed' | 'flagged' | 'skipped', attempt, issues, costUsd, at }

const RUN_TIMEOUT_MS = 10 * 60000;
const OUT_TAIL = 3000;
const REVIEW_DIFF_CHARS = 40000;
const REVIEW_MODEL = 'sonnet';

function install(ctx) {
  const { blockedCommand, broadcast, changesOf, closeTicket, enqueueResident, lessons, now, oneShot, readJson, spawn, thread, touchTicket, workdirOf } = ctx;
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

  // Called when the lead's answer would close the job. Returns true when checks or the reviewer took over closing it.
  function start(t, leadId) {
    const cmds = checksFor(t);
    if (t.status === 'stopped') return false;
    if (!cmds.length) return review(t, leadId);
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

  // ---------------------------------------------------------------- the reviewer (jobs without checks)

  const changed = (t) => (t.changes || []).some((c) => !c.revertedAt);
  function wantsReview(t) {
    const mode = Number((readJson('roster.json').defaults || {}).reviewAnswers ?? 1);
    // Routines and the weekly review report on the office rather than change anything, so there is nothing to review.
    if (!mode || t.routine || t.review || !oneShot) return false;
    return mode === 2 || changed(t);
  }

  function reviewPrompt(t) {
    const asks = [t.text, ...(t.thread || []).filter((e) => e.from === 'user' && e.kind !== 'user' && e.text).map((e) => e.text)]
      .map((s) => String(s || '').trim()).filter(Boolean);
    let diff = '';
    if (changesOf) {
      for (const c of changesOf(t)) {
        if (c.revertedAt || c.state === 'unchanged') continue;
        diff += `\n### ${c.path} (${c.state}, +${c.added} −${c.removed})\n${c.diff}`;
        if (diff.length > REVIEW_DIFF_CHARS) { diff = diff.slice(0, REVIEW_DIFF_CHARS) + '\n… (diff cut here)'; break; }
      }
    }
    const ev = evidence(t);
    const cmds = ev.commands.slice(-15).map((c) => `- \`${String(c.command).slice(0, 160)}\` → exit ${c.exitCode}`).join('\n');
    return `You review work an agent did for the user, before the job is marked done. You cannot run anything; judge only from what is below.
Fail it only for concrete problems you can point to: part of the request not done; a bug, a syntax error or a broken reference in the diff; the answer claiming something the diff or the commands do not show (e.g. "tests pass" with no test run, or a file "updated" that is not in the diff); a change clearly outside what was asked.
Do not fail it for style, naming, missing nice-to-haves or things you merely cannot verify. When in doubt, pass.

Reply with exactly PASS or FAIL on the first line. After FAIL, list each problem on its own line starting with "- ", naming the file and what is wrong, at most 6 lines. Nothing else.

# What the user asked${asks.length > 1 ? ' (the first request, then follow-ups in order)' : ''}
${asks.map((s) => s.slice(0, 3000)).join('\n\n---\n\n') || '(not recorded)'}

# The agent's answer
${String(t.answer || '(no answer)').slice(-6000)}

# Files changed
${diff || '(no files changed)'}

# Commands the agent ran (last run of each)
${cmds || '(none)'}`;
  }

  function review(t, leadId) {
    if (!wantsReview(t)) return false;
    const prev = t.reviewer;
    const attempt = (prev && prev.status === 'failed' ? prev.attempt : 0) + 1;
    t.reviewer = { status: 'running', attempt, at: now(), costUsd: (prev && prev.status === 'failed' && prev.costUsd) || 0 };
    t.status = 'open';
    touchTicket(t);
    thread(t, { from: 'system', kind: 'system', text: 'No checks on this job, so a reviewer is reading the request, the answer and the changes before it closes.' });
    broadcast({ type: 'verify', ticketId: t.id, cmd: 'reviewer' });
    (async () => {
      const r = await oneShot(reviewPrompt(t), REVIEW_MODEL, 'low');
      if (t.status === 'stopped') return;
      if (r.costUsd) { t.reviewer.costUsd += r.costUsd; t.costUsd = (t.costUsd || 0) + r.costUsd; }
      const text = String(r.text || '').trim();
      const verdict = /^\W*(PASS|FAIL)\b/i.exec(text);
      if (r.error || !verdict) {
        t.reviewer.status = 'skipped';
        thread(t, { from: 'system', kind: 'system', text: `The reviewer could not give a verdict (${r.error ? String(r.error).slice(0, 200) : 'unexpected reply'}), so the job closes on the lead's answer.` });
        return closeTicket(t, false);
      }
      if (verdict[1].toUpperCase() === 'PASS') {
        t.reviewer.status = 'passed';
        thread(t, { from: 'system', kind: 'verify', ok: true, text: 'The reviewer found no problems with the answer or the changes.' });
        return closeTicket(t, false);
      }
      const issues = text.slice(verdict[0].length).split('\n').map((l) => l.trim()).filter((l) => /^[-*•]\s*\S/.test(l)).slice(0, 6).map((l) => '- ' + l.replace(/^[-*•]\s*/, ''));
      if (!issues.length) issues.push('- (the reviewer gave no details)');
      t.reviewer.issues = issues;
      const retries = Math.max(0, Number(readJson('roster.json').defaults.verifyRetries ?? 1));
      if (attempt <= retries && leadId) {
        t.reviewer.status = 'failed';
        thread(t, { from: 'system', kind: 'verify', ok: false, text: `The reviewer found problems; sent back to the lead to fix (attempt ${attempt + 1} of ${retries + 1}):\n${issues.join('\n')}` });
        if (!t.pending.includes(leadId)) t.pending.push(leadId);
        touchTicket(t);
        enqueueResident(leadId, { ticketId: t.id, kind: 'direct',
          text: `[Ticket #${t.n}: a reviewer read your answer and changes and found problems]\n${issues.join('\n')}\nFix the real ones and answer again, saying what you changed. If a point is wrong, say why in your answer instead of changing the code. The reviewer reads your new answer before the job closes.` });
        return;
      }
      t.reviewer.status = 'flagged';
      thread(t, { from: 'system', kind: 'verify', ok: false, text: `Closed as done, but the reviewer still has concerns. Worth a look:\n${issues.join('\n')}` });
      closeTicket(t, false);
    })().catch((e) => { t.reviewer.status = 'skipped'; thread(t, { from: 'system', kind: 'system', text: `The reviewer could not run: ${e.message}` }); closeTicket(t, false); });
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
