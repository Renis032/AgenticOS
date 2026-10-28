'use strict';
// Telegram: what needs the user (plans, questions, terminal commands, edit access) as messages with buttons in a linked
// chat, so jobs keep moving away from the desk; optionally a note when a job finishes. Long polling only (no webhook,
// no public URL). Watches ticket state instead of hooking each decision, so a decision made in the window is noticed the
// same way and the Telegram message is updated. Settings and the bot token live in data/telegram.json (git-ignored).
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const EVENTS = ['plan', 'question', 'command', 'access', 'done'];
const DEFAULT_EVENTS = { plan: true, question: true, command: true, access: true, done: false };
const MAX = 4000;

function install(ctx) {
  const { DATA, agents, tickets, now, decidePlan, decideCommand, answerUser, decideAccess } = ctx;
  const FILE = path.join(DATA, 'telegram.json');
  const BASE = (process.env.TELEGRAM_API || 'https://api.telegram.org').replace(/\/$/, '');
  const startedAt = now();
  let cfg = load();
  let gen = 0;
  let pollReq = null;
  let lastError = null;
  let stopped = false;

  function load() {
    try { const c = JSON.parse(fs.readFileSync(FILE, 'utf8')); return { sent: {}, ...c, events: { ...DEFAULT_EVENTS, ...(c.events || {}) } }; } catch { return { sent: {}, events: { ...DEFAULT_EVENTS } }; }
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
      if (cfg.enabled === false) return;
      for (const it of items) {
        if (cfg.sent[it.key] || !cfg.events[it.event]) continue;
        cfg.sent[it.key] = { mid: null, text: it.text, at: now() };
        try { const m = await send(it.text, it.markup); cfg.sent[it.key].mid = m.message_id; } catch (e) { delete cfg.sent[it.key]; lastError = e.message; }
        save();
      }
      if (cfg.events.done) for (const t of tickets.values()) {
        if (t.status !== 'done' || !t.closedAt || t.closedAt < startedAt) continue;
        const key = `d|${t.id}|${t.closedAt}`;
        if (cfg.sent[key]) continue;
        cfg.sent[key] = { mid: 0, text: '', at: now() };
        const who = (t.assignees || []).map(persona).join(', ') || 'The office';
        send(`✅ ${head(t)} is done\n${esc(who)}${t.costUsd ? ` · $${t.costUsd.toFixed(2)}` : ''}\n\n${esc(cut(String(t.answer || ''), 700))}`).catch((e) => { lastError = e.message; });
        save();
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
      send('Linked to Agentic OS. Plans, questions and commands that need you will show up here.').catch(() => {});
      return;
    }
    if (chatId !== cfg.chatId || !text) return;
    // An answer to a question: a reply to its message, or plain text when exactly one question is open.
    const reply = m.reply_to_message && m.reply_to_message.message_id;
    const open = Object.entries(cfg.sent).filter(([k]) => k.startsWith('q|'));
    const hit = open.find(([, s]) => s.mid === reply) || (open.length === 1 && !reply ? open[0] : null);
    if (!hit) {
      if (!text.startsWith('/')) send(open.length ? 'Reply to the question you are answering (swipe left on it), so I know which one.' : 'Nothing is waiting for you right now.').catch(() => {});
      return;
    }
    const id = hit[0].split('|')[1];
    const t = findTicket('q', id);
    if (t && answerUser(t, text)) settle(hit[0], `Answered in Telegram: ${cut(text, 300)}`);
    else settle(hit[0], 'This question is no longer waiting.');
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
      cfg = { ...cfg, token, botName: me.username ? `@${me.username}` : me.first_name, chatId: null, chatName: null, sent: {},
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
      try { await send('Test from Agentic OS: this chat gets plans, questions and commands that need you.'); return json(res, 200, { ok: true }), true; }
      catch (e) { lastError = e.message; return json(res, 400, { error: e.message }), true; }
    }
    if (p === '/api/telegram' && req.method === 'DELETE') {
      cfg = { sent: {}, events: { ...DEFAULT_EVENTS } };
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

  return { route, stop, scan };
}

module.exports = { install };
