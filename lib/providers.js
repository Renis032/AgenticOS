'use strict';
// Other model providers for the office's one-shot tasks (Preferences → Models): Ask the office, the reviewer for jobs
// without checks, the lead wizard, talking a lesson over, and routing a job the rules cannot place. Leads and
// specialists stay on Claude (they need Claude Code's tools). Providers: OpenAI or anything OpenAI-compatible
// (OpenRouter, LM Studio, vLLM, llama.cpp's server), Google Gemini, and Ollama on this computer. Each task can use its own
// provider and model; when a provider fails, the task falls back to Claude unless that is turned off. Keys are checked
// before they are saved and kept in data/providers.json (0600); the window only sees their last four characters.
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const TASKS = {
  ask: { name: 'Ask the office', hint: 'answers questions about your jobs from facts the office gathers' },
  review: { name: 'Reviewer for jobs without checks', hint: 'reads the request, acceptance criteria, answer and diff and says PASS or FAIL' },
  walkthrough: { name: 'Change walkthrough', hint: 'puts a job\'s changed files in reading order and says why each changed' },
  wizard: { name: 'New-lead wizard', hint: 'drafts a lead from your description' },
  lessons: { name: 'Talking a lesson over', hint: 'rewrites a lesson from your explanation' },
  routing: { name: 'Routing unclear jobs', hint: 'picks the lead when the routing rules cannot; God decides when it is unsure' },
};
const KINDS = {
  openai: { name: 'OpenAI or compatible', base: () => process.env.AGENTOS_OPENAI_URL || 'https://api.openai.com/v1', needsKey: true },
  gemini: { name: 'Google Gemini', base: () => process.env.AGENTOS_GEMINI_URL || 'https://generativelanguage.googleapis.com/v1beta', needsKey: true },
  ollama: { name: 'Ollama (this computer)', base: () => process.env.AGENTOS_OLLAMA_URL || 'http://127.0.0.1:11434', needsKey: false },
};

