'use strict';
// Scrolling that follows new messages, and live output of agents' terminal commands.
// ================================================================ scrolling that follows new messages
// Renders into a scroll box; if you were at the bottom it stays at the bottom, otherwise it keeps your place. Returns true when it kept your place.
function stickyRender(el, keepPlace, render) {
  const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  const top = el.scrollTop;
  render();
  if (keepPlace && !atEnd) { el.scrollTop = top; return true; }
  el.scrollTop = el.scrollHeight;
  hidePill(el);
  return false;
}
// The "new message" button floating over the bottom of a scroll box.
function newPill(el, n, kind) {
  const host = el.parentElement;
  if (!host) return;
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  let pill = host.querySelector(':scope > .newpill');
  if (!pill) {
    pill = document.createElement('button');
    pill.className = 'newpill';
    pill.onclick = () => { el.scrollTo({ top: el.scrollHeight, behavior: pref('motion', 'full') === 'reduced' ? 'auto' : 'smooth' }); hidePill(el); };
    host.appendChild(pill);
    el.addEventListener('scroll', () => { if (el.scrollHeight - el.scrollTop - el.clientHeight < 60) hidePill(el); });
  }
  const count = (Number(pill.dataset.n) || 0) + (n || 1);
  pill.dataset.n = count;
  pill.innerHTML = `${ic('down')}<span>${kind === 'writing' && count === 1 ? 'New answer coming in' : count === 1 ? 'New message' : `${count} new messages`}</span>`;
  pill.style.bottom = Math.max(12, host.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom + 14) + 'px';
  pill.classList.add('on');
}
function hidePill(el) {
  const pill = el.parentElement && el.parentElement.querySelector(':scope > .newpill');
  if (pill) { pill.classList.remove('on'); pill.dataset.n = 0; }
}

// ================================================================ terminal commands run by agents: live output in the job and the Terminal app
S.cmdLive = {};
function onCommandEvent(m) {
  if (m.phase === 'start') { S.cmdLive[m.cid] = ''; termPrint('c', `[${m.persona} · #${m.ticketN}] $ ${m.command}`); termPrint('m', `  in ${m.cwd}`); return; }
  if (m.phase === 'out') {
    S.cmdLive[m.cid] = ((S.cmdLive[m.cid] || '') + m.text).slice(-60000);
    for (const line of m.text.replace(/\n$/, '').split('\n')) termPrint(m.stream === 'err' ? 'e' : '', line);
    const pre = document.getElementById(`cmdo-${m.cid}`);
    if (pre) {
      const body = $('#jbody');
      const atEnd = body && body.scrollHeight - body.scrollTop - body.clientHeight < 60;
      const preEnd = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 30;
      pre.textContent = S.cmdLive[m.cid];
      if (preEnd) pre.scrollTop = pre.scrollHeight;
      if (atEnd) body.scrollTop = body.scrollHeight;
    }
    return;
  }
  if (m.phase === 'end') termPrint('m', `  → ${m.status}${m.exitCode != null ? ` (exit ${m.exitCode})` : ''}`);
}
Object.assign(ACT, {
  cmdRun: (d) => api('POST', `/api/commands/${d.cid}/decide`, { decision: 'run' }),
  cmdAll: (d) => api('POST', `/api/commands/${d.cid}/decide`, { decision: 'run', allowAll: true }),
  cmdDeny: (d) => api('POST', `/api/commands/${d.cid}/decide`, { decision: 'deny' }),
  cmdStop: (d) => api('POST', `/api/commands/${d.cid}/stop`),
  accessDecide: (d) => api('POST', `/api/edit-access/${d.id}/decide`, { decision: d.d }),
  copyCmd: (d) => { const t = S.tickets[S.job]; const c = t && (t.commands || []).find((x) => x.id === d.cid); if (c) copyText(c.command); },
  termMode: (d) => api('POST', '/api/terminal-mode', { mode: d.v }).then((r) => { S.termMode = r.mode; renderPrefs(); }),
});
