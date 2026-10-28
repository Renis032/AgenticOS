'use strict';
// The Brain app: what the agents know (knowledge graph), how work flows through the office (decision flow), and what to improve
// (optimizer). Data comes from /api/brain/* (lib/brain.js). The knowledge map is drawn by public/ui/os/brainmap.js.

const BRAIN_TYPES = [
  // type, label, sprite badge, icon (24×24, drawn as strokes)
  // Every kind has its own colour (--c-<type> in os.css). Eight colours cannot all be told apart by colour alone, so the
  // icon carries the kind too: the legend, the side panel and the map all use the same sprite.
  ['agent', 'Agents', 'circle', '<circle cx="12" cy="8.2" r="3.7"/><path d="M5 20.2c.9-3.7 3.7-5.6 7-5.6s6.1 1.9 7 5.6"/>'],
  ['memory', 'Memories', 'tile', '<path d="M17.5 20.5 12 16.6l-5.5 3.9V5.2c0-1 .8-1.7 1.7-1.7h7.6c1 0 1.7.8 1.7 1.7Z"/>'],
  ['page', 'Library pages', 'tile', '<path d="M3 4.5h5.2A3.8 3.8 0 0 1 12 8.3v12a3 3 0 0 0-3-3H3Z"/><path d="M21 4.5h-5.2A3.8 3.8 0 0 0 12 8.3v12a3 3 0 0 1 3-3h6Z"/>'],
  ['skill', 'Skills', 'tile', '<path d="m11 3.5 1.9 5.1 5.1 1.9-5.1 1.9L11 17.5l-1.9-5.1L4 10.5l5.1-1.9Z"/><path d="M18.5 15v5M16 17.5h5"/>'],
  ['handoff', 'Project handoffs', 'tile', '<path d="M14 3.5H6.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V9Z"/><path d="M14 3.5V9h5.5"/><path d="M8.5 15h7M12.5 12l3 3-3 3"/>'],
  ['instructions', 'Instructions', 'tile', '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><path d="M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01"/>'],
  ['project', 'Projects', 'tile', '<path d="M21 18.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h4.5l2 3H19a2 2 0 0 1 2 2Z"/>'],
  ['job', 'Jobs', 'circle', '<path d="M21 12h-5.5l-1.8 2.8h-3.4L8.5 12H3"/><path d="M6 6 3 12v5.5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V12l-3-6a2 2 0 0 0-1.8-1H7.8A2 2 0 0 0 6 6Z"/>'],
];
const BT = Object.fromEntries(BRAIN_TYPES.map(([t, l, badge, icon]) => [t, { label: l, badge, icon, color: `var(--c-${t})` }]));
S.brain = { view: pref('brainView', 'map') === 'table' ? 'table' : 'map', tab: pref('brainTab', 'knowledge'), hidden: new Set(prefObj('brainHidden') || ['job']), q: '', sel: null, days: 30 };

// A kind's sprite as SVG: a coloured badge (circle for people and jobs, rounded tile for the rest) with a white icon.
// `color` is any CSS colour; the map passes resolved hex because it rasterises the sprite for its canvas.
function spriteSvg(type, size, color) {
  const t = BT[type], c = color || t.color;
  const badge = t.badge === 'circle' ? `<circle cx="12" cy="12" r="11.2" fill="${c}"/>` : `<rect x="0.8" y="0.8" width="22.4" height="22.4" rx="6.2" fill="${c}"/>`;
  const sheen = t.badge === 'circle' ? '<path d="M1.6 11A10.4 10.4 0 0 1 22.4 11Z" fill="#fff" opacity=".14"/>' : '<path d="M1.6 7A5.4 5.4 0 0 1 7 1.6h10A5.4 5.4 0 0 1 22.4 7v4H1.6Z" fill="#fff" opacity=".12"/>';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" class="bsprite">${badge}${sheen}` +
    `<g transform="translate(4.6 4.6) scale(.617)" fill="none" stroke="#fff" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">${t.icon}</g></svg>`;
}

