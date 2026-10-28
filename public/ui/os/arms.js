'use strict';
// The ARMS apps: checklist, Skills, Routines and Recos.
// ================================================================ ARMS apps
const DAYNAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
async function armsData(force) {
  if (!S.armsData || force) S.armsData = await api('GET', '/api/arms');
  return S.armsData;
}
APPS.arms = {
  mount(root) {
    root.innerHTML = `<div class="app"><div class="toolbar"><h1>ARMS</h1><span class="hint">Apps, Routines, Memory, Skills: twelve levels that make the setup cheaper, faster and better every week.</span></div><div class="page" id="armsBody"><div class="empty">Loading…</div></div></div>`;
    S.armsKey = null;
  },
  async update() {
    const d = S.armsData || await armsData();
    const key = JSON.stringify(d).length + '|' + (S.diffOpen || '') + '|' + (S.imgs ? S.imgs.total : '');
    if (key === S.armsKey) return;
    S.armsKey = key;
    const icon = (l) => (l.done ? '✅' : l.auto === 'partial' ? '◐' : '○');
    let html = `<div class="cards" style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr))">` + d.checklist.map((p) => `<div class="card"><h3>${p.part} · ${p.name}</h3>${p.levels.map((l) => `
      <div class="rolerow"><div class="top"><span title="${l.done ? 'done' : 'not yet'}">${icon(l)}</span><b>${l.id} ${esc(l.title)}</b><label class="chk" title="Tick it yourself"><input type="checkbox" data-act="armsTick" data-id="${l.id}" ${l.done ? 'checked' : ''}></label></div>
      <div class="hint">${esc(l.test)}</div><div style="margin-top:4px">${esc(l.detail)} ${l.app && l.app !== 'arms' ? `<a data-act="app" data-app="${l.app}">open ${esc((APP_LIST.find((x) => x.id === l.app) || {}).name || l.app)}</a>` : ''}</div></div>`).join('')}</div>`).join('') + '</div>';
    html += `<h2 style="margin:22px 0 8px;font-size:15px">Approvals <span class="hint">· changes to your Claude Code setup wait here until you approve them</span> <button class="btn sm" data-act="armsSelftest">Test all of them safely</button></h2>${S.armsSelftest ? `<pre class="card" style="white-space:pre-wrap;font-size:12px;margin:0 0 10px">${esc(S.armsSelftest)}</pre>` : ''}<div class="cards" style="grid-template-columns:repeat(auto-fill,minmax(380px,1fr))">` + d.approvals.map((a) => `<div class="card"><h3>${a.level} · ${esc(a.title)}</h3>
      <div style="margin-bottom:8px">${a.status === 'applied' ? '<span class="pill s-done">done</span>' : '<span class="pill s-queued">waiting for you</span>'}</div><div class="hint" style="color:var(--text)">${esc(a.what)}</div>
      <div class="row">${a.id === 'memory-map' ? `<button class="btn sm" data-act="armsDiff">${S.diffOpen ? 'Hide' : 'Show'} the new map</button>` : ''}
        ${a.id === 'keepwarm' ? `<button class="btn sm ${a.status === 'applied' ? '' : 'pri'}" data-act="armsApprove" data-id="keepwarm" data-off="${a.status === 'applied' ? '1' : ''}">${a.status === 'applied' ? 'Turn off' : 'Turn on'}</button>` : a.id === 'extension' ? `<button class="btn sm" data-act="armsApprove" data-id="extension" data-off="${a.status === 'applied' ? '1' : ''}">${a.status === 'applied' ? 'Mark not loaded' : 'I loaded it'}</button>` : a.manual || a.status === 'applied' ? '' : `<button class="btn pri sm" data-act="armsApprove" data-id="${a.id}">Approve</button>`}</div>
      ${a.id === 'memory-map' && S.diffOpen ? `<pre class="diff" style="max-height:420px">${diffColor(S.mapDiff || 'Loading…')}</pre><div class="hint">Plus router files: one for your work notes (moved word for word), personal.md and agentic-os.md.</div>` : ''}</div>`).join('') + '</div>';
    const r = d.routing;
    html += `<div class="cards" style="margin-top:14px"><div class="card"><h3>S2 · Model routing</h3><div>Router: <b>${r.key.present ? 'Jev (typesafe/jev-router)' : 'EV script'}</b>${r.key.present ? '' : ' — Jev needs an OpenRouter key'} · <label class="chk"><input type="checkbox" data-act="jevToggle" ${r.on ? 'checked' : ''}> use Jev when available</label></div>
      <div class="kv"><span>picks (30 d) <b>${r.calls}</b></span>${Object.entries(r.bySource).map(([k, v]) => `<span>${esc(k)} <b>${v}</b></span>`).join('')}${r.jevCalls ? `<span>Jev avg <b>${r.jevAvgMs} ms</b></span><span>Jev cost <b>$${r.jevCostUsd.toFixed(4)}</b></span>` : ''}${Object.entries(r.byModel).filter(([k]) => k !== 'undefined').map(([k, v]) => `<span>${esc(k)} <b>${Math.round((v / Math.max(1, r.calls)) * 100)}%</b></span>`).join('')}</div>
      ${r.cacheHits || r.overrides ? `<div class="hint">Reused Jev decisions for near-identical tasks: <b>${r.cacheHits}</b> · your track record overruled Jev: <b>${r.overrides}</b></div>` : ''}
      ${r.outcomes && r.outcomes.rows.length ? `<table class="ps" style="table-layout:auto;margin:8px 0"><thead><tr><th>How picks turned out (30 d)</th><th class="num">Tasks</th><th class="num">Done</th><th class="num">$/task</th><th class="num">Min</th><th class="num">${thumb(true)}/${thumb(false)}</th><th class="num">Sent back</th><th class="num">Retried</th></tr></thead><tbody>${r.outcomes.rows.map((g) => `<tr title="${esc(Object.entries(g.models).map(([m, n]) => `${m}×${n}`).join(' '))}"><td>${esc(g.label)}</td><td class="num">${g.n}</td><td class="num">${Math.round(g.doneRate * 100)}%</td><td class="num">$${g.avgCost.toFixed(2)}</td><td class="num">${g.avgMin == null ? '—' : g.avgMin.toFixed(1)}</td><td class="num">${g.good}/${g.bad}</td><td class="num">${Math.round(g.sentBackRate * 100)}%</td><td class="num">${Math.round(g.retryRate * 100)}%</td></tr>`).join('')}</tbody></table>` : ''}
      ${r.outcomes ? `<div class="hint" style="margin-bottom:6px">${esc(r.outcomes.verdict)}</div>` : ''}
      ${r.last.slice(0, 6).map((l) => `<div class="line-ev">${new Date(l.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ${esc(l.source)} → ${esc(l.error ? 'error: ' + l.error : `${l.model}/${l.effort}`)} · ${esc(short(l.task || '', 60))}</div>`).join('')}</div>
      <div class="card"><h3>M2 · Cache</h3>${d.cache ? `<div>${d.cache.cold} cold reloads in ${d.cache.days} days, about <b>$${d.cache.coldUsd.toFixed(2)}</b>. Keep-warm would net <b>$${d.cache.netUsd.toFixed(2)}</b> (${d.cache.savable} reloads within 4 h; ${d.cache.longGaps} after longer gaps).</div>` : '<div class="hint">No report yet.</div>'}
        <div class="kv">${d.leadsCache.filter((l) => l.id !== S.root).map((l) => `<span>${esc(l.persona)} <b style="color:${l.state === 'warm' ? 'var(--done)' : l.state === 'cooling' ? 'var(--stop)' : 'var(--muted)'}">${l.state}</b></span>`).join('')}</div><div class="row"><button class="btn sm" data-act="cacheRefresh">Run the report again</button></div></div>
      <div class="card"><h3>M1 · Images without a description</h3>${S.imgs ? `<div><b>${S.imgs.total}</b> images in ${S.imgs.dirs.length} folders (≈ $${(S.imgs.total * 0.001).toFixed(2)} for all). Caption only the folders you search:</div>${S.imgs.dirs.slice(0, 6).map((x) => `<div class="row" style="margin-top:4px"><span class="mono hint" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(x.dir)}">${esc(x.dir.replace(/^\/home\/[^/]+/, '~'))}</span><span class="num">${x.uncaptioned}</span><button class="btn sm" data-act="caption" data-dir="${esc(x.dir)}">Caption ≈ $${(x.uncaptioned * 0.001).toFixed(2)}</button></div>`).join('')}` : '<button class="btn sm" data-act="imgScan">Find images without a description</button>'}</div></div>`;
    $('#armsBody').innerHTML = html;
  },
};
function diffColor(t) { return esc(t).split('\n').map((l) => (l.startsWith('@@') ? `<span class="hh">${l}</span>` : l.startsWith('+') && !l.startsWith('+++') ? `<span class="a">${l}</span>` : l.startsWith('-') && !l.startsWith('---') ? `<span class="d">${l}</span>` : l + '\n')).join(''); }

APPS.skills = {
  mount(root) {
    root.innerHTML = `<div class="app"><div class="toolbar"><h1>Skills</h1><span class="hint">Saved instructions Claude follows: types, sizes, how often you use them, the model each runs on.</span><span class="sp"></span><button class="btn sm" data-act="skNew" data-k="database">+ Database skill</button><button class="btn sm" data-act="skNew" data-k="artifact">+ Artifact skill</button><button class="btn sm" data-act="skRescan">Rescan</button></div>
      <div class="two"><div class="list" id="skList"></div><div class="page" id="skBody"></div></div></div>`;
    S.skKey = null;
  },
  async update() {
    if (!S.skillsData) S.skillsData = await api('GET', '/api/arms/skills');
    if (!S.skProps) S.skProps = await api('GET', '/api/skill-proposals').catch(() => []);
    const d = S.skillsData;
    const props = S.skProps;
    if (S.spSel === undefined && props.some((x) => x.status === 'pending')) S.spSel = props.find((x) => x.status === 'pending').id;
    const sel = S.skill || (d.skills[0] || {}).name;
    const key = JSON.stringify(d).length + '|' + JSON.stringify(props).length + '|' + (S.spSel || '') + '|' + sel + '|' + (S.skNew || '') + '|' + (S.teachP ? S.teachP.id : '');
    if (key === S.skKey) return;
    S.skKey = key;
    const pend = props.filter((x) => x.status === 'pending');
    const recent = props.filter((x) => x.status !== 'pending').slice(0, 5);
    $('#skList').innerHTML = (pend.length || recent.length ? `<div class="grp">Proposed by agents${pend.length ? ` · ${pend.length} waiting` : ''}</div>` +
      [...pend, ...recent].map((x) => `<div class="li ${S.spSel === x.id ? 'on' : ''}" data-act="spSel" data-id="${x.id}"><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(x.name)}</span><span class="hint">${x.status === 'pending' ? esc(x.persona) : x.status}</span></div>`).join('') + '<div class="grp">Installed</div>' : '') +
      d.skills.map((s) => `<div class="li ${sel === s.name ? 'on' : ''}" data-act="skSel" data-id="${esc(s.name)}"><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(s.name)}</span><span class="pill s-${s.type === 'database' ? 'delegating' : s.type === 'artifact' ? 'running' : 'queued'}">${esc(s.type)}</span>${s.model ? `<span class="mdl m-${esc(s.model)}">${esc(s.model)}</span>` : ''}<span class="hint">${s.uses}×</span></div>`).join('') || '<div class="empty">No skills found.</div>';
    const body = $('#skBody');
    const sp = S.spSel && props.find((x) => x.id === S.spSel);
    if (sp) {
      body.innerHTML = `<h2 style="margin-top:0">${esc(sp.name)} ${pill(sp.status === 'pending' ? 'queued' : sp.status === 'approved' ? 'done' : 'failed', sp.status === 'pending' ? 'waiting for you' : sp.status)}</h2>
        <div class="kv"><span>proposed by <b>${esc(sp.persona)}</b></span><span>for <b>${sp.scope === 'me' ? esc(sp.persona) + ' only' : 'the whole ' + esc(sp.room || 'team')}</b></span>${sp.ticketN ? `<span>during <a data-act="openJobN" data-n="${sp.ticketN}">#${sp.ticketN}</a></span>` : ''}<span>${ago(sp.at)}</span>${sp.update ? '<span><b>updates an existing skill</b></span>' : ''}</div>
        <div class="card" style="margin-top:12px"><h3>When to use it</h3><div>${esc(sp.description)}</div>${sp.why ? `<h3 style="margin-top:10px">Why (the agent's evidence)</h3><div class="md">${mdRich(sp.why)}</div>` : ''}</div>
        <div class="card"><h3>The skill</h3><div class="md">${mdRich(sp.content)}</div>${sp.update ? `<details style="margin-top:8px"><summary>the current version it replaces</summary><div class="md">${mdRich(sp.update.replace(/^---\n[\s\S]*?\n---\n*/, ''))}</div></details>` : ''}</div>
        ${sp.status === 'pending' ? `<textarea id="spNote" placeholder="Optional: a note for ${esc(sp.persona)} (why, or what to change)" style="min-height:44px"></textarea>
        <div class="row"><button class="btn pri" data-act="spDecide" data-id="${sp.id}" data-d="approve">Approve and install</button><button class="btn danger" data-act="spDecide" data-id="${sp.id}" data-d="reject">Reject</button></div>`
        : `<div class="hint">${sp.status === 'approved' ? `Installed in <code class="fref" data-act="openFile" data-p="${esc(sp.file || '')}">${esc(sp.file || '')}</code>` : 'Rejected'}${sp.note ? ` · your note: “${esc(sp.note)}”` : ''}</div>`}`;
      return;
    }
    if (S.skNew === 'database') { body.innerHTML = `<h2 style="margin-top:0">New database skill</h2><div class="hint" style="margin-bottom:10px">For something you reference every week (your tone of voice, best titles, thumbnails, links). The skill stays short; examples and principles go in references.md. When it pitches ideas, 8 of 10 follow the references and 2 are wildcards.</div>
      <div class="form"><input class="in" id="ndb_name" placeholder="Name, e.g. tone"><input class="in" id="ndb_holds" placeholder="What it holds, e.g. how I write"><textarea class="full" id="ndb_principles" placeholder="Principles (one per line)" style="min-height:80px"></textarea><textarea class="full" id="ndb_examples" placeholder="Paste examples" style="min-height:140px"></textarea></div><div class="row"><button class="btn pri" data-act="skCreate" data-k="database">Create in ~/.claude/skills</button><button class="btn" data-act="skNew" data-k="">Cancel</button></div>`; return; }
    if (S.skNew === 'artifact') { body.innerHTML = `<h2 style="margin-top:0">Artifact skill</h2><div class="hint" style="margin-bottom:10px">One brand book as an HTML page; every deck, infographic and PDF is built in HTML from it, exported only at the end, and saved to one artifacts inbox (newest first, searchable).</div>
      <div class="form"><input class="in" id="nar_brand" placeholder="Brand name"><input class="in" id="nar_colors" placeholder="Colours, e.g. #141a22, #e8a33d, #f5f1e8"><input class="in" id="nar_font" placeholder="Font stack, e.g. Inter, system-ui"><input class="in" id="nar_logo" placeholder="Logo rules (one line)"></div><div class="row"><button class="btn pri" data-act="skCreate" data-k="artifact">Create</button><button class="btn" data-act="skNew" data-k="">Cancel</button><a href="/artifacts/" target="_blank">open the artifacts inbox</a></div>`; return; }
    const s = d.skills.find((x) => x.name === sel);
    if (!s) { body.innerHTML = '<div class="empty">Pick a skill.</div>'; return; }
    const btn = d.buttons[s.name];
    const runs = d.runs.filter((r) => r.skill === s.name).slice(0, 8);
    const tp = S.teachP && S.teachP.skill === s.name ? S.teachP : null;
    body.innerHTML = `<h2 style="margin:0 0 4px">/${esc(s.name)} <span class="pill s-${s.type === 'database' ? 'delegating' : 'queued'}">${esc(s.type)}</span></h2><div class="hint">${esc(s.description)}</div>
      <div class="kv"><span>used <b>${s.uses}×</b></span><span>size <b>${s.tokens} tokens</b></span><span>files <b>${s.files}</b></span>${s.wildcards ? '<span><b>wildcards on</b></span>' : ''}${s.parkedNotes ? `<span>parked notes <b>${s.parkedNotes}</b></span>` : ''}<span class="mono">${esc(s.dir.replace(/^\/home\/[^/]+/, '~'))}</span></div>
      <div class="cards" style="margin-top:12px">
        <div class="card"><h3>Run in the background (claude -p)</h3><input class="in" id="skArgs" placeholder="Arguments (optional)" value="${esc((btn && btn.args) || '')}" style="width:100%">
          <div class="row"><select id="skModel"><option value="">model: ${s.model ? 'pinned ' + esc(s.model) : 'router decides'}</option>${['haiku', 'sonnet', 'opus'].map((m) => `<option ${btn && btn.model === m ? 'selected' : ''}>${m}</option>`).join('')}</select><select id="skEffort"><option value="">effort: auto</option>${['low', 'medium', 'high', 'xhigh'].map((m) => `<option ${btn && btn.effort === m ? 'selected' : ''}>${m}</option>`).join('')}</select><label class="chk"><input type="checkbox" id="skEdit" ${btn && btn.edit ? 'checked' : ''}> may edit files</label></div>
          <div class="row"><button class="btn pri" data-act="skRun">Run now</button><button class="btn" data-act="skButton">${btn ? 'Update' : 'Save as'} run button</button>${btn ? '<button class="btn sm" data-act="skButtonDel">remove button</button>' : ''}</div><div class="hint" style="margin-top:6px">Each run saves a short report below.</div></div>
        <div class="card"><h3>Model routing (S2)</h3><div>Pin fixed-step skills to the smallest model that does the job; everything else is decided per run by ${S.armsData && S.armsData.routing.key.present ? 'Jev' : 'the router (Jev once you add a key, else the EV script)'}.</div>
          <div class="row"><select id="skPin"><option value="">not pinned (router decides)</option>${['haiku', 'sonnet', 'opus'].map((m) => `<option ${s.model === m ? 'selected' : ''}>${m}</option>`).join('')}</select><button class="btn" data-act="skPin">Save</button></div></div>
        <div class="card"><h3>Teach (S3)</h3><div class="hint">Feedback on what it produced. Claude finds the principle behind it and folds it in, so the skill gets sharper, not longer. You see the change before it's saved.</div>
          <textarea id="skFeedback" placeholder="What was wrong or missing in its last output?" style="min-height:70px;margin-top:6px"></textarea><div class="row"><button class="btn pri" data-act="skTeach">Propose an improvement</button><span class="hint" id="skTeachMsg"></span></div>
          ${tp ? `<div style="margin-top:10px"><b>Principle:</b> ${esc(tp.principle)}<pre class="diff" style="max-height:300px">${diffColor(tp.diff || '(no change)')}</pre><div class="row"><button class="btn pri sm" data-act="skApply">Apply</button><button class="btn sm" data-act="skDiscard">Discard</button><span class="hint">${esc(tp.model)} · $${(tp.costUsd || 0).toFixed(3)}</span></div></div>` : ''}</div></div>
      <div class="label" style="margin-top:16px">Recent runs</div>${runs.length ? runs.map((r) => `<div class="ev ${r.status === 'failed' ? 'err' : ''}"><div class="h">${esc(r.status)} · ${esc(r.model)}/${esc(r.effort)}${r.costUsd != null ? ` · $${(r.costUsd || 0).toFixed(3)}` : ''}<span class="ts">${new Date(r.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></div><div class="hint">${esc(r.choice || '')}</div>${r.output ? `<details><summary>report</summary><div class="b md">${md(r.output)}</div></details>` : ''}</div>`).join('') : '<div class="hint">No runs yet.</div>'}`;
  },
};

APPS.routines = {
  mount(root) {
    root.innerHTML = `<div class="app"><div class="toolbar"><h1>Routines</h1><span class="hint">Jobs that run on a schedule. Active ones hand you a result; passive ones stay quiet unless something is worth flagging.</span><span class="sp"></span><button class="btn pri sm" data-act="rtNew">+ New routine</button></div><div class="page" id="rtBody"></div></div>`;
    S.rtKey = null;
  },
  async update() {
    if (!S.routinesData) S.routinesData = await api('GET', '/api/arms/routines');
    const d = S.routinesData;
    const key = JSON.stringify(d).length + '|' + (S.rtEdit || '');
    if (key === S.rtKey) return;
    S.rtKey = key;
    const ed = S.rtEdit ? (S.rtEdit === 'new' ? { name: '', prompt: '', mode: 'passive', schedule: { type: 'weekly', day: 5, at: '09:00' }, capUsdWeek: 2 } : d.routines.find((r) => r.id === S.rtEdit)) : null;
    let html = '';
    if (ed) html += `<div class="card" style="margin-bottom:14px"><h3>${S.rtEdit === 'new' ? 'New routine' : 'Edit routine'}</h3><div class="form">
      <input class="in" id="rt_name" placeholder="Name" value="${esc(ed.name)}"><select id="rt_mode"><option value="passive" ${ed.mode === 'passive' ? 'selected' : ''}>passive: ping only if worth flagging</option><option value="active" ${ed.mode === 'active' ? 'selected' : ''}>active: always hand me the output</option></select>
      <textarea class="full" id="rt_prompt" placeholder="What it does, as you'd ask the agents" style="min-height:90px">${esc(ed.prompt)}</textarea>
      <select id="rt_type">${['daily', 'weekly', 'hourly'].map((t) => `<option ${ed.schedule.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select><select id="rt_day">${DAYNAMES.map((n, i) => `<option value="${i}" ${ed.schedule.day === i ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <input class="in" id="rt_at" placeholder="09:00" value="${esc(ed.schedule.at || '09:00')}"><input class="in" id="rt_every" placeholder="every N hours (hourly)" value="${esc(ed.schedule.every || '')}">
      <select id="rt_project"><option value="">route automatically</option>${S.projects.map((p) => `<option ${ed.project === p.name ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select><input class="in" id="rt_cap" placeholder="Cap, $ per week" value="${esc(ed.capUsdWeek || '')}"></div>
      <div class="row"><button class="btn pri" data-act="rtSave">Save</button><button class="btn" data-act="rtCancel">Cancel</button></div></div>`;
    html += `<div class="card"><table class="ps" style="table-layout:auto"><thead><tr><th>Routine</th><th>Mode</th><th>When</th><th class="num">This week</th><th class="num">Cap</th><th>Next run</th><th></th></tr></thead><tbody>` + d.routines.map((r) => `<tr class="${r.enabled ? '' : 'dim'}"><td><b>${esc(r.name)}</b>${r.builtin ? ' <span class="hint">· script</span>' : ''}<div class="hint" style="white-space:normal">${esc(r.does || short(r.prompt || '', 120))}</div></td>
      <td>${pill(r.mode === 'passive' ? 'idle' : 'running', r.mode)}</td><td>${esc(r.scheduleText)}</td><td class="num">$${r.week.usd.toFixed(2)} · ${r.week.runs}</td>
      <td class="num">${r.builtin ? '—' : r.capUsdWeek ? `$${r.capUsdWeek}${r.week.usd >= r.capUsdWeek ? ' <b style="color:var(--fail)">hit</b>' : ''}` : '<span style="color:var(--stop)">none</span>'}</td><td>${r.nextRunAt && r.enabled ? whenAt(r.nextRunAt) : '—'}</td>
      <td style="white-space:nowrap">${r.builtin ? '' : `<button class="btn sm" data-act="rtRun" data-id="${r.id}">Run now</button> <button class="btn sm" data-act="rtOpt" data-id="${r.id}" title="Ask the lead to cut the fat">Optimise</button> <button class="btn sm" data-act="rtToggle" data-id="${r.id}">${r.enabled ? 'Pause' : 'Enable'}</button> <button class="btn sm" data-act="rtEdit" data-id="${r.id}">Edit</button> <button class="btn sm danger" data-act="rtDel" data-id="${r.id}">✕</button>`}</td></tr>`).join('') + `</tbody></table></div>
      <div class="hint" style="margin-top:10px">Sorted by what they cost this week (API-equivalent dollars). Script routines cost nothing. A capped routine skips its runs once it reaches its cap, and tells you.${d.keepWarm && d.keepWarm.pings ? ` Keep-warm has pinged ${d.keepWarm.pings} time(s) for $${d.keepWarm.costUsd.toFixed(2)}.` : ''}</div>`;
    $('#rtBody').innerHTML = html;
  },
};

APPS.recos = {
  mount(root) {
    root.innerHTML = `<div class="app"><div class="toolbar"><h1>Recos</h1><span class="hint">Every Friday a script looks for jobs you did by hand 3+ times this week, and corrections you had to repeat. Pick the ones you want.</span><span class="sp"></span><button class="btn sm" data-act="rcRefresh">Look again now</button></div><div class="page" id="rcBody"></div></div>`;
    S.rcKey = null; S.cart = S.cart || new Set();
  },
  async update() {
    if (!S.recosData) S.recosData = await api('GET', '/api/arms/recos');
    const d = S.recosData;
    const key = JSON.stringify(d).length + '|' + [...S.cart].join();
    if (key === S.rcKey) return;
    S.rcKey = key;
    $('#rcBody').innerHTML = `<div class="hint" style="margin-bottom:12px">Last looked ${d.at ? ago(d.at) : 'never'} over ${d.days || 7} days. Nothing changes until you pick.</div>` + (d.cards.length ? `<div class="cards" style="grid-template-columns:repeat(auto-fill,minmax(340px,1fr))">${d.cards.map((c) => `<div class="card" style="${S.cart.has(c.id) ? 'border-color:var(--accent)' : ''}"><h3>${c.kind === 'routine' ? 'Routine' : 'Memory'} · ${esc(c.title)}</h3><div>${esc(c.what)}</div>
      <div class="kv"><span>when <b>${esc(c.when)}</b></span><span>saves <b>${esc(c.saves)}</b></span>${c.routine ? `<span>${esc(c.routine.mode)}</span>` : ''}</div>${c.examples.map((x) => `<div class="line-ev">“${esc(short(x, 140))}”</div>`).join('')}
      <div class="row"><label class="chk"><input type="checkbox" data-act="cart" data-id="${c.id}" ${S.cart.has(c.id) ? 'checked' : ''}> add to cart</label></div></div>`).join('')}</div>
      <div class="row" style="margin-top:14px"><b>Cart: ${S.cart.size}</b><button class="btn" data-act="cartCopy" ${S.cart.size ? '' : 'disabled'}>Copy cart</button><button class="btn pri" data-act="cartSetup" ${S.cart.size ? '' : 'disabled'}>Set up the ones in my cart</button><span class="hint">Routines start passive or active as shown, capped at $2/week; memory cards go to that agent as feedback to calibrate.</span></div>` : '<div class="empty">No suggestions right now. They appear when you ask for the same kind of job 3+ times in a week, or correct an agent on the same thing twice.</div>');
  },
};
