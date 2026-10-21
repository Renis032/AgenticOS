#!/usr/bin/env node
'use strict';
const os = require('os');
const readline = require('readline');
const { parseArgs, fs, path } = require('./_util');

const ROOT = path.join(os.homedir(), '.claude', 'projects');
const BASE = { opus: 5, sonnet: 3, haiku: 1 };
const tier = (m) => (/haiku/i.test(m) ? 'haiku' : /sonnet/i.test(m) ? 'sonnet' : 'opus');
const est = (chars) => Math.round(chars / 4);
const sizeOf = (c) => (typeof c === 'string' ? c.length : Array.isArray(c) ? c.reduce((n, x) => n + (x.type === 'text' ? (x.text || '').length : x.type === 'image' ? 6000 : x.type === 'document' ? JSON.stringify(x).length / 10 : JSON.stringify(x).length), 0) : JSON.stringify(c || '').length);

function files(since) {
  const out = [];
  const walk = (d) => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) { try { if (fs.statSync(p).mtimeMs >= since) out.push(p); } catch {} }
    }
  };
  walk(ROOT);
  return out;
}

function projectName(dir) {
  const d = dir.replace(/^-home-default-?/, '');
  if (!d) return '~ (home)';
  if (d.startsWith('-tmp') || d === 'tmp') return 'tmp / scratch';
  return d.replace(/-/g, '/');
}

const ATTACH = { instructions: '(CLAUDE.md & memory)', skill_listing: '(skill, agent & tool listings)', agent_listing_delta: '(skill, agent & tool listings)', deferred_tools_record: '(skill, agent & tool listings)', deferred_tools_delta: '(skill, agent & tool listings)', mcp_instructions_delta: '(skill, agent & tool listings)', file: '(files & edit notices)', edited_text_file: '(files & edit notices)' };
const SKIP_ATTACH = new Set(['prompt_snapshot']);

