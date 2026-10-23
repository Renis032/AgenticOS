'use strict';
// The app shell: window title bar and buttons, menus, notification center and Preferences. Starts the app.
// ================================================================ app shell: title bar, window, menus, notifications, preferences
const NATIVE = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.agentos);
const NATIVE_INFO = window.osNativeInfo || {};
function native(cmd, data) { if (NATIVE) window.webkit.messageHandlers.agentos.postMessage(JSON.stringify({ cmd, ...(data || {}) })); }
const ic = (name) => `<svg class="i"><use href="#i-${name}"/></svg>`;
S.zoom = 1;
S.notes = prefObj('notes') || [];
S.notesSeen = Number(pref('notesSeen', '0'));

// The window process tells the page when it is maximized, focused or zoomed, and asks it to open a job from a notification.
window.osNativeState = (st) => {
  const root = document.documentElement;
  root.classList.toggle('maximized', !!st.maximized);
  root.classList.toggle('inactive', !st.active);
  S.maximized = !!st.maximized;
  if (typeof st.zoom === 'number') S.zoom = Math.round(st.zoom * 100) / 100;
  renderWindowControls();
  if ($('#prefs').classList.contains('on') && S.prefSec === 'appearance') renderPrefs();
};
window.osOpenJob = (id) => { if (S.tickets[id]) { S.job = id; S.jtab = 'thread'; openApp('jobs'); } };

function renderWindowControls() {
  if (!NATIVE) return;
  const [left, right] = String(NATIVE_INFO.layout || ':minimize,maximize,close').split(':');
  const btn = (n) => n === 'minimize' ? `<button class="wbtn" data-act="wmin" data-tip="Minimize">${ic('min')}</button>`
    : n === 'maximize' ? `<button class="wbtn" data-act="wmax" data-tip="${S.maximized ? 'Restore' : 'Maximize'}">${ic(S.maximized ? 'restore' : 'max')}</button>`
    : n === 'close' ? `<button class="wbtn close" data-act="wclose" data-tip="Close">${ic('close')}</button>` : '';
  const html = (part) => (part || '').split(',').map((x) => btn(x.trim())).join('');
  if ($('#wctlL').innerHTML !== html(left)) $('#wctlL').innerHTML = html(left);
  if ($('#wctlR').innerHTML !== html(right)) $('#wctlR').innerHTML = html(right);
}
const NO_DRAG = 'button, input, select, textarea, a, kbd, .meter, .searchpill, [data-act]';
$('#top').addEventListener('mousedown', (e) => { if (e.button === 0 && !e.target.closest(NO_DRAG) && e.detail === 1) native('drag'); });
$('#top').addEventListener('dblclick', (e) => { if (!e.target.closest(NO_DRAG)) native('maximize'); });

function renderTitlebar(running, open) {
  const app = APP_LIST.find((x) => x.id === S.app) || {};
  let tail = '';
  if (S.app === 'jobs' && S.tickets[S.job]) tail = `<span class="sep">›</span><b>#${S.tickets[S.job].n} ${esc(short(S.tickets[S.job].title, 70))}</b>`;
  else if (S.app === 'processes' && S.agents[S.sel]) tail = `<span class="sep">›</span><b>${esc(S.agents[S.sel].persona)}</b>`;
  const h = `<span>${esc(app.name || '')}</span>${tail}<span class="stat ${running ? 'on' : ''}" data-act="app" data-app="processes">${running} running</span><span class="stat" data-act="app" data-app="jobs">${open} open</span>`;
  const el = $('#appTitle');
  if (el.dataset.h !== h) { el.innerHTML = h; el.dataset.h = h; }
  const unread = S.notes.filter((n) => n.t > S.notesSeen).length;
  $('#nbadge').textContent = unread > 9 ? '9+' : unread;
  $('#nbadge').classList.toggle('on', unread > 0);
  $('#bell').querySelector('use').setAttribute('href', pref('dnd', '0') === '1' ? '#i-bell-off' : '#i-bell');
  $('#clock').style.display = pref('clock', '1') === '1' ? '' : 'none';
  const R = S.restart || {};
  const upd = S.down ? `<span class="updchip warn">${ic('reload')}Reconnecting…</span>`
    : R.pending && R.pending.checking ? `<span class="updchip on" data-tip="The new version is being tested in a throwaway copy before the office switches to it.">${ic('reload')}${esc(R.pending.checking)} <a data-act="restartCancel">Cancel</a></span>`
    : R.pending ? `<span class="updchip on" data-tip="New work waits; running work finishes first. The window reloads by itself.">${ic('reload')}Restarting when idle${R.busy && R.busy.length ? ` · waiting for ${esc(R.busy.slice(0, 3).join(', '))}` : '…'} <a data-act="restartCancel">Cancel</a></span>`
    : R.codeChanged ? `<span class="updchip">${ic('reload')}Update ready <a data-act="restartIdle">Restart when idle</a></span>`
    : R.uiStamp && S.uiAtLoad && R.uiStamp > S.uiAtLoad ? `<span class="updchip">${ic('reload')}Update ready <a data-act="reloadUi">Reload</a></span>` : '';
  if ($('#upd').dataset.h !== upd) { $('#upd').innerHTML = upd; $('#upd').dataset.h = upd; }
}

