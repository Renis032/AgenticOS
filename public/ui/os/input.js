'use strict';
// Notifications, tooltips, the launcher (Ctrl+K), keyboard shortcuts and click actions.
// ================================================================ files, notifications, tooltips
let pickTarget = null, pickDone = null;
async function uploadFile(file) {
  const r = await fetch('/api/uploads?name=' + encodeURIComponent(file.name || 'pasted.png'), { method: 'POST', body: file });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
async function addFiles(list, getTarget, done) { for (const f of list) { try { getTarget().push((await uploadFile(f)).path); } catch (e) { alert(`${f.name}: ${e.message}`); } } done(); }
function wireDrop(box, getTarget, done) {
  box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('drop'); });
  box.addEventListener('dragleave', () => box.classList.remove('drop'));
  box.addEventListener('drop', (e) => { e.preventDefault(); box.classList.remove('drop'); if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files], getTarget, done); });
  box.addEventListener('paste', (e) => { const fl = [...((e.clipboardData || {}).files || [])]; if (fl.length) { e.preventDefault(); addFiles(fl, getTarget, done); } });
}
$('#filePick').addEventListener('change', (e) => { const files = [...e.target.files]; e.target.value = ''; if (pickTarget) addFiles(files, pickTarget, pickDone); });
function chime(kind) {
  if (pref('sound', '0') !== '1' || pref('dnd', '0') === '1') return;
  try {
    const ac = chime.ac || (chime.ac = new (window.AudioContext || window.webkitAudioContext)());
    (kind === 'warn' || kind === 'limit' ? [660, 440] : kind === 'question' ? [523, 784] : [587, 880]).forEach((hz, i) => {
      const o = ac.createOscillator(), g = ac.createGain(), t0 = ac.currentTime + i * 0.16;
      o.frequency.value = hz; o.connect(g); g.connect(ac.destination);
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);
      o.start(t0); o.stop(t0 + 0.4);
    });
  } catch {}
}
function notify(kind, title, text, ticketId) {
  logNote(kind, title, text, ticketId);
  if (!noteWanted(kind)) return;
  chime(kind);
  if (NATIVE && pref('notify', '1') === '1') native('notify', { kind, title, body: short(text || '', 280), ticket: ticketId || null });
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span class="tic k-${esc(kind)}">${ic(NOTE_ICON[kind] || 'info')}</span><div><b>${esc(title)}</b><span class="hint">${esc(short(text || '', 150))}</span></div>`;
  el.onclick = () => { if (ticketId && S.tickets[ticketId]) { S.job = ticketId; openApp('jobs'); } else if (kind === 'limit') openApp('usage'); else if (/proposes a skill/.test(title)) openApp('skills'); el.remove(); };
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 200); }, Number(pref('toastSecs', '8')) * 1000);
  if (!NATIVE && pref('notify', '0') === '1' && 'Notification' in window && Notification.permission === 'granted' && document.hidden) {
    try { const n = new Notification(title, { body: short(text || '', 200), tag: ticketId || kind, icon: '/icon.svg' }); n.onclick = () => { window.focus(); if (ticketId) { S.job = ticketId; openApp('jobs'); } }; } catch {}
  }
}
let tipEl = null, tipTimer = null, tipXY = [0, 0];
document.addEventListener('mouseover', (ev) => { const t = ev.target.closest && ev.target.closest('[title]'); if (t && t.title) { t.dataset.tip = t.title; t.removeAttribute('title'); } }, true);
document.addEventListener('mousemove', (ev) => {
  tipXY = [ev.clientX, ev.clientY];
  const el = ev.target.closest && ev.target.closest('[data-tip]');
  if (el === tipEl) return;
  hideTip();
  tipEl = el;
  if (el) tipTimer = setTimeout(() => showTip(el), $('#tip').style.display === 'block' ? 0 : 550);
});
function showTip(el) {
  if (!document.body.contains(el) || !el.dataset.tip) return;
  const tip = $('#tip');
  tip.textContent = el.dataset.tip; tip.style.display = 'block';
  const [x, y] = tipXY;
  tip.style.left = Math.max(6, Math.min(innerWidth - tip.offsetWidth - 8, x + 2)) + 'px';
  tip.style.top = (y + 22 + tip.offsetHeight > innerHeight ? y - tip.offsetHeight - 10 : y + 22) + 'px';
}
function hideTip() { clearTimeout(tipTimer); tipEl = null; const tip = $('#tip'); if (tip) tip.style.display = 'none'; }
document.addEventListener('scroll', hideTip, true);
document.addEventListener('keydown', hideTip, true);

// ================================================================ launcher (Ctrl+K)
let palList = [], palSel = 0;
function palItems(q) {
  const items = APP_LIST.map((x) => ({ k: 'app', label: x.name, hint: `key ${x.key}`, run: () => openApp(x.id) }));
  for (const t of Object.values(S.tickets).sort((a, b) => b.createdAt - a.createdAt)) items.push({ k: 'job', label: `#${t.n} ${t.title}`, hint: stateLabel(t.status) + (t.archived ? ' · archived' : ''), run: () => { S.job = t.id; openApp('jobs'); } });
  for (const a of Object.values(S.agents)) items.push({ k: 'process', label: `${a.no || ''} ${a.persona} — ${a.id === S.root ? 'router' : a.name}`, hint: stateLabel(a.status), run: () => { S.sel = a.id; openApp('processes'); } });
  for (const k of leads()) {
    items.push({ k: 'action', label: `Weekly review — ${who(k)}`, hint: '', run: () => api('POST', `/api/agents/${k}/review`).then((r) => { if (r.id) { S.job = r.id; openApp('jobs'); } }) });
    items.push({ k: 'action', label: `Fresh session — ${who(k)}`, hint: 'saves memory first', run: () => api('POST', `/api/agents/${k}/refresh`) });
  }
  items.push({ k: 'action', label: 'Run self-test', hint: '', run: () => { openApp('health'); api('POST', '/api/selftest').catch((e) => alert(e.message)); } });
  items.push({ k: 'action', label: 'Keyboard shortcuts', hint: '?', run: () => openPrefs('keys') });
  for (const [sec, label] of PREF_SECTIONS) items.push({ k: 'settings', label: `Preferences: ${label}`, hint: 'Ctrl+,', run: () => openPrefs(sec) });
  items.push({ k: 'action', label: 'Toggle sidebar', hint: 'Ctrl+B', run: toggleSidebar });
  items.push({ k: 'action', label: 'Theme: system', hint: '', run: () => setTheme('system') }, { k: 'action', label: 'Theme: dark', hint: '', run: () => setTheme('dark') }, { k: 'action', label: 'Theme: light', hint: '', run: () => setTheme('light') });
  items.push({ k: 'action', label: 'Notifications', hint: '', run: () => ACT.ncenter() });
  if (NATIVE) items.push({ k: 'action', label: 'About Agentic OS', hint: '', run: () => native('about') }, { k: 'action', label: 'Full screen', hint: 'F11', run: () => native('fullscreen') });
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((it) => words.every((w) => (it.label + ' ' + it.k + ' ' + it.hint).toLowerCase().includes(w))).slice(0, 60);
}
function renderPal() {
  palList = palItems($('#palIn').value);
  palSel = Math.min(palSel, Math.max(0, palList.length - 1));
  $('#palItems').innerHTML = palList.map((it, i) => `<div class="it ${i === palSel ? 'on' : ''}" data-pi="${i}"><span class="k">${esc(it.k)}</span><span>${esc(short(it.label, 70))}</span><span class="hint">${esc(it.hint)}</span></div>`).join('') || '<div class="hint" style="padding:12px 16px">Nothing matches.</div>';
  const on = $('#palItems .it.on'); if (on) on.scrollIntoView({ block: 'nearest' });
}
function openPal() { $('#pal').classList.add('on'); $('#palIn').value = ''; palSel = 0; renderPal(); setTimeout(() => $('#palIn').focus(), 0); }
function closePal() { $('#pal').classList.remove('on'); }
function showKeys() {
  $('#pal').classList.add('on'); $('#palIn').value = '';
  $('#palItems').innerHTML = `<div style="padding:14px 18px;line-height:2">${[['Ctrl / ⌘ + K', 'launcher'], ['p · j · n · m · y · l · t · u · h · ,', 'open an app (see the dock)'], ['↑ ↓', 'move through processes or jobs'], ['← →', 'fold / unfold a process'], ['Enter', 'inspect'], ['Esc', 'close'], ['Ctrl + Enter', 'send'], ['?', 'this list']].map(([k, d]) => `<div><kbd>${k}</kbd> &nbsp; ${d}</div>`).join('')}</div>`;
  setTimeout(() => $('#palIn').focus(), 0);
}
$('#palIn').addEventListener('input', () => { palSel = 0; renderPal(); });
$('#palIn').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); palSel = Math.min(palList.length - 1, palSel + 1); renderPal(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); palSel = Math.max(0, palSel - 1); renderPal(); }
  else if (e.key === 'Enter') { e.preventDefault(); const it = palList[palSel]; closePal(); if (it) it.run(); }
  else if (e.key === 'Escape') { e.preventDefault(); closePal(); }
});
$('#pal').addEventListener('click', (e) => { const it = e.target.closest('[data-pi]'); if (it) { closePal(); palList[Number(it.dataset.pi)].run(); } else if (e.target.id === 'pal') closePal(); });
$('#quickIn').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.value.trim()) { S.quickText = e.target.value.trim(); e.target.value = ''; openApp('newjob'); } });