function sourceOf(s) {
  if (s.entry !== 'sdk-cli') return 'Your Claude Code chats';
  if (/^tmp|claude\/dashboard/.test(s.project)) return 'Tests & experiments';
  const p = s.firstPrompt;
  if (/^Use the \/\S+ skill/.test(p)) return 'Agentic OS: skill runs';
  if (/^You improve a Claude Code skill/.test(p)) return 'Agentic OS: teach';
  if (/NOTHING TO FLAG|^\[Routine/.test(p)) return 'Agentic OS: routines';
  if (/self-test|selftest|smoke test|stop test|^reply with: ok|^say /i.test(p)) return 'Agentic OS: tests';
  return 'Agentic OS: jobs';
}

function cost(model, u) {
  const b = BASE[tier(model)];
  const c1h = (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0;
  const c5m = (u.cache_creation_input_tokens || 0) - c1h;
  return { input: ((u.input_tokens || 0) * b) / 1e6, write: (c5m * 1.25 * b + c1h * 2 * b) / 1e6, read: ((u.cache_read_input_tokens || 0) * 0.1 * b) / 1e6, output: ((u.output_tokens || 0) * 5 * b) / 1e6 };
}

const blank = () => ({ calls: 0, input: 0, write: 0, read: 0, output: 0, thinking: 0, usd: 0, usdParts: { input: 0, write: 0, read: 0, output: 0 } });
function add(a, model, u) {
  const c = cost(model, u);
  a.calls++; a.input += u.input_tokens || 0; a.write += u.cache_creation_input_tokens || 0; a.read += u.cache_read_input_tokens || 0;
  a.output += u.output_tokens || 0; a.thinking += (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0;
  for (const k of Object.keys(c)) { a.usdParts[k] += c[k]; a.usd += c[k]; }
}

function describe(name, input) {
  if (!input) return '';
  const v = input.command || input.file_path || input.path || input.pattern || input.url || input.query || input.skill || input.description || input.prompt || '';
  return String(v).replace(/\s+/g, ' ').slice(0, 90);
}

async function readSession(file, seen) {
  const dir = path.relative(ROOT, file).split(path.sep)[0];
  const sub = file.includes(`${path.sep}subagents${path.sep}`);
  const s = { file, project: projectName(dir), session: sub ? path.basename(path.dirname(path.dirname(file))) : path.basename(file, '.jsonl'), subagent: sub, entry: '', firstPrompt: '', title: '', calls: [], tools: {}, carried: {}, big: [], prompts: { n: 0, tokens: 0 }, shape: null, compactions: 0, first: 0, last: 0 };
  const names = new Map();
  const active = {};
  const ctx = (key, tok) => { const a = s.tools[key] || (s.tools[key] = { n: 0, tokens: 0 }); a.n++; a.tokens += tok; active[key] = (active[key] || 0) + tok; };
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.entrypoint && !s.entry) s.entry = e.entrypoint;
    if (e.type === 'custom-title' && e.customTitle) s.title = e.customTitle;
    else if (e.type === 'ai-title' && e.aiTitle && !s.title) s.title = e.aiTitle;
    else if (e.type === 'api-request-shape' && e.shape) s.shape = e.shape;
    else if (e.type === 'system' && e.subtype === 'compact_boundary') { s.compactions++; for (const k of Object.keys(active)) active[k] = 0; }
    else if (e.type === 'assistant' && e.message) {
      const m = e.message;
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c.type === 'tool_use') names.set(c.id, { name: c.name, what: describe(c.name, c.input) });
        ctx(c.type === 'thinking' ? '(Claude: thinking)' : c.type === 'tool_use' ? '(Claude: tool inputs, e.g. Write/Edit text)' : '(Claude: replies)', est(c.type === 'tool_use' ? JSON.stringify(c.input || '').length : (c.text || c.thinking || '').length));
      }
      if (!m.usage || !m.id || seen.has(m.id)) continue;
      seen.add(m.id);
      const t = Date.parse(e.timestamp) || 0;
      s.calls.push({ t, model: m.model || '', u: m.usage });
      if (!s.first) s.first = t;
      s.last = t;
      for (const [k, v] of Object.entries(active)) s.carried[k] = (s.carried[k] || 0) + v;
    } else if (e.type === 'user' && e.message) {
      const c = e.message.content;
      if (typeof c === 'string' || (Array.isArray(c) && !c.some((x) => x.type === 'tool_result'))) {
        const text = typeof c === 'string' ? c : c.filter((x) => x.type === 'text').map((x) => x.text).join(' ');
        if (!s.firstPrompt && text && !text.startsWith('<')) s.firstPrompt = text.replace(/\s+/g, ' ').slice(0, 140);
        const tok = est(sizeOf(c));
        if (!e.isMeta) { s.prompts.n++; s.prompts.tokens += tok; }
        ctx(e.isMeta ? '(other reminders)' : '(your messages)', tok);
        continue;
      }
      for (const r of c.filter((x) => x.type === 'tool_result')) {
        const info = names.get(r.tool_use_id) || { name: '?', what: '' };
        const name = info.name.startsWith('mcp__') ? info.name.replace(/^mcp__([^_]+(?:_[^_]+)*?)__/, 'mcp:$1/') : info.name;
        const tok = est(sizeOf(r.content));
        ctx(name, tok);
        if (tok > 2000) s.big.push({ tool: name, tokens: tok, what: info.what, t: Date.parse(e.timestamp) || 0 });
      }
    } else if (e.type === 'attachment') {
      const type = (e.attachment && e.attachment.type) || '';
      if (!SKIP_ATTACH.has(type)) ctx(ATTACH[type] || '(other reminders)', est(JSON.stringify(e.attachment || '').length));
    }
  }
  return s;
}

function overhead(shape) {
  if (!shape) return null;
  const sys = est(JSON.stringify(shape.system || '').length);
  const tools = (shape.tools || []).map((t) => ({ name: t.name, tokens: est(JSON.stringify(t).length) })).sort((a, b) => b.tokens - a.tokens);
  return { system: sys, tools: tools.reduce((n, t) => n + t.tokens, 0), list: tools };
}