function install({ DATA, now }) {
  const FILE = path.join(DATA, 'providers.json');
  let cfg = load();
  const stats = {}; // task -> { calls, fails, fallbacks, ms, inTokens, outTokens, last }
  function load() { try { return { providers: {}, tasks: {}, fallback: true, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { return { providers: {}, tasks: {}, fallback: true }; } }
  function save() { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 }); try { fs.chmodSync(FILE, 0o600); } catch {} }

  function request(method, url, body, headers = {}, timeout = 90000) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const data = body ? Buffer.from(JSON.stringify(body)) : null;
      const req = (u.protocol === 'http:' ? http : https).request(u, { method, timeout, headers: { accept: 'application/json', ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers } }, (res) => {
        let s = ''; res.on('data', (c) => (s += c));
        res.on('end', () => {
          let j = null; try { j = s ? JSON.parse(s) : null; } catch {}
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(j);
          const msg = (j && ((j.error && (j.error.message || j.error)) || j.message)) || s.slice(0, 200);
          reject(new Error(res.statusCode === 401 || res.statusCode === 403 ? `the key was refused (${res.statusCode})` : `${res.statusCode}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`));
        });
      });
      req.on('timeout', () => req.destroy(new Error('no answer in time')));
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  const baseOf = (kind) => String((cfg.providers[kind] || {}).base || KINDS[kind].base()).replace(/\/$/, '');
  const keyOf = (kind) => (cfg.providers[kind] || {}).key || '';

  // The models a provider offers (asked live, so new models show up without an update).
  async function models(kind, key = keyOf(kind), base = baseOf(kind)) {
    if (kind === 'openai') { const j = await request('GET', `${base}/models`, null, { authorization: `Bearer ${key}` }, 20000); return ((j && j.data) || []).map((m) => m.id).sort(); }
    if (kind === 'gemini') { const j = await request('GET', `${base}/models?pageSize=200`, null, { 'x-goog-api-key': key }, 20000); return ((j && j.models) || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => m.name.replace(/^models\//, '')).sort(); }
    if (kind === 'ollama') { const j = await request('GET', `${base}/api/tags`, null, {}, 10000); return ((j && j.models) || []).map((m) => m.name).sort(); }
    return [];
  }

  async function connect(kind, b) {
    if (!KINDS[kind]) return { error: 'Unknown provider.' };
    const key = String(b.key || '').trim() || keyOf(kind);
    const base = String(b.base || '').trim().replace(/\/$/, '') || null;
    if (KINDS[kind].needsKey && !key) return { error: 'Paste the API key first.' };
    if (base && !/^https?:\/\/[^\s]+$/.test(base)) return { error: 'The address should start with http:// or https://.' };
    let list;
    try { list = await models(kind, key, base || KINDS[kind].base().replace(/\/$/, '')); } catch (e) { return { error: `${KINDS[kind].name} did not accept it: ${e.message}` }; }
    if (!list.length) return { error: kind === 'ollama' ? 'Ollama answered but has no models yet: run `ollama pull <model>` first.' : 'It answered, but lists no models this key can use.' };
    cfg.providers[kind] = { ...(KINDS[kind].needsKey ? { key } : {}), ...(base ? { base } : {}), models: list.slice(0, 400), checkedAt: now() };
    save();
    return view();
  }

  function setTask(task, b) {
    if (!TASKS[task]) return { error: 'Unknown task.' };
    const kind = b.provider || 'claude';
    if (kind === 'claude') { delete cfg.tasks[task]; save(); return view(); }
    if (!cfg.providers[kind]) return { error: 'Connect that provider first.' };
    const model = String(b.model || '').trim();
    if (!model) return { error: 'Pick a model.' };
    cfg.tasks[task] = { provider: kind, model };
    save();
    return view();
  }

  function view() {
    const P = Object.fromEntries(Object.keys(KINDS).map((k) => {
      const p = cfg.providers[k];
      return [k, { name: KINDS[k].name, connected: !!p, needsKey: KINDS[k].needsKey, keyHint: p && p.key ? `…${p.key.slice(-4)}` : null, base: p && p.base ? p.base : null, defaultBase: KINDS[k].base(), models: p ? p.models : [], checkedAt: p ? p.checkedAt : null }];
    }));
    return { providers: P, tasks: Object.fromEntries(Object.entries(TASKS).map(([k, t]) => [k, { ...t, use: cfg.tasks[k] || { provider: 'claude' }, stats: stats[k] || null }])), fallback: cfg.fallback !== false };
  }

  // One prompt in, text out, on the provider chosen for this task. { text, provider, model, tokens } or { error }.
  async function complete(task, prompt) {
    const use = cfg.tasks[task];
    if (!use || !cfg.providers[use.provider]) return null;
    const kind = use.provider, base = baseOf(kind), key = keyOf(kind), t0 = Date.now();
    const st = (stats[task] = stats[task] || { calls: 0, fails: 0, fallbacks: 0, ms: 0, inTokens: 0, outTokens: 0, last: null });
    st.calls++;
    try {
      let text = '', inT = 0, outT = 0;
      if (kind === 'openai') {
        const j = await request('POST', `${base}/chat/completions`, { model: use.model, messages: [{ role: 'user', content: prompt }] }, { authorization: `Bearer ${key}` });
        text = (((j && j.choices) || [])[0] || {}).message?.content || '';
        inT = (j && j.usage && j.usage.prompt_tokens) || 0; outT = (j && j.usage && j.usage.completion_tokens) || 0;
      } else if (kind === 'gemini') {
        const j = await request('POST', `${base}/models/${encodeURIComponent(use.model)}:generateContent`, { contents: [{ role: 'user', parts: [{ text: prompt }] }] }, { 'x-goog-api-key': key });
        text = ((((j && j.candidates) || [])[0] || {}).content?.parts || []).map((p) => p.text || '').join('');
        inT = (j && j.usageMetadata && j.usageMetadata.promptTokenCount) || 0; outT = (j && j.usageMetadata && j.usageMetadata.candidatesTokenCount) || 0;
      } else if (kind === 'ollama') {
        const j = await request('POST', `${base}/api/chat`, { model: use.model, stream: false, messages: [{ role: 'user', content: prompt }] }, {}, 240000);
        text = (j && j.message && j.message.content) || '';
        inT = (j && j.prompt_eval_count) || 0; outT = (j && j.eval_count) || 0;
      }
      // Some models think aloud in <think> tags; the office only wants the answer.
      text = String(text).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      if (!text) throw new Error('an empty answer');
      Object.assign(st, { ms: st.ms + (Date.now() - t0), inTokens: st.inTokens + inT, outTokens: st.outTokens + outT, last: { t: now(), ok: true, model: use.model } });
      return { text, provider: kind, model: use.model, tokens: { in: inT, out: outT }, costUsd: 0 };
    } catch (e) {
      st.fails++;
      st.last = { t: now(), ok: false, model: use.model, error: e.message };
      return { error: `${KINDS[kind].name} (${use.model}): ${e.message}`, provider: kind };
    }
  }
  const noteFallback = (task) => { if (stats[task]) stats[task].fallbacks++; };
  const fallbackOn = () => cfg.fallback !== false;
  const uses = (task) => !!(cfg.tasks[task] && cfg.providers[cfg.tasks[task].provider]);

  // Routing a job the rules could not place: the lead's key, or null to let God decide.
  async function route(text, leads) {
    if (!uses('routing') || !leads.length) return null;
    const prompt = `You route a job to the one team lead who owns it. Leads:\n${leads.map((l) => `- ${l.key}: ${l.persona}, ${l.room}. ${l.description}`).join('\n')}\n\nThe job:\n"""${String(text).slice(0, 4000)}"""\n\nAnswer with JSON only: {"lead": "<key from the list, or null if it is unclear>", "why": "<a few words>"}`;
    const r = await complete('routing', prompt);
    if (!r || r.error) return null;
    let j = null; try { j = JSON.parse((r.text.match(/\{[\s\S]*\}/) || [''])[0]); } catch {}
    const lead = j && leads.find((l) => l.key === j.lead);
    return lead ? { lead: lead.key, why: String(j.why || '').slice(0, 160), model: r.model, provider: r.provider } : null;
  }

  async function routeHttp(req, res, url, p, body, json) {
    if (!p.startsWith('/api/providers')) return false;
    if (p === '/api/providers' && req.method === 'GET') return json(res, 200, view()), true;
    let m;
    // Before the per-provider routes, which would take "settings" for a provider's name.
    if (p === '/api/providers/settings' && req.method === 'POST') { const b = await body(req); if ('fallback' in b) cfg.fallback = !!b.fallback; save(); return json(res, 200, view()), true; }
    if ((m = p.match(/^\/api\/providers\/(\w+)$/)) && req.method === 'POST') {
      const b = await body(req);
      if (b.key && String(b.key).trim().length < 20) return json(res, 400, { error: 'That key looks too short.' }), true;
      const r = await connect(m[1], b);
      return json(res, r.error ? 400 : 200, r), true;
    }
    if ((m = p.match(/^\/api\/providers\/(\w+)$/)) && req.method === 'DELETE') {
      delete cfg.providers[m[1]];
      for (const [k, t] of Object.entries(cfg.tasks)) if (t.provider === m[1]) delete cfg.tasks[k];
      save();
      return json(res, 200, view()), true;
    }
    if ((m = p.match(/^\/api\/providers\/task\/(\w+)$/)) && req.method === 'POST') { const r = setTask(m[1], await body(req)); return json(res, r.error ? 400 : 200, r), true; }
    if ((m = p.match(/^\/api\/providers\/test\/(\w+)$/)) && req.method === 'POST') {
      if (!TASKS[m[1]] || !uses(m[1])) return json(res, 400, { error: 'This task uses Claude.' }), true;
      const r = await complete(m[1], 'Reply with exactly: ok');
      return json(res, r.error ? 400 : 200, r), true;
    }
    return false;
  }

  return { complete, fallbackOn, noteFallback, route, routeHttp, uses, view, TASKS };
}

module.exports = { install, TASKS, KINDS };