// ---------------------------------------------------------------- preferences applied to the page
const ACCENTS = { amber: ['#e8a33d', '#b86e1c'], blue: ['#5aa6ef', '#2f6fbf'], violet: ['#a98bf0', '#7a55d4'], green: ['#4fbf86', '#23885c'], rose: ['#ef6f93', '#c43d66'], teal: ['#3fbab2', '#1f8a84'] };
const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
function isDark() { const t = pref('theme', 'system'); return t === 'dark' || (t === 'system' && darkMq.matches); }
function applyPrefs() {
  const root = document.documentElement;
  const theme = pref('theme', 'system');
  if (theme === 'system') delete root.dataset.theme; else root.dataset.theme = theme;
  root.dataset.density = pref('density', 'comfortable');
  root.dataset.motion = pref('motion', 'full');
  root.dataset.sidebar = pref('sidebar', 'expanded');
  const [dark, light] = ACCENTS[pref('accent', 'amber')] || ACCENTS.amber;
  root.style.setProperty('--accent', isDark() ? dark : light);
  root.style.setProperty('--accent-ink', isDark() ? '#16110a' : '#ffffff');
  if (!NATIVE) root.style.zoom = pref('zoomCss', '1');
  renderWindowControls();
}
darkMq.addEventListener('change', applyPrefs);
function toggleSidebar() { setPref('sidebar', pref('sidebar', 'expanded') === 'expanded' ? 'collapsed' : 'expanded'); applyPrefs(); }
function setTheme(t) { setPref('theme', t); applyPrefs(); if ($('#prefs').classList.contains('on')) renderPrefs(); }
function zoomTo(level) {
  level = Math.max(0.7, Math.min(1.6, Math.round(level * 10) / 10));
  S.zoom = level;
  if (NATIVE) native('zoom', { level }); else { setPref('zoomCss', String(level)); applyPrefs(); }
}

// ---------------------------------------------------------------- menus (main menu, right-click menus)
let menuItems = [], menuHot = -1;
function openMenu(items, at) {
  menuItems = items.filter(Boolean);
  menuHot = -1;
  const el = $('#menu');
  el.innerHTML = menuItems.map((it, i) => it.sep ? '<div class="ms"></div>' : it.head ? `<div class="mh">${esc(it.head)}</div>`
    : `<div class="mi ${it.danger ? 'danger' : ''} ${it.disabled ? 'off' : ''}" data-mi="${i}">${it.checked !== undefined ? `<span class="ck">${it.checked ? ic('check') : ''}</span>` : ic(it.icon || 'dot')}<span class="lbl">${esc(it.label)}</span>${it.kb ? `<span class="kb">${esc(it.kb)}</span>` : ''}</div>`).join('');
  el.classList.add('on');
  const r = el.getBoundingClientRect();
  let x = at.x, y = at.y;
  if (at.el) { const b = at.el.getBoundingClientRect(); x = at.align === 'right' ? b.right - r.width : b.left; y = b.bottom + 6; }
  el.style.left = Math.max(6, Math.min(innerWidth - r.width - 6, x)) + 'px';
  el.style.top = Math.max(6, Math.min(innerHeight - r.height - 6, y)) + 'px';
  S.menuAnchor = at.el || null;
  if (at.el) at.el.classList.add('on');
}
function closeMenu() { $('#menu').classList.remove('on'); if (S.menuAnchor) S.menuAnchor.classList.remove('on'); S.menuAnchor = null; menuItems = []; }
function hotMenu(i) { menuHot = i; document.querySelectorAll('#menu .mi').forEach((x) => x.classList.toggle('hot', Number(x.dataset.mi) === i)); }
function runMenu(i) { const it = menuItems[i]; if (!it || it.disabled || !it.run) return; closeMenu(); setTimeout(() => Promise.resolve().then(it.run).catch((e) => alert(e.message)), 40); }
$('#menu').addEventListener('mousemove', (e) => { const mi = e.target.closest('.mi'); if (mi) hotMenu(Number(mi.dataset.mi)); });
$('#menu').addEventListener('click', (e) => { const mi = e.target.closest('.mi'); if (mi) runMenu(Number(mi.dataset.mi)); });
document.addEventListener('mousedown', (e) => {
  if ($('#menu').classList.contains('on') && !e.target.closest('#menu') && !(S.menuAnchor && S.menuAnchor.contains(e.target))) closeMenu();
  if ($('#ncenter').classList.contains('on') && !e.target.closest('#ncenter, #bell')) $('#ncenter').classList.remove('on');
  hideTip();
}, true);
window.addEventListener('blur', () => { closeMenu(); hideTip(); });
window.addEventListener('resize', closeMenu);

