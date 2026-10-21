#!/usr/bin/env node
'use strict';
// Every model call Claude Code made on this machine, with exact token counts from the API and an estimated
// breakdown of what was in the context. Parsed transcripts are cached per file (data/usage/cache) by mtime and size.
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const { parseArgs, fs, path } = require('./_util');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const CACHE = path.join(DATA, 'usage', 'cache');
const VERSION = 5;
const BASE = { opus: 5, sonnet: 3, haiku: 1 };
const WEB_SEARCH_USD = 0.01;
const NOT_SENT = new Set(['prompt_snapshot', 'thinking_drop', 'credential_org', 'auto_mode', 'command_permissions', 'deferred_tools_record', 'remote_session_change', 'compact_file_reference', 'queued_command']);
const ATTACH = { instructions: 'claude.md', skill_listing: 'listings', agent_listing_delta: 'listings', deferred_tools_delta: 'listings', mcp_instructions_delta: 'listings', invoked_skills: 'listings', file: 'files', edited_text_file: 'files' };
const CAT_LABEL = {
  fixed: 'System prompt & tool definitions', 'claude.md': 'CLAUDE.md & memory', listings: 'Skill, agent & tool listings', files: 'Files & edit notices',
  reminders: 'Reminders & environment', skills: 'Skill instructions (loaded when a skill runs)', you: 'Your messages', summary: 'Compaction summaries', 'claude:text': 'Claude: replies',
  'claude:thinking': 'Claude: thinking', 'claude:input': 'Claude: tool inputs (Write/Edit text, commands)',
};
const tier = (m) => (/haiku/i.test(m) ? 'haiku' : /sonnet/i.test(m) ? 'sonnet' : 'opus');
const est = (chars) => Math.round(chars / 4);
const catLabel = (c) => CAT_LABEL[c] || (c.startsWith('tool:') ? `Tool result: ${c.slice(5)}` : c);

function sizeOf(c) {
  if (typeof c === 'string') return c.length;
  if (Array.isArray(c)) return c.reduce((n, x) => n + (x.type === 'text' ? (x.text || '').length : x.type === 'image' ? 6000 : x.type === 'document' ? JSON.stringify(x).length / 10 : JSON.stringify(x).length), 0);
  return JSON.stringify(c || '').length;
}
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x.type === 'text' ? x.text : x.type === 'image' ? '[image]' : x.type === 'document' ? '[document]' : '')).join(' ') : '');
const preview = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n || 140);
function attachSize(a) {
  const v = a.content || a.text || a.addedLines || a.addedBlocks || a.files || a.snapshot || a.context || a.skills || a.identity || a.date || a.snippet || '';
  return (typeof v === 'string' ? v.length : JSON.stringify(v).length) + 40;
}
function describe(input) {
  if (!input) return '';
  const v = input.command || input.file_path || input.path || input.pattern || input.url || input.query || input.skill || input.description || input.prompt || input.title || '';
  return preview(v, 120);
}
const toolName = (n) => (n && n.startsWith('mcp__') ? n.replace(/^mcp__(.+?)__/, 'mcp:$1/') : n || '?');

function cost(c) {
  const b = BASE[tier(c.model)];
  const parts = { input: (c.in * b) / 1e6, write: (c.w5 * 1.25 * b + c.w1 * 2 * b) / 1e6, read: (c.r * 0.1 * b) / 1e6, output: (c.out * 5 * b) / 1e6, web: (c.ws || 0) * WEB_SEARCH_USD };
  return { ...parts, total: parts.input + parts.write + parts.read + parts.output + parts.web };
}

function listFiles() {
  const out = [];
  const walk = (d) => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(PROJECTS);
  return out;
}

function projectName(dir) {
  const d = dir.replace(/^-home-default-?/, '');
  if (!d) return '~ (home)';
  if (d.startsWith('-tmp') || d === 'tmp') return 'tmp / scratch';
  return d.replace(/-/g, '/');
}

