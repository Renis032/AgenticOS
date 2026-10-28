'use strict';
// Upkeep: reminders for plans, questions and commands waiting on the user; restarting when idle (and noticing new code);
// office-wide settings the Preferences window may change.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function install(ctx) {
  const { ROOT, agents, tickets, readJson, now, broadcast, ACTIVE, pumpResident, pump, commandsRunning, isShuttingDown, shutdown } = ctx;
  let restartPending = null;

  function remindWaiting() {
    const d = readJson('roster.json').defaults;
    const after = (Number(d.remindAfterMinutes) || 0) * 60000;
    if (!after) return;
    const [quietFrom, quietTo] = Array.isArray(d.remindQuietHours) ? d.remindQuietHours : [22, 8];
    const h = new Date().getHours();
    if (quietFrom > quietTo ? h >= quietFrom || h < quietTo : h >= quietFrom && h < quietTo) return;
    for (const t of tickets.values()) {
      if (!['open', 'paused'].includes(t.status)) continue;
      const cmd = (t.commands || []).find((c) => c.status === 'pending');
      const waiting = t.plan && t.plan.status === 'pending' ? { at: t.plan.at, who: t.plan.from, what: 'plan' }
        : t.waiting ? { at: t.waiting.at, who: t.waiting.from, what: 'question' }
        : cmd ? { at: cmd.at, who: cmd.agentId, what: 'command' } : null;
      if (!waiting || now() - waiting.at < after || (t.remindedAt && now() - t.remindedAt < after)) continue;
      t.remindedAt = now();
      const persona = (agents.get(waiting.who) || {}).persona || 'An agent';
      const mins = Math.round((now() - waiting.at) / 60000);
      broadcast({ type: 'notify', kind: 'question', ticketId: t.id, title: `Still waiting for you on #${t.n}`,
        text: `${persona}'s ${waiting.what} has waited ${mins >= 120 ? `${Math.round(mins / 60)} hours` : `${mins} minutes`}. ${t.title}` });
    }
  }

  // ---------------------------------------------------------------- restarting when idle, and noticing new code

  const CODE_FILES = () => ['server.js', ...(fs.existsSync(path.join(ROOT, 'lib')) ? fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js')).map((f) => `lib/${f}`) : [])];
  const codeStamp = () => CODE_FILES().map((f) => { try { return `${f}:${fs.statSync(path.join(ROOT, f)).mtimeMs}`; } catch { return f; } }).join('|');
  const BOOT_STAMP = codeStamp();
  function uiStamp() {
    let max = 0;
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else max = Math.max(max, fs.statSync(f).mtimeMs); } };
    try { walk(path.join(ROOT, 'public')); } catch {}
    return Math.round(max);
  }
  const BOOT_UI = uiStamp();
  const busyNow = () => [...agents.values()].filter((a) => ACTIVE.includes(a.status) || (a.resident && a.current));
  function restartView() {
    return { pending: restartPending, codeChanged: codeStamp() !== BOOT_STAMP, uiStamp: uiStamp(), busy: busyNow().map((a) => a.persona) };
  }
  function requestRestart(on, opts) {
    restartPending = on ? { since: now(), check: !(opts && opts.check === false) } : null;
    broadcast({ type: 'restart', restart: restartView() });
    if (on) setTimeout(checkRestart, 300);
    else { for (const a of agents.values()) if (a.resident) pumpResident(a); pump(); }
    return restartView();
  }
  // New work waits while a restart is pending; once nothing runs, a fresh server starts and this one exits. Inboxes survive.
  function checkRestart() {
    if (!restartPending || restartPending.checking || isShuttingDown() || busyNow().length || commandsRunning()) return;
    const changed = codeStamp() !== BOOT_STAMP || uiStamp() > BOOT_UI;
    if (changed && restartPending.check && !restartPending.checked && readJson('roster.json').defaults.checkBeforeRestart !== false) return runChecks();
    const child = spawn('bash', ['-c', `sleep 1.5; cd ${JSON.stringify(ROOT)} && exec node server.js >> data/server.log 2>&1`], { detached: true, stdio: 'ignore' });
    child.unref();
    broadcast({ type: 'restart', restart: { ...restartView(), now: true } });
    setTimeout(() => shutdown(), 300);
  }

  // Before restarting onto changed code, the API check and a quick UI check run against it in throwaway copies; if either fails,
  // the restart is called off and the running office stays on the version that works.
  function runChecks() {
    restartPending.checking = 'Checking the new version…';
    broadcast({ type: 'restart', restart: restartView() });
    const runOne = (args) => new Promise((resolve) => {
      const c = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      c.stdout.on('data', (d) => { out += d; });
      c.stderr.on('data', (d) => { out += d; });
      c.on('close', (code) => resolve({ code, out }));
    });
    (async () => {
      const api = await runOne([path.join(ROOT, 'scripts', 'api-check.js')]);
      const ui = api.code === 0 ? await runOne([path.join(ROOT, 'scripts', 'ui-check.js'), '--quick']) : { code: 0, out: '' };
      const uiSkipped = /Needs Xvfb/.test(ui.out);
      if (!restartPending) return;
      if (api.code === 0 && (ui.code === 0 || uiSkipped)) {
        restartPending.checking = null;
        restartPending.checked = true;
        setTimeout(checkRestart, 200);
        return;
      }
      const failed = api.code !== 0 ? api.out : ui.out;
      const lines = failed.split('\n').filter((l) => /^FAIL|^- |problems|error/i.test(l)).slice(0, 6).join('\n');
      restartPending = null;
      broadcast({ type: 'restart', restart: restartView() });
      broadcast({ type: 'notify', kind: 'warn', title: 'Restart called off: the new version failed its checks', text: lines || failed.slice(-400) });
      for (const a of agents.values()) if (a.resident) pumpResident(a);
      pump();
    })();
  }

  // A list setting: one entry per line (or an array), trimmed, at most 50.
  const list = (v) => (Array.isArray(v) ? v : String(v || '').split('\n')).map((x) => String(x).trim()).filter(Boolean).slice(0, 50);
  // Office-wide settings the Preferences window may change (stored in roster.json defaults).
  const OFFICE_SETTINGS = {
    autoApprovePlansUsd: (v) => Math.max(0, Number(v) || 0),
    autoApproveUsageMax: (v) => Math.max(0, Math.min(1, Number(v) || 0)),
    remindAfterMinutes: (v) => Math.max(0, Math.round(Number(v) || 0)),
    planOverUsd: (v) => Math.max(0, Number(v) || 0),
    autoCompactTokens: (v) => Math.max(0, Math.round(Number(v) || 0)),
    autoRunKnownCommands: (v) => !!Number(v),
    keepBackupsDays: (v) => Math.max(1, Math.round(Number(v) || 30)),
    leadContextNudge: (v) => Math.max(0, Math.round(Number(v) || 0)),
    editScope: (v) => (Number(v) === 1 ? 'home' : 'project'),
    agentEvalDays: (v) => Math.max(0, Math.round(Number(v) || 0)),
    leadTwins: (v) => Math.max(0, Math.min(3, Math.round(Number(v) || 0))),
    twinIdleMinutes: (v) => Math.max(1, Math.round(Number(v) || 20)),
    reviewLessons: (v) => (v !== null && v !== '' && Number(v) === 0 ? 0 : 1),
    allowWeb: (v) => (v !== null && v !== '' && Number(v) === 0 ? 0 : 1),
    commandAllow: list, commandDeny: list, extraEditDirs: list,
    dailySpendUsd: (v) => Math.max(0, Number(v) || 0),
    isolateJobs: (v) => (['off', 'shared', 'always'].includes(v) ? v : 'shared'),
    verifyRetries: (v) => (v == null || v === '' ? 1 : Math.max(0, Math.min(3, Math.round(Number(v) || 0)))),
    stuckMinutes: (v) => (v == null || v === '' ? 15 : Math.max(0, Math.round(Number(v) || 0))),
  };

  // Old backups (copies saved before changes) are pruned after defaults.keepBackupsDays (30), once a day.
  function pruneBackups() {
    const days = Number(readJson('roster.json').defaults.keepBackupsDays) || 30;
    const dir = path.join(ROOT, 'data', 'backups');
    const cutoff = now() - days * 86400000;
    const walk = (d) => {
      let list = [];
      try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of list) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) { walk(f); try { if (!fs.readdirSync(f).length) fs.rmdirSync(f); } catch {} }
        else { try { if (fs.statSync(f).mtimeMs < cutoff) fs.unlinkSync(f); } catch {} }
      }
    };
    walk(dir);
  }
  setTimeout(pruneBackups, 120000);
  setInterval(pruneBackups, 86400000);
  setInterval(remindWaiting, 5 * 60000);
  setInterval(checkRestart, 3000);
  return { restartView, requestRestart, OFFICE_SETTINGS, isRestartPending: () => !!restartPending };
}

module.exports = { install };
