'use strict';
// Telegram: what needs the user (plans, questions, terminal commands, edit access) as messages with buttons in a linked
// chat, so jobs keep moving away from the desk; notes when a job finishes or fails. From the chat the user can also start
// jobs, follow up on them, see one job as a card that updates live, pause/resume/stop it, rate the answer, and see the
// processes and plan usage (/help lists the commands). Long polling only (no webhook, no public URL). Watches ticket state instead of hooking each decision, so a decision made in the window is noticed the
// same way and the Telegram message is updated. Settings and the bot token live in data/telegram.json (git-ignored).
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const EVENTS = ['plan', 'question', 'command', 'access', 'done', 'failed'];
const DEFAULT_EVENTS = { plan: true, question: true, command: true, access: true, done: false, failed: true };
const MAX = 4000;
const LIVE = ['open', 'paused', 'scheduled'];
// The bot's command menu in Telegram.
const COMMANDS = [
  ['new', 'Start a new job'], ['jobs', 'Jobs in progress'], ['job', 'One job: where it stands, with buttons'],
  ['ps', 'Processes: who is working on what'], ['usage', 'Plan usage and spend today'], ['waiting', 'Send again what needs you'],
  ['projects', 'Projects you can name in /new'], ['help', 'What I can do'],
];

function install(ctx) {
  const { DATA, ACTIVE, agents, tickets, now, readJson, thread, limitsView, decidePlan, decideCommand, answerUser, decideAccess,
    createTicket, dispatchTicket, followUp, pauseTicket, resumeTicket, stopTicket, rateTicket } = ctx;
  const FILE = path.join(DATA, 'telegram.json');
  const BASE = (process.env.TELEGRAM_API || 'https://api.telegram.org').replace(/\/$/, '');
  const startedAt = now();
  let cfg = load();
  let gen = 0;
  let pollReq = null;
  let lastError = null;
  let stopped = false;
  // Plain messages offered as a new job, waiting for the user's tap (in memory: an offer does not survive a restart).
  const drafts = new Map();

  function load() {
    // sent: messages about what waits on the user; cards: message id -> the job it is about ('new' for a new-job prompt),
    // so a reply to it follows up on that job; watch: job id -> the card message kept up to date as the job moves.
    try { const c = JSON.parse(fs.readFileSync(FILE, 'utf8')); return { sent: {}, cards: {}, watch: {}, ...c, events: { ...DEFAULT_EVENTS, ...(c.events || {}) } }; } catch { return { sent: {}, cards: {}, watch: {}, events: { ...DEFAULT_EVENTS } }; }
  }
  function save() {
    try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 }); } catch {}
  }

  function view() {
    return { configured: !!cfg.token, linked: !!cfg.chatId, botName: cfg.botName || null, chatName: cfg.chatName || null,
      pairCode: cfg.token && !cfg.chatId ? cfg.pairCode || null : null, enabled: !!cfg.chatId && cfg.enabled !== false,
      events: Object.fromEntries(EVENTS.map((k) => [k, !!cfg.events[k]])), lastError };
  }

  // ---------------------------------------------------------------- the Bot API

  function api(method, params, timeoutMs = 15000, token = cfg.token) {
    return new Promise((resolve, reject) => {
      if (!token) return reject(new Error('No bot token.'));
      const u = new URL(`${BASE}/bot${token}/${method}`);
      const data = Buffer.from(JSON.stringify(params || {}));
      const req = (u.protocol === 'http:' ? http : https).request(u, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
        let s = '';
        res.on('data', (c) => (s += c));
        res.on('end', () => {
          let j = null;
          try { j = JSON.parse(s); } catch {}
          if (j && j.ok) resolve(j.result);
          else reject(Object.assign(new Error((j && j.description) || `HTTP ${res.statusCode}`), { code: (j && j.error_code) || res.statusCode }));
        });
      });
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => req.destroy(new Error('Telegram did not answer in time.')));
      if (method === 'getUpdates') pollReq = req;
      req.end(data);
    });
  }

  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const persona = (id) => (agents.get(id) || {}).persona || 'An agent';
  const head = (t) => `<b>#${t.n} ${esc(cut(t.title || '', 120))}</b>`;
  const btn = (text, data) => ({ text, callback_data: data });

  function send(text, markup) {
    return api('sendMessage', { chat_id: cfg.chatId, text: cut(text, MAX), parse_mode: 'HTML', disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) });
  }
  // Rewrites a sent message with how it was decided; without reply_markup Telegram drops the buttons.
  function settle(key, how) {
    const s = cfg.sent[key];
    if (!s) return;
    delete cfg.sent[key];
    save();
    api('editMessageText', { chat_id: cfg.chatId, message_id: s.mid, text: cut(`${s.text}\n\n<i>${esc(how)}</i>`, MAX), parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => {});
  }

  // ---------------------------------------------------------------- what is waiting on the user

  function pendingItems() {
    const out = [];
    for (const t of tickets.values()) {
      if (!['open', 'paused'].includes(t.status)) continue;
      const p = t.plan;
      if (p && p.status === 'pending') out.push({ key: `p|${p.id}`, event: 'plan', t, text: `${head(t)}\n${esc(persona(p.from))} wants your OK on a plan · estimated $${(p.estimateUsd || 0).toFixed(2)}\n\n${esc(cut(p.text || '', 3200))}`,
        markup: { inline_keyboard: [[btn('Approve', `p|${p.id}|approve`), btn('Reject', `p|${p.id}|reject`)]] } });
      const q = t.waiting;
      if (q) out.push({ key: `q|${q.id}`, event: 'question', t, text: `${head(t)}\n${esc(persona(q.from))} asks:\n\n${esc(cut(q.text || '', 3200))}${q.options && q.options.length ? '\n\n<i>Pick an answer, or reply to this message in your own words.</i>' : '\n\n<i>Reply to this message with your answer.</i>'}`,
        markup: q.options && q.options.length ? { inline_keyboard: q.options.map((o, i) => [btn(cut(o, 60), `q|${q.id}|${i}`)]) } : { force_reply: true, input_field_placeholder: 'Your answer' } });
      for (const c of t.commands || []) if (c.status === 'pending') out.push({ key: `c|${c.id}`, event: 'command', t,
        text: `${head(t)}\n${esc(c.persona || persona(c.agentId))} wants to run a command:\n<pre>${esc(cut(c.command, 2500))}</pre>\nin <code>${esc(c.cwd)}</code>${c.reason ? ` · ${esc(cut(c.reason, 300))}` : ''}`,
        markup: { inline_keyboard: [[btn('Run', `c|${c.id}|run`), btn('Run all on this job', `c|${c.id}|all`), btn("Don't run", `c|${c.id}|deny`)]] } });
      for (const r of t.access || []) if (r.status === 'pending') out.push({ key: `a|${r.id}`, event: 'access', t,
        text: `${head(t)}\n${esc(r.persona || persona(r.agentId))} asks to edit files in <code>${esc(r.folder)}</code>${r.reason ? `\n\n${esc(cut(r.reason, 500))}` : ''}`,
        markup: { inline_keyboard: [[btn('Allow', `a|${r.id}|allow`), btn('Deny', `a|${r.id}|deny`)]] } });
    }
    return out;
  }

  // How an item that is no longer waiting was settled, for the message it left behind.
  function outcome(key) {
    const [kind, id] = key.split('|');
    for (const t of tickets.values()) {
      if (kind === 'p' && t.plan && t.plan.id === id) return t.plan.status === 'pending' ? null : `plan ${t.plan.status}`;
      if (kind === 'q' && t.thread.some((e) => e.qid === id)) return 'answered';
      if (kind === 'c') { const c = (t.commands || []).find((x) => x.id === id); if (c) return c.status === 'denied' ? 'not run' : `command ${c.status}`; }
      if (kind === 'a') { const r = (t.access || []).find((x) => x.id === id); if (r) return `edits ${r.status}`; }
    }
    return 'no longer waiting';
  }

  // ---------------------------------------------------------------- jobs, processes and usage as messages

  const LIVE_EVERY = 10000;
  const money = (n) => `$${(n || 0).toFixed(2)}`;
  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const when = (ms) => (new Date(ms).toDateString() === new Date().toDateString() ? clock(ms) : `${new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' })} ${clock(ms)}`);
  const who = (k) => (k === 'user' ? 'You' : k === 'system' ? 'Office' : persona(k));
  const byN = (n) => [...tickets.values()].find((t) => t.n === Number(n));
  const leadsOf = (t) => [...new Set([t.direct, ...(t.assignees || [])].filter(Boolean))].map(persona).join(', ');
  const needsYou = (t) => !!(t.waiting || (t.plan && t.plan.status === 'pending') || (t.commands || []).some((c) => c.status === 'pending') || (t.access || []).some((r) => r.status === 'pending'));

  function statusOf(t) {
    if (t.status === 'open') return needsYou(t) ? '🙋 needs you' : t.overBudget ? '💸 over budget' : '⚙️ working';
    return { paused: '⏸ paused', scheduled: `🕒 starts ${t.scheduledFor ? when(t.scheduledFor) : 'later'}`, done: '✅ done', failed: '❌ failed', stopped: '⏹ stopped' }[t.status] || t.status;
  }
  // The agents on a job right now: a lead whose current item is the job, or a specialist hired for it that is still running.
  function workersOf(t) {
    return [...agents.values()].filter((a) => !a.retired && (a.resident ? a.current && a.current.ticketId === t.id : a.ticketId === t.id && ACTIVE.includes(a.status)));
  }

  // One job as a message: status, who has it, cost, who is doing what right now, the last few messages and the answer.
  // Holds no running clock, so a card being kept up to date changes only when the job does.
  function jobCard(t) {
    const leads = leadsOf(t);
    const lines = [head(t), `${statusOf(t)}${t.project ? ` · ${esc(t.project)}` : ''}${leads ? ` · ${esc(leads)}` : ''}`,
      `${money(t.costUsd)}${t.budgetUsd ? ` of ${money(t.budgetUsd)}` : ''} · started ${when(t.createdAt)}${t.closedAt ? ` · ended ${when(t.closedAt)}` : ''}`];
    const w = workersOf(t);
    if (w.length) lines.push('', ...w.slice(0, 6).map((a) => `• <b>${esc(a.persona)}</b> <i>${esc(a.model || '')}${a.effort ? `/${esc(a.effort)}` : ''}</i>${a.progress ? `: ${esc(cut(String(a.progress), 160))}` : ''}`));
    const recent = t.thread.filter((e) => e.text && e.kind !== 'rating').slice(-4);
    if (recent.length) lines.push('', ...recent.map((e) => `<b>${esc(who(e.from))}:</b> ${esc(cut(String(e.text).replace(/\s+/g, ' ').trim(), 220))}`));
    if (t.answer && !LIVE.includes(t.status) && !recent.some((e) => e.text === t.answer)) lines.push('', `<b>Answer:</b> ${esc(cut(String(t.answer), 900))}`);
    return lines.join('\n');
  }
  function cardKeys(t) {
    const id = t.id;
    const row = [btn('🔄 Refresh', `j|${id}|card`)];
    if (t.status === 'open') row.push(btn('⏸ Pause', `j|${id}|pause`), btn('⏹ Stop', `j|${id}|stop`));
    if (t.status === 'paused') row.push(btn('▶️ Resume', `j|${id}|resume`), btn('⏹ Stop', `j|${id}|stop`));
    if (t.status === 'scheduled') row.push(btn('▶️ Start now', `j|${id}|start`), btn('✖️ Cancel', `j|${id}|stop`));
    const row2 = [btn('💬 Follow up', `j|${id}|reply`)];
    if (LIVE.includes(t.status)) row2.push(cfg.watch[id] ? btn('🔕 Stop live updates', `j|${id}|unwatch`) : btn('🔔 Live updates', `j|${id}|watch`));
    return { inline_keyboard: [row, row2] };
  }

  // A message that is about a job, so a reply to it is a follow-up. Only the latest few hundred are kept.
  function remember(mid, tid) {
    if (!mid) return;
    cfg.cards[mid] = tid;
    const keys = Object.keys(cfg.cards);
    for (const k of keys.slice(0, Math.max(0, keys.length - 300))) delete cfg.cards[k];
    save();
  }
  function watch(t, mid, text) {
    cfg.watch[t.id] = { mid, text: text || '', at: now() };
    save();
  }
  async function sendCard(t, live) {
    const text = jobCard(t);
    // Marked as watched before sending, so the card already offers "Stop live updates".
    if (live && LIVE.includes(t.status)) cfg.watch[t.id] = { mid: 0, text, at: now() };
    let m;
    try { m = await send(text, cardKeys(t)); } catch (e) { if (cfg.watch[t.id] && !cfg.watch[t.id].mid) delete cfg.watch[t.id]; throw e; }
    remember(m.message_id, t.id);
    if (live && LIVE.includes(t.status)) watch(t, m.message_id, text);
    return m;
  }
  function editCard(mid, t, markup) {
    const text = jobCard(t);
    if (cfg.watch[t.id] && cfg.watch[t.id].mid === mid) watch(t, mid, text);
    return api('editMessageText', { chat_id: cfg.chatId, message_id: mid, text: cut(text, MAX), parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: markup || cardKeys(t) })
      .catch((e) => { if (!/not modified/i.test(e.message)) lastError = e.message; });
  }
  function askFollowUp(t) {
    return send(`💬 Follow-up on ${head(t)}\n<i>Reply to this message with what you want to add or change.</i>`, { force_reply: true, input_field_placeholder: `Follow-up on #${t.n}` })
      .then((m) => remember(m.message_id, t.id));
  }

  function jobsList() {
    const live = [...tickets.values()].filter((t) => LIVE.includes(t.status) && !t.archived).sort((a, b) => b.n - a.n).slice(0, 15);
    const recent = [...tickets.values()].filter((t) => !LIVE.includes(t.status) && t.closedAt && now() - t.closedAt < 86400000).sort((a, b) => b.closedAt - a.closedAt).slice(0, 5);
    const line = (t) => `${head(t)}\n   ${statusOf(t)}${leadsOf(t) ? ` · ${esc(leadsOf(t))}` : ''} · ${money(t.costUsd)}`;
    const text = [live.length ? '<b>In progress</b>' : 'Nothing is in progress. /new starts a job.', ...live.map(line),
      ...(recent.length ? ['', '<b>Finished in the last day</b>', ...recent.map(line)] : [])].join('\n');
    const all = [...live, ...recent];
    const rows = [];
    for (let i = 0; i < all.length; i += 4) rows.push(all.slice(i, i + 4).map((t) => btn(`#${t.n}`, `j|${t.id}|show`)));
    return [text, rows.length ? { inline_keyboard: rows } : null];
  }

  // Every lead, and each specialist that is running: model and effort, state, job and what it is doing.
  function psText() {
    const list = [...agents.values()].filter((a) => !a.retired && (a.resident || ACTIVE.includes(a.status)));
    list.sort((a, b) => (b.resident ? 1 : 0) - (a.resident ? 1 : 0) || (a.no || 0) - (b.no || 0));
    const lines = list.map((a) => {
      const job = tickets.get(a.resident ? a.current && a.current.ticketId : a.ticketId);
      const busy = (a.resident && a.current) || ACTIVE.includes(a.status);
      const state = a.status === 'error' ? 'error' : busy ? 'working' : a.resident && a.inbox && a.inbox.length ? `${a.inbox.length} queued` : a.status || 'idle';
      const dot = a.status === 'error' ? '🔴' : busy ? '🟢' : a.status === 'offline' ? '⚫' : '⚪';
      return `${a.resident ? '' : '   └ '}${dot} <b>${esc(a.persona)}</b> · <i>${esc(a.model || '?')}${a.effort ? `/${esc(a.effort)}` : ''}</i> · ${esc(state)}${job ? ` · #${job.n}` : ''}` +
        (busy && a.progress ? `\n      ${esc(cut(String(a.progress), 140))}` : '');
    });
    const open = [...tickets.values()].filter((t) => t.status === 'open');
    return `<b>Processes</b> · ${list.filter((a) => (a.resident && a.current) || ACTIVE.includes(a.status)).length} working · ${open.length} open job${open.length === 1 ? '' : 's'}${open.filter(needsYou).length ? ` · ${open.filter(needsYou).length} need you` : ''}\n\n${lines.join('\n') || 'No processes.'}`;
  }

  function usageText() {
    const L = limitsView();
    const names = { five_hour: '5-hour window', seven_day: 'Weekly' };
    const ws = Object.entries(L.windows || {}).map(([k, w]) => `${esc(names[k] || k.replace(/_/g, ' '))}: <b>${Math.round((w.utilization || 0) * 100)}%</b>${w.resetsAt && w.resetsAt > now() ? ` · resets ${when(w.resetsAt)}` : ''}`);
    return ['<b>Usage</b>', ...(ws.length ? ws : ['No usage reading yet.']),
      `Spent today: <b>${money(L.today)}</b>${L.dailyCap ? ` of a ${money(L.dailyCap)} daily limit` : ''}`,
      ...(L.hold ? [`⏸ New work is held${L.hold.resetsAt ? ` until ${when(L.hold.resetsAt)}` : ''}.`] : [])].join('\n');
  }

  function helpText() {
    return ['<b>Agentic OS</b> · what I can do', '',
      '/new &lt;task&gt; · start a job; begin with <code>project:</code> to pick the project. Or just send me the task.',
      '/jobs · jobs in progress · /job 12 · one job, with buttons',
      '<code>#12 message</code> · follow up on job 12 (or reply to any message about it)',
      '/pause 12 · /resume 12 · /stop 12 · /watch 12 (a card that updates as the job moves)',
      '/ps · who is working on what', '/usage · plan usage and spend today', '/waiting · send again what needs you', '/projects · project names',
      '', 'Plans, questions and commands that need you arrive here with buttons. Jobs you start or follow up here update live, and you get a note when they finish.'].join('\n');
  }

  function startJob(text) {
    const projects = readJson('projects.json');
    const m = text.match(/^([\w.\- ]{2,40}):\s+([\s\S]+)$/);
    const project = m && projects.find((x) => x.name.toLowerCase() === m[1].trim().toLowerCase());
    let t;
    try { t = createTicket({ text: project ? m[2] : text, project: project ? project.name : undefined }); } catch (e) { return send(`Could not start the job: ${esc(e.message)}`); }
    return sendCard(t, true);
  }
  function followUpOn(t, text) {
    if (!t) return send('That job no longer exists.');
    const r = followUp(t, text, []);
    if (r.error) return send(esc(r.error));
    return sendCard(t, true);
  }

  // A job by its number from a command argument ("12" or "#12"), or a message saying it was not found.
  function jobArg(arg) {
    const n = (String(arg).match(/^#?(\d+)/) || [])[1];
    const t = n && byN(n);
    if (!t) send(n ? `There is no job #${n}.` : 'Which job? Add its number, e.g. <code>/job 12</code>.').catch(() => {});
    return t;
  }

  function command(text) {
    const [, name = '', arg = ''] = text.match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/) || [];
    const a = arg.trim();
    const cmd = name.toLowerCase();
    let t;
    switch (cmd) {
      case 'start': case 'help': return send(helpText());
      case 'new':
        if (a) return startJob(a);
        return send('🆕 What should the office do?\n<i>Reply to this message with the task. Begin with a project name and a colon to pick it, e.g. <code>recipe-box: add dark mode</code>.</i>',
          { force_reply: true, input_field_placeholder: 'The task' }).then((m) => remember(m.message_id, 'new'));
      case 'jobs': return send(...jobsList());
      case 'job': return a ? (t = jobArg(a)) && sendCard(t) : send(...jobsList());
      case 'watch': return (t = jobArg(a)) && (LIVE.includes(t.status) ? sendCard(t, true) : sendCard(t));
      case 'pause': case 'resume': {
        if (!(t = jobArg(a))) return;
        const r = cmd === 'pause' ? pauseTicket(t) : resumeTicket(t);
        return r.error ? send(esc(r.error)) : sendCard(t);
      }
      case 'stop':
        if (!(t = jobArg(a))) return;
        if (!LIVE.includes(t.status)) return send(`${head(t)} is not running.`);
        return send(jobCard(t), stopKeys(t)).then((m) => remember(m.message_id, t.id));
      case 'ps': return send(psText());
      case 'usage': return send(usageText());
      case 'projects': {
        const ps = readJson('projects.json');
        return send(ps.length ? `<b>Projects</b>\n${ps.map((x) => `<code>${esc(x.name)}</code>${x.department ? ` · ${esc(persona(x.department))}` : ''}`).join('\n')}\n\n<i>Start one with</i> <code>/new ${esc(ps[0].name)}: …</code>` : 'No projects are set up.');
      }
      case 'waiting': {
        const keys = Object.keys(cfg.sent).filter((k) => !k.startsWith('d|'));
        if (!pendingItems().some((x) => cfg.events[x.event])) return send('Nothing is waiting for you right now.');
        // Settled as "sent again" here; the next scan sends each one again as a new message at the bottom of the chat.
        for (const k of keys) settle(k, 'Sent again below.');
        return;
      }
      default: return send(`I don't know /${esc(cmd)}. /help lists what I can do.`);
    }
  }
  const stopKeys = (t) => ({ inline_keyboard: [[btn(`⏹ Yes, stop #${t.n}`, `j|${t.id}|stopyes`), btn('Keep it going', `j|${t.id}|card`)]] });

  function onJobButton(cq, tid, action) {
    const ack = (text) => api('answerCallbackQuery', { callback_query_id: cq.id, text: text || '' }).catch(() => {});
    const t = tickets.get(tid);
    if (!t) return ack('That job no longer exists.');
    const mid = cq.message.message_id;
    let r = { ok: true };
    if (action === 'show') return ack(), sendCard(t).catch((e) => { lastError = e.message; });
    if (action === 'reply') return ack(), askFollowUp(t).catch((e) => { lastError = e.message; });
    if (action === 'stop') return ack(), editCard(mid, t, stopKeys(t));
    if (action === 'pause') r = pauseTicket(t);
    else if (action === 'resume') r = resumeTicket(t);
    else if (action === 'stopyes') { if (LIVE.includes(t.status)) stopTicket(t); else r = { error: 'This job is not running.' }; }
    else if (action === 'start') {
      if (t.status !== 'scheduled') r = { error: 'This job is not waiting to start.' };
      else { thread(t, { from: 'system', kind: 'system', text: 'Started now by you (Telegram).' }); dispatchTicket(t); }
    } else if (action === 'watch') { watch(t, mid, ''); remember(mid, t.id); } else if (action === 'unwatch') { delete cfg.watch[t.id]; save(); }
    ack(r.error || (action === 'card' ? '' : 'Done'));
    editCard(mid, t);
  }

  function onRating(cq, tid, score) {
    const t = tickets.get(tid);
    api('answerCallbackQuery', { callback_query_id: cq.id, text: t ? 'Thanks, the lead will take it on board.' : 'That job no longer exists.' }).catch(() => {});
    if (!t) return;
    rateTicket(t, Number(score) > 0 ? 1 : -1, '');
    api('editMessageReplyMarkup', { chat_id: cfg.chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [[btn(Number(score) > 0 ? '👍 Rated good' : '👎 Rated not good', `j|${t.id}|show`), btn('💬 Follow up', `j|${t.id}|reply`)]] } }).catch(() => {});
  }

  function onDraft(cq, id, action) {
    const text = drafts.get(id);
    drafts.delete(id);
    api('answerCallbackQuery', { callback_query_id: cq.id, text: text == null ? 'That offer has expired; send the task again.' : '' }).catch(() => {});
    const original = (cq.message && cq.message.text) || '';
    api('editMessageText', { chat_id: cfg.chatId, message_id: cq.message.message_id, text: cut(`${esc(original)}\n\n<i>${text == null ? 'Expired.' : action === 'go' ? 'Started as a new job.' : 'Not started.'}</i>`, MAX), parse_mode: 'HTML' }).catch(() => {});
    if (text != null && action === 'go') startJob(text).catch((e) => { lastError = e.message; });
  }

  let scanning = false;
  async function scan() {
    if (scanning || !cfg.token || !cfg.chatId) return;
    scanning = true;
    try {
      const items = pendingItems();
      const live = new Set(items.map((x) => x.key));
      for (const key of Object.keys(cfg.sent)) {
        if (key.startsWith('d|') || live.has(key)) continue;
        settle(key, `Decided in the window: ${outcome(key)}.`);
      }
      if (cfg.enabled !== false) {
        for (const it of items) {
          if (cfg.sent[it.key] || !cfg.events[it.event]) continue;
          cfg.sent[it.key] = { mid: null, text: it.text, at: now() };
          try { const m = await send(it.text, it.markup); cfg.sent[it.key].mid = m.message_id; } catch (e) { delete cfg.sent[it.key]; lastError = e.message; }
          save();
        }
        // A note when a job ends: always for one being kept up to date here, else as the settings say.
        for (const t of tickets.values()) {
          const ev = { done: 'done', failed: 'failed' }[t.status];
          if (!ev || !t.closedAt || t.closedAt < startedAt || !(cfg.events[ev] || cfg.watch[t.id])) continue;
          const key = `d|${t.id}|${t.closedAt}`;
          if (cfg.sent[key]) continue;
          cfg.sent[key] = { mid: 0, text: '', at: now() };
          const by = leadsOf(t) || 'The office';
          const keys = ev === 'done'
            ? [[btn('👍', `r|${t.id}|1`), btn('👎', `r|${t.id}|-1`), btn('💬 Follow up', `j|${t.id}|reply`), btn('Details', `j|${t.id}|show`)]]
            : [[btn('💬 Follow up', `j|${t.id}|reply`), btn('Details', `j|${t.id}|show`)]];
          send(`${ev === 'done' ? '✅' : '❌'} ${head(t)} ${ev === 'done' ? 'is done' : 'failed'}\n${esc(by)}${t.costUsd ? ` · ${money(t.costUsd)}` : ''}\n\n${esc(cut(String(t.answer || ''), 700))}\n\n<i>Reply to this message to follow up.</i>`, { inline_keyboard: keys })
            .then((m) => remember(m.message_id, t.id)).catch((e) => { lastError = e.message; });
          save();
        }
      }
      // Cards kept up to date: edited when the job changes, at most every few seconds, and a last time when it ends.
      for (const [tid, w] of Object.entries(cfg.watch)) {
        const t = tickets.get(tid);
        if (!t || !w.mid) { if (!t) { delete cfg.watch[tid]; save(); } continue; }
        const live = LIVE.includes(t.status);
        const text = jobCard(t);
        if (live && (text === w.text || now() - w.at < LIVE_EVERY)) continue;
        if (live) watch(t, w.mid, text); else { delete cfg.watch[tid]; save(); }
        api('editMessageText', { chat_id: cfg.chatId, message_id: w.mid, text: cut(text, MAX), parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: cardKeys(t) })
          .catch((e) => { if (/not found|can't be edited/i.test(e.message) && cfg.watch[tid]) { delete cfg.watch[tid]; save(); } });
      }
      // Finished-job notes only need remembering for a day.
      for (const [k, s] of Object.entries(cfg.sent)) if (k.startsWith('d|') && now() - s.at > 86400000) delete cfg.sent[k];
    } finally { scanning = false; }
  }

  // ---------------------------------------------------------------- updates from Telegram

  function findTicket(kind, id) {
    for (const t of tickets.values()) {
      if (kind === 'p' && t.plan && t.plan.id === id) return t;
      if (kind === 'q' && t.waiting && t.waiting.id === id) return t;
      if (kind === 'c' && (t.commands || []).some((c) => c.id === id)) return t;
      if (kind === 'a' && (t.access || []).some((r) => r.id === id)) return t;
    }
    return null;
  }

  function onCallback(cq) {
    const [kind, id, action] = String(cq.data || '').split('|');
    if (kind === 'j') return onJobButton(cq, id, action);
    if (kind === 'r') return onRating(cq, id, action);
    if (kind === 'n') return onDraft(cq, id, action);
    const key = `${kind}|${id}`;
    const t = findTicket(kind, id);
    let r = { error: 'This is no longer waiting.' };
    let how = '';
    if (t && kind === 'p') { r = decidePlan(t, action === 'approve' ? 'approve' : 'reject', ''); how = action === 'approve' ? 'Approved in Telegram.' : 'Rejected in Telegram.'; }
    if (t && kind === 'c') { r = decideCommand(id, action === 'deny' ? 'deny' : 'run', action === 'deny' ? 'declined in Telegram' : '', action === 'all'); how = action === 'deny' ? "Not run (Telegram)." : action === 'all' ? 'Run, and the rest on this job too (Telegram).' : 'Run (Telegram).'; }
    if (t && kind === 'a') { r = decideAccess(tickets, id, action === 'allow'); how = action === 'allow' ? 'Allowed in Telegram.' : 'Denied in Telegram.'; }
    if (t && kind === 'q') {
      const opt = (t.waiting.options || [])[Number(action)];
      r = opt != null && answerUser(t, opt) ? { ok: true } : { error: 'That answer is no longer valid.' };
      how = `Answered in Telegram: ${opt}`;
    }
    api('answerCallbackQuery', { callback_query_id: cq.id, text: r.error ? r.error : 'Done' }).catch(() => {});
    if (!r.error) settle(key, how);
    else if (cfg.sent[key]) settle(key, r.error);
  }

  function onMessage(m) {
    const text = String(m.text || '').trim();
    const chatId = m.chat && m.chat.id;
    if (!cfg.chatId) {
      const code = (text.match(/^(?:\/start\s+)?(\d{6})$/) || [])[1];
      if (!code || !cfg.pairCode || code !== cfg.pairCode) return;
      cfg.chatId = chatId;
      cfg.chatName = m.chat.title || [m.chat.first_name, m.chat.last_name].filter(Boolean).join(' ') || m.chat.username || String(chatId);
      cfg.pairCode = null;
      cfg.enabled = true;
      save();
      setCommands();
      send(`Linked to Agentic OS. Plans, questions and commands that need you will show up here.\n\n${helpText()}`).catch(() => {});
      return;
    }
    if (chatId !== cfg.chatId || !text) return;
    if (text.startsWith('/')) return Promise.resolve(command(text)).catch((e) => { lastError = e.message; });
    // An answer to a question: a reply to its message, or plain text when exactly one question is open.
    const reply = m.reply_to_message && m.reply_to_message.message_id;
    const open = Object.entries(cfg.sent).filter(([k]) => k.startsWith('q|'));
    const jobRef = text.match(/^#(\d+)\b\s*([\s\S]*)$/);
    const hit = open.find(([, s]) => s.mid === reply) || (open.length === 1 && !reply && !jobRef ? open[0] : null);
    if (hit) {
      const id = hit[0].split('|')[1];
      const t = findTicket('q', id);
      if (t && answerUser(t, text)) settle(hit[0], `Answered in Telegram: ${cut(text, 300)}`);
      else settle(hit[0], 'This question is no longer waiting.');
      return;
    }
    const done = (p) => Promise.resolve(p).catch((e) => { lastError = e.message; });
    // A reply to a message about a job follows up on it; a reply to the new-job prompt is the task.
    const target = reply && cfg.cards[reply];
    if (target === 'new') return done(startJob(text));
    if (target) return done(followUpOn(tickets.get(target), text));
    if (jobRef) {
      const t = byN(jobRef[1]);
      if (!t) return done(send(`There is no job #${jobRef[1]}.`));
      return done(jobRef[2].trim() ? followUpOn(t, jobRef[2].trim()) : sendCard(t));
    }
    if (reply) return done(send('I can\'t tell which job that message is about. Use <code>#12 your message</code>, or /new for a new job.'));
    if (open.length) return done(send('Reply to the question you are answering (swipe left on it), so I know which one. /new starts a new job instead.'));
    // Anything else is offered as a new job, so a stray message never starts work by itself.
    const did = crypto.randomBytes(4).toString('hex');
    drafts.set(did, text);
    for (const k of [...drafts.keys()].slice(0, Math.max(0, drafts.size - 20))) drafts.delete(k);
    return done(send(`🆕 Start this as a new job?\n\n${esc(cut(text, 1500))}`, { inline_keyboard: [[btn('Start the job', `n|${did}|go`), btn('No', `n|${did}|no`)]] }));
  }

  async function poll(myGen, skipOld) {
    let offset = 0;
    let delay = 1000;
    // At start-up, skip whatever piled up while the office was off: old button presses must not act now.
    if (skipOld) try { const old = await api('getUpdates', { offset: -1, timeout: 0 }, 15000); if (old.length) offset = old[old.length - 1].update_id + 1; } catch {}
    while (!stopped && myGen === gen && cfg.token) {
      try {
        const ups = await api('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, 35000);
        lastError = null;
        delay = 1000;
        for (const u of ups) {
          offset = u.update_id + 1;
          if (myGen !== gen) return;
          try {
            if (u.callback_query) { if (cfg.chatId && u.callback_query.message && u.callback_query.message.chat.id === cfg.chatId) onCallback(u.callback_query); }
            else if (u.message) onMessage(u.message);
          } catch (e) { lastError = e.message; }
        }
      } catch (e) {
        if (stopped || myGen !== gen) return;
        lastError = e.code === 401 || e.code === 404 ? 'The bot token was refused; paste it again.' : e.message;
        await new Promise((r) => setTimeout(r, delay).unref());
        delay = Math.min(delay * 2, e.code === 401 || e.code === 404 ? 300000 : 60000);
      }
    }
  }

  function setCommands() {
    api('setMyCommands', { commands: COMMANDS.map(([command, description]) => ({ command, description })) }).catch(() => {});
  }

  function restartPolling(skipOld) {
    gen++;
    if (pollReq) { try { pollReq.destroy(); } catch {} pollReq = null; }
    if (cfg.token && !stopped) poll(gen, skipOld);
  }

  // ---------------------------------------------------------------- HTTP

  async function route(req, res, url, p, body, json) {
    if (p === '/api/telegram' && req.method === 'GET') return json(res, 200, view()), true;
    if (p === '/api/telegram' && req.method === 'POST') {
      const b = await body(req);
      const token = String(b.token || '').trim();
      if (!/^\d+:[\w-]{20,}$/.test(token)) return json(res, 400, { error: 'That does not look like a bot token (it looks like 123456789:ABC…, from @BotFather).' }), true;
      let me;
      try { me = await api('getMe', {}, 15000, token); } catch (e) { return json(res, 400, { error: `Telegram refused the token: ${e.message}` }), true; }
      cfg = { ...cfg, token, botName: me.username ? `@${me.username}` : me.first_name, chatId: null, chatName: null, sent: {}, cards: {}, watch: {},
        pairCode: String(crypto.randomInt(0, 1000000)).padStart(6, '0'), enabled: true };
      lastError = null;
      save();
      restartPolling();
      return json(res, 200, { ok: true, botName: cfg.botName, pairCode: cfg.pairCode }), true;
    }
    if (p === '/api/telegram/settings' && req.method === 'POST') {
      const b = await body(req);
      if ('enabled' in b) cfg.enabled = !!b.enabled;
      if (b.events && typeof b.events === 'object') for (const k of EVENTS) if (k in b.events) cfg.events[k] = !!b.events[k];
      save();
      return json(res, 200, view()), true;
    }
    if (p === '/api/telegram/test' && req.method === 'POST') {
      if (!cfg.chatId) return json(res, 400, { error: 'Link a chat first: send the code to your bot.' }), true;
      try { await send('Test from Agentic OS: this chat gets plans, questions and commands that need you. /help lists what you can do from here.'); return json(res, 200, { ok: true }), true; }
      catch (e) { lastError = e.message; return json(res, 400, { error: e.message }), true; }
    }
    if (p === '/api/telegram' && req.method === 'DELETE') {
      cfg = { sent: {}, cards: {}, watch: {}, events: { ...DEFAULT_EVENTS } };
      lastError = null;
      save();
      restartPolling();
      return json(res, 200, view()), true;
    }
    return false;
  }

  function stop() {
    stopped = true;
    gen++;
    if (pollReq) { try { pollReq.destroy(); } catch {} }
  }

  setInterval(() => { scan().catch(() => {}); }, 1000).unref();
  restartPolling(true);
  if (cfg.token && cfg.chatId) setCommands();

  return { route, stop, scan };
}

module.exports = { install };