async function parseFile(file) {
  const rel = path.relative(PROJECTS, file).split(path.sep);
  const sub = rel.includes('subagents');
  const f = { v: VERSION, file, project: projectName(rel[0]), sid: sub ? rel[1] : path.basename(file, '.jsonl'), sub: sub ? path.basename(file, '.jsonl').replace(/^agent-/, '') : null,
    entry: '', title: '', firstPrompt: '', cwd: '', version: '', overhead: null, compactions: [], calls: [] };
  const names = new Map();
  const comp = {};
  let added = [];
  let ticket = null;
  const seen = new Set();
  const add = (cat, label, tok) => { if (!tok) return; comp[cat] = (comp[cat] || 0) + tok; added.push([cat, preview(label, 160), tok]); };
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.entrypoint && !f.entry) f.entry = e.entrypoint;
    if (e.cwd && !f.cwd) f.cwd = e.cwd;
    if (e.version && !f.version) f.version = e.version;
    if (e.type === 'custom-title' && e.customTitle) f.title = e.customTitle;
    else if (e.type === 'ai-title' && e.aiTitle && !f.title) f.title = e.aiTitle;
    else if (e.type === 'api-request-shape' && e.shape) {
      const tools = (e.shape.tools || []).map((t) => [t.name, est(JSON.stringify(t).length)]).sort((a, b) => b[1] - a[1]);
      f.overhead = { system: est(JSON.stringify(e.shape.system || '').length), tools: tools.reduce((n, t) => n + t[1], 0), list: tools };
    } else if (e.type === 'system' && e.subtype === 'compact_boundary') {
      f.compactions.push(Date.parse(e.timestamp) || 0);
      for (const k of Object.keys(comp)) delete comp[k];
    } else if (e.type === 'assistant' && e.message) {
      const m = e.message;
      const did = [];
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c.type === 'tool_use') { const what = describe(c.input); names.set(c.id, { name: toolName(c.name), what }); did.push([toolName(c.name), what]); }
      }
      if (m.usage && m.id && !seen.has(m.id)) {
        seen.add(m.id);
        const u = m.usage;
        const w1 = (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0;
        f.calls.push({ id: m.id, t: Date.parse(e.timestamp) || 0, model: m.model || '', in: u.input_tokens || 0, w5: (u.cache_creation_input_tokens || 0) - w1, w1,
          r: u.cache_read_input_tokens || 0, out: u.output_tokens || 0, th: (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0,
          ws: (u.server_tool_use && u.server_tool_use.web_search_requests) || 0, wf: (u.server_tool_use && u.server_tool_use.web_fetch_requests) || 0,
          tier: u.service_tier || '', stop: m.stop_reason || '', tk: ticket, side: !!e.isSidechain, did, added, comp: { ...comp } });
        added = [];
      } else if (did.length && f.calls.length && f.calls[f.calls.length - 1].id === m.id) {
        f.calls[f.calls.length - 1].did.push(...did);
      }
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c.type === 'thinking') add('claude:thinking', '(thinking)', est((c.thinking || '').length));
        else if (c.type === 'text') add('claude:text', c.text, est((c.text || '').length));
        else if (c.type === 'tool_use') add('claude:input', `${toolName(c.name)}: ${describe(c.input)}`, est(JSON.stringify(c.input || '').length));
      }
    } else if (e.type === 'user' && e.message) {
      const c = e.message.content;
      if (Array.isArray(c) && c.some((x) => x.type === 'tool_result')) {
        for (const r of c.filter((x) => x.type === 'tool_result')) {
          const info = names.get(r.tool_use_id) || { name: '?', what: '' };
          add(`tool:${info.name}`, `${info.name}${info.what ? ': ' + info.what : ''}${r.is_error ? ' (error)' : ''}`, est(sizeOf(r.content)));
        }
        continue;
      }
      const text = textOf(c);
      const h = text.match(/\[(?:Ticket|User follow-up on ticket) #(\d+)/i);
      if (h) ticket = Number(h[1]);
      if (e.isCompactSummary) { add('summary', text, est(sizeOf(c))); continue; }
      if (e.isMeta) { add(/^Base directory for this skill/.test(text) ? 'skills' : 'reminders', text, est(sizeOf(c))); continue; }
      if (!f.firstPrompt && text && !text.startsWith('<')) f.firstPrompt = preview(text, 200);
      add('you', text, est(sizeOf(c)));
    } else if (e.type === 'attachment' && e.attachment) {
      const a = e.attachment;
      if (NOT_SENT.has(a.type)) continue;
      add(ATTACH[a.type] || 'reminders', `${a.type}${a.filename ? ': ' + a.filename : ''}`, est(attachSize(a)));
    }
  }
  return f;
}