async function report(opts = {}) {
  const days = Number(opts.days) || 30;
  const since = Date.now() - days * 86400000;
  const seen = new Set();
  const list = files(since).sort((a, b) => a.includes('/subagents/') - b.includes('/subagents/'));
  const sessions = [];
  for (const f of list) {
    const s = await readSession(f, seen);
    s.calls = s.calls.filter((c) => c.t >= since);
    if (s.calls.length) sessions.push(s);
  }
  const parents = new Map(sessions.filter((s) => !s.subagent).map((s) => [s.session, s]));
  for (const s of sessions) {
    const p = s.subagent && parents.get(s.session);
    if (p) { s.entry = p.entry; s.title = p.title; if (!s.firstPrompt) s.firstPrompt = p.firstPrompt; s.parentPrompt = p.firstPrompt; }
    s.source = sourceOf(p ? { ...s, entry: p.entry, firstPrompt: p.firstPrompt } : s);
  }
  if (opts.session) return detail(sessions.filter((s) => s.session.startsWith(opts.session)), days);

  const r = { days, total: blank(), bySource: {}, byProject: {}, byModel: {}, byDay: {}, byHour: {}, tools: {}, carried: {}, big: [], sessions: [], subagents: blank(), overhead: null, compactions: 0, prompts: { n: 0, tokens: 0 } };
  const bump = (map, key, model, u) => add(map[key] || (map[key] = blank()), model, u);
  const bySession = new Map();
  for (const s of sessions) {
    r.compactions += s.compactions;
    r.prompts.n += s.prompts.n; r.prompts.tokens += s.prompts.tokens;
    for (const c of s.calls) {
      add(r.total, c.model, c.u);
      bump(r.bySource, s.source, c.model, c.u);
      bump(r.byProject, s.project, c.model, c.u);
      bump(r.byModel, c.model.replace(/^claude-/, '') || '?', c.model, c.u);
      bump(r.byDay, new Date(c.t).toISOString().slice(0, 10), c.model, c.u);
      bump(r.byHour, String(new Date(c.t).getHours()).padStart(2, '0'), c.model, c.u);
      if (s.subagent) add(r.subagents, c.model, c.u);
    }
    const agg = bySession.get(s.session) || { session: s.session, project: s.project, source: s.source, title: s.title || s.firstPrompt, ...blank(), subagents: 0, first: s.first, last: s.last, compactions: 0 };
    for (const c of s.calls) add(agg, c.model, c.u);
    if (s.subagent) agg.subagents++;
    agg.first = Math.min(agg.first || s.first, s.first); agg.last = Math.max(agg.last, s.last); agg.compactions += s.compactions;
    bySession.set(s.session, agg);
    for (const [k, v] of Object.entries(s.tools)) { const a = r.tools[k] || (r.tools[k] = { n: 0, tokens: 0 }); a.n += v.n; a.tokens += v.tokens; }
    for (const [k, v] of Object.entries(s.carried)) r.carried[k] = (r.carried[k] || 0) + v;
    for (const b of s.big) r.big.push({ ...b, project: s.project, session: s.session.slice(0, 8) });
    const o = overhead(s.shape);
    if (o && (!r.overhead || s.last > r.overhead.at)) r.overhead = { ...o, at: s.last, source: s.source };
  }
  const fallback = r.overhead ? r.overhead.system + r.overhead.tools : 0;
  for (const s of sessions) { const o = overhead(s.shape); r.carried['(system prompt & tool definitions)'] = (r.carried['(system prompt & tool definitions)'] || 0) + s.calls.length * (o ? o.system + o.tools : fallback); }
  r.contextTotal = r.total.read + r.total.write + r.total.input;
  r.sessions = [...bySession.values()].sort((a, b) => b.usd - a.usd);
  r.big = r.big.sort((a, b) => b.tokens - a.tokens).slice(0, 15);
  r.sessionCount = r.sessions.length;
  return r;
}