function appMenu() {
  return [
    { label: 'New job', icon: 'newjob', kb: 'Ctrl+N', run: () => openApp('newjob') },
    { label: 'Search and commands', icon: 'command', kb: 'Ctrl+K', run: openPal },
    { sep: true }, { head: 'View' },
    { label: 'Show sidebar', checked: pref('sidebar', 'expanded') === 'expanded', kb: 'Ctrl+B', run: toggleSidebar },
    { label: 'Follow the system theme', checked: pref('theme', 'system') === 'system', run: () => setTheme('system') },
    { label: 'Dark theme', checked: pref('theme', 'system') === 'dark', run: () => setTheme('dark') },
    { label: 'Light theme', checked: pref('theme', 'system') === 'light', run: () => setTheme('light') },
    { label: 'Zoom in', icon: 'zoom-in', kb: 'Ctrl +', run: () => zoomTo(S.zoom + 0.1) },
    { label: 'Zoom out', icon: 'zoom-out', kb: 'Ctrl −', run: () => zoomTo(S.zoom - 0.1) },
    { label: `Actual size (${Math.round(S.zoom * 100)}%)`, icon: 'search', kb: 'Ctrl 0', run: () => zoomTo(1) },
    NATIVE && { label: 'Full screen', icon: 'expand', kb: 'F11', run: () => native('fullscreen') },
    { sep: true },
    { label: 'Preferences…', icon: 'settings', kb: 'Ctrl+,', run: () => openPrefs() },
    { label: 'Teams & roles', icon: 'teams', kb: 'E', run: () => openApp('settings') },
    { label: 'Keyboard shortcuts', icon: 'keyboard', kb: '?', run: () => openPrefs('keys') },
    { sep: true },
    { label: 'Reload', icon: 'reload', kb: 'Ctrl+R', run: () => location.reload() },
    { label: S.restart && S.restart.pending ? 'Cancel the pending restart' : 'Restart Agentic OS when idle', icon: 'reload', run: () => (S.restart && S.restart.pending ? ACT.restartCancel() : ACT.restartIdle()) },
    { label: 'About Agentic OS', icon: 'info', run: () => (NATIVE ? native('about') : openPrefs('about')) },
    NATIVE && { sep: true },
    NATIVE && { label: 'Quit Agentic OS', icon: 'quit', kb: 'Ctrl+Q', run: () => native('close') },
  ];
}

// Right-click: jobs and dock entries get their own menus; text fields and selected text keep copy and paste.
document.addEventListener('contextmenu', (e) => {
  const job = e.target.closest('.jl[data-id]');
  const link = e.target.closest('.app-link[data-app]');
  if (job) { e.preventDefault(); return openMenu(jobMenu(S.tickets[job.dataset.id]), { x: e.clientX, y: e.clientY }); }
  if (link) { e.preventDefault(); const app = APP_LIST.find((x) => x.id === link.dataset.app); return openMenu([{ label: `Open ${app.name}`, icon: app.ic, kb: app.key.toUpperCase(), run: () => openApp(app.id) }, { sep: true }, { label: pref('sidebar', 'expanded') === 'expanded' ? 'Collapse sidebar' : 'Expand sidebar', icon: 'sidebar', kb: 'Ctrl+B', run: toggleSidebar }], { x: e.clientX, y: e.clientY }); }
  if (e.target.closest('input, textarea, [contenteditable]') || String(window.getSelection())) return;
  e.preventDefault();
});
function jobMenu(t) {
  if (!t) return [];
  const unread = isUnread(t);
  return [
    { label: 'Open', icon: 'open', run: () => { S.job = t.id; S.jtab = 'thread'; openApp('jobs'); } },
    { label: unread ? 'Mark as read' : 'Mark as unread', icon: 'mail-read', run: () => { S.seen[t.id] = unread ? Date.now() : 0; setPref('seen', JSON.stringify(S.seen)); dirty(); } },
    { label: `Copy “#${t.n}”`, icon: 'copy', run: () => copyText(`#${t.n}`) },
    { label: 'Copy the answer', icon: 'copy', disabled: !t.answer, run: () => copyText(t.answer || '') },
    { sep: true },
    ['open', 'paused'].includes(t.status) && { label: t.status === 'paused' ? 'Resume' : 'Pause', icon: 'pause', run: () => api('POST', `/api/tickets/${t.id}/${t.status === 'paused' ? 'resume' : 'pause'}`) },
    ['open', 'paused'].includes(t.status) && { label: 'Stop job', icon: 'stop', danger: true, run: () => { if (confirm(`Stop job #${t.n}?\nRunning agents on it are stopped.`)) return api('POST', `/api/tickets/${t.id}/stop`); } },
    !['open', 'paused'].includes(t.status) && { label: t.archived ? 'Unarchive' : 'Archive', icon: 'archive', run: () => api('POST', `/api/tickets/${t.id}/archive`, { archived: !t.archived }) },
    { label: 'Delete…', icon: 'trash', danger: true, run: () => { if (confirm(`Delete job #${t.n}?\nStaff stay; its history goes.`)) return api('DELETE', `/api/tickets/${t.id}`); } },
  ];
}
function copyText(text) {
  const done = () => notifyQuiet('Copied to the clipboard');
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(done, () => {});
  const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch {} ta.remove();
}
function notifyQuiet(title) {
  const el = document.createElement('div');
  el.className = 'toast'; el.innerHTML = `<span class="tic">${ic('check')}</span><div><b>${esc(title)}</b></div>`;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 200); }, 1600);
}