async function loadFile(file) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  const key = crypto.createHash('sha1').update(file).digest('hex').slice(0, 16);
  const cf = path.join(CACHE, key + '.json');
  try {
    const c = JSON.parse(fs.readFileSync(cf, 'utf8'));
    if (c.v === VERSION && c.mtime === st.mtimeMs && c.size === st.size) return c;
  } catch {}
  const f = await parseFile(file);
  f.mtime = st.mtimeMs; f.size = st.size;
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(cf, JSON.stringify(f));
  return f;
}

function readJsonl(f) { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } }
function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }

function officeMap() {
  const agentsRaw = readJson(path.join(DATA, 'agents.json'), []);
  const agents = new Map((Array.isArray(agentsRaw) ? agentsRaw : Object.values(agentsRaw)).map((a) => [a.id, a]));
  const ticketsRaw = readJson(path.join(DATA, 'tickets.json'), { tickets: {} }).tickets || {};
  const tickets = new Map(Object.values(ticketsRaw).map((t) => [t.id, t]));
  const byPrefix = new Map();
  const evDir = path.join(DATA, 'events');
  for (const fn of (() => { try { return fs.readdirSync(evDir); } catch { return []; } })()) {
    const agentId = fn.replace(/\.jsonl$/, '');
    let lastTicket = null;
    for (const ev of readJsonl(path.join(evDir, fn))) {
      if ((ev.kind === 'brief' || ev.kind === 'followup') && ev.ticketId) lastTicket = ev.ticketId;
      const m = ev.kind === 'system' && /^Session ([0-9a-f]{8})/.exec(ev.text || '');
      if (m) byPrefix.set(m[1], { agentId, ticketId: lastTicket });
    }
  }
  for (const s of readJsonl(path.join(DATA, 'sessions.jsonl'))) byPrefix.set(s.sid.slice(0, 8), { agentId: s.agentId, ticketId: s.ticketId, persona: s.persona, role: s.role, name: s.name, homeId: s.homeId });
  const who = (agentId, fallback) => {
    const a = agents.get(agentId) || {};
    const homeId = a.resident ? a.id : a.homeId || (fallback && fallback.homeId);
    const home = agents.get(homeId) || {};
    return { id: agentId, persona: a.persona || (fallback && fallback.persona) || agentId, role: a.role === 'custom' ? a.name || 'custom' : a.role || (fallback && fallback.role) || '?',
      team: home.persona ? `${home.persona} · ${home.room || home.name || ''}`.replace(/ · $/, '') : '—' };
  };
  return { byPrefix, tickets, who };
}