function detail(parts, days) {
  if (!parts.length) throw new Error('no session with that id in the window');
  const r = { days, session: parts[0].session, title: parts[0].title || parts[0].firstPrompt, project: parts[0].project, source: parts[0].source, total: blank(), main: blank(), subagents: [], tools: {}, carried: {}, big: [], timeline: [], compactions: 0 };
  for (const s of parts) {
    r.compactions += s.compactions;
    const a = s.subagent ? blank() : r.main;
    for (const c of s.calls) { add(r.total, c.model, c.u); add(a, c.model, c.u); r.timeline.push({ t: c.t, sub: s.subagent, model: c.model, ctx: (c.u.input_tokens || 0) + (c.u.cache_creation_input_tokens || 0) + (c.u.cache_read_input_tokens || 0), out: c.u.output_tokens || 0, usd: Object.values(cost(c.model, c.u)).reduce((x, y) => x + y, 0) }); }
    if (s.subagent) r.subagents.push({ prompt: s.firstPrompt, ...a });
    for (const [k, v] of Object.entries(s.tools)) { const x = r.tools[k] || (r.tools[k] = { n: 0, tokens: 0 }); x.n += v.n; x.tokens += v.tokens; }
    for (const [k, v] of Object.entries(s.carried)) r.carried[k] = (r.carried[k] || 0) + v;
    r.big.push(...s.big);
    if (!s.subagent) r.overhead = overhead(s.shape);
  }
  r.timeline.sort((a, b) => a.t - b.t);
  r.big = r.big.sort((a, b) => b.tokens - a.tokens).slice(0, 12);
  r.peakContext = Math.max(...r.timeline.map((x) => x.ctx));
  return r;
}

const M = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n));
const $ = (x) => `$${x.toFixed(2)}`;
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '0%');
const table = (rows) => {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => r.map((c, i) => (i ? String(c).padStart(w[i]) : String(c).padEnd(w[i]))).join('  ')).join('\n');
};
const usageRows = (map, limit) => [['', 'calls', 'fresh in', 'cache write', 'cache read', 'output', 'API $'], ...Object.entries(map).sort((a, b) => b[1].usd - a[1].usd).slice(0, limit || 99).map(([k, a]) => [k.slice(0, 34), a.calls, M(a.input), M(a.write), M(a.read), M(a.output), $(a.usd)])];