// ---------------------------------------------------------------- the app
APPS.brain = {
  mount(root) {
    const B = S.brain;
    root.innerHTML = `<div class="app brain"><div class="toolbar"><h1>Brain</h1>
        <div class="seg">${[['knowledge', 'Knowledge'], ['flow', 'Flow'], ['optimize', 'Optimize']].map(([k, l]) => `<button class="${B.tab === k ? 'on' : ''}" data-act="brainTab" data-tab="${k}">${l}<span class="bcount" id="bc-${k}"></span></button>`).join('')}</div>
        <span class="sp"></span><span id="brainTools"></span><button class="btn sm" data-act="brainRefresh" title="Rebuild from the latest data">${ic('reload')} Refresh</button></div>
      <div class="brain-body"><div class="brain-main" id="brainMain">${skel(8)}</div><aside class="brain-side" id="brainSide"></aside></div></div>`;
    B.data = B.data || {};
    this.load();
  },
  async load(fresh) {
    const B = S.brain;
    const q = fresh ? '?fresh=1' : '';
    const [k, f, o] = await Promise.all([api('GET', `/api/brain/knowledge${q}`).catch(() => null), api('GET', `/api/brain/flow?days=${B.days}`).catch(() => null), api('GET', '/api/brain/findings').catch(() => [])]);
    B.data = { knowledge: k, flow: f, findings: o };
    if (S.app !== 'brain') return;
    const counts = { knowledge: k ? k.nodes.length : '', flow: f ? f.nodes.length : '', optimize: o.length || '' };
    for (const [key, v] of Object.entries(counts)) { const el = $(`#bc-${key}`); if (el) el.textContent = v ? ` ${v}` : ''; }
    this.render();
    if (f && !f.usageReady) setTimeout(() => { if (S.app === 'brain') api('GET', `/api/brain/flow?days=${B.days}`).then((x) => { B.data.flow = x; if (B.tab === 'flow') this.render(); }); }, 6000);
  },
  update() {},
  render() {
    const B = S.brain;
    if (B.tab === 'knowledge') return renderKnowledge();
    if (B.tab === 'flow') return renderFlow();
    return renderOptimize();
  },
};