function classify(f, office, parent) {
  const base = parent || f;
  const o = office.byPrefix.get(base.sid.slice(0, 8));
  if (o) {
    const w = office.who(o.agentId, o);
    const t = o.ticketId && office.tickets.get(o.ticketId);
    return { source: 'Agentic OS', agent: w.persona, role: w.role, team: w.team, ticket: t ? t.n : null };
  }
  if (base.entry !== 'sdk-cli') return { source: 'You (Claude Code)', agent: 'You', role: 'you', team: 'You' };
  const p = base.firstPrompt || '';
  const project = base.project;
  if (/^tmp|claude\/dashboard/.test(project)) return { source: 'Tests & experiments', agent: 'test runs', role: 'test', team: 'Tests' };
  const kind = /^Use the \/\S+ skill/.test(p) ? 'skill runs' : /^You improve a Claude Code skill/.test(p) ? 'teach' : /^Reply with: ok/.test(p) ? 'limit probes'
    : /self-test|selftest|smoke test|stop test|^say /i.test(p) ? 'self-tests' : /^\[Ticket|^\[User follow-up/.test(p) ? 'agents (older runs)' : 'scripts';
  if (kind === 'scripts' && project.startsWith('repo/baseline')) return { source: 'Agentic OS', agent: '(earlier WORK staff)', role: 'staff before per-agent tracking', team: 'WORK team (before per-agent tracking)', ticket: null };
  return { source: 'Agentic OS', agent: `(${kind === 'scripts' ? 'earlier office runs' : kind})`, role: kind, team: 'Agentic OS system', ticket: null };
}

let MEMO = { at: 0, files: [] };
async function index(opts = {}) {
  if (!opts.fresh && Date.now() - MEMO.at < 30000) return MEMO.files;
  const files = [];
  for (const p of listFiles().sort((a, b) => a.includes('/subagents/') - b.includes('/subagents/'))) { const f = await loadFile(p); if (f && f.calls.length) files.push(f); }
  const office = officeMap();
  const parents = new Map(files.filter((f) => !f.sub).map((f) => [f.sid, f]));
  let fallbackOverhead = null;
  for (const f of files) if (f.overhead && (!fallbackOverhead || f.mtime > fallbackOverhead.at)) fallbackOverhead = { ...f.overhead, at: f.mtime };
  const seen = new Set();
  for (const f of files) {
    const parent = f.sub ? parents.get(f.sid) : null;
    Object.assign(f, classify(f, office, parent));
    if (parent && !f.title) f.title = parent.title;
    f.label = f.title || f.firstPrompt || f.sid.slice(0, 8);
    const oh = f.overhead || (parent && parent.overhead) || fallbackOverhead;
    f.fixed = oh ? oh.system + oh.tools : 0;
    f.calls = f.calls.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
    for (const c of f.calls) { c.usd = cost(c); if (c.tk == null && f.ticket) c.tk = f.ticket; }
  }
  MEMO = { at: Date.now(), files, jev: readJsonl(path.join(DATA, 'arms', 'routing.jsonl')).filter((l) => l.source === 'jev' && !l.error) };
  return files;
}

function filterFn(q) {
  const from = q.from ? Date.parse(q.from + 'T00:00:00') : q.days ? Date.now() - Number(q.days) * 86400000 : 0;
  const to = q.to ? Date.parse(q.to + 'T23:59:59.999') : Infinity;
  return (f, c) => c.t >= from && c.t <= to && (!q.source || f.source === q.source) && (!q.project || f.project === q.project) && (!q.agent || f.agent === q.agent)
    && (!q.team || f.team === q.team) && (!q.model || c.model === q.model) && (!q.session || f.sid === q.session) && (!q.ticket || String(c.tk) === String(q.ticket))
    && (!q.day || new Date(c.t).toLocaleDateString('sv') === q.day);
}

const blank = () => ({ calls: 0, in: 0, w5: 0, w1: 0, r: 0, out: 0, th: 0, ws: 0, usd: 0, usdIn: 0, usdW: 0, usdR: 0, usdOut: 0, usdWeb: 0 });
function addTo(a, c) {
  a.calls++; a.in += c.in; a.w5 += c.w5; a.w1 += c.w1; a.r += c.r; a.out += c.out; a.th += c.th; a.ws += c.ws;
  a.usd += c.usd.total; a.usdIn += c.usd.input; a.usdW += c.usd.write; a.usdR += c.usd.read; a.usdOut += c.usd.output; a.usdWeb += c.usd.web;
}
const tot = (a) => a.in + a.w5 + a.w1 + a.r + a.out;

async function overview(q = {}) {
  const files = await index(q);
  const keep = filterFn(q);
  const total = blank();
  const dims = { day: {}, hour: {}, weekday: {}, source: {}, team: {}, agent: {}, role: {}, ticket: {}, project: {}, model: {}, tier: {}, thread: {}, stop: {} };
  const sessions = new Map();
  const ctx = {}, tools = {};
  let prompts = 0, promptTok = 0, peak = null;
  const biggest = [];
  for (const f of files) {
    for (const c of f.calls) {
      if (!keep(f, c)) continue;
      addTo(total, c);
      const d = new Date(c.t);
      const put = (dim, key) => addTo(dims[dim][key] || (dims[dim][key] = blank()), c);
      put('day', d.toLocaleDateString('sv')); put('hour', String(d.getHours()).padStart(2, '0')); put('weekday', ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]);
      put('source', f.source); put('team', f.team); put('agent', f.agent); put('role', f.role); put('project', f.project);
      put('model', c.model.replace(/^claude-/, '') || '?'); put('tier', c.tier || '—'); put('thread', f.sub ? 'subagents (Agent tool)' : 'main thread'); put('stop', c.stop || '—');
      if (c.tk != null) put('ticket', `#${c.tk}`);
      const s = sessions.get(f.sid) || { sid: f.sid, label: f.label, source: f.source, agent: f.agent, team: f.team, project: f.project, first: c.t, last: c.t, subagents: new Set(), peak: 0, compactions: 0, ...blank() };
      addTo(s, c); s.first = Math.min(s.first, c.t); s.last = Math.max(s.last, c.t);
      if (f.sub) s.subagents.add(f.sub);
      const size = c.in + c.w5 + c.w1 + c.r;
      s.peak = Math.max(s.peak, size);
      if (!peak || size > peak.tokens) peak = { tokens: size, sid: f.sid, label: f.label, t: c.t };
      sessions.set(f.sid, s);
      ctx.fixed = (ctx.fixed || 0) + f.fixed;
      for (const [k, v] of Object.entries(c.comp)) ctx[k] = (ctx[k] || 0) + v;
      for (const [cat, label, tok] of c.added) {
        if (cat.startsWith('tool:')) { const t = tools[cat.slice(5)] || (tools[cat.slice(5)] = { n: 0, tokens: 0 }); t.n++; t.tokens += tok; }
        if (cat === 'you') { prompts++; promptTok += tok; }
        if (tok >= 1500) biggest.push({ tok, cat, catLabel: catLabel(cat), label, sid: f.sid, session: f.label, agent: f.agent, t: c.t });
      }
    }
    for (const t of f.compactions) if (sessions.has(f.sid) && keep(f, { t, model: '', tk: null })) sessions.get(f.sid).compactions++;
  }
  const rows = (m) => Object.entries(m).map(([k, v]) => ({ key: k, ...v, tokens: tot(v) })).sort((a, b) => b.usd - a.usd);
  const ctxTotal = Object.values(ctx).reduce((a, b) => a + b, 0);
  const sent = total.in + total.w5 + total.w1 + total.r;
  const jev = (MEMO.jev || []).filter((l) => keep({ source: 'Jev (OpenRouter)', project: '', agent: '', team: '', sid: '' }, { t: l.t, model: '', tk: null }) && (!q.source || q.source === 'Jev (OpenRouter)'));
  return {
    query: q, total: { ...total, tokens: tot(total) }, sent, peak,
    dims: Object.fromEntries(Object.entries(dims).map(([k, v]) => [k, k === 'day' || k === 'hour' ? Object.entries(v).map(([key, x]) => ({ key, ...x, tokens: tot(x) })).sort((a, b) => a.key.localeCompare(b.key)) : rows(v)])),
    context: Object.entries(ctx).map(([k, v]) => ({ key: k, label: catLabel(k), tokens: v, share: ctxTotal ? v / ctxTotal : 0 })).sort((a, b) => b.tokens - a.tokens),
    contextExplained: sent ? ctxTotal / sent : 0,
    tools: Object.entries(tools).map(([k, v]) => ({ key: k, ...v, carried: ctx['tool:' + k] || 0 })).sort((a, b) => b.carried - a.carried),
    prompts: { n: prompts, tokens: promptTok },
    biggest: biggest.sort((a, b) => b.tok - a.tok).slice(0, 60),
    sessions: [...sessions.values()].map((s) => ({ ...s, subagents: s.subagents.size, tokens: tot(s) })).sort((a, b) => b.usd - a.usd),
    jev: { calls: jev.length, usd: jev.reduce((a, l) => a + (l.costUsd || 0), 0), tokensIn: jev.reduce((a, l) => a + (l.tokensIn || 0), 0), tokensOut: jev.reduce((a, l) => a + (l.tokensOut || 0), 0), list: jev.slice(-200).reverse() },
    filters: {
      sources: [...new Set(files.map((f) => f.source)), 'Jev (OpenRouter)'], projects: [...new Set(files.map((f) => f.project))].sort(), agents: [...new Set(files.map((f) => f.agent))].sort(),
      teams: [...new Set(files.map((f) => f.team))].sort(), models: [...new Set(files.flatMap((f) => f.calls.map((c) => c.model)))].filter(Boolean).sort(),
    },
    prices: 'API list prices: input per M tokens opus $5, sonnet $3, haiku $1; cache write 1.25× (5 min) or 2× (1 h); cache read 0.1×; output 5×; web search $10 per 1,000.',
  };
}

async function calls(q = {}) {
  const files = await index(q);
  const keep = filterFn(q);
  const out = [];
  for (const f of files) for (const c of f.calls) if (keep(f, c)) out.push({ f, c });
  const key = { t: (x) => x.c.t, usd: (x) => x.c.usd.total, out: (x) => x.c.out, ctx: (x) => x.c.in + x.c.w5 + x.c.w1 + x.c.r, write: (x) => x.c.w5 + x.c.w1 }[q.sort || 't'] || ((x) => x.c.t);
  out.sort((a, b) => key(b) - key(a));
  const offset = Number(q.offset) || 0, limit = Math.min(1000, Number(q.limit) || 100);
  return { count: out.length, offset, rows: out.slice(offset, offset + limit).map(({ f, c }) => row(f, c)) };
}

function row(f, c, full) {
  const r = { id: c.id, t: c.t, sid: f.sid, sub: f.sub, label: f.label, source: f.source, agent: f.agent, team: f.team, project: f.project, ticket: c.tk, model: c.model,
    in: c.in, w5: c.w5, w1: c.w1, r: c.r, out: c.out, th: c.th, ws: c.ws, wf: c.wf, tier: c.tier, stop: c.stop, usd: c.usd, ctx: c.in + c.w5 + c.w1 + c.r,
    did: c.did.slice(0, full ? 100 : 4), addedTok: c.added.reduce((a, x) => a + x[2], 0), addedN: c.added.length };
  if (full) {
    r.added = c.added.map(([cat, label, tok]) => ({ cat, catLabel: catLabel(cat), label, tok }));
    r.comp = [['fixed', f.fixed], ...Object.entries(c.comp)].map(([k, v]) => ({ key: k, label: catLabel(k), tokens: v })).filter((x) => x.tokens).sort((a, b) => b.tokens - a.tokens);
  }
  return r;
}

async function session(sid, q = {}) {
  const files = (await index(q)).filter((f) => f.sid === sid);
  if (!files.length) return null;
  const main = files.find((f) => !f.sub) || files[0];
  const all = [];
  for (const f of files) for (const c of f.calls) all.push(row(f, c, true));
  all.sort((a, b) => a.t - b.t);
  const total = blank();
  for (const f of files) for (const c of f.calls) addTo(total, c);
  return { sid, label: main.label, title: main.title, firstPrompt: main.firstPrompt, source: main.source, agent: main.agent, team: main.team, project: main.project, cwd: main.cwd,
    entry: main.entry, version: main.version, overhead: main.overhead, fixed: main.fixed, compactions: files.flatMap((f) => f.compactions), subagents: files.filter((f) => f.sub).map((f) => ({ id: f.sub, firstPrompt: f.firstPrompt, calls: f.calls.length })),
    total: { ...total, tokens: tot(total) }, calls: all };
}

async function csv(q = {}) {
  const files = await index(q);
  const keep = filterFn(q);
  const head = ['time', 'session', 'subagent', 'source', 'team', 'agent', 'project', 'ticket', 'model', 'fresh_input', 'cache_write_5m', 'cache_write_1h', 'cache_read', 'output', 'thinking', 'web_searches', 'context', 'usd_input', 'usd_write', 'usd_read', 'usd_output', 'usd_web', 'usd_total', 'stop', 'tools_used', 'session_title'];
  const q1 = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [head.join(',')];
  for (const f of files) for (const c of f.calls) {
    if (!keep(f, c)) continue;
    lines.push([new Date(c.t).toISOString(), f.sid, f.sub || '', f.source, f.team, f.agent, f.project, c.tk == null ? '' : c.tk, c.model, c.in, c.w5, c.w1, c.r, c.out, c.th, c.ws, c.in + c.w5 + c.w1 + c.r,
      c.usd.input.toFixed(6), c.usd.write.toFixed(6), c.usd.read.toFixed(6), c.usd.output.toFixed(6), c.usd.web.toFixed(6), c.usd.total.toFixed(6), c.stop, c.did.map((d) => d[0]).join(' '), f.label].map(q1).join(','));
  }
  return lines.join('\n') + '\n';
}

const READ_BUCKETS = [[100000, 'under 100k'], [200000, '100k–200k'], [300000, '200k–300k'], [500000, '300k–500k'], [Infinity, 'over 500k']];
const SAVE_CAPS = [100000, 150000, 200000, 300000];

async function cacheRead(q = {}) {
  const files = await index(q);
  const keep = filterFn(q);
  const total = { calls: 0, r: 0, usd: 0, all: 0, allUsd: 0, prompts: 0, withRead: 0 };
  const cats = {}, buckets = {}, models = {}, savings = Object.fromEntries(SAVE_CAPS.map((c) => [c, 0]));
  const cold = { n: 0, tokens: 0, usd: 0, list: [] };
  const items = [];
  for (const f of files) {
    const calls = f.calls;
    const comps = f.compactions.slice().sort((a, b) => a - b);
    const seg = calls.map((c) => comps.filter((t) => t <= c.t).length);
    const suffixN = new Array(calls.length).fill(0), suffixP = new Array(calls.length).fill(0);
    for (let i = calls.length - 2; i >= 0; i--) {
      const j = i + 1;
      const sameSeg = seg[j] === seg[i];
      suffixN[i] = sameSeg ? suffixN[j] + 1 : 0;
      suffixP[i] = sameSeg ? suffixP[j] + (0.1 * BASE[tier(calls[j].model)]) / 1e6 : 0;
    }
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i];
      if (!keep(f, c)) continue;
      const ctx = c.in + c.w5 + c.w1 + c.r;
      total.calls++; total.r += c.r; total.usd += c.usd.read; total.all += ctx + c.out; total.allUsd += c.usd.total;
      if (c.r) total.withRead++;
      total.prompts += c.added.filter((a) => a[0] === 'you').length;
      const prev = i > 0 && seg[i - 1] === seg[i] ? calls[i - 1] : null;
      const comp = { fixed: f.fixed, ...(prev ? prev.comp : c.comp) };
      const sum = Object.values(comp).reduce((a, b) => a + b, 0);
      if (c.r) {
        if (!sum) { const k = cats.unknown || (cats.unknown = { tokens: 0, usd: 0 }); k.tokens += c.r; k.usd += c.usd.read; }
        else for (const [k, v] of Object.entries(comp)) { if (!v) continue; const x = cats[k] || (cats[k] = { tokens: 0, usd: 0 }); x.tokens += (c.r * v) / sum; x.usd += (c.usd.read * v) / sum; }
      }
      const b = READ_BUCKETS.find(([lim]) => ctx < lim)[1];
      const bb = buckets[b] || (buckets[b] = { calls: 0, r: 0, usd: 0 });
      bb.calls++; bb.r += c.r; bb.usd += c.usd.read;
      const m = c.model.replace(/^claude-/, '') || '?';
      const mm = models[m] || (models[m] = { calls: 0, r: 0, usd: 0, perM: 0.1 * BASE[tier(c.model)] });
      mm.calls++; mm.r += c.r; mm.usd += c.usd.read;
      for (const cap of SAVE_CAPS) if (ctx > cap) savings[cap] += (c.usd.read * (ctx - cap)) / ctx;
      if (prev) {
        const gap = c.t - prev.t;
        const oneHour = c.w1 > 0 || prev.w1 > 0;
        const w = c.w5 + c.w1;
        if (gap > (oneHour ? 3600000 : 300000) && w > 10000) {
          const extra = (w * ((oneHour ? 2 : 1.25) - 0.1) * BASE[tier(c.model)]) / 1e6;
          cold.n++; cold.tokens += w; cold.usd += extra;
          cold.list.push({ t: c.t, sid: f.sid, session: f.label, agent: f.agent, gapMin: Math.round(gap / 60000), tokens: w, usd: extra, ttl: oneHour ? '1 h' : '5 min' });
        }
      }
      for (const [cat, label, tok] of c.added) {
        if (tok < 200 || !suffixN[i]) continue;
        items.push({ cat, catLabel: catLabel(cat), label, tok, calls: suffixN[i], carried: tok * suffixN[i], usd: tok * suffixP[i], sid: f.sid, session: f.label, agent: f.agent, t: c.t });
      }
    }
  }
  const catRows = Object.entries(cats).map(([k, v]) => ({ key: k, label: k === 'unknown' ? 'Not attributable (no content recorded)' : catLabel(k), ...v })).sort((a, b) => b.usd - a.usd);
  const byKind = {};
  for (const r of catRows) {
    const g = r.key === 'fixed' ? 'Fixed: system prompt & tools' : r.key.startsWith('tool:') ? 'Tool results' : r.key.startsWith('claude:') ? "Claude's own output" : ['claude.md', 'listings', 'skills', 'reminders', 'files', 'summary'].includes(r.key) ? 'Added by Claude Code' : r.key === 'you' ? 'Your messages' : 'Other';
    const x = byKind[g] || (byKind[g] = { key: g, tokens: 0, usd: 0 }); x.tokens += r.tokens; x.usd += r.usd;
  }
  items.sort((a, b) => b.usd - a.usd);
  cold.list.sort((a, b) => b.usd - a.usd); cold.list = cold.list.slice(0, 30);
  return {
    query: q, total: { ...total, perCall: total.calls ? total.r / total.calls : 0, callsPerPrompt: total.prompts ? total.calls / total.prompts : null, shareTokens: total.all ? total.r / total.all : 0, shareUsd: total.allUsd ? total.usd / total.allUsd : 0 },
    groups: Object.values(byKind).sort((a, b) => b.usd - a.usd), categories: catRows,
    buckets: READ_BUCKETS.map(([, k]) => ({ key: k, ...(buckets[k] || { calls: 0, r: 0, usd: 0 }) })),
    models: Object.entries(models).map(([k, v]) => ({ key: k, ...v })).sort((a, b) => b.usd - a.usd),
    savings: SAVE_CAPS.map((cap) => ({ cap, usd: savings[cap] })), cold, carried: items.slice(0, 60),
    note: 'Cache-read totals per call are exact (from the API). The split by category spreads each call\'s exact cache read over what its context held, estimated from content length; "carried" multiplies an item\'s size by the number of later calls that re-read it before the chat ended or compacted.',
  };
}

