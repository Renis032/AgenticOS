'use strict';
// The Processes app: the full process tree and the inspector.
// ================================================================ app: Processes (the full tree)
function parentOf(a) {
  if (a.id === S.root) return null;
  if (a.resident) return S.root;
  if (ACTIVE.includes(a.status) && a.parentId && S.agents[a.parentId]) return a.parentId;
  return S.agents[a.homeId] ? a.homeId : S.root;
}
function procTree() {
  const kids = {};
  for (const a of Object.values(S.agents)) { const p = parentOf(a); if (p) (kids[p] = kids[p] || []).push(a); }
  const order = (a) => (a.resident ? S.residents.indexOf(a.id) : 1000 + (ACTIVE.includes(a.status) ? 0 : 5000) + (a.no || 0));
  for (const k of Object.keys(kids)) kids[k].sort((x, y) => order(x) - order(y));
  return kids;
}
function procRows() {
  const kids = procTree();
  const q = S.pq.trim().toLowerCase();
  const jobIds = S.pjob ? new Set(Object.values(S.agents).filter((a) => (a.tickets || []).includes(S.pjob) || (S.tickets[S.pjob] && [S.tickets[S.pjob].direct, ...S.tickets[S.pjob].assignees].includes(a.id)) || (agentJob(a) || {}).id === S.pjob).map((a) => a.id)) : null;
  const keep = new Map();
  const visit = (a) => {
    const childKeep = (kids[a.id] || []).map(visit).some(Boolean);
    const busy = ACTIVE.includes(a.status) || (a.resident && a.current);
    let self = true;
    if (!S.showIdle && !a.resident && !busy) self = false;
    if (!S.showOnCall && (a.onCall || a.retired) && !busy) self = false; // hired for one project, or retired: off the team list
    if (q && !(`${a.persona} ${a.name} ${a.role} ${a.no}`.toLowerCase().includes(q))) self = false;
    if (jobIds && !jobIds.has(a.id)) self = false;
    const k = self || childKeep || a.id === S.root || (a.resident && !q && !jobIds);
    keep.set(a.id, k);
    return self || childKeep;
  };
  const root = S.agents[S.root];
  if (!root) return [];
  visit(root);
  const rows = [];
  const walk = (a, prefix, last, depth) => {
    if (!keep.get(a.id)) return;
    const list = (kids[a.id] || []).filter((c) => keep.get(c.id));
    rows.push({ a, glyph: depth ? prefix + (last ? '└─ ' : '├─ ') : '', has: list.length, depth });
    if (S.collapsed.has(a.id)) return;
    list.forEach((c, i) => walk(c, depth ? prefix + (last ? '   ' : '│  ') : '', i === list.length - 1, depth + 1));
  };
  walk(root, '', true, 0);
  return rows;
}
function activityOf(a) {
  const L = S.live[a.id] || {};
  const busy = ACTIVE.includes(a.status) || (a.resident && a.current);
  if (busy && L.thought) return { text: L.thought, think: L.kind === 'think' };
  if (busy) return { text: a.progress || 'working…' };
  if (a.status === 'offline') return { text: 'restarting…' };
  if (a.resident) return { text: (a.inbox || []).length ? `${a.inbox.length} waiting in inbox` : a.id === S.root ? 'routing — waits for jobs that the rules can\'t place' : 'waiting for work' };
  if (a.endedAt) return { text: `${a.lastOutcome || 'idle'} · last task ${ago(a.endedAt)}${a.title ? ` · ${a.title}` : ''}` };
  return { text: 'idle' };
}
const APPS = {};
APPS.processes = {
  mount(root) {
    root.innerHTML = `<div class="app">
      <div class="toolbar"><h1>Processes</h1><input class="in" id="pq" placeholder="Filter by name, role or PID…" value="${esc(S.pq)}" style="width:220px">
        <select id="pjob"><option value="">all jobs</option></select>
        <label class="chk"><input type="checkbox" id="pidle" ${S.showIdle ? 'checked' : ''}> idle staff</label>
        <label class="chk" title="Specialists hired for one project. They come back when that project does."><input type="checkbox" id="poncall" ${S.showOnCall ? 'checked' : ''}> on call</label>
        <span class="sp"></span><span class="hint" id="psum"></span>
        <button class="btn sm" data-act="expandAll">Expand all</button></div>
      <div class="split"><div class="scroll" style="flex:1"><table class="ps"><colgroup><col style="width:52px"><col style="width:34%"><col style="width:112px"><col style="width:84px"><col style="width:52px"><col><col style="width:68px"><col style="width:64px"></colgroup><thead><tr><th class="pid">PID</th><th>Process</th><th>Model</th><th>State</th><th>Job</th><th>Activity</th><th class="num">Cost</th><th class="num">Tasks</th></tr></thead><tbody id="psBody"></tbody></table></div>
      <aside class="insp" id="insp"></aside></div></div>`;
    $('#pq').oninput = (e) => { S.pq = e.target.value; APPS.processes.update(); };
    $('#pidle').onchange = (e) => { S.showIdle = e.target.checked; setPref('showIdle', S.showIdle ? '1' : '0'); APPS.processes.update(); };
    $('#poncall').onchange = (e) => { S.showOnCall = e.target.checked; setPref('showOnCall', S.showOnCall ? '1' : '0'); APPS.processes.update(); };
    $('#pjob').onchange = (e) => { S.pjob = e.target.value; APPS.processes.update(); };
    S.inspFor = null;
  },
  update() {
    const jobs = Object.values(S.tickets).filter((t) => !t.archived || t.id === S.pjob).sort((a, b) => b.createdAt - a.createdAt).slice(0, 40);
    const sel = $('#pjob');
    const opts = '<option value="">all jobs</option>' + jobs.map((t) => `<option value="${t.id}" ${S.pjob === t.id ? 'selected' : ''}>#${t.n} ${esc(short(t.title, 40))}</option>`).join('');
    if (sel.dataset.k !== opts.length + S.pjob) { sel.innerHTML = opts; sel.dataset.k = opts.length + S.pjob; }
    const rows = procRows();
    const all = Object.values(S.agents);
    const run = all.filter((a) => ['running', 'delegating'].includes(a.status) || (a.resident && a.current)).length;
    $('#psum').textContent = `${all.length} processes · ${run} running · ${all.filter((a) => a.status === 'queued').length} queued`;
    $('#psBody').innerHTML = rows.map(({ a, glyph, has }) => {
      const j = agentJob(a);
      const act = activityOf(a);
      const st = a.resident && a.current && a.status === 'idle' ? 'running' : a.status;
      const busy = ACTIVE.includes(st) || (a.resident && a.current);
      return `<tr class="${S.sel === a.id ? 'on' : ''} ${!busy && !a.resident ? 'dim' : ''}" data-act="sel" data-id="${a.id}">
        <td class="pid">${a.no || ''}</td>
        <td class="nm"><span class="tree">${esc(glyph)}</span>${has ? `<span class="tw" data-act="fold" data-id="${a.id}">${S.collapsed.has(a.id) ? '▸' : '▾'}</span>` : '<span class="tw"></span>'}<b>${esc(a.persona)}</b><span class="r">${esc(a.id === S.root ? 'router' : a.name)}</span>${a.retired ? ` <span class="hint" title="${esc(a.retired.why)}">retired</span>` : a.onCall ? ` <span class="hint" title="Hired for one project; comes back when it does">on call · ${esc(a.onCall.project || 'past job')}</span>` : ''}${a.staff && starOf(a.homeId) === a.id ? ' <span class="lv" title="most reliable on the team">★</span>' : ''}</td>
        <td>${modelChip(a)}</td><td>${pill(st)}</td>
        <td>${j ? `<a data-act="openJob" data-id="${j.id}">#${j.n}</a>` : '<span class="hint">—</span>'}</td>
        <td class="act ${act.think ? 'th' : ''}" title="${esc(act.text)}">${esc(short(act.text, 160))}</td>
        <td class="num">${money(a.costUsd)}</td>
        <td class="num">${a.resident ? (a.id === S.root ? '' : `${a.ticketsHandled || 0} jobs`) : `${a.tasksDone || 0}${a.tasksFailed ? `/<span style="color:var(--fail)">${a.tasksFailed}</span>` : ''}`}</td></tr>`;
    }).join('') || `<tr><td colspan="8" class="empty">No processes match.</td></tr>`;
    renderInspector();
  },
};
function renderInspector() {
  const el = $('#insp');
  if (!el) return;
  const a = S.agents[S.sel];
  el.classList.toggle('none', !a);
  if (!a) {
    if (S.inspFor !== '') { S.inspFor = ''; el.innerHTML = `<div class="insp-head"><h2>System</h2><div class="sub">Select a process to inspect its thinking, memory and work.</div></div><div class="body" id="inspBody"></div>`; }
    const all = Object.values(S.agents);
    $('#inspBody').innerHTML = `<div class="sec"><div class="label">Overview</div><div class="kv"><span>leads <b>${leads().length}</b></span><span>staff <b>${all.filter((x) => x.staff && !x.onCall && !x.retired).length}</b></span><span>on call <b>${all.filter((x) => x.onCall && !x.retired).length}</b></span><span>retired <b>${all.filter((x) => x.retired).length}</b></span><span>jobs done <b>${Object.values(S.tickets).filter((t) => t.status === 'done').length}</b></span><span>total spend <b>${money(all.reduce((x, y) => x + (y.costUsd || 0), 0))}</b></span></div></div>
      <div class="sec"><div class="label">How the tree works</div><div class="hint">God (PID 1) is the root and only routes jobs the routing rules can't place. Each lead runs permanently under God. Staff sit under their lead while idle; while working they appear under whoever started them, so delegations nest as deep as they go.</div></div>
      <div class="sec"><div class="label">Keys</div><div class="hint"><kbd>↑</kbd><kbd>↓</kbd> move · <kbd>←</kbd><kbd>→</kbd> fold · <kbd>Enter</kbd> inspect · <kbd>Ctrl K</kbd> launcher</div></div>`;
    return;
  }
  if (S.inspFor !== a.id) {
    S.inspFor = a.id; S.itabKey = null;
    el.innerHTML = `<div class="insp-head" id="inspHead"></div><div class="tabs" id="inspTabs"></div><div class="body" id="inspBody"></div>
      <div class="composer"><textarea id="inspText" placeholder=""></textarea><div class="row"><span class="hint" id="inspHint" style="flex:1"></span><span id="inspBtns"></span></div></div>`;
    if (!S.events[a.id]) loadEvents(a.id).then(() => { S.itabKey = null; dirty(); });
  }
  const busy = ACTIVE.includes(a.status) || (a.resident && a.current);
  const j = agentJob(a);
  const par = S.agents[parentOf(a)];
  const L = S.live[a.id] || {};
  $('#inspHead').innerHTML = `<h2>${esc(a.persona)} ${pill(a.resident && a.current && a.status === 'idle' ? 'running' : a.status)} <span class="hint mono">PID ${a.no || '?'}</span><span class="sp" style="flex:1"></span><button class="btn sm" data-act="unsel" title="Close">✕</button></h2>
    <div class="sub">${esc(a.id === S.root ? 'Router — assigns jobs the rules cannot place' : a.title || a.name)}${par ? ` · child of <a data-act="sel" data-id="${par.id}">${esc(par.persona)}</a>` : ''}</div>
    <div class="kv"><span>${modelChip(a)}</span>${a.id !== S.root ? `<span>level <b>${levelOf(a)}</b></span>` : ''}<span>cost <b>${money(a.costUsd)}</b></span><span>turns <b>${a.turns || 0}</b></span>
      ${a.resident ? `${a.id !== S.root ? `<span>jobs <b>${a.ticketsHandled || 0}</b></span>` : ''}${a.contextTokens && a.id !== S.root ? `<span>session <b>${tokens(a.contextTokens)}</b> tok</span>` : ''}` : `<span>done <b>${a.tasksDone || 0}</b></span><span>not done <b>${a.tasksFailed || 0}</b></span><span>team <b>${esc(teamName(a.homeId))}</b></span>`}
      ${a.scriptRuns ? `<span>scripts <b>${a.scriptRuns}</b></span>` : ''}${a.resident && a.id !== S.root ? (() => { const last = ((S.events[a.id] || []).filter((e) => e.kind === 'result').pop() || {}).t; if (!last) return ''; const idle = Date.now() - last; return `<span>cache <b style="color:${idle < 55 * 60000 ? 'var(--done)' : idle < 3600000 ? 'var(--stop)' : 'var(--muted)'}">${idle < 55 * 60000 ? 'warm' : idle < 3600000 ? 'cooling' : 'cold'}</b></span>`; })() : ''}</div>
    ${busy ? `<div class="now" style="margin-top:8px">${j ? `<a data-act="openJob" data-id="${j.id}">#${j.n} ${esc(short(j.title, 60))}</a><br>` : ''}<span class="${L.kind === 'think' ? 'hint' : ''}" style="${L.kind === 'think' ? 'color:var(--think);font-style:italic' : ''}">${esc(short(L.thought || a.progress || 'working…', 220))}</span>${typeof a.percent === 'number' ? `<div class="bar"><i style="width:${a.percent}%"></i></div>` : ''}</div>` : ''}
    <div class="actions">${busy && a.id !== S.root ? '<button class="btn sm danger" data-act="kill">Kill</button>' : ''}
      ${a.resident && a.id !== S.root ? '<button class="btn sm" data-act="fresh" title="Save memory, start a shorter session">Fresh session</button><button class="btn sm" data-act="review">Weekly review</button><button class="btn sm" data-act="reset" title="Restart without saving memory">Reset</button>' : ''}
      ${(a.children || []).filter((c) => S.agents[c]).length ? `<span class="hint">children: ${(a.children || []).filter((c) => S.agents[c]).slice(-6).map((c) => `<a data-act="sel" data-id="${c}">${esc(S.agents[c].persona)}</a>`).join(', ')}</span>` : ''}</div>`;
  const tabs = ['mind', 'memory', 'report', 'history'];
  $('#inspTabs').innerHTML = tabs.map((t) => `<button class="${S.itab === t ? 'on' : ''}" data-act="itab" data-tab="${t}">${{ mind: 'Mind', memory: `Memory${a.memoryVersion ? ' v' + a.memoryVersion : ''}`, report: a.resident ? 'Last answer' : 'Report', history: 'History' }[t]}</button>`).join('');
  const evs = S.events[a.id] || [];
  const key = `${a.id}|${S.itab}|${evs.length}|${a.memoryVersion}|${(a.history || []).length}|${(a.feedback || []).length}|${a.result ? a.result.length : 0}`;
  if (key !== S.itabKey) {
    S.itabKey = key;
    const body = $('#inspBody');
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
    if (S.itab === 'mind') { body.innerHTML = feedHtml(evs) || '<div class="empty">Nothing yet.</div>'; if (atBottom || !body.dataset.k || body.dataset.k !== a.id) body.scrollTop = body.scrollHeight; body.dataset.k = a.id; }
    else if (S.itab === 'memory') { body.innerHTML = '<div class="hint" style="padding:10px 0">Loading…</div>'; api('GET', `/api/agents/${a.id}/memory`).then((r) => { if (S.sel === a.id && S.itab === 'memory') body.innerHTML = r.text ? `<div class="hint" style="margin:8px 0">Shown to ${esc(a.persona)} at the start of every task${a.memoryUpdatedAt ? ` · updated ${ago(a.memoryUpdatedAt)}` : ''}.</div><div class="md">${md(r.text)}</div>` : '<div class="empty">No lessons written yet.</div>'; }); }
    else if (S.itab === 'report') body.innerHTML = a.result ? `<div class="md" style="padding-top:8px">${md(a.result)}</div>` : '<div class="empty">No report yet.</div>';
    else body.innerHTML = historyHtml(a);
  }
  const txt = $('#inspText');
  if (a.resident) { txt.placeholder = `Message ${a.persona} (opens a job on their desk)…`; $('#inspHint').textContent = ''; $('#inspBtns').innerHTML = `${a.id !== S.root ? '<button class="btn sm" data-act="feedback">As feedback</button> ' : ''}<button class="btn pri sm" data-act="message">Send</button>`; }
  else { txt.placeholder = `Coach ${a.persona}: feedback for their next task…`; $('#inspHint').textContent = ''; $('#inspBtns').innerHTML = `${!busy && a.sessionId ? '<button class="btn sm" data-act="followup" title="Continue their last task">As follow-up</button> ' : ''}<button class="btn pri sm" data-act="feedback">Send feedback</button>`; }
}
function historyHtml(a) {
  const h = (a.history || []).slice(-15).reverse();
  const fb = (a.feedback || []).slice(-8).reverse();
  const scope = a.staff ? `<div class="sec"><div class="label">Place on the team</div>${a.retired
    ? `Retired ${ago(a.retired.t)}: ${esc(a.retired.why)}. Their memory is archived. <button class="btn sm" data-act="staffBack">Bring back</button>`
    : a.onCall
    ? `On call for <b>${esc(a.onCall.project || 'a past job')}</b>: reused when that project is worked on again, off the team otherwise. <button class="btn sm" data-act="staffScope" data-team="1">Keep on the team</button>`
    : `On the team for good${a.joinedTeam ? ` (${esc(a.joinedTeam.why)})` : ''}.${a.role === 'custom' ? ' <button class="btn sm" data-act="staffScope" data-team="">Project only</button>' : ''}`}</div>` : '';
  return `${scope}${a.staff ? `<div class="sec"><div class="label">Track record</div><b>${a.tasksDone || 0}</b> done · <b>${a.tasksFailed || 0}</b> not completed · hired ${ago(a.hiredAt || a.createdAt)}
    ${h.map((x) => `<div class="line-ev">#${x.n || '?'} ${esc(short(x.title, 60))} — ${esc(x.outcome)}${x.model ? ` · ${esc(x.model)}` : ''}${x.costUsd != null ? ` · ${money(x.costUsd)}` : ''} · ${ago(x.t)}</div>`).join('')}</div>` : ''}
    <div class="sec"><div class="label">Feedback received</div>${fb.length ? fb.map((f) => `<div style="margin:6px 0"><span class="hint">${esc(f.fromPersona)}${f.ticketN ? ` · #${f.ticketN}` : ''}${f.seen ? '' : ' · not read yet'}:</span> ${esc(f.text)}</div>`).join('') : '<div class="hint">None yet.</div>'}</div>`;
}
const MIND_KINDS = ['brief', 'followup', 'thinking', 'text', 'result', 'msg_in', 'msg_out', 'doc', 'memory', 'feedback', 'script', 'script-nudge', 'delegate', 'progress', 'system'];
function feedHtml(evs) {
  return evs.filter((e) => MIND_KINDS.includes(e.kind) && !(e.kind === 'system' && /^(Back at the desk|Session [0-9a-f]{8}|Started a fresh session)/.test(e.text || ''))).slice(-250).map((e) => {
    const ts = `<span class="ts">${clock(e.t)}</span>`;
    switch (e.kind) {
      case 'brief': case 'followup': return `<div class="ev"><div class="h">${e.kind === 'brief' ? (e.chore ? 'housekeeping' : 'brief') : 'follow-up'}${ts}</div><details><summary>${esc(short(e.text, 110))}</summary><div class="b md">${md(e.text)}</div></details></div>`;
      case 'thinking': return `<div class="ev thinking"><div class="h">thinking${ts}</div><div class="b">${esc(e.text)}</div></div>`;
      case 'text': return `<div class="ev"><div class="h">says${ts}</div><div class="b md">${md(e.text)}</div></div>`;
      case 'result': return `<div class="ev result ${e.isError ? 'err' : ''}"><div class="h">${e.isError ? 'failed' : 'finished'} · ${money(e.costUsd)}${ts}</div><details><summary>final message</summary><div class="b md">${md(e.text)}</div></details></div>`;
      case 'msg_in': return `<div class="ev chat"><div class="h">from ${esc(e.fromPersona)}${e.ask ? ' · question' : ''}${ts}</div><div class="b md">${md(e.text)}</div></div>`;
      case 'msg_out': return `<div class="ev chat"><div class="h">to ${esc(e.toPersona)}${e.ask ? ' · question' : ''}${ts}</div><div class="b md">${md(e.text)}</div></div>`;
      case 'doc': return `<div class="ev doc"><div class="h">library · ${esc(e.page)}${ts}</div><details><summary>note</summary><div class="b md">${md(e.text)}</div></details></div>`;
      case 'memory': return `<div class="ev memory"><div class="h">memory v${e.version || '?'}${ts}</div><details><summary>what they remember now</summary><div class="b md">${md(e.text)}</div></details></div>`;
      case 'feedback': return `<div class="ev chat"><div class="h">feedback from ${esc(e.fromPersona)}${ts}</div><div class="b md">${md(e.text)}</div></div>`;
      case 'script': return `<div class="line-ev">$ ${esc(e.name)} ${esc((e.args || []).join(' '))} ${e.ok ? '' : '✗'} · ${clock(e.t)}</div>`;
      case 'script-nudge': return `<div class="line-ev">↪ shell command redirected to script ${esc(e.name)} · ${clock(e.t)}</div>`;
      case 'delegate': return `<div class="ev team"><div class="h">started child processes${ts}</div><div class="b">${esc(e.text)}</div></div>`;
      case 'progress': return `<div class="line-ev">• ${esc(e.text)} · ${clock(e.t)}</div>`;
      default: return `<div class="line-ev">${esc(e.text || '')} · ${clock(e.t)}</div>`;
    }
  }).join('');
}
