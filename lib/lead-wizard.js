'use strict';
// The new-lead wizard (Teams & roles → New team lead). The user explains in plain words what the lead is for; one
// Sonnet call with no tools drafts the rest the way the built-in leads are set up: a name, a team, what it owns (for
// routing), routing keywords, its instructions and a few specialist roles. The user reviews and edits every field,
// then `createTeam` (lib/teams-config.js) makes the lead. If the model is unavailable, a plain template is drafted
// from the user's own words instead, so the wizard always works.

const MAX_PURPOSE = 3000;

function install(ctx) {
  const { fs, home, oneShot, readJson } = ctx;

  const words = (s) => (String(s || '').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}+#.-]{2,}/gu) || []).map((w) => w.replace(/[.-]+$/, '')).filter((w) => w.length > 2);
  const STOP = new Set('the and for with that this from into your their about which will should would could things stuff everything anything work works working help helps make makes them they what when where who how all any can also more most other some such than then there these those very just like want need lead team project projects look after keep running explain changed change manage handle take care sure always never mine home folder files everything'.split(' '));
  const title = (s) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());

  // Without a model: the user's purpose becomes the description, keywords come from its words.
  function template(b) {
    const purpose = String(b.purpose || '').trim();
    // A folder named in the purpose ("in ~/homelab") becomes the working folder when it exists.
    const named = (purpose.match(/~\/[\w.\/-]+/) || [])[0];
    const cwd = b.cwd || (named && fs.existsSync(home(named.replace(/[.,)]+$/, ''))) ? named.replace(/[.,)]+$/, '') : '~');
    const kw = [...new Set(words(purpose.replace(/~\/[\w.\/-]+/g, ' ')).filter((w) => !STOP.has(w) && !/^\d+$/.test(w)))].slice(0, 8);
    const base = cwd !== '~' ? cwd.split('/').filter(Boolean).pop() : '';
    const room = String(b.room || '').trim() || title(base || kw.slice(0, 2).join(' ') || 'New team');
    const persona = String(b.persona || '').trim() || 'Nova';
    return {
      persona, room, description: purpose.split(/(?<=\.)\s/)[0].slice(0, 300) || `Owns ${room}.`, keywords: kw,
      cwd, access: b.access || 'edit', model: 'opus', effort: 'high',
      prompt: `You are ${persona}, the permanent lead for ${room}. ${purpose}\n\nYou own each ticket end to end. Do quick things yourself; ` +
        'delegate anything that needs more than about 10 tool calls, touches more than 2 or 3 files or means running and fixing tests, ' +
        'putting independent pieces in ONE delegate call so they run in parallel. Ask the user only when the answer changes what you do, ' +
        'and offer the likely answers as options. Before you report something as done, check it (run the build or the tests, read the result). ' +
        'Your final message goes straight to the user: what you did, what you checked, anything left. Never commit or push.',
      roles: [{ name: 'Researcher', description: 'Reads code, docs and the web and reports findings with sources.', access: 'web' }],
      drafted: 'template',
    };
  }

  function exampleLead(r) {
    const k = (r.residents || []).find((x) => x !== r.root && r.roles[x] && r.roles[x].prompt);
    return k ? String(r.roles[k].prompt).slice(0, 1800) : '';
  }

  async function draft(b) {
    const purpose = String(b.purpose || '').trim().slice(0, MAX_PURPOSE);
    if (purpose.length < 15) return { error: 'Explain in a sentence or two what this lead should look after.' };
    const r = readJson('roster.json');
    const taken = Object.values(r.roles).map((d) => d.persona).filter(Boolean);
    const rooms = (r.residents || []).filter((k) => k !== r.root).map((k) => `${r.roles[k].room}: ${r.roles[k].description}`);
    const prompt = `You design a new permanent team lead for the user's Agentic OS office (a team of Claude Code agents).
The user describes what the lead is for. Reply with ONLY a JSON object, no prose, with these keys:
- "persona": a short, friendly first name for the lead (not one of: ${taken.join(', ') || 'none'})${b.persona ? `; the user chose "${b.persona}", use it` : ''}
- "room": the team's name, 1-3 words${b.room ? `; the user chose "${b.room}", use it` : ''}
- "description": one or two sentences on what this team owns and what it does NOT own. The dispatcher routes jobs with it, so make the boundary with the existing teams clear.
- "keywords": 4-10 lowercase words or short phrases that, when they appear in a job, clearly mean it belongs to this team (avoid generic words)
- "access": "edit" if the lead must change files, "readonly" if it only reads and answers
- "model": "opus" for engineering or judgement-heavy work, "sonnet" for lighter work
- "effort": "high" normally, "medium" for light work
- "prompt": the lead's standing instructions, 120-250 words, second person. Cover: what it owns, how it works (quick things itself, bigger work delegated to specialists in parallel), how it checks its work before reporting it done, what to ask the user, and what it must never do (never commit or push, stay inside its area).
- "roles": 1-3 specialists the lead can hire, each {"name", "description" (one line), "access": "edit" | "readonly" | "web"}

Existing teams (don't overlap):
${rooms.map((x) => '- ' + x).join('\n') || '- none'}
${exampleLead(r) ? `\nAn existing lead's instructions, for tone and level of detail:\n"""${exampleLead(r)}"""\n` : ''}
Working folder: ${b.cwd || 'not given'}

What the user wants this lead for:
"""${purpose}"""`;
    const res = await oneShot(prompt, 'sonnet', 'low');
    let j = null;
    if (res && res.text) { const m = res.text.match(/\{[\s\S]*\}/); try { j = m && JSON.parse(m[0]); } catch {} }
    const base = template({ ...b, purpose });
    if (!j || typeof j !== 'object') return { ...base, note: res && res.error ? `Drafted from your words (the model was unavailable: ${String(res.error).slice(0, 120)}).` : 'Drafted from your words.' };
    const str = (v, d, n = 400) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : d);
    return {
      persona: str(b.persona, str(j.persona, base.persona, 30), 30), room: str(b.room, str(j.room, base.room, 40), 40),
      description: str(j.description, base.description, 500),
      keywords: (Array.isArray(j.keywords) ? j.keywords : base.keywords).map((k) => String(k).toLowerCase().trim()).filter(Boolean).slice(0, 12),
      cwd: base.cwd, access: ['edit', 'readonly'].includes(j.access) ? j.access : base.access,
      model: ['opus', 'sonnet', 'haiku'].includes(j.model) ? j.model : base.model, effort: ['medium', 'high', 'xhigh'].includes(j.effort) ? j.effort : base.effort,
      prompt: str(j.prompt, base.prompt, 4000),
      roles: (Array.isArray(j.roles) ? j.roles : base.roles).slice(0, 4).map((x) => ({ name: str(x && x.name, 'Specialist', 40), description: str(x && x.description, '', 200), access: ['edit', 'readonly', 'web'].includes(x && x.access) ? x.access : 'readonly' })),
      drafted: 'model', costUsd: res.costUsd || 0,
    };
  }

  async function route(req, res, url, p, body, json) {
    if (req.method === 'POST' && p === '/api/config/team/draft') {
      const b = await body(req);
      if (b.cwd && !fs.existsSync(home(b.cwd))) return json(res, 400, { error: `There is no folder ${b.cwd}.` }), true;
      const r = await draft(b);
      json(res, r.error ? 400 : 200, r);
      return true;
    }
    return false;
  }

  return { draft, template, route };
}

module.exports = { install };
