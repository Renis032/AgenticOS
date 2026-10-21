// Agentic OS app: Tokens. Every model call on this machine, exact API token counts, drill-down to what filled the context.
(function () {
  'use strict';
  const T = (S.tk = { q: { days: '30' }, tab: 'overview', metric: 'usd', data: null, loading: false, key: null, sid: null, sess: null, open: new Set(), calls: null, csort: 't', coff: 0, ssort: 'usd', err: null });
  const KINDS = [['r', 'cache read', 'usdR'], ['w', 'cache write', 'usdW'], ['in', 'fresh input', 'usdIn'], ['out', 'output', 'usdOut']];
  const FILTERS = [['source', 'sources', 'All sources'], ['team', 'teams', 'All teams'], ['agent', 'agents', 'All agents'], ['project', 'projects', 'All projects'], ['model', 'models', 'All models']];
  const RANGES = [['1', 'Last 24 hours'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['', 'All time']];
  const usd = (x) => { x = x || 0; return x >= 100 ? `$${x.toFixed(0)}` : x >= 1 ? `$${x.toFixed(2)}` : x >= 0.01 ? `$${x.toFixed(3)}` : `$${x.toFixed(4)}`; };
  const n0 = (x) => Math.round(x || 0).toLocaleString();
  const pc = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();
  const when = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const day = (d) => new Date(d + 'T12:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const kindTok = (r) => ({ r: r.r, w: r.w5 + r.w1, in: r.in, out: r.out });

  async function load() {
    T.loading = true; T.err = null; T.key = null; dirty();
    try { T.data = await api('GET', '/api/tokens/overview?' + qs(T.q)); } catch (e) { T.err = e.message; }
    T.loading = false; T.calls = null; T.key = null; dirty();
  }
  async function loadCalls() {
    T.calls = { loading: true };
    try { T.calls = await api('GET', '/api/tokens/calls?' + qs({ ...T.q, sort: T.csort, offset: T.coff, limit: 100 })); } catch (e) { T.calls = { err: e.message }; }
    T.key = null; dirty();
  }
  async function openSession(sid, callId) {
    T.sid = sid; T.sess = null; T.open = new Set(callId ? [callId] : []); T.key = null; dirty();
    try { T.sess = await api('GET', '/api/tokens/session/' + sid); } catch (e) { T.sess = { err: e.message }; }
    T.key = null; dirty();
    if (callId) setTimeout(() => { const el = document.getElementById('call-' + callId); if (el) el.scrollIntoView({ block: 'center' }); }, 50);
  }
  function setQ(k, v) { if (v === '' || v == null) delete T.q[k]; else T.q[k] = v; T.coff = 0; T.sid = null; load(); }

  function filtersBar() {
    const d = T.data, F = (d && d.filters) || {};
    const sel = (k, list, all) => `<select data-tkf="${k}"><option value="">${all}</option>${(list || []).map((v) => `<option ${T.q[k] === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>`;
    const chips = ['day', 'ticket', 'session'].filter((k) => T.q[k]).map((k) => `<span class="pill" style="cursor:pointer" data-act="tkClear" data-k="${k}" title="Remove this filter">${k} ${esc(k === 'session' ? T.q[k].slice(0, 8) : T.q[k])} ✕</span>`).join('');
    return `<select data-tkf="days">${RANGES.map(([v, l]) => `<option value="${v}" ${(T.q.days || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>` + FILTERS.map(([k, l, a]) => sel(k, F[l], a)).join('') + chips;
  }

  function tiles(d) {
    const t = d.total;
    const avg = t.calls ? d.sent / t.calls : 0;
    const tile = (label, big, sub) => `<div class="card"><h3>${label}</h3><div class="big">${big}</div><div class="hint">${sub}</div></div>`;
    return `<div class="cards">${tile('Tokens', tokens(t.tokens), `${n0(t.tokens)} tokens in ${n0(t.calls)} model calls`)}${tile('At API prices', usd(t.usd), 'what this would cost on the API; on a subscription it is the weight against your limits')}
      ${tile('Context per call', tokens(avg), `average sent per call · peak ${d.peak ? tokens(d.peak.tokens) : '—'}${d.peak ? ` in “${esc((d.peak.label || '').slice(0, 40))}”` : ''}`)}
      ${tile('Output', tokens(t.out), `${n0(t.out)} written by Claude · ${n0(t.th)} of it thinking · ${n0(t.ws)} web searches`)}
      ${tile('Jev routing', usd(d.jev.usd), `${n0(d.jev.calls)} decisions on OpenRouter · ${n0(d.jev.tokensIn + d.jev.tokensOut)} tokens logged`)}</div>`;
  }

  function kindTable(d) {
    const t = d.total, all = t.tokens || 1;
    const rows = [['Cache read: earlier context re-sent each call', t.r, t.usdR], ['Cache write, 5-minute cache', t.w5, null], ['Cache write, 1-hour cache', t.w1, null], ['Fresh input (not cached)', t.in, t.usdIn],
      [`Output (incl. ${n0(t.th)} thinking)`, t.out, t.usdOut], ['Web searches', null, t.usdWeb]];
    return `<div class="card" style="grid-column:1/-1"><h3>Every token by kind</h3><div style="overflow-x:auto"><table class="ps" style="table-layout:auto"><thead><tr><th>Kind</th><th class="num">Tokens</th><th class="num">Share</th><th class="num">API $</th><th class="num">Share of $</th></tr></thead><tbody>${rows.map(([k, n, u]) => `<tr><td>${k}</td><td class="num">${n == null ? `${n0(t.ws)} searches` : n0(n)}</td><td class="num">${n == null ? '' : pc(n, all)}</td><td class="num">${u == null ? '' : usd(u)}</td><td class="num">${u == null ? '' : pc(u, t.usd)}</td></tr>`).join('')}
      <tr><td><b>Cache writes together</b></td><td class="num">${n0(t.w5 + t.w1)}</td><td class="num">${pc(t.w5 + t.w1, all)}</td><td class="num">${usd(t.usdW)}</td><td class="num">${pc(t.usdW, t.usd)}</td></tr>
      <tr><td><b>Total</b></td><td class="num"><b>${n0(t.tokens)}</b></td><td></td><td class="num"><b>${usd(t.usd)}</b></td><td></td></tr></tbody></table></div><div class="hint" style="margin-top:6px">${esc(d.prices)}</div></div>`;
  }

  function dayChart(d) {
    if (!d.dims.day.length) return '';
    const have = new Map(d.dims.day.map((r) => [r.key, r]));
    const days = [];
    for (let t = Date.parse(d.dims.day[0].key + 'T12:00'), end = Date.parse(d.dims.day[d.dims.day.length - 1].key + 'T12:00'); t <= end; t += 86400000) {
      const k = new Date(t).toLocaleDateString('sv');
      days.push(have.get(k) || { key: k, calls: 0, in: 0, w5: 0, w1: 0, r: 0, out: 0, th: 0, usd: 0, usdIn: 0, usdW: 0, usdR: 0, usdOut: 0 });
    }
    const val = (r, k) => (T.metric === 'usd' ? r[KINDS.find((x) => x[0] === k)[2]] : kindTok(r)[k]);
    const max = Math.max(1e-9, ...days.map((r) => KINDS.reduce((a, [k]) => a + val(r, k), 0)));
    const fmt = (x) => (T.metric === 'usd' ? usd(x) : tokens(x));
    const cols = days.map((r) => {
      const sum = KINDS.reduce((a, [k]) => a + val(r, k), 0);
      const segs = KINDS.slice().reverse().map(([k, l], i) => { const v = val(r, k); return v ? `<i style="height:${(v / max) * 100}%;background:var(--k-${k})" class="${i === 0 ? 'top' : ''}"></i>` : ''; }).join('');
      const tip = `${day(r.key)}: ${fmt(sum)} · ${KINDS.map(([k, l]) => `${l} ${fmt(val(r, k))}`).join(' · ')} · ${n0(r.calls)} calls`;
      return `<div class="tk-col" data-tip="${esc(tip)}" data-act="tkFilter" data-k="day" data-v="${r.key}">${segs}</div>`;
    }).join('');
    return `<div class="card tkv" style="grid-column:1/-1"><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><h3 style="margin:0">By day</h3>
      <span class="tk-legend">${KINDS.map(([k, l]) => `<span><i style="background:var(--k-${k})"></i>${l}</span>`).join('')}</span><span class="sp" style="flex:1"></span>
      <button class="btn sm ${T.metric === 'usd' ? 'pri' : ''}" data-act="tkMetric" data-m="usd">API $</button><button class="btn sm ${T.metric === 'tokens' ? 'pri' : ''}" data-act="tkMetric" data-m="tokens">Tokens</button></div>
      <div class="tk-chart">${cols}</div><div class="hint" style="display:flex;justify-content:space-between"><span>${day(days[0].key)}</span><span>peak ${fmt(max)}/day · click a day to filter</span><span>${day(days[days.length - 1].key)}</span></div>
      <details style="margin-top:8px"><summary class="hint">Table</summary>${table(['Day', 'Calls', 'Fresh in', 'Write 5m', 'Write 1h', 'Cache read', 'Output', 'Thinking', 'API $'], days.slice().reverse().map((r) => [day(r.key), n0(r.calls), n0(r.in), n0(r.w5), n0(r.w1), n0(r.r), n0(r.out), n0(r.th), usd(r.usd)]), days.slice().reverse().map((r) => `data-act="tkFilter" data-k="day" data-v="${r.key}"`))}</details></div>`;
  }

  const isNum = (c) => /^(<b>)?[-+~]?\$?[\d.,]+[kM%]?( searches| ms| \/ [\d.,]+|\+[\d.,]+)?(<\/b>)?$/.test(String(c).trim());
  function table(head, rows, attrs) {
    const num = head.map((h, i) => i > 0 && rows.length > 0 && rows.every((r) => r[i] === '' || r[i] === '—' || isNum(r[i])));
    return `<div style="overflow-x:auto"><table class="ps" style="table-layout:auto"><thead><tr>${head.map((h, i) => `<th class="${num[i] ? 'num' : ''}">${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r, j) => `<tr ${attrs ? attrs[j] || '' : ''}>${r.map((c, i) => `<td class="${num[i] ? 'num' : ''}">${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  function dim(title, rows, k, wide) {
    if (!rows || !rows.length) return '';
    const total = rows.reduce((a, r) => a + r.usd, 0) || 1;
    const max = Math.max(1e-9, ...rows.map((r) => r.usd));
    const fk = { source: 'source', team: 'team', agent: 'agent', project: 'project', model: null, ticket: 'ticket' }[k];
    return `<div class="card" ${wide ? 'style="grid-column:1/-1"' : ''}><h3>${title}</h3><div style="overflow-x:auto"><table class="ps" style="table-layout:auto"><thead><tr><th></th><th class="num">Calls</th><th class="num">Tokens</th><th class="num">Output</th><th class="num">API $</th><th style="width:30%"></th></tr></thead><tbody>${rows.map((r) => {
      const v = k === 'ticket' ? r.key.slice(1) : k === 'model' ? 'claude-' + r.key : r.key;
      const act = fk || k === 'model' ? `data-act="tkFilter" data-k="${k === 'model' ? 'model' : fk}" data-v="${esc(v)}"` : '';
      return `<tr ${act} data-tip="${esc(`${r.key}: fresh ${n0(r.in)} · write ${n0(r.w5 + r.w1)} · read ${n0(r.r)} · out ${n0(r.out)} · thinking ${n0(r.th)}`)}"><td>${esc(r.key)}</td><td class="num">${n0(r.calls)}</td><td class="num">${tokens(r.tokens)}</td><td class="num">${tokens(r.out)}</td><td class="num">${usd(r.usd)}</td><td><div class="tk-bar"><i style="width:${(r.usd / max) * 100}%"></i></div><span class="hint">${pc(r.usd, total)}</span></td></tr>`;
    }).join('')}</tbody></table></div></div>`;
  }

  function overviewTab(d) {
    const D = d.dims;
    if (T.live === undefined) { T.live = null; api('GET', '/api/tokens/live?min=150000').then((l) => { T.live = l; T.key = null; dirty(); }).catch(() => {}); }
    const live = T.live && T.live.length ? `<div class="card" style="margin-top:12px;border-color:var(--stop)"><h3>Long chats right now</h3>${table(['Chat', 'Project', 'Context per message', 'Each message costs', 'Last active'], T.live.map((c) => [esc(c.label.slice(0, 60)), esc(c.project), tokens(c.tokens), usd(c.perCallUsd), when(c.lastAt)]), T.live.map((c) => `data-act="tkSession" data-sid="${c.sid}"`))}<div class="hint" style="margin-top:6px">Every message re-sends the whole context. Over 300k, finish the task and start a new chat (/clear) or run /compact.</div></div>` : '';
    return tiles(d) + live + `<div class="cards" style="margin-top:12px;grid-template-columns:repeat(auto-fill,minmax(420px,1fr))">${dayChart(d)}${kindTable(d)}
      ${dim('Who: source', D.source, 'source')}${dim('Teams', D.team, 'team')}${dim('Agents (and you)', D.agent, 'agent', true)}${dim('Roles', D.role, 'role')}
      ${dim('Jobs', D.ticket, 'ticket')}${dim('Projects', D.project, 'project')}${dim('Models', D.model, 'model')}${dim('Hour of day', D.hour, 'hour')}${dim('Weekday', D.weekday, 'weekday')}
      ${dim('Main thread vs subagents', D.thread, 'thread')}${dim('Service tier', D.tier, 'tier')}${dim('How calls ended (stop reason)', D.stop, 'stop')}</div>`;
  }

  function contextTab(d) {
    const max = Math.max(1, ...d.context.map((c) => c.tokens));
    return `<div class="hint" style="margin:4px 0 10px;max-width:900px">What made up the context of every call, summed over calls (a file read once and kept for 100 calls counts 100 times). Sizes are estimated from content length (about 4 characters per token); they explain <b>${Math.round(d.contextExplained * 100)}%</b> of the ${tokens(d.sent)} tokens actually sent. The rest is images, compaction summaries, formatting and counting slack. The token totals elsewhere are exact.</div>
      <div class="cards" style="grid-template-columns:repeat(auto-fill,minmax(460px,1fr))"><div class="card"><h3>Context by category</h3><table class="ps" style="table-layout:auto"><thead><tr><th>Category</th><th class="num">Tokens carried</th><th class="num">Share</th><th style="width:34%"></th></tr></thead><tbody>${d.context.map((c) => `<tr><td>${esc(c.label)}</td><td class="num">${tokens(c.tokens)}</td><td class="num">${pc(c.share, 1)}</td><td><div class="tk-bar"><i style="width:${(c.tokens / max) * 100}%"></i></div></td></tr>`).join('')}</tbody></table></div>
      <div class="card"><h3>Tool results</h3>${table(['Tool', 'Results', 'Tokens added', 'Carried', 'Avg size'], d.tools.map((t) => [esc(t.key), n0(t.n), tokens(t.tokens), tokens(t.carried), tokens(t.n ? t.tokens / t.n : 0)]))}
      <div class="hint" style="margin-top:8px">Your typed messages: ${n0(d.prompts.n)}, about ${tokens(d.prompts.tokens)} tokens.</div></div>
      <div class="card" style="grid-column:1/-1"><h3>Biggest single things that entered a context</h3>${table(['Size', 'What', 'Item', 'Session', 'Who', 'When'], d.biggest.map((b) => [tokens(b.tok), esc(b.catLabel), esc(b.label.slice(0, 110)), esc((b.session || '').slice(0, 40)), esc(b.agent), when(b.t)]), d.biggest.map((b) => `data-act="tkSession" data-sid="${b.sid}"`))}</div></div>`;
  }

  function cacheBody(c, scope) {
    const t = c.total;
    const tile = (label, big, sub) => `<div class="card"><h3>${label}</h3><div class="big">${big}</div><div class="hint">${sub}</div></div>`;
    const bars = (rows, total, val, label) => { const max = Math.max(1e-9, ...rows.map(val)); return rows.map((r) => [label(r), tokens(r.tokens != null ? r.tokens : r.r), usd(r.usd), pc(r.usd, total), `<div class="tk-bar"><i style="width:${(val(r) / max) * 100}%"></i></div>`]); };
    let h = `<div class="cards">${tile('Cache read', tokens(t.r), `${n0(t.r)} tokens re-read · ${pc(t.shareTokens, 1)} of all tokens`)}
      ${tile('At API prices', usd(t.usd), `${pc(t.shareUsd, 1)} of all spend · 0.1× the input price`)}
      ${tile('Re-read per call', tokens(t.perCall), `average over ${n0(t.calls)} calls${t.callsPerPrompt ? ` · ${t.callsPerPrompt.toFixed(1)} calls per message you sent` : ''}`)}
      ${tile('Cold reloads', n0(c.cold.n), `cache expired, whole context written again: ${tokens(c.cold.tokens)} tokens, ${usd(c.cold.usd)} extra`)}</div>`;
    h += `<div class="cards" style="margin-top:12px;grid-template-columns:repeat(auto-fill,minmax(460px,1fr))">`;
    h += `<div class="card"><h3>What is re-read, by source</h3>${table(['Source', 'Tokens', 'API $', 'Share', ''], bars(c.groups, t.usd, (r) => r.usd, (r) => esc(r.key)))}</div>`;
    h += `<div class="card"><h3>By how big the context was</h3>${table(['Context per call', 'Calls', 'Tokens', 'API $', 'Share'], c.buckets.map((b) => [esc(b.key), n0(b.calls), tokens(b.r), usd(b.usd), pc(b.usd, t.usd)]))}
      <div class="hint" style="margin-top:8px">Starting a new chat once the context passed a size would have saved about: ${c.savings.map((x) => `<b>${usd(x.usd)}</b> at ${tokens(x.cap)}`).join(' · ')} (upper bound: a fresh chat still carries the fixed part and a hand-off note).</div></div>`;
    h += `<div class="card" style="grid-column:1/-1"><h3>What is re-read, in detail</h3>${table(['Category', 'Tokens', 'API $', 'Share', ''], bars(c.categories, t.usd, (r) => r.usd, (r) => esc(r.label)))}</div>`;
    h += `<div class="card"><h3>By model</h3>${table(['Model', 'Calls', 'Tokens', 'API $', 'Price per M'], c.models.map((m) => [esc(m.key), n0(m.calls), tokens(m.r), usd(m.usd), '$' + m.perM.toFixed(2)]))}</div>`;
    h += `<div class="card"><h3>Cold reloads</h3>${c.cold.list.length ? table(['When', 'Chat', 'Idle', 'Cache', 'Tokens', 'Extra $'], c.cold.list.slice(0, 12).map((x) => [when(x.t), esc((x.session || '').slice(0, 34)), `${n0(x.gapMin)} min`, x.ttl, tokens(x.tokens), usd(x.usd)]), scope ? null : c.cold.list.slice(0, 12).map((x) => `data-act="tkSession" data-sid="${x.sid}"`)) : '<div class="hint">None: the cache never expired between calls.</div>'}</div>`;
    h += `<div class="card" style="grid-column:1/-1"><h3>Single items that cost the most to carry</h3>${table(['Size', 'Re-read by', 'Carried', 'API $', 'What', 'Item'].concat(scope ? [] : ['Chat', 'Who']), c.carried.slice(0, scope ? 25 : 40).map((x) => [tokens(x.tok), `${n0(x.calls)} calls`, tokens(x.carried), usd(x.usd), esc(x.catLabel), esc(x.label.slice(0, 100))].concat(scope ? [] : [esc((x.session || '').slice(0, 30)), esc(x.agent)])), scope ? null : c.carried.slice(0, 40).map((x) => `data-act="tkSession" data-sid="${x.sid}"`))}</div></div>`;
    return h + `<div class="hint" style="margin-top:10px;max-width:900px">${esc(c.note)}</div>`;
  }

  function cacheTab() {
    if (!T.cache || T.cache.key !== JSON.stringify(T.q)) {
      if (!T.cacheLoading) {
        T.cacheLoading = true;
        const key = JSON.stringify(T.q);
        api('GET', '/api/tokens/cache?' + qs(T.q)).then((c) => { T.cache = { key, data: c }; }).catch((e) => { T.cache = { key, err: e.message }; }).finally(() => { T.cacheLoading = false; T.key = null; dirty(); });
      }
      return '<div class="hint">Working out what every call re-read…</div>';
    }
    if (T.cache.err) return `<div class="hint">${esc(T.cache.err)}</div>`;
    return `<div class="hint" style="margin:0 0 10px;max-width:900px">Cache read is the part of each call that was already sent before: the system prompt and tool definitions, CLAUDE.md, listings, every message, every tool result and every file Claude wrote, re-sent from the prompt cache on every call until the chat ends or compacts.</div>` + cacheBody(T.cache.data, false);
  }

  function sessionsTab(d) {
    const key = { usd: (s) => s.usd, read: (s) => s.usdR, tokens: (s) => s.tokens, calls: (s) => s.calls, peak: (s) => s.peak, last: (s) => s.last }[T.ssort];
    const list = d.sessions.slice().sort((a, b) => key(b) - key(a));
    return `<div class="toolbar" style="border:0;padding:4px 0 8px;background:none"><span class="hint">${n0(list.length)} sessions · sort by</span>${['usd', 'read', 'tokens', 'calls', 'peak', 'last'].map((k) => `<button class="btn sm ${T.ssort === k ? 'pri' : ''}" data-act="tkSsort" data-k="${k}">${{ usd: 'API $', read: 'cache read $', tokens: 'tokens', calls: 'calls', peak: 'peak context', last: 'last active' }[k]}</button>`).join('')}</div>
      <div class="card" style="padding:0">${table(['Session', 'Who', 'Project', 'Last active', 'Calls', 'Subagents', 'Peak context', 'Fresh in', 'Cache write', 'Cache read', 'Read $', 'Output', 'API $'],
        list.map((s) => [`${esc((s.label || '').slice(0, 60))}${s.compactions ? ` <span class="hint">· ${s.compactions} compaction${s.compactions === 1 ? '' : 's'}</span>` : ''}`, esc(s.agent), esc(s.project), when(s.last), n0(s.calls), n0(s.subagents), tokens(s.peak), tokens(s.in), tokens(s.w5 + s.w1), tokens(s.r), usd(s.usdR), tokens(s.out), usd(s.usd)]),
        list.map((s) => `data-act="tkSession" data-sid="${s.sid}"`))}</div>`;
  }

  function callsTab() {
    if (!T.calls) { loadCalls(); return '<div class="hint">Loading calls…</div>'; }
    if (T.calls.loading) return '<div class="hint">Loading calls…</div>';
    if (T.calls.err) return `<div class="hint">${esc(T.calls.err)}</div>`;
    const c = T.calls;
    return `<div class="toolbar" style="border:0;padding:4px 0 8px;background:none"><span class="hint">${n0(c.count)} calls · sort by</span>${[['t', 'newest'], ['usd', 'API $'], ['ctx', 'context size'], ['write', 'cache write'], ['out', 'output']].map(([k, l]) => `<button class="btn sm ${T.csort === k ? 'pri' : ''}" data-act="tkCsort" data-k="${k}">${l}</button>`).join('')}
      <span class="sp" style="flex:1"></span><button class="btn sm" data-act="tkPage" data-d="-1" ${c.offset ? '' : 'disabled'}>‹ Prev</button><span class="hint">${n0(c.offset + 1)}–${n0(Math.min(c.count, c.offset + c.rows.length))}</span><button class="btn sm" data-act="tkPage" data-d="1" ${c.offset + c.rows.length < c.count ? '' : 'disabled'}>Next ›</button></div>
      <div class="card" style="padding:0">${table(['When', 'Session', 'Who', 'Model', 'Context', 'Fresh', 'Write 5m', 'Write 1h', 'Read', 'Output', 'Thinking', 'API $', 'Did'],
        c.rows.map((r) => [when(r.t), esc((r.label || '').slice(0, 34)) + (r.sub ? ' <span class="hint">· sub</span>' : ''), esc(r.agent) + (r.ticket ? ` <span class="hint">#${r.ticket}</span>` : ''), esc(r.model.replace('claude-', '')), tokens(r.ctx), n0(r.in), n0(r.w5), n0(r.w1), n0(r.r), n0(r.out), n0(r.th), usd(r.usd.total), esc(r.did.map((x) => x[0]).join(', ') || (r.stop === 'end_turn' ? 'reply' : r.stop))]),
        c.rows.map((r) => `data-act="tkSession" data-sid="${r.sid}" data-call="${r.id}"`))}</div>`;
  }

  function jevTab(d) {
    const j = d.jev;
    return `<div class="cards"><div class="card"><h3>Jev on OpenRouter</h3><div class="big">${usd(j.usd)}</div><div class="hint">${n0(j.calls)} routing decisions · ${n0(j.tokensIn)} tokens in · ${n0(j.tokensOut)} out (token counts are logged from today on)</div></div></div>
      <div class="card" style="padding:0;margin-top:12px">${table(['When', 'Task', 'Role', 'Picked', 'Time', 'Tokens', 'Cost', 'Why'], j.list.map((l) => [when(l.t), esc((l.task || '').slice(0, 60)), esc(l.role || ''), `${esc(l.model)}/${esc(l.effort)}`, `${n0(l.ms)} ms`, l.tokensIn ? `${n0(l.tokensIn)}+${n0(l.tokensOut)}` : '—', usd(l.costUsd), esc(l.why || '')]))}</div>`;
  }

  function sessionView() {
    const s = T.sess;
    const back = `<button class="btn sm" data-act="tkBack">‹ Back</button>`;
    if (!s) return `${back} <span class="hint">Loading the session…</span>`;
    if (s.err) return `${back} <span class="hint">${esc(s.err)}</span>`;
    const t = s.total;
    const max = Math.max(1, ...s.calls.map((c) => c.ctx));
    const bars = s.calls.map((c) => `<i data-tip="${esc(`${when(c.t)} · context ${n0(c.ctx)} · out ${n0(c.out)} · ${usd(c.usd.total)}`)}" data-act="tkCall" data-id="${c.id}" style="height:${Math.max(2, (c.ctx / max) * 100)}%;${c.sub ? 'opacity:.55' : ''}"></i>`).join('');
    const oh = s.overhead;
    return `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px">${back}<h2 style="margin:0;font-size:16px;white-space:nowrap">${esc(s.label)}</h2><span class="hint">${esc(s.agent)} · ${esc(s.project)} · ${esc(s.sid)}</span></div>
      <div class="kv" style="margin-bottom:10px"><span>calls <b>${n0(t.calls)}</b></span><span>tokens <b>${n0(t.tokens)}</b></span><span>API price <b>${usd(t.usd)}</b></span><span>fresh <b>${n0(t.in)}</b></span><span>cache write <b>${n0(t.w5 + t.w1)}</b> (5m ${n0(t.w5)} · 1h ${n0(t.w1)})</span><span>cache read <b>${n0(t.r)}</b></span><span>output <b>${n0(t.out)}</b> (thinking ${n0(t.th)})</span><span>compactions <b>${s.compactions.length}</b></span><span>subagents <b>${s.subagents.length}</b></span><span>Claude Code <b>${esc(s.version || '?')}</b> · ${esc(s.entry || '')}</span></div>
      ${s.firstPrompt ? `<div class="hint" style="margin-bottom:8px">First message: ${esc(s.firstPrompt)}</div>` : ''}
      ${oh ? `<div class="hint" style="margin-bottom:8px">Sent with every call: system prompt ~${tokens(oh.system)}, tool definitions ~${tokens(oh.tools)} (${oh.list.slice(0, 8).map((x) => `${esc(x[0])} ${tokens(x[1])}`).join(', ')}${oh.list.length > 8 ? ', …' : ''}).</div>` : ''}
      ${sessionCache(s.sid)}
      <div class="card"><h3>Context size of every call</h3><div class="chart tk-sess" style="gap:${s.calls.length > 150 ? 0 : s.calls.length > 60 ? 1 : 2}px">${bars}</div><div class="hint">each bar is one call (faded: subagent); click one to open it</div></div>
      <div class="card" style="padding:0;margin-top:12px">${s.calls.map(callRow).join('')}</div>`;
  }

  function sessionCache(sid) {
    if (!T.sessCache || T.sessCache.sid !== sid) {
      if (!T.sessCacheLoading) {
        T.sessCacheLoading = true;
        api('GET', '/api/tokens/cache?session=' + sid).then((c) => { T.sessCache = { sid, data: c }; }).catch((e) => { T.sessCache = { sid, err: e.message }; }).finally(() => { T.sessCacheLoading = false; T.key = null; dirty(); });
      }
      return '<div class="hint">Working out what this chat re-read…</div>';
    }
    if (T.sessCache.err) return `<div class="hint">${esc(T.sessCache.err)}</div>`;
    return `<details class="card" ${T.sessCacheOpen ? 'open' : ''} style="margin-bottom:12px"><summary data-act="tkSessCache" style="cursor:pointer"><b>Cache read in this chat:</b> ${tokens(T.sessCache.data.total.r)} tokens, ${usd(T.sessCache.data.total.usd)} · ${pc(T.sessCache.data.total.shareUsd, 1)} of its cost (open for the breakdown)</summary><div style="margin-top:10px">${cacheBody(T.sessCache.data, true)}</div></details>`;
  }

  function callRow(c) {
    const open = T.open.has(c.id);
    const head = `<div class="tk-call ${open ? 'on' : ''}" id="call-${c.id}" data-act="tkCall" data-id="${c.id}"><span class="hint" style="width:150px">${when(c.t)}</span><span style="width:110px">${esc(c.model.replace('claude-', ''))}${c.sub ? ' <span class="hint">sub</span>' : ''}</span>
      <span class="num" style="width:90px" title="context sent">${tokens(c.ctx)} ctx</span><span class="num" style="width:90px">+${tokens(c.addedTok)} new</span><span class="num" style="width:80px">${tokens(c.out)} out</span><span class="num" style="width:70px">${usd(c.usd.total)}</span>
      <span class="hint" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.did.map((x) => `${x[0]}${x[1] ? ': ' + x[1] : ''}`).join(' · ') || (c.stop === 'end_turn' ? 'reply to you' : c.stop))}</span></div>`;
    if (!open) return head;
    const u = c.usd;
    return head + `<div class="tk-detail"><div class="cards" style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr))">
      <div class="card"><h3>Exact usage (from the API)</h3>${table(['', 'Tokens', 'API $'], [['Fresh input', n0(c.in), usd(u.input)], ['Cache write 5 min', n0(c.w5), ''], ['Cache write 1 hour', n0(c.w1), usd(u.write)], ['Cache read', n0(c.r), usd(u.read)], ['Output', n0(c.out), usd(u.output)], ['  of which thinking', n0(c.th), ''], ['Web searches / fetches', `${n0(c.ws)} / ${n0(c.wf)}`, usd(u.web)], ['<b>Total</b>', `<b>${n0(c.ctx + c.out)}</b>`, `<b>${usd(u.total)}</b>`]])}
        <div class="hint" style="margin-top:6px">${esc(c.model)} · tier ${esc(c.tier || '—')} · ended: ${esc(c.stop || '—')}${c.ticket ? ` · job #${c.ticket}` : ''}</div></div>
      <div class="card"><h3>New in the context since the previous call (${n0(c.addedN)} items, ~${tokens(c.addedTok)})</h3>${c.added.length ? table(['What', 'Item', 'Tokens'], c.added.map((a) => [esc(a.catLabel), esc(a.label.slice(0, 120)), n0(a.tok)])) : '<div class="hint">Nothing new.</div>'}</div>
      <div class="card"><h3>What the context held (estimate)</h3>${table(['Category', 'Tokens'], c.comp.map((x) => [esc(x.label), n0(x.tokens)]))}</div>
      <div class="card"><h3>What Claude did in this call</h3>${c.did.length ? table(['Tool', 'On'], c.did.map((x) => [esc(x[0]), esc(x[1] || '')])) : `<div class="hint">${c.stop === 'end_turn' ? 'Wrote a reply.' : esc(c.stop || '')}</div>`}</div></div></div>`;
  }

  APPS.tokens = {
    mount(root) {
      root.innerHTML = `<div class="app"><div class="toolbar"><h1>Tokens</h1><span id="tkF" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center"></span><span class="sp"></span><button class="btn sm" data-act="tkReload">Refresh</button><button class="btn sm" data-act="tkCsv">Save as CSV</button></div>
        <div class="tabs" id="tkTabs"></div><div class="body" id="tkBody" style="padding-top:12px"></div></div>`;
      T.key = null;
      if (!T.data && !T.loading) load();
    },
    update() {
      const key = JSON.stringify([T.q, T.tab, T.metric, !!T.data, T.data && T.data.total.calls, T.loading, T.err, T.sid, !!T.sess, [...T.open], T.calls && (T.calls.offset + ':' + T.calls.count + ':' + !!T.calls.loading), T.csort, T.ssort, T.cache && T.cache.key, T.sessCache && T.sessCache.sid, !!T.sessCacheOpen]);
      if (key === T.key) return;
      T.key = key;
      $('#tkF').innerHTML = filtersBar();
      $('#tkTabs').innerHTML = [['overview', 'Overview'], ['cache', 'Cache read'], ['context', 'Context'], ['sessions', 'Sessions'], ['calls', 'Every call'], ['jev', 'Jev']].map(([k, l]) => `<button class="${T.tab === k && !T.sid ? 'on' : ''}" data-act="tkTab" data-k="${k}">${l}</button>`).join('');
      const body = $('#tkBody');
      if (T.err) { body.innerHTML = `<div class="hint">${esc(T.err)}</div>`; return; }
      if (!T.data) { body.innerHTML = '<div class="hint">Reading every Claude Code transcript on this machine… the first time takes a few seconds.</div>'; return; }
      const scroll = body.scrollTop;
      body.innerHTML = (T.loading ? '<div class="hint">Updating…</div>' : '') + (T.sid ? sessionView() : T.tab === 'cache' ? cacheTab() : T.tab === 'context' ? contextTab(T.data) : T.tab === 'sessions' ? sessionsTab(T.data) : T.tab === 'calls' ? callsTab() : T.tab === 'jev' ? jevTab(T.data) : overviewTab(T.data));
      body.scrollTop = scroll;
    },
  };

  Object.assign(ACT, {
    tkTab: (d) => { T.tab = d.k; T.sid = null; T.key = null; dirty(); },
    tkSessCache: () => { T.sessCacheOpen = !T.sessCacheOpen; T.key = null; dirty(); },
    tkMetric: (d) => { T.metric = d.m; T.key = null; dirty(); },
    tkFilter: (d) => setQ(d.k, d.v),
    tkClear: (d) => setQ(d.k, ''),
    tkReload: () => { T.live = undefined; load(); },
    tkSession: (d) => openSession(d.sid, d.call),
    tkBack: () => { T.sid = null; T.sess = null; T.key = null; dirty(); },
    tkCall: (d) => { if (T.open.has(d.id)) T.open.delete(d.id); else T.open.add(d.id); T.key = null; dirty(); setTimeout(() => { const el = document.getElementById('call-' + d.id); if (el) el.scrollIntoView({ block: 'nearest' }); }, 30); },
    tkCsort: (d) => { T.csort = d.k; T.coff = 0; T.calls = null; T.key = null; dirty(); },
    tkSsort: (d) => { T.ssort = d.k; T.key = null; dirty(); },
    tkPage: (d) => { T.coff = Math.max(0, T.coff + Number(d.d) * 100); T.calls = null; T.key = null; dirty(); },
    tkCsv: async () => { const r = await api('POST', '/api/tokens/save-csv', T.q); notify('answer', 'Tokens saved', `Every call in this view, one row each: ${r.file}`); },
  });
  document.addEventListener('change', (ev) => {
    const el = ev.target.closest('[data-tkf]');
    if (el) setQ(el.dataset.tkf, el.value);
  });
})();
