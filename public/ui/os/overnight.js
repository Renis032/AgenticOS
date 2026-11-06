'use strict';
// Overnight mode (lib/overnight.js): the queue, the settings for the night, the run as it goes, and the morning report.

function nextTime(hhmm) {
  const [h, m] = String(hhmm || '08:00').split(':').map(Number);
  const d = new Date();
  d.setHours(h || 0, m || 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

const nightRow = (x, extra, ask) => `<div class="li" data-act="openJob" data-id="${x.id}"><span class="hint mono">#${x.n}</span><span class="awt">${esc(x.title)}</span>${x.concerns ? '<span class="pill s-paused">reviewer has concerns</span>' : ''}${x.why ? (ask ? `<span class="pill s-ask">${esc(x.why)}</span>` : `<span class="hint">${esc(x.why)}</span>`) : ''}${extra || ''}</div>`;

function nightSection(title, rows, cost) {
  if (!rows.length) return '';
  return `<div class="nightsec"><h3>${esc(title)} <span class="hint">${rows.length}</span></h3>${rows.map((x) => nightRow(x, cost && x.costUsd ? `<span class="hint">${money(x.costUsd)}</span>` : '', title === 'Waiting for you')).join('')}</div>`;
}

const NIGHT_END = { empty: 'Everything that could run has run.', time: 'The finish time passed.', cap: 'It stopped at the spending cap.', stopped: 'You stopped it.' };

function nightReport(r) {
  const any = r.done.length + r.waiting.length + r.notFinished.length + r.notStarted.length;
  return `<div class="card nightreport"><h3>Last run's report</h3>
    <div class="hint">${whenAt(r.startedAt)} → ${r.endedAt ? whenAt(r.endedAt) : 'now'}. ${esc(NIGHT_END[r.reason] || '')} Spent <b>${money(r.spentUsd)}</b> of ${money(r.capUsd)} at API prices.</div>
    ${any ? nightSection('Waiting for you', r.waiting, true) + nightSection('Done', r.done, true) + nightSection('Not finished', r.notFinished, true) + nightSection('Not started', r.notStarted) : '<div class="hint" style="margin-top:8px">No job ran.</div>'}</div>`;
}

function nightRunning(r) {
  const share = r.capUsd ? Math.min(100, (r.spentUsd / r.capUsd) * 100) : 0;
  const h = r.hold;
  const status = r.capped ? 'At the spending cap: jobs in progress are paused.' : h && h.why === 'limit' ? `Held by your usage limit until ${whenAt(h.until)}. It carries on then.` : h && h.why === 'daily' ? 'Held by your daily spending limit.' : `${r.working} working, up to ${r.concurrency} at a time.`;
  return `<div class="card nightrun"><div class="row" style="margin-top:0"><h3 style="margin:0;flex:1">${ic('moon')} Working while you sleep</h3><button class="btn sm danger" data-act="nightStop" title="No new jobs start; jobs in progress carry on">Stop the run</button></div>
    <div class="nightbar"><i style="width:${share}%"></i></div>
    <div class="hint">${money(r.spentUsd)} of ${money(r.capUsd)} · finishes by ${whenAt(r.until)} · ${esc(status)}</div>
    ${r.awakeFailed ? '<div class="banner" style="margin-top:8px">The office could not keep this computer awake. Check that it won\'t go to sleep tonight.</div>' : ''}
    ${nightSection('Waiting for you', r.waiting, true) + nightSection('Done', r.done, true) + nightSection('Not finished', r.notFinished, true)}</div>`;
}

function nightQueue(O) {
  const q = O.queue;
  return `<div class="card"><div class="row" style="margin-top:0"><h3 style="margin:0;flex:1">Queue <span class="hint">${q.length}</span></h3><button class="btn sm" data-act="nightAdd">+ Add a job</button></div>
    ${q.length ? q.map((x, i) => `<div class="li nightq"><span class="hint mono">#${x.n}</span><a class="awt" data-act="openJob" data-id="${x.id}">${esc(x.title)}</a>${x.waitsFor ? `<span class="hint">after #${x.waitsFor}</span>` : ''}${x.project ? `<span class="hint">${esc(x.project)}</span>` : ''}<button class="xbtn" data-act="nightMove" data-id="${x.id}" data-dir="-1" title="Earlier" ${i ? '' : 'disabled'}>↑</button><button class="xbtn" data-act="nightMove" data-id="${x.id}" data-dir="1" title="Later" ${i < q.length - 1 ? '' : 'disabled'}>↓</button></div>`).join('') : '<div class="hint">Nothing queued. Add jobs here, or use <b>Add to overnight queue</b> on the New job page.</div>'}</div>`;
}

APPS.overnight = {
  mount(root) {
    root.innerHTML = `<div class="app"><div class="toolbar"><h1>Overnight</h1><span class="hint">Queue jobs, go to bed, and read one report in the morning.</span></div><div class="page"><div style="max-width:820px">
      <div id="nightRun"></div>
      <div id="nightQueue"></div>
      <div class="card" id="nightForm"><h3>Tonight</h3>
        <div class="nightform">
          <label class="njf">Spending cap, in dollars <input class="in" id="nightCap" type="number" min="1" step="1" value="${esc(pref('nightCap', '10'))}"></label>
          <label class="njf">Finish by <input class="in" id="nightUntil" type="time" value="${esc(pref('nightUntil', '08:00'))}"></label>
          <label class="njf">Jobs at a time <select id="nightConc">${[1, 2, 3, 4].map((n) => `<option ${String(n) === pref('nightConc', '2') ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          <label class="njf">Approve plans up to, in dollars <input class="in" id="nightPlans" type="number" min="0" step="1" value="${esc(pref('nightPlans', '0'))}" title="0 means every plan waits for you in the morning"></label>
        </div>
        <div class="hint" style="margin:8px 0">The cap counts these jobs' spend at API prices; on a plan it isn't your bill. Your usage limits still hold new work. A job that needs you waits and the rest carry on. At the cap, jobs in progress pause, so spending can pass it by what they had under way.</div>
        <div class="row"><button class="btn pri" data-act="nightStart">${ic('moon')} Work while I sleep</button></div>
      </div>
      <div id="nightLast"></div>
    </div></div></div>`;
    S.nightKey = null;
    if (S.overnight && S.overnight.last) setPref('nightSeen', S.overnight.last.id);
  },
  update() {
    const O = S.overnight;
    if (!O) return;
    const key = JSON.stringify(O);
    if (key === S.nightKey) return;
    S.nightKey = key;
    if (O.last) setPref('nightSeen', O.last.id);
    $('#nightRun').innerHTML = O.run ? nightRunning(O.run) : '';
    $('#nightQueue').innerHTML = nightQueue(O);
    $('#nightForm').style.display = O.run ? 'none' : '';
    $('#nightLast').innerHTML = O.last && !O.run ? nightReport(O.last) : '';
  },
};

Object.assign(ACT, {
  nightAdd: () => { S.njQueue = true; openApp('newjob'); },
  nightMove: (d) => api('POST', '/api/overnight/move', { id: d.id, dir: Number(d.dir) }).catch((e) => alert(e.message)),
  nightStop: () => api('POST', '/api/overnight/stop').catch((e) => alert(e.message)),
  nightStart: () => {
    const cap = $('#nightCap').value, until = $('#nightUntil').value, conc = $('#nightConc').value, plans = $('#nightPlans').value;
    setPref('nightCap', cap); setPref('nightUntil', until); setPref('nightConc', conc); setPref('nightPlans', plans);
    return api('POST', '/api/overnight/start', { capUsd: Number(cap), until: nextTime(until), concurrency: Number(conc), autoPlansUsd: Number(plans) }).catch((e) => alert(e.message));
  },
});

// A finished run's report opens once, the next time you come back to the office.
function nightReportDue() {
  const O = S.overnight;
  return !!(O && !O.run && O.last && O.last.endedAt && pref('nightSeen', '') !== O.last.id);
}
