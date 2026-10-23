'use strict';
// The Jobs app: the job list, the conversation, banners, changes and timeline.
// ================================================================ app: Jobs
APPS.jobs = {
  mount(root) {
    root.innerHTML = `<div class="app"><div class="split jobs" id="jobsWrap"><div class="joblist">
        <div class="toolbar"><input class="in" id="jq" placeholder="Search jobs…" value="${esc(S.jq)}" style="flex:1"><button class="btn pri sm" data-act="app" data-app="newjob">+ New</button></div>
        <div class="scroll" style="flex:1" id="jlist"></div>
        <div class="toolbar" style="border-top:1px solid var(--line);border-bottom:0"><span class="hint" id="jcount"></span><span class="sp"></span><a id="jarch" data-act="toggleArch"></a></div></div>
      <section class="jview" id="jview"></section></div></div>`;
    $('#jq').oninput = (e) => { S.jq = e.target.value; APPS.jobs.update(); };
    S.jviewFor = null;
  },
  update() {
    const q = S.jq.toLowerCase().split(/\s+/).filter(Boolean);
    const all = Object.values(S.tickets).sort((a, b) => needsYou(b) - needsYou(a) || b.createdAt - a.createdAt);
    const arch = all.filter((t) => t.archived).length;
    const list = all.filter((t) => (S.showArchived || !t.archived || t.id === S.job) && q.every((w) => [t.title, t.text, t.answer || '', '#' + t.n, t.project || ''].join(' ').toLowerCase().includes(w)));
    $('#jcount').textContent = `${list.length} job${list.length === 1 ? '' : 's'}`;
    $('#jarch').textContent = arch ? (S.showArchived ? 'hide archived' : `show archived (${arch})`) : '';
    $('#jlist').innerHTML = list.map((t) => {
      const people = [...new Set([t.direct, ...t.assignees].filter((k) => k && k !== S.root))].map((k) => S.agents[k]).filter(Boolean);
      const team = Object.values(S.agents).filter((a) => (a.tickets || []).includes(t.id)).length;
      const unread = isUnread(t);
      return `<div class="jl ${S.job === t.id ? 'on' : ''} ${unread ? 'unread' : ''}" data-act="openJob" data-id="${t.id}"><div class="t1">${unread ? '<span class="newdot" title="New reply"></span>' : ''}<span class="n">#${t.n}</span><span class="t">${esc(t.title)}</span>${jobPill(t)}</div>
        <div class="meta">${t.waiting ? '<span class="pill s-paused">needs your answer</span>' : ''}${t.plan && t.plan.status === 'pending' ? '<span class="pill s-delegating">plan needs OK</span>' : ''}${t.overBudget && t.status === 'open' ? '<span class="pill s-paused">budget stop</span>' : ''}${t.status === 'scheduled' ? `starts ${whenAt(t.scheduledFor)} · ` : ''}${people.map((a) => esc(a.persona)).join(', ') || 'routing'}${team ? ` +${team}` : ''} · ${money(t.costUsd)}${(t.changes || []).length ? ` · ${t.changes.length} file${t.changes.length === 1 ? '' : 's'}` : ''} · ${ago(t.createdAt)}${t.rating ? (t.rating.score > 0 ? ' · 👍' : ' · 👎') : ''}</div>${t.answer && t.status !== 'open' && pref('previews', '1') === '1' ? `<div class="prev">${esc(short(plainText(t.answer), 140))}</div>` : ''}</div>`;
    }).join('') || '<div class="empty">No jobs.</div>';
    $('#jobsWrap').classList.toggle('withjob', !!S.job);
    renderJob();
  },
};
function jobTree(t) {
  const nodes = new Map();
  const add = (id, parent, why, at, choice) => { if (!S.agents[id] || nodes.has(id)) return; nodes.set(id, { id, parent, why, at, choice, kids: [] }); };
  const assign = t.thread.filter((e) => e.kind === 'assign');
  const top = assign.length ? S.root : t.direct || t.assignees[0];
  if (!top) return null;
  add(top, null, assign.length ? 'routed the job' : 'owns the job', t.createdAt);
  for (const e of t.thread) {
    if (e.kind === 'assign') add(e.to, e.from, 'assigned by God', e.t);
    if (e.kind === 'team') for (const k of e.agents || []) add(k, e.from, (String(e.text || '').split('\n').find((l) => l.includes(S.agents[k] ? S.agents[k].persona : '\u0000')) || '').replace(/^[^—]*—\s*/, '').replace(/ · \w+\/\w+$/, ''), e.t, ((e.choices || []).find((c) => c.id === k) || {}).why);
  }
  if (!assign.length && t.direct) for (const k of t.assignees) add(k, t.direct, '', t.createdAt);
  for (const a of Object.values(S.agents)) if ((a.tickets || []).includes(t.id) && !nodes.has(a.id)) add(a.id, nodes.has(a.parentId) ? a.parentId : top, '', t.createdAt);
  for (const n of nodes.values()) if (n.parent && nodes.has(n.parent)) nodes.get(n.parent).kids.push(n);
  return nodes.get(top);
}
function nodeState(t, id) {
  const a = S.agents[id];
  if (!a) return 'idle';
  if ((agentJob(a) || {}).id === t.id) return a.resident && a.current ? 'running' : a.status;
  if (a.resident) return t.status === 'open' && t.pending.includes(id) ? 'queued' : ['done', 'failed', 'stopped', 'interrupted', 'paused'].includes(t.status) ? (t.status === 'paused' ? 'paused' : 'done') : 'done';
  const h = (a.history || []).filter((x) => x.ticketId === t.id).pop();
  return h ? (h.outcome === 'done' ? 'done' : h.outcome) : 'idle';
}
function jobTreeHtml(t, tl, at) {
  const rootN = jobTree(t);
  if (!rootN) return '<div class="empty">Nobody has picked this job up yet.</div>';
  const costs = {}; const spansOf = {};
  for (const r of (tl && tl.rows) || []) { costs[r.id] = r.spans.reduce((x, y) => x + y.costUsd, 0); spansOf[r.id] = r.spans; }
  const out = [];
  const walk = (n, prefix, last, depth) => {
    const a = S.agents[n.id];
    const hot = at && (spansOf[n.id] || []).some((sp) => sp.start <= at && (sp.end || Date.now()) >= at);
    const st = at ? (hot ? 'running' : (spansOf[n.id] || []).some((sp) => (sp.end || Infinity) < at) ? 'done' : 'queued') : nodeState(t, n.id);
    out.push(`<div class="nd ${hot ? 'hot' : ''}" data-act="sel2" data-id="${n.id}"><span class="tree">${esc(depth ? prefix + (last ? '└─ ' : '├─ ') : '')}</span><span class="hint mono">${a.no || ''}</span><b>${esc(a.persona)}</b><span class="hint">${esc(a.id === S.root ? 'router' : a.name)}</span><span ${n.choice ? `data-tip="${esc(n.choice)}"` : ''}>${modelChip(a)}</span>${pill(st)}<span class="why">${esc(n.why || '')}</span><span class="num">${costs[n.id] != null ? money(costs[n.id]) : ''}</span></div>`);
    n.kids.forEach((k, i) => walk(k, depth ? prefix + (last ? '   ' : '│  ') : '', i === n.kids.length - 1, depth + 1));
  };
  walk(rootN, '', true, 0);
  return `<div class="jtree">${out.join('')}</div>`;
}
function fileUrl(p) { return '/api/uploads/' + p.split('/uploads/')[1].split('/').map(encodeURIComponent).join('/'); }
const isImg = (p) => /\.(png|jpe?g|gif|webp)$/i.test(p);
function fileChip(p, removable) { return `<span class="file">${isImg(p) ? `<img src="${fileUrl(p)}" alt="">` : '📄'}<a href="${fileUrl(p)}" target="_blank" rel="noopener">${esc(p.split('/').pop())}</a>${removable ? `<span class="x" data-act="unfile" data-path="${esc(p)}">✕</span>` : ''}</span>`; }
// What you and the leads say stays in view; the work between (assignments, reports, teammates talking, system notes) folds into one line.
const FOREGROUND = ['user', 'followup', 'answer', 'question', 'reply', 'plan', 'plandecision', 'rating', 'command', 'access'];
function threadHtml(t, upTo) {
  const out = [];
  let grp = [];
  const flush = () => {
    if (!grp.length) return;
    const k = `${t.id}:${grp[0].t}`;
    const people = [...new Set(grp.map((e) => e.from).filter((f) => f && !['system', 'user', 'script'].includes(f)))].map(who);
    const span = grp[grp.length - 1].t - grp[0].t;
    out.push(`<details class="bg" ${(pref('bgOpen', '0') === '1') !== S.openGroups.has(k) ? 'open' : ''}><summary data-act="bgGroup" data-k="${esc(k)}">Behind the scenes · ${grp.length} step${grp.length === 1 ? '' : 's'}${people.length ? ` · ${esc(people.join(', '))}` : ''}${span >= 1000 ? ` · ${dur(span)}` : ''}</summary>${entryHtml(grp, t)}</details>`);
    grp = [];
  };
  for (const e of t.thread.filter((x) => !upTo || x.t <= upTo)) {
    if (FOREGROUND.includes(e.kind)) { flush(); out.push(entryHtml([e], t)); } else grp.push(e);
  }
  flush();
  return out.join('');
}
const CMD_STATE = { pending: 'waiting for your OK', running: 'running', done: 'done', failed: 'failed', denied: 'not run', stopped: 'stopped', 'timed out': 'timed out' };
function commandHtml(e, t) {
  const c = ((t && t.commands) || []).find((x) => x.id === e.cid) || { status: 'denied', command: e.text };
  const out = c.status === 'running' ? S.cmdLive[c.id] || '' : c.output || '';
  const took = c.endedAt && c.startedAt ? ` · ${dur(c.endedAt - c.startedAt)}` : '';
  return `<div class="ev cmd st-${esc(c.status.replace(' ', '-'))}"><div class="h">${esc(who(e.from))} · terminal · <span class="cst">${esc(CMD_STATE[c.status] || c.status)}${c.exitCode != null && c.status !== 'done' ? ` (exit ${c.exitCode})` : ''}${took}</span><span class="ts">${clock(e.t)}</span></div>
    <div class="cmdline"><span class="pr">$</span><code>${esc(c.command)}</code><button class="copy" data-act="copyCmd" data-cid="${esc(c.id || '')}" title="Copy the command">Copy</button></div>
    <div class="hint">in ${esc(String(c.cwd || '').replace(/^\/home\/[^/]+/, '~'))}${c.reason ? ` · ${esc(c.reason)}` : ''}${c.known ? ' · ran without asking: it worked before in this folder' : ''}${c.note ? ` · you said: “${esc(c.note)}”` : ''}</div>
    ${c.status === 'pending' ? `<div class="row"><button class="btn pri sm" data-act="cmdRun" data-cid="${c.id}">Run</button><button class="btn sm" data-act="cmdAll" data-cid="${c.id}" title="Run this and every later command on this job without asking">Run all on this job</button><button class="btn sm danger" data-act="cmdDeny" data-cid="${c.id}">Don't run</button></div>` : ''}
    ${c.status === 'running' ? `<div class="row"><span class="dots"><i></i><i></i><i></i></span><button class="btn sm danger" data-act="cmdStop" data-cid="${c.id}">Stop</button></div>` : ''}
    ${out || c.status === 'running' ? `<pre class="cmdout" id="cmdo-${c.id}">${esc(out)}</pre>` : ''}</div>`;
}
function entryHtml(list, t) {
  return list.map((e) => {
    const ts = `<span class="ts">${clock(e.t)}</span>`;
    if (e.kind === 'command') return commandHtml(e, t);
    if (e.kind === 'access') {
      const r = ((t && t.access) || []).find((x) => x.id === e.aid) || { status: 'denied', folder: e.text };
      return `<div class="ev cmd st-${r.status === 'pending' ? 'pending' : r.status === 'allowed' ? 'done' : 'failed'}"><div class="h">${esc(who(e.from))} · edit access · <span class="cst">${r.status === 'pending' ? 'waiting for your OK' : r.status}</span>${ts}</div>
        <div class="cmdline"><span class="pr">📁</span><code>${esc(String(r.folder).replace(/^\/home\/[^/]+/, '~'))}</code></div>${r.reason ? `<div class="hint">${esc(r.reason)}</div>` : ''}
        ${r.status === 'pending' ? `<div class="row"><button class="btn pri sm" data-act="accessDecide" data-id="${r.id}" data-d="allow">Allow on this job</button><button class="btn sm danger" data-act="accessDecide" data-id="${r.id}" data-d="deny">Don't allow</button></div>` : ''}</div>`;
    }
    const files = (e.attachments || []).length ? `<div class="files">${e.attachments.map((p) => fileChip(p)).join('')}</div>` : '';
    switch (e.kind) {
      case 'user': return `<div class="ev user"><div class="h">You${e.to ? ' → ' + esc(who(e.to)) : ''}${ts}</div><div class="b md">${mdRich(e.text)}</div>${files}</div>`;
      case 'followup': if (e.fid && e.fid === queuedFid(t)) return `<div class="ev user queued"><div class="h">You · follow-up · <span class="qtag">queued</span> <a data-act="recallMsg">edit (↑)</a>${ts}</div><div class="b md">${mdRich(e.text)}</div>${files}</div>`;
        return `<div class="ev user"><div class="h">You · follow-up${ts}</div><div class="b md">${mdRich(e.text)}</div>${files}</div>`;
      case 'assign': return `<div class="ev assign"><div class="h">${esc(who(e.from))} → ${esc(who(e.to))} · assigned${ts}</div><details><summary>brief</summary><div class="b md">${mdRich(e.text)}</div></details></div>`;
      case 'team': return `<div class="ev team"><div class="h">${esc(who(e.from))} started${ts}</div><div class="b">${esc(e.text)}</div></div>`;
      case 'report': return `<div class="ev report"><div class="h">${esc(who(e.from))} → ${esc(who(e.to))} · report${ts}</div><details><summary>read</summary><div class="b md">${mdRich(e.text)}</div></details></div>`;
      case 'chat': return `<div class="ev chat"><div class="h">${esc(who(e.from))} → ${esc(who(e.to))}${e.ask ? ' · question' : ''}${ts}</div><div class="b md">${mdRich(e.text)}</div></div>`;
      case 'note': return `<div class="ev"><div class="h">${esc(who(e.from))}${ts}</div><div class="b md">${mdRich(e.text)}</div></div>`;
      case 'answer': return `<div class="ev answer"><div class="h">${esc(who(e.from))} · answer${t && !t.rating && ['done', 'failed', 'interrupted'].includes(t.status) && e === [...t.thread].reverse().find((x) => x.kind === 'answer') ? `<span class="quickrate"><button class="xbtn" data-act="rate" data-s="1" title="Good answer">👍</button><button class="xbtn" data-act="rate" data-s="-1" title="Not what I needed">👎</button></span>` : ''}${t && t.rework ? '<span class="hint"> · followed up</span>' : ''}${ts}</div><div class="b md">${mdRich(e.text)}</div></div>`;
      case 'question': return `<div class="ev question"><div class="h">${esc(who(e.from))} asks you${ts}</div><div class="b md">${mdRich(e.text)}</div></div>`;
      case 'reply': return `<div class="ev reply"><div class="h">You → ${esc(who(e.to))}${ts}</div><div class="b md">${mdRich(e.text)}</div></div>`;
      case 'plan': return `<div class="ev plan"><div class="h">${esc(who(e.from))} · plan · est. ${money(e.estimateUsd)}${ts}</div><details><summary>read the plan</summary><div class="b md">${mdRich(e.text)}</div></details></div>`;
      case 'plandecision': if (e.auto) return `<div class="line-ev">Plan ${esc(e.auto)} · ${clock(e.t)}</div>`;
        return `<div class="line-ev">You ${e.decision === 'rejected' ? 'rejected' : e.decision === 'changed' ? 'approved with changes' : 'approved'} the plan${e.text ? `: “${esc(e.text)}”` : ''} · ${clock(e.t)}</div>`;
      case 'rating': return `<div class="line-ev">You rated this ${e.score > 0 ? '👍' : '👎'}${e.text ? `: “${esc(e.text)}”` : ''} · ${clock(e.t)}</div>`;
      default: return `<div class="line-ev">${esc(e.text || '')} · ${clock(e.t)}</div>`;
    }
  }).join('');
}
// The strip under a job's thread: who is working on it right now, what they are doing and what it has cost so far, refreshed every second.
const busyOn = (t) => Object.values(S.agents).filter((a) => agentJob(a) === t).sort((x, y) => !!y.resident - !!x.resident);
const queuedOn = (t) => Object.values(S.agents).find((a) => (a.inbox || []).some((i) => i.ticketId === t.id));
const pendingCmd = (t) => (t.commands || []).find((c) => c.status === 'pending');
const pendingAccess = (t) => (t.access || []).find((r) => r.status === 'pending');
const needsYou = (t) => !!(t.waiting || (t.plan && t.plan.status === 'pending') || (t.overBudget && t.status === 'open') || pendingCmd(t) || pendingAccess(t));
function jobLiveHtml(t) {
  if (t.status !== 'open' || needsYou(t)) return '';
  const busy = busyOn(t);
  if (!busy.length) {
    const inbox = queuedOn(t);
    if (!inbox) return '';
    const on = agentJob(inbox);
    return `<div class="r"><span class="dots wait"><i></i><i></i><i></i></span><b>${esc(inbox.persona)}</b><span class="act">${inbox.status === 'offline' ? 'is restarting, then picks this up' : on ? `finishes #${on.n} first, then picks this up` : 'picks this up next'}</span></div>`;
  }
  const asked = [...t.thread].reverse().find((e) => ['user', 'followup', 'reply'].includes(e.kind));
  const spent = (t.costUsd || 0) + busy.reduce((sum, a) => sum + (a.liveUsd || 0), 0);
  return busy.slice(0, 4).map((a, n) => {
    const L = S.live[a.id] || {};
    const quiet = L.t ? Date.now() - L.t : 0;
    const text = S.drafts[a.id] ? 'Writing the answer…' : L.thought || a.progress || 'Starting up…';
    const since = n === 0 && asked ? ` · working ${dur(Date.now() - asked.t)} · ≈ ${money(spent)} so far` : '';
    const stale = quiet > 90000 ? ` · no new output for ${dur(quiet)}, still running` : '';
    const stop = a.resident ? '<button class="xbtn" data-act="pause" title="Pause the job (resume it any time)">⏸</button>'
      : `<button class="xbtn" data-act="stopAgent" data-id="${a.id}" title="Stop ${esc(a.persona)}; ${esc(busy[0].persona)} gets told and carries on">⏹</button>`;
    return `<div class="r"><span class="dots"><i></i><i></i><i></i></span><b>${esc(a.persona)}</b><span class="act ${L.kind === 'think' && !S.drafts[a.id] ? 'th' : ''}" title="${esc(text)}">${esc(text)}</span><span class="hint mono">${since}${stale}</span>${stop}</div>`;
  }).join('') + (busy.length > 4 ? `<div class="hint">and ${busy.length - 4} more teammates</div>` : '') + planProgressHtml(t, busy);
}
function planSteps(text) {
  const lines = String(text || '').split('\n');
  let steps = lines.map((l) => l.match(/^\s{0,3}(\d+)[.)]\s+(.*)/)).filter(Boolean).map((m) => m[2]);
  if (steps.length < 2) steps = lines.map((l) => l.match(/^[-*]\s+(.*)/)).filter(Boolean).map((m) => m[1]);
  return steps.map((x) => plainText(x)).filter(Boolean);
}
function planProgressHtml(t, busy) {
  if (!t.plan || !['approved', 'changed'].includes(t.plan.status)) return '';
  const steps = planSteps(t.plan.text);
  if (!steps.length) return '';
  const lead = busy.find((a) => a.resident);
  const cur = Math.min(steps.length, t.plan.step || 0);
  const frac = lead && typeof lead.percent === 'number' ? lead.percent / 100 : cur ? (cur - 1) / steps.length : 0;
  const head = cur ? `Step ${cur} of ${steps.length}: ${steps[cur - 1]}` : `Plan: ${steps.length} steps`;
  return `<div class="plan-prog"><div class="bar"><i style="width:${Math.round(frac * 100)}%"></i></div>
    <a class="hint" data-act="planOpen">${S.planOpen ? '▾' : '▸'} ${esc(short(head, 140))}</a>
    ${S.planOpen ? `<ol class="steps">${steps.map((x, i) => `<li class="${i + 1 < cur ? 'done' : i + 1 === cur ? 'cur' : ''}">${esc(short(x, 160))}</li>`).join('')}</ol>` : ''}</div>`;
}
// The lead's answer as it is being written, at the end of the thread.
function jobDraftHtml(t) {
  if (t.status !== 'open') return '';
  const a = busyOn(t).find((x) => x.resident && S.drafts[x.id]);
  return a ? `<div class="ev answer draft"><div class="h">${esc(a.persona)} · writing…</div><div class="b md">${md(S.drafts[a.id])}</div></div>` : '';
}
const lastReplyAt = (t) => { for (let i = t.thread.length - 1; i >= 0; i--) if (['answer', 'question', 'plan'].includes(t.thread[i].kind)) return t.thread[i].t; return 0; };
const isUnread = (t) => !t.archived && lastReplyAt(t) > (S.seen[t.id] || 0) && !(S.app === 'jobs' && S.job === t.id);
function markSeen(t) { if (lastReplyAt(t) > (S.seen[t.id] || 0)) { S.seen[t.id] = Date.now(); setPref('seen', JSON.stringify(S.seen)); } }
function jobPill(t) {
  if (t.status !== 'open') return pill(t.status);
  if (needsYou(t)) return pill('paused', 'needs you');
  if (busyOn(t).length) return pill('running', 'working');
  return pill('queued', queuedOn(t) ? 'queued' : 'waiting');
}
function updateJobLive() {
  const el = $('#jlive');
  if (!el) return;
  const t = S.app === 'jobs' && S.tickets[S.job];
  const on = t && S.jtab === 'thread' && !S.replay;
  const h = on ? jobLiveHtml(t) : '';
  if (el.dataset.h !== h) { el.innerHTML = h; el.dataset.h = h; }
  const d = $('#jdraft');
  const dh = on ? jobDraftHtml(t) : '';
  if (d && d.dataset.h !== dh) {
    const body = $('#jbody');
    const atEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
    const started = dh && !d.dataset.h;
    d.innerHTML = dh; d.dataset.h = dh;
    if (atEnd) body.scrollTop = body.scrollHeight;
    else if (started) newPill(body, 1, 'writing');
  }
}
function ticketShare(usd) {
  const ws = Object.entries((S.limits && S.limits.windows) || {}).filter(([, w]) => w.est && w.est.pctPerUsd);
  return ws.length ? '≈ ' + ws.map(([k, w]) => `${pctFine(usd * w.est.pctPerUsd)} of ${k === 'five_hour' ? '5h' : k === 'seven_day' ? 'week' : k}`).join(' · ') : '';
}
async function getTimeline(t) {
  if (S.timeline[t.id] && Date.now() - S.timeline[t.id].at < 8000) return S.timeline[t.id].data;
  const d = await api('GET', `/api/tickets/${t.id}/timeline`).catch(() => null);
  S.timeline[t.id] = { at: Date.now(), data: d };
  return d;
}
function changesCard(t) {
  const n = (t.changes || []).length;
  if (!n) return '';
  const key = `${n}|${t.changes.map((c) => c.revertedAt || 0).join()}|${t.status}`;
  const c = S.chg[t.id];
  if ((!c || c.key !== key) && !(c && c.loading === key)) {
    S.chg[t.id] = { key: c && c.key, loading: key, list: c && c.list };
    api('GET', `/api/tickets/${t.id}/changes`).then((list) => { S.chg[t.id] = { key, list: Array.isArray(list) ? list : [] }; S.jbodyKey = null; dirty(); }).catch(() => { S.chg[t.id] = { key, list: null }; });
  }
  const list = (S.chg[t.id] && S.chg[t.id].list) || null;
  const live = list ? list.filter((x) => x.state !== 'unchanged') : null;
  if (live && !live.length) return `<div class="chgcard"><b>All file changes on this job were undone.</b> <a data-act="jtab" data-tab="changes">view</a></div>`;
  const files = live || t.changes;
  const names = files.slice(0, 4).map((x) => `<code class="fref" data-act="openFile" data-p="${esc(x.path)}" title="${esc(x.path)}">${esc(x.path.split('/').pop())}</code>`).join(' ');
  const more = files.length > 4 ? ` +${files.length - 4} more` : '';
  const nums = live ? ` · <span class="a">+${live.reduce((s2, x) => s2 + x.added, 0)}</span> <span class="d">−${live.reduce((s2, x) => s2 + x.removed, 0)}</span>` : '';
  return `<div class="chgcard"><b>Changed ${files.length} file${files.length === 1 ? '' : 's'}</b>${nums} · ${names}${more}<span style="flex:1"></span><a data-act="jtab" data-tab="changes">view changes</a>${live && live.length ? ' · <a data-act="revert" data-path="">undo all</a>' : ''}</div>`;
}
// The user's latest follow-up while it still waits in an agent's inbox (it can be taken back and edited).
function queuedFid(t) {
  if (!t) return null;
  const last = [...t.thread].reverse().find((e) => e.kind === 'followup');
  return last && last.fid && Object.values(S.agents).some((a) => (a.inbox || []).some((i) => i.fid === last.fid)) ? last.fid : null;
}
function flushSend() {
  const p = S.pendingSend;
  if (!p) return;
  clearTimeout(p.timer); S.pendingSend = null;
  showSendBar();
  api('POST', `/api/tickets/${p.id}/message`, { text: p.text, attachments: p.files }).catch((e) => {
    S.compose[p.id] = p.text; setPref('compose', JSON.stringify(S.compose));
    notify('warn', 'Your message was not sent', `${e.message}. It is back in the message box.`, p.id);
    if (S.job === p.id && $('#jtext') && !$('#jtext').value) $('#jtext').value = p.text;
  });
}
function showSendBar() {
  const el = $('#jsend');
  if (!el) return;
  const p = S.pendingSend;
  const h = p && p.id === S.job ? `Sending in ${Math.max(1, p.secs - Math.floor((Date.now() - p.at) / 1000))}s · <a data-act="undoSend">Undo</a> · <a data-act="sendNow">Send now</a>` : '';
  if (el.dataset.h !== h) { el.innerHTML = h; el.dataset.h = h; }
}
window.addEventListener('beforeunload', () => {
  const p = S.pendingSend;
  if (p) navigator.sendBeacon(`/api/tickets/${p.id}/message`, new Blob([JSON.stringify({ text: p.text, attachments: p.files })], { type: 'application/json' }));
});
function failBanner(t) {
  if (!['failed', 'interrupted'].includes(t.status)) return '';
  const why = t.status === 'failed' ? short(String(t.answer || 'No reason was given.').replace(/\s+/g, ' '), 300)
    : 'The agent stopped before finishing: the office was restarted or its process ended.';
  return `<div class="banner fail"><b>This job ${t.status === 'failed' ? 'failed' : 'was interrupted'}.</b> ${esc(why)}<div class="row"><button class="btn pri sm" data-act="retry">Retry</button></div></div>`;
}
function handoffBanner(t) {
  return (t.handoffs || []).map((name) => {
    const d = handoffDoc(name);
    const open = S.handoffOpen === `${t.id}:${name}`;
    const meta = d && d.text ? ` · updated ${esc(d.updated || '?')} · ${d.sessions} earlier session${d.sessions === 1 ? '' : 's'}` : '';
    return `<div class="banner info">↻ Continuing <b>${esc(name)}</b> from its handoff${meta} · <a data-act="handoff" data-k="${esc(`${t.id}:${name}`)}">${open ? 'hide' : 'show'}</a>${open && d && d.text ? `<div class="md" style="margin-top:6px;max-height:320px;overflow:auto">${md(d.text)}</div>` : ''}</div>`;
  }).join('');
}
function handoffDoc(name) {
  if (S.handoffDocs[name] !== undefined) return S.handoffDocs[name];
  S.handoffDocs[name] = null;
  api('GET', '/api/teams').then((teams) => {
    const pg = teams.flatMap((x) => x.pages).find((x) => x.group === 'Project handoffs' && x.name === `${name}.md`);
    return pg && api('GET', `/api/teams/page?path=${encodeURIComponent(pg.path)}`);
  }).then((r) => {
    if (!r || !r.text) return;
    const log = r.text.split(/^## Session log$/m)[1] || '';
    S.handoffDocs[name] = { text: r.text, updated: (r.text.match(/^Updated (\S+)/m) || [])[1], sessions: (log.match(/^### /gm) || []).length };
    dirty();
  }).catch(() => {});
  return null;
}
function renderJob() {
  const v = $('#jview');
  const t = S.tickets[S.job];
  if (!t) { if (S.jviewFor !== '') { S.jviewFor = ''; v.innerHTML = `<div class="empty">Select a job, or start one with <kbd>N</kbd>.</div>`; } return; }
  if (S.jviewFor !== t.id) {
    S.jviewFor = t.id; S.jbodyFor = null; S.jbodyKey = null; S.followFiles = []; S.rerate = false;
    v.innerHTML = `<div class="jhead" id="jhead"></div><div id="jban"></div><div class="tabs" id="jtabs"></div><div class="jbody" id="jbody"></div><div class="jlive" id="jlive" aria-live="polite"></div>
      <div class="composer"><textarea id="jtext"></textarea><div class="files" id="jfiles"></div><div class="row"><button class="btn sm" data-act="attachJob" title="Attach files">📎</button><span class="hint" id="jhint" style="flex:1"></span><span id="jsend" class="hint"></span><button class="btn pri sm" data-act="jobSend">Send</button></div></div>`;
    wireDrop($('#jtext'), () => S.followFiles, () => { $('#jfiles').innerHTML = S.followFiles.map((p) => fileChip(p, true)).join(''); });
    const box = $('#jtext');
    box.value = S.compose[t.id] || '';
    box.oninput = () => { if (box.value) S.compose[t.id] = box.value; else delete S.compose[t.id]; setPref('compose', JSON.stringify(S.compose)); };
    box.onkeydown = (e) => {
      if (e.key === 'ArrowUp' && !box.value && !e.shiftKey && !e.ctrlKey) { e.preventDefault(); ACT.recallMsg(); return; }
      if (e.key !== 'Enter' || e.isComposing) return;
      const ctrl = pref('sendKey', 'enter') === 'ctrl';
      if (ctrl ? (e.ctrlKey || e.metaKey) : !e.shiftKey && !e.ctrlKey) { e.preventDefault(); ACT.jobSend(); }
    };
  }
  if (S.app === 'jobs') markSeen(t);
  const owner = t.direct || t.assignees.find((k) => k !== S.root);
  const canWrap = owner && S.roles[owner] && S.roles[owner].handoffs && t.status !== 'scheduled';
  const people = [...new Set([t.direct, ...t.assignees].filter((k) => k && k !== S.root))];
  $('#jhead').innerHTML = `<h2><span class="hint mono">#${t.n}</span><span class="jt" title="${esc(t.title)}">${esc(t.title)}</span>${pill(t.status)}<span style="flex:1"></span>
      ${t.status === 'open' ? '<button class="btn sm" data-act="pause">Pause</button><button class="btn sm danger" data-act="stop">Stop</button>' : ''}${t.status === 'paused' ? '<button class="btn sm pri" data-act="resume">Resume</button><button class="btn sm danger" data-act="stop">Stop</button>' : ''}
      ${!['open', 'paused'].includes(t.status) ? `<button class="btn sm" data-act="archive">${t.archived ? 'Unarchive' : 'Archive'}</button>` : ''}${canWrap ? `<button class="btn sm" data-act="wrapUp" title="Ask ${esc(who(owner))} to save the project handoff and sum up">Wrap up</button>` : ''}<button class="btn sm" data-act="delJob">Delete</button></h2>
    <div class="kv"><span>cost <b>${money(t.costUsd)}</b>${t.budgetUsd != null ? ` of ${money(t.budgetUsd)}` : ''}</span>${t.costUsd && ticketShare(t.costUsd) ? `<span>limits <b>${ticketShare(t.costUsd)}</b></span>` : ''}<span>owner <b>${esc(people.map(who).join(', ') || 'routing')}</b></span>${t.project ? `<span>project <b>${esc(t.project)}</b></span>` : ''}<span>lead effort <b>${esc(t.leadEffort || 'high')}</b></span><span>opened <b>${ago(t.createdAt)}</b></span>${t.closedAt ? `<span>took <b>${dur(t.closedAt - t.createdAt)}</b></span>` : ''}</div>`;
  const q = t.waiting;
  const banHtml = failBanner(t) + handoffBanner(t) + (t.overBudget && t.status === 'open' ? `<div class="banner"><b>Paused at the budget.</b> ${money(t.costUsd)} of ${money(t.budgetUsd)} spent. <div class="row"><button class="btn pri sm" data-act="budget" data-add="5">+ $5</button><button class="btn sm" data-act="budget" data-add="10">+ $10</button><button class="btn sm danger" data-act="stop">Stop job</button></div></div>` : '')
    + (t.status === 'paused' ? '<div class="banner"><b>Paused.</b> Nothing runs on this job until you resume it.</div>' : '')
    + (t.status === 'scheduled' ? `<div class="banner"><b>Scheduled.</b> Starts ${whenAt(t.scheduledFor)}, after the 5-hour limit resets. <div class="row"><button class="btn pri sm" data-act="startNow">Start now</button></div></div>` : '')
    + (t.plan && t.plan.status === 'pending' ? `<div class="banner plan"><div class="row" style="margin:0;align-items:center"><span style="flex:1"><b>${esc(who(t.plan.from))} wants your OK on a plan</b> · estimated <b>${money(t.plan.estimateUsd)}</b></span><button class="btn pri sm" data-act="plan" data-d="approve">Approve</button><button class="btn sm" data-act="plan" data-d="always" title="Approve this one and every later plan on this job">Approve, don't ask again here</button><button class="btn sm danger" data-act="plan" data-d="reject">Reject</button></div><div class="md plantext">${md(t.plan.text)}</div><textarea id="planNote" placeholder="Optional: changes you want (then press Approve)" style="min-height:40px;margin-top:6px"></textarea></div>` : '')
    + (pendingAccess(t) ? `<div class="banner"><b>${esc(pendingAccess(t).persona)} asks to edit files outside this job's project:</b> <code>${esc(String(pendingAccess(t).folder).replace(/^\/home\/[^/]+/, '~'))}</code>${pendingAccess(t).reason ? `<div class="hint">${esc(pendingAccess(t).reason)}</div>` : ''}<div class="row"><button class="btn pri sm" data-act="accessDecide" data-id="${pendingAccess(t).id}" data-d="allow">Allow on this job</button><button class="btn sm danger" data-act="accessDecide" data-id="${pendingAccess(t).id}" data-d="deny">Don't allow</button></div></div>` : '')
    + (pendingCmd(t) ? `<div class="banner"><b>${esc(pendingCmd(t).persona)} wants to run a command.</b><div class="cmdline" style="margin-top:6px"><span class="pr">$</span><code>${esc(pendingCmd(t).command)}</code></div>${pendingCmd(t).reason ? `<div class="hint">${esc(pendingCmd(t).reason)}</div>` : ''}<div class="row"><button class="btn pri sm" data-act="cmdRun" data-cid="${pendingCmd(t).id}">Run</button><button class="btn sm" data-act="cmdAll" data-cid="${pendingCmd(t).id}">Run all on this job</button><button class="btn sm danger" data-act="cmdDeny" data-cid="${pendingCmd(t).id}">Don't run</button></div></div>` : '')
    + (q ? `<div class="banner"><b>${esc(who(q.from))} is waiting for your answer.</b><div class="md" style="margin-top:4px">${md(q.text)}</div>${(q.options || []).length ? `<div class="row">${q.options.map((o) => `<button class="btn sm" data-act="qopt" data-v="${esc(o)}">${esc(o)}</button>`).join('')}</div>` : ''}<div class="hint" style="margin-top:6px">Or type your answer below.</div></div>` : '');
  const ban = $('#jban');
  if (ban.dataset.h !== banHtml) {
    const note = $('#planNote') && $('#planNote').value;
    const scrolls = [...ban.querySelectorAll('.plantext, .md')].map((x) => x.scrollTop);
    ban.innerHTML = banHtml; ban.dataset.h = banHtml;
    if (note && $('#planNote')) $('#planNote').value = note;
    [...ban.querySelectorAll('.plantext, .md')].forEach((x, k) => { x.scrollTop = scrolls[k] || 0; });
  }
  const nCh = (t.changes || []).length;
  $('#jtabs').innerHTML = [['thread', 'Thread'], ['tree', 'Process tree'], ['changes', `Changes${nCh ? ` (${nCh})` : ''}`], ['timeline', 'Timeline']].map(([k, l]) => `<button class="${S.jtab === k ? 'on' : ''}" data-act="jtab" data-tab="${k}">${l}</button>`).join('');
  $('#jtext').placeholder = q ? `Answer ${who(q.from)}…` : t.status === 'open' ? 'Add to this job…' : 'Reply to reopen this job…';
  $('#jhint').textContent = (q ? `Answers ${who(q.from)}.` : `Goes to ${who(t.direct || (t.assignees.length === 1 ? t.assignees[0] : S.root))}.`) + (pref('sendKey', 'enter') === 'ctrl' ? ' Ctrl+Enter sends.' : ' Enter sends, Shift+Enter adds a line.') + (queuedFid(t) ? ' ↑ edits your queued message.' : '');
  const key = `${t.id}|${S.jtab}|${t.thread.length}|${queuedFid(t)}|${t.status}|${(t.commands || []).map((c) => c.status).join()}|${(t.access || []).map((r) => r.status).join()}|${nCh}|${(t.changes || []).map((c) => c.revertedAt || 0).join()}|${t.rating ? t.rating.score : 0}|${S.rerate}|${S.replay ? Math.round(S.replay.t / 1000) : ''}|${S.jtab === 'tree' || S.jtab === 'timeline' ? Math.floor(Date.now() / 5000) + Object.values(S.agents).map((a) => a.status).join('') : ''}`;
  if (key === S.jbodyKey) return;
  S.jbodyKey = key;
  const body = $('#jbody');
  if (S.jtab === 'thread') {
    const closed = ['done', 'failed', 'interrupted', 'stopped'].includes(t.status) && t.answer;
    const rate = closed ? (t.rating && !S.rerate ? `<div class="sec">You rated this ${t.rating.score > 0 ? '👍' : '👎'}${t.rating.note ? `: “${esc(t.rating.note)}”` : ''} <a class="hint" data-act="rerate">change</a></div>`
      : `<div class="sec"><div class="label">How was this answer?</div><div class="row" style="margin-top:0"><input class="in" id="rateNote" placeholder="Optional: what was good or missing" style="flex:1;min-width:160px"><button class="btn sm" data-act="rate" data-s="1">👍</button><button class="btn sm" data-act="rate" data-s="-1">👎</button></div><div class="hint" style="margin-top:4px">Goes to the lead as feedback.</div></div>`) : '';
    const same = S.jbodyFor === t.id;
    const prevLen = S.jbodyLen || 0;
    const fresh = same ? t.thread.slice(prevLen) : [];
    const mine = fresh.some((e) => ['user', 'followup', 'reply'].includes(e.kind));
    const jump = stickyRender(body, same && !mine, () => { body.innerHTML = threadHtml(t) + '<div id="jdraft"></div>' + changesCard(t) + rate; });
    if (!same) body.scrollTop = q ? 0 : body.scrollHeight;
    else if (jump && fresh.some((e) => FOREGROUND.includes(e.kind) && !['user', 'followup', 'reply'].includes(e.kind))) newPill(body, fresh.length);
    S.jbodyFor = t.id; S.jbodyLen = t.thread.length;
  } else if (S.jtab === 'tree') {
    getTimeline(t).then((tl) => { if (S.job === t.id && S.jtab === 'tree') body.innerHTML = `<div class="hint" style="margin:10px 0">Who started whom on this job, with each process's state and its cost here. Click a process to inspect it.</div>${jobTreeHtml(t, tl)}`; });
  } else if (S.jtab === 'changes') renderChanges(t, body);
  else renderTimeline(t, body);
}
async function renderChanges(t, body) {
  const list = await api('GET', `/api/tickets/${t.id}/changes`).catch((e) => ({ error: e.message }));
  if (S.job !== t.id || S.jtab !== 'changes') return;
  if (list.error) { body.innerHTML = `<div class="empty">${esc(list.error)}</div>`; return; }
  if (!list.length) { body.innerHTML = '<div class="empty">No files changed on this job.</div>'; return; }
  const live = list.filter((c) => c.state !== 'unchanged').length;
  body.innerHTML = `<div class="row"><span class="hint" style="flex:1">${live} of ${list.length} file${list.length === 1 ? '' : 's'} differ from before this job. Undo restores the copy saved before the first edit here (it never touches git).</span>${live ? '<button class="btn sm danger" data-act="revert" data-path="">Undo all</button>' : ''}</div>` +
    list.map((c) => {
      const diff = esc(c.diff).split('\n').map((l) => (l.startsWith('@@') ? `<span class="hh">${l}</span>` : l.startsWith('+') && !l.startsWith('+++') ? `<span class="a">${l}</span>` : l.startsWith('-') && !l.startsWith('---') ? `<span class="d">${l}</span>` : l + '\n')).join('');
      return `<div class="diffhead">${pill(c.state === 'unchanged' ? 'queued' : c.state === 'deleted' ? 'failed' : 'done', c.state === 'unchanged' ? (c.revertedAt ? 'undone' : 'same') : c.state)}<span class="p" title="${esc(c.path)}"><bdi>${esc(c.path)}</bdi></span><span class="hint mono">+${c.added} −${c.removed}</span>${c.state !== 'unchanged' ? `<button class="btn sm" data-act="revert" data-path="${esc(c.path)}">Undo</button>` : ''}</div>
        <div class="hint">by ${esc(c.by.join(', '))}</div>${c.diff ? `<details ${list.length <= 3 ? 'open' : ''}><summary>diff</summary><pre class="diff">${diff}</pre></details>` : ''}`;
    }).join('');
}
async function renderTimeline(t, body) {
  const tl = await getTimeline(t);
  if (S.job !== t.id || S.jtab !== 'timeline' || !tl) return;
  if (!tl.rows.length) { body.innerHTML = '<div class="empty">Nobody has worked on this job yet.</div>'; return; }
  const t0 = tl.start, t1 = Math.max(tl.end || Date.now(), ...tl.rows.flatMap((r) => r.spans.map((sp) => sp.end || Date.now())));
  const span = Math.max(1000, t1 - t0);
  const x = (v) => Math.max(0, Math.min(100, ((v - t0) / span) * 100));
  if (S.wantReplay && !S.replay) { S.wantReplay = false; S.replay = { job: t.id, t: t0, t0, t1, speed: 30, playing: true }; }
  const R = S.replay && S.replay.job === t.id ? S.replay : null;
  const rows = tl.rows.sort((a, b) => (b.resident - a.resident) || (a.spans[0].start - b.spans[0].start));
  body.innerHTML = `<div class="row"><span class="hint" style="flex:1">${whenAt(t0)} → ${tl.end ? whenAt(tl.end) : 'now'} · ${dur(span)}</span>
      ${R ? `<button class="btn sm" data-act="rpPlay">${R.playing ? '⏸ Pause' : '▶ Play'}</button><select id="rpSpeed">${[10, 30, 120].map((v) => `<option value="${v}" ${R.speed === v ? 'selected' : ''}>${v}×</option>`).join('')}</select><button class="btn sm" data-act="rpExit">Exit replay</button>` : '<button class="btn sm" data-act="replay">▶ Replay</button>'}</div>
    ${R ? `<input type="range" id="rpSeek" min="0" max="1000" value="${Math.round(((R.t - t0) / span) * 1000)}" style="width:100%"><div class="hint mono">${new Date(R.t).toLocaleTimeString()} · +${dur(R.t - t0)}</div>` : ''}
    <div class="tl">${rows.map((r) => `<div class="r"><span class="who" data-act="sel2" data-id="${r.id}">${esc(r.persona)}</span><div class="lane">${r.spans.map((sp) => { const a = x(sp.start), b = x(sp.end || Date.now()); return `<i class="spn ${r.resident ? 'res' : ''} ${sp.ok === false ? 'bad' : ''} ${sp.running ? 'live' : ''}" style="left:${a}%;width:${Math.max(0.6, b - a)}%" data-tip="${esc(r.persona)} · ${dur((sp.end || Date.now()) - sp.start)} · ${sp.running ? 'working' : money(sp.costUsd)}"></i>`; }).join('')}${R ? `<i class="cursor" style="left:${x(R.t)}%"></i>` : ''}</div><span class="num" style="width:56px">${money(r.spans.reduce((s, sp) => s + sp.costUsd, 0))}</span></div>`).join('')}</div>
    ${R ? `<div class="label" style="margin-top:14px">Process tree at this moment</div>${jobTreeHtml(t, tl, R.t)}<div class="label" style="margin-top:14px">What had happened by then</div>${threadHtml(t, R.t)}` : `<div class="hint" style="margin-top:8px"><span style="color:var(--accent)">■</span> lead &nbsp; <span style="color:var(--run)">■</span> staff &nbsp; <span style="color:var(--fail)">■</span> did not finish. Replay steps through the job: the process tree and the thread as they were at each moment.</div>`}`;
  const seek = $('#rpSeek');
  if (seek) seek.oninput = (e) => { R.t = t0 + (span * Number(e.target.value)) / 1000; R.playing = false; S.jbodyKey = null; dirty(); };
  const sp = $('#rpSpeed');
  if (sp) sp.onchange = (e) => { R.speed = Number(e.target.value); };
}
