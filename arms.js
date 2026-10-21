'use strict';
// ARMS (Apps, Routines, Memory, Skills) for Agentic OS. Loaded by server.js with install(ctx).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const jev = require('./scripts/jev');
const skillsScan = require('./scripts/skills-scan');
const recosScript = require('./scripts/suggest-routines');
const cacheReport = require('./scripts/cache-report');
const workspaceMap = require('./scripts/workspace-map');
const { choose: chooseModel } = require('./scripts/choose-model');
const routingReport = require('./scripts/routing-report');

const HOME = os.homedir();
const SKILLS_DIR = path.join(HOME, '.claude', 'skills');
const SETTINGS_JSON = path.join(HOME, '.claude', 'settings.json');
const MODELS = ['haiku', 'sonnet', 'opus'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const NOTHING = 'NOTHING TO FLAG';

function install(ctx) {
  const ROOT = ctx.ROOT;
  const DIR = path.join(ctx.DATA, 'arms');
  const RUNS = path.join(DIR, 'skill-runs');
  const TEACH = path.join(DIR, 'teach');
  const INBOX = path.join(ROOT, 'inbox');
  const ARTIFACTS = path.join(ROOT, 'artifacts');
  const REVIEWS = path.join(DIR, 'reviews');
  for (const d of [DIR, RUNS, TEACH, INBOX, ARTIFACTS, REVIEWS]) fs.mkdirSync(d, { recursive: true });
  const file = (n) => path.join(DIR, n);
  const load = (n, d) => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch { return d; } };
  const save = (n, v) => fs.writeFileSync(file(n), JSON.stringify(v, null, 1));
  const now = () => Date.now();
  const id = () => crypto.randomBytes(5).toString('hex');
  const changed = () => ctx.broadcast({ type: 'arms' });
  const settings = () => ({ jev: true, keepWarm: false, ...load('settings.json', {}) });
  const setSetting = (k, v) => { const s = load('settings.json', {}); s[k] = v; save('settings.json', s); changed(); };

  // ---------------------------------------------------------------- model routing (S2)
  function logPick(entry) {
    fs.appendFileSync(file('routing.jsonl'), JSON.stringify({ t: now(), ...entry }) + '\n');
  }
  function routingStats() {
    let lines = [];
    try { lines = fs.readFileSync(file('routing.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
    const since = now() - 30 * 86400000;
    const recent = lines.filter((l) => l.t >= since);
    const by = (k) => recent.reduce((m, l) => { m[l[k]] = (m[l[k]] || 0) + 1; return m; }, {});
    const jevCalls = recent.filter((l) => l.source === 'jev');
    return { calls: recent.length, bySource: by('source'), byModel: by('model'), jevCalls: jevCalls.length,
      jevAvgMs: jevCalls.length ? Math.round(jevCalls.reduce((s, l) => s + (l.ms || 0), 0) / jevCalls.length) : null,
      jevCostUsd: jevCalls.reduce((s, l) => s + (l.costUsd || 0), 0), errors: recent.filter((l) => l.error).length,
      last: lines.slice(-25).reverse(), on: settings().jev !== false, key: jev.keyStatus(),
      cacheHits: recent.filter((l) => l.source === 'jev-cache').length, overrides: recent.filter((l) => l.source === 'ev-override').length,
      outcomes: routingReport.report({ days: 30, dir: DIR, tickets: [...ctx.tickets.values()] }) };
  }
  const JEV_TIMEOUT_MS = 6000;
  const JEV_CACHE_DAYS = 7;
  const words = (t) => [...new Set(String(t || '').toLowerCase().replace(/[^a-z0-9а-я#_./-]+/g, ' ').split(' ').filter((w) => w.length > 2))];
  const jaccard = (a, b) => { const B = new Set(b); const inter = a.filter((w) => B.has(w)).length; return inter / (new Set([...a, ...b]).size || 1); };
  function cachedJev(role, task) {
    const list = load('jev-cache.json', []).filter((c) => now() - c.t < JEV_CACHE_DAYS * 86400000);
    const w = words(task);
    let best = null;
    for (const c of list) { if (c.role !== role) continue; const j = jaccard(w, c.words); if (j >= 0.8 && (!best || j > best.j)) best = { ...c, j }; }
    return best;
  }
  function rememberJev(role, task, r) {
    const list = load('jev-cache.json', []).filter((c) => now() - c.t < JEV_CACHE_DAYS * 86400000).slice(-400);
    list.push({ t: now(), role, words: words(task), model: r.model, effort: r.effort, why: r.why });
    save('jev-cache.json', list);
  }
  function evVeto(jevPick, ev) {
    const rows = ev.rows.filter((x) => x.model === jevPick.model);
    if (!rows.length) return null;
    const mine = rows.reduce((a, b) => (Math.abs(EFFORTS.indexOf(b.effort) - EFFORTS.indexOf(jevPick.effort)) < Math.abs(EFFORTS.indexOf(a.effort) - EFFORTS.indexOf(jevPick.effort)) ? b : a));
    const best = ev.rows[0];
    if (best.model === jevPick.model) return null;
    if (mine.n >= 4 && mine.p < 0.6 && best.p >= mine.p + 0.2) {
      return `this role succeeded only ${Math.round(mine.p * 100)}% on ${jevPick.model} (${mine.n} past tasks); ${best.model}/${best.effort} ${Math.round(best.p * 100)}%`;
    }
    const cheaper = MODELS.indexOf(best.model) < MODELS.indexOf(jevPick.model);
    if (cheaper && best.n >= 5 && best.p >= 0.9 && best.cost < mine.cost * 0.6) {
      return `${best.model}/${best.effort} already succeeds ${Math.round(best.p * 100)}% for this role (${best.n} past tasks) at ~$${best.cost.toFixed(2)} vs ~$${mine.cost.toFixed(2)}`;
    }
    return null;
  }
  async function decideModel({ roster, cap, role, roleDef, name, task, pin, kind, ticketId }) {
    const capModel = cap || 'opus';
    const capIdx = MODELS.indexOf(capModel);
    const short = String(task || '').replace(/\s+/g, ' ').slice(0, 120);
    const pickId = id();
    const base = { pickId, kind, role, task: short, ticketId: ticketId || null };
    if (pin && MODELS.includes(pin.model)) {
      const model = MODELS[Math.min(capIdx, MODELS.indexOf(pin.model))];
      const effort = EFFORTS.includes(pin.effort) ? pin.effort : 'medium';
      logPick({ ...base, source: 'pin', model, effort, why: pin.reason || '' });
      return { model, effort, pickId, source: 'pin', choice: `pinned: ${pin.reason || 'fixed model'}` };
    }
    const util = Math.max(0, ...Object.values((ctx.limits().windows) || {}).map((w) => (w.resetsAt > now() ? w.utilization : 0)));
    const ev = chooseModel({ role, roleDef, name, task, agents: [...ctx.agents.values()], tickets: [...ctx.tickets.values()], capModel, values: roster.defaults.taskValueUsd, utilization: util });
    const evPick = { model: ev.model, effort: ev.effort, p: Math.round(ev.rows[0].p * 100) / 100 };
    const jevKey = `${role === 'custom' ? 'custom:' + (name || '') : role}`;
    if (settings().jev !== false && jev.keyStatus().present) {
      let r = null, source = 'jev';
      const hit = cachedJev(jevKey, task);
      if (hit) { r = { model: MODELS[Math.min(capIdx, MODELS.indexOf(hit.model))], effort: hit.effort, why: hit.why, ms: 0, costUsd: 0 }; source = 'jev-cache'; }
      else {
        try {
          r = await jev.route({ task: `${role ? `(${role}${name ? ' — ' + name : ''}) ` : ''}${task}`, role, capModel, timeoutMs: JEV_TIMEOUT_MS });
          rememberJev(jevKey, task, r);
        } catch (e) { logPick({ ...base, source: 'jev', error: e.message }); }
      }
      if (r) {
        const veto = evVeto(r, ev);
        const jevInfo = { model: r.model, effort: r.effort, why: r.why };
        if (veto) {
          logPick({ ...base, source: 'ev-override', model: ev.model, effort: ev.effort, jev: jevInfo, ev: evPick, ms: r.ms, costUsd: r.costUsd, tokensIn: r.tokensIn, tokensOut: r.tokensOut, why: veto });
          return { model: ev.model, effort: ev.effort, pickId, source: 'ev-override', choice: `Jev picked ${r.model}/${r.effort}, overruled by your track record: ${veto}` };
        }
        logPick({ ...base, source, model: r.model, effort: r.effort, jev: jevInfo, ev: evPick, ms: r.ms, costUsd: r.costUsd, why: r.why, via: r.via, tokensIn: r.tokensIn, tokensOut: r.tokensOut });
        return { model: r.model, effort: r.effort, pickId, source, choice: `Jev${source === 'jev-cache' ? ' (reused for a near-identical task)' : ''}: ${r.why || 'picked'}${r.ms ? ` (${r.ms} ms, $${(r.costUsd || 0).toFixed(5)})` : ''}` };
      }
    }
    logPick({ ...base, source: 'ev', model: ev.model, effort: ev.effort, ev: evPick, why: ev.reason });
    return { model: ev.model, effort: ev.effort, pickId, source: 'ev', choice: `EV model${settings().jev !== false && !jev.keyStatus().present ? ' (Jev has no key yet)' : ''}: ${ev.reason}` };
  }
  function recordOutcome(a, t) {
    if (!a.pickId) return;
    fs.appendFileSync(file('outcomes.jsonl'), JSON.stringify({ t: now(), pickId: a.pickId, source: a.pickSource || null, agentId: a.id, homeId: a.homeId || null, role: a.role === 'custom' ? `custom:${a.name}` : a.role,
      ticketId: a.ticketId || null, model: a.model, effort: a.effort, outcome: a.lastOutcome, costUsd: Math.max(0, (a.costUsd || 0) - (a.taskCostStart || 0)), ms: a.endedAt && a.startedAt ? a.endedAt - a.startedAt : null }) + '\n');
    a.pickId = null;
  }


  // ---------------------------------------------------------------- skills (S1, S3)
  let skillCache = null;
  const skills = (fresh) => { if (fresh || !skillCache || now() - skillCache.at > 60000) skillCache = { at: now(), list: skillsScan.scan() }; return skillCache.list; };
  const findSkill = (name) => skills().find((s) => s.name === name);
  const runs = () => { try { return fs.readdirSync(RUNS).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(RUNS, f), 'utf8'))).sort((a, b) => b.startedAt - a.startedAt).slice(0, 60); } catch { return []; } };
  const READ_ONLY = ['Read', 'Glob', 'Grep', 'Bash(ls:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)', 'Bash(find:*)', 'Bash(grep:*)', 'Bash(du:*)', 'Bash(df:*)', 'Bash(ps:*)', 'Bash(git status:*)', 'Bash(git log:*)', 'Bash(git diff:*)'];
  const NEVER = ['Bash(git commit:*)', 'Bash(git push:*)', 'Bash(sudo:*)', 'Bash(apt upgrade:*)', 'Bash(apt-get upgrade:*)', 'Bash(rm -rf:*)'];

  function claude(args, opts) {
    return new Promise((resolve) => {
      const child = spawn(ctx.CLAUDE_BIN, args, { cwd: opts.cwd || HOME, env: ctx.childEnv({ id: opts.label || 'arms' }), stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { if (err.length < 4000) err += c; });
      const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs || 15 * 60000);
      child.on('close', (code) => {
        clearTimeout(timer);
        let j = null;
        try { j = JSON.parse(out); } catch {}
        resolve({ ok: code === 0 && j && !j.is_error, text: j ? j.result || '' : out.slice(-4000), costUsd: j ? j.total_cost_usd || 0 : 0, error: code === 0 ? null : (err || `exit ${code}`).slice(-1500) });
      });
    });
  }

  async function runSkill(name, b) {
    const s = findSkill(name);
    if (!s) return { error: `No skill ${name}` };
    const roster = ctx.readJson('roster.json');
    const btn = load('buttons.json', {})[name] || {};
    const pick = b.model ? { model: b.model, effort: b.effort || 'medium', choice: 'chosen next to the button' }
      : await decideModel({ roster, role: `skill:${name}`, task: `${s.description}\n${b.args || btn.args || ''}`, pin: s.model ? { model: s.model, effort: s.effort || 'low', reason: `model: ${s.model} in SKILL.md` } : null, kind: 'skill' });
    const text = fs.readFileSync(s.file, 'utf8');
    const cwd = /\/home\/default\/repo\/baseline|~\/repo\/baseline/.test(text) ? path.join(HOME, 'repo', 'baseline') : HOME;
    const edit = !!(b.edit ?? btn.edit);
    const r = { id: id(), skill: name, args: b.args || btn.args || '', model: pick.model, effort: pick.effort, choice: pick.choice, edit, cwd, startedAt: now(), status: 'running' };
    fs.writeFileSync(path.join(RUNS, `${r.id}.json`), JSON.stringify(r));
    changed();
    claude(['-p', `Use the /${name} skill.${r.args ? ` ${r.args}` : ''}\n\nWhen you finish, end with a short report: what you did and what you found.`,
      '--model', pick.model, '--effort', pick.effort, '--output-format', 'json', '--permission-mode', edit ? 'acceptEdits' : 'default',
      '--allowedTools', ...(edit ? [...READ_ONLY, 'Edit', 'Write', 'MultiEdit', 'Skill'] : [...READ_ONLY, 'Skill']), '--disallowedTools', ...NEVER], { cwd, label: `skill-${name}` }).then((o) => {
      Object.assign(r, { status: o.ok ? 'done' : 'failed', finishedAt: now(), costUsd: o.costUsd, output: o.text || o.error });
      fs.writeFileSync(path.join(RUNS, `${r.id}.json`), JSON.stringify(r));
      ctx.notify(o.ok ? 'answer' : 'warn', `/${name} ${o.ok ? 'finished' : 'failed'}`, String(r.output || '').slice(0, 200));
      changed();
    });
    return { id: r.id, model: pick.model, effort: pick.effort, choice: pick.choice };
  }

  function setFrontmatter(fileName, key, value) {
    const text = fs.readFileSync(fileName, 'utf8');
    const m = text.match(/^---\n([\s\S]*?)\n---/);
    let next;
    if (!m) next = value == null ? text : `---\n${key}: ${value}\n---\n\n${text}`;
    else {
      const lines = m[1].split('\n').filter((l) => !l.startsWith(`${key}:`));
      if (value != null) lines.push(`${key}: ${value}`);
      next = `---\n${lines.join('\n')}\n---` + text.slice(m[0].length);
    }
    fs.writeFileSync(fileName, next);
  }
  const changelog = (dir, line) => fs.appendFileSync(path.join(dir, 'CHANGELOG.md'), `${fs.existsSync(path.join(dir, 'CHANGELOG.md')) ? '' : '# Changelog\n\n'}- ${new Date().toISOString().slice(0, 10)}: ${line}\n`);

  async function teach(name, feedback) {
    const s = findSkill(name);
    if (!s) return { error: `No skill ${name}` };
    const before = fs.readFileSync(s.file, 'utf8');
    const roster = ctx.readJson('roster.json');
    const pick = await decideModel({ roster, role: 'skill-teacher', task: 'Rewrite a short instruction file to fold in one principle from user feedback; judgement needed, moderate difficulty.', kind: 'teach' });
    const prompt = `You improve a Claude Code skill from the user's feedback, like reinforcement learning: find the principle behind the feedback and fold it into the skill so it gets sharper, not longer. Prefer replacing or merging a rule to adding one; a good update often makes the skill shorter. Keep the frontmatter.\n\nFeedback on the skill's output:\n${feedback}\n\nCurrent SKILL.md:\n<<<SKILL\n${before}\nSKILL>>>\n\nReply in exactly this form:\nPRINCIPLE: <one line>\n<<<SKILL\n<the complete new SKILL.md>\nSKILL>>>`;
    const o = await claude(['-p', prompt, '--model', pick.model, '--effort', pick.effort, '--output-format', 'json', '--tools', ''], { label: 'teach' });
    const m = (o.text || '').match(/<<<SKILL\n([\s\S]*?)\nSKILL>>>/);
    if (!o.ok || !m) return { error: `The model did not return a new skill: ${(o.error || o.text || '').slice(0, 300)}` };
    const p = { id: id(), skill: name, file: s.file, dir: s.dir, feedback, before, after: m[1].trimEnd() + '\n', principle: ((o.text.match(/PRINCIPLE:\s*(.+)/) || [])[1] || '').trim(), costUsd: o.costUsd, model: `${pick.model}/${pick.effort}`, at: now() };
    fs.writeFileSync(path.join(TEACH, `${p.id}.after`), p.after);
    p.diff = spawnSync('diff', ['-u', '--label', 'now', '--label', 'proposed', s.file, path.join(TEACH, `${p.id}.after`)], { encoding: 'utf8' }).stdout;
    fs.writeFileSync(path.join(TEACH, `${p.id}.json`), JSON.stringify(p));
    return p;
  }
  function applyTeach(pid) {
    let p;
    try { p = JSON.parse(fs.readFileSync(path.join(TEACH, `${pid}.json`), 'utf8')); } catch { return { error: 'No such proposal.' }; }
    if (fs.readFileSync(p.file, 'utf8') !== p.before) return { error: 'The skill changed since this proposal was made; teach it again.' };
    fs.copyFileSync(p.file, `${p.file}.bak`);
    fs.writeFileSync(p.file, p.after);
    changelog(p.dir, `${p.principle || 'folded in feedback'} (from: “${p.feedback.slice(0, 160)}”)`);
    p.applied = now();
    fs.writeFileSync(path.join(TEACH, `${pid}.json`), JSON.stringify(p));
    skills(true);
    changed();
    return { ok: true };
  }

  const slug = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  function newDatabaseSkill(b) {
    const name = slug(b.name);
    if (!name) return { error: 'Give the skill a name.' };
    const dir = path.join(SKILLS_DIR, name);
    if (fs.existsSync(dir)) return { error: `A skill called ${name} already exists.` };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Reference for ${b.holds || name}. Use whenever drafting, pitching or checking ${b.holds || name}.\narms-type: database\n---\n\nThe examples and principles live in \`references.md\` next to this file. Read it before producing anything in this area.\n\n- Follow the principles; use the examples to calibrate tone, length and quality.\n- **Wildcards:** when pitching ideas, 8 of 10 follow the references and 2 are wildcards that deliberately break a pattern. Mark them WILDCARD.\n- When the user likes a wildcard, offer to add it to \`references.md\`.\n- Keep this file short; knowledge belongs in \`references.md\`.\n`);
    fs.writeFileSync(path.join(dir, 'references.md'), `# ${b.holds || name}: references\n\n## Principles\n\n${(b.principles || '- (add the principles here)').trim()}\n\n## Examples\n\n${(b.examples || '- (paste examples here)').trim()}\n\n## Wildcards that worked\n\n`);
    changelog(dir, 'created as a database skill with wildcards');
    skills(true);
    changed();
    return { ok: true, dir };
  }
  function newArtifactSkill(b) {
    const dir = path.join(SKILLS_DIR, 'artifacts');
    if (fs.existsSync(dir) && !b.overwrite) return { error: 'An artifacts skill already exists.' };
    fs.mkdirSync(dir, { recursive: true });
    const colors = String(b.colors || '#141a22, #e8a33d, #f5f1e8').split(/[\s,]+/).filter((c) => /^#[0-9a-f]{3,8}$/i.test(c));
    const font = b.font || 'Inter, system-ui, sans-serif';
    fs.writeFileSync(path.join(dir, 'brand-book.html'), `<!doctype html><html><head><meta charset="utf-8"><title>${b.brand || 'Brand'} — brand book</title><style>
:root{${colors.map((c, i) => `--c${i + 1}:${c};`).join('')}--font:${font};}
body{font-family:var(--font);margin:40px;color:var(--c1);background:${colors[2] || '#fff'}}h1{font-size:40px;margin:0 0 8px}h2{margin-top:32px}
.sw{display:inline-block;width:120px;height:80px;border-radius:12px;margin:8px;vertical-align:top;color:#fff;padding:8px;font:12px monospace}
.card{border-radius:14px;padding:20px;background:#fff;box-shadow:0 4px 18px rgba(0,0,0,.08);max-width:520px}</style></head><body>
<h1>${b.brand || 'Brand'}</h1><p>Colours, type, spacing and logo rules for every artifact.</p>
<h2>Colours</h2>${colors.map((c, i) => `<span class="sw" style="background:${c}">--c${i + 1}<br>${c}</span>`).join('')}
<h2>Type</h2><p style="font-size:32px;font-weight:700">Headline 32 bold</p><p style="font-size:16px">Body 16 regular, line height 1.5.</p>
<h2>Spacing</h2><p>Base unit 8px; sections 32px apart; cards 20px padding, 14px radius.</p>
<h2>Logo</h2><p>${b.logo || 'Clear space of one logo height on all sides. Never stretch or recolour.'}</p>
<h2>Component</h2><div class="card"><b>Card</b><p>Use for stats and callouts.</p></div></body></html>`);
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: artifacts\ndescription: Build decks, infographics, one-pagers and PDFs in the user's brand. Use for any visual artifact.\narms-type: artifact\n---\n\n1. Read \`brand-book.html\` next to this file and use only its colours, fonts, spacing and logo rules (CSS variables --c1…).\n2. Build the artifact as HTML first, in \`~/agent-workplace/artifacts/<YYYY-MM-DD>-<slug>/index.html\`, with a one-line \`<meta name="description">\`.\n3. Export to PDF or images only at the end, if asked: \`google-chrome --headless=new --print-to-pdf=out.pdf index.html\`.\n4. Refresh the artifacts inbox: \`node ~/agent-workplace/scripts/artifacts-index.js\` (newest first, searchable). Never look for old artifacts by asking; read the index.\n`);
    changelog(dir, 'created as an artifact skill with a brand book');
    skills(true);
    changed();
    return { ok: true, dir };
  }

  // ---------------------------------------------------------------- routines (R1-R3)
  const BUILTIN = [
    { id: 'b-weekly-review', name: 'Weekly review per team', mode: 'active', builtin: 'script', schedule: { type: 'weekly', day: 1, at: '09:00' }, does: 'weekly-report script; a lead looks only when something went wrong' },
    { id: 'b-library-check', name: 'Library check', mode: 'passive', builtin: 'script', schedule: { type: 'event', on: 'after 6 new notes' }, does: 'library-check script; a lead tidies only when it finds problems' },
    { id: 'b-recos', name: 'Suggest routines (Recos)', mode: 'passive', builtin: 'script', schedule: { type: 'weekly', day: 5, at: '09:00' }, does: 'finds jobs you did by hand 3+ times this week and repeated corrections; pings only when there are new cards' },
    { id: 'b-cache', name: 'Cache report', mode: 'passive', builtin: 'script', schedule: { type: 'weekly', day: 1, at: '08:00' }, does: 'checks cold-cache reloads; pings only if keep-warm would pay and is off' },
    { id: 'b-keepwarm', name: 'Keep idle chats warm', mode: 'passive', builtin: 'script', schedule: { type: 'every', minutes: 10 }, does: 'pings Claude Code chats idle 50+ min (up to 4 h) so their prompt cache stays warm; only when enabled' },
  ];
  const userRoutines = () => load('routines.json', []);
  function nextRun(r, from) {
    const s = r.schedule || {};
    const d = new Date(from);
    if (s.type === 'every') return from + (s.minutes || 60) * 60000;
    if (s.type === 'hourly') return from + (s.every || 1) * 3600000;
    const [h, m] = String(s.at || '09:00').split(':').map(Number);
    const c = new Date(d); c.setHours(h, m || 0, 0, 0);
    if (s.type === 'daily') { if (c.getTime() <= from) c.setDate(c.getDate() + 1); return c.getTime(); }
    if (s.type === 'weekly') { let add = ((s.day ?? 1) - c.getDay() + 7) % 7; if (add === 0 && c.getTime() <= from) add = 7; c.setDate(c.getDate() + add); return c.getTime(); }
    return null;
  }
  const scheduleText = (s) => (!s ? '' : s.type === 'daily' ? `daily at ${s.at}` : s.type === 'weekly' ? `${DAYS[s.day ?? 1]}s at ${s.at}` : s.type === 'every' ? `every ${s.minutes} min` : s.type === 'hourly' ? `every ${s.every || 1} h` : s.on || '');
  function weekCost(rid) {
    const since = now() - 7 * 86400000;
    const list = [...ctx.tickets.values()].filter((t) => t.routine === rid && t.createdAt >= since);
    return { usd: list.reduce((s, t) => s + (t.costUsd || 0), 0), runs: list.length };
  }
  function routinesView() {
    const st = load('routine-state.json', {});
    const kw = load('keepwarm.json', { pings: 0, costUsd: 0, sessions: {} });
    const builtin = BUILTIN.map((b) => ({ ...b, enabled: b.id === 'b-keepwarm' ? settings().keepWarm : true, scheduleText: scheduleText(b.schedule),
      week: b.id === 'b-keepwarm' ? { usd: kw.weekUsd || 0, runs: kw.weekPings || 0 } : b.id === 'b-weekly-review' ? (() => { const l = [...ctx.tickets.values()].filter((t) => t.review && t.createdAt >= now() - 7 * 86400000); return { usd: l.reduce((s, t) => s + (t.costUsd || 0), 0), runs: l.length }; })() : { usd: 0, runs: (st[b.id] || {}).weekRuns || 0 },
      lastRunAt: (st[b.id] || {}).lastRunAt || null, nextRunAt: nextRun(b, now()) }));
    const mine = userRoutines().map((r) => ({ ...r, scheduleText: scheduleText(r.schedule), week: weekCost(r.id), nextRunAt: r.enabled ? r.nextRunAt || nextRun(r, now()) : null }));
    return { routines: [...mine, ...builtin].sort((a, b) => b.week.usd - a.week.usd || (a.builtin ? 1 : 0) - (b.builtin ? 1 : 0)), keepWarm: kw };
  }
  function saveRoutine(b) {
    const list = userRoutines();
    let r = list.find((x) => x.id === b.id);
    if (!r) { r = { id: 'r' + id(), createdAt: now(), enabled: true }; list.push(r); }
    for (const k of ['name', 'prompt', 'mode', 'project', 'capUsdWeek', 'enabled', 'effort']) if (b[k] !== undefined) r[k] = b[k];
    if (b.schedule) r.schedule = b.schedule;
    if (!r.name || !r.prompt) return { error: 'A routine needs a name and what to do.' };
    r.mode = r.mode === 'passive' ? 'passive' : 'active';
    r.capUsdWeek = r.capUsdWeek ? Number(r.capUsdWeek) : null;
    r.nextRunAt = nextRun(r, now());
    save('routines.json', list);
    changed();
    return { ok: true, id: r.id };
  }
  function deleteRoutine(rid) { save('routines.json', userRoutines().filter((x) => x.id !== rid)); changed(); return { ok: true }; }
  function runRoutine(rid, manual) {
    const list = userRoutines();
    const r = list.find((x) => x.id === rid);
    if (!r) return { error: 'No such routine.' };
    const w = weekCost(r.id);
    if (r.capUsdWeek && w.usd >= r.capUsdWeek && !manual) {
      if (!r.cappedAt || now() - r.cappedAt > 6 * 86400000) { r.cappedAt = now(); ctx.notify('warn', `Routine “${r.name}” hit its cap`, `$${w.usd.toFixed(2)} of $${r.capUsdWeek} this week; it skips runs until next week.`); }
      r.nextRunAt = nextRun(r, now()); save('routines.json', list); changed();
      return { skipped: true };
    }
    const text = r.prompt + (r.mode === 'passive' ? `\n\n(This is a passive routine. If nothing is worth flagging, reply with exactly "${NOTHING}" and nothing else. Otherwise report only what is worth the user's attention.)` : '')
      + (r.capUsdWeek ? `\n(Budget: this routine is capped at $${r.capUsdWeek} a week; keep the run lean.)` : '');
    const t = ctx.createTicket({ text, project: r.project || undefined, effort: r.effort || undefined, routineId: r.id });
    t.routine = r.id;
    t.title = `↻ ${r.name}`;
    ctx.touchTicket(t);
    r.lastRunAt = now();
    r.nextRunAt = nextRun(r, now());
    save('routines.json', list);
    changed();
    return { id: t.id };
  }
  function optimiseRoutine(rid) {
    const r = userRoutines().find((x) => x.id === rid);
    if (!r) return { error: 'No such routine.' };
    const w = weekCost(r.id);
    const t = ctx.createTicket({ text: `Optimise the routine “${r.name}” so it costs less without losing what it is for.\n\nIt runs ${scheduleText(r.schedule)} as a ${r.mode} routine and cost $${w.usd.toFixed(2)} in ${w.runs} run(s) this week${r.capUsdWeek ? `; the cap is $${r.capUsdWeek} a week` : ''}.\n\nCurrent prompt:\n\`\`\`\n${r.prompt}\n\`\`\`\n\nCut the fat: narrower scope, cheaper steps (office scripts instead of reading), fewer sources, shorter output. Do not drop anything the user relies on without saying so. Answer with what changes and why, the expected cost before and after, and the new prompt in a block that starts with \`\`\`prompt.`, project: r.project || undefined });
    t.title = `Optimise routine: ${r.name}`;
    ctx.touchTicket(t);
    return { id: t.id };
  }
  function onAnswer(t, text) {
    if (!t.routine) return false;
    const r = userRoutines().find((x) => x.id === t.routine);
    if (r && r.mode === 'passive' && new RegExp(`^\\W*${NOTHING}\\W*$`, 'i').test(String(text).trim())) { t.archived = true; t.silent = true; return true; }
    return false;
  }

  // ---------------------------------------------------------------- recos (R3, M3)
  function refreshRecos(notifyNew) {
    const prev = load('recos.json', { cards: [] });
    const r = recosScript.suggest({ days: 7 });
    const handled = new Set(load('recos-handled.json', []));
    r.cards = r.cards.filter((c) => !handled.has(c.id));
    save('recos.json', r);
    const fresh = r.cards.filter((c) => !prev.cards.some((p) => p.id === c.id));
    if (notifyNew && fresh.length) ctx.notify('answer', `${fresh.length} new suggestion${fresh.length === 1 ? '' : 's'} in Recos`, fresh.map((c) => c.title).join(' · '));
    changed();
    return r;
  }
  function setupRecos(ids) {
    const r = load('recos.json', { cards: [] });
    const handled = new Set(load('recos-handled.json', []));
    const done = [];
    for (const c of r.cards.filter((x) => ids.includes(x.id))) {
      if (c.kind === 'routine') { const res = saveRoutine({ ...c.routine, capUsdWeek: 2 }); if (!res.error) done.push(`routine “${c.routine.name}”`); }
      else if (c.kind === 'memory') { ctx.giveFeedback('user', c.agentId, c.fix); done.push(`calibration for ${(ctx.agents.get(c.agentId) || {}).persona || c.agentId}`); }
      handled.add(c.id);
    }
    save('recos-handled.json', [...handled]);
    r.cards = r.cards.filter((x) => !handled.has(x.id));
    save('recos.json', r);
    changed();
    return { done };
  }

  // ---------------------------------------------------------------- cache warmth (M2)
  let cacheCache = load('cache-report.json', null);
  async function refreshCache() {
    const office = [...ctx.agents.values()].filter((a) => a.resident && a.sessionId).map((a) => a.sessionId);
    cacheCache = { at: now(), ...(await cacheReport.report({ days: 30, officeSessions: office })) };
    save('cache-report.json', cacheCache);
    changed();
    return cacheCache;
  }
  function leadsCache() {
    return [...ctx.agents.values()].filter((a) => a.resident).map((a) => {
      const last = (ctx.eventsOf(a).filter((e) => e.kind === 'result').pop() || {}).t || null;
      const idle = last ? now() - last : null;
      return { id: a.id, persona: a.persona, lastTurn: last, state: idle == null ? 'none' : idle < 55 * 60000 ? 'warm' : idle < 60 * 60000 ? 'cooling' : 'cold', contextTokens: a.contextTokens || 0 };
    });
  }
  async function keepWarmTick() {
    if (!settings().keepWarm) return;
    const kw = load('keepwarm.json', { pings: 0, costUsd: 0, sessions: {} });
    const office = new Set([...ctx.agents.values()].filter((a) => a.sessionId).map((a) => a.sessionId));
    const dir = path.join(HOME, '.claude', 'projects');
    let files = [];
    for (const d of fs.readdirSync(dir)) {
      if (d.includes('agent-workplace')) continue;
      try { for (const f of fs.readdirSync(path.join(dir, d))) if (f.endsWith('.jsonl')) files.push(path.join(dir, d, f)); } catch {}
    }
    const t = now();
    for (const f of files) {
      let st; try { st = fs.statSync(f); } catch { continue; }
      const idle = t - st.mtimeMs;
      if (idle < 50 * 60000 || idle > 58 * 60000) continue;
      const sid = path.basename(f, '.jsonl');
      if (office.has(sid)) continue;
      const rec = kw.sessions[sid] || { pings: 0, userAt: st.mtimeMs, lastPingMtime: 0 };
      if (Math.abs(st.mtimeMs - rec.lastPingMtime) > 2000) { rec.userAt = st.mtimeMs; rec.pings = 0; }
      if (t - rec.userAt > 4 * 3600000 || rec.pings >= 5) continue;
      const tail = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('"usage"') && l.includes('"assistant"')).pop();
      let e; try { e = JSON.parse(tail); } catch { continue; }
      const u = e.message.usage || {};
      const ctxTok = (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.input_tokens || 0);
      if (ctxTok < 30000) continue;
      const o = await claude(['-p', '(keep-warm ping from Agentic OS; reply with just: ok)', '--resume', sid, '--model', e.message.model, '--output-format', 'json', '--max-turns', '1', '--tools', ''], { cwd: e.cwd || HOME, label: 'keepwarm', timeoutMs: 120000 });
      try { rec.lastPingMtime = fs.statSync(f).mtimeMs; } catch {}
      rec.pings++;
      kw.sessions[sid] = rec;
      kw.pings++; kw.costUsd += o.costUsd || 0;
      kw.week = (kw.week || []).filter((x) => x.t > t - 7 * 86400000).concat([{ t, usd: o.costUsd || 0 }]);
      kw.weekPings = kw.week.length; kw.weekUsd = kw.week.reduce((s, x) => s + x.usd, 0);
    }
    save('keepwarm.json', kw);
  }

  // ---------------------------------------------------------------- approvals (anything that changes ~/.claude)
  const SKILL_PROPOSALS = ['note', 'calibrate', 'search-connectors'];
  const readSettings = () => { try { return JSON.parse(fs.readFileSync(SETTINGS_JSON, 'utf8')); } catch { return {}; } };
  function approvals() {
    const s = readSettings();
    const status = (cond) => (cond ? 'applied' : 'pending');
    const cr = cacheCache;
    const list = [
      { id: 'openrouter-key', level: 'S2', title: 'OpenRouter key for Jev', status: jev.keyStatus().present ? 'applied' : 'pending', manual: true,
        what: jev.keyStatus().present ? `Found (${jev.keyStatus().where}). Jev picks models; the EV script is the fallback.` : `Create an OpenRouter account, then put the API key alone in ${jev.keyStatus().where} (mkdir -p ~/.config/agentos; chmod 600 the file). Never paste it in chat. Until then the EV script decides.` },
      { id: 'memory-map', level: 'M1', title: 'Turn CLAUDE.md into a map', status: status(fs.existsSync(path.join(HOME, '.claude', 'departments', 'work.md'))),
        what: 'Keep the global rules, move the WORK notes word for word into ~/.claude/departments/work.md, add routers for personal projects and Agentic OS, and add what to keep when a chat compacts. The old file is backed up first. Loaded at every chat start: 9 KB → 2 KB.', diff: true },
      ...SKILL_PROPOSALS.map((n) => ({ id: `skill-${n}`, level: n === 'search-connectors' ? 'A1' : 'M3', title: `Install the /${n} skill`, status: status(fs.existsSync(path.join(SKILLS_DIR, n, 'SKILL.md'))),
        what: fs.readFileSync(path.join(ROOT, 'arms', 'skills', n, 'SKILL.md'), 'utf8').split('\n').find((l) => l.startsWith('description:')).slice(13) })),
      { id: 'statusline', level: 'A2', title: 'Usage mod for Claude Code (status line)', status: status(s.statusLine && String(s.statusLine.command || '').includes('agentos-statusline')),
        what: 'Shows your 5-hour and weekly limits and whether this chat\'s prompt cache is warm or cold, under every Claude Code prompt. Runs as plain code, costs no tokens. Sets statusLine in ~/.claude/settings.json (backed up first).' },
      { id: 'keepwarm', level: 'M2', title: 'Keep idle chats warm', status: settings().keepWarm ? 'applied' : 'pending',
        what: cr ? `Last ${cr.days} days: ${cr.cold} cold reloads cost about $${cr.coldUsd.toFixed(2)}; ${cr.savable} came within 4 h of the last message. Pinging those chats every 50 min would have saved $${cr.savableUsd.toFixed(2)} for $${cr.pingUsd.toFixed(2)} of pings (net $${cr.netUsd.toFixed(2)}). The ping adds a one-line "ok" exchange to the chat.` : 'Run the cache report first.' },
    ];
    return list;
  }
  function approve(aid, b) {
    if (aid === 'memory-map') { const r = workspaceMap.apply(); changed(); return { ok: true, message: `Applied. Backup: ${r.backup}` }; }
    if (aid.startsWith('skill-')) {
      const n = aid.slice(6);
      if (!SKILL_PROPOSALS.includes(n)) return { error: 'unknown skill' };
      const dest = path.join(SKILLS_DIR, n);
      if (fs.existsSync(path.join(dest, 'SKILL.md'))) return { error: `~/.claude/skills/${n} already exists; not overwriting it.` };
      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(path.join(ROOT, 'arms', 'skills', n, 'SKILL.md'), path.join(dest, 'SKILL.md'));
      skills(true); changed();
      return { ok: true, message: `Installed /${n} in ~/.claude/skills/${n}.` };
    }
    if (aid === 'statusline') {
      const s = readSettings();
      const backup = `${SETTINGS_JSON}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      if (fs.existsSync(SETTINGS_JSON)) fs.copyFileSync(SETTINGS_JSON, backup);
      s.statusLine = { type: 'command', command: path.join(ROOT, 'arms', 'statusline', 'agentos-statusline.sh') };
      fs.writeFileSync(SETTINGS_JSON, JSON.stringify(s, null, 2) + '\n');
      changed();
      return { ok: true, message: `Status line set (backup: ${backup}). It shows in new Claude Code prompts.` };
    }
    if (aid === 'keepwarm') { setSetting('keepWarm', b.off ? false : true); return { ok: true, message: b.off ? 'Keep-warm off.' : 'Keep-warm on: idle chats get a tiny ping every 50 min for up to 4 h.' }; }
    return { error: 'This one needs you to do it by hand; follow the steps shown.' };
  }

  // ---------------------------------------------------------------- the ARMS checklist
  function checklist() {
    const sk = skills();
    const btns = load('buttons.json', {});
    const ap = Object.fromEntries(approvals().map((a) => [a.id, a.status === 'applied']));
    const rs = routinesView().routines;
    const mine = rs.filter((r) => !r.builtin);
    const rstats = routingStats();
    const ticks = load('state.json', {}).ticks || {};
    const lvl = (id, title, test, auto, detail, app) => ({ id, title, test, auto, done: ticks[id] ?? auto === 'done', detail, app });
    const db = sk.filter((s) => s.type === 'database' && s.wildcards);
    const taught = sk.filter((s) => s.changelog);
    return [
      { part: 'S', name: 'Skills', levels: [
        lvl('S1', 'Know your skill types', 'What you reference every week lives in a database skill, with wildcards on.', db.length && Object.keys(btns).length ? 'done' : 'partial', `${sk.length} skills: ${['database', 'artifact', 'procedure'].map((t) => `${sk.filter((s) => s.type === t).length} ${t}`).join(', ')}; ${db.length} database skill(s) with wildcards; ${Object.keys(btns).length} run button(s).`, 'skills'),
        lvl('S2', 'Model routing', 'Fixed-step skills run on the smallest model that does the job.', sk.some((s) => s.model) && rstats.key.present ? 'done' : 'partial', `${sk.filter((s) => s.model).length} pinned skill(s); router: ${rstats.key.present ? 'Jev' : 'EV script (Jev needs a key)'}; ${rstats.calls} picks in 30 days.`, 'skills'),
        lvl('S3', 'Self-improving skills', 'Your most-used skill gets better from your feedback.', taught.length ? 'done' : 'partial', taught.length ? `${taught.length} skill(s) improved from feedback.` : 'Teach is ready: give feedback on a skill in the Skills app.', 'skills'),
      ] },
      { part: 'R', name: 'Routines', levels: [
        lvl('R1', 'Active vs passive', 'Most of your routines only ping you when something is worth flagging.', rs.filter((r) => r.mode === 'passive').length > rs.filter((r) => r.mode === 'active').length ? 'done' : 'partial', `${rs.filter((r) => r.mode === 'passive').length} passive, ${rs.filter((r) => r.mode === 'active').length} active.`, 'routines'),
        lvl('R2', 'Capped routines', 'You know what each routine costs, and the priciest one has a cap.', !mine.length || mine.slice().sort((a, b) => b.week.usd - a.week.usd)[0].capUsdWeek ? 'done' : 'partial', mine.length ? `${mine.filter((r) => r.capUsdWeek).length} of ${mine.length} of your routines capped.` : 'Costs are tracked per routine; no paid routines yet.', 'routines'),
        lvl('R3', 'Routines that suggest routines', 'A weekly routine suggests new routines for you to pick.', 'done', 'Every Friday at 09:00 the Recos script looks for jobs you did by hand 3+ times.', 'recos'),
      ] },
      { part: 'M', name: 'Memory', levels: [
        lvl('M1', 'Long-term memory', 'Claude finds anything through plain-text maps, with no vector database.', ap['memory-map'] ? 'done' : 'partial', ap['memory-map'] ? 'CLAUDE.md is a map with department routers.' : 'Map proposal ready for your approval.', 'arms'),
        lvl('M2', 'Short-term memory', 'Your chats compact with a purpose, and you know when your cache is cold.', ap['memory-map'] && ap.statusline ? 'done' : 'partial', `${ap['memory-map'] ? 'Compaction rules in CLAUDE.md. ' : ''}${ap.statusline ? 'Cache state in the status line. ' : ''}${cacheCache ? `Cache report: keep-warm would net $${cacheCache.netUsd.toFixed(2)}/month.` : ''}`, 'arms'),
        lvl('M3', 'Self-evolving memory', 'You never correct Claude on the same thing twice.', ap['skill-note'] && ap['skill-calibrate'] ? 'done' : 'partial', `${ap['skill-note'] ? '/note' : '/note pending'}, ${ap['skill-calibrate'] ? '/calibrate' : '/calibrate pending'}; repeated corrections show up in Recos.`, 'arms'),
      ] },
      { part: 'A', name: 'Apps', levels: [
        lvl('A1', 'Connect anything', 'Every app you use has a way in, lightest first.', ap['skill-search-connectors'] ? 'done' : 'partial', ap['skill-search-connectors'] ? '/search-connectors installed.' : '/search-connectors pending your approval.', 'arms'),
        lvl('A2', 'Mods', 'One mod saves you clicks every day.', ap.statusline ? 'done' : 'partial', ap.statusline ? 'Usage mod on.' : 'Usage mod pending your approval.', 'arms'),
        lvl('A3', 'A micro app for every big job', 'One weekly job lives in its own micro app.', 'done', 'Review: approve agents\' answers and diffs with comments, built on a shared UI parts library.', 'review'),
      ] },
    ];
  }
  function tick(lid, done) { const st = load('state.json', {}); st.ticks = st.ticks || {}; if (done === null) delete st.ticks[lid]; else st.ticks[lid] = !!done; save('state.json', st); changed(); return { ok: true }; }

  // ---------------------------------------------------------------- inbox, artifacts
  function inboxList() {
    const read = (dir, kind) => { try { return fs.readdirSync(dir).filter((f) => !f.startsWith('.') && f !== 'index.html').map((f) => { const p = path.join(dir, f); const s = fs.statSync(p); return { name: f, kind, mtime: s.mtimeMs, dir: s.isDirectory() }; }); } catch { return []; } };
    return [...read(INBOX, 'inbox'), ...read(ARTIFACTS, 'artifact')].sort((a, b) => b.mtime - a.mtime);
  }
  function saveToInbox(b) {
    const name = `${new Date().toISOString().slice(0, 10)}-${slug(b.title || b.url || 'note') || 'note'}.md`;
    fs.writeFileSync(path.join(INBOX, name), `# ${b.title || 'Saved page'}\n\n${b.url ? `Source: ${b.url}\n\n` : ''}${b.text ? `${String(b.text).slice(0, 200000)}\n` : ''}`);
    changed();
    return { ok: true, name };
  }

  // ---------------------------------------------------------------- schedule
  let busy = false;
  async function schedule() {
    if (busy) return;
    busy = true;
    try {
      const list = userRoutines();
      for (const r of list) if (r.enabled && r.nextRunAt && r.nextRunAt <= now()) runRoutine(r.id, false);
      const st = load('routine-state.json', {});
      const due = (bid) => { const b = BUILTIN.find((x) => x.id === bid); const last = (st[bid] || {}).lastRunAt || 0; return nextRun(b, last || now() - 8 * 86400000) <= now(); };
      if (due('b-recos')) { refreshRecos(true); st['b-recos'] = { lastRunAt: now(), weekRuns: 1 }; save('routine-state.json', st); }
      if (due('b-cache')) {
        const r = await refreshCache();
        st['b-cache'] = { lastRunAt: now(), weekRuns: 1 }; save('routine-state.json', st);
        if (r.pays && !settings().keepWarm) ctx.notify('answer', 'Keep-warm would pay', `It would have saved a net $${r.netUsd.toFixed(2)} in the last ${r.days} days. Turn it on in ARMS → Approvals.`);
      }
      await keepWarmTick();
    } catch (e) { console.error('arms schedule:', e.message); }
    busy = false;
  }
  if (!cacheCache) refreshCache().catch(() => {});
  if (!fs.existsSync(file('recos.json'))) try { refreshRecos(false); } catch {}

  // ---------------------------------------------------------------- HTTP
  async function route(req, res, url, p, body, json) {
    const m = (re) => p.match(re);
    let x;
    if (!p.startsWith('/api/arms')) return false;
    if (req.method === 'POST' && p === '/api/arms/selftest') { json(res, 200, { text: require('./scripts/arms-selftest').run() }); return true; }
    if (req.method === 'GET' && p === '/api/arms') { json(res, 200, { checklist: checklist(), approvals: approvals(), routing: routingStats(), settings: settings(), cache: cacheCache, leadsCache: leadsCache() }); return true; }
    if (req.method === 'POST' && p === '/api/arms/tick') { const b = await body(req); json(res, 200, tick(b.id, b.done)); return true; }
    if (req.method === 'POST' && p === '/api/arms/settings') { const b = await body(req); for (const k of ['jev']) if (k in b) setSetting(k, !!b[k]); json(res, 200, settings()); return true; }
    if (req.method === 'GET' && p === '/api/arms/proposal/memory-map') { json(res, 200, workspaceMap.writeProposal()); return true; }
    if (req.method === 'GET' && p === '/api/arms/images') { json(res, 200, workspaceMap.imagesWithoutCaptions(path.join(HOME, 'Personal', 'Projects'))); return true; }
    if (req.method === 'POST' && p === '/api/arms/captions') {
      const b = await body(req);
      const dir = path.resolve(String(b.dir || ''));
      if (!dir.startsWith(path.join(HOME, 'Personal', 'Projects') + path.sep)) { json(res, 400, { error: 'Pick a folder under ~/Personal/Projects.' }); return true; }
      const t = ctx.createTicket({ project: 'Personal projects', text: `Give the images in ${dir} a text description so they can be found by search.\n- Delegate the captioning to one teammate on the cheapest model that can describe images (haiku, effort low), in batches.\n- Write ${path.join(dir, 'CAPTIONS.md')}: one line per image, "<file name> — <what it shows, 10-20 words>".\n- Skip images already listed there. Do not move or change any image.` });
      json(res, 200, { id: t.id }); return true;
    }
    if (req.method === 'POST' && (x = m(/^\/api\/arms\/approve\/([\w-]+)$/))) { const b = await body(req); const r = approve(x[1], b); json(res, r.error ? 400 : 200, r); return true; }
    if (req.method === 'GET' && p === '/api/arms/skills') { json(res, 200, { skills: skills(url.searchParams.get('fresh') === '1'), runs: runs(), buttons: load('buttons.json', {}), teach: (() => { try { return fs.readdirSync(TEACH).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(TEACH, f), 'utf8'))).sort((a, b) => b.at - a.at).slice(0, 20); } catch { return []; } })() }); return true; }
    if (req.method === 'POST' && (x = m(/^\/api\/arms\/skills\/([\w:-]+)\/run$/))) { const r = await runSkill(x[1], await body(req)); json(res, r.error ? 400 : 200, r); return true; }
    if (req.method === 'POST' && (x = m(/^\/api\/arms\/skills\/([\w:-]+)\/button$/))) {
      const b = await body(req); const all = load('buttons.json', {});
      if (b.remove) delete all[x[1]]; else all[x[1]] = { model: MODELS.includes(b.model) ? b.model : null, effort: EFFORTS.includes(b.effort) ? b.effort : null, args: b.args || '', edit: !!b.edit };
      save('buttons.json', all); skills(true); changed(); json(res, 200, { ok: true }); return true;
    }
    if (req.method === 'POST' && (x = m(/^\/api\/arms\/skills\/([\w:-]+)\/pin$/))) {
      const s = findSkill(x[1]); const b = await body(req);
      if (!s) { json(res, 404, { error: 'no such skill' }); return true; }
      setFrontmatter(s.file, 'model', MODELS.includes(b.model) ? b.model : null);
      changelog(s.dir, b.model ? `pinned to ${b.model}` : 'unpinned (router decides)');
      skills(true); changed(); json(res, 200, { ok: true }); return true;
    }
    if (req.method === 'POST' && (x = m(/^\/api\/arms\/skills\/([\w:-]+)\/teach$/))) { const b = await body(req); const r = await teach(x[1], String(b.feedback || '')); json(res, r.error ? 400 : 200, r); return true; }
    if (req.method === 'POST' && (x = m(/^\/api\/arms\/teach\/(\w+)\/apply$/))) { const r = applyTeach(x[1]); json(res, r.error ? 400 : 200, r); return true; }
    if (req.method === 'POST' && p === '/api/arms/skills-new/database') { const r = newDatabaseSkill(await body(req)); json(res, r.error ? 400 : 200, r); return true; }
    if (req.method === 'POST' && p === '/api/arms/skills-new/artifact') { const r = newArtifactSkill(await body(req)); json(res, r.error ? 400 : 200, r); return true; }
    if (req.method === 'GET' && p === '/api/arms/routines') { json(res, 200, routinesView()); return true; }
    if (req.method === 'POST' && p === '/api/arms/routines') { const r = saveRoutine(await body(req)); json(res, r.error ? 400 : 200, r); return true; }
    if (req.method === 'DELETE' && (x = m(/^\/api\/arms\/routines\/(\w+)$/))) { json(res, 200, deleteRoutine(x[1])); return true; }
    if (req.method === 'POST' && (x = m(/^\/api\/arms\/routines\/(\w+)\/run$/))) { const r = runRoutine(x[1], true); json(res, r.error ? 400 : 200, r); return true; }
    if (req.method === 'POST' && (x = m(/^\/api\/arms\/routines\/(\w+)\/optimise$/))) { const r = optimiseRoutine(x[1]); json(res, r.error ? 400 : 200, r); return true; }
    if (req.method === 'GET' && p === '/api/arms/recos') { json(res, 200, load('recos.json', { cards: [] })); return true; }
    if (req.method === 'POST' && p === '/api/arms/recos/refresh') { json(res, 200, refreshRecos(false)); return true; }
    if (req.method === 'POST' && p === '/api/arms/recos/setup') { const b = await body(req); json(res, 200, setupRecos(b.ids || [])); return true; }
    if (req.method === 'POST' && p === '/api/arms/cache/refresh') { json(res, 200, await refreshCache()); return true; }
    if (req.method === 'GET' && p === '/api/arms/reviews') {
      const out = {};
      try { for (const f of fs.readdirSync(REVIEWS)) if (f.endsWith('.json')) { const r = JSON.parse(fs.readFileSync(path.join(REVIEWS, f), 'utf8')); out[r.jobId] = { status: r.status, updatedAt: r.updatedAt }; } } catch {}
      json(res, 200, out); return true;
    }
    if ((x = m(/^\/api\/arms\/reviews\/(\w+)$/))) {
      const fpath = path.join(REVIEWS, `${x[1]}.json`);
      if (req.method === 'GET') { try { json(res, 200, JSON.parse(fs.readFileSync(fpath, 'utf8'))); } catch { json(res, 200, { jobId: x[1], comments: { answer: '', files: {} }, overall: '', status: 'open' }); } return true; }
      if (req.method === 'POST') {
        const b = await body(req);
        const r = { jobId: x[1], comments: { answer: String((b.comments || {}).answer || ''), files: (b.comments || {}).files || {} }, overall: String(b.overall || ''), status: ['open', 'sent', 'approved'].includes(b.status) ? b.status : 'open', updatedAt: now() };
        fs.writeFileSync(fpath, JSON.stringify(r, null, 1));
        json(res, 200, r); return true;
      }
    }
    if (req.method === 'GET' && p === '/api/arms/inbox') { json(res, 200, inboxList()); return true; }
    if (req.method === 'GET' && p === '/api/arms/inbox/page') {
      const kind = url.searchParams.get('kind') === 'artifact' ? ARTIFACTS : INBOX;
      const f = path.resolve(kind, url.searchParams.get('name') || '');
      if (!f.startsWith(kind + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { json(res, 404, { error: 'not found' }); return true; }
      json(res, 200, { text: fs.readFileSync(f, 'utf8').slice(0, 300000) }); return true;
    }
    return false;
  }

  return { route, schedule, decideModel, onAnswer, recordOutcome };
}

module.exports = { install };