// ---------------------------------------------------------------- knowledge view
function renderKnowledge() {
  const B = S.brain, K = B.data.knowledge;
  const main = $('#brainMain');
  if (!K) { main.innerHTML = '<div class="empty">Could not load the knowledge graph.</div>'; return; }
  const counts = {};
  for (const n of K.nodes) counts[n.type] = (counts[n.type] || 0) + 1;
  $('#brainTools').innerHTML = `<input class="in" id="brainQ" placeholder="Find in the brain…" value="${esc(B.q)}" style="width:200px"> <div class="seg">${[['map', 'Map'], ['table', 'Table']].map(([v, l]) => `<button class="${B.view === v ? 'on' : ''}" data-act="brainView" data-v="${v}">${l}</button>`).join('')}</div>`;
  $('#brainQ').oninput = (e) => { B.q = e.target.value; if (B.view === 'table') renderBrainTable(); else BrainMap.search(B.q); };
  $('#brainQ').onkeydown = (e) => {
    if (e.key !== 'Enter' || B.view === 'table') return;
    e.preventDefault();
    const n = BrainMap.findNext();
    $('#brainQ').title = n ? `${n} match${n === 1 ? '' : 'es'} · Enter for the next` : 'No match';
  };
  BrainMap.stop();
  if (B.view === 'table') return renderBrainTable();
  return renderBrainMap(counts);
}
function nodeTip(n) {
  const bits = [n.tokens ? `${n.tokens.toLocaleString()} tokens` : '', n.carried ? 'in every call' : '', n.reads ? `read ${n.reads}× in 30 days` : '', n.updatedAt ? `updated ${ago(n.updatedAt)}` : '',
    n.type === 'agent' ? `${n.tasks} ${n.resident ? 'jobs' : 'tasks'}${n.model ? ` · ${n.model}` : ''}` : '', n.type === 'job' ? `${n.status} · ${money(n.costUsd)}` : ''].filter(Boolean);
  return `<b>${esc(n.label)}</b><div class="hint">${esc(BT[n.type].label.replace(/s$/, ''))}${n.sub ? ` · ${esc(short(n.sub, 60))}` : ''}</div>${bits.length ? `<div>${esc(bits.join(' · '))}</div>` : ''}`;
}
function sideSummary() {
  const K = S.brain.data.knowledge;
  if (!K) return;
  const carried = K.nodes.filter((n) => n.carried).sort((a, b) => (b.carriedWeekTokens || 0) - (a.carriedWeekTokens || 0)).slice(0, 6);
  const tokens = (t) => K.nodes.filter((n) => n.type === t).reduce((s, n) => s + (n.tokens || 0), 0);
  $('#brainSide').innerHTML = `<h3>The office's knowledge</h3>
    <div class="kv" style="flex-direction:column;gap:2px">${BRAIN_TYPES.filter(([t]) => t !== 'agent' && t !== 'job' && t !== 'project').map(([t, l]) => `<span>${esc(l)}: <b>${K.nodes.filter((n) => n.type === t).length}</b> · ${tokens(t).toLocaleString()} tokens</span>`).join('')}</div>
    <div class="label" style="margin-top:14px">Carried in every call (last 7 days)</div>
    ${carried.map((n) => `<div class="li" data-act="brainSel" data-id="${esc(n.id)}"><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(n.label)}</span><span class="hint">${((n.carriedWeekTokens || 0) / 1e6).toFixed(2)}M</span></div>`).join('') || '<div class="hint">Nothing yet.</div>'}
    <div class="hint" style="margin-top:12px">Memories, routers and role instructions are re-sent with every call of the agents that carry them, so their size counts many times over. Library pages, skills and handoffs are read only when needed.</div>`;
}
async function showNode(id) {
  const side = $('#brainSide');
  if (!side) return;
  side.innerHTML = skel(4);
  const d = await api('GET', `/api/brain/node?id=${encodeURIComponent(id)}`).catch((e) => ({ error: e.message }));
  if (S.brain.sel !== id || S.app !== 'brain') return;
  if (d.error) { side.innerHTML = `<div class="hint">${esc(d.error)}</div>`; return; }
  const K = S.brain.data.knowledge;
  const label = (nid) => { const n = K.nodes.find((x) => x.id === nid); return n ? n.label : nid; };
  const groups = {};
  for (const l of d.links) { const k = `${l.dir === 'out' ? '' : '← '}${l.kind}`; (groups[k] = groups[k] || []).push(l); }
  const findings = (S.brain.data.findings || []).filter((f) => f.node === id);
  side.innerHTML = `<div class="bhead">${spriteSvg(d.type, 22)}<div><h3>${esc(d.label)}</h3><div class="hint">${esc(BT[d.type].label.replace(/s$/, ''))}${d.sub ? ` · ${esc(d.sub)}` : ''}</div></div><button class="tb-ic" data-act="brainSel" data-id="" title="Close">${ic('close')}</button></div>
    <div class="kv" style="flex-wrap:wrap;margin:8px 0">${[d.tokens ? `<span><b>${d.tokens.toLocaleString()}</b> tokens</span>` : '', d.carried ? `<span>in every call of <b>${d.carriedBy.length}</b> agent${d.carriedBy.length === 1 ? '' : 's'}</span>` : '', d.carriedWeekTokens ? `<span><b>${(d.carriedWeekTokens / 1e6).toFixed(2)}M</b> tokens/week</span>` : '', `<span>read <b>${d.reads || 0}×</b> in 30 days</span>`, d.updatedAt ? `<span>updated <b>${ago(d.updatedAt)}</b></span>` : '', d.entries ? `<span><b>${d.entries}</b> entries</span>` : '', d.sessions ? `<span><b>${d.sessions}</b> sessions</span>` : '', d.costUsd ? `<span><b>${money(d.costUsd)}</b></span>` : ''].join('')}</div>
    ${findings.map((f) => findingCard(f, true)).join('')}
    <div class="row" style="margin:6px 0">${d.file ? `<button class="btn sm" data-act="openFile" data-p="${esc(d.file)}">${ic('open')} Open file</button>` : ''}${d.ticketId ? `<button class="btn sm" data-act="openJob" data-id="${esc(d.ticketId)}">${ic('jobs')} Open job</button>` : ''}${d.type === 'agent' ? `<button class="btn sm" data-act="brainAgent" data-id="${esc(d.id.slice(6))}">${ic('processes')} Open process</button>` : ''}</div>
    <div class="label" style="margin-top:10px">Connections</div>
    ${Object.entries(groups).map(([k, list]) => `<div class="hint" style="margin-top:6px">${esc(k)}</div>${list.slice(0, 14).map((l) => `<div class="li" data-act="brainSel" data-id="${esc(l.other)}"><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(label(l.other))}</span>${l.count ? `<span class="hint">${l.count}×</span>` : ''}</div>`).join('')}${list.length > 14 ? `<div class="hint">+${list.length - 14} more</div>` : ''}`).join('') || '<div class="hint">No connections.</div>'}
    ${d.content ? `<div class="label" style="margin-top:12px">Content${d.contentTruncated ? ' (start)' : ''}</div><div class="md bcontent">${mdRich(d.content.replace(/^---\n[\s\S]*?\n---\n*/, ''))}</div>` : ''}
    ${d.answer ? `<div class="label" style="margin-top:12px">Answer</div><div class="md bcontent">${mdRich(d.answer)}</div>` : ''}`;
}

