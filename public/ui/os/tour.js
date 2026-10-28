'use strict';
// The 1-minute tour: five steps that point at the real controls (start a job, watch it, decide, undo, find anything).
// Started from the main menu, Today's suggestions or the empty Jobs list; never on its own. Esc or Skip ends it.
const TOUR = [
  { app: 'newjob', target: '#njText', title: 'Start a job', text: 'Describe a task in your own words, or start from a template. The card underneath shows who will take it, at what effort, and what similar jobs cost.' },
  { app: 'jobs', target: '#jlist', title: 'Watch it work', text: 'Every job lives here: live progress, who is working on it, and what it has cost so far. Reply any time; your message goes straight to the lead who owns the job.' },
  { app: 'jobs', target: '#jneed, .composer', title: 'You decide', text: 'Plans, terminal commands, questions and edits outside the project wait for you in Needs you, right above the reply box. Nothing big runs without your OK.' },
  { app: 'jobs', target: '#jtabs', title: 'Undo anything', text: 'Changes lists every file an agent touched on a job, with the diff. Undo puts them back. Agents never commit or push; that stays with you.' },
  { app: null, target: '.searchpill', title: 'Find anything', text: 'Ctrl+K opens any app, job, project or setting, or starts a new job from what you type. The sidebar keeps the daily apps; Insights and Tools fold away.' },
];
let tourAt = -1;
function startTour() {
  tourAt = 0;
  if (!S.job) { const t = Object.values(S.tickets).sort((a, b) => b.createdAt - a.createdAt)[0]; if (t) S.job = t.id; }
  showTourStep();
}
function endTour() {
  tourAt = -1;
  const el = $('#tour'); if (el) el.remove();
  setPref('toured', '1');
}
function showTourStep() {
  const step = TOUR[tourAt];
  if (!step) return endTour();
  if (step.app && S.app !== step.app) openApp(step.app);
  setTimeout(() => {
    let el = $('#tour');
    if (!el) { el = document.createElement('div'); el.id = 'tour'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); document.body.appendChild(el); }
    const target = step.target.split(',').map((s) => document.querySelector(s.trim())).find((x) => x && x.offsetParent && x.getBoundingClientRect().height > 4);
    const r = target ? target.getBoundingClientRect() : { left: innerWidth / 2 - 150, top: innerHeight / 2 - 60, width: 300, height: 0, right: innerWidth / 2 + 150, bottom: innerHeight / 2 - 60 };
    const pad = 6;
    const cardW = 340;
    const below = r.bottom + 180 < innerHeight;
    const left = Math.max(12, Math.min(innerWidth - cardW - 12, r.left));
    const top = below ? r.bottom + pad + 10 : Math.max(12, r.top - pad - 10 - 170);
    el.innerHTML = `<div class="tour-spot" style="left:${r.left - pad}px;top:${r.top - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px"></div>
      <div class="tour-card" style="left:${left}px;top:${top}px;width:${cardW}px" aria-labelledby="tourTitle">
        <div class="hint">Step ${tourAt + 1} of ${TOUR.length}</div><h3 id="tourTitle">${esc(step.title)}</h3><p>${esc(step.text)}</p>
        <div class="row"><button class="btn sm" data-act="tourEnd">Skip</button><span style="flex:1"></span>${tourAt ? '<button class="btn sm" data-act="tourBack">Back</button>' : ''}<button class="btn pri sm" data-act="tourNext">${tourAt === TOUR.length - 1 ? 'Done' : 'Next'}</button></div></div>`;
    el.querySelector('[data-act=tourNext]').focus();
  }, step.app && S.app !== step.app ? 250 : 60);
}
addEventListener('keydown', (e) => { if (tourAt >= 0 && e.key === 'Escape') { e.stopPropagation(); endTour(); } }, true);
addEventListener('resize', () => { if (tourAt >= 0) showTourStep(); });
Object.assign(ACT, {
  tour: () => startTour(),
  tourNext: () => { tourAt++; showTourStep(); },
  tourBack: () => { tourAt = Math.max(0, tourAt - 1); showTourStep(); },
  tourEnd: () => endTour(),
});
