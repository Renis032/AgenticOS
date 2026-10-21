#!/usr/bin/env node
'use strict';
const os = require('os');
const crypto = require('crypto');
const { parseArgs, cli, fs, path } = require('./_util');

const ROOT = path.join(__dirname, '..');
const STOP = new Set('a an the and or but if then to of in on at for from with by is are was were be been it this that these those i you me my your we our us can could would should will just please now also not no yes do does did make get let use using into out up so as about what which who how when where why there here all any some more most very really want need like ok okay'.split(' '));
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const words = (s) => [...new Set(String(s).toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/[\/~][\w./-]+/g, ' ').replace(/\d+/g, ' ').match(/[\p{L}][\p{L}\p{N}_-]{2,}/gu) || [])].filter((w) => !STOP.has(w));
const jaccard = (a, b) => { const B = new Set(b); let i = 0; for (const x of a) if (B.has(x)) i++; return i / (a.length + b.length - i || 1); };
const isQuestion = (s) => /\?\s*$/.test(s) || /^(is|are|can|could|would|should|do|does|did|what|why|how|which|where|when|who)\b/i.test(s.trim());
const id = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);

function prompts(since) {
  const out = [];
  try {
    for (const l of fs.readFileSync(path.join(os.homedir(), '.claude', 'history.jsonl'), 'utf8').split('\n')) {
      if (!l) continue;
      let e; try { e = JSON.parse(l); } catch { continue; }
      const text = String(e.display || '').replace(/\[(Pasted text|Image) #\d+[^\]]*\]/gi, ' ').replace(/\s+/g, ' ').trim();
      if (!text || text.startsWith('/') || e.timestamp < since || text.length < 12 || isQuestion(text)) continue;
      out.push({ text, t: e.timestamp, where: e.project, src: 'Claude Code' });
    }
  } catch {}
  try {
    for (const t of JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tickets.json'), 'utf8')).tickets) {
      if (t.createdAt < since || t.review || t.routine || t.teamAsk || /self-test/i.test(t.title)) continue;
      out.push({ text: t.text, t: t.createdAt, where: t.project || 'Agentic OS', src: 'Agentic OS' });
    }
  } catch {}
  return out.map((p) => ({ ...p, w: words(p.text) })).filter((p) => p.w.length >= 2);
}

function clusters(list, threshold, min) {
  const groups = [];
  for (const p of list) {
    let best = null, bs = 0;
    for (const g of groups) { const s = jaccard(p.w, g.w); if (s > bs) { bs = s; best = g; } }
    if (best && bs >= threshold) { best.items.push(p); for (const x of p.w) best.freq[x] = (best.freq[x] || 0) + 1; best.w = Object.keys(best.freq).filter((x) => best.freq[x] * 2 >= best.items.length); }
    else groups.push({ items: [p], w: p.w, freq: Object.fromEntries(p.w.map((x) => [x, 1])) });
  }
  return groups.filter((g) => g.items.length >= min).sort((a, b) => b.items.length - a.items.length);
}

function routineCards(days, min) {
  const since = Date.now() - days * 86400000;
  return clusters(prompts(since), 0.4, min).slice(0, 12).map((g) => {
    const items = g.items.sort((a, b) => b.t - a.t);
    const dayCount = {}, hourCount = {};
    for (const it of items) { const d = new Date(it.t); dayCount[d.getDay()] = (dayCount[d.getDay()] || 0) + 1; hourCount[d.getHours()] = (hourCount[d.getHours()] || 0) + 1; }
    const day = Number(Object.entries(dayCount).sort((a, b) => b[1] - a[1])[0][0]);
    const hour = Number(Object.entries(hourCount).sort((a, b) => b[1] - a[1])[0][0]);
    const spread = Object.keys(dayCount).length;
    const top = Object.entries(g.freq).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([w]) => w);
    const passive = /\b(check|watch|monitor|scan|look for|alert|any new|status)\b/i.test(items.map((i) => i.text).join(' '));
    const schedule = spread >= 4 ? { type: 'daily', at: `${String(hour).padStart(2, '0')}:00` } : { type: 'weekly', day, at: `${String(hour).padStart(2, '0')}:00` };
    return {
      id: 'r-' + id(top.join(' ') + items.length), kind: 'routine', title: top.join(' · '), count: items.length,
      what: `You asked for this ${items.length} times in ${days} days (${[...new Set(items.map((i) => i.src))].join(', ')}). As a routine it runs by itself${passive ? ' and only pings you when something is worth flagging' : ' and hands you the result'}.`,
      when: schedule.type === 'daily' ? `every day at ${schedule.at}` : `every ${DAYS[day]} at ${schedule.at}`,
      saves: `about ${items.length * 4} minutes of asking and waiting per ${days === 7 ? 'week' : `${days} days`}`,
      examples: items.slice(0, 3).map((i) => i.text.slice(0, 220)),
      routine: { name: top.slice(0, 3).join(' ').replace(/^./, (c) => c.toUpperCase()), prompt: items[0].text, schedule, mode: passive ? 'passive' : 'active' },
    };
  });
}

function memoryCards() {
  let agents = [];
  try { agents = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'agents.json'), 'utf8')); } catch {}
  const cards = [];
  for (const a of agents) {
    const fb = (a.feedback || []).map((f) => ({ ...f, w: words(f.text) })).filter((f) => f.w.length >= 3);
    const g = clusters(fb, 0.3, 2)[0];
    if (!g) continue;
    cards.push({ id: 'm-' + id(a.id + g.items.length + g.w.join()), kind: 'memory', agentId: a.id, title: `${a.persona}: the same correction ${g.items.length}×`,
      what: `${a.persona} (${a.name}) was told the same thing ${g.items.length} times. Their memory missed it; calibrate it so it sticks.`,
      when: 'once', saves: 'one less repeated correction', examples: g.items.slice(0, 3).map((f) => `${f.fromPersona}: ${f.text.slice(0, 200)}`),
      fix: `Calibrate ${a.persona}'s memory: turn this repeated feedback into one principle and fold it into their memory — ${g.items.map((f) => f.text).join(' | ').slice(0, 600)}` });
  }
  return cards;
}

function suggest(opts) {
  const days = (opts && opts.days) || 7;
  return { at: Date.now(), days, cards: [...routineCards(days, (opts && opts.min) || 3), ...memoryCards()] };
}

function run(argv) {
  const { opt } = parseArgs(argv);
  const r = suggest({ days: Number(opt.days) || 7, min: Number(opt.min) || 3 });
  if (opt.json) return JSON.stringify(r, null, 1);
  if (!r.cards.length) return `No repeated jobs in the last ${r.days} days (3+ similar requests) and no repeated corrections.`;
  return r.cards.map((c) => `[${c.kind}] ${c.title} (${c.count || c.examples.length}×)\n  ${c.what}\n  when: ${c.when} · saves: ${c.saves}\n  e.g. ${c.examples[0]}`).join('\n\n');
}

module.exports = { suggest };
if (require.main === module) cli(run);