// The knowledge as a map of solid figures on a plane, with physics (public/ui/os/brainmap.js).
function renderBrainMap(counts) {
  const B = S.brain, K = B.data.knowledge;
  $('#brainMain').innerHTML = `<div class="blegend">${BRAIN_TYPES.map(([t, l]) => `<button class="bchip ${B.hidden.has(t) ? 'off' : ''}" data-act="brainType" data-t="${t}">${spriteSvg(t, 16)}${esc(l)} <span class="hint">${counts[t] || 0}</span></button>`).join('')}
      <span class="hint" style="margin-left:auto">Drag a node to pull its neighbours · drag space to pan · scroll to zoom · double-click to fit · Enter in search finds</span></div>
    <div class="bgraph bmapwrap" id="bgraph"><div class="btip" id="btip"></div>${timeBar(K)}</div>`;
  const visible = { nodes: K.nodes.filter((n) => !B.hidden.has(n.type)), edges: K.edges };
  BrainMap.start($('#bgraph'), visible, {
    sel: B.sel,
    until: B.until || 0,
    onSelect: (id) => { B.sel = id; if (id) showNode(id); else sideSummary(); },
    onHover: (n, ev) => {
      const tip = $('#btip');
      if (!tip) return;
      if (!n || !ev) { tip.style.display = 'none'; return; }
      const r = $('#bgraph').getBoundingClientRect();
      tip.innerHTML = nodeTip(n); tip.style.display = 'block';
      tip.style.left = Math.min(r.width - 280, ev.clientX - r.left + 16) + 'px'; tip.style.top = (ev.clientY - r.top + 16) + 'px';
    },
  });
  BrainMap.search(B.q);
  wireTimeBar(K);
  if (B.sel) showNode(B.sel); else sideSummary();
}

// The time filter: a slider over the weeks since the first node appeared; the map shows only what existed by then.
// ▶ plays it week by week, so you watch the knowledge grow.
const WEEK = 7 * 86400000;
function timeWeeks(K) {
  const first = Math.min(...K.nodes.map((n) => n.createdAt).filter((t) => t > 0), Date.now());
  return Math.max(1, Math.ceil((Date.now() - first) / WEEK));
}
function timeBar(K) {
  const weeks = timeWeeks(K), v = S.brain.until ? Math.max(0, weeks - Math.ceil((Date.now() - S.brain.until) / WEEK)) : weeks;
  return `<div class="btime"><button class="btn sm" id="bPlay" title="Play: watch the knowledge grow week by week">▶</button>
    <input type="range" id="bTime" min="0" max="${weeks}" step="1" value="${v}" aria-label="Show the knowledge as it was"><span class="hint" id="bTimeL"></span></div>`;
}
function wireTimeBar(K) {
  const B = S.brain, weeks = timeWeeks(K), range = $('#bTime');
  const label = (v) => { const t = v >= weeks ? 0 : Date.now() - (weeks - v) * WEEK; $('#bTimeL').textContent = t ? `as of ${new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} · ${K.nodes.filter((n) => !B.hidden.has(n.type) && (n.createdAt || 0) <= t).length} nodes` : 'now · everything'; return t; };
  const apply = (v) => { B.until = label(v); BrainMap.setUntil(B.until); };
  label(+range.value);
  range.oninput = () => { clearInterval(B.play); B.play = null; $('#bPlay').textContent = '▶'; apply(+range.value); };
  $('#bPlay').onclick = () => {
    if (B.play) { clearInterval(B.play); B.play = null; $('#bPlay').textContent = '▶'; return; }
    if (+range.value >= weeks) range.value = 0;
    $('#bPlay').textContent = '❚❚';
    apply(+range.value);
    B.play = setInterval(() => {
      if (!document.body.contains(range) || +range.value >= weeks) { clearInterval(B.play); B.play = null; if (document.body.contains(range)) $('#bPlay').textContent = '▶'; return; }
      range.value = +range.value + 1; apply(+range.value);
    }, 900);
  };
}

