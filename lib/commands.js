'use strict';
// Terminal commands: shell commands agents run with run_command. The user sees each one with its live output and approves it
// unless they allowed commands (Preferences → Agents & teams, defaults.terminalCommands: off | ask | allow).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function install(ctx) {
  const { agents, tickets, readJson, home, now, newId, broadcast, addEvent, touch, touchTicket, thread, ticketOfAgent, defOf, expandTools } = ctx;

  const commandWaiters = new Map();
  const commandProcs = new Map();

  function commandMode(roster) { return ['off', 'ask', 'allow'].includes(roster.defaults.terminalCommands) ? roster.defaults.terminalCommands : 'ask'; }

  // Agents that may edit files may also run commands; readers and the router may not.
  function canRunCommands(roster, a) {
    if (!a || a.id === roster.root) return false;
    return expandTools(roster, defOf(roster, a).tools || 'readonly').includes('Edit');
  }

  // The office-wide ban list (alwaysDisallowed) applies anywhere in the command line, not only at its start.
  function blockedCommand(roster, cmd) {
    const c = ` ${String(cmd).replace(/\s+/g, ' ')} `;
    for (const d of roster.alwaysDisallowed || []) {
      const m = String(d).match(/^Bash\((.+?)(?::\*)?\)$/);
      if (!m) continue;
      const pat = m[1].trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
      if (new RegExp(`(^|[\\s;&|(\`$"'])${pat}(?=[\\s;&|)"']|$)`).test(c)) return m[1];
    }
    return null;
  }

  // The user's own lists (Preferences → Agents & teams): commands starting with a "never" entry are refused, ones starting
  // with an "always" entry run without asking. A "*" in an entry matches anything.
  const listed = (list, cmd) => (Array.isArray(list) ? list : []).find((p) => {
    const re = new RegExp('^' + String(p).trim().split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '(\\s|$)');
    return String(p).trim() && re.test(String(cmd).trim());
  });
  // Commands that reach the network ask first when web access is off, whatever the command mode.
  const NETWORK = /(^|[\s;&|(])(curl|wget|ssh|scp|sftp|ftp|nc|telnet|git\s+(clone|fetch|pull|push|ls-remote)|npm\s+(i|install|ci|publish|update)|pnpm\s+(i|install|add)|yarn(\s+(add|install))?|pip3?\s+install|cargo\s+(install|fetch)|apt(-get)?|docker\s+(pull|push|login))(?=[\s;&|)]|$)/;

  async function runCommand(agentId, b) {
    const roster = readJson('roster.json');
    const a = agents.get(agentId);
    const t = a && ticketOfAgent(a);
    if (!t) return { error: 'You have no current ticket.' };
    if (!canRunCommands(roster, a)) return { error: 'Your role cannot run terminal commands.' };
    const mode = commandMode(roster);
    if (mode === 'off') return { error: 'The user has turned terminal commands off (Preferences → Agents & teams). Tell them what to run, or use your other tools.' };
    const command = String(b.command || '').trim();
    if (!command) return { error: 'No command given.' };
    const bad = blockedCommand(roster, command);
    if (bad) return { error: `Not allowed: "${bad}" is blocked for every agent. Tell the user what to run themselves.` };
    const never = listed(roster.defaults.commandDeny, command);
    if (never) return { error: `Not allowed: the user's never-run list has "${never}". Tell the user what you wanted to run and why.` };
    const cwd = path.resolve(home(String(b.cwd || '').trim() || a.cwd || '~'));
    if (!(cwd === os.homedir() || cwd.startsWith(os.homedir() + path.sep)) || !fs.existsSync(cwd)) return { error: `The working folder ${cwd} must exist inside your home folder.` };
    const c = { id: newId(), agentId: a.id, persona: a.persona, command: command.slice(0, 4000), cwd, reason: String(b.reason || '').slice(0, 500),
      timeoutSec: Math.max(5, Math.min(1800, Number(b.timeout_sec) || 300)), status: 'pending', at: now() };
    t.commands = t.commands || [];
    t.commands.push(c);
    thread(t, { from: a.id, kind: 'command', cid: c.id, text: c.command });
    // A command that already succeeded in the same folder (numbers such as ports ignored) runs without asking again.
    const norm = (x) => String(x).replace(/\s+/g, ' ').trim().replace(/\d{3,}/g, '#');
    const known = readJson('roster.json').defaults.autoRunKnownCommands !== false && [...tickets.values()].some((x) => (x.commands || []).some((k) => k.status === 'done' && k.cwd === c.cwd && norm(k.command) === norm(c.command)));
    if (known) c.known = true;
    const always = listed(roster.defaults.commandAllow, command);
    if (always) c.allowedBy = always;
    c.network = roster.defaults.allowWeb === 0 && NETWORK.test(` ${command}`);
    if (c.network || (mode === 'ask' && !t.allowCommands && !known && !always)) {
      a.progress = `Waiting for you to approve a command on #${t.n}.`;
      addEvent(a, { kind: 'progress', text: a.progress });
      touch(a);
      broadcast({ type: 'notify', kind: 'question', ticketId: t.id, title: `${a.persona} wants to run a command (#${t.n})`, text: c.command });
      const d = await new Promise((resolve) => commandWaiters.set(c.id, resolve));
      if (d.decision !== 'run') {
        c.status = 'denied';
        c.note = String(d.note || '').slice(0, 500);
        touchTicket(t);
        return { error: `The user chose not to run this command${c.note ? `: ${c.note}` : ''}. Do not retry it as is; if you need it, explain why or ask with ask_user.` };
      }
    }
    return execCommand(t, a, c);
  }

  function execCommand(t, a, c) {
    return new Promise((resolve) => {
      c.status = 'running';
      c.startedAt = now();
      touchTicket(t);
      a.progress = `Running: ${c.command.slice(0, 120)}`;
      addEvent(a, { kind: 'progress', text: a.progress });
      touch(a);
      broadcast({ type: 'cmd', phase: 'start', cid: c.id, ticketN: t.n, persona: a.persona, command: c.command, cwd: c.cwd });
      const child = spawn('bash', ['-lc', c.command], { cwd: c.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', CI: '1', GIT_TERMINAL_PROMPT: '0', DEBIAN_FRONTEND: 'noninteractive' } });
      commandProcs.set(c.id, child);
      let out = '';
      const take = (stream) => (d) => {
        const s = d.toString();
        if (out.length < 400000) out += s;
        broadcast({ type: 'cmd', phase: 'out', cid: c.id, stream, text: s.slice(0, 20000) });
      };
      child.stdout.on('data', take('out'));
      child.stderr.on('data', take('err'));
      const timer = setTimeout(() => { c.timedOut = true; try { process.kill(-child.pid, 'SIGTERM'); } catch {} }, c.timeoutSec * 1000);
      let ended = false;
      const finish = (code, sig) => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        commandProcs.delete(c.id);
        c.status = c.stopped ? 'stopped' : c.timedOut ? 'timed out' : code === 0 ? 'done' : 'failed';
        c.exitCode = code;
        c.endedAt = now();
        c.output = out.length > 12000 ? `…\n${out.slice(-12000)}` : out;
        touchTicket(t);
        broadcast({ type: 'cmd', phase: 'end', cid: c.id, status: c.status, exitCode: code });
        a.progress = `Command ${c.status}${code != null && code !== 0 ? ` (exit ${code})` : ''}; reading the output.`;
        addEvent(a, { kind: 'progress', text: a.progress });
        touch(a);
        const shown = out.length > 30000 ? `${out.slice(0, 10000)}\n… (${out.length - 25000} characters cut) …\n${out.slice(-15000)}` : out;
        const why = c.timedOut ? ` (stopped after the ${c.timeoutSec}s timeout)` : c.stopped ? ' (stopped by the user)' : '';
        resolve({ message: `Exit code ${code == null ? sig : code}${why}. Took ${((c.endedAt - c.startedAt) / 1000).toFixed(1)}s.\n\n${shown || '(no output)'}` });
      };
      child.on('error', (e) => { out += String(e.message); finish(null, 'error'); });
      child.on('close', finish);
    });
  }

  function findCommand(cid) {
    for (const t of tickets.values()) { const c = (t.commands || []).find((x) => x.id === cid); if (c) return { t, c }; }
    return {};
  }

  function decideCommand(cid, decision, note, allowAll) {
    const { t, c } = findCommand(cid);
    if (!c || c.status !== 'pending') return { error: 'That command is not waiting for a decision.' };
    if (allowAll && decision === 'run') t.allowCommands = true;
    const w = commandWaiters.get(cid);
    commandWaiters.delete(cid);
    if (w) w({ decision, note });
    else { c.status = 'denied'; touchTicket(t); }
    return { ok: true };
  }

  function stopCommand(cid) {
    const { t, c } = findCommand(cid);
    if (!c) return { error: 'No such command.' };
    if (c.status === 'pending') return decideCommand(cid, 'deny', 'stopped before it ran');
    const child = commandProcs.get(cid);
    if (child) { c.stopped = true; try { process.kill(-child.pid, 'SIGTERM'); } catch {} setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 3000); }
    touchTicket(t);
    return { ok: true };
  }

  // A paused or stopped job takes its commands with it.
  function endCommands(t) {
    for (const c of t.commands || []) if (['pending', 'running'].includes(c.status)) stopCommand(c.id);
  }

  return { commandMode, canRunCommands, blockedCommand, runCommand, decideCommand, stopCommand, endCommands, running: () => commandProcs.size };
}

module.exports = { install };