// ================================================================ keyboard
document.addEventListener('keydown', (e) => {
  if (shellKeys(e)) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#pal').classList.contains('on') ? closePal() : openPal(); return; }
  if (e.key === 'Escape') { if ($('#pal').classList.contains('on')) return closePal(); if (S.app === 'processes' && S.sel) { S.sel = null; writeHash(); return dirty(); } if (S.app === 'jobs' && S.job) { S.job = null; S.replay = null; writeHash(); return dirty(); } }
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '?') { e.preventDefault(); return openPrefs('keys'); }
  const app = APP_LIST.find((x) => x.key === e.key.toLowerCase());
  if (app) { e.preventDefault(); return openApp(app.id); }
  if (S.app === 'processes' && ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.key)) {
    e.preventDefault();
    const rows = procRows();
    let i = rows.findIndex((r) => r.a.id === S.sel);
    if (e.key === 'ArrowDown') i = Math.min(rows.length - 1, i + 1);
    else if (e.key === 'ArrowUp') i = Math.max(0, i - 1);
    else if (e.key === 'ArrowLeft' && S.sel) S.collapsed.add(S.sel);
    else if (e.key === 'ArrowRight' && S.sel) S.collapsed.delete(S.sel);
    if (rows[i]) S.sel = rows[i].a.id;
    writeHash(); APPS.processes.update();
    const on = $('#psBody tr.on'); if (on) on.scrollIntoView({ block: 'nearest' });
  }
  if (S.app === 'jobs' && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    const ids = [...document.querySelectorAll('#jlist .jl')].map((x) => x.dataset.id);
    let i = ids.indexOf(S.job);
    i = e.key === 'ArrowDown' ? Math.min(ids.length - 1, i + 1) : Math.max(0, i - 1);
    if (ids[i]) { S.job = ids[i]; S.replay = null; writeHash(); APPS.jobs.update(); }
  }
});