// The same knowledge as a table: every node, sortable, for reading exact values (and when colour is hard to tell apart).
function renderBrainTable() {
  const B = S.brain, K = B.data.knowledge;
  const q = B.q.trim().toLowerCase();
  const sort = B.sort || 'carried';
  const rows = K.nodes.filter((n) => !B.hidden.has(n.type) && (!q || `${n.label} ${n.sub || ''}`.toLowerCase().includes(q)))
    .sort((a, b) => sort === 'name' ? a.label.localeCompare(b.label) : sort === 'tokens' ? (b.tokens || 0) - (a.tokens || 0) : sort === 'reads' ? (b.reads || 0) - (a.reads || 0) : sort === 'updated' ? (b.updatedAt || 0) - (a.updatedAt || 0) : (b.carriedWeekTokens || 0) - (a.carriedWeekTokens || 0) || (b.tokens || 0) - (a.tokens || 0));
  const th = (k, l) => `<th data-act="brainSort" data-k="${k}" class="${sort === k ? 'on' : ''}">${l}</th>`;
  $('#brainMain').innerHTML = `<div class="blegend">${BRAIN_TYPES.map(([t, l]) => `<button class="bchip ${B.hidden.has(t) ? 'off' : ''}" data-act="brainType" data-t="${t}">${spriteSvg(t, 16)}${esc(l)}</button>`).join('')}</div>
    <div class="scroll" style="flex:1;overflow:auto"><table class="ps btable"><thead><tr>${th('name', 'Name')}<th>Type</th>${th('tokens', 'Tokens')}${th('carried', 'Carried per week')}${th('reads', 'Reads (30 d)')}${th('updated', 'Updated')}<th>Links</th></tr></thead><tbody>
    ${rows.map((n) => `<tr data-act="brainSel" data-id="${esc(n.id)}" class="${B.sel === n.id ? 'on' : ''}"><td><b>${esc(n.label)}</b>${n.sub ? `<div class="hint">${esc(short(n.sub, 70))}</div>` : ''}</td><td>${esc(BT[n.type].label.replace(/s$/, ''))}</td><td class="num">${n.tokens ? n.tokens.toLocaleString() : ''}</td><td class="num">${n.carriedWeekTokens ? `${(n.carriedWeekTokens / 1e6).toFixed(2)}M` : n.carried ? '0' : ''}</td><td class="num">${n.reads || ''}</td><td class="num">${n.updatedAt ? ago(n.updatedAt) : ''}</td><td class="num">${K.edges.filter((e) => e.from === n.id || e.to === n.id).length}</td></tr>`).join('')}
    </tbody></table></div>`;
  if (B.sel) showNode(B.sel); else sideSummary();
}

