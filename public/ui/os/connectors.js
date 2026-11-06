'use strict';
// Connectors (lib/github.js): Preferences → Connectors, and the GitHub buttons on a finished job.
// The token stays on the server; posting a comment or opening a draft pull request only happens on a click here.

function loadGithub() {
  return api('GET', '/api/github').then((r) => { S.gh = r; if ($('#prefs').classList.contains('on') && S.prefSec === 'connectors') renderPrefs(); }).catch(() => { S.gh = { unavailable: true }; });
}

function loadGmail() {
  return api('GET', '/api/gmail').then((r) => { S.gm = r; if ($('#prefs').classList.contains('on') && S.prefSec === 'connectors') renderPrefs(); }).catch(() => { S.gm = { unavailable: true }; });
}
function gmailPrefs() {
  const M = S.gm;
  if (!M) { loadGmail(); return pGroup('Gmail', [prow('Gmail', 'Loading…', '')]); }
  if (M.unavailable) return '';
  const err = M.lastError ? `<div class="hint" style="color:var(--fail)">Last problem: ${esc(M.lastError)}</div>` : '';
  const what = 'Emails you put under a Gmail label open as jobs, and a finished job can save its answer as a reply draft in the same thread. Nothing is ever sent, marked or deleted: you send the draft from Gmail.';
  if (!M.client) {
    return pGroup('Gmail', [prow('Set up Google sign-in', `${what} Signing in needs a Google OAuth client: in Google Cloud → APIs &amp; Services, enable the Gmail API, then Credentials → Create credentials → OAuth client ID, type “Desktop app”, and paste its ID and secret here.`,
      '<div class="row" style="margin:0;flex-wrap:wrap;justify-content:flex-end"><input class="in" id="gmId" placeholder="…apps.googleusercontent.com" style="width:240px"><input class="in" id="gmSecret" type="password" placeholder="client secret" style="width:150px"><button class="btn pri sm" data-act="gmClient">Save</button></div>')]);
  }
  if (!M.connected) {
    return pGroup('Gmail', [prow('Connect Gmail', `${what} Your browser opens Google's sign-in; afterwards it comes back to this office.${err}`,
      `<div class="row" style="margin:0"><button class="btn pri sm" data-act="gmConnect">Connect Gmail</button>${M.clientFromEnv ? '' : '<button class="btn sm" data-act="gmClientReset" title="Use a different Google OAuth client">Change client</button>'}</div>`)]);
  }
  return pGroup('Gmail', [
    prow(`Connected as ${esc(M.email || 'your Google account')}`, `Checks every 2 minutes. The first look only notes emails already under the label; after that each new one opens a job (5 at a time). A job made from an email is told the email is data from outside, not instructions.${M.canDraft ? '' : ' <span style="color:var(--fail)">Drafts need the compose permission: connect again and allow it.</span>'}${err}`,
      '<div class="row" style="margin:0"><button class="btn sm" data-act="gmPoll">Check now</button><button class="btn sm danger" data-act="gmDisconnect">Disconnect</button></div>'),
    prow('Label to watch', 'Put an email under this label in Gmail to hand it to the office.', `<div class="row" style="margin:0"><input class="in" id="gmLabel" value="${esc(M.label)}" style="width:140px"><select id="gmProject"><option value="">route automatically</option>${S.projects.map((x) => `<option value="${esc(x.name)}" ${M.project === x.name ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select><button class="btn sm" data-act="gmSave">Save</button></div>`),
  ]);
}

function connectorsPrefs() {
  const G = S.gh;
  const head = `<h2>Connectors</h2><div class="hint">Bring work in from where you already track it, and send results back when you say so.</div>`;
  if (!G) { loadGithub(); return head + pGroup('GitHub', [prow('GitHub', 'Loading…', '')]); }
  if (G.unavailable) return head + pGroup('GitHub', [prow('GitHub', 'The office did not answer. Try again in a moment.', '')]);
  const err = G.lastError ? `<div class="hint" style="color:var(--fail)">Last problem: ${esc(G.lastError)}</div>` : '';
  if (!G.configured) {
    return head + pGroup('GitHub', [prow('Connect GitHub',
      'Issues with a label you choose open as jobs; failed CI runs can start a routine; and from a finished job you can post the answer on its issue or open a draft pull request. Create a fine-grained token at github.com → Settings → Developer settings, for the repositories you want, with Issues and Pull requests (read and write), Contents (read and write), Actions and Metadata (read).',
      `<div class="row" style="margin:0"><input class="in" id="ghToken" type="password" placeholder="github_pat_…" autocomplete="off" style="width:220px"><button class="btn pri sm" data-act="ghConnect">Connect</button>${G.ghToken ? '<button class="btn sm" data-act="ghConnect" data-gh="1" title="gh is signed in on this computer">Use gh\'s token</button>' : ''}</div>`)]) + gmailPrefs();
  }
  const rows = (G.projects || []).map((p) => {
    const id = (k) => `gh_${k}_${btoa(unescape(encodeURIComponent(p.name))).replace(/[^\w]/g, '')}`;
    const repo = p.repo || p.detected || '';
    return prow(esc(p.name), p.repo ? `Linked to ${esc(p.repo)}.${p.error ? ` <span style="color:var(--fail)">${esc(p.error)}</span>` : ''}` : p.git ? (p.detected ? `Its origin is ${esc(p.detected)}; link it to use it here.` : 'A git repository without a GitHub origin: type owner/name to link it.') : 'Not a git repository.',
      p.git ? `<div class="ghlink"><input class="in" id="${id('repo')}" placeholder="owner/name" value="${esc(repo)}">
        <label class="chk"><input type="checkbox" id="${id('issues')}" ${!p.repo || p.issues ? 'checked' : ''}> issues labelled</label><input class="in sm" id="${id('label')}" value="${esc(p.label)}" style="width:96px">
        <label class="chk"><input type="checkbox" id="${id('ci')}" ${!p.repo || p.ci ? 'checked' : ''}> CI runs</label>
        <button class="btn sm ${p.repo ? '' : 'pri'}" data-act="ghLink" data-p="${esc(p.name)}" data-k="${id('')}">${p.repo ? 'Save' : 'Link'}</button>${p.repo ? `<button class="btn sm" data-act="ghUnlink" data-p="${esc(p.name)}">Unlink</button><span class="sep"></span><input class="in sm" id="${id('num')}" placeholder="issue #" style="width:76px"><button class="btn sm" data-act="ghImport" data-p="${esc(p.name)}" data-k="${id('')}">Import</button>` : ''}</div>` : '');
  });
  return head + pGroup('GitHub', [
    prow(`Connected as ${esc(G.login || '?')}`, `Checks linked repositories every 2 minutes. The first look only notes issues that are already labelled; later ones open a job for each new one (5 at a time). Nothing is posted to GitHub unless you click “Comment” or “Open draft PR” on a job.${err}`,
      '<div class="row" style="margin:0"><button class="btn sm" data-act="ghPoll">Check now</button><button class="btn sm danger" data-act="ghDisconnect">Disconnect</button></div>'),
    ...rows,
  ]) + gmailPrefs() + pGroup('', [prow('Routines on CI', 'In Routines, a routine set to run “when CI fails on GitHub” is started for each new failed Actions run on a linked repository, and told which run failed.', '')]);
}

// The GitHub buttons in a job's header, filled in once the server says what is possible.
function jobGithubHtml(t) {
  const mail = t.gmail ? (t.gmail.draftId ? '<a class="btn sm" href="https://mail.google.com/mail/u/0/#drafts" target="_blank" rel="noopener">Reply draft ↗</a>'
    : t.answer && !['open', 'paused'].includes(t.status) ? `<button class="btn sm" data-act="gmDraft" data-tip="Save the answer as a reply to ${esc(t.gmail.from)} in Gmail's drafts (not sent)">Draft a reply</button>` : '') : '';
  return mail + jobGithubButtons(t);
}
function jobGithubButtons(t) {
  const G = (S.ghJob || {})[t.id];
  if (!S.ghJobLoading) S.ghJobLoading = {};
  if (!G && !S.ghJobLoading[t.id]) {
    S.ghJobLoading[t.id] = true;
    api('GET', `/api/github/job/${t.id}`).then((r) => { (S.ghJob = S.ghJob || {})[t.id] = { ...r, at: Date.now(), status: t.status }; S.jKey = null; dirty(); }).catch(() => {}).finally(() => { delete S.ghJobLoading[t.id]; });
  } else if (G && G.status !== t.status) { delete S.ghJob[t.id]; }
  if (!G || !G.linked) return '';
  const out = [];
  if (G.commentUrl) out.push(`<a class="btn sm" href="${esc(G.commentUrl)}" target="_blank" rel="noopener">Comment on #${esc(G.issue.issue)} ↗</a>`);
  else if (G.canComment) out.push(`<button class="btn sm" data-act="ghComment" data-tip="Post the answer as a comment on ${esc(G.repo)}#${esc(G.issue.issue)}">Comment on #${esc(G.issue.issue)}</button>`);
  if (G.prUrl) out.push(`<a class="btn sm" href="${esc(G.prUrl)}" target="_blank" rel="noopener">Draft PR ↗</a>`);
  else if (G.canPr) out.push(`<button class="btn sm" data-act="ghPr" data-tip="Push the ${G.prFiles.length} changed file${G.prFiles.length === 1 ? '' : 's'} to a new branch on ${esc(G.repo)} and open a draft pull request">Open draft PR</button>`);
  return out.join('');
}

Object.assign(ACT, {
  gmClient: () => api('POST', '/api/gmail/client', { clientId: $('#gmId').value, clientSecret: $('#gmSecret').value }).then((r) => { S.gm = r; renderPrefs(); }).catch((e) => alert(e.message)),
  gmClientReset: () => { if (!confirm('Forget this Google OAuth client?')) return; api('POST', '/api/gmail/client', { clientId: '' }).then(() => loadGmail()); },
  gmConnect: async () => {
    const r = await api('POST', '/api/gmail/connect').catch((e) => ({ error: e.message }));
    if (r.error) return alert(r.error);
    window.open(r.url, '_blank', 'noopener');
    notifyQuiet('Finish signing in in your browser; this page updates when you are back.');
    const until = Date.now() + 10 * 60000;
    const tick = () => loadGmail().then(() => { if (!(S.gm && S.gm.connected) && Date.now() < until && S.prefSec === 'connectors') setTimeout(tick, 2500); });
    setTimeout(tick, 2500);
  },
  gmDisconnect: () => { if (!confirm('Disconnect Gmail? The office forgets its sign-in.')) return; api('DELETE', '/api/gmail').then((r) => { S.gm = r; renderPrefs(); }); },
  gmPoll: () => api('POST', '/api/gmail/poll').then((r) => { S.gm = r; renderPrefs(); notifyQuiet('Checked Gmail.'); }).catch((e) => { notifyQuiet(`Gmail: ${e.message}`); loadGmail(); }),
  gmSave: () => api('POST', '/api/gmail/settings', { label: $('#gmLabel').value, project: $('#gmProject').value || null }).then((r) => { S.gm = r; renderPrefs(); notifyQuiet('Saved.'); }).catch((e) => alert(e.message)),
  gmDraft: async () => {
    const t = S.tickets[S.job];
    if (!t || !confirm(`Save this job's answer as a reply to ${t.gmail.from} in your Gmail drafts? Nothing is sent; you review and send it in Gmail.`)) return;
    const r = await api('POST', `/api/gmail/job/${t.id}/draft`).catch((e) => ({ error: e.message }));
    if (r.error) return alert(r.error);
    notifyQuiet('Saved as a Gmail draft.');
  },
  ghConnect: async (d) => {
    const token = d.gh ? 'gh' : (($('#ghToken') || {}).value || '').trim();
    if (!token) return notifyQuiet('Paste a GitHub token first.');
    const r = await api('POST', '/api/github', { token }).catch((e) => ({ error: e.message }));
    if (r.error) return alert(`GitHub: ${r.error}`);
    S.gh = r; renderPrefs(); notifyQuiet(`Connected to GitHub as ${r.login}.`);
  },
  ghDisconnect: () => { if (!confirm('Disconnect GitHub? The token and the project links are forgotten.')) return; api('DELETE', '/api/github').then((r) => { S.gh = r; renderPrefs(); }); },
  ghPoll: () => api('POST', '/api/github/poll').then((r) => { S.gh = r; renderPrefs(); notifyQuiet('Checked GitHub.'); }).catch((e) => { notifyQuiet(`GitHub: ${e.message}`); loadGithub(); }),
  ghLink: (d) => {
    const el = (k) => document.getElementById(d.k.replace('gh__', `gh_${k}_`));
    api('POST', '/api/github/link', { project: d.p, repo: el('repo').value.trim(), issues: el('issues').checked, label: el('label').value.trim(), ci: el('ci').checked })
      .then((r) => { S.gh = r; renderPrefs(); notifyQuiet(`${d.p} is linked to GitHub.`); }).catch((e) => alert(e.message));
  },
  ghUnlink: (d) => api('POST', '/api/github/link', { project: d.p, repo: null }).then((r) => { S.gh = r; renderPrefs(); }),
  ghImport: (d) => {
    const n = Number((document.getElementById(d.k.replace('gh__', 'gh_num_')) || {}).value);
    if (!n) return notifyQuiet('Type the issue number first.');
    api('POST', '/api/github/import', { project: d.p, number: n }).then((r) => { closePrefs(); S.job = r.id; openApp('jobs'); if (r.existing) notifyQuiet('That issue already has a job.'); }).catch((e) => alert(e.message));
  },
  ghComment: async () => {
    const t = S.tickets[S.job]; const G = (S.ghJob || {})[S.job];
    if (!t || !G || !confirm(`Post this job's answer as a comment on ${G.repo}#${G.issue.issue}? Everyone who can see the issue will see it.`)) return;
    const r = await api('POST', `/api/github/job/${t.id}/comment`).catch((e) => ({ error: e.message }));
    if (r.error) return alert(r.error);
    delete S.ghJob[t.id]; S.jKey = null; dirty(); notifyQuiet('Posted on GitHub.');
  },
  ghPr: async () => {
    const t = S.tickets[S.job]; const G = (S.ghJob || {})[S.job];
    if (!t || !G) return;
    const files = G.prFiles.slice(0, 12).join('\n  ') + (G.prFiles.length > 12 ? `\n  … and ${G.prFiles.length - 12} more` : '');
    if (!confirm(`Open a draft pull request on ${G.repo}?\n\nThe current content of these files goes onto a new branch agentos/job-${t.n} (from your HEAD), which is pushed to GitHub:\n  ${files}\n\nYour own branch and working files are not changed.`)) return;
    notifyQuiet('Pushing the branch and opening the pull request…');
    const r = await api('POST', `/api/github/job/${t.id}/pr`, {}).catch((e) => ({ error: e.message }));
    if (r.error) return alert(r.error);
    delete S.ghJob[t.id]; S.jKey = null; dirty(); notifyQuiet(`Draft pull request opened: ${r.url}`);
  },
});
