'use strict';
// Reading an agent's output stream (events, live spend, the text being written) and the money side of jobs: exact costs and budgets. Moved out of server.js unchanged.

function install(ctx) {
  const { addEvent, broadcast, budgetWaiters, childRolesFor, DATA, fs, noteSpend, now, officeNote, onRateLimit, path, readJson, SCRIPTS,
    spawn, thread, tickets, touch, touchTicket, usageIndex } = ctx;

  function readLines(stream, onLine) {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onLine(line);
      }
    });
  }

  function blockText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
    return JSON.stringify(content);
  }

  function onStreamMessage(a, m) {
    if (m.type === 'system' && m.subtype === 'init') {
      if (a.sessionId !== m.session_id) {
        a.sessionId = m.session_id;
        a.sessionStartedAt = now();
        a.contextTokens = 0;
        addEvent(a, { kind: 'system', text: `Session ${m.session_id.slice(0, 8)} · ${m.model} · ${m.cwd}` });
        try { fs.appendFileSync(path.join(DATA, 'sessions.jsonl'), JSON.stringify({ t: now(), sid: m.session_id, agentId: a.id, persona: a.persona, role: a.role, name: a.name, homeId: a.resident ? a.id : a.homeId, ticketId: a.resident ? (a.current && a.current.ticketId) || null : a.ticketId || null }) + '\n'); } catch {}
        touch(a);
      }
    } else if (m.type === 'stream_event' && m.event) {
      const e = m.event;
      if (e.type === 'content_block_start') setDraft(a, e.content_block && e.content_block.type === 'text' ? '' : null);
      else if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta' && a.draft != null) setDraft(a, a.draft + e.delta.text);
    } else if (m.type === 'assistant' && m.message) {
      const u = m.message.usage;
      if (u && m.message.id && m.message.id !== a.liveMsgId) {
        // Estimate of this turn's spend so far; the exact figure replaces it when the turn ends.
        const cc = u.cache_creation || {};
        a.liveMsgId = m.message.id;
        contextNudge(a, (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0));
        a.liveUsd = (a.liveUsd || 0) + usageIndex.cost({ model: m.message.model || a.model, in: u.input_tokens || 0, r: u.cache_read_input_tokens || 0,
          w5: cc.ephemeral_5m_input_tokens != null ? cc.ephemeral_5m_input_tokens : u.cache_creation_input_tokens || 0, w1: cc.ephemeral_1h_input_tokens || 0, out: u.output_tokens || 0 }).total;
        touch(a);
      }
      for (const b of m.message.content || []) {
        if (b.type === 'thinking' && b.thinking) addEvent(a, { kind: 'thinking', text: b.thinking });
        else if (b.type === 'text' && b.text.trim()) addEvent(a, { kind: 'text', text: b.text });
        else if (b.type === 'tool_use') addEvent(a, { kind: 'tool_use', id: b.id, name: b.name, input: b.input });
      }
    } else if (m.type === 'user' && m.message && Array.isArray(m.message.content)) {
      for (const b of m.message.content) {
        if (b.type === 'tool_result') {
          const text = blockText(b.content);
          addEvent(a, { kind: 'tool_result', toolUseId: b.tool_use_id, isError: !!b.is_error,
            text: text.length > 6000 ? text.slice(0, 6000) + `\n… (${text.length - 6000} more chars)` : text });
        }
      }
    } else if (m.type === 'rate_limit_event') {
      onRateLimit(m.rate_limit_info);
    } else if (m.type === 'result') {
      const cum = m.total_cost_usd || 0;
      const sid = m.session_id || a.sessionId;
      const prev = a.costSid === sid ? a.costCum || 0 : 0;
      const cost = cum >= prev ? cum - prev : cum;
      a.costSid = sid;
      a.costCum = cum;
      a.costUsd += cost;
      a.liveUsd = 0;
      setDraft(a, null);
      refreshExactSoon();
      chargeTicket(a, cost);
      noteSpend(cost, m.usage);
      const it = m.usage && Array.isArray(m.usage.iterations) && m.usage.iterations.length ? m.usage.iterations[m.usage.iterations.length - 1] : m.usage;
      if (it) a.contextTokens = (it.input_tokens || 0) + (it.cache_read_input_tokens || 0) + (it.cache_creation_input_tokens || 0) + (it.output_tokens || 0);
      if (a.resident && !a.sessionStartedAt) a.sessionStartedAt = now();
      a.turns += m.num_turns || 0;
      addEvent(a, { kind: 'result', text: m.result || '', isError: !!m.is_error, subtype: m.subtype,
        costUsd: cost, sessionCostUsd: cum, model: a.model, durationMs: m.duration_ms, turns: m.num_turns, ticketId: a.current && a.current.ticketId });
      return { done: true, text: m.result || '', isError: !!m.is_error || m.subtype !== 'success' };
    }
    return null;
  }

  // The text block an agent is writing right now, sent to the window a few times a second (never saved).
  const draftTimers = new Map();
  function setDraft(a, text) {
    a.draft = text;
    if (draftTimers.has(a.id)) return;
    draftTimers.set(a.id, setTimeout(() => {
      draftTimers.delete(a.id);
      broadcast({ type: 'draft', agentId: a.id, text: a.draft || null });
    }, 150));
  }

  // The per-job budget in USD, or null when jobs have no budget (defaults.ticketBudgetUsd null or 0; the plan's usage limits still apply).
  function ticketBudget() {
    const v = readJson('roster.json').defaults.ticketBudgetUsd;
    return typeof v === 'number' && v > 0 ? v : null;
  }

  // Job costs from the exact per-call token counts in Claude Code's transcripts, priced per model (scripts/job-cost.js --all).
  // Claude Code's own running total, which chargeTicket adds up live, undercounts some cache writes; this replaces it every 10 minutes
  // and shortly after a turn ends. The live figure is kept as costRecordedUsd.
  let exactRunning = false;
  function refreshExactCosts() {
    if (exactRunning) return;
    exactRunning = true;
    const child = spawn(process.execPath, [path.join(SCRIPTS, 'job-cost.js'), '--all'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('close', () => {
      exactRunning = false;
      let rows = [];
      try { rows = JSON.parse(out); } catch { return; }
      const byN = new Map(rows.map((r) => [r.n, r]));
      for (const t of tickets.values()) {
        const r = byN.get(t.n);
        if (!r || !(r.usd > 0) || Math.abs((t.costUsd || 0) - r.usd) < 0.01) continue;
        if (t.costRecordedUsd == null) t.costRecordedUsd = t.costUsd || 0;
        t.costUsd = r.usd;
        t.costExact = true;
        touchTicket(t);
      }
    });
  }
  setInterval(refreshExactCosts, 10 * 60000);
  setTimeout(refreshExactCosts, 60000);
  let exactSoon = null;
  const refreshExactSoon = () => { clearTimeout(exactSoon); exactSoon = setTimeout(refreshExactCosts, 45000); };

  // A lead whose own conversation grows past defaults.leadContextNudge (100k tokens) is reminded, then again every 50k more, to keep
  // itself to planning and review and hand the long reading and editing to teammates with fresh contexts. Its context is re-read
  // on every call, so this is the biggest cost on long jobs.
  function contextNudge(a, ctx) {
    a.liveContext = ctx;
    const roster = readJson('roster.json');
    const at = Number(roster.defaults.leadContextNudge ?? 100000);
    if (!at || !a.resident || a.id === roster.root || !childRolesFor(roster, a).length) return;
    if (ctx < Math.max(at, (a.ctxNudgedAt || 0) + 50000)) return;
    a.ctxNudgedAt = ctx;
    officeNote(a.id, `Your own context is now ${Math.round(ctx / 1000)}k tokens, and every call re-reads all of it. From here, keep yourself to ` +
      'planning, briefing and review: hand the remaining reading, searching and editing to a teammate with a fresh context (`delegate`, with a ' +
      'precise brief and the file:line pointers you already have), and ask for a short report back. Read only what you need to decide.');
    addEvent(a, { kind: 'system', text: `Context ${Math.round(ctx / 1000)}k: reminded to delegate the remaining long work.` });
  }

  function chargeTicket(a, usd) {
    const t = a.resident ? (a.current && tickets.get(a.current.ticketId)) : tickets.get(a.ticketId);
    if (!t || !usd) return;
    t.costUsd = (t.costUsd || 0) + usd;
    const limit = ticketBudget();
    if (limit == null) {
      if (t.overBudget) { t.overBudget = false; releaseBudget(t, true); }
      touchTicket(t);
      return;
    }
    if (t.budgetUsd == null) t.budgetUsd = limit;
    if (!t.overBudget && t.costUsd >= t.budgetUsd && t.status === 'open') {
      t.overBudget = true;
      thread(t, { from: 'system', kind: 'system', text: `Reached the $${t.budgetUsd.toFixed(2)} budget ($${t.costUsd.toFixed(2)} spent). New sub-agents wait until you raise it.` });
    }
    touchTicket(t);
  }

  function waitForBudget(t) {
    if (!t || !t.overBudget || t.status !== 'open' || ticketBudget() == null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const list = budgetWaiters.get(t.id) || [];
      list.push(resolve);
      budgetWaiters.set(t.id, list);
    });
  }

  function releaseBudget(t, ok) {
    const list = budgetWaiters.get(t.id) || [];
    budgetWaiters.delete(t.id);
    list.forEach((r) => r(ok));
  }

  return { readLines, onStreamMessage, ticketBudget, waitForBudget,
    releaseBudget };
}

module.exports = { install };