// ---------------------------------------------------------------- flow view
// Split a heading into lines of at most n characters (at most two; the rest is cut).
function wrapWords(text, n) {
  const lines = [''];
  for (const w of text.split(' ')) { const cur = lines[lines.length - 1]; if (cur && (cur + ' ' + w).length > n) lines.push(w); else lines[lines.length - 1] = cur ? `${cur} ${w}` : w; }
  return lines.length > 2 ? [lines[0], short(lines.slice(1).join(' '), n)] : lines;
}
function renderFlow() {
  const B = S.brain, F = B.data.flow;
  const main = $('#brainMain');
  $('#brainTools').innerHTML = `<select id="brainDays">${[7, 30, 90].map((d) => `<option value="${d}" ${B.days === d ? 'selected' : ''}>Last ${d} days</option>`).join('')}</select>`;
  $('#brainDays').onchange = (e) => { B.days = Number(e.target.value); APPS.brain.load(); };
  if (!F) { main.innerHTML = '<div class="empty">Could not load the flow.</div>'; return; }
  main.innerHTML = `<div class="bflow" id="bflow"></div>`;
  const box = $('#bflow').getBoundingClientRect();
  // Columns share the width, with room after the last one for its labels; below 118px a column scrolls sideways instead.
  const cols = F.columns.length, lastW = 170, colW = Math.max(118, (box.width - 24 - lastW) / Math.max(1, cols - 1)), W = colW * (cols - 1) + lastW + 14, H = Math.max(460, box.height - 10), nodeW = 12, top = 54;
  const units = ['jobs', 'jobs', 'jobs', 'model picks', 'teammate tasks', 'tool calls', 'jobs', 'events'];
  const pos = new Map();
  for (let c = 0; c < cols; c++) {
    const list = F.nodes.filter((n) => n.col === c && n.value > 0).sort((a, b) => b.value - a.value);
    const total = list.reduce((s, n) => s + n.value, 0) || 1;
    const gap = 10, avail = H - top - gap * Math.max(0, list.length - 1) - 10;
    let y = top;
    for (const n of list) {
      const hgt = Math.max(18, (n.value / total) * avail);
      pos.set(n.id, { x: c * colW + 10, y, h: hgt, n, outY: y, inY: y });
      y += hgt + gap;
    }
  }
  const maxByPair = {};
  for (const e of F.edges) { const a = F.nodes.find((n) => n.id === e.from), b = F.nodes.find((n) => n.id === e.to); if (!a || !b) continue; const k = `${a.col}-${b.col}`; maxByPair[k] = Math.max(maxByPair[k] || 0, e.value); }
  const bands = [];
  for (const e of F.edges.sort((x, y) => y.value - x.value)) {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) continue;
    const k = `${a.n.col}-${b.n.col}`;
    // Square-root scaling and a cap keep the big flows readable without swamping the small ones.
    const wdt = Math.max(1.5, Math.min(a.h * 0.6, b.h * 0.6, 34, Math.sqrt(e.value / maxByPair[k]) * 34));
    const y1 = a.outY + wdt / 2, y2 = b.inY + wdt / 2;
    a.outY = Math.min(a.y + a.h - wdt / 2, a.outY + wdt); b.inY = Math.min(b.y + b.h - wdt / 2, b.inY + wdt);
    const x1 = a.x + nodeW, x2 = b.x, mx = (x1 + x2) / 2;
    bands.push(`<path class="fband" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" stroke-width="${wdt.toFixed(1)}" data-tip="${esc(`${a.n.label} → ${b.n.label}: ${e.value.toLocaleString()} ${units[b.n.col]}${e.costUsd ? ` · ${money(e.costUsd)}` : ''}`)}"/>`);
  }
  const usage = F.usageReady ? '' : '<tspan class="hint"> (usage per lead loading…)</tspan>';
  const svg = `<svg width="${W}" height="${H}" class="fsvg">
    ${F.columns.map((c, i) => { const lines = wrapWords(c, Math.floor((i === cols - 1 ? lastW : colW - 8) / 7)); return `<text class="fcol" x="${i * colW + 10}" y="14">${lines.map((l, j) => `<tspan x="${i * colW + 10}" dy="${j ? 14 : 0}">${esc(l)}</tspan>`).join('')}</text><text class="fcolu" x="${i * colW + 10}" y="${14 + lines.length * 14}">${units[i]}</text>`; }).join('')}
    <g>${bands.join('')}</g>
    ${[...pos.values()].map(({ x, y, h, n }) => `<g class="fnode ${S.brain.sel === n.id ? 'sel' : ''}" data-act="brainFlowSel" data-id="${esc(n.id)}" data-tip="${esc(`${n.label}: ${n.value.toLocaleString()} ${units[n.col]}${n.costUsd ? ` · ${money(n.costUsd)}` : ''}`)}"><rect x="${x}" y="${y}" width="${nodeW}" height="${h}" rx="3"/><text x="${x + nodeW + 6}" y="${y + Math.min(h / 2, 14) + 4}">${esc(short(n.label, Math.floor(((n.col === cols - 1 ? lastW : colW) - 40) / 6.4)))} <tspan class="fval">${n.value.toLocaleString()}</tspan></text>${n.avgContext ? `<text class="fsub" x="${x + nodeW + 6}" y="${y + Math.min(h / 2, 14) + 17}">avg context ${Math.round(n.avgContext / 1000)}k</text>` : n.tasks ? `<text class="fsub" x="${x + nodeW + 6}" y="${y + Math.min(h / 2, 14) + 17}">${n.ok}/${n.tasks} finished</text>` : ''}</g>`).join('')}
    ${usage ? `<text x="${W - 8}" y="${H - 4}" text-anchor="end" class="fsub">${usage}</text>` : ''}</svg>`;
  $('#bflow').innerHTML = svg;
  if (S.brain.sel && S.brain.sel.includes(':') && F.nodes.some((n) => n.id === S.brain.sel)) showFlowNode(S.brain.sel); else flowSummary();
}
function flowSummary() {
  const F = S.brain.data.flow;
  const jobs = F.nodes.filter((n) => n.col === 0).reduce((s, n) => s + n.value, 0);
  const cost = F.nodes.filter((n) => n.col === 0).reduce((s, n) => s + n.costUsd, 0);
  const work = F.nodes.filter((n) => n.col === 5).sort((a, b) => b.value - a.value);
  const tools = work.reduce((s, n) => s + n.value, 0) || 1;
  $('#brainSide').innerHTML = `<h3>Last ${F.days} days</h3><div class="kv" style="flex-direction:column;gap:2px"><span><b>${jobs}</b> jobs · <b>${money(cost)}</b></span>${F.nodes.filter((n) => n.col === 2).map((n) => `<span>${esc(n.label)}: <b>${n.value}</b> jobs${n.avgContext ? `, ${Math.round(n.avgContext / 1000)}k context per call` : ''}</span>`).join('')}</div>
    <div class="label" style="margin-top:12px">Where the work goes</div>${work.map((n) => `<div class="hbar"><span class="n">${esc(n.label)}</span><span class="t"><i style="width:${(n.value / tools) * 100}%"></i></span><span class="v">${Math.round((n.value / tools) * 100)}%</span></div>`).join('')}
    <div class="hint" style="margin-top:12px">Columns are stages; band thickness is volume relative to the other bands between the same two stages. Hover a band for exact numbers; click a stage for details.</div>`;
}
function showFlowNode(id) {
  const F = S.brain.data.flow, n = F.nodes.find((x) => x.id === id);
  if (!n) return flowSummary();
  const ins = F.edges.filter((e) => e.to === id), outs = F.edges.filter((e) => e.from === id);
  const lbl = (nid) => (F.nodes.find((x) => x.id === nid) || {}).label || nid;
  const findings = (S.brain.data.findings || []).filter((f) => f.id.includes(id) || (n.agent && f.id.includes(n.agent)));
  $('#brainSide').innerHTML = `<div class="bhead"><div><h3>${esc(n.label)}</h3><div class="hint">${esc(F.columns[n.col])}</div></div><button class="tb-ic" data-act="brainFlowSel" data-id="" title="Close">${ic('close')}</button></div>
    <div class="kv" style="flex-wrap:wrap;margin:8px 0"><span><b>${n.value.toLocaleString()}</b></span>${n.costUsd ? `<span><b>${money(n.costUsd)}</b></span>` : ''}${n.calls ? `<span><b>${n.calls}</b> model calls</span>` : ''}${n.avgContext ? `<span>avg context <b>${Math.round(n.avgContext / 1000)}k</b></span>` : ''}${n.tasks ? `<span><b>${n.ok}/${n.tasks}</b> finished</span>` : ''}</div>
    ${n.models ? `<div class="hint">Models: ${Object.entries(n.models).map(([m, c]) => `${esc(m)} ${c}`).join(' · ')}</div>` : ''}
    ${findings.map((f) => findingCard(f, true)).join('')}
    ${ins.length ? `<div class="label" style="margin-top:10px">Comes from</div>${ins.sort((a, b) => b.value - a.value).map((e) => `<div class="li" data-act="brainFlowSel" data-id="${esc(e.from)}"><span style="flex:1">${esc(lbl(e.from))}</span><span class="hint">${e.value.toLocaleString()}</span></div>`).join('')}` : ''}
    ${outs.length ? `<div class="label" style="margin-top:10px">Goes to</div>${outs.sort((a, b) => b.value - a.value).map((e) => `<div class="li" data-act="brainFlowSel" data-id="${esc(e.to)}"><span style="flex:1">${esc(lbl(e.to))}</span><span class="hint">${e.value.toLocaleString()}</span></div>`).join('')}` : ''}`;
}

