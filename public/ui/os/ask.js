'use strict';
// Ask the office: a small chat about the office itself (lib/ask-office.js). Opens from the title bar, Ctrl+J or the
// Ctrl+K launcher; answers cite jobs as #N, which open the job. The conversation lasts until the window reloads.
const ASK_SUGGEST = ['What did my team do yesterday?', 'Why did my most expensive job cost so much?', 'What is waiting for me right now?', 'Which projects haven\'t moved this week?'];
S.ask = { msgs: [], busy: false };
function openAsk(question) {
  closeMenu(); closePal(); $('#ncenter').classList.remove('on');
  $('#ask').classList.add('on');
  renderAsk();
  const box = $('#askIn');
  if (question) { box.value = question; sendAsk(); } else setTimeout(() => box.focus(), 0);
}
function closeAsk() { $('#ask').classList.remove('on'); }
const askLinks = (html) => html.replace(/(^|[\s>(,;])#(\d+)\b/g, (m, pre, n) => { const t = Object.values(S.tickets).find((x) => x.n === Number(n)); return t ? `${pre}<a data-act="askJob" data-id="${t.id}" title="${esc(t.title)}">#${n}</a>` : m; });
function askAnswerHtml(m) {
  if (m.pending) return '<div class="aa"><span class="dots"><i></i><i></i><i></i></span> <span class="hint">Looking through your jobs, memories and libraries…</span></div>';
  if (m.error) return `<div class="aa err">${esc(m.error)}</div>`;
  const src = (m.sources || []).map((x) => `<button class="chip" data-act="askJob" data-id="${esc(x.id)}" title="${esc(x.title)}">#${x.n} ${esc(short(x.title, 40))}</button>`).join('');
  const meta = [m.ms ? `${(m.ms / 1000).toFixed(1)} s` : '', m.costUsd ? money(m.costUsd) : ''].filter(Boolean).join(' · ');
  return `<div class="aa"><div class="md">${askLinks(md(m.a || ''))}</div>${src ? `<div class="asrc">${src}</div>` : ''}${meta ? `<div class="hint ameta">${meta}</div>` : ''}</div>`;
}
function renderAsk() {
  const el = $('#ask');
  const msgs = S.ask.msgs.map((m) => `<div class="aq">${esc(m.q)}</div>${askAnswerHtml(m)}`).join('');
  const empty = `<div class="aempty"><div class="hint">Ask anything about your office: what happened, what something cost, where a note is, what is waiting. Answers come from your jobs, memories and team libraries.</div>${ASK_SUGGEST.map((q) => `<button class="chip" data-act="askSuggest" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>`;
  const keep = $('#askIn') ? $('#askIn').value : '';
  el.innerHTML = `<div class="ph"><h3>Ask the office</h3>${S.ask.msgs.length ? '<button class="btn sm" data-act="askClear">New chat</button>' : ''}<button class="tb-ic" data-act="askClose" data-tip="Close · Esc">${ic('close')}</button></div>
    <div class="pl" id="askList" aria-live="polite">${msgs || empty}</div>
    <div class="aform"><textarea id="askIn" rows="2" placeholder="e.g. What did Renko do yesterday?" ${S.ask.busy ? 'disabled' : ''}></textarea>${undoBtns('askIn')}<button class="btn pri sm" data-act="askSend" ${S.ask.busy ? 'disabled' : ''}>Ask</button></div>
    <div class="hint afoot">Answered on Haiku from facts the office gathers · about a cent each</div>`;
  const box = $('#askIn');
  box.value = keep;
  wireUndo(box, 'askIn');
  box.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendAsk(); } if (e.key === 'Escape') closeAsk(); };
  const list = $('#askList'); list.scrollTop = list.scrollHeight;
}
async function sendAsk() {
  const box = $('#askIn');
  const q = box.value.trim();
  if (!q || S.ask.busy) return;
  const history = S.ask.msgs.filter((m) => m.a).slice(-3).map((m) => ({ q: m.q, a: m.a }));
  const m = { q, pending: true };
  S.ask.msgs.push(m); S.ask.busy = true; box.value = '';
  renderAsk();
  const r = await api('POST', '/api/ask-office', { question: q, history }).catch((e) => ({ error: e.message }));
  Object.assign(m, { pending: false, a: r.answer, error: r.error, sources: r.sources, ms: r.ms, costUsd: r.costUsd });
  S.ask.busy = false;
  if ($('#ask').classList.contains('on')) { renderAsk(); setTimeout(() => $('#askIn') && $('#askIn').focus(), 0); }
  else notify('answer', 'Ask the office', short(r.answer || r.error || '', 140));
}
document.body.insertAdjacentHTML('beforeend', '<div id="ask" class="pop ask" role="dialog" aria-label="Ask the office"></div>');
document.addEventListener('mousedown', (e) => { if ($('#ask').classList.contains('on') && !e.target.closest('#ask, #askBtn, #pal')) closeAsk(); }, true);
addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'j') { e.preventDefault(); e.stopPropagation(); $('#ask').classList.contains('on') ? closeAsk() : openAsk(); }
  else if (e.key === 'Escape' && $('#ask').classList.contains('on')) { e.stopPropagation(); closeAsk(); }
}, true);
Object.assign(ACT, {
  askOpen: () => ($('#ask').classList.contains('on') ? closeAsk() : openAsk()),
  askClose: () => closeAsk(),
  askSend: () => sendAsk(),
  askSuggest: (d) => { $('#askIn').value = d.q; sendAsk(); },
  askClear: () => { S.ask.msgs = []; renderAsk(); $('#askIn').focus(); },
  askJob: (d) => { closeAsk(); ACT.openJob({ id: d.id }); },
});