async function liveChats(minTokens) {
  const files = await index({ fresh: true });
  const out = [];
  for (const f of files) {
    if (f.sub || f.source !== 'You (Claude Code)') continue;
    const last = f.calls[f.calls.length - 1];
    if (!last || Date.now() - last.t > 12 * 3600000) continue;
    const size = last.in + last.w5 + last.w1 + last.r;
    if (size >= (minTokens || 300000)) out.push({ sid: f.sid, label: f.label, project: f.project, tokens: size, lastAt: last.t, perCallUsd: cost({ ...last, out: 0, ws: 0 }).total });
  }
  return out.sort((a, b) => b.tokens - a.tokens);
}

module.exports = { index, overview, calls, session, csv, liveChats, cacheRead, cost };
if (require.main === module) {
  const { opt } = parseArgs(process.argv.slice(2));
  const M = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n));
  const run = async () => {
    if (opt.csv) return csv({ days: opt.days });
    if (opt.session) return JSON.stringify(await session(opt.session), null, 1);
    const o = await overview({ days: opt.days || 30 });
    return [`${o.total.calls} calls, ${M(o.total.tokens)} tokens, $${o.total.usd.toFixed(2)} at API prices (last ${opt.days || 30} days).`,
      ...o.dims.source.map((r) => `  ${r.key}: ${r.calls} calls, ${M(r.tokens)} tokens, $${r.usd.toFixed(2)}`),
      ...o.dims.agent.slice(0, 15).map((r) => `  agent ${r.key}: ${r.calls} calls, $${r.usd.toFixed(2)}`),
      `Context estimate explains ${Math.round(o.contextExplained * 100)}% of the tokens sent.`].join('\n');
  };
  run().then((s) => process.stdout.write(s + '\n'), (e) => { process.stderr.write(e.stack + '\n'); process.exit(2); });
}
