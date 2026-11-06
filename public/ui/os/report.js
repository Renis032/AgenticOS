'use strict';
// Share a report (lib/reports.js): what the team did over a period, for a client, a manager or your own records.
// Pick the period, a team or a project, and whether costs and answer summaries go in; the preview is the page itself.
// Save it as an HTML page (prints cleanly, opens anywhere) or copy it as Markdown for an email or a doc.

function reportQuery(extra) {
  const R = S.report || {};
  const q = new URLSearchParams({ days: String(R.days || 7), costs: R.costs === false ? '0' : '1', summaries: R.summaries === false ? '0' : '1', ...(extra || {}) });
  if (R.lead) q.set('lead', R.lead);
  if (R.project) q.set('project', R.project);
  if (R.title) q.set('title', R.title);
  return `/api/reports?${q}`;
}

function renderReport() {
  const R = S.report;
  const leads = S.residents.filter((k) => k !== S.root && S.agents[k]);
  const opt = (v, l, cur) => `<option value="${esc(v)}" ${String(cur || '') === String(v) ? 'selected' : ''}>${esc(l)}</option>`;
  $('#reportBody').innerHTML = `<header><div><h2>Share a report</h2><div class="hint">What the team did, ready to send. Nothing from inside a job goes in beyond the start of its answer; anything that looks like a key or password is blanked.</div></div><button class="tb-ic" data-act="reportClose" aria-label="Close">${ic('close')}</button></header>
    <div class="rpform">
      <label>Period<select id="rp_days">${[[7, 'Last 7 days'], [14, 'Last 14 days'], [30, 'Last 30 days'], [90, 'Last 90 days']].map(([v, l]) => opt(v, l, R.days)).join('')}</select></label>
      <label>Team<select id="rp_lead">${opt('', 'All teams', R.lead)}${leads.map((k) => opt(k, `${S.agents[k].persona} · ${S.agents[k].room || ''}`, R.lead)).join('')}</select></label>
      <label>Project<select id="rp_project">${opt('', 'All projects', R.project)}${S.projects.map((p) => opt(p.name, p.name, R.project)).join('')}</select></label>
      <label class="wide">Title<input class="in" id="rp_title" placeholder="What the team did" value="${esc(R.title || '')}"></label>
      <label class="chk"><input type="checkbox" id="rp_costs" ${R.costs === false ? '' : 'checked'}> Costs</label>
      <label class="chk"><input type="checkbox" id="rp_summaries" ${R.summaries === false ? '' : 'checked'}> Answer summaries</label>
    </div>
    <iframe class="rpview" id="rpView" title="Report preview" sandbox=""></iframe>
    <footer><span class="hint" id="rpInfo"></span><span class="sp"></span><button class="btn sm" data-act="reportCopy">Copy as Markdown</button><a class="btn sm pri" id="rpSave" href="${esc(reportQuery({ format: 'html', download: '1' }))}" download>Save as HTML</a></footer>`;
  loadReportPreview();
}

async function loadReportPreview() {
  const R = S.report; if (!R) return;
  const seq = (R.seq = (R.seq || 0) + 1);
  try {
    const [page, data] = await Promise.all([fetch(reportQuery({ format: 'html' })).then((r) => r.text()), api('GET', reportQuery())]);
    if (!S.report || seq !== S.report.seq) return;
    $('#rpView').srcdoc = page;
    const T = data.totals;
    $('#rpInfo').textContent = `${T.jobs} job${T.jobs === 1 ? '' : 's'} · ${T.done} done${data.costs ? ` · ${money(T.cost)}` : ''}`;
    $('#rpSave').href = reportQuery({ format: 'html', download: '1' });
  } catch (e) { $('#rpInfo').textContent = `Could not build the report: ${e.message}`; }
}

function openReport(opts) {
  closeMenu(); closePal();
  S.report = { days: 7, costs: true, summaries: true, ...(S.report || {}), ...(opts || {}) };
  renderReport();
  $('#report').classList.add('on');
}
function closeReport() { $('#report').classList.remove('on'); }

document.addEventListener('change', (e) => {
  if (!e.target.closest || !e.target.closest('#report') || !S.report) return;
  const v = (id) => $('#' + id);
  Object.assign(S.report, { days: Number(v('rp_days').value), lead: v('rp_lead').value || null, project: v('rp_project').value || null,
    costs: v('rp_costs').checked, summaries: v('rp_summaries').checked, title: v('rp_title').value.trim() || null });
  loadReportPreview();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#report').classList.contains('on')) { e.stopImmediatePropagation(); closeReport(); } }, true);

Object.assign(ACT, {
  report: (d) => openReport(d && d.lead ? { lead: d.lead } : null),
  reportClose: () => closeReport(),
  reportCopy: async () => {
    try {
      const md = await fetch(reportQuery({ format: 'md' })).then((r) => r.text());
      await navigator.clipboard.writeText(md);
      notifyQuiet('Copied the report as Markdown.');
    } catch (e) { notifyQuiet(`Could not copy: ${e.message}`); }
  },
});
