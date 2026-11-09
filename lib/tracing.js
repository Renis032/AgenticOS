'use strict';
// One trace per job: a span for the job, each agent's turn inside it and each tool call inside that, with model and
// cost on the turns. Built from the events agents already produce and kept in data/traces/<job id>.jsonl (tool names and
// timing only, never their inputs). GET /api/tickets/<id>/trace shows it; ?format=otlp gives OpenTelemetry JSON.
const crypto = require('crypto');

const MAX_FILES = 1000;
const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');

function install(ctx) {
  const { DATA, fs, now, path, ticketOfAgent, tickets } = ctx;
  const dir = path.join(DATA, 'traces');
  const turns = new Map();  // agent id → open turn
  const tools = new Map();  // tool_use id → open tool call
  const fileOf = (id) => path.join(dir, `${String(id).replace(/\W/g, '')}.jsonl`);
  const rootId = (t) => t.traceId.slice(0, 16);

  function prune() {
    try {
      const files = fs.readdirSync(dir).map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m);
      for (const x of files.slice(MAX_FILES)) fs.unlinkSync(path.join(dir, x.f));
    } catch { /* no traces yet */ }
  }
  prune();
  const timer = setInterval(prune, 6 * 3600000);
  if (timer.unref) timer.unref();

  function write(ticketId, span) {
    try { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(fileOf(ticketId), JSON.stringify(span) + '\n'); } catch { /* tracing never gets in the way of work */ }
  }
  function closeTurn(a, attrs, status) {
    const o = turns.get(a.id);
    if (!o) return;
    turns.delete(a.id);
    write(o.ticketId, { id: o.id, parent: o.parent, name: `turn ${a.persona}`, start: o.start, end: now(), status, attrs: { agent: a.id, ...attrs } });
  }

  function onEvent(a, ev) {
    if (ev.kind === 'brief' || ev.kind === 'followup') {
      if (ev.chore) return;
      const t = tickets.get(ev.ticketId) || ticketOfAgent(a);
      if (!t) return;
      if (!t.traceId) t.traceId = hex(16);
      closeTurn(a, {}, 'incomplete');
      const up = turns.get(a.parentId);
      turns.set(a.id, { id: hex(8), parent: up ? up.id : rootId(t), start: now(), ticketId: t.id });
    } else if (ev.kind === 'tool_use') {
      const o = turns.get(a.id);
      if (o) tools.set(ev.id, { name: ev.name, start: now(), turn: o });
    } else if (ev.kind === 'tool_result') {
      const c = tools.get(ev.toolUseId);
      if (!c) return;
      tools.delete(ev.toolUseId);
      write(c.turn.ticketId, { id: hex(8), parent: c.turn.id, name: `tool ${c.name}`, start: c.start, end: now(), status: ev.isError ? 'error' : 'ok', attrs: { tool: c.name } });
    } else if (ev.kind === 'result') {
      closeTurn(a, { model: ev.model || a.model, costUsd: ev.costUsd || 0, turns: ev.turns || 0 }, ev.isError ? 'error' : 'ok');
    }
  }

  function view(t) {
    let spans = [];
    try { spans = fs.readFileSync(fileOf(t.id), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none yet */ }
    if (!t.traceId) return { traceId: null, spans: [] };
    const root = { id: rootId(t), parent: null, name: `job #${t.n}`, start: t.createdAt, end: t.closedAt || now(), status: t.status === 'failed' ? 'error' : 'ok', attrs: { job: t.n, jobStatus: t.status, project: t.project || '', costUsd: t.costUsd || 0 } };
    return { traceId: t.traceId, spans: [root, ...spans] };
  }

  function otlp(t) {
    const { traceId, spans } = view(t);
    const ns = (ms) => `${Math.round(ms)}000000`;
    const attr = (k, v) => ({ key: k, value: typeof v === 'number' ? { doubleValue: v } : { stringValue: String(v) } });
    return { resourceSpans: [{ resource: { attributes: [attr('service.name', 'agentos')] }, scopeSpans: [{ scope: { name: 'agentos' }, spans: spans.map((s) => ({
      traceId, spanId: s.id, ...(s.parent ? { parentSpanId: s.parent } : {}), name: s.name, kind: 1, startTimeUnixNano: ns(s.start), endTimeUnixNano: ns(s.end),
      attributes: Object.entries(s.attrs || {}).map(([k, v]) => attr(k, v)), status: { code: s.status === 'error' ? 2 : 1 } })) }] }] };
  }

  const remove = (id) => { try { fs.unlinkSync(fileOf(id)); } catch { /* none */ } };

  async function route(req, res, url, p, body, json) {
    const m = req.method === 'GET' && p.match(/^\/api\/tickets\/(\w+)\/trace$/);
    if (!m) return false;
    const t = tickets.get(m[1]);
    if (!t) json(res, 404, { error: 'not found' });
    else json(res, 200, url.searchParams.get('format') === 'otlp' ? otlp(t) : view(t));
    return true;
  }
  return { onEvent, otlp, remove, route, view };
}

module.exports = { install };
