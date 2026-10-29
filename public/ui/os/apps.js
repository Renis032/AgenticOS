'use strict';
// Projects, New job, Messages, Memory, Library, Terminal, Usage, Health and Teams & roles.
// ================================================================ app: Projects
function boardProject(lead) { const p = S.projects.find((x) => x.department === lead && x.keywordsFromSubfolders); return p ? p.name : undefined; }
async function loadBoard(force) {
  if (!force && S.board && Date.now() - S.boardAt < 15000) return S.board;
  S.boardAt = Date.now();
  S.board = await api('GET', '/api/projects-board').catch(() => S.board || []);
  return S.board;
}
// The first list after a line that mentions "next" (a heading, bold label or plain line).
function nextSteps(state) {
  const lines = String(state || '').split('\n');
  const at = lines.findIndex((l) => /\bnext\b/i.test(l) && !/^\s*(?:[-*]|\d+[.)])\s/.test(l));
  const items = [];
  for (const l of at >= 0 ? lines.slice(at + 1) : []) {
    const m = l.match(/^\s*(?:[-*]|\d+[.)])\s+(.*)/);
    if (m) items.push(plainText(m[1]));
    else if (items.length || (l.trim() && !/^\s*$/.test(l))) break;
  }
  return items.slice(0, 4);
}
APPS.projects = {
  mount(root) {
    root.innerHTML = `<div class="app"><div class="toolbar"><h1>Projects</h1><input class="in" id="boardQ" placeholder="Filter projects…" value="${esc(S.boardQ)}" style="width:220px"><span class="hint" style="flex:1">Where each personal project stands, from its handoff. Continue starts a job that picks up there.</span><button class="btn sm" data-act="boardRefresh">Refresh</button></div>
      <div class="page"><div id="board">${skel(6, "cards")}</div><div id="pmem"></div></div></div>`;
    renderProjectMemory();
    $('#boardQ').oninput = (e) => { S.boardQ = e.target.value; APPS.projects.update(); };
    loadBoard(true).then(() => APPS.projects.update());
  },
  update() {
    const el = $('#board');
    if (!el || !S.board) return;
    if (Date.now() - S.boardAt > 15000) loadBoard().then(() => { if (S.app === 'projects') APPS.projects.update(); });
    const q = S.boardQ.toLowerCase();
    const list = S.board.filter((c) => !q || [c.name, c.about, c.handoff ? c.handoff.state : ''].join(' ').toLowerCase().includes(q));
    const active = list.filter((c) => c.handoff || c.jobs);
    const other = list.filter((c) => !c.handoff && !c.jobs);
    const card = (c) => {
      const next = c.handoff ? nextSteps(c.handoff.state) : [];
      const last = c.handoff && c.handoff.last ? c.handoff.last.split('\n') : null;
      const open = S.boardOpen === c.name;
      return `<div class="pcard"><div class="row" style="margin:0;align-items:baseline"><h3>${esc(c.name)}</h3>${c.open ? pill('running', `${c.open} open`) : ''}<span style="flex:1"></span><button class="btn pri sm" data-act="boardContinue" data-name="${esc(c.name)}" data-lead="${esc(c.lead)}">${c.handoff ? 'Continue' : 'Start'}</button></div>
        ${c.about ? `<div class="hint">${esc(c.about)}</div>` : ''}
        <div class="kv" style="margin-top:6px">${c.handoff ? `<span>updated <b>${esc(c.handoff.updated || '?')}</b></span><span><b>${c.handoff.sessions}</b> session${c.handoff.sessions === 1 ? '' : 's'}</span>` : '<span>no handoff yet</span>'}<span><b>${c.jobs}</b> job${c.jobs === 1 ? '' : 's'}</span><span><b>${money(c.costUsd)}</b></span>${c.lastJob ? `<span><a data-act="openJob" data-id="${c.lastJob.id}">#${c.lastJob.n}</a> ${pill(c.lastJob.status)}</span>` : ''}</div>
        ${next.length ? `<div class="label" style="margin-top:8px">Next steps</div><ol class="steps">${next.map((x) => `<li>${esc(short(x, 160))}</li>`).join('')}</ol>` : ''}
        ${last ? `<div class="label" style="margin-top:8px">Last session</div><div class="hint">${esc(last[0].replace(/^###\s*/, ''))}</div><div>${esc(short(plainText(last.slice(1).join(' ')), 220))}</div>` : ''}
        ${c.handoff ? `<div style="margin-top:8px"><a data-act="boardOpen" data-name="${esc(c.name)}">${open ? '▾ hide' : '▸ full handoff'}</a></div>${open ? `<div class="md" style="margin-top:6px;max-height:360px;overflow:auto">${mdRich(c.handoff.state)}</div>` : ''}` : ''}</div>`;
    };
    el.innerHTML = (active.length ? `<div class="pgrid">${active.map(card).join('')}</div>` : '<div class="empty">No project has a handoff or a job yet. Start one below, or name a project in a new job.</div>')
      + (other.length ? `<div class="label" style="margin-top:18px">Other projects</div><div class="plist">${other.map((c) => `<div class="row" style="margin:0;padding:6px 0;border-bottom:1px solid var(--line)"><b style="min-width:200px">${esc(c.name)}</b><span class="hint" style="flex:1">${esc(c.about || '')}</span><button class="btn sm" data-act="boardContinue" data-name="${esc(c.name)}" data-lead="${esc(c.lead)}">Start</button></div>`).join('')}</div>` : '');
  },
};

// What the office remembers per project (lib/project-memory.js): the user's standing instructions, decisions and known
// failures the agents recorded, and one line per finished job. Rendered on its own so the board's refreshes keep typing.
const PM_KIND = { instruction: ['your instruction', 'accent'], decision: ['decision', 'deleg'], failure: ['known failure', 'fail'], outcome: ['past job', 'idle'] };
function renderProjectMemory() {
  const el = $('#pmem');
  if (!el) return;
  const names = S.projects.filter((p) => !p.keywordsFromSubfolders).map((p) => p.name);
  if (!names.length) { el.innerHTML = ''; return; }
  const cur = names.includes(S.pmProject) ? S.pmProject : names[0];
  S.pmProject = cur;
  const list = S.pm && S.pm.project === cur ? S.pm.list : null;
  if (!list) api('GET', `/api/projects/${encodeURIComponent(cur)}/memory`).then((l) => { S.pm = { project: cur, list: l }; renderProjectMemory(); }).catch(() => {});
  const shown = (list || []).filter((e) => S.pmKind ? e.kind === S.pmKind : e.kind !== 'outcome' || S.pmAll);
  el.innerHTML = `<div class="card pmem"><h3>${ic('memory')} What the office remembers about <select id="pmSel" aria-label="Project">${names.map((n) => `<option ${n === cur ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></h3>
    <div class="hint">New jobs on this project get your instructions and only the entries relevant to them, not the whole history. Agents add decisions and known failures; the office adds a line for every finished job.</div>
    <div class="row pmadd"><input class="in" id="pmText" placeholder="Add an instruction, e.g. Use pnpm, never npm" style="flex:1"><button class="btn sm pri" data-act="pmAdd">Add</button></div>
    <div class="chips" style="margin:8px 0">${[['', 'All but past jobs'], ['instruction', 'Instructions'], ['decision', 'Decisions'], ['failure', 'Known failures'], ['outcome', 'Past jobs']].map(([k, l]) => `<button class="chip ${((S.pmKind || '') === k) ? 'on' : ''}" data-act="pmKind" data-k="${k}">${l}</button>`).join('')}</div>
    ${!list ? skel(3) : shown.length ? shown.slice(0, 60).map((e) => `<div class="li pmrow"><span class="pill" style="--c:var(--${PM_KIND[e.kind][1]})">${PM_KIND[e.kind][0]}</span><span style="flex:1;min-width:0">${esc(e.text)}</span><span class="hint">${e.ticketN ? `<a data-act="openJobN" data-n="${e.ticketN}">#${e.ticketN}</a> · ` : ''}${ago(e.t)}</span><button class="btn sm" data-act="pmDel" data-id="${e.id}" title="Forget this">Forget</button></div>`).join('')
      : '<div class="hint">Nothing remembered yet.</div>'}</div>`;
  $('#pmSel').onchange = (e) => { S.pmProject = e.target.value; S.pm = null; renderProjectMemory(); };
  $('#pmText').onkeydown = (e) => { if (e.key === 'Enter') ACT.pmAdd(); };
}
// ================================================================ app: New job
APPS.newjob = {
  mount(root) {
    root.innerHTML = `<div class="app"><div class="toolbar"><h1>New job</h1><span class="hint">Describe the task or paste the bug report. <kbd>Ctrl</kbd>+<kbd>Enter</kbd> sends.</span></div>
      <div class="page"><div style="max-width:820px">
        <div class="chips" id="njTpl"></div>
        <div class="chips" id="njChips"></div>
        <textarea id="njText" style="min-height:200px" placeholder="What should the agents do?"></textarea>
        <div class="files" id="njFiles"></div>
        <div class="row"><select id="njProject"></select><select id="njEffort" title="How hard the lead thinks on this job"><option value="">lead effort: auto</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option><option value="max">max</option></select>
          <button class="btn ibtn" data-act="attachNew">${ic('clip')} Attach files</button><label class="chk"><input type="checkbox" id="njAfter"> start after the 5-hour limit resets</label><span style="flex:1"></span><button class="btn pri" data-act="sendJob">Start job</button></div>
        <details class="njmore" id="njMore"><summary>Checks and workspace</summary>
          <label class="njf">Done when these pass <span class="hint">the office runs them itself after the lead answers; one command per line</span><textarea id="njVerify" style="min-height:44px" placeholder="e.g. npm test"></textarea></label>
          <label class="chk"><input type="checkbox" id="njIsolate"> work in a separate copy of the project (git worktree); you review and apply the changes at the end</label></details>
        <div id="njRoute" class="routecard" aria-live="polite"></div><div class="hint" id="njEst" style="margin-top:4px"></div>
      </div></div></div>`;
    const sel = $('#njProject');
    sel.innerHTML = '<option value="">Let the office decide</option>' + S.projects.map((p) => `<option value="${esc(p.name)}">${esc(p.name)} → ${esc(who(p.department))}${p.leadEffort ? ` (${esc(p.leadEffort)})` : ''}</option>`).join('');
    sel.value = pref('project', '');
    $('#njEffort').value = pref('defaultEffort', '');
    $('#njEffort').onchange = () => routePreview();
    renderTemplates();
    const txt = $('#njText');
    if (S.quickText) { txt.value = S.quickText; S.quickText = ''; }
    txt.oninput = () => routePreview();
    // Checks default to the project's (Teams & roles → Projects); editing them sets this job's own.
    const ver = $('#njVerify');
    const fillChecks = () => { if (ver.dataset.dirty) return; const p = S.projects.find((x) => x.name === sel.value); ver.value = ((p && p.verify) || []).join('\n'); if (ver.value) $('#njMore').open = true; };
    ver.oninput = () => { ver.dataset.dirty = '1'; };
    fillChecks();
    sel.onchange = () => { setPref('project', sel.value); fillChecks(); routePreview(); };
    txt.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendNewJob(); } };
    wireDrop(txt, () => S.newFiles, () => { $('#njFiles').innerHTML = S.newFiles.map((p) => fileChip(p, true)).join(''); });
    $('#njFiles').innerHTML = S.newFiles.map((p) => fileChip(p, true)).join('');
    setTimeout(() => txt.focus(), 0);
    routePreview();
    loadBoard().then(() => {
      const el = $('#njChips');
      if (!el || !S.board) return;
      const top = S.board.filter((c) => c.handoff || c.jobs).slice(0, 5);
      el.innerHTML = top.length ? `<span class="hint">Continue:</span>${top.map((c) => `<button class="chip" data-act="chipContinue" data-name="${esc(c.name)}" data-lead="${esc(c.lead)}" title="${esc(c.handoff ? `Handoff updated ${c.handoff.updated || '?'}` : `${c.jobs} earlier job${c.jobs === 1 ? '' : 's'}`)}">↻ ${esc(c.name)}</button>`).join('')}` : '';
    });
  },
  update() {
    const done = Object.values(S.tickets).filter((t) => t.status === 'done' && t.costUsd > 0.02).map((t) => t.costUsd).sort((a, b) => a - b);
    const w = windowOf('five_hour');
    $('#njEst').textContent = (done.length ? `A typical job costs ${money(done[Math.floor(done.length / 2)])}${ticketShare(done[Math.floor(done.length / 2)]) ? ` (${ticketShare(done[Math.floor(done.length / 2)])})` : ''}. ` : '') + (w ? `5-hour limit ${pct(live(w))} used.` : '');
  },
};
let routeTimer = null;
function routePreview() {
  clearTimeout(routeTimer);
  routeTimer = setTimeout(async () => {
    const el = $('#njRoute'); if (!el) return;
    const text = $('#njText').value.trim();
    const project = $('#njProject').value;
    if (!text && !project) { el.innerHTML = ''; return; }
    const r = await api('POST', '/api/route-preview', { text, project: project || undefined, effort: $('#njEffort').value || undefined, attachments: S.newFiles }).catch(() => null);
    if (!r || !$('#njRoute')) return;
    const to = r.via === 'god' ? 'The office will pick the lead' : `Goes to <b>${esc(r.persona || '?')}</b>`;
    const why = r.via === 'god' ? `(${esc(r.reason || 'nothing matched')}; God reads it and assigns it)` : r.via === 'rules' ? `(${esc(r.reason)})` : '';
    const busy = r.busyWith && r.via !== 'god' ? `<div class="hint">${esc(r.persona)} is busy with #${r.busyWith.n}; ${r.twins > 0 ? `a second ${esc(r.persona)} will take this one` : 'this one waits until they finish'}.</div>` : '';
    $('#njRoute').innerHTML = `<div class="rc"><span class="arrow">→</span><span>${to}${r.project ? ` · <b>${esc(r.project)}</b>` : ''} ${why}</span></div>
      <div class="rc2">${r.effort ? `<span class="tag">${esc(r.effort)} effort</span> <span class="hint">${esc(r.effortWhy)}</span>` : `<span class="hint">effort: ${esc(r.effortWhy)}</span>`}${r.estimateUsd != null ? ` <span class="tag">≈ ${money(r.estimateUsd)}</span> <span class="hint">${ticketShare(r.estimateUsd) ? `${ticketShare(r.estimateUsd).replace(/^≈ /, '')} · ` : ''}typical for ${r.basedOn} similar job${r.basedOn === 1 ? '' : 's'}</span>` : ''}</div>${busy}`;
  }, 300);
}
// Templates: a head start for the usual kinds of job. Built-in ones plus your own (saved in this window).
const BUILTIN_TEMPLATES = [
  { name: 'Bug report', effort: 'xhigh', text: 'Bug: <what happens>\n\nExpected: <what should happen>\n\nSteps to reproduce:\n1. <first step>\n\nError or log:\n<paste it here>' },
  { name: 'New feature', effort: 'high', text: 'Add <the feature> to <the project>.\n\nWhat it should do:\n- <behaviour>\n\nDone when:\n- <how we know it works>' },
  { name: 'Code review', effort: 'high', text: 'Review <the files, branch or change> for bugs, risks and missing tests. List findings by severity with file:line. Don\'t change anything.' },
  { name: 'Research', effort: 'high', text: 'Research <the topic>: compare the main options with sources, and recommend one for <my situation>.' },
  { name: 'Quick question', effort: 'medium', text: '<your question>' },
];
const userTemplates = () => prefObj('templates') || [];
function renderTemplates() {
  const el = $('#njTpl'); if (!el) return;
  const mine = userTemplates();
  el.innerHTML = `<span class="hint">Start from:</span>${BUILTIN_TEMPLATES.map((t, i) => `<button class="chip" data-act="useTpl" data-k="b${i}" title="${esc(t.text.slice(0, 120))}">${esc(t.name)}</button>`).join('')}`
    + mine.map((t, i) => `<span class="chip mine"><button class="lnk" data-act="useTpl" data-k="u${i}" title="${esc(t.text.slice(0, 120))}">${esc(t.name)}</button><button class="x" data-act="delTpl" data-i="${i}" title="Remove this template" aria-label="Remove template ${esc(t.name)}">×</button></span>`).join('')
    + '<button class="chip ghost" data-act="saveTpl" title="Save what you typed as a template">+ Save as template</button>';
}
function useTemplate(k) {
  const t = k[0] === 'b' ? BUILTIN_TEMPLATES[+k.slice(1)] : userTemplates()[+k.slice(1)];
  if (!t) return;
  const box = $('#njText');
  if (box.value.trim() && !confirm('Replace what you typed with this template?')) return;
  box.value = t.text;
  if (t.effort) $('#njEffort').value = t.effort;
  if (t.project !== undefined && [...$('#njProject').options].some((o) => o.value === t.project)) $('#njProject').value = t.project;
  box.focus();
  const m = box.value.match(/<[^<>\n]+>/);
  if (m) box.setSelectionRange(m.index, m.index + m[0].length);
  routePreview();
}
async function sendNewJob() {
  const text = $('#njText').value.trim();
  if (!text) return;
  const ver = $('#njVerify');
  const r = await api('POST', '/api/tasks', { text, project: $('#njProject').value || undefined, effort: $('#njEffort').value || undefined, attachments: S.newFiles, after: $('#njAfter').checked ? 'reset' : undefined,
    verify: ver && ver.dataset.dirty ? ver.value : undefined, isolate: $('#njIsolate') && $('#njIsolate').checked ? true : undefined }).catch((e) => alert(e.message));
  if (!r) return;
  S.newFiles = [];
  S.job = r.id; S.jtab = 'thread';
  const wait = () => (S.tickets[r.id] ? openApp('jobs') : setTimeout(wait, 150));
  wait();
}

// ================================================================ app: Messages (team rooms)
APPS.messages = {
  mount(root) {
    if (!S.chatTeam || !leads().includes(S.chatTeam)) S.chatTeam = leads()[0];
    root.innerHTML = `<div class="app"><div class="two"><div class="list" id="mtList"></div><div style="flex:1;display:flex;flex-direction:column;min-width:0">
      <div class="toolbar"><h1 id="mtTitle"></h1><span class="hint">What teammates say to each other while they work, and your questions to a whole team.</span></div>
      <div class="body" id="mtBody" style="padding:6px 18px"></div>
      <div class="composer"><textarea id="mtText"></textarea><div class="row"><span class="hint" id="mtHint" style="flex:1"></span><button class="btn pri sm" data-act="askTeam">Ask the team</button></div></div></div></div></div>`;
    S.chat = null;
  },
  update() {
    $('#mtList').innerHTML = '<div class="grp">Teams</div>' + leads().map((k) => `<div class="li ${S.chatTeam === k ? 'on' : ''}" data-act="chatTeam" data-id="${k}"><b>${esc(teamName(k))}</b><span class="hint">${esc(who(k))}</span></div>`).join('');
    const k = S.chatTeam;
    $('#mtTitle').textContent = teamName(k);
    $('#mtText').placeholder = `Ask the whole ${teamName(k)} team… (${who(k)} gathers their input and answers)`;
    $('#mtHint').textContent = `Opens a job on ${who(k)}'s desk.`;
    if (!S.chat || S.chat.k !== k) {
      S.chat = { k, list: null };
      api('GET', `/api/teams/${k}/chat`).then((l) => { S.chat = { k, list: l }; S.chatKey = null; dirty(); });
    }
    const list = S.chat.list;
    const key = k + '|' + (list ? list.length : -1);
    if (key === S.chatKey) return;
    S.chatKey = key;
    const b = $('#mtBody');
    const sameRoom = S.chatRoomFor === k;
    const grew = sameRoom && list && list.length > (S.chatLen || 0);
    const mineChat = grew && list.slice(S.chatLen || 0).every((m) => m.fromId === 'user');
    const atEndChat = b.scrollHeight - b.scrollTop - b.clientHeight < 60;
    const topChat = b.scrollTop;
    b.innerHTML = list === null ? skel(5) : list.length ? list.map((m) => `<div class="chatmsg ${m.fromId === 'user' ? 'me' : ''}"><div class="h"><b ${m.fromId !== 'user' ? `data-act="sel2" data-id="${m.fromId}" style="cursor:pointer"` : ''}>${esc(m.from)}</b> → ${esc(m.to || '')}${m.ask ? ' · question' : ''}<span class="ts">${ago(m.t)}</span></div><div class="md">${md(m.text)}</div>${m.ticketId ? `<a class="hint" data-act="openJob" data-id="${m.ticketId}">open job</a>` : ''}</div>`).join('') : '<div class="empty">Quiet so far.</div>';
    if (!sameRoom || atEndChat || mineChat) b.scrollTop = b.scrollHeight;
    else { b.scrollTop = topChat; if (grew) newPill(b, list.length - (S.chatLen || 0)); }
    S.chatRoomFor = k; S.chatLen = list ? list.length : 0;
  },
};

// ================================================================ app: Memory
APPS.memory = {
  mount(root) {
    root.innerHTML = `<div class="app"><div class="two"><div class="list" id="memList"></div><div style="flex:1;display:flex;flex-direction:column;min-width:0"><div class="toolbar"><h1 id="memTitle">Memory</h1><span class="hint" id="memSub"></span></div><div class="page" id="memBody"></div></div></div></div>`;
    S.memKey = null;
  },
  update() {
    const groups = leads().map((k) => [k, [S.agents[k], ...Object.values(S.agents).filter((a) => a.staff && a.homeId === k).sort((x, y) => !!x.retired - !!y.retired || !!x.onCall - !!y.onCall || (y.memoryVersion || 0) - (x.memoryVersion || 0))].filter(Boolean)]);
    $('#memList').innerHTML = groups.map(([k, list]) => `<div class="grp">${esc(teamName(k))}</div>` + list.map((a) => `<div class="li ${S.memAgent === a.id ? 'on' : ''}" data-act="memSel" data-id="${a.id}"><span>${esc(a.persona)}${a.retired ? ' <span class="hint">retired</span>' : a.onCall ? ` <span class="hint">on call · ${esc(a.onCall.project || 'past job')}</span>` : ''}</span><span class="hint">${a.memoryVersion ? 'v' + a.memoryVersion : 'empty'}</span></div>`).join('')).join('');
    const a = S.agents[S.memAgent];
    if (!a) { $('#memBody').innerHTML = '<div class="empty">Pick an agent to read what they have learned. Each agent rewrites its memory at the end of a task, and sees it at the start of the next.</div>'; return; }
    const L = a.lessons || [];
    const drafts = lessonDrafts().filter((x) => x.a.id === a.id);
    const key = a.id + '|' + a.memoryVersion + '|' + L.map((l) => l.id).join() + '|' + drafts.map((x) => x.l.id).join() + '|' + S.lessonEdit;
    if (key === S.memKey) return;
    if (document.activeElement && document.activeElement.classList.contains('lrin') && S.lessonEdit) return;
    S.memKey = key;
    $('#memTitle').textContent = `${a.persona} · memory`;
    $('#memSub').textContent = a.memoryVersion ? `version ${a.memoryVersion}${a.memoryUpdatedAt ? ' · updated ' + ago(a.memoryUpdatedAt) : ''}` : '';
    // Lessons: one line each, written after a job failed, was rated 👎, needed rework or was undone (lib/lessons.js).
    const lessonsHtml = L.length ? `<div class="card lessons" style="max-width:820px;margin-bottom:14px"><h3>${ic('bell')} Lessons from jobs that went wrong <span class="hint">${L.length} of 8</span></h3>${L.slice().reverse().map((l) => `<div class="li"><span style="flex:1;min-width:0">${esc(l.text)}</span><span class="hint">${l.ticketN ? '#' + l.ticketN + ' · ' : ''}${ago(l.t)}</span><button class="btn sm" data-act="lessonDel" data-id="${a.id}" data-lid="${l.id}" title="Remove this lesson">Remove</button></div>`).join('')}</div>` : '';
    api('GET', `/api/agents/${a.id}/memory`).then((r) => { if (S.memAgent === a.id) $('#memBody').innerHTML = `<div style="max-width:820px;margin-bottom:14px">${lessonReviewHtml(drafts)}</div>` + lessonsHtml + (r.text ? `<div class="md" style="max-width:820px">${md(r.text)}</div>` : '<div class="empty">Nothing written yet.</div>'); });
  },
};

// ================================================================ app: Library (file browser)
APPS.library = {
  mount(root) {
    root.innerHTML = `<div class="app"><div class="two"><div class="list" id="libList"></div><div style="flex:1;display:flex;flex-direction:column;min-width:0">
      <div class="toolbar"><h1 id="libTitle">Library</h1><span class="sp"></span><button class="btn sm" data-act="libCheck">Run library check</button><button class="btn sm" data-act="libTidy">Tidy now</button></div>
      <div class="page" id="libBody"></div></div></div></div>`;
    S.libKey = null;
  },
  update() {
    if (!S.teams) { S.teams = 'loading'; api('GET', '/api/teams').then((l) => { S.teams = l; dirty(); }).catch(() => { S.teams = []; }); return; }
    if (S.teams === 'loading') return;
    if (!S.libTeam) S.libTeam = (S.teams.find((x) => leads().includes(x.key)) || S.teams[0] || {}).key;
    if (!S.inbox) { S.inbox = 'loading'; api('GET', '/api/arms/inbox').then((l) => { S.inbox = l; S.libKey = null; dirty(); }).catch(() => { S.inbox = []; }); }
    const inbox = Array.isArray(S.inbox) ? S.inbox : [];
    $('#libList').innerHTML = `<div class="grp">Reading inbox</div>${inbox.filter((x) => x.kind === 'inbox').slice(0, 30).map((x) => `<div class="li ${S.libPage === 'inbox:' + x.name ? 'on' : ''}" data-act="libPage" data-team="inbox" data-path="inbox:${esc(x.name)}"><span class="mono" style="font-size:12px;overflow:hidden;text-overflow:ellipsis">${esc(x.name)}</span><span class="hint">${ago(x.mtime)}</span></div>`).join('') || '<div class="li hint">Empty. Save pages with the Chrome extension.</div>'}
      <div class="grp">Artifacts</div><div class="li"><a href="/artifacts/" target="_blank">open the artifacts inbox</a><span class="hint">${inbox.filter((x) => x.kind === 'artifact').length}</span></div>` + S.teams.map((tm) => `<div class="grp">${esc(tm.room || tm.key)}</div>` + tm.pages.map((pg) => `<div class="li ${S.libPage === pg.path ? 'on' : ''}" data-act="libPage" data-team="${tm.key}" data-path="${esc(pg.path)}"><span class="mono" style="font-size:12px">${esc(pg.name)}</span><span class="hint">${ago(pg.mtime)}</span></div>`).join('')).join('');
    const tm = S.teams.find((x) => x.key === S.libTeam);
    const key = `${S.libTeam}|${S.libPage}|${S.libCheck ? S.libCheck.at : 0}`;
    if (key === S.libKey) return;
    S.libKey = key;
    $('#libTitle').textContent = tm ? `${tm.room || tm.key} library` : 'Library';
    const body = $('#libBody');
    const check = S.libCheck && S.libCheck.team === S.libTeam ? `<div class="card" style="margin-bottom:14px"><h3>Library check</h3><pre>${esc(S.libCheck.text)}</pre></div>` : '';
    if (!S.libPage) { body.innerHTML = check + `<div class="hint">${tm ? `${tm.pages.length} pages · ${tm.sinceTidy || 0} notes since the last check${tm.lastTidy ? ` · last tidy-up ${ago(tm.lastTidy)}` : ''}. Pick a page.` : ''}</div>`; return; }
    (S.libPage.startsWith('inbox:') ? api('GET', '/api/arms/inbox/page?kind=inbox&name=' + encodeURIComponent(S.libPage.slice(6))) : api('GET', '/api/teams/page?path=' + encodeURIComponent(S.libPage))).then((r) => { if (S.libKey === key) body.innerHTML = check + `<div class="hint mono" style="margin-bottom:10px">${esc(S.libPage)}</div><div class="md" style="max-width:860px">${md(r.text)}</div>`; }).catch((e) => { body.innerHTML = esc(e.message); });
  },
};

// ================================================================ app: Terminal
APPS.terminal = {
  mount(root) {
    root.innerHTML = `<div class="app"><div class="toolbar"><h1>Terminal</h1><span class="hint">Office scripts and system commands. Type <code>help</code>.</span></div>
      <div class="term" id="termOut"></div><div class="termin"><span>agentos $</span><input id="termIn" autocomplete="off" spellcheck="false"></div></div>`;
    const inp = $('#termIn');
    inp.onkeydown = (e) => {
      const T = S.term;
      if (e.key === 'Enter') { const v = inp.value; inp.value = ''; T.hi = -1; if (v.trim()) { T.hist.push(v); termRun(v.trim()); } }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (T.hist.length) { T.hi = T.hi < 0 ? T.hist.length - 1 : Math.max(0, T.hi - 1); inp.value = T.hist[T.hi]; } }
      else if (e.key === 'ArrowDown') { e.preventDefault(); if (T.hi >= 0) { T.hi = Math.min(T.hist.length, T.hi + 1); inp.value = T.hist[T.hi] || ''; if (T.hi >= T.hist.length) T.hi = -1; } }
    };
    if (!S.term.out.length) termPrint('m', 'Agentic OS terminal. Commands: help · ps · jobs · open <pid|#job> · kill <pid> · new <job text> · clear · and every office script (e.g. count README.md).');
    termRender();
    setTimeout(() => inp.focus(), 0);
    $('#termOut').onclick = () => inp.focus();
  },
  update() {},
};
function termPrint(cls, text) { S.term.out.push({ cls, text }); if (S.term.out.length > 400) S.term.out.splice(0, 100); termRender(); }
function termRender() { const o = $('#termOut'); if (!o) return; o.innerHTML = S.term.out.map((l) => `<div class="${l.cls}">${esc(l.text)}</div>`).join(''); o.scrollTop = o.scrollHeight; }
function argv(s) { return (s.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((w) => w.replace(/^(["'])(.*)\1$/, '$2')); }
async function termRun(line) {
  termPrint('c', '$ ' + line);
  const [cmd, ...args] = argv(line);
  const byPid = (x) => Object.values(S.agents).find((a) => String(a.no) === String(x) || a.persona.toLowerCase() === String(x).toLowerCase());
  if (cmd === 'clear') { S.term.out = []; return termRender(); }
  if (cmd === 'help') return termPrint('', ['ps                 process tree', 'jobs               open and recent jobs', 'open <pid|#n>      inspect a process or job', 'kill <pid>         stop a running process', 'new <text>         start a job', 'clear', '', 'Office scripts:', ...S.scripts.map((x) => `  ${x.usage.padEnd(58)} ${x.does}`)].join('\n'));
  if (cmd === 'ps') return termPrint('', procRows().map(({ a, glyph }) => `${String(a.no || '').padStart(4)}  ${(glyph + a.persona).padEnd(26)} ${`${a.model || '-'}/${a.effort || '-'}`.padEnd(14)} ${stateLabel(a.resident && a.current ? 'running' : a.status).padEnd(9)} ${(agentJob(a) ? '#' + agentJob(a).n : '-').padEnd(5)} ${money(a.costUsd)}`).join('\n'));
  if (cmd === 'jobs') return termPrint('', Object.values(S.tickets).filter((t) => !t.archived).sort((a, b) => b.createdAt - a.createdAt).slice(0, 20).map((t) => `#${String(t.n).padEnd(4)} ${stateLabel(t.status).padEnd(10)} ${money(t.costUsd).padStart(7)}  ${short(t.title, 70)}`).join('\n') || 'no jobs');
  if (cmd === 'open') { const x = args[0] || ''; if (x.startsWith('#')) { const t = Object.values(S.tickets).find((j) => '#' + j.n === x); if (t) { S.job = t.id; return openApp('jobs'); } } const a = byPid(x); if (a) { S.sel = a.id; return openApp('processes'); } return termPrint('e', 'not found: ' + x); }
  if (cmd === 'kill') { const a = byPid(args[0]); if (!a) return termPrint('e', 'no such process'); await api('POST', `/api/agents/${a.id}/stop`).catch((e) => termPrint('e', e.message)); return termPrint('m', `sent stop to ${a.persona} (${a.no})`); }
  if (cmd === 'new') { const text = args.join(' '); if (!text) return termPrint('e', 'usage: new <job text>'); const r = await api('POST', '/api/tasks', { text }).catch((e) => termPrint('e', e.message)); if (r) termPrint('m', `job started (${r.id}); open it in Jobs.`); return; }
  if (S.scripts.some((x) => x.name === cmd)) {
    const r = await api('POST', '/api/script', { name: cmd, args }).catch((e) => ({ error: e.message }));
    return termPrint(r.error ? 'e' : '', r.error || r.message);
  }
  termPrint('e', `unknown command: ${cmd} (try help)`);
}

// ================================================================ app: Usage
// What it costs to get a job done well (lib/outcomes.js): successes are jobs done with passing checks, not rated down,
// not undone and not followed up within two hours.
function outcomesHtml(o, L) {
  const O = o.overall;
  const rate = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
  const row = (g) => `<tr><td>${esc(g.name)}</td><td class="num">${g.jobs}</td><td class="num">${rate(g.successRate)}</td><td class="num">${g.checked ? `${g.checkFails}` : '–'}</td><td class="num">${g.retries}</td><td class="num">${g.medianMinutes == null ? '–' : dur(g.medianMinutes * 60000)}</td><td class="num">${money(g.costUsd)}</td><td class="num"><b>${g.costPerSuccess == null ? '–' : money(g.costPerSuccess)}</b></td></tr>`;
  const table = (rows, first) => rows.length ? `<table class="ps otab"><thead><tr><th>${first}</th><th class="num">Jobs</th><th class="num">Success</th><th class="num">Check fails</th><th class="num">Retries</th><th class="num">Median time</th><th class="num">Cost</th><th class="num">Per success</th></tr></thead><tbody>${rows.map(row).join('')}</tbody></table>` : '<div class="hint">No finished jobs yet.</div>';
  return `<div class="cards" style="margin-top:12px"><div class="card wide"><h3>${ic('check')} Cost per successful job · last ${o.days} days</h3>
    <div class="ostats"><div><div class="big">${O.costPerSuccess == null ? '–' : money(O.costPerSuccess)}</div><div class="hint">per successful job</div></div><div><div class="big">${rate(O.successRate)}</div><div class="hint">${O.succeeded} of ${O.jobs} jobs succeeded</div></div><div><div class="big">${O.costPerJob == null ? '–' : money(O.costPerJob)}</div><div class="hint">per job, any outcome</div></div><div><div class="big">${O.checkFails}</div><div class="hint">check failures · ${O.retries} retries</div></div>${L.dailyCap ? `<div><div class="big">${money(L.today)}</div><div class="hint">today, of ${money(L.dailyCap)} limit</div></div>` : ''}</div>
    <div class="hint" style="margin:6px 0 10px">A success is a job that ended done, with its checks passing, not rated down, not undone and not followed up within two hours. Failed and reworked jobs still cost money, which is why cost per success is the number to watch.</div>
    <div class="label">By lead</div>${table(o.byLead, 'Lead')}
    ${o.byProject.length ? `<div class="label" style="margin-top:12px">By project</div>${table(o.byProject, 'Project')}` : ''}
    ${o.failing.length ? `<div class="label" style="margin-top:12px">Recent jobs that didn't succeed</div>${o.failing.map((t) => `<div class="li" data-act="openJob" data-id="${t.id}"><span class="hint mono">#${t.n}</span><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.title)}</span><span class="hint">${esc(t.why)} · ${money(t.costUsd)}</span></div>`).join('')}` : ''}</div></div>`;
}
APPS.usage = {
  mount(root) { root.innerHTML = `<div class="app"><div class="toolbar"><h1>Usage</h1><span class="hint">Plan limits as Anthropic reports them on every agent run, and office spend.</span><span class="sp"></span><button class="btn sm" data-act="limRefresh">Refresh</button></div><div class="page" id="usBody"></div></div>`; S.usKey = null; },
  update() {
    if (!S.spend || Date.now() - S.spend.at > 60000) { S.spend = { at: Date.now(), data: S.spend && S.spend.data }; api('GET', '/api/spend').then((d) => { S.spend = { at: Date.now(), data: d }; S.usKey = null; dirty(); }).catch(() => {}); }
    const L = S.limits || { windows: {} };
    if (!S.outc || Date.now() - S.outc.at > 60000) { S.outc = { at: Date.now(), data: S.outc && S.outc.data }; api('GET', '/api/outcomes?days=30').then((d) => { S.outc = { at: Date.now(), data: d }; S.usKey = null; dirty(); }).catch(() => {}); }
    const key = `${L.updatedAt}|${L.probing}|${!!L.hold}|${S.spend.data ? S.spend.at : 0}|${S.outc.data ? S.outc.at : 0}|${Math.floor(Date.now() / 30000)}`;
    if (key === S.usKey) return;
    S.usKey = key;
    const wins = Object.entries(L.windows || {}).sort(([a], [b]) => (a === 'five_hour' ? -1 : b === 'five_hour' ? 1 : a.localeCompare(b)));
    const names = { five_hour: '5-hour window', seven_day: 'Weekly', seven_day_opus: 'Weekly · Opus', seven_day_sonnet: 'Weekly · Sonnet' };
    let html = `<div class="hint" style="margin-bottom:12px">Claude ${L.plan ? esc(L.plan) : ''} plan · updated ${L.updatedAt ? ago(L.updatedAt) : 'never'}. New work pauses at ${pct(L.pauseAt || 0.85)} and asks you whether to continue.${L.hold ? ' <b style="color:var(--fail)">Paused now.</b> <button class="btn pri sm" data-act="limContinue">Continue anyway</button>' : ''}</div><div class="cards">`;
    for (const [k, w] of wins) {
      const u = live(w), e = w.est || {};
      html += `<div class="card"><h3>${esc(names[k] || k)}</h3><div class="big">${pct(u)}</div><div class="wbar"><i style="width:${Math.min(100, u * 100)}%;background:${meterColor(u)}"></i></div>
        <div class="hint">${w.resetsAt ? (w.resetsAt < Date.now() ? 'has reset since the last reading' : `resets ${whenAt(w.resetsAt)} (in ${dur(w.resetsAt - Date.now())})`) : ''}</div>
        ${e.hitsAt ? (e.hitsAt < (w.resetsAt || Infinity) ? `<div style="color:var(--fail);margin-top:6px">At the last hour's pace (${pct(e.perHour)}/h) you'd hit it around <b>${whenAt(e.hitsAt)}</b>.</div>` : `<div class="hint" style="margin-top:6px">At the last hour's pace (${pct(e.perHour)}/h) you won't reach it before the reset.</div>`) : ''}
        ${e.fullUsd ? `<div style="margin-top:8px">Whole window ≈ <b>${money(e.fullUsd)}</b> of office work${e.fullTokens ? ` · ≈ <b>${tokens(e.fullTokens)}</b> tokens` : ''}<br>Left ≈ <b>${money(e.remainingUsd)}</b></div>` : `<div class="hint" style="margin-top:8px">Window size: still learning (${money(e.calibratedOnUsd || 0)} of office spend seen; needs $1 and 3 points of movement).</div>`}</div>`;
    }
    html += '</div>';
    const sp = S.spend.data;
    if (sp) {
      const maxD = Math.max(0.01, ...sp.days.map((d) => d.usd));
      const hb = (rows) => { const mx = Math.max(0.01, ...rows.map((r) => r.usd)); return rows.map((r) => `<div class="hbar"><span class="n">${esc(r.label || r.key)}</span><span class="t" data-tip="${esc(r.label || r.key)}: ${money(r.usd)}"><i style="width:${(r.usd / mx) * 100}%"></i></span><span class="v">${money(r.usd)}</span></div>`).join(''); };
      html += `<div class="cards" style="margin-top:12px"><div class="card" style="grid-column:span 2"><h3>Office spend · last 14 days · ${money(sp.days.reduce((x, d) => x + d.usd, 0))}</h3>
        <div class="chart">${sp.days.map((d) => `<i class="${d.usd ? '' : 'z'}" style="height:${d.usd ? Math.max(3, (d.usd / maxD) * 100) : 2}%" data-tip="${new Date(d.day + 'T12:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}: ${money(d.usd)}"></i>`).join('')}</div>
        <div class="hint" style="display:flex;justify-content:space-between"><span>${new Date(sp.days[0].day + 'T12:00').toLocaleDateString([], { month: 'short', day: 'numeric' })}</span><span>peak ${money(maxD)}/day</span><span>today</span></div></div>
        <div class="card"><h3>By team</h3>${hb(sp.teams.map((r) => ({ ...r, label: r.key === S.root ? 'God (routing)' : `${r.label}'s team` })))}</div>
        <div class="card"><h3>By model</h3>${hb(sp.models)}</div></div>`;
    }
    if (S.outc.data) html += outcomesHtml(S.outc.data, L);
    html += `<div class="hint" style="margin-top:14px;max-width:820px">Anthropic reports limits as percentages, not tokens; the window size is estimated from how far the bar moves while the office spends. Other Claude use moves the same bars, so estimates lean low. Dollars are API-equivalent prices, covered by your plan.</div>`;
    $('#usBody').innerHTML = html;
  },
};

// ================================================================ app: Health
APPS.health = {
  mount(root) { root.innerHTML = `<div class="app"><div class="toolbar"><h1>Health</h1><span class="hint" id="hSub"></span><span class="sp"></span><button class="btn sm" data-act="healthRefresh">Refresh</button><button class="btn pri sm" data-act="selftest">Run self-test</button></div><div class="page" id="hBody"></div></div>`; S.hKey = null; S.evals = null; refreshHealth(); },
  update() {
    const h = S.health;
    if (!h) return;
    const st = S.selftest || h.selftest;
    if (!S.evals) { S.evals = 'loading'; api('GET', '/api/evals').then((e) => { S.evals = e; S.hKey = null; dirty(); }).catch(() => { S.evals = { runs: [] }; }); }
    const ev = S.evals === 'loading' ? null : S.evals;
    const key = `${JSON.stringify(h).length}|${st ? st.status + st.steps.length : ''}|${ev ? ev.runs.length + '' + !!ev.running : ''}`;
    if (key === S.hKey) return;
    S.hKey = key;
    $('#hSub').textContent = { ok: 'Everything looks fine.', warn: 'Working, with a few things to look at.', bad: 'Something needs attention.' }[h.level];
    const lg = h.login;
    const loginTxt = !lg ? 'Could not read the Claude login.' : lg.refreshExpiresAt ? (lg.refreshExpiresAt < Date.now() ? '<b style="color:var(--fail)">Expired.</b> Run <code>claude</code> and log in again.' : `Valid; renews automatically until ${new Date(lg.refreshExpiresAt).toLocaleDateString()}.`) : 'Logged in.';
    $('#hBody').innerHTML = `<div class="cards">
      <div class="card"><h3>System</h3><div class="kv" style="margin:0"><span>status <b><span class="dot ${h.level}"></span> ${esc(h.level)}</b></span><span>server up <b>${dur(Date.now() - h.server.startedAt)}</b></span><span>${esc(h.server.claude || '')}</span><span>node <b>${esc(h.server.node)}</b></span>${h.server.dataKb ? `<span>data <b>${(h.server.dataKb / 1024).toFixed(1)} MB</b></span>` : ''}</div><div class="hint" style="margin-top:8px">${loginTxt}<br>Desktop app only: the backend answers only this window and its own agents.</div></div>
      <div class="card"><h3>Self-test</h3>${st ? `<b>${st.status === 'running' ? 'Running…' : st.status === 'passed' ? '✅ Passed' : st.status === 'interrupted' ? 'Interrupted' : '❌ Failed'}</b> <span class="hint">${ago(st.startedAt)}${st.finishedAt ? ` · ${dur(st.finishedAt - st.startedAt)} · ${money(st.costUsd)}` : ''}</span>${st.steps.map((x) => `<div class="step"><span class="i">${x.ok ? '✅' : '❌'}</span><span>${esc(x.name)}${x.detail ? ` <span class="hint">· ${esc(x.detail)}</span>` : ''}</span></div>`).join('')}${st.ticketId && S.tickets[st.ticketId] ? `<a class="hint" data-act="openJob" data-id="${st.ticketId}">open the test job</a>` : ''}` : '<div class="hint">Sends one small job through routing, search, a child process, a question, an edit and undo. About $0.15.</div>'}</div>
      <div class="card"><h3>Leads</h3>${h.residents.map((r) => `<div class="rolerow"><div class="top"><span class="pill s-${r.status}">${esc(r.status)}</span><a data-act="sel2" data-id="${r.id}"><b>${esc(r.persona)}</b></a><span class="hint">${esc(r.model)}/${esc(r.effort)}${r.upSince ? ` · up ${dur(Date.now() - r.upSince)}` : ''}${r.restarts ? ` · ${r.restarts} restarts` : ''}</span></div>${r.id !== S.root ? `<div class="hint">session ${tokens(r.contextTokens)} / ${tokens(h.refresh.contextTokens)} tokens${r.needsRefresh ? ' · refreshes after its next job' : ''}</div><div class="bar"><i style="width:${Math.min(100, (r.contextTokens / h.refresh.contextTokens) * 100)}%"></i></div>` : '<div class="hint">fresh session every job</div>'}</div>`).join('')}</div>
      <div class="card"><h3>Office scripts</h3>${(h.scripts || []).length ? h.scripts.map((x) => `<div class="step"><span class="i">⚙</span><span><a data-act="sel2" data-id="${x.id}">${esc(x.who)}</a> ran ${x.runs}${x.nudges ? ` · ${x.nudges} shell command${x.nudges === 1 ? '' : 's'} redirected` : ''}</span></div>`).join('') : '<div class="hint">No scripts used yet.</div>'}</div>
      <div class="card"><h3>Problems · 48 hours</h3>${h.errors.length ? h.errors.slice(0, 10).map((e) => `<div class="step"><span class="i">⚠️</span><span><a data-act="sel2" data-id="${e.id}">${esc(e.who)}</a> <span class="hint">${ago(e.t)}</span><br><span class="hint">${esc(short(e.text, 200))}</span></span></div>`).join('') : '<div class="hint">None.</div>'}${h.failed.length ? `<div class="label" style="margin-top:10px">Not completed · 7 days</div>${h.failed.map((x) => `<div class="hint">${esc(x.who)} · #${x.n || '?'} ${esc(short(x.title || '', 50))} · ${esc(x.outcome)} · ${ago(x.t)}</div>`).join('')}` : ''}</div>
      </div>${evalCard(ev)}<div class="card" style="margin-top:12px"><h3>Server log</h3><pre style="max-height:320px">${esc(h.logTail || '(empty)')}</pre></div>`;
  },
};

// The agent eval over time (lib/evals.js): one column per run, one row per behaviour. ✓/✗ carry the result, so the
// colour is never the only signal; ◆ marks a run whose agent instructions changed since the run before.
function evalCard(ev) {
  if (!ev) return `<div class="card" style="margin-top:12px"><h3>Agent eval</h3>${skel(3)}</div>`;
  const runs = ev.runs.slice(-14);
  const every = ev.everyDays ? (ev.everyDays === 1 ? 'every day' : `every ${ev.everyDays} days`) + ' when the office has been idle for 20 minutes' : 'only when you run it';
  const head = `<h3>${ic('check')} Agent eval</h3><div class="evtop"><span class="hint">Real agents on ${esc((runs[runs.length - 1] || ev.running || {}).model || 'haiku')} in a throwaway office · runs ${every}.</span>${ev.running ? `<span class="hint"><span class="dots"><i></i><i></i><i></i></span> Running since ${ago(ev.running.startedAt)}…</span>` : '<button class="btn sm" data-act="evalRun">Run now</button>'}</div>`;
  if (!runs.length) return `<div class="card" style="margin-top:12px">${head}<div class="hint">No runs yet. Each run sends about five small jobs through the agents and checks they follow their instructions: reading big files in parts, using scripts, never committing, planning before a big team, saving project handoffs. A few cents each.</div></div>`;
  const names = [];
  for (const r of runs.slice().reverse()) for (const x of r.results || []) if (!names.includes(x.name)) names.push(x.name);
  const day = (t) => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' });
  const col = (r) => `<th title="${esc(new Date(r.t).toLocaleString())}${r.head ? ' · code ' + esc(r.head) : ''}${r.instructionsChanged ? ' · instructions changed since the run before' : ''} · ${money(r.cost || 0)}">${r.instructionsChanged ? '<span class="evchg">◆</span>' : ''}${day(r.t)}</th>`;
  const cell = (r, n) => {
    if (r.error) return `<td class="everr" title="Could not run: ${esc(r.error)}">!</td>`;
    const x = (r.results || []).find((y) => y.name === n);
    if (!x) return '<td class="evnone" title="Not checked in this run">·</td>';
    return x.pass ? '<td class="evok" title="Followed">✓</td>' : `<td class="evbad" title="Not followed${x.detail ? ': ' + esc(x.detail) : ''}">✗</td>`;
  };
  const last = runs[runs.length - 1];
  const total = runs.reduce((n, r) => n + (r.cost || 0), 0);
  return `<div class="card" style="margin-top:12px">${head}<div style="overflow-x:auto"><table class="evgrid"><thead><tr><th class="evname"></th>${runs.map(col).join('')}</tr></thead><tbody>
    ${names.map((n) => `<tr><td class="evname">${esc(n)}</td>${runs.map((r) => cell(r, n)).join('')}</tr>`).join('')}
    <tr class="evsum"><td class="evname">followed</td>${runs.map((r) => `<td>${r.error ? '–' : `${r.passed}/${r.total}`}</td>`).join('')}</tr></tbody></table></div>
    <div class="hint" style="margin-top:8px">Last run ${ago(last.t)}${last.error ? ' could not run' : `: ${last.passed} of ${last.total} followed · ${money(last.cost || 0)} · ${dur(last.ms || 0)}`} · ${runs.length} runs shown cost ${money(total)}. ◆ = the agents' instructions changed since the run before. Change how often it runs in Preferences → Agents &amp; teams.</div></div>`;
}

// ================================================================ app: Settings
APPS.settings = {
  mount(root) { root.innerHTML = `<div class="app"><div class="toolbar"><h1>Teams & roles</h1><span class="hint">Teams, roles, models and projects. Leads pick up changes when they're next idle.</span></div><div class="page" id="cfgBody"></div></div>`; S.cfg = null; S.cfgKey = null; },
  update() {
    if (!S.cfg) { S.cfg = 'loading'; api('GET', '/api/config').then((c) => { S.cfg = c; S.cfgKey = null; dirty(); }).catch((e) => { S.cfg = { error: e.message }; }); return; }
    if (S.cfg === 'loading') return;
    const cfg = S.cfg;
    const key = JSON.stringify(cfg).length;
    if (key === S.cfgKey) return;
    S.cfgKey = key;
    const ls = cfg.residents.filter((k) => k !== cfg.root);
    const byKey = Object.fromEntries(cfg.roles.map((r) => [r.key, r]));
    const sel = (id, opts, v) => `<select id="${id}">${opts.map((o) => `<option value="${esc(o)}" ${o === v ? 'selected' : ''}>${esc(o || 'usual')}</option>`).join('')}</select>`;
    let html = '<div class="cards" style="grid-template-columns:repeat(auto-fill,minmax(420px,1fr))">';
    for (const lk of ls) {
      const L = byKey[lk];
      html += `<div class="card"><h3>${esc(L.room)} · lead ${esc(L.persona)}</h3>` + (L.children || []).filter((c) => byKey[c]).map((c) => { const r = byKey[c]; return `<div class="rolerow"><div class="top"><b>${esc(r.name)}</b>${sel('m_' + c, ['', 'haiku', 'sonnet', 'opus'], r.model || '')}${sel('e_' + c, ['', 'low', 'medium', 'high', 'xhigh'], r.effort || '')}<button class="btn sm" data-act="saveRole" data-key="${esc(c)}" data-team="${esc(lk)}">Save</button>${r.createdInUi ? `<button class="btn sm danger" data-act="delRole" data-key="${esc(c)}">Remove</button>` : ''}</div><div class="hint">${esc(r.description)}${r.agentFile ? ' · instructions in ' + esc(r.agentFile) : ''}</div>${r.agentFile ? '' : `<details><summary>instructions</summary><textarea id="p_${esc(c)}" style="min-height:90px">${esc(r.prompt)}</textarea></details>`}</div>`; }).join('')
        + `<details style="margin-top:8px"><summary>+ Add a role</summary><div class="form" style="margin-top:8px"><input class="in" id="nr_name_${lk}" placeholder="Role name"><select id="nr_access_${lk}"><option value="readonly">reads only</option><option value="edit">can edit files</option><option value="web">reads + web</option></select><select id="nr_model_${lk}"><option>sonnet</option><option>haiku</option><option>opus</option></select><select id="nr_effort_${lk}"><option>medium</option><option>low</option><option>high</option><option>xhigh</option></select><input class="in full" id="nr_desc_${lk}" placeholder="One line: what they do"><textarea class="full" id="nr_prompt_${lk}" placeholder="Instructions"></textarea><button class="btn pri sm" data-act="addRole" data-team="${esc(lk)}">Add role</button></div></details></div>`;
    }
    html += `<div class="card"><h3>Projects</h3>${cfg.projects.map((p, i) => `<div class="rolerow"><div class="form"><input class="in" id="pj_name_${i}" value="${esc(p.name)}" placeholder="Name"><input class="in" id="pj_path_${i}" value="${esc(p.path)}" placeholder="Folder"><select id="pj_dep_${i}">${ls.map((k) => `<option value="${k}" ${k === p.department ? 'selected' : ''}>${esc(byKey[k].persona)} · ${esc(byKey[k].room)}</option>`).join('')}</select><select id="pj_eff_${i}">${['', 'medium', 'high', 'xhigh', 'max'].map((e) => `<option value="${e}" ${e === (p.leadEffort || '') ? 'selected' : ''}>${e ? 'lead effort ' + e : 'lead effort auto'}</option>`).join('')}</select><input class="in full" id="pj_desc_${i}" value="${esc(p.description || '')}" placeholder="Description"><input class="in full" id="pj_kw_${i}" value="${esc((p.keywords || []).join(', '))}" placeholder="Routing keywords, comma-separated"><input class="in full mono" id="pj_ver_${i}" value="${esc((p.verify || []).join(' ;; '))}" placeholder="Checks before a job counts as done, e.g. npm test ;; npm run lint"></div><a class="hint" data-act="delProj" data-i="${i}">remove</a></div>`).join('')}<div class="row"><button class="btn sm" data-act="addProj">+ Project</button><button class="btn pri sm" data-act="saveProj">Save projects</button></div></div>`;
    html += leadWizardHtml() + '</div>';
    $('#cfgBody').innerHTML = html;
  },
};

// ================================================================ app: Today (what needs you, what is running, what finished, where projects stand)
// Today's extras: what happened lately, what jobs cost day by day, and what is worth doing next.
function activityFeed(tickets) {
  const since = Date.now() - 2 * 86400000;
  const rows = [];
  for (const t of tickets) for (const e of t.thread) {
    if (e.t < since) continue;
    const by = e.from && e.from !== 'user' && e.from !== 'system' && e.from !== 'script' ? who(e.from) : null;
    let text = null;
    if (e.kind === 'user') text = `You started <b>#${t.n}</b>`;
    else if (e.kind === 'followup' || e.kind === 'reply') text = `You replied on <b>#${t.n}</b>`;
    else if (e.kind === 'answer' && by) text = `${esc(by)} answered <b>#${t.n}</b>${t.changes && t.changes.length ? ` · ${t.changes.length} file${t.changes.length === 1 ? '' : 's'} changed` : ''}${t.costUsd ? ` · ${money(t.costUsd)}` : ''}`;
    else if (e.kind === 'plan' && by) text = `${esc(by)} proposed a plan on <b>#${t.n}</b> · ${money(e.estimateUsd)}`;
    else if (e.kind === 'plandecision') text = `Plan ${/reject/i.test(e.text || '') ? 'rejected' : 'approved'} on <b>#${t.n}</b>`;
    else if (e.kind === 'question' && by) text = `${esc(by)} asked you something on <b>#${t.n}</b>`;
    if (text) rows.push({ t: e.t, id: t.id, text, title: t.title });
  }
  rows.sort((a, b) => b.t - a.t);
  if (!rows.length) return '<div class="hint">Nothing in the last two days. Start a job and it shows up here.</div>';
  return rows.slice(0, 10).map((r) => `<div class="li" data-act="openJob" data-id="${r.id}"><span class="hint mono" style="width:92px;flex:none">${new Date(r.t).toDateString() === new Date().toDateString() ? clock(r.t) : `${new Date(r.t).toLocaleDateString(undefined, { weekday: 'short' })} ${clock(r.t)}`}</span><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.title)}">${r.text} <span class="hint">${esc(short(r.title, 60))}</span></span></div>`).join('');
}
function spendChart(tickets) {
  const days = 14, dayMs = 86400000, start = new Date(); start.setHours(0, 0, 0, 0);
  const sums = Array(days).fill(0);
  for (const t of tickets) {
    const at = t.closedAt || t.createdAt; const k = days - 1 - Math.floor((start.getTime() + dayMs - at) / dayMs);
    if (k >= 0 && k < days) sums[k] += t.costUsd || 0;
  }
  const max = Math.max(...sums), week = sums.slice(-7).reduce((a, b) => a + b, 0);
  if (!max) return '';
  const bars = sums.map((v, i) => { const h = Math.max(v ? 2 : 0, Math.round((v / max) * 36)); const d = new Date(start.getTime() - (days - 1 - i) * dayMs); return `<rect x="${i * 14}" y="${38 - h}" width="10" height="${h}" rx="2" class="${i === days - 1 ? 'today' : ''}"><title>${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}: ${money(v)}</title></rect>`; }).join('');
  return `<div class="spark"><svg viewBox="0 0 ${days * 14} 40" width="${days * 14}" height="40" role="img" aria-label="Job costs over the last 14 days">${bars}</svg><span class="hint">last 14 days · <b>${money(week)}</b> this week</span></div>`;
}
function suggestions(tickets, finished) {
  const out = [];
  const stale = (S.board || []).filter((c) => c.handoff && c.handoff.updated && Date.now() - new Date(c.handoff.updated).getTime() > 7 * 86400000).slice(0, 2);
  for (const c of stale) out.push(`<div class="li" data-act="boardContinue" data-name="${esc(c.name)}" data-lead="${esc(c.lead)}">${ic('projects')}<span style="flex:1"><b>${esc(c.name)}</b> hasn't moved since ${esc(c.handoff.updated)}</span><span class="hint">continue</span></div>`);
  const failed = tickets.filter((t) => ['failed', 'interrupted'].includes(t.status) && t.closedAt > Date.now() - 3 * 86400000).slice(0, 2);
  for (const t of failed) out.push(`<div class="li" data-act="openJob" data-id="${t.id}">${ic('reload')}<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Retry <b>#${t.n}</b> ${esc(short(t.title, 50))}</span><span class="hint">${esc(t.status)}</span></div>`);
  const unrated = tickets.filter((t) => t.status === 'done' && t.answer && !t.rating && t.closedAt > Date.now() - 7 * 86400000);
  if (unrated.length) out.push(`<div class="li" data-act="openJob" data-id="${unrated[0].id}">${ic('check')}<span style="flex:1">Rate ${unrated.length} recent answer${unrated.length === 1 ? '' : 's'}: it teaches your team what you like</span><span class="hint">rate</span></div>`);
  if (!tickets.length) out.push(`<div class="li" data-act="tour">${ic('info')}<span style="flex:1">New here? Take the 1-minute tour</span><span class="hint">start</span></div>`);
  return out.length ? out.join('') : '<div class="hint">Nothing to suggest. You\'re all caught up.</div>';
}
// Getting set up: a short checklist on Today that ticks itself off and goes away once done (or dismissed).
function setupChecklist(tickets) {
  if (pref('setupHidden', '0') === '1') return '';
  const steps = [
    { done: S.projects.some((p) => p.department && p.department !== S.root), label: 'Tell the office about your projects', hint: 'so jobs go straight to the right lead', act: 'data-act="app" data-app="settings"', cta: 'Teams & roles' },
    { done: tickets.length > 0, label: 'Start your first job', hint: 'anything: a bug, a feature, a question', act: 'data-act="app" data-app="newjob"', cta: 'New job' },
    { done: tickets.some((t) => t.rating), label: 'Rate an answer', hint: 'it teaches your team what you like', act: (() => { const t = tickets.find((x) => x.status === 'done' && x.answer); return t ? `data-act="openJob" data-id="${t.id}"` : 'data-act="app" data-app="jobs"'; })(), cta: 'Rate' },
    { done: !!(S.tg && S.tg.linked), label: 'Connect Telegram', hint: 'approve plans from your phone', act: 'data-act="prefs" data-sec="notifications"', cta: 'Connect', skip: S.tg && S.tg.unavailable },
    { done: pref('toured', '0') === '1', label: 'Take the 1-minute tour', hint: 'where everything is', act: 'data-act="tour"', cta: 'Start' },
  ].filter((x) => !x.skip);
  const left = steps.filter((x) => !x.done).length;
  if (!left) return '';
  return `<div class="card wide setup"><h3>${ic('check')} Getting set up <span class="hint">${steps.length - left} of ${steps.length} done</span><span style="flex:1"></span><a class="hint" data-act="setupHide">hide</a></h3>
    <div class="sbar"><i style="width:${Math.round(((steps.length - left) / steps.length) * 100)}%"></i></div>
    ${steps.map((x) => `<div class="li ${x.done ? 'done' : ''}" ${x.done ? '' : x.act}><span class="ck">${x.done ? '✓' : ''}</span><span style="flex:1"><b>${esc(x.label)}</b> <span class="hint">${esc(x.hint)}</span></span>${x.done ? '' : `<span class="hint">${esc(x.cta)}</span>`}</div>`).join('')}</div>`;
}
// Lessons the agents wrote after a job went wrong, waiting for the user (lib/lessons.js): keep, edit or drop each.
function lessonDrafts() {
  const hid = S.hiddenDrafts || new Set();
  return Object.values(S.agents).flatMap((a) => (a.lessonDrafts || []).filter((l) => !hid.has(l.id)).map((l) => ({ a, l }))).sort((x, y) => y.l.t - x.l.t);
}
function lessonReviewHtml(list, wide) {
  if (!list.length) return '';
  return `<div class="card ${wide ? 'wide' : ''} lreview"><h3>${ic('memory')} Lessons to review <span class="pill s-ask">${list.length}</span></h3><div class="hint">Written by the leads after a job went wrong. They reach the agents only once you keep them.</div>
    ${list.map(({ a, l }) => `<div class="lr"><div class="lh"><b>${esc(a.persona)}</b> <span class="hint">${l.ticketN ? `after <a data-act="openJobN" data-n="${l.ticketN}">#${l.ticketN}</a> · ` : ''}${ago(l.t)}</span></div>
      ${S.lessonEdit === l.id ? `<input id="lr-${l.id}" class="in lrin" maxlength="220" value="${esc(l.text)}" data-id="${a.id}" data-lid="${l.id}" aria-label="Lesson text">` : `<div class="lt">${esc(l.text)}</div>`}
      ${l.reason || l.trigger ? `<div class="hint lwhy">${l.trigger ? `<b>Asked because</b> ${esc(l.trigger)}.` : ''}${l.reason ? ` <b>${esc(a.persona)}'s reasoning:</b> ${esc(l.reason)}` : ''}</div>` : ''}
      <div class="row"><button class="btn sm pri" data-act="lessonKeep" data-id="${a.id}" data-lid="${l.id}">${S.lessonEdit === l.id ? 'Keep as edited' : 'Keep'}</button>${S.lessonEdit === l.id ? '' : `<button class="btn sm" data-act="lessonEdit" data-lid="${l.id}">Edit</button>`}<button class="btn sm danger" data-act="lessonDrop" data-id="${a.id}" data-lid="${l.id}">Drop</button></div></div>`).join('')}</div>`;
}
// The new-lead wizard (lib/lead-wizard.js): explain the purpose, get a full draft, review every field, create.
function leadWizardHtml() {
  const W = S.lw || {};
  const v = (k) => esc(W.draft ? W.draft[k] ?? '' : '');
  if (!W.draft) {
    return `<div class="card lwiz"><h3>${ic('teams')} New team lead</h3>
      <div class="hint">Explain what this lead should look after, like you would to a new colleague. The office drafts the rest (name, routing, instructions, specialists) the way the built-in leads are set up; you review everything before it is created.</div>
      <textarea id="lw_purpose" class="full" style="min-height:96px;margin-top:8px" placeholder="e.g. Look after my home server: Docker containers, backups and the Raspberry Pi in ~/homelab. Keep things running, explain what changed, and never expose services to the internet.">${esc(W.purpose || '')}</textarea>
      <div class="form" style="margin-top:6px"><input class="in" id="lw_persona" placeholder="Lead's name (optional)" value="${esc(W.persona || '')}"><input class="in" id="lw_room" placeholder="Team name (optional)" value="${esc(W.room || '')}"><input class="in" id="lw_cwd" placeholder="Working folder, e.g. ~/homelab (optional)" value="${esc(W.cwd || '')}"></div>
      <div class="row" style="margin-top:8px"><button class="btn pri sm" data-act="lwDraft" ${W.busy ? 'disabled' : ''}>${W.busy ? 'Drafting… (about 15 s)' : 'Draft the lead'}</button><a class="hint" data-act="lwDraft" data-skip="1">or fill it in yourself</a></div></div>`;
  }
  const roles = W.draft.roles || [];
  return `<div class="card lwiz wide"><h3>${ic('teams')} New team lead · review</h3>
    <div class="hint">${esc(W.draft.note || (W.draft.drafted === 'model' ? 'Drafted from your description. Change anything, then create the lead.' : 'Fill in the fields, then create the lead.'))}</div>
    <div class="lwgrid">
      <label>Lead's name<input class="in" id="lw_d_persona" value="${v('persona')}"></label>
      <label>Team<input class="in" id="lw_d_room" value="${v('room')}"></label>
      <label>Working folder<input class="in" id="lw_d_cwd" value="${v('cwd')}"></label>
      <label>Files<select id="lw_d_access"><option value="edit" ${W.draft.access === 'edit' ? 'selected' : ''}>can edit files</option><option value="readonly" ${W.draft.access !== 'edit' ? 'selected' : ''}>reads only</option></select></label>
      <label>Model<select id="lw_d_model">${['opus', 'sonnet', 'haiku'].map((m) => `<option ${W.draft.model === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
      <label>Effort<select id="lw_d_effort">${['medium', 'high', 'xhigh'].map((m) => `<option ${W.draft.effort === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
      <label class="full">What the team owns <span class="hint">God routes jobs with this; say what it does not own too</span><textarea id="lw_d_description" style="min-height:52px">${v('description')}</textarea></label>
      <label class="full">Routing keywords <span class="hint">a job that mentions one goes straight to this lead</span><input class="in" id="lw_d_keywords" value="${esc((W.draft.keywords || []).join(', '))}"></label>
      <label class="full">Instructions <span class="hint">the lead reads these at the start of every session; the office adds its own rules (never commit, report progress)</span><textarea id="lw_d_prompt" style="min-height:180px">${v('prompt')}</textarea></label>
    </div>
    <div class="label" style="margin-top:10px">Specialists the lead can hire</div>
    ${roles.map((r, i) => `<div class="form lwrole"><input class="in" id="lw_r_name_${i}" value="${esc(r.name)}" placeholder="Role"><select id="lw_r_access_${i}">${[['readonly', 'reads only'], ['edit', 'can edit files'], ['web', 'reads + web']].map(([k, l]) => `<option value="${k}" ${r.access === k ? 'selected' : ''}>${l}</option>`).join('')}</select><input class="in full" id="lw_r_desc_${i}" value="${esc(r.description)}" placeholder="One line: what they do"><a class="hint" data-act="lwRoleDel" data-i="${i}">remove</a></div>`).join('') || '<div class="hint">None yet. The lead can still hire a custom specialist for a job.</div>'}
    <div class="row" style="margin-top:6px"><a class="hint" data-act="lwRoleAdd">+ Add a specialist</a></div>
    <div class="row" style="margin-top:12px"><button class="btn pri sm" data-act="lwCreate" ${W.busy ? 'disabled' : ''}>${W.busy ? 'Creating…' : `Create ${esc(W.draft.persona || 'the lead')}`}</button><button class="btn sm" data-act="lwBack">Back</button><span class="hint">The lead starts as a permanent process under God, with its own library and message room.</span></div></div>`;
}
APPS.today = {
  mount(root) {
    root.innerHTML = `<div class="app"><div class="toolbar"><h1>Today</h1><span class="hint" id="tdHint"></span><span class="sp"></span><button class="btn sm" data-act="app" data-app="newjob">${ic('newjob')} New job</button></div><div class="page" id="tdBody"></div></div>`;
    loadBoard().then(() => { if (S.app === 'today') { S.tdKey = null; APPS.today.update(); } });
    if (!S.tg) api('GET', '/api/telegram').then((r) => { S.tg = r; S.tdKey = null; if (S.app === 'today') APPS.today.update(); }).catch(() => { S.tg = { unavailable: true }; });
    api('GET', '/api/skill-proposals').then((l) => { S.tdProps = l.filter((x) => x.status === 'pending'); S.tdKey = null; if (S.app === 'today') APPS.today.update(); }).catch(() => {});
    S.tdKey = null;
  },
  update() {
    const tickets = Object.values(S.tickets).filter((t) => !t.archived);
    const day = Date.now() - 86400000;
    const need = tickets.filter(needsYou);
    const busy = Object.values(S.agents).filter((a) => agentJob(a) && (ACTIVE.includes(a.status) || (a.resident && a.current)));
    const finished = tickets.filter((t) => t.closedAt && t.closedAt > day && ['done', 'failed', 'interrupted'].includes(t.status)).sort((a, b) => b.closedAt - a.closedAt);
    const spentToday = tickets.filter((t) => (t.closedAt || t.updatedAt || t.createdAt) > day).reduce((s2, t) => s2 + (t.costUsd || 0), 0);
    const projects = (S.board || []).filter((c) => c.handoff).slice(0, 4);
    const props = S.tdProps || [];
    const R = S.restart || {};
    const key = JSON.stringify([need.map((t) => t.id + t.thread.length), busy.map((a) => a.id + (S.live[a.id] || {}).t), finished.map((t) => t.id), projects.length, props.length, R.codeChanged, Math.floor(Date.now() / 30000), tickets.length, tickets.filter((t) => t.rating).length, !!(S.tg && S.tg.linked), pref('toured', '0'), pref('setupHidden', '0'), lessonDrafts().map((x) => x.l.id), S.lessonEdit]);
    if (key === S.tdKey) return;
    if (document.activeElement && document.activeElement.classList.contains('lrin') && S.lessonEdit) return; // don't wipe an edit in progress
    S.tdKey = key;
    const h = new Date().getHours();
    $('#tdHint').textContent = `${h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'} · ${new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}`;
    const jobLink = (t, extra) => `<div class="li" data-act="openJob" data-id="${t.id}"><span class="hint mono">#${t.n}</span><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.title)}</span>${extra || ''}</div>`;
    const why = (t) => (t.status === 'interrupted' ? 'interrupted · resume' : wsToReview(t) ? 'changes to apply' : t.stuck ? `${t.stuck.persona} looks stuck` : t.waiting ? 'a question' : t.plan && t.plan.status === 'pending' ? `a plan · ${money(t.plan.estimateUsd)}${ticketShare(t.plan.estimateUsd) ? ` · ${ticketShare(t.plan.estimateUsd).replace(/^≈ /, '').split(' · ')[0]}` : ''}` : pendingCmd(t) ? 'a command to run' : 'budget stop');
    const meters = ['five_hour', 'seven_day'].map((k) => { const w = windowOf(k); if (!w) return ''; const u = live(w); return `<div class="hbar"><span class="n">${k === 'five_hour' ? '5-hour window' : 'This week'}</span><span class="t"><i style="width:${Math.min(100, u * 100)}%;background:${meterColor(u)}"></i></span><span class="v">${pct(u)}</span></div>`; }).join('');
    $('#tdBody').innerHTML = `<div class="cards" style="grid-template-columns:repeat(auto-fill,minmax(360px,1fr))">${setupChecklist(tickets)}${lessonReviewHtml(lessonDrafts(), true)}
      <div class="card"><h3>${ic('bell')} Needs you ${need.length ? `<span class="pill s-ask">${need.length}</span>` : ''}</h3>${need.length ? need.map((t) => jobLink(t, `<span class="hint">${why(t)}</span>`) + (t.waiting ? qoptsHtml(t.waiting, t.id) : '')).join('') : '<div class="hint">Nothing is waiting for you.</div>'}
        ${props.length ? `<div class="li" data-act="app" data-app="skills">${ic('skills')}<span style="flex:1">${props.length} skill proposal${props.length === 1 ? '' : 's'} from your agents</span><span class="hint">review</span></div>` : ''}
        ${R.codeChanged ? `<div class="li" data-act="restartIdle">${ic('reload')}<span style="flex:1">An update is ready</span><span class="hint">restart when idle</span></div>` : ''}</div>
      <div class="card"><h3>${ic('processes')} Working now</h3>${busy.length ? busy.map((a) => { const t = agentJob(a); const L = S.live[a.id] || {}; return `<div class="li" data-act="openJob" data-id="${t.id}"><span class="dots"><i></i><i></i><i></i></span><b>${esc(a.persona)}</b><span class="hint" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">#${t.n} · ${esc(L.thought || a.progress || 'working')}</span></div>`; }).join('') : '<div class="hint">Nobody is working right now.</div>'}</div>
      <div class="card"><h3>${ic('check')} Finished in the last 24 hours</h3>${finished.length ? finished.slice(0, 8).map((t) => jobLink(t, `${pill(t.status)}<span class="hint">${ago(t.closedAt)}</span>`) + (t.answer ? `<div class="hint" style="margin:-4px 0 6px 12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(short(plainText(t.answer), 140))}</div>` : '')).join('') : '<div class="hint">No jobs finished today.</div>'}</div>
      <div class="card"><h3>${ic('projects')} Projects</h3>${projects.length ? projects.map((c) => { const next = nextSteps(c.handoff.state); return `<div class="li" data-act="boardContinue" data-name="${esc(c.name)}" data-lead="${esc(c.lead)}" title="Continue ${esc(c.name)}"><b>${esc(c.name)}</b><span class="hint" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${next.length ? 'next: ' + esc(next[0]) : 'updated ' + esc(c.handoff.updated || '?')}</span><span class="hint">continue</span></div>`; }).join('') + '<div class="hint" style="margin-top:6px"><a data-act="app" data-app="projects">All projects</a></div>' : '<div class="hint">No project handoffs yet. They appear after a job on a personal project.</div>'}</div>
      <div class="card"><h3>${ic('usage')} Usage</h3>${meters || '<div class="hint">No usage data yet.</div>'}<div class="hint" style="margin-top:6px">Jobs in the last 24 hours: <b>${money(spentToday)}</b> at API prices · <a data-act="app" data-app="usage">details</a></div>${spendChart(tickets)}</div>
      <div class="card"><h3>${ic('recos')} Suggested next</h3>${suggestions(tickets, finished)}</div>
      <div class="card wide"><h3>${ic('processes')} Activity</h3>${activityFeed(tickets)}</div>
    </div>`;
  },
};
