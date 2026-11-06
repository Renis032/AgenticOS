'use strict';
// Preferences → Models (lib/providers.js): other providers for the office's one-shot tasks. Leads and specialists
// stay on Claude. Keys stay on the server.

function loadProviders() {
  return api('GET', '/api/providers').then((r) => { S.prov = r; if ($('#prefs').classList.contains('on') && S.prefSec === 'models') renderPrefs(); }).catch(() => { S.prov = { unavailable: true }; });
}

function modelsPrefs() {
  const head = `<h2>Models</h2><div class="hint">Which model does the office's small one-off tasks. Leads and specialists always run on Claude (they need Claude Code's tools); these tasks can use another provider or a model on this computer.</div>`;
  const M = S.prov;
  if (!M) { loadProviders(); return head + pGroup('', [prow('Providers', 'Loading…', '')]); }
  if (M.unavailable) return head;
  const P = M.providers;
  const prov = (k, extra) => {
    const p = P[k];
    const status = p.connected ? `Connected${p.keyHint ? ` with key ${esc(p.keyHint)}` : ''}${p.base ? ` at ${esc(p.base)}` : ''} · ${p.models.length} model${p.models.length === 1 ? '' : 's'}` : '';
    const key = p.needsKey ? `<input class="in" id="pv_key_${k}" type="password" placeholder="${p.connected ? 'new key (optional)' : 'API key'}" autocomplete="off" style="width:180px">` : '';
    const base = `<input class="in" id="pv_base_${k}" placeholder="${esc(p.defaultBase)}" value="${esc(p.base || '')}" style="width:${k === 'ollama' ? 220 : 200}px" title="Address (leave empty for ${esc(p.defaultBase)})">`;
    return prow(esc(p.name), `${extra}${status ? `<br><span class="pvok">${status}</span>` : ''}`,
      `<div class="row" style="margin:0;flex-wrap:wrap;justify-content:flex-end">${key}${k === 'gemini' ? '' : base}<button class="btn sm ${p.connected ? '' : 'pri'}" data-act="pvConnect" data-k="${k}">${p.connected ? 'Check again' : 'Connect'}</button>${p.connected ? `<button class="btn sm danger" data-act="pvForget" data-k="${k}">Forget</button>` : ''}</div>`);
  };
  const choices = [['claude', 'Claude (default)'], ...Object.entries(P).filter(([, p]) => p.connected).map(([k, p]) => [k, p.name])];
  const task = ([k, t]) => {
    const use = t.use || { provider: 'claude' };
    const models = use.provider !== 'claude' && P[use.provider] ? P[use.provider].models : [];
    const st = t.stats;
    const stTxt = st ? ` · ${st.calls} call${st.calls === 1 ? '' : 's'} since the office started${st.fails ? `, ${st.fails} failed${st.fallbacks ? ` (${st.fallbacks} answered by Claude instead)` : ''}` : ''}${st.calls - st.fails ? `, about ${Math.round(st.ms / Math.max(1, st.calls - st.fails) / 100) / 10} s each` : ''}` : '';
    const err = st && st.last && !st.last.ok ? `<br><span style="color:var(--fail)">Last problem: ${esc(st.last.error)}</span>` : '';
    return prow(esc(t.name), `${esc(t.hint)}.${stTxt}${err}`,
      `<div class="row" style="margin:0;flex-wrap:wrap;justify-content:flex-end"><select id="pt_p_${k}" data-chg="ptProvider" data-k="${k}">${choices.map(([v, l]) => `<option value="${v}" ${use.provider === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>${use.provider === 'claude' ? '' : `<select id="pt_m_${k}" data-chg="ptModel" data-k="${k}">${models.map((m) => `<option ${use.model === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select><button class="btn sm" data-act="ptTest" data-k="${k}">Test</button>`}</div>`);
  };
  return head + pGroup('Providers', [
    prov('openai', 'OpenAI, or any server that speaks its API: OpenRouter (https://openrouter.ai/api/v1), LM Studio or llama.cpp (http://127.0.0.1:1234/v1), vLLM. '),
    prov('gemini', 'Google Gemini, with a key from Google AI Studio. '),
    prov('ollama', 'Models running on this computer through Ollama: free, and nothing leaves the machine. '),
  ]) + pGroup('Tasks', Object.entries(M.tasks).map(task)) + pGroup('', [
    prow('When a provider fails', 'Fall back to Claude so the task still gets done (it then costs what it does on Claude). Off: the task reports the problem instead.', `<label class="sw"><input type="checkbox" data-chg="pvFallback" ${M.fallback ? 'checked' : ''}><i></i></label>`),
    prow('What is sent', 'A task on another provider sends it what it would send Claude: Ask the office sends the facts it gathered about your jobs; the reviewer sends the job\'s request, answer and diff; the wizard sends your description; routing sends the job\'s text and your leads\' descriptions. Pick a local model for anything you would rather keep on this computer.', ''),
  ]);
}

document.addEventListener('change', (e) => {
  const d = e.target.dataset || {};
  if (d.chg === 'ptProvider') {
    const kind = e.target.value;
    const first = kind === 'claude' ? '' : ((S.prov.providers[kind] || {}).models || [])[0] || '';
    api('POST', `/api/providers/task/${d.k}`, { provider: kind, model: first }).then((r) => { S.prov = r; renderPrefs(); }).catch((er) => { alert(er.message); loadProviders(); });
  } else if (d.chg === 'ptModel') {
    api('POST', `/api/providers/task/${d.k}`, { provider: $(`#pt_p_${d.k}`).value, model: e.target.value }).then((r) => { S.prov = r; renderPrefs(); }).catch((er) => alert(er.message));
  } else if (d.chg === 'pvFallback') {
    api('POST', '/api/providers/settings', { fallback: e.target.checked }).then((r) => { S.prov = r; renderPrefs(); });
  }
});

Object.assign(ACT, {
  pvConnect: async (d) => {
    const key = (($(`#pv_key_${d.k}`) || {}).value || '').trim(), base = (($(`#pv_base_${d.k}`) || {}).value || '').trim();
    notifyQuiet('Checking…');
    const r = await api('POST', `/api/providers/${d.k}`, { key: key || undefined, base: base || undefined }).catch((e) => ({ error: e.message }));
    if (r.error) return alert(r.error);
    S.prov = r; renderPrefs(); notifyQuiet(`${r.providers[d.k].name}: ${r.providers[d.k].models.length} models available.`);
  },
  pvForget: (d) => { if (!confirm('Forget this provider? Tasks using it go back to Claude.')) return; api('DELETE', `/api/providers/${d.k}`).then((r) => { S.prov = r; renderPrefs(); }); },
  ptTest: async (d) => {
    notifyQuiet('Asking the model…');
    const r = await api('POST', `/api/providers/test/${d.k}`).catch((e) => ({ error: e.message }));
    notifyQuiet(r.error ? `It did not answer: ${r.error}` : `${r.model} answered: “${String(r.text).slice(0, 80)}”`);
    loadProviders();
  },
});
