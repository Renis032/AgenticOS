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
      <div class="page" id="board"><div class="empty">Loading…</div></div></div>`;
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

// ================================================================ app: New job
APPS.newjob = {
  mount(root) {
    root.innerHTML = `<div class="app"><div class="toolbar"><h1>New job</h1><span class="hint">Describe the task or paste the bug report. <kbd>Ctrl</kbd>+<kbd>Enter</kbd> sends.</span></div>
      <div class="page"><div style="max-width:820px">
        <div class="chips" id="njChips"></div>
        <textarea id="njText" style="min-height:200px" placeholder="What should the agents do?"></textarea>
        <div class="files" id="njFiles"></div>
        <div class="row"><select id="njProject"></select><select id="njEffort" title="How hard the lead thinks on this job"><option value="">lead effort: auto</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option><option value="max">max</option></select>
          <button class="btn" data-act="attachNew">📎 Attach</button><label class="chk"><input type="checkbox" id="njAfter"> start after the 5-hour limit resets</label><span style="flex:1"></span><button class="btn pri" data-act="sendJob">Start job</button></div>
        <div class="hint" id="njRoute" style="margin-top:10px"></div><div class="hint" id="njEst" style="margin-top:4px"></div>
      </div></div></div>`;
    const sel = $('#njProject');
    sel.innerHTML = '<option value="">Route automatically (rules, then God)</option>' + S.projects.map((p) => `<option value="${esc(p.name)}">${esc(p.name)} → ${esc(who(p.department))}${p.leadEffort ? ` (${esc(p.leadEffort)})` : ''}</option>`).join('');
    sel.value = pref('project', '');
    $('#njEffort').value = pref('defaultEffort', '');
    const txt = $('#njText');
    if (S.quickText) { txt.value = S.quickText; S.quickText = ''; }
    txt.oninput = () => routePreview();
    sel.onchange = () => { setPref('project', sel.value); routePreview(); };
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
    const proj = $('#njProject').value;
    const text = $('#njText').value.trim();
    if (proj) { const p = S.projects.find((x) => x.name === proj); el.textContent = p ? `Goes straight to ${who(p.department)}.` : ''; return; }
    if (!text) { el.textContent = ''; return; }
    const r = await api('POST', '/api/script', { name: 'route', args: [text] }).catch(() => null);
    if (r && r.message && $('#njRoute')) $('#njRoute').textContent = 'Routing: ' + r.message.replace(/\n/g, ' — ');
  }, 400);
}
async function sendNewJob() {
  const text = $('#njText').value.trim();
  if (!text) return;
  const r = await api('POST', '/api/tasks', { text, project: $('#njProject').value || undefined, effort: $('#njEffort').value || undefined, attachments: S.newFiles, after: $('#njAfter').checked ? 'reset' : undefined }).catch((e) => alert(e.message));
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
    b.innerHTML = list === null ? '<div class="empty">Loading…</div>' : list.length ? list.map((m) => `<div class="chatmsg ${m.fromId === 'user' ? 'me' : ''}"><div class="h"><b ${m.fromId !== 'user' ? `data-act="sel2" data-id="${m.fromId}" style="cursor:pointer"` : ''}>${esc(m.from)}</b> → ${esc(m.to || '')}${m.ask ? ' · question' : ''}<span class="ts">${ago(m.t)}</span></div><div class="md">${md(m.text)}</div>${m.ticketId ? `<a class="hint" data-act="openJob" data-id="${m.ticketId}">open job</a>` : ''}</div>`).join('') : '<div class="empty">Quiet so far.</div>';
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
    const groups = leads().map((k) => [k, [S.agents[k], ...Object.values(S.agents).filter((a) => a.staff && a.homeId === k).sort((x, y) => (y.memoryVersion || 0) - (x.memoryVersion || 0))].filter(Boolean)]);
    $('#memList').innerHTML = groups.map(([k, list]) => `<div class="grp">${esc(teamName(k))}</div>` + list.map((a) => `<div class="li ${S.memAgent === a.id ? 'on' : ''}" data-act="memSel" data-id="${a.id}"><span>${esc(a.persona)}</span><span class="hint">${a.memoryVersion ? 'v' + a.memoryVersion : 'empty'}</span></div>`).join('')).join('');
    const a = S.agents[S.memAgent];
    if (!a) { $('#memBody').innerHTML = '<div class="empty">Pick an agent to read what they have learned. Each agent rewrites its memory at the end of a task, and sees it at the start of the next.</div>'; return; }
    const key = a.id + '|' + a.memoryVersion;
    if (key === S.memKey) return;
    S.memKey = key;
    $('#memTitle').textContent = `${a.persona} · memory`;
    $('#memSub').textContent = a.memoryVersion ? `version ${a.memoryVersion}${a.memoryUpdatedAt ? ' · updated ' + ago(a.memoryUpdatedAt) : ''}` : '';
    api('GET', `/api/agents/${a.id}/memory`).then((r) => { if (S.memAgent === a.id) $('#memBody').innerHTML = r.text ? `<div class="md" style="max-width:820px">${md(r.text)}</div>` : '<div class="empty">Nothing written yet.</div>'; });
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
APPS.usage = {
  mount(root) { root.innerHTML = `<div class="app"><div class="toolbar"><h1>Usage</h1><span class="hint">Plan limits as Anthropic reports them on every agent run, and office spend.</span><span class="sp"></span><button class="btn sm" data-act="limRefresh">Refresh</button></div><div class="page" id="usBody"></div></div>`; S.usKey = null; },
  update() {
    if (!S.spend || Date.now() - S.spend.at > 60000) { S.spend = { at: Date.now(), data: S.spend && S.spend.data }; api('GET', '/api/spend').then((d) => { S.spend = { at: Date.now(), data: d }; S.usKey = null; dirty(); }).catch(() => {}); }
    const L = S.limits || { windows: {} };
    const key = `${L.updatedAt}|${L.probing}|${!!L.hold}|${S.spend.data ? S.spend.at : 0}|${Math.floor(Date.now() / 30000)}`;
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
    html += `<div class="hint" style="margin-top:14px;max-width:820px">Anthropic reports limits as percentages, not tokens; the window size is estimated from how far the bar moves while the office spends. Other Claude use moves the same bars, so estimates lean low. Dollars are API-equivalent prices, covered by your plan.</div>`;
    $('#usBody').innerHTML = html;
  },
};

// ================================================================ app: Health
APPS.health = {
  mount(root) { root.innerHTML = `<div class="app"><div class="toolbar"><h1>Health</h1><span class="hint" id="hSub"></span><span class="sp"></span><button class="btn sm" data-act="healthRefresh">Refresh</button><button class="btn pri sm" data-act="selftest">Run self-test</button></div><div class="page" id="hBody"></div></div>`; S.hKey = null; refreshHealth(); },
  update() {
    const h = S.health;
    if (!h) return;
    const st = S.selftest || h.selftest;
    const key = `${JSON.stringify(h).length}|${st ? st.status + st.steps.length : ''}`;
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
      </div><div class="card" style="margin-top:12px"><h3>Server log</h3><pre style="max-height:320px">${esc(h.logTail || '(empty)')}</pre></div>`;
  },
};

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
    html += `<div class="card"><h3>Projects</h3>${cfg.projects.map((p, i) => `<div class="rolerow"><div class="form"><input class="in" id="pj_name_${i}" value="${esc(p.name)}" placeholder="Name"><input class="in" id="pj_path_${i}" value="${esc(p.path)}" placeholder="Folder"><select id="pj_dep_${i}">${ls.map((k) => `<option value="${k}" ${k === p.department ? 'selected' : ''}>${esc(byKey[k].persona)} · ${esc(byKey[k].room)}</option>`).join('')}</select><select id="pj_eff_${i}">${['', 'medium', 'high', 'xhigh', 'max'].map((e) => `<option value="${e}" ${e === (p.leadEffort || '') ? 'selected' : ''}>${e ? 'lead effort ' + e : 'lead effort auto'}</option>`).join('')}</select><input class="in full" id="pj_desc_${i}" value="${esc(p.description || '')}" placeholder="Description"><input class="in full" id="pj_kw_${i}" value="${esc((p.keywords || []).join(', '))}" placeholder="Routing keywords, comma-separated"></div><a class="hint" data-act="delProj" data-i="${i}">remove</a></div>`).join('')}<div class="row"><button class="btn sm" data-act="addProj">+ Project</button><button class="btn pri sm" data-act="saveProj">Save projects</button></div></div>`;
    html += `<div class="card"><h3>New team</h3><div class="form"><input class="in" id="nt_persona" placeholder="Lead's name"><input class="in" id="nt_room" placeholder="Team name"><input class="in" id="nt_cwd" placeholder="Working folder, e.g. ~/Documents"><select id="nt_access"><option value="readonly">reads only</option><option value="edit">can edit files</option></select><textarea class="full" id="nt_desc" placeholder="What this team owns (used for routing)"></textarea><button class="btn pri sm" data-act="addTeam">Create team</button></div><div class="hint" style="margin-top:6px">The new lead becomes a permanent process under God, with its own library and message room.</div></div></div>`;
    $('#cfgBody').innerHTML = html;
  },
};