// ---------------------------------------------------------------- notification center
const NOTE_ICON = { answer: 'check', question: 'messages', warn: 'info', limit: 'usage' };
function logNote(kind, title, text, ticketId) {
  S.notes.unshift({ t: Date.now(), kind, title, text: short(text || '', 300), ticketId: ticketId || null });
  S.notes = S.notes.slice(0, 60);
  setPref('notes', JSON.stringify(S.notes));
  if ($('#ncenter').classList.contains('on')) renderNcenter();
  dirty();
}
function noteWanted(kind) {
  if (pref('dnd', '0') === '1') return false;
  const key = { answer: 'nAnswers', question: 'nQuestions', warn: 'nWarn', limit: 'nLimits' }[kind];
  return !key || pref(key, '1') === '1';
}
function renderNcenter() {
  const seen = S.ncPrevSeen || 0;
  const dnd = pref('dnd', '0') === '1';
  $('#ncenter').innerHTML = `<div class="ph"><h3>Notifications</h3>
      <button class="tb-ic ${dnd ? 'on' : ''}" data-act="dnd" data-tip="${dnd ? 'Do not disturb is on: no toasts, sounds or desktop notifications' : 'Do not disturb'}">${ic(dnd ? 'bell-off' : 'dnd')}</button>
      <button class="tb-ic" data-act="ncClear" data-tip="Clear all">${ic('trash')}</button>
      <button class="tb-ic" data-act="prefs" data-sec="notifications" data-tip="Notification preferences">${ic('settings')}</button></div>
    <div class="pl">${S.notes.length ? S.notes.map((n, i) => `<div class="nt ${n.t > seen ? 'unread' : ''}" data-act="ncOpen" data-i="${i}"><span class="tic k-${esc(n.kind)}">${ic(NOTE_ICON[n.kind] || 'info')}</span><div class="b2"><b>${esc(n.title)}</b>${n.text ? `<span class="hint">${esc(n.text)}</span>` : ''}</div><span class="when">${ago(n.t)}</span></div>`).join('')
      : `<div class="empty">${ic('bell')}<div style="margin-top:8px">You're all caught up.</div><div class="hint">Answers, questions from agents, budget stops and limits show up here.</div></div>`}</div>`;
}

