'use strict';
// The plan's usage limits (5-hour and weekly windows) as Claude Code reports them: read from every agent's stream and from a
// tiny probe call, kept in data/limits.json, with an estimate of each window's size in dollars and tokens. Near
// defaults.limitPauseAt (85%) new work is held until the user continues or the window resets.

function install(ctx) {
  const { DATA, fs, os, path, spawn, CLAUDE_BIN, now, readJson, broadcast, childEnv, readLines, agents, pump, pumpResident } = ctx;

  const LIMITS_FILE = path.join(DATA, 'limits.json');
  const limits = { windows: {}, status: null, samples: [], spend: 0, tokens: 0, updatedAt: null };
  try { Object.assign(limits, JSON.parse(fs.readFileSync(LIMITS_FILE, 'utf8'))); } catch {}
  try { limits.plan = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8')).claudeAiOauth.subscriptionType || null; } catch { limits.plan = null; }
  let limitsTimer = null;
  let probing = null;

  function saveLimits() {
    clearTimeout(limitsTimer);
    limitsTimer = setTimeout(() => { try { fs.writeFileSync(LIMITS_FILE, JSON.stringify(limits)); } catch {} }, 500);
  }

  function noteSpend(usd, usage) {
    const u = usage || {};
    limits.spend += usd || 0;
    // Spend per calendar day, for the daily spending limit (defaults.dailySpendUsd).
    const day = new Date().toDateString();
    if (limits.day !== day) { limits.day = day; limits.daySpend = 0; }
    limits.daySpend = (limits.daySpend || 0) + (usd || 0);
    limits.tokens += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
    saveLimits();
  }

  function onRateLimit(info) {
    if (!info) return;
    const w = { ...(info.unifiedWindows || {}) };
    if (!Object.keys(w).length && info.rateLimitType && info.utilization != null) w[info.rateLimitType] = { utilization: info.utilization, resetsAt: info.resetsAt };
    for (const [k, v] of Object.entries(w)) {
      if (v && v.utilization != null) limits.windows[k] = { utilization: v.utilization, resetsAt: v.resetsAt ? v.resetsAt * 1000 : null };
    }
    limits.status = info.status || null;
    limits.limitedBy = info.rateLimitType || null;
    limits.usingOverage = !!info.isUsingOverage;
    limits.updatedAt = now();
    limits.samples.push({ t: now(), spend: limits.spend, tokens: limits.tokens,
      w: Object.fromEntries(Object.entries(limits.windows).map(([k, v]) => [k, [v.utilization, v.resetsAt]])) });
    if (limits.samples.length > 3000) limits.samples = limits.samples.slice(-2000);
    checkHold();
    saveLimits();
    broadcast({ type: 'limits', limits: limitsView() });
  }

  function windowEstimate(k) {
    const cur = limits.windows[k];
    let du = 0, ds = 0, dt = 0, prev = null;
    for (const sm of limits.samples) {
      const v = sm.w[k];
      if (!v) { prev = null; continue; }
      if (prev && prev.v[1] === v[1] && sm.t - prev.t <= 900000) {
        const u = v[0] - prev.v[0], sp = sm.spend - prev.spend;
        if (u >= 0 && sp > 0.02) { du += u; ds += sp; dt += sm.tokens - prev.tokens; }
      }
      prev = { v, t: sm.t, spend: sm.spend, tokens: sm.tokens };
    }
    const est = { calibratedOnUsd: ds, calibratedOnPoints: Math.round(du * 100) };
    if (du >= 0.03 && ds >= 1) {
      est.pctPerUsd = du / ds;
      est.fullUsd = ds / du;
      est.fullTokens = dt > 0 ? dt / du : null;
    }
    if (cur) {
      const live = cur.resetsAt && cur.resetsAt < now() ? 0 : cur.utilization;
      if (est.fullUsd) {
        est.remainingUsd = Math.max(0, 1 - live) * est.fullUsd;
        if (est.fullTokens) est.remainingTokens = Math.max(0, 1 - live) * est.fullTokens;
      }
      const recent = limits.samples.filter((sm) => sm.w[k] && sm.w[k][1] === cur.resetsAt && sm.t > now() - 3600000);
      if (recent.length > 1 && live > 0) {
        const a = recent[0], b = recent[recent.length - 1];
        const hours = (b.t - a.t) / 3600000;
        const rate = hours > 0.25 ? (b.w[k][0] - a.w[k][0]) / hours : null;
        if (rate > 0) { est.perHour = rate; est.hitsAt = now() + ((1 - live) / rate) * 3600000; }
      }
    }
    return est;
  }

  function limitHold() {
    const pauseAt = readJson('roster.json').defaults.limitPauseAt || 0.85;
    limits.approved = limits.approved || {};
    for (const [k, w] of Object.entries(limits.windows)) {
      if (!w.resetsAt || w.resetsAt < now()) continue;
      const ok = limits.approved[k];
      const bar = ok && ok.resetsAt === w.resetsAt ? Math.min(1, Math.max(pauseAt, ok.at + 0.1)) : pauseAt;
      if (w.utilization >= bar) return { window: k, utilization: w.utilization, resetsAt: w.resetsAt };
    }
    return null;
  }

  function checkHold() {
    const was = limits.hold;
    const h = limitHold();
    limits.hold = h;
    if (h && (!was || was.window !== h.window || was.resetsAt !== h.resetsAt)) {
      const label = h.window === 'five_hour' ? '5-hour' : h.window === 'seven_day' ? 'weekly' : h.window.replace(/_/g, ' ');
      broadcast({ type: 'notify', kind: 'limit', title: `Your ${label} limit is at ${Math.round(h.utilization * 100)}%`,
        text: 'New work is paused. Continue anyway, or let it wait for the reset.' });
    }
    if (!h && was) kickAll();
  }

  function continuePastLimit() {
    limits.approved = limits.approved || {};
    for (const [k, w] of Object.entries(limits.windows)) {
      if (w.resetsAt && w.resetsAt > now()) limits.approved[k] = { resetsAt: w.resetsAt, at: w.utilization };
    }
    saveLimits();
    checkHold();
    broadcast({ type: 'limits', limits: limitsView() });
  }

  function kickAll() {
    pump();
    for (const a of agents.values()) if (a.resident) pumpResident(a);
  }

  function limitsView() {
    return { plan: limits.plan, hold: limits.hold || null, pauseAt: readJson('roster.json').defaults.limitPauseAt || 0.85, status: limits.status, limitedBy: limits.limitedBy, usingOverage: limits.usingOverage,
      updatedAt: limits.updatedAt, spend: limits.spend, tokens: limits.tokens, probing: !!probing,
      today: limits.day === new Date().toDateString() ? limits.daySpend || 0 : 0, dailyCap: Number(readJson('roster.json').defaults.dailySpendUsd) || 0,
      windows: Object.fromEntries(Object.entries(limits.windows).map(([k, v]) => [k, { ...v, est: windowEstimate(k) }])) };
  }

  function probeLimits() {
    if (probing) return probing;
    probing = new Promise((resolve) => {
      const child = spawn(CLAUDE_BIN, ['-p', 'Reply with: ok', '--model', 'haiku', '--effort', 'low', '--output-format', 'stream-json', '--verbose',
        '--strict-mcp-config', '--max-turns', '1'],
        { cwd: DATA, env: childEnv({ id: 'limits-probe' }), stdio: ['ignore', 'pipe', 'ignore'] });
      readLines(child.stdout, (line) => {
        let m;
        try { m = JSON.parse(line); } catch { return; }
        if (m.type === 'rate_limit_event') onRateLimit(m.rate_limit_info);
        else if (m.type === 'result') noteSpend(m.total_cost_usd || 0, m.usage);
      });
      const done = () => { probing = null; broadcast({ type: 'limits', limits: limitsView() }); resolve(); };
      child.on('close', done);
      child.on('error', done);
    });
    broadcast({ type: 'limits', limits: limitsView() });
    return probing;
  }

  return { LIMITS_FILE, limits, saveLimits, noteSpend, onRateLimit, windowEstimate, checkHold, continuePastLimit, limitsView, probeLimits };
}

module.exports = { install };