// ================================================================ app: Today (what needs you, what is running, what finished, where projects stand)
APPS.today = {
  mount(root) {
    root.innerHTML = `<div class="app"><div class="toolbar"><h1>Today</h1><span class="hint" id="tdHint"></span><span class="sp"></span><button class="btn sm" data-act="app" data-app="newjob">${ic('newjob')} New job</button></div><div class="page" id="tdBody"></div></div>`;
    loadBoard().then(() => { if (S.app === 'today') { S.tdKey = null; APPS.today.update(); } });
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
    const key = JSON.stringify([need.map((t) => t.id + t.thread.length), busy.map((a) => a.id + (S.live[a.id] || {}).t), finished.map((t) => t.id), projects.length, props.length, R.codeChanged, Math.floor(Date.now() / 30000)]);
    if (key === S.tdKey) return;
    S.tdKey = key;
    const h = new Date().getHours();
    $('#tdHint').textContent = `${h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'} · ${new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}`;
    const jobLink = (t, extra) => `<div class="li" data-act="openJob" data-id="${t.id}"><span class="hint mono">#${t.n}</span><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.title)}</span>${extra || ''}</div>`;
    const why = (t) => (t.waiting ? 'a question' : t.plan && t.plan.status === 'pending' ? `a plan · ${money(t.plan.estimateUsd)}` : pendingCmd(t) ? 'a command to run' : 'budget stop');
    const meters = ['five_hour', 'seven_day'].map((k) => { const w = windowOf(k); if (!w) return ''; const u = live(w); return `<div class="hbar"><span class="n">${k === 'five_hour' ? '5-hour window' : 'This week'}</span><span class="t"><i style="width:${Math.min(100, u * 100)}%;background:${meterColor(u)}"></i></span><span class="v">${pct(u)}</span></div>`; }).join('');
    $('#tdBody').innerHTML = `<div class="cards" style="grid-template-columns:repeat(auto-fill,minmax(360px,1fr))">
      <div class="card"><h3>${ic('bell')} Needs you ${need.length ? `<span class="pill s-paused">${need.length}</span>` : ''}</h3>${need.length ? need.map((t) => jobLink(t, `<span class="hint">${why(t)}</span>`)).join('') : '<div class="hint">Nothing is waiting for you.</div>'}
        ${props.length ? `<div class="li" data-act="app" data-app="skills">${ic('skills')}<span style="flex:1">${props.length} skill proposal${props.length === 1 ? '' : 's'} from your agents</span><span class="hint">review</span></div>` : ''}
        ${R.codeChanged ? `<div class="li" data-act="restartIdle">${ic('reload')}<span style="flex:1">An update is ready</span><span class="hint">restart when idle</span></div>` : ''}</div>
      <div class="card"><h3>${ic('processes')} Working now</h3>${busy.length ? busy.map((a) => { const t = agentJob(a); const L = S.live[a.id] || {}; return `<div class="li" data-act="openJob" data-id="${t.id}"><span class="dots"><i></i><i></i><i></i></span><b>${esc(a.persona)}</b><span class="hint" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">#${t.n} · ${esc(L.thought || a.progress || 'working')}</span></div>`; }).join('') : '<div class="hint">Nobody is working right now.</div>'}</div>
      <div class="card"><h3>${ic('check')} Finished in the last 24 hours</h3>${finished.length ? finished.slice(0, 8).map((t) => jobLink(t, `${pill(t.status)}<span class="hint">${ago(t.closedAt)}</span>`) + (t.answer ? `<div class="hint" style="margin:-4px 0 6px 12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(short(plainText(t.answer), 140))}</div>` : '')).join('') : '<div class="hint">No jobs finished today.</div>'}</div>
      <div class="card"><h3>${ic('projects')} Projects</h3>${projects.length ? projects.map((c) => { const next = nextSteps(c.handoff.state); return `<div class="li" data-act="boardContinue" data-name="${esc(c.name)}" data-lead="${esc(c.lead)}" title="Continue ${esc(c.name)}"><b>${esc(c.name)}</b><span class="hint" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${next.length ? 'next: ' + esc(next[0]) : 'updated ' + esc(c.handoff.updated || '?')}</span><span class="hint">continue</span></div>`; }).join('') + '<div class="hint" style="margin-top:6px"><a data-act="app" data-app="projects">All projects</a></div>' : '<div class="hint">No project handoffs yet. They appear after a job on a personal project.</div>'}</div>
      <div class="card"><h3>${ic('usage')} Usage</h3>${meters || '<div class="hint">No usage data yet.</div>'}<div class="hint" style="margin-top:6px">Jobs in the last 24 hours: <b>${money(spentToday)}</b> at API prices · <a data-act="app" data-app="usage">details</a></div></div>
    </div>`;
  },
};