// ---------------------------------------------------------------- preferences window
const PREF_SECTIONS = [['general', 'General', 'settings'], ['appearance', 'Appearance', 'sun'], ['notifications', 'Notifications', 'bell'], ['jobs', 'Jobs & chat', 'jobs'], ['agents', 'Agents & teams', 'teams'], ['keys', 'Keyboard', 'keyboard'], ['about', 'About', 'info']];
// Office-wide settings live on the server (roster.json); the Preferences window edits them through /api/office-settings.
function officeSelect(key, opts) {
  const v = (S.office || {})[key];
  return `<select data-office="${key}">${opts.map(([val, l]) => `<option value="${val}" ${Number(v) === Number(val) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
}
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-office]');
  if (!el) return;
  api('POST', '/api/office-settings', { [el.dataset.office]: Number(el.value) }).then((r) => { S.office = r; renderPrefs(); });
});
function openPrefs(sec) {
  closeMenu(); closePal(); $('#ncenter').classList.remove('on');
  api('GET', '/api/office-settings').then((r) => { S.office = r; if ($('#prefs').classList.contains('on')) renderPrefs(); }).catch(() => {});
  api('GET', '/api/terminal-mode').then((r) => { if (r.mode !== S.termMode) { S.termMode = r.mode; if ($('#prefs').classList.contains('on')) renderPrefs(); } }).catch(() => {});
  S.prefSec = sec || S.prefSec || 'general';
  $('#prefs').classList.add('on');
  renderPrefs();
}
function closePrefs() { $('#prefs').classList.remove('on'); }
const prow = (title, desc, control) => `<div class="prow"><div class="pt"><b>${title}</b>${desc ? `<span>${desc}</span>` : ''}</div>${control}</div>`;
const pSwitch = (key, def) => `<label class="sw"><input type="checkbox" data-pref="${key}" ${pref(key, def) === '1' ? 'checked' : ''}><i></i></label>`;
const pSeg = (key, def, opts) => `<div class="seg">${opts.map(([v, l, i]) => `<button class="${pref(key, def) === v ? 'on' : ''}" data-act="prefSeg" data-k="${key}" data-v="${esc(v)}">${i ? ic(i) : ''}${esc(l)}</button>`).join('')}</div>`;
const pSelect = (key, def, opts) => `<select data-pref="${key}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${pref(key, def) === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
const pGroup = (title, rows) => `${title ? `<div class="pgroup-h">${title}</div>` : ''}<div class="pgroup">${rows.join('')}</div>`;
function renderPrefs() {
  $('#prefsNav').innerHTML = `<h2>Preferences</h2>${PREF_SECTIONS.map(([k, l, i]) => `<div class="pn ${S.prefSec === k ? 'on' : ''}" data-act="prefSec" data-sec="${k}">${ic(i)}${esc(l)}</div>`).join('')}<div class="grow"></div><div class="hint" style="padding:0 10px">Saved as you change them.</div>`;
  const body = PREF_BODY[S.prefSec]();
  $('#prefsBody').innerHTML = `<button class="tb-ic x" data-act="closePrefs" data-tip="Close · Esc">${ic('close')}</button>${body}`;
}
const PREF_BODY = {
  general: () => `<h2>General</h2><div class="hint">How Agentic OS starts and closes.</div>` +
    pGroup('Start-up', [
      prow('Open on start', 'The app shown when the window opens.', pSelect('startApp', 'today', [['today', 'Today'], ['last', 'Where I left off'], ['jobs', 'Jobs'], ['projects', 'Projects'], ['processes', 'Processes'], ['newjob', 'New job']])),
      prow('Sidebar', 'Show app names, or only icons for more room.', pSeg('sidebar', 'expanded', [['expanded', 'Names'], ['collapsed', 'Icons only']])),
      NATIVE ? prow('Start at login', NATIVE_INFO.tray ? 'Agentic OS starts in the tray when you log in, so agents can work before you open the window.' : 'Agentic OS starts when you log in.',
        `<label class="sw"><input type="checkbox" id="autostartSw" ${NATIVE_INFO.autostart ? 'checked' : ''}><i></i></label>`) : '',
    ]) +
    pGroup('Closing the window', [
      prow('While jobs are running', `What closing the window does when agents are still working. With nothing running, it always quits.${NATIVE_INFO.tray ? ' "In the background" hides it to the tray.' : ''}`,
        pSelect('closeAction', 'ask', [['ask', 'Ask me each time'], ['background', 'Keep them running in the background'], ['stop', 'Stop them and quit']])),
    ]),
  appearance: () => `<h2>Appearance</h2><div class="hint">Theme, colour and size.</div>` +
    pGroup('', [
      prow('Theme', 'Follow Ubuntu’s light or dark style, or pick one.', pSeg('theme', 'system', [['system', 'System', 'monitor'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']])),
      prow('Accent colour', 'Used for highlights, switches and the active app.', `<div class="swatches">${Object.entries(ACCENTS).map(([k, [d, l]]) => `<button class="${pref('accent', 'amber') === k ? 'on' : ''}" style="--c:${isDark() ? d : l}" data-act="prefSeg" data-k="accent" data-v="${k}" data-tip="${k}"></button>`).join('')}</div>`),
      prow('Text size', 'Zooms the whole window (also Ctrl + and Ctrl −).', `<div class="range"><input type="range" min="70" max="160" step="10" value="${Math.round(S.zoom * 100)}" id="zoomRange" style="--fill:${((Math.round(S.zoom * 100) - 70) / 90) * 100}%"><output id="zoomOut">${Math.round(S.zoom * 100)}%</output></div>`),
      prow('Density', 'Compact fits more rows on screen.', pSeg('density', 'comfortable', [['comfortable', 'Comfortable'], ['compact', 'Compact']])),
      prow('Animations', 'Reduce motion turns off fades and slides.', pSeg('motion', 'full', [['full', 'On'], ['reduced', 'Reduced']])),
      prow('Clock in the title bar', '', pSwitch('clock', '1')),
    ]),
  notifications: () => `<h2>Notifications</h2><div class="hint">What gets your attention, and how.</div>` +
    pGroup('', [
      prow('Do not disturb', 'Keep everything in the notification center, with no toasts, sounds or desktop notifications.', pSwitch('dnd', '0')),
      prow('Desktop notifications', NATIVE ? 'Ubuntu notifications while the window is in the background. Click one to open the job.' : 'Browser notifications while the window is hidden.', pSwitch('notify', NATIVE ? '1' : '0')),
      prow('Sounds', 'A short chime; questions and warnings sound different from answers.', pSwitch('sound', '0')),
      prow('Keep toasts on screen for', '', pSelect('toastSecs', '8', [['4', '4 seconds'], ['8', '8 seconds'], ['15', '15 seconds'], ['30', '30 seconds']])),
    ]) +
    pGroup('Tell me about', [
      prow('Answers', 'A lead finished and answered a job.', pSwitch('nAnswers', '1')),
      prow('Questions and plans', 'An agent is waiting for your answer or your OK.', pSwitch('nQuestions', '1')),
      prow('Warnings', 'Budget stops, long chats and other problems.', pSwitch('nWarn', '1')),
      prow('Usage limits', 'The 5-hour or weekly limit is getting close.', pSwitch('nLimits', '1')),
    ]),
  jobs: () => `<h2>Jobs & chat</h2><div class="hint">Writing to agents and reading their work.</div>` +
    pGroup('Message box', [
      prow('Send with', 'The other key combination adds a new line.', pSeg('sendKey', 'enter', [['enter', 'Enter'], ['ctrl', 'Ctrl+Enter']])),
      prow('Edit a queued message', 'Messages send right away. While the agent has not picked yours up yet, press ↑ in the empty message box to take it back and edit it.', '<kbd>↑</kbd>'),
    ]) +
    pGroup('Conversation', [
      prow('Show behind-the-scenes steps open', 'Assignments, reports and teammate chat are folded by default.', pSwitch('bgOpen', '0')),
      prow('Answer previews in the job list', 'The first line of each answer under its title.', pSwitch('previews', '1')),
    ]) +
    pGroup('New jobs', [
      prow('Default project', 'Pre-selected on the New job page.', pSelect('project', '', [['', 'Route automatically'], ...S.projects.map((x) => [x.name, x.name])])),
      prow('Default lead effort', 'How hard the lead thinks unless you choose otherwise.', pSelect('defaultEffort', '', [['', 'Auto (project default)'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']])),
    ]),
  agents: () => `<h2>Agents & teams</h2><div class="hint">The leads and their staff. Models, roles, instructions and routing live in Teams & roles.</div>` +
    pGroup('Commands and file edits', [
      prow('Where agents may edit files', 'On a job about a project, agents edit inside that project, their team library and scratch folders (~/…_test, /tmp); anything else they must ask you for first. Jobs with no project are not limited.',
        `<select data-office="editScope"><option value="0" ${(S.office || {}).editScope !== 'home' ? 'selected' : ''}>The job's project (ask for anything else)</option><option value="1" ${(S.office || {}).editScope === 'home' ? 'selected' : ''}>Anywhere in my home folder</option></select>`),
      prow('Run commands that worked before without asking', 'In "Ask me first" mode, a command that already succeeded in the same folder runs straight away; anything new still asks.',
        officeSelect('autoRunKnownCommands', [[1, 'Yes'], [0, 'No, always ask']])),
      prow('Agents may run commands', 'For agents that can edit files (leads and implementers): builds, tests, installs, running programs. You see every command and its output in the job and in the Terminal app. Commit, push, sudo, upgrades and rm -rf stay blocked.',
        `<div class="seg">${[['off', 'Off'], ['ask', 'Ask me first'], ['allow', 'Allow']].map(([v, l]) => `<button class="${(S.termMode || 'ask') === v ? 'on' : ''}" data-act="termMode" data-v="${v}">${l}</button>`).join('')}</div>`),
    ]) +
    pGroup('Plans, reminders and cost', [
      prow('Ask for a plan before work above', 'A lead shows you its plan first when it expects a job to cost more than this, or when it starts two or more teammates or an Opus teammate.',
        officeSelect('planOverUsd', [[2, '$2'], [5, '$5'], [8, '$8'], [15, '$15'], [30, '$30']])),
      prow('Approve plans automatically', 'Plans estimated under this go ahead without asking you. You still see them in the job.',
        officeSelect('autoApprovePlansUsd', [[0, 'Never'], [5, 'Under $5'], [10, 'Under $10'], [25, 'Under $25'], [50, 'Under $50'], [1000000, 'Always']])),
      prow('…only while 5-hour usage is below', 'So automatic plans never eat the end of your window.',
        officeSelect('autoApproveUsageMax', [[0, 'Any usage'], [0.3, '30%'], [0.5, '50%'], [0.7, '70%']])),
      prow('Compact long agent sessions at', 'When an agent\'s conversation reaches this size, Claude Code summarises it and carries on. Long sessions are re-read on every call, so this is the biggest saving on long jobs. Applies to agents started after the change.',
        officeSelect('autoCompactTokens', [[0, 'Claude Code default'], [100000, '100k tokens'], [150000, '150k tokens'], [200000, '200k tokens'], [300000, '300k tokens']])),
      prow('Remind leads to delegate at', 'When a lead\'s own conversation passes this size, it is told to hand the remaining long work to teammates with fresh contexts.',
        officeSelect('leadContextNudge', [[0, 'Never'], [80000, '80k tokens'], [100000, '100k tokens'], [150000, '150k tokens']])),
      prow('Remind me when something waits', 'A plan, question or command that waits this long gets a reminder (not between 22:00 and 08:00).',
        officeSelect('remindAfterMinutes', [[0, 'Never'], [30, 'After 30 minutes'], [60, 'After 1 hour'], [120, 'After 2 hours']])),
    ]) +
    pGroup('Leads', leads().map((k) => { const a = S.agents[k] || {}; return prow(`${esc(a.persona || k)} <span class="hint">· ${esc((S.roles[k] || {}).room || '')}</span>`, esc((S.roles[k] || {}).description || ''), `${modelChip(a)}`); })) +
    `<button class="btn pri" data-act="prefTeams">${ic('teams')} Open Teams & roles</button>`,
  keys: () => `<h2>Keyboard</h2><div class="hint">Shortcuts work everywhere except while you type in a box.</div>` +
    pGroup('Window', [`<table class="ktable">${[['Ctrl K', 'Search and run commands'], ['Ctrl N', 'New job'], ['Ctrl ,', 'Preferences'], ['Ctrl B', 'Show or hide the sidebar'], ['F10', 'Main menu'], ['Ctrl + / Ctrl − / Ctrl 0', 'Zoom in, out, actual size'], ['F11', 'Full screen'], ['Ctrl R', 'Reload'], ['Ctrl Q', 'Quit'], ['Esc', 'Close a menu or panel, deselect']].map(([k, d]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(d)}</td></tr>`).join('')}</table>`]) +
    pGroup('Apps', [`<table class="ktable">${APP_LIST.map((x) => `<tr><td><kbd>${esc(x.key.toUpperCase())}</kbd></td><td>${esc(x.name)}</td></tr>`).join('')}</table>`]) +
    pGroup('Lists and messages', [`<table class="ktable">${[['↑ ↓', 'Move through jobs or processes'], ['← →', 'Fold or unfold a process'], ['Enter', 'Send (or Ctrl Enter, see Jobs & chat)'], ['Shift Enter', 'New line in a message'], ['?', 'This page']].map(([k, d]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(d)}</td></tr>`).join('')}</table>`]),
  about: () => `<h2>About</h2><div class="about-hero" style="margin-top:14px"><img src="/icon.svg" alt=""><div><div style="font-size:18px;font-weight:700">Agentic OS</div><div class="hint">${esc(NATIVE_INFO.version || 'local build')} · runs on this computer with your Claude Code login</div></div></div>` +
    pGroup('', [
      prow('System health', S.health ? `Status: ${esc(S.health.level || 'unknown')}` : '', `<button class="btn" data-act="prefHealth">Open Health</button>`),
      NATIVE ? prow('Install folder', '~/agent-workplace', `<button class="btn" data-act="openPath" data-path="~/agent-workplace">${ic('folder-open')} Open</button>`) : '',
      NATIVE ? prow('Agents, jobs and logs', '~/agent-workplace/data', `<button class="btn" data-act="openPath" data-path="~/agent-workplace/data">${ic('folder-open')} Open</button>`) : '',
      NATIVE ? prow('Team libraries', '~/agent-workplace/teams', `<button class="btn" data-act="openPath" data-path="~/agent-workplace/teams">${ic('folder-open')} Open</button>`) : '',
    ]) + (NATIVE ? `<button class="btn" data-act="nativeAbout">${ic('info')} Credits and licence</button>` : ''),
};
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-pref]');
  if (!el) return;
  const key = el.dataset.pref;
  setPref(key, el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value);
  prefChanged(key);
});
document.addEventListener('change', (e) => {
  if (e.target.id !== 'autostartSw') return;
  NATIVE_INFO.autostart = e.target.checked;
  native('autostart', { on: e.target.checked });
});
document.addEventListener('input', (e) => {
  if (e.target.id !== 'zoomRange') return;
  $('#zoomOut').textContent = e.target.value + '%';
  e.target.style.setProperty('--fill', ((e.target.value - 70) / 90) * 100 + '%');
  zoomTo(Number(e.target.value) / 100);
});
function prefChanged(key) {
  applyPrefs();
  if (key === 'closeAction') native('prefs', { prefs: { closeAction: pref('closeAction', 'ask') } });
  if (key === 'notify' && !NATIVE && pref('notify', '0') === '1' && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  if (key === 'sound' && pref('sound', '0') === '1') chime('answer');
  S.jbodyKey = null; S.jviewFor = null;
  if (S.app === 'jobs') APPS.jobs.mount($('#appRoot'));
  dirty();
  renderPrefs();
}
setInterval(() => { if (!S.down) api('GET', '/api/restart').then((r) => { S.restart = r; dirty(); }).catch(() => {}); }, 30000);
Object.assign(ACT, {
  restartIdle: () => api('POST', '/api/restart', { when: 'idle' }).then((r) => { S.restart = r; dirty(); }),
  restartCancel: () => api('POST', '/api/restart', { when: 'cancel' }).then((r) => { S.restart = r; dirty(); }),
  reloadUi: () => location.reload(),
  wmin: () => native('minimize'), wmax: () => native('maximize'), wclose: () => native('close'),
  toggleSidebar: () => toggleSidebar(),
  appmenu: (d, ev) => { const b = ev.target.closest('button'); if ($('#menu').classList.contains('on') && S.menuAnchor === b) return closeMenu(); openMenu(appMenu(), { el: b, align: 'right' }); },
  prefs: (d) => openPrefs(d.sec),
  closePrefs: () => closePrefs(),
  prefSec: (d) => { S.prefSec = d.sec; renderPrefs(); },
  prefSeg: (d) => { setPref(d.k, d.v); prefChanged(d.k); },
  prefTeams: () => { closePrefs(); openApp('settings'); },
  prefHealth: () => { closePrefs(); openApp('health'); },
  nativeAbout: () => native('about'),
  openPath: (d) => native('openPath', { path: d.path }),
  ncenter: () => {
    const el = $('#ncenter');
    if (el.classList.contains('on')) return el.classList.remove('on');
    S.ncPrevSeen = S.notesSeen;
    S.notesSeen = Date.now(); setPref('notesSeen', String(S.notesSeen));
    renderNcenter(); el.classList.add('on'); dirty();
  },
  ncOpen: (d) => { const n = S.notes[Number(d.i)]; $('#ncenter').classList.remove('on'); if (n && n.ticketId && S.tickets[n.ticketId]) { S.job = n.ticketId; S.jtab = 'thread'; openApp('jobs'); } else if (n && n.kind === 'limit') openApp('usage'); else if (n && /proposes a skill/.test(n.title)) openApp('skills'); },
  ncClear: () => { S.notes = []; setPref('notes', '[]'); renderNcenter(); dirty(); },
  dnd: () => { setPref('dnd', pref('dnd', '0') === '1' ? '0' : '1'); renderNcenter(); dirty(); },
});
$('#prefs').addEventListener('mousedown', (e) => { if (e.target.id === 'prefs') closePrefs(); });

// Window-level keys: return true when handled.
function shellKeys(e) {
  const ctrl = e.ctrlKey || e.metaKey;
  if ($('#menu').classList.contains('on')) {
    const idx = menuItems.map((it, i) => (it.label && !it.disabled ? i : -1)).filter((i) => i >= 0);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const at = idx.indexOf(menuHot); hotMenu(idx[(at + (e.key === 'ArrowDown' ? 1 : idx.length - 1)) % idx.length] ?? idx[0]); return true; }
    if (e.key === 'Enter') { e.preventDefault(); runMenu(menuHot); return true; }
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); return true; }
  }
  if (e.key === 'Escape' && $('#prefs').classList.contains('on')) { e.preventDefault(); closePrefs(); return true; }
  if (e.key === 'Escape' && $('#ncenter').classList.contains('on')) { e.preventDefault(); $('#ncenter').classList.remove('on'); return true; }
  if (ctrl && e.key === ',') { e.preventDefault(); openPrefs(); return true; }
  if (ctrl && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleSidebar(); return true; }
  if (ctrl && e.key.toLowerCase() === 'n' && !e.shiftKey) { e.preventDefault(); openApp('newjob'); return true; }
  if (e.key === 'F10') { e.preventDefault(); const b = document.querySelector('[data-act="appmenu"]'); openMenu(appMenu(), { el: b, align: 'right' }); hotMenu(0); return true; }
  if (!NATIVE && ctrl && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomTo(S.zoom + 0.1); return true; }
  if (!NATIVE && ctrl && e.key === '-') { e.preventDefault(); zoomTo(S.zoom - 0.1); return true; }
  if (!NATIVE && ctrl && e.key === '0') { e.preventDefault(); zoomTo(1); return true; }
  return false;
}
if (!NATIVE) S.zoom = Number(pref('zoomCss', '1'));
native('prefs', { prefs: { closeAction: pref('closeAction', 'ask') } });

applyPrefs();
init().catch((e) => { document.body.innerHTML = `<div class="empty">Could not reach the Agentic OS server: ${esc(e.message)}. Start it with <code>./agentos</code>.</div>`; });