// ================================================================ actions (clicks)
const ACT = {
  armsTick: (d, ev) => api('POST', '/api/arms/tick', { id: d.id, done: ev.target.checked }),
  armsDiff: async () => { S.diffOpen = !S.diffOpen; if (S.diffOpen) { S.mapDiff = (await api('GET', '/api/arms/proposal/memory-map')).diff; } S.armsKey = null; APPS.arms.update(); },
  armsApprove: async (d) => {
    const msg = { 'memory-map': 'Replace ~/.claude/CLAUDE.md with the map and write the three router files? The current file is backed up first.', statusline: 'Set the Claude Code status line in ~/.claude/settings.json? It is backed up first.' }[d.id];
    if (msg && !confirm(msg)) return;
    const r = await api('POST', `/api/arms/approve/${d.id}`, { off: !!d.off });
    if (r.message) notify('answer', 'ARMS', r.message);
    S.armsData = null; S.armsKey = null; dirty();
  },
  armsSelftest: async () => { S.armsSelftest = 'Running in a throwaway copy…'; S.armsKey = null; dirty(); const r = await api('POST', '/api/arms/selftest'); S.armsSelftest = r.text; S.armsKey = null; dirty(); },
  jevToggle: (d, ev) => api('POST', '/api/arms/settings', { jev: ev.target.checked }).then(() => { S.armsData = null; dirty(); }),
  cacheRefresh: () => api('POST', '/api/arms/cache/refresh').then(() => { S.armsData = null; S.armsKey = null; dirty(); }),
  imgScan: async () => { S.imgs = await api('GET', '/api/arms/images'); S.armsKey = null; APPS.arms.update(); },
  caption: (d) => { if (confirm(`Caption the images in
${d.dir}?
A teammate on the cheapest model writes CAPTIONS.md there.`)) api('POST', '/api/arms/captions', { dir: d.dir }).then((r) => { S.job = r.id; openApp('jobs'); }); },
  skSel: (d) => { S.skill = d.id; S.spSel = null; S.skNew = null; S.teachP = null; S.skKey = null; APPS.skills.update(); },
  spSel: (d) => { S.spSel = d.id; S.skKey = null; APPS.skills.update(); },
  spDecide: async (d) => { const r = await api('POST', `/api/skill-proposals/${d.id}/decide`, { decision: d.d, note: ($('#spNote') || {}).value || '' }); if (r.error) return alert(r.error); S.skProps = null; S.skillsData = null; S.skKey = null; APPS.skills.update(); },
  openJobN: (d) => { const t = Object.values(S.tickets).find((x) => x.n === Number(d.n)); if (t) { S.job = t.id; openApp('jobs'); } },
  skNew: (d) => { S.skNew = d.k || null; S.skKey = null; APPS.skills.update(); },
  skRescan: () => api('GET', '/api/arms/skills?fresh=1').then((r) => { S.skillsData = r; S.skKey = null; APPS.skills.update(); }),
  skCreate: async (d) => {
    const v = (id) => ($('#' + id) || {}).value || '';
    const r = d.k === 'database' ? await api('POST', '/api/arms/skills-new/database', { name: v('ndb_name'), holds: v('ndb_holds'), principles: v('ndb_principles'), examples: v('ndb_examples') })
      : await api('POST', '/api/arms/skills-new/artifact', { brand: v('nar_brand'), colors: v('nar_colors'), font: v('nar_font'), logo: v('nar_logo') });
    notify('answer', 'Skill created', r.dir); S.skNew = null; S.skillsData = null; dirty();
  },
  skRun: async () => { const r = await api('POST', `/api/arms/skills/${S.skill || S.skillsData.skills[0].name}/run`, { args: $('#skArgs').value, model: $('#skModel').value || undefined, effort: $('#skEffort').value || undefined, edit: $('#skEdit').checked }); notify('answer', 'Skill started', `${r.model}/${r.effort} — ${r.choice}`); },
  skButton: () => api('POST', `/api/arms/skills/${S.skill || S.skillsData.skills[0].name}/button`, { args: $('#skArgs').value, model: $('#skModel').value, effort: $('#skEffort').value, edit: $('#skEdit').checked }).then(() => { S.skillsData = null; dirty(); }),
  skButtonDel: () => api('POST', `/api/arms/skills/${S.skill || S.skillsData.skills[0].name}/button`, { remove: true }).then(() => { S.skillsData = null; dirty(); }),
  skPin: () => api('POST', `/api/arms/skills/${S.skill || S.skillsData.skills[0].name}/pin`, { model: $('#skPin').value || null }).then(() => { S.skillsData = null; dirty(); }),
  skTeach: async () => { const fb = $('#skFeedback').value.trim(); if (!fb) return; $('#skTeachMsg').textContent = 'Thinking… (about a minute)'; try { S.teachP = await api('POST', `/api/arms/skills/${S.skill || S.skillsData.skills[0].name}/teach`, { feedback: fb }); S.skKey = null; APPS.skills.update(); } catch (e) { $('#skTeachMsg').textContent = e.message; } },
  skApply: () => api('POST', `/api/arms/teach/${S.teachP.id}/apply`).then(() => { notify('answer', 'Skill improved', S.teachP.principle); S.teachP = null; S.skillsData = null; dirty(); }),
  skDiscard: () => { S.teachP = null; S.skKey = null; APPS.skills.update(); },
  rtNew: () => { S.rtEdit = 'new'; S.rtKey = null; APPS.routines.update(); },
  rtEdit: (d) => { S.rtEdit = d.id; S.rtKey = null; APPS.routines.update(); },
  rtCancel: () => { S.rtEdit = null; S.rtKey = null; APPS.routines.update(); },
  rtSave: async () => {
    const v = (id) => $('#' + id).value;
    const type = v('rt_type');
    const schedule = type === 'hourly' ? { type, every: Number(v('rt_every')) || 4 } : type === 'daily' ? { type, at: v('rt_at') || '09:00' } : { type, day: Number(v('rt_day')), at: v('rt_at') || '09:00' };
    await api('POST', '/api/arms/routines', { id: S.rtEdit === 'new' ? undefined : S.rtEdit, name: v('rt_name'), prompt: v('rt_prompt'), mode: v('rt_mode'), schedule, project: v('rt_project') || null, capUsdWeek: v('rt_cap') || null });
    S.rtEdit = null; S.routinesData = null; dirty();
  },
  rtRun: (d) => api('POST', `/api/arms/routines/${d.id}/run`).then((r) => { if (r.id) { S.job = r.id; openApp('jobs'); } }),
  rtOpt: (d) => api('POST', `/api/arms/routines/${d.id}/optimise`).then((r) => { S.job = r.id; openApp('jobs'); }),
  rtToggle: (d) => { const r = S.routinesData.routines.find((x) => x.id === d.id); return api('POST', '/api/arms/routines', { id: d.id, enabled: !r.enabled }).then(() => { S.routinesData = null; dirty(); }); },
  rtDel: (d) => { if (confirm('Delete this routine?')) api('DELETE', `/api/arms/routines/${d.id}`).then(() => { S.routinesData = null; dirty(); }); },
  rcRefresh: () => api('POST', '/api/arms/recos/refresh').then((r) => { S.recosData = r; S.rcKey = null; APPS.recos.update(); }),
  cart: (d, ev) => { ev.target.checked ? S.cart.add(d.id) : S.cart.delete(d.id); S.rcKey = null; APPS.recos.update(); },
  cartCopy: () => { const cards = S.recosData.cards.filter((c) => S.cart.has(c.id)); const text = 'Set up these for me:\n' + cards.map((c) => `- ${c.kind === 'routine' ? `Routine “${c.routine.name}” (${c.routine.mode}, ${c.when}): ${c.routine.prompt}` : c.fix}`).join('\n'); navigator.clipboard.writeText(text).then(() => notify('answer', 'Cart copied', `${cards.length} item(s)`)); },
  cartSetup: () => api('POST', '/api/arms/recos/setup', { ids: [...S.cart] }).then((r) => { notify('answer', 'Set up', r.done.join(', ')); S.cart.clear(); S.recosData = null; S.routinesData = null; dirty(); }),
  app: (d) => openApp(d.app),
  palette: () => openPal(),
  bell: async () => { const on = pref('notify', '0') !== '1'; if (on && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission().catch(() => {}); setPref('notify', on ? '1' : '0'); renderChrome(); notify('answer', on ? 'Desktop notifications on' : 'Desktop notifications off', on ? 'You get one when a job is answered, an agent asks you something, or a budget or limit is reached (while the window is in the background).' : ''); },
  sound: () => { setPref('sound', pref('sound', '0') === '1' ? '0' : '1'); renderChrome(); chime('answer'); },
  limContinue: () => api('POST', '/api/limits/continue').then((r) => { S.limits = r; dirty(); }),
  limWait: () => { S.alertDismissed = $('#alert').dataset.key; dirty(); },
  limRefresh: () => api('POST', '/api/limits/refresh').then((r) => { S.limits = r; S.usKey = null; dirty(); }),
  sel: (d, ev) => { if (ev.target.closest('[data-act="fold"],[data-act="openJob"]')) return; S.sel = d.id; S.itab = S.itab || 'mind'; writeHash(); if (S.app !== 'processes') openApp('processes'); else APPS.processes.update(); },
  sel2: (d) => { S.sel = d.id; openApp('processes'); },
  unsel: () => { S.sel = null; writeHash(); APPS.processes.update(); },
  fold: (d) => { S.collapsed.has(d.id) ? S.collapsed.delete(d.id) : S.collapsed.add(d.id); APPS.processes.update(); },
  expandAll: () => { S.collapsed.clear(); APPS.processes.update(); },
  itab: (d) => { S.itab = d.tab; S.itabKey = null; renderInspector(); },
  staffScope: (d) => api('POST', `/api/agents/${S.sel}/scope`, { team: !!d.team }),
  kill: () => { const a = S.agents[S.sel]; if (confirm(`Stop ${a.persona} (PID ${a.no}) and its children?`)) api('POST', `/api/agents/${a.id}/stop`); },
  fresh: () => { const a = S.agents[S.sel]; if (confirm(`${a.persona} saves what matters to memory, then starts a fresh session. Continue?`)) api('POST', `/api/agents/${a.id}/refresh`); },
  review: () => api('POST', `/api/agents/${S.sel}/review`).then((r) => { if (r.id) { S.job = r.id; openApp('jobs'); } }),
  reset: () => { const a = S.agents[S.sel]; if (confirm(`Restart ${a.persona} with a new session, without saving to memory first?`)) api('POST', `/api/agents/${a.id}/reset`); },
  message: async () => { const text = $('#inspText').value.trim(); if (!text) return; const r = await api('POST', `/api/agents/${S.sel}/message`, { text }); $('#inspText').value = ''; if (r.ticketId) { S.job = r.ticketId; const w = () => (S.tickets[r.ticketId] ? openApp('jobs') : setTimeout(w, 150)); w(); } },
  feedback: async () => { const text = $('#inspText').value.trim(); if (!text) return; await api('POST', `/api/agents/${S.sel}/feedback`, { text }); $('#inspText').value = ''; notify('answer', 'Feedback saved', `${who(S.sel)} gets it at the start of their next task.`); },
  followup: async () => { const text = $('#inspText').value.trim(); if (!text) return; await api('POST', `/api/agents/${S.sel}/message`, { text }); $('#inspText').value = ''; },
  openJob: (d) => { S.job = d.id; S.jtab = S.jtab || 'thread'; S.replay = null; openApp('jobs'); },
  toggleArch: () => { S.showArchived = !S.showArchived; APPS.jobs.update(); },
  jtab: (d) => { S.jtab = d.tab; S.jbodyKey = null; writeHash(); renderJob(); },
  pause: () => api('POST', `/api/tickets/${S.job}/pause`),
  resume: () => api('POST', `/api/tickets/${S.job}/resume`),
  stop: () => { if (confirm('Stop this job and everything running for it?')) api('POST', `/api/tickets/${S.job}/stop`); },
  archive: () => api('POST', `/api/tickets/${S.job}/archive`, { archived: !S.tickets[S.job].archived }),
  delJob: () => { if (confirm('Delete this job? Staff stay; its history goes.')) api('DELETE', `/api/tickets/${S.job}`); },
  budget: (d) => api('POST', `/api/tickets/${S.job}/budget`, { add: Number(d.add) }),
  startNow: () => api('POST', `/api/tickets/${S.job}/start`),
  plan: (d) => api('POST', `/api/tickets/${S.job}/plan`, { decision: d.d, note: ($('#planNote') || {}).value || '' }),
  qopt: (d) => api('POST', `/api/tickets/${S.job}/message`, { text: d.v }),
  rate: (d) => { S.rerate = false; api('POST', `/api/tickets/${S.job}/rate`, { score: Number(d.s), note: ($('#rateNote') || {}).value || '' }); },
  rerate: () => { S.rerate = true; S.jbodyKey = null; renderJob(); },
  revert: (d) => { const one = d.path; if (confirm(one ? `Undo the agents' changes to\n${one}?` : 'Undo every file change made on this job?')) api('POST', `/api/tickets/${S.job}/revert`, { path: one || undefined }).then(() => { S.jbodyKey = null; dirty(); }); },
  jobSend: () => {
    const text = $('#jtext').value.trim();
    if (!text) return;
    if (S.pendingSend) flushSend();
    const id = S.job;
    const delay = 0;
    S.pendingSend = { id, text, files: S.followFiles, at: Date.now(), secs: delay, timer: setTimeout(flushSend, delay * 1000) };
    $('#jtext').value = ''; delete S.compose[id]; setPref('compose', JSON.stringify(S.compose)); S.followFiles = []; $('#jfiles').innerHTML = '';
    if (!delay) flushSend(); else showSendBar();
  },
  undoSend: () => {
    const p = S.pendingSend;
    if (!p) return;
    clearTimeout(p.timer); S.pendingSend = null;
    if (S.job === p.id && $('#jtext')) { $('#jtext').value = p.text; S.followFiles = p.files; $('#jfiles').innerHTML = p.files.map((f) => fileChip(f, true)).join(''); $('#jtext').focus(); }
    S.compose[p.id] = p.text; setPref('compose', JSON.stringify(S.compose));
    showSendBar();
  },
  sendNow: () => flushSend(),
  recallMsg: async () => {
    const t = S.tickets[S.job];
    if (!t) return;
    if (!queuedFid(t)) { const h = $('#jhint'); if (h) { h.dataset.old = h.textContent; h.textContent = 'Nothing to edit: your last message was already delivered.'; setTimeout(() => { if (h.dataset.old) h.textContent = h.dataset.old; }, 2500); } return; }
    const r = await api('POST', `/api/tickets/${t.id}/recall`);
    if (r.error) return notifyQuiet(r.error);
    const box = $('#jtext');
    if (!box) return;
    box.value = r.text + (box.value ? '\n' + box.value : '');
    S.followFiles = r.attachments || [];
    $('#jfiles').innerHTML = S.followFiles.map((f) => fileChip(f, true)).join('');
    box.focus(); box.setSelectionRange(box.value.length, box.value.length);
    S.compose[t.id] = box.value; setPref('compose', JSON.stringify(S.compose));
  },
  copyCode: (d, ev) => {
    const btn = ev.target.closest('.copy');
    const text = btn.parentElement.querySelector('pre').textContent;
    const done = () => { btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 1200); };
    const fallback = () => { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch {} ta.remove(); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
  },
  openFile: (d) => api('POST', '/api/open-file', { path: d.p, ticketId: S.app === 'jobs' ? S.job || undefined : undefined }).then((r) => { if (r.error) notify('warn', 'Could not open the file', r.error); }),
  planOpen: () => { S.planOpen = !S.planOpen; updateJobLive(); },
  boardRefresh: () => loadBoard(true).then(() => APPS.projects.update()),
  boardOpen: (d) => { S.boardOpen = S.boardOpen === d.name ? null : d.name; APPS.projects.update(); },
  boardContinue: async (d) => {
    const r = await api('POST', '/api/tasks', { text: `Continue ${d.name} where we left off.`, project: boardProject(d.lead) });
    S.boardAt = 0; S.job = r.id; S.jtab = 'thread';
    const wait = () => (S.tickets[r.id] ? openApp('jobs') : setTimeout(wait, 150));
    wait();
  },
  chipContinue: (d) => {
    const txt = $('#njText'); const sel = $('#njProject');
    txt.value = `Continue ${d.name} where we left off. ${txt.value.trim()}`.trim() + ' ';
    const proj = boardProject(d.lead);
    if (proj && sel) { sel.value = proj; setPref('project', proj); }
    txt.focus(); txt.setSelectionRange(txt.value.length, txt.value.length);
    routePreview();
  },
  wrapUp: () => api('POST', `/api/tickets/${S.job}/message`, { text: 'Wrap up: save the project handoff for what we did (current state, this session, next steps), then give me a short summary.' }),
  retry: () => { const t = S.tickets[S.job]; return api('POST', `/api/tickets/${t.id}/message`, { text: t.status === 'failed' ? `Please try again. The last attempt failed with: ${short(String(t.answer || '').replace(/\s+/g, ' '), 400)}` : 'Please try again: the last attempt was interrupted before you finished. Pick up where you stopped.' }); },
  stopAgent: (d) => { const a = S.agents[d.id]; if (a && confirm(`Stop ${a.persona}? Their lead is told and carries on without them.`)) return api('POST', `/api/agents/${a.id}/stop`); },
  bgGroup: (d, ev) => { const el = ev.target.closest('details'); if (el) el.open = !el.open; if (S.openGroups.has(d.k)) S.openGroups.delete(d.k); else S.openGroups.add(d.k); },
  handoff: (d) => { S.handoffOpen = S.handoffOpen === d.k ? null : d.k; dirty(); },
  attachJob: () => { pickTarget = () => S.followFiles; pickDone = () => { $('#jfiles').innerHTML = S.followFiles.map((p) => fileChip(p, true)).join(''); }; $('#filePick').click(); },
  attachNew: () => { pickTarget = () => S.newFiles; pickDone = () => { $('#njFiles').innerHTML = S.newFiles.map((p) => fileChip(p, true)).join(''); }; $('#filePick').click(); },
  unfile: (d) => { S.newFiles = S.newFiles.filter((x) => x !== d.path); S.followFiles = S.followFiles.filter((x) => x !== d.path); if ($('#njFiles')) $('#njFiles').innerHTML = S.newFiles.map((p) => fileChip(p, true)).join(''); if ($('#jfiles')) $('#jfiles').innerHTML = S.followFiles.map((p) => fileChip(p, true)).join(''); },
  sendJob: () => sendNewJob(),
  replay: () => { const tl = S.timeline[S.job] && S.timeline[S.job].data; if (!tl) return; S.replay = { job: S.job, t: tl.start, t0: tl.start, t1: tl.end || Date.now(), speed: 30, playing: true }; S.jbodyKey = null; renderJob(); },
  rpPlay: () => { const R = S.replay; if (R.t >= R.t1) R.t = R.t0; R.playing = !R.playing; S.jbodyKey = null; renderJob(); },
  rpExit: () => { S.replay = null; S.jbodyKey = null; renderJob(); },
  chatTeam: (d) => { S.chatTeam = d.id; S.chat = null; S.chatKey = null; APPS.messages.update(); },
  askTeam: async () => { const text = $('#mtText').value.trim(); if (!text) return; const r = await api('POST', `/api/teams/${S.chatTeam}/ask`, { text }); $('#mtText').value = ''; if (r.id) { S.job = r.id; const w = () => (S.tickets[r.id] ? openApp('jobs') : setTimeout(w, 150)); w(); } },
  memSel: (d) => { S.memAgent = d.id; S.memKey = null; APPS.memory.update(); },
  libPage: (d) => { S.libTeam = d.team; S.libPage = d.path; APPS.library.update(); },
  libCheck: async () => { const r = await api('GET', `/api/teams/${S.libTeam}/check`).catch((e) => ({ text: e.message })); S.libCheck = { team: S.libTeam, text: r.text, at: Date.now() }; APPS.library.update(); },
  libTidy: () => api('POST', `/api/teams/${S.libTeam}/tidy`).then((r) => notify('answer', 'Library', r.message || 'Tidy-up queued.')).catch((e) => alert(e.message)),
  healthRefresh: () => { S.hKey = null; refreshHealth(); },
  selftest: () => { S.selftest = { status: 'running', steps: [], startedAt: Date.now() }; S.hKey = null; dirty(); api('POST', '/api/selftest').catch((e) => alert(e.message)); },
  saveRole: (d, ev) => api('POST', '/api/config/role', { key: d.key, team: d.team, model: $('#m_' + d.key).value || undefined, effort: $('#e_' + d.key).value || undefined, prompt: $('#p_' + d.key) ? $('#p_' + d.key).value : undefined }).then(() => { ev.target.textContent = 'Saved ✓'; setTimeout(() => { S.cfg = null; dirty(); }, 700); }).catch((e) => alert(e.message)),
  delRole: (d) => { if (confirm('Remove this role? Staff already hired keep working.')) api('DELETE', `/api/config/role/${d.key}`).then(() => { S.cfg = null; dirty(); }).catch((e) => alert(e.message)); },
  addRole: (d) => { const v = (n) => $(`#nr_${n}_${d.team}`).value; api('POST', '/api/config/role', { team: d.team, name: v('name'), access: v('access'), model: v('model'), effort: v('effort'), description: v('desc'), prompt: v('prompt') }).then(() => { S.cfg = null; dirty(); }).catch((e) => alert(e.message)); },
  addTeam: () => { const v = (n) => $('#nt_' + n).value; api('POST', '/api/config/team', { persona: v('persona'), room: v('room'), cwd: v('cwd'), access: v('access'), description: v('desc') }).then(() => { S.cfg = null; dirty(); }).catch((e) => alert(e.message)); },
  addProj: () => { S.cfg.projects.push({ name: '', path: '', department: S.cfg.residents.find((k) => k !== S.cfg.root), description: '' }); S.cfgKey = null; dirty(); },
  delProj: (d) => { S.cfg.projects.splice(Number(d.i), 1); S.cfgKey = null; dirty(); },
  saveProj: () => { const list = S.cfg.projects.map((p, i) => ({ ...p, name: $('#pj_name_' + i).value.trim(), path: $('#pj_path_' + i).value.trim(), department: $('#pj_dep_' + i).value, description: $('#pj_desc_' + i).value.trim(), leadEffort: $('#pj_eff_' + i).value || undefined, keywords: $('#pj_kw_' + i).value.split(',').map((x) => x.trim()).filter(Boolean) })).filter((p) => p.name && p.path); api('PUT', '/api/projects', list).then(async () => { const st = await api('GET', '/api/state'); S.projects = st.projects; S.cfg = null; dirty(); notify('answer', 'Projects saved', ''); }).catch((e) => alert(e.message)); },
};
document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const f = ACT[el.dataset.act];
  if (!f) return;
  if (el.tagName !== 'INPUT') ev.preventDefault();
  try { const r = f(el.dataset, ev); if (r && r.catch) r.catch((e) => alert(e.message)); } catch (e) { alert(e.message); }
});