// ---------------------------------------------------------------- optimize view
const SEV = { serious: ['Serious', 'fail'], warning: ['Worth doing', 'stop'], info: ['Note', 'queue'] };
function findingCard(f, compact) {
  const [label, cls] = SEV[f.severity] || SEV.info;
  return `<div class="bfind ${compact ? 'compact' : ''}"><div class="bfh"><span class="pill s-${cls === 'fail' ? 'failed' : cls === 'stop' ? 'paused' : 'queued'}">${label}</span><span class="hint">${esc(f.group)}</span>${f.saving ? `<span class="hint" style="margin-left:auto">${esc(f.saving)}</span>` : ''}</div>
    <b>${esc(f.title)}</b><div class="hint" style="margin-top:3px">${esc(f.detail)}</div>
    <div class="row" style="margin:8px 0 0">${(f.actions || []).map((a) => `<button class="btn sm ${a.kind !== 'open' ? 'pri' : ''}" data-act="brainAction" data-kind="${esc(a.kind)}" data-target="${esc(a.target || '')}" data-fid="${esc(f.id)}">${esc(a.label)}</button>`).join('')}${f.node && !compact ? `<button class="btn sm" data-act="brainShow" data-id="${esc(f.node)}">Show in the graph</button>` : ''}</div></div>`;
}
function renderOptimize() {
  const list = S.brain.data.findings || [];
  $('#brainTools').innerHTML = '';
  const groups = ['Cost', 'Knowledge', 'Flow'];
  $('#brainMain').innerHTML = `<div class="page boptimize">${list.length ? groups.map((g) => { const l = list.filter((f) => f.group === g); return l.length ? `<div class="label">${g === 'Cost' ? 'Cost: what every call carries and how long contexts get' : g === 'Knowledge' ? 'Knowledge: stale, unused, behind or duplicated' : 'Flow: how jobs are routed and worked'}</div>${l.map((f) => findingCard(f)).join('')}` : ''; }).join('') : '<div class="empty">Nothing to improve right now.</div>'}</div>`;
  $('#brainSide').innerHTML = `<h3>Optimizer</h3><div class="kv" style="flex-direction:column;gap:2px">${['serious', 'warning', 'info'].map((s) => `<span>${SEV[s][0]}: <b>${list.filter((f) => f.severity === s).length}</b></span>`).join('')}</div>
    <div class="hint" style="margin-top:10px">Findings are worked out from the live data every time you open this: what each agent carries in every call, what nobody reads or updates, what repeats, and where jobs lose time or money. Actions either change files directly (archive) or ask the right agent to do it at the start of its next task.</div>`;
}

