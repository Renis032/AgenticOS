'use strict';
// "While you were away": when the office opens after being closed, or the window comes back after AWAY_MIN minutes in the
// background, one card sums up what happened since you last looked: what waits for you, jobs finished and not finished,
// who joined or left the team, lessons the leads wrote, and what the finished jobs cost. Off with the "awayCard" preference.
const AWAY_MIN = 30;

function markSeen(force) { if (force || !document.hidden) setPref('lastSeen', String(Date.now())); }
const lastTouch = (t) => Math.max(t.closedAt || 0, t.createdAt || 0, ...((t.thread || []).slice(-1).map((e) => e.t || 0)));

function awayDigest(since) {
  const tickets = Object.values(S.tickets).filter((t) => !t.archived);
  const closed = tickets.filter((t) => t.closedAt > since && ['done', 'failed'].includes(t.status)).sort((a, b) => b.closedAt - a.closedAt);
  const done = closed.filter((t) => t.status === 'done');
  const failed = [...closed.filter((t) => t.status === 'failed'), ...tickets.filter((t) => t.status === 'interrupted' && lastTouch(t) > since)];
  const need = tickets.filter(needsYou);
  const staff = Object.values(S.agents).filter((a) => a.staff);
  const retired = staff.filter((a) => a.retired && a.retired.t > since);
  const joined = staff.filter((a) => a.joinedTeam && a.joinedTeam.t > since);
  const hired = staff.filter((a) => (a.hiredAt || 0) > since && !a.retired);
  const lessons = Object.values(S.agents).flatMap((a) => (a.lessons || []).filter((l) => l.t > since).map((l) => ({ a, l })));
  const spent = closed.reduce((n, t) => n + (t.costUsd || 0), 0);
  const any = closed.length || failed.length || need.length || retired.length || joined.length || hired.length || lessons.length;
  return { since, done, failed, need, retired, joined, hired, lessons, spent, any };
}

function renderAway(d) {
  const row = (t, extra) => `<div class="li" data-act="awayJob" data-id="${t.id}"><span class="hint mono">#${t.n}</span><span class="awt">${esc(t.title)}</span>${extra || ''}</div>`;
  const why = (t) => (t.waiting ? 'a question' : t.plan && t.plan.status === 'pending' ? `a plan · ${money(t.plan.estimateUsd)}` : pendingCmd(t) ? 'a command to run' : pendingAccess(t) ? 'edit access' : 'budget stop');
  const sec = (icon, title, n, body) => n ? `<section><h3>${ic(icon)} ${title} <span class="hint">${n}</span></h3>${body}</section>` : '';
  const more = (list, max) => (list.length > max ? `<div class="hint" style="margin:2px 0 0 4px">and ${list.length - max} more</div>` : '');
  const people = [
    ...d.hired.map((a) => `<div class="li"><b>${esc(a.persona)}</b><span class="awt hint">hired as ${esc(a.name)}${a.onCall ? ` · on call for ${esc(a.onCall.project || 'a past job')}` : ''}</span></div>`),
    ...d.joined.map((a) => `<div class="li"><b>${esc(a.persona)}</b><span class="awt hint">joined the team · ${esc(a.joinedTeam.why || '')}</span></div>`),
    ...d.retired.map((a) => `<div class="li"><b>${esc(a.persona)}</b><span class="awt hint">retired · ${esc(a.retired.why || '')}</span></div>`),
  ];
  $('#awayBody').innerHTML = `<header><div><h2>While you were away</h2><div class="hint">Since ${esc(new Date(d.since).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }))} · ${dur(Date.now() - d.since)}</div></div><button class="btn sm" data-act="awayClose" title="Close (Esc)">${ic('close')}</button></header>
    <div class="awbody">
      ${sec('bell', 'Waiting for you', d.need.length, d.need.slice(0, 6).map((t) => row(t, `<span class="pill s-paused">${why(t)}</span>`)).join('') + more(d.need, 6))}
      ${sec('check', 'Finished', d.done.length, d.done.slice(0, 6).map((t) => row(t, `<span class="hint">${money(t.costUsd)} · ${ago(t.closedAt)}</span>`)).join('') + more(d.done, 6))}
      ${sec('stop', 'Not finished', d.failed.length, d.failed.slice(0, 6).map((t) => row(t, pill(t.status))).join('') + more(d.failed, 6))}
      ${sec('teams', 'Team changes', people.length, people.slice(0, 8).join('') + more(people, 8))}
      ${sec('memory', 'Lessons the agents wrote', d.lessons.length, d.lessons.slice(0, 5).map(({ a, l }) => `<div class="li" data-act="awayMem" data-id="${a.id}"><b>${esc(a.persona)}</b><span class="awt hint">${esc(l.text)}</span></div>`).join('') + more(d.lessons, 5))}
    </div>
    <footer><span class="hint">${d.done.length + d.failed.length ? `Finished jobs cost <b>${money(d.spent)}</b> at API prices.` : ''}</span><span class="sp"></span><button class="btn sm" data-act="awayToday">Open Today</button><button class="btn pri sm" data-act="awayClose">Got it</button></footer>`;
}

function showAway(d) {
  renderAway(d);
  $('#away').classList.add('on');
  setTimeout(() => { const b = $('#away [data-act="awayClose"].pri'); if (b) b.focus(); }, 0);
}
function closeAway() { $('#away').classList.remove('on'); }

// Called once the state is loaded, and whenever the window becomes visible again.
function checkAway(force) {
  const last = Number(pref('lastSeen', '0'));
  markSeen(true);
  if (pref('awayCard', '1') !== '1' && !force) return null;
  if (!force && (!last || Date.now() - last < AWAY_MIN * 60000)) return null;
  const d = awayDigest(force ? Math.min(last || Date.now(), Date.now() - 86400000) : last);
  if (d.any || force) showAway(d);
  return d;
}

setInterval(() => markSeen(), 60000);
document.addEventListener('visibilitychange', () => { if (document.hidden) markSeen(true); else if (S.tickets && Object.keys(S.tickets).length) checkAway(); });
window.addEventListener('beforeunload', () => markSeen(true));
$('#away').addEventListener('click', (e) => { if (e.target.id === 'away') closeAway(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#away').classList.contains('on')) { e.stopImmediatePropagation(); closeAway(); } }, true);
Object.assign(ACT, {
  awayClose: closeAway,
  awayJob: (d) => { closeAway(); S.job = d.id; openApp('jobs'); },
  awayMem: (d) => { closeAway(); S.memAgent = d.id; S.memKey = null; openApp('memory'); },
  awayToday: () => { closeAway(); openApp('today'); },
});