function text(r) {
  if (r.timeline) return detailText(r);
  const T = r.total;
  const carriedTotal = Object.values(r.carried).reduce((a, b) => a + b, 0) || 1;
  const out = [
    `TOKEN USAGE, last ${r.days} days: ${r.sessionCount} sessions, ${T.calls} model calls, ${r.compactions} compactions.`,
    `Estimated at API list prices (opus $5 / sonnet $3 / haiku $1 per M input; output 5x, cache write 1.25x or 2x, cache read 0.1x). On a subscription you don't pay this; it shows relative weight and drives the usage limits.`,
    '',
    'WHAT KIND OF TOKENS',
    table([['', 'tokens', 'share', 'API $', 'share of $'],
      ['cache read (context re-sent each call)', M(T.read), pct(T.read, T.read + T.write + T.input + T.output), $(T.usdParts.read), pct(T.usdParts.read, T.usd)],
      ['cache write (new context stored)', M(T.write), pct(T.write, T.read + T.write + T.input + T.output), $(T.usdParts.write), pct(T.usdParts.write, T.usd)],
      ['fresh input (uncached)', M(T.input), pct(T.input, T.read + T.write + T.input + T.output), $(T.usdParts.input), pct(T.usdParts.input, T.usd)],
      [`output (of which thinking ${M(T.thinking)})`, M(T.output), pct(T.output, T.read + T.write + T.input + T.output), $(T.usdParts.output), pct(T.usdParts.output, T.usd)],
      ['total', M(T.read + T.write + T.input + T.output), '', $(T.usd), '']]),
    '',
    'WHO USED IT',
    table(usageRows(r.bySource)),
    `Subagents (Agent tool / sidechains) inside those: ${r.subagents.calls} calls, ${$(r.subagents.usd)}.`,
    '',
    'BY PROJECT',
    table(usageRows(r.byProject, 12)),
    '',
    'BY MODEL',
    table(usageRows(r.byModel)),
    '',
    'WHAT FILLS THE CONTEXT (estimated from content size; "carried" = tokens re-read on every later call until compaction)',
    table([['', 'results', 'tokens added', 'carried', 'share of carried'], ...Object.entries(r.carried).sort((a, b) => b[1] - a[1]).slice(0, 16).map(([k, v]) => [k, (r.tools[k] || { n: '' }).n, M((r.tools[k] || { tokens: 0 }).tokens), M(v), pct(v, carriedTotal)])]),
    `Context actually sent: ${M(r.contextTotal)}; the estimate above explains ${pct(carriedTotal, r.contextTotal)} of it (the rest is images, compaction summaries and counting slack).`,
    `Your typed prompts: ${r.prompts.n} messages, about ${M(r.prompts.tokens)} tokens.`,
  ];
  if (r.overhead) out.push('', `FIXED OVERHEAD PER CALL (latest session with a recorded request shape): system prompt ~${M(r.overhead.system)}, tool definitions ~${M(r.overhead.tools)}.`, `Largest tool definitions: ${r.overhead.list.slice(0, 6).map((t) => `${t.name} ${M(t.tokens)}`).join(', ')}.`);
  out.push('', 'BIGGEST SINGLE TOOL RESULTS', table([['tool', 'tokens', 'project', 'what'], ...r.big.map((b) => [b.tool, M(b.tokens), b.project.slice(0, 22), b.what.slice(0, 70)])]));
  out.push('', 'MOST EXPENSIVE SESSIONS', table([['session', 'source', 'calls', 'subag', 'API $', 'title'], ...r.sessions.slice(0, 12).map((s) => [s.session.slice(0, 8), s.source.replace('Agentic OS: ', 'OS ').replace('Your Claude Code chats', 'you'), s.calls, s.subagents, $(s.usd), (s.title || '').slice(0, 60)])]));
  out.push('', 'BY DAY', table([['day', 'calls', 'output', 'API $'], ...Object.entries(r.byDay).sort().map(([d, a]) => [d, a.calls, M(a.output), $(a.usd)])]));
  out.push('', 'Detail for one session: node scripts/token-usage.js --session <id prefix>');
  return out.join('\n');
}

function detailText(r) {
  const carriedTotal = Object.values(r.carried).reduce((a, b) => a + b, 0) || 1;
  const out = [`SESSION ${r.session} (${r.source}, ${r.project})`, r.title || '', `${r.total.calls} calls, ${$(r.total.usd)}, peak context ${M(r.peakContext)} tokens, ${r.compactions} compactions.`, '',
    table(usageRows({ 'main thread': r.main, ...Object.fromEntries(r.subagents.map((s, i) => [`subagent ${i + 1}: ${(s.prompt || '').slice(0, 22)}`, s])) })), '',
    'WHAT FILLED THE CONTEXT', table([['', 'results', 'tokens added', 'carried', 'share'], ...Object.entries(r.carried).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => [k, (r.tools[k] || { n: '' }).n, M((r.tools[k] || { tokens: 0 }).tokens), M(v), pct(v, carriedTotal)])])];
  if (r.overhead) out.push('', `Fixed per call: system ~${M(r.overhead.system)}, tools ~${M(r.overhead.tools)} (${r.overhead.list.slice(0, 5).map((t) => `${t.name} ${M(t.tokens)}`).join(', ')}).`);
  if (r.big.length) out.push('', 'BIGGEST TOOL RESULTS', table([['tool', 'tokens', 'what'], ...r.big.map((b) => [b.tool, M(b.tokens), b.what.slice(0, 80)])]));
  return out.join('\n');
}

module.exports = { report, text };
if (require.main === module) {
  const { opt } = parseArgs(process.argv.slice(2));
  report({ days: opt.days, session: opt.session }).then((r) => process.stdout.write((opt.json ? JSON.stringify(r, null, 1) : text(r)) + '\n'), (e) => { process.stderr.write(e.message + '\n'); process.exit(2); });
}