Object.assign(ACT, {
  brainTab: (d) => { BrainMap.stop(); S.brain.tab = d.tab; setPref('brainTab', d.tab); S.brain.sel = null; APPS.brain.mount($('#appRoot')); },
  brainRefresh: () => APPS.brain.load(true),
  brainView: (d) => { S.brain.view = d.v; setPref('brainView', d.v); renderKnowledge(); },
  brainSort: (d) => { S.brain.sort = d.k; renderBrainTable(); },
  brainType: (d) => { const h = S.brain.hidden; if (h.has(d.t)) h.delete(d.t); else h.add(d.t); setPref('brainHidden', JSON.stringify([...h])); renderKnowledge(); },
  brainSel: (d) => { S.brain.sel = d.id || null; if (S.brain.tab !== 'knowledge') { S.brain.tab = 'knowledge'; APPS.brain.mount($('#appRoot')); return; } if (S.brain.view === 'table') return renderBrainTable(); BrainMap.select(S.brain.sel); if (d.id) showNode(d.id); else sideSummary(); },
  brainShow: (d) => { S.brain.sel = d.id; S.brain.hidden.delete((d.id.split(':')[0] === 'ccskill' ? 'skill' : d.id.split(':')[0])); S.brain.tab = 'knowledge'; APPS.brain.mount($('#appRoot')); },
  brainFlowSel: (d) => { S.brain.sel = d.id || null; renderFlow(); },
  brainAgent: (d) => { S.sel = d.id; openApp('processes'); },
  brainAction: async (d) => {
    if (d.kind === 'open') return ACT.openFile({ p: d.target });
    if (d.kind === 'app') return openApp(d.target);
    if (d.kind === 'prefs') return openPrefs(d.target);
    if (d.kind === 'archive' && !confirm('Archive this?\nIt moves to the team\'s archive folder and stops being offered to agents.')) return;
    const r = await api('POST', '/api/brain/action', { kind: d.kind, target: d.target });
    notifyQuiet(r.error || r.message || 'Done');
    APPS.brain.load(true);
  },
});
