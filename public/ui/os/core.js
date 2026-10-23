'use strict';
// Helpers, state, start-up and live updates, title bar and dock.
// ================================================================ helpers
const $ = (q, el = document) => el.querySelector(q);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (x) => `$${(x || 0).toFixed(2)}`;
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const whenAt = (t) => new Date(t).toLocaleString([], { weekday: t - Date.now() > 20 * 3600000 ? 'short' : undefined, hour: '2-digit', minute: '2-digit' });
const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : new Date(t).toLocaleDateString(); };
function dur(ms) { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`; }
const short = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const pct = (x) => `${Math.round((x || 0) * 100)}%`;
const pctFine = (x) => (x < 0.01 ? `${(x * 100).toFixed(1)}%` : `${Math.round(x * 100)}%`);
const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n || 0)));
const ACTIVE = ['running', 'delegating', 'queued'];
function md(src) {
  return String(src ?? '').split(/```[^\n]*\n?/).map((p, i) => {
    if (i % 2) return `<pre>${esc(p)}</pre>`;
    let h = esc(p).replace(/^#{1,4} (.*)$/gm, '<h4>$1</h4>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/^\s*[-*] (.*)$/gm, '<li>$1</li>');
    h = h.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);
    return h.split(/\n{2,}/).map((x) => /^<(h4|ul|pre)/.test(x.trim()) ? x : `<p>${x.replace(/\n/g, '<br>')}</p>`).join('');
  }).join('');
}
// Thread markdown: code blocks get a Copy button, file paths open in VS Code.
const FILE_RE = /^~?\/?[\w.@-]+(?:\/[\w.@-]+)*\.[A-Za-z][\w]{0,9}(?::\d+(?::\d+)?)?$/;
function mdRich(src) {
  return md(src)
    .replace(/<pre>([\s\S]*?)<\/pre>/g, '<div class="cb"><button class="copy" data-act="copyCode" title="Copy">Copy</button><pre>$1</pre></div>')
    .replace(/<code>([^<]+)<\/code>/g, (m, x) => (FILE_RE.test(x) && !/^\d/.test(x) && (/[/:]/.test(x) || /\.(js|mjs|ts|tsx|jsx|py|java|kt|json|md|html|css|xml|ya?ml|sh|cpp|cc|hpp|h|c|go|rs|sql|toml|gradle|properties)$/i.test(x)) ? `<code class="fref" data-act="openFile" data-p="${x}" title="Open in VS Code">${x}</code>` : m))
    .replace(/(^|[\s(])((?:~|\/home)\/[\w.@\/-]+\.[A-Za-z][\w]{0,9}(?::\d+)?)/g, (m, pre, x) => `${pre}<a class="fref" data-act="openFile" data-p="${x}" title="Open in VS Code">${x}</a>`);
}
const plainText = (s) => String(s || '').replace(/```[\s\S]*?```/g, ' ').replace(/[`*#>_]|\[|\]\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const pref = (k, d) => { try { const v = localStorage.getItem('aos.' + k); return v === null ? d : v; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem('aos.' + k, v); } catch {} };
const prefObj = (k) => { try { return JSON.parse(pref(k, 'null')); } catch { return null; } };

// ================================================================ state
const S = {
  agents: {}, tickets: {}, roles: {}, residents: [], root: 'manager', projects: [], limits: null, health: null, selftest: null,
  app: pref('startApp', 'today') === 'last' ? pref('app', 'today') : pref('startApp', 'today'), sel: null, job: null, jtab: 'thread', itab: 'mind', collapsed: new Set(), showIdle: pref('showIdle', '1') === '1',
  pq: '', pjob: '', jq: '', showArchived: false, events: {}, live: {}, newFiles: [], followFiles: [], chatTeam: null, libTeam: null, libPage: null,
  memAgent: null, term: { out: [], hist: [], hi: -1 }, timeline: {}, replay: null, spend: null, cfg: null, scripts: [], rerate: false,
  drafts: {}, seen: prefObj('seen'), compose: prefObj('compose'), openGroups: new Set(), handoffDocs: {},
  board: null, boardAt: 0, boardQ: '', boardOpen: null, chg: {}, planOpen: false, pendingSend: null,
};
const who = (id) => (id === 'user' ? 'You' : id === 'script' ? 'Office script' : id === 'system' ? 'System' : S.agents[id] ? S.agents[id].persona : id);
const leads = () => S.residents.filter((k) => k !== S.root);
const teamName = (k) => (S.roles[k] && S.roles[k].room) || k;
const modelChip = (a) => (a && a.model ? `<span class="mdl m-${esc(a.model)}">${esc(a.model)}/${esc(a.effort || '?')}</span>` : '<span class="hint">—</span>');
const stateLabel = (s) => ({ delegating: 'leading', idle: 'idle', offline: 'down', open: 'running', scheduled: 'scheduled', paused: 'paused' }[s] || s);
const pill = (s, extra) => `<span class="pill s-${esc(s)} ${['running', 'delegating', 'open'].includes(s) ? 'live' : ''}">${esc(extra || stateLabel(s))}</span>`;
const LEVELS = [1, 3, 6, 10, 15, 25, 40, 60];
const levelOf = (a) => 1 + LEVELS.filter((x) => (a.resident ? a.ticketsHandled || 0 : a.tasksDone || 0) >= x).length;
function starOf(homeId) {
  let best = null, bestRate = -1;
  for (const a of Object.values(S.agents)) {
    if (!a.staff || a.homeId !== homeId) continue;
    const tot = (a.tasksDone || 0) + (a.tasksFailed || 0);
    if (tot < 3) continue;
    const rate = (a.tasksDone || 0) / tot + tot / 1000;
    if (rate > bestRate) { bestRate = rate; best = a.id; }
  }
  return best;
}
function agentJob(a) {
  if (!a) return null;
  if (a.resident) return a.current ? S.tickets[a.current.ticketId] : null;
  return ACTIVE.includes(a.status) ? S.tickets[a.ticketId] : null;
}
function absorb(id, e) {
  const L = S.live[id] || (S.live[id] = {});
  const one = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  if (e.kind === 'thinking' || e.kind === 'text') { L.thought = one(e.text); L.t = e.t; L.kind = 'think'; }
  else if (e.kind === 'progress') { L.thought = one(e.text); L.t = e.t; L.kind = 'say'; }
  else if (e.kind === 'delegate') { L.thought = 'Started: ' + one(e.text.replace(/\n/g, '; ')); L.t = e.t; L.kind = 'say'; }
  else if (e.kind === 'brief' || e.kind === 'followup') { L.thought = e.label || (e.chore ? 'Housekeeping.' : 'Reading the brief.'); L.t = e.t; L.kind = 'say'; }
  else if (e.kind === 'result') { L.thought = e.isError ? 'Finished with an error.' : 'Finished and reported.'; L.t = e.t; L.kind = 'say'; }
  else if (e.kind === 'msg_out') { L.thought = `→ ${e.toPersona}: ${one(e.text)}`; L.t = e.t; L.kind = 'say'; }
  else if (e.kind === 'script') { L.thought = `ran script ${e.name} ${(e.args || []).join(' ')}`; L.t = e.t; L.kind = 'say'; }
  else if (e.kind === 'tool_use') { L.thought = toolStep(e.name, e.input || {}); L.t = e.t; L.kind = 'tool'; }
  else if (e.kind === 'tool_result') { L.t = e.t; }
}
function toolStep(name, i) {
  const base = (p) => String(p || '').split('/').pop();
  const cut = (s) => short(String(s || '').replace(/\s+/g, ' '), 90);
  if (name === 'Read') return `Reading ${base(i.file_path)}`;
  if (name === 'Edit' || name === 'MultiEdit') return `Editing ${base(i.file_path)}`;
  if (name === 'Write') return `Writing ${base(i.file_path)}`;
  if (name === 'Bash') return `Running: ${cut(i.description || i.command)}`;
  if (name === 'Grep' || name === 'Glob') return `Searching for ${cut(i.pattern)}`;
  if (name === 'WebSearch') return `Searching the web: ${cut(i.query)}`;
  if (name === 'WebFetch') return `Reading ${cut(i.url)}`;
  const n = String(name).replace(/^mcp__workplace__/, '');
  const words = { delegate: 'Handing work to teammates', wait_for_team: 'Waiting for teammates', ask_user: 'Asking you a question', propose_plan: 'Proposing a plan',
    search_tickets: `Checking past jobs for ${cut(i.query)}`, script: `Running script ${cut(i.name)}`, ask: `Asking ${i.to || 'a colleague'}`, update_memory: 'Updating its memory',
    add_to_team_docs: 'Writing team notes', save_project_handoff: `Saving the ${i.project || 'project'} handoff`, report_progress: cut(i.status) };
  return words[n] || `Using ${n.replace(/^mcp__[^_]+__/, '').replace(/_/g, ' ')}`;
}

// ================================================================ boot + live updates
async function init() {
  const st = await api('GET', '/api/state');
  S.roles = st.roles; S.projects = st.projects; S.residents = st.residents; S.root = st.root; S.limits = st.limits;
  S.restart = st.restart || {}; S.uiAtLoad = S.restart.uiStamp || 0;
  api('GET', '/api/skill-proposals').then((l) => { S.skPending = l.filter((x) => x.status === 'pending').length; dirty(); }).catch(() => {});
  S.agents = Object.fromEntries(st.agents.map((a) => [a.id, a]));
  S.tickets = Object.fromEntries(st.tickets.map((t) => [t.id, t]));
  if (!S.seen) { S.seen = Object.fromEntries(st.tickets.map((t) => [t.id, Date.now()])); setPref('seen', JSON.stringify(S.seen)); }
  S.compose = S.compose || {};
  api('GET', '/api/scripts').then((l) => { S.scripts = l; }).catch(() => {});
  refreshHealth();
  setInterval(refreshHealth, 60000);
  await Promise.all(Object.values(S.agents).filter((a) => a.resident || ACTIVE.includes(a.status)).map((a) => loadEvents(a.id)));
  readHash();
  openApp(S.app, true);
  if (!/[?&]nosse/.test(location.search)) connect();
  setInterval(tick, 1000);
  tick();
}
async function loadEvents(id, force) {
  if (S.events[id] && !force) return;
  const list = await api('GET', `/api/agents/${id}/events?limit=400`).catch(() => []);
  S.events[id] = list;
  S.live[id] = {};
  for (const e of list) absorb(id, e);
}
function refreshHealth() { api('GET', '/api/health').then((h) => { S.health = h; if (!S.selftest) S.selftest = h.selftest; dirty(); }).catch(() => {}); }
let isDirty = true;
const dirty = () => { isDirty = true; };
function connect() {
  const es = new EventSource('/api/stream');
  // After a restart (or any lost connection) the page reloads itself once the server answers again.
  es.onerror = () => { if (!S.down) { S.down = Date.now(); dirty(); } };
  es.onopen = () => { if (S.down) location.reload(); };
  es.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'agent') {
      const prev = S.agents[m.agent.id];
      S.agents[m.agent.id] = m.agent;
      if (!S.events[m.agent.id] && ACTIVE.includes(m.agent.status)) loadEvents(m.agent.id);
      if (prev && prev.memoryVersion !== m.agent.memoryVersion && S.app === 'memory') S.memCache = null;
    } else if (m.type === 'event') {
      absorb(m.agentId, m.event);
      if (S.events[m.agentId]) S.events[m.agentId].push(m.event);
    } else if (m.type === 'skills') {
      S.skProps = null; S.skillsData = null; S.skKey = null;
      api('GET', '/api/skill-proposals').then((l) => { S.skPending = l.filter((x) => x.status === 'pending').length; dirty(); }).catch(() => {});
    } else if (m.type === 'restart') {
      S.restart = m.restart;
    } else if (m.type === 'cmd') {
      onCommandEvent(m);
      return;
    } else if (m.type === 'draft') {
      S.drafts[m.agentId] = m.text;
      updateJobLive();
      return;
    } else if (m.type === 'ticket') {
      const prev = S.tickets[m.ticket.id];
      S.tickets[m.ticket.id] = m.ticket;
      if (prev) for (const e of m.ticket.thread.slice(prev.thread.length)) {
        if (e.kind === 'answer') S.drafts[e.from] = null;
        if (e.kind === 'answer' && !e.silent) notify('answer', `${who(e.from)} answered job #${m.ticket.n}`, e.text, m.ticket.id);
        else if (e.kind === 'system' && /budget/i.test(e.text || '') && m.ticket.overBudget) notify('warn', `Job #${m.ticket.n} paused at its budget`, e.text, m.ticket.id);
      }
      delete S.timeline[m.ticket.id];
    } else if (m.type === 'ticketRemoved') {
      delete S.tickets[m.id];
      if (S.job === m.id) S.job = null;
    } else if (m.type === 'limits') S.limits = m.limits;
    else if (m.type === 'notify') notify(m.kind, m.title, m.text, m.ticketId);
    else if (m.type === 'selftest') S.selftest = m.selftest;
    else if (m.type === 'roster') api('GET', '/api/state').then((st) => { S.roles = st.roles; S.residents = st.residents; S.projects = st.projects; for (const a of st.agents) S.agents[a.id] = a; S.cfg = null; dirty(); });
    else if (m.type === 'chat') S.chat = null;
    else if (m.type === 'docs') S.teams = null;
    else if (m.type === 'arms') { S.armsData = null; S.skillsData = null; S.routinesData = null; S.recosData = null; S.inbox = null; S.armsKey = null; }
    dirty();
  };
}
function tick() {
  $('#clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  updateJobLive();
  showSendBar();
  if (S.replay && S.replay.playing) { S.replay.t = Math.min(S.replay.t1, S.replay.t + 1000 * S.replay.speed); if (S.replay.t >= S.replay.t1) S.replay.playing = false; isDirty = true; }
  if (!isDirty) return;
  isDirty = false;
  renderChrome();
  updateApp(S.app);
}

// ================================================================ chrome: top bar, dock, alert
const APP_LIST = [
  { id: 'today', ic: 'home', name: 'Today', key: 'd', grp: 'Home' },
  { id: 'processes', ic: 'processes', name: 'Processes', key: 'p', grp: 'System' },
  { id: 'jobs', ic: 'jobs', name: 'Jobs', key: 'j' },
  { id: 'newjob', ic: 'newjob', name: 'New job', key: 'n' },
  { id: 'arms', ic: 'arms', name: 'ARMS', key: 'a', grp: 'ARMS' },
  { id: 'skills', ic: 'skills', name: 'Skills', key: 's' },
  { id: 'routines', ic: 'routines', name: 'Routines', key: 'r' },
  { id: 'recos', ic: 'recos', name: 'Recos', key: 'c' },
  { id: 'review', ic: 'review', name: 'Review', key: 'v', external: '/review' },
  { id: 'projects', ic: 'projects', name: 'Projects', key: 'o', grp: 'Workspace' },
  { id: 'messages', ic: 'messages', name: 'Messages', key: 'm' },
  { id: 'memory', ic: 'memory', name: 'Memory', key: 'y' },
  { id: 'library', ic: 'library', name: 'Library', key: 'l' },
  { id: 'terminal', ic: 'terminal', name: 'Terminal', key: 't' },
  { id: 'usage', ic: 'usage', name: 'Usage', key: 'u' },
  { id: 'tokens', ic: 'tokens', name: 'Tokens', key: 'k' },
  { id: 'health', ic: 'health', name: 'Health', key: 'h' },
  { id: 'settings', ic: 'teams', name: 'Teams & roles', key: 'e' },
];
function windowOf(k) { return (S.limits && S.limits.windows && S.limits.windows[k]) || null; }
const live = (w) => (w.resetsAt && w.resetsAt < Date.now() ? 0 : w.utilization || 0);
const meterColor = (u) => (u >= 0.85 ? 'var(--fail)' : u >= 0.7 ? 'var(--stop)' : 'var(--done)');
function renderChrome() {
  const all = Object.values(S.agents);
  const running = all.filter((a) => ['running', 'delegating'].includes(a.status) || (a.resident && a.current)).length;
  const openJobs = Object.values(S.tickets).filter((t) => ['open', 'paused'].includes(t.status));
  const asks = Object.values(S.tickets).filter(needsYou).length;
  const unread = Object.values(S.tickets).filter(isUnread).length;
  const badges = { skills: S.skPending ? [`${S.skPending} new`, 'ask'] : null, processes: running ? [running, 'run'] : null, jobs: asks ? [`${asks} ?`, 'ask'] : unread ? [`${unread} new`, 'run'] : openJobs.length ? [openJobs.length, 'run'] : null };
  $('#nav').innerHTML = APP_LIST.map((x) => `${x.grp ? `<div class="dock-sec">${x.grp}</div>` : ''}<div class="app-link ${S.app === x.id ? 'on' : ''}" data-act="app" data-app="${x.id}" data-tip="${esc(x.name)} · ${esc(x.key)}"><span class="ic">${ic(x.ic)}</span><span class="lbl">${esc(x.name)}</span>${badges[x.id] ? `<span class="bd ${badges[x.id][1]}">${badges[x.id][0]}</span>` : ''}</div>`).join('');
  $('#meters').innerHTML = ['five_hour', 'seven_day'].map((k) => { const w = windowOf(k); if (!w) return ''; const u = live(w); return `<span class="meter" data-act="app" data-app="usage" title="${k === 'five_hour' ? '5-hour' : 'Weekly'} limit${w.resetsAt ? ', resets ' + whenAt(w.resetsAt) : ''}"><span class="lbl">${k === 'five_hour' ? '5h' : 'week'}</span><i><b style="width:${Math.min(100, u * 100)}%;background:${meterColor(u)}"></b></i><span>${pct(u)}</span></span>`; }).join('');
  $('#hdot').className = 'dot ' + (S.health ? S.health.level : '');
  renderTitlebar(running, openJobs.length);
  const h = S.limits && S.limits.hold;
  const key = h ? `${h.window}|${h.resetsAt}` : '';
  const al = $('#alert');
  if (h && S.alertDismissed !== key) {
    al.classList.add('on'); al.dataset.key = key;
    al.innerHTML = `⚠️ <span>Your <b>${h.window === 'five_hour' ? '5-hour' : h.window === 'seven_day' ? 'weekly' : esc(h.window)}</b> limit is at <b>${pct(h.utilization)}</b>. New work is paused.</span><button class="btn pri sm" data-act="limContinue">Continue anyway</button><button class="btn sm" data-act="limWait">Wait for the reset (${whenAt(h.resetsAt)})</button>`;
    $('#appRoot').style.top = al.offsetHeight + 'px';
  } else { al.classList.remove('on'); $('#appRoot').style.top = '0'; }
}
function openApp(id, keepSel) {
  const ext = APP_LIST.find((x) => x.id === id && x.external);
  if (ext) { window.open(ext.external, 'agentos-' + id, 'popup,width=1280,height=860'); return; }
  if (!APPS[id]) id = 'processes';
  S.app = id;
  setPref('app', id);
  if (!keepSel && id !== 'processes') S.replay = null;
  $('#appRoot').innerHTML = '';
  APPS[id].mount($('#appRoot'));
  writeHash();
  renderChrome();
  updateApp(id);
}
// Apps that load data asynchronously may finish after you left them; their late writes are ignored, errors in the open app are not.
function updateApp(id) {
  let r;
  try { r = APPS[id].update(); } catch (e) { if (S.app === id) throw e; return; }
  if (r && r.catch) r.catch((e) => { if (S.app === id) console.error(e); });
}
function writeHash() {
  const parts = [S.app];
  if (S.app === 'processes' && S.sel) parts.push('pid=' + S.sel);
  if (S.app === 'jobs' && S.job) parts.push('job=' + S.job, 'tab=' + S.jtab);
  history.replaceState(null, '', '#' + parts.join('&'));
}
function readHash() {
  const h = location.hash.slice(1);
  if (!h) return;
  const [app, ...kv] = h.split('&');
  if (APP_LIST.some((x) => x.id === app)) S.app = app;
  for (const x of kv) {
    const [k, v] = x.split('=');
    if (k === 'pid' && S.agents[v]) S.sel = v;
    if (k === 'job' && S.tickets[v]) S.job = v;
    if (k === 'tab') S.jtab = v;
    if (k === 'replay') S.wantReplay = true;
  }
}
