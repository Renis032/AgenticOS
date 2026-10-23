'use strict';
// Shared files: who edits which file, and the heads-up when two agents edit the same one.

function install(ctx) {
  const { ACTIVE, agents, fileTouches, now, path, sendMail, ticketOfAgent } = ctx;

  function isPresent(a) {
    return a && ((a.resident && (a.current || ACTIVE.includes(a.status))) || (!a.resident && ACTIVE.includes(a.status)));
  }

  function filesOf(agentId) {
    const out = [];
    for (const [file, who] of fileTouches) if (who.has(agentId)) out.push(file);
    return out;
  }

  function touchFile(agentId, file) {
    const me = agents.get(agentId);
    if (!me || !file) return '';
    const abs = path.resolve(me.cwd || '/', file);
    if (!fileTouches.has(abs)) fileTouches.set(abs, new Map());
    const who = fileTouches.get(abs);
    for (const id of [...who.keys()]) if (!isPresent(agents.get(id))) who.delete(id);
    const first = !who.has(agentId);
    who.set(agentId, now());
    const others = [...who.keys()].filter((id) => id !== agentId).map((id) => agents.get(id));
    if (!others.length || !first) return '';
    for (const o of others) {
      sendMail(agentId, o.id, `(automatic notice) I just edited ${abs}, which you have also been editing. Let's agree who changes what so we don't overwrite each other.`, null, false);
    }
    return `Heads-up: ${others.map((o) => { const t = ticketOfAgent(o); return `${o.persona} (${o.name}${t ? `, ticket #${t.n}` : ''})`; }).join(' and ')} ` +
      `also edited ${abs}. They have been notified. Coordinate with them (ask / send_message) before further changes to this file.`;
  }

  return { filesOf, touchFile };
}

module.exports = { install };
