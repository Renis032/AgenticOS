#!/usr/bin/env node
'use strict';
const os = require('os');
const readline = require('readline');
const { parseArgs, fs, path } = require('./_util');

const BASE = { opus: 5, sonnet: 3, haiku: 1 };
const PING_EVERY = 50 * 60000;
const WARM_FOR = 4 * 3600000;
const tier = (m) => (/haiku/i.test(m) ? 'haiku' : /sonnet/i.test(m) ? 'sonnet' : 'opus');

function filesSince(dir, since) {
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
  walk(dir);
  return out;
}

async function calls(file) {
  const seen = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const m = e.message;
    if (!m || !m.usage || !e.timestamp) continue;
    const key = m.id || e.uuid;
    if (!seen.has(key)) seen.set(key, { t: Date.parse(e.timestamp), model: m.model || '', u: m.usage, session: e.sessionId });
  }
  return [...seen.values()].sort((a, b) => a.t - b.t);
}

async function report(opts) {
  const days = (opts && opts.days) || 30;
  const since = Date.now() - days * 86400000;
  const office = new Set((opts && opts.officeSessions) || []);
  const files = filesSince(path.join(os.homedir(), '.claude', 'projects'), since);
  const r = { days, sessions: 0, calls: 0, cold: 0, coldTokens: 0, coldUsd: 0, savable: 0, savableUsd: 0, pingUsd: 0, longGaps: 0, office: { cold: 0, coldUsd: 0, savableUsd: 0, pingUsd: 0 }, worst: [] };
  for (const f of files) {
    const list = (await calls(f)).filter((c) => c.t >= since);
    if (!list.length) continue;
    r.sessions++;
    r.calls += list.length;
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1], c = list[i];
      const gap = c.t - prev.t;
      const oneHour = (c.u.cache_creation && c.u.cache_creation.ephemeral_1h_input_tokens) || (prev.u.cache_creation && prev.u.cache_creation.ephemeral_1h_input_tokens);
      const ttl = oneHour ? 3600000 : 300000;
      const write = c.u.cache_creation_input_tokens || 0;
      if (gap <= ttl || write < 10000) continue;
      const base = BASE[tier(c.model)];
      const wMul = oneHour ? 2 : 1.25;
      const usd = (write * (wMul - 0.1) * base) / 1e6;
      const isOffice = office.has(c.session);
      r.cold++; r.coldTokens += write; r.coldUsd += usd;
      if (isOffice) { r.office.cold++; r.office.coldUsd += usd; }
      if (gap <= WARM_FOR) {
        const pings = Math.max(1, Math.ceil((gap - (oneHour ? 0 : 0)) / PING_EVERY) - 1);
        const pingUsd = (pings * write * 0.1 * base) / 1e6 + pings * 0.0005;
        r.savable++; r.savableUsd += usd; r.pingUsd += pingUsd;
        if (isOffice) { r.office.savableUsd += usd; r.office.pingUsd += pingUsd; }
      } else r.longGaps++;
      r.worst.push({ t: c.t, gapMin: Math.round(gap / 60000), tokens: write, usd, model: tier(c.model), file: path.basename(path.dirname(f)), office: isOffice });
    }
  }
  r.worst = r.worst.sort((a, b) => b.usd - a.usd).slice(0, 8);
  r.netUsd = r.savableUsd - r.pingUsd;
  r.pays = r.netUsd > 0.5;
  r.officePays = r.office.savableUsd - r.office.pingUsd > 0.25;
  return r;
}

function text(r) {
  const $ = (x) => `$${x.toFixed(2)}`;
  return [`Last ${r.days} days: ${r.sessions} chats, ${r.calls} model calls.`,
    `Cold cache reloads: ${r.cold} (${(r.coldTokens / 1e6).toFixed(1)}M tokens re-sent), about ${$(r.coldUsd)} at API prices.`,
    `${r.savable} of them came after a gap under 4 hours. Keeping those chats warm (a tiny ping every 50 min) would have saved ${$(r.savableUsd)} and cost ${$(r.pingUsd)} in pings: net ${$(r.netUsd)}.`,
    `${r.longGaps} reloads came after gaps over 4 hours; pinging would not have helped.`,
    r.office.cold ? `Agentic OS leads: ${r.office.cold} cold reloads, ${$(r.office.coldUsd)}; warm pings would net ${$(r.office.savableUsd - r.office.pingUsd)}.` : '',
    `Verdict: ${r.pays ? 'keep-warm pays for your chats.' : 'keep-warm does not pay for your chats.'} ${r.officePays ? 'It pays for the Agentic OS leads.' : 'It does not pay for the Agentic OS leads.'}`,
    '(Estimates at API list prices: input opus $5, sonnet $3, haiku $1 per million tokens; cache write 2× (1h) or 1.25× (5 min), read 0.1×.)'].filter(Boolean).join('\n');
}

module.exports = { report, text };
if (require.main === module) {
  const { opt } = parseArgs(process.argv.slice(2));
  report({ days: Number(opt.days) || 30 }).then((r) => process.stdout.write((opt.json ? JSON.stringify(r, null, 1) : text(r)) + '\n'), (e) => { process.stderr.write(e.message + '\n'); process.exit(2); });
}
