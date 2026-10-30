'use strict';
// Agents talking to each other: colleagues, send_message, ask and their replies.

function install(ctx) {
  const { ACTIVE, addEvent, agents, askWaiters, broadcast, enqueueResident, filesOf, mail, mailWake, newId, now, procs, thread, ticketOfAgent, tickets, touch } = ctx;

  function present() {
    return [...agents.values()].filter((x) => (x.resident && x.status !== 'offline') || (!x.resident && ACTIVE.includes(x.status)));
  }

  function findColleague(name) {
    const n = String(name || '').trim().toLowerCase();
    return present().find((x) => x.id.toLowerCase() === n || x.persona.toLowerCase() === n);
  }

  function colleagues(agentId) {
    const lines = present().filter((x) => x.id !== agentId).map((x) => {
      const t = ticketOfAgent(x);
      return `- ${x.persona} — ${x.name}${x.resident ? ' (permanent)' : ''} — ${x.status === 'delegating' ? 'waiting on their sub-agents (reads mail when that finishes)' : x.status}` +
        `${t ? ` — ticket #${t.n}` : ''}${x.resident ? '' : ` — working on: ${x.title}`}` +
        (filesOf(x.id).length ? ` — editing: ${filesOf(x.id).join(', ')}` : '');
    });
    return lines.length ? 'In the office now:\n' + lines.join('\n') : 'Nobody else is in the office right now.';
  }

  function sendMail(fromId, toName, text, replyTo, ask) {
    const from = agents.get(fromId);
    const to = findColleague(toName);
    if (!from) return { error: 'Unknown sender.' };
    if (!to) return { error: `"${toName}" is not in the office. ${colleagues(fromId)}` };
    if (to.id === from.id) return { error: 'That is you.' };
    const t = ticketOfAgent(from) || ticketOfAgent(to);
    const msg = { id: newId(), from: from.id, to: to.id, text: String(text || '').slice(0, 8000), replyTo: replyTo || null,
      ask: !!ask, ticketId: t ? t.id : null, t: now(), read: false };
    mail.push(msg);
    if (mail.length > 2000) mail.splice(0, mail.length - 2000);
    addEvent(from, { kind: 'msg_out', to: to.id, toPersona: to.persona, text: msg.text, ask: msg.ask });
    broadcast({ type: 'chat', from: from.id, to: to.id, text: msg.text, ask: msg.ask });
    if (t) thread(t, { from: from.id, to: to.id, kind: 'chat', text: msg.text, ask: msg.ask });
    if (msg.ask && mailWake.has(to.id)) {
      mailWake.get(to.id)();
    } else if (replyTo && askWaiters.has(replyTo)) {
      msg.read = true;
      addEvent(to, { kind: 'msg_in', from: from.id, fromPersona: from.persona, text: msg.text });
      askWaiters.get(replyTo)(msg);
    } else if (to.resident && !to.current && procs.get(to.id)) {
      msg.read = true;
      addEvent(to, { kind: 'msg_in', from: from.id, fromPersona: from.persona, text: msg.text });
      enqueueResident(to.id, { ticketId: msg.ticketId, kind: 'message', text: formatMail([msg]) });
    }
    return { msg, to };
  }

  function formatMail(list) {
    return list.map((m) => {
      const f = agents.get(m.from);
      const t = m.ticketId && tickets.get(m.ticketId);
      return `[Mail from ${f ? `${f.persona} (${f.name})` : m.from}${t ? `, ticket #${t.n}` : ''}${m.ask ? `, QUESTION — they are waiting; answer with send_message to "${f ? f.persona : m.from}" and reply_to "${m.id}"` : ''}]\n${m.text}`;
    }).join('\n\n');
  }

  function takeUnread(agentId) {
    const a = agents.get(agentId);
    const list = mail.filter((m) => m.to === agentId && !m.read);
    for (const m of list) {
      m.read = true;
      const f = agents.get(m.from);
      if (a) addEvent(a, { kind: 'msg_in', from: m.from, fromPersona: f ? f.persona : m.from, text: m.text, ask: m.ask });
      // A follow-up the user sent now (lib/tickets.js sendFollowupNow) is delivered: its inbox copy goes.
      if (m.fid && a) { const i = a.inbox.findIndex((x) => x.fid === m.fid); if (i >= 0) a.inbox.splice(i, 1); touch(a); }
    }
    return list.length ? formatMail(list) : '';
  }

  function ask(agentId, toName, question, timeoutSec) {
    const r = sendMail(agentId, toName, question, null, true);
    if (r.error) return Promise.resolve({ error: r.error });
    const secs = Math.max(30, Math.min(900, Number(timeoutSec) || 300));
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        askWaiters.delete(r.msg.id);
        resolve({ message: `${r.to.persona} has not answered within ${Math.round(secs / 60)} minute(s). Carry on with your best judgment; their answer, if it comes, will arrive as mail.` });
      }, secs * 1000);
      askWaiters.set(r.msg.id, (reply) => {
        clearTimeout(timer);
        askWaiters.delete(r.msg.id);
        resolve({ message: `${r.to.persona} answered:\n${reply.text}` });
      });
    });
  }

  // A note from the office itself (not an agent), delivered like mail after the agent's next tool call.
  function officeNote(agentId, text) {
    mail.push({ id: newId(), from: 'the office', to: agentId, text: String(text), replyTo: null, ask: false, ticketId: null, t: now(), read: false });
  }

  return { ask, colleagues, sendMail, takeUnread, officeNote };
}

module.exports = { install };
