'use strict';
// Hardware while a job runs (lib/hardware.js): the job's Hardware tab and the "This computer" card on Health.
// Charts follow one set of rules: one y-axis per chart (CPU % and memory are separate charts), 2px lines, hairline
// gridlines, a crosshair with one tooltip listing every series, a legend for two series plus labels at the line ends,
// and a table view. Colors are categorical slots 1 and 2, stepped for light and dark (validated against the panels).

const HW_COLORS = () => (isDark() ? ['#3987e5', '#d95926'] : ['#2a78d6', '#eb6834']);
const hwSec = (s) => (s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
const hwMb = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);

// series: [{ name, values: [number|null], fmt }], xs: seconds (or ms timestamps with opts.clock). opts: { max, unit, height, clock }
function hwChart(id, xs, series, opts) {
  // Drawn at the width it is shown at, so its text stays at its real size.
  const W = Math.max(320, Math.round(opts.width || 640)), H = opts.height || 150, L = 44, R = 92, T = 10, B = 22;
  const colors = HW_COLORS();
  const vals = series.flatMap((s) => s.values).filter((v) => v != null);
  const top = opts.max || niceMax(Math.max(1, ...vals));
  const x0 = xs[0] || 0, x1 = Math.max(x0 + 1, xs[xs.length - 1] || 0);
  const X = (x) => L + ((x - x0) / (x1 - x0)) * (W - L - R), Y = (v) => T + (1 - Math.min(v, top) / top) * (H - T - B);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * top);
  const grid = ticks.map((v) => `<line class="hwgrid" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text class="hwax" x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${esc(opts.fmt ? opts.fmt(v) : Math.round(v))}</text>`).join('');
  const xl = [x0, (x0 + x1) / 2, x1].map((x, i) => `<text class="hwax" x="${X(x)}" y="${H - 6}" text-anchor="${['start', 'middle', 'end'][i]}">${esc(opts.clock ? new Date(x).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : hwSec(x - x0))}</text>`).join('');
  const path = (s) => {
    let d = '', pen = false;
    s.values.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${X(xs[i]).toFixed(1)},${Y(v).toFixed(1)}`; pen = true; });
    return d;
  };
  const lines = series.map((s, i) => `<path d="${path(s)}" fill="none" stroke="${colors[i]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`).join('');
  // A label at each line's end (two series at most), nudged apart when they would touch.
  const ends = series.map((s, i) => { const k = s.values.map((v, j) => (v == null ? -1 : j)).filter((j) => j >= 0).pop(); return k == null ? null : { i, y: Y(s.values[k]), x: X(xs[k]), v: s.values[k] }; }).filter(Boolean);
  if (ends.length === 2 && Math.abs(ends[0].y - ends[1].y) < 14) { const mid = (ends[0].y + ends[1].y) / 2, up = ends[0].y <= ends[1].y ? 0 : 1; ends[up].y = mid - 7; ends[1 - up].y = mid + 7; }
  const labels = ends.map((e) => `<circle cx="${e.x}" cy="${Y(series[e.i].values.filter((v) => v != null).pop())}" r="4" fill="${colors[e.i]}" stroke="var(--panel)" stroke-width="2"/><text class="hwend" x="${W - R + 8}" y="${e.y + 4}">${esc(series[e.i].short || series[e.i].name)} ${esc(series[e.i].fmt(e.v))}</text>`).join('');
  const legend = series.length > 1 ? `<div class="hwlegend">${series.map((s, i) => `<span><i style="background:${colors[i]}"></i>${esc(s.name)}</span>`).join('')}</div>` : '';
  S.hwCharts = S.hwCharts || {};
  S.hwCharts[id] = { xs, series, X, W, L, R, x0, clock: !!opts.clock };
  return `${legend}<div class="hwchart" data-chart="${id}"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || '')}">${grid}${xl}${lines}${labels}<line class="hwx" x1="0" x2="0" y1="${T}" y2="${H - B}" style="display:none"/></svg><div class="hwtip" role="status"></div></div>`;
}
function niceMax(v) { const p = 10 ** Math.floor(Math.log10(v)); const m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p; }

// The crosshair: snaps to the nearest sample and lists every series there.
document.addEventListener('pointermove', (e) => {
  const box = e.target.closest && e.target.closest('.hwchart');
  for (const other of document.querySelectorAll('.hwchart.hover')) if (other !== box) { other.classList.remove('hover'); other.querySelector('.hwx').style.display = 'none'; }
  if (!box) return;
  const C = (S.hwCharts || {})[box.dataset.chart];
  if (!C || !C.xs.length) return;
  const svg = box.querySelector('svg'), r = svg.getBoundingClientRect();
  const vx = ((e.clientX - r.left) / r.width) * C.W;
  let k = 0, best = Infinity;
  C.xs.forEach((x, i) => { const d = Math.abs(C.X(x) - vx); if (d < best) { best = d; k = i; } });
  const line = box.querySelector('.hwx');
  line.setAttribute('x1', C.X(C.xs[k])); line.setAttribute('x2', C.X(C.xs[k])); line.style.display = '';
  const tip = box.querySelector('.hwtip');
  tip.replaceChildren();
  const head = document.createElement('div'); head.className = 'hint';
  head.textContent = C.clock ? new Date(C.xs[k]).toLocaleTimeString() : `${hwSec(C.xs[k] - C.x0)} in`;
  tip.appendChild(head);
  const colors = HW_COLORS();
  C.series.forEach((s, i) => {
    const row = document.createElement('div');
    const key = document.createElement('i'); key.style.background = colors[i];
    const val = document.createElement('b'); val.textContent = s.values[k] == null ? '–' : s.fmt(s.values[k]);
    row.append(key, val, document.createTextNode(` ${s.name}`));
    tip.appendChild(row);
  });
  const px = (C.X(C.xs[k]) / C.W) * r.width;
  tip.style.left = `${Math.min(r.width - 170, Math.max(0, px + 12))}px`;
  box.classList.add('hover');
});

function hwTable(cols, rows) {
  return `<details class="hwtable"><summary>Show as a table</summary><div class="hwscroll"><table class="ps"><thead><tr>${cols.map((c) => `<th class="num">${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((v) => `<td class="num">${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
}

async function renderHardware(t, body) {
  let h;
  try { h = await api('GET', `/api/hardware/job/${t.id}`); } catch (e) { body.innerHTML = `<div class="hint" style="margin:10px 0">Hardware figures are not available: ${esc(e.message)}</div>`; return; }
  if (S.job !== t.id || S.jtab !== 'hardware') return;
  const rows = h.rows || [];
  const intro = `<div class="hint" style="margin:10px 0">What this job's processes used — its agents and the tools they ran, its terminal commands and its checks — next to the whole computer (${h.cpus} cores, ${hwMb(h.memTotalMb)} memory).${h.live ? ' Updates while it runs.' : ''}</div>`;
  if (!rows.length) { body.innerHTML = intro + `<div class="card"><div class="hint">${h.perJob ? 'No samples yet: they start when an agent, a command or a check is working on this job.' : 'Per-job figures need Linux or macOS.'}</div></div>`; return; }
  const s = h.summary || {};
  const tile = (v, l) => `<div class="hwstat"><b>${esc(v)}</b><span>${esc(l)}</span></div>`;
  const xs = rows.map((r) => r[0]);
  const col = (i) => rows.map((r) => r[i]);
  const pct = (v) => `${Math.round(v)}%`;
  const hasTemp = rows.some((r) => r[5] != null), hasGpu = rows.some((r) => r[6] != null);
  const width = (body.clientWidth || 700) - 34;
  body.innerHTML = intro + `<div class="hwstats">${tile(pct(s.peakCpu || 0), 'peak CPU (job)')}${tile(pct(s.avgCpu || 0), 'average CPU (job)')}${tile(hwMb(s.peakMemMb || 0), 'peak memory (job)')}${s.peakTemp != null ? tile(`${Math.round(s.peakTemp)} °C`, 'hottest CPU') : ''}${s.peakGpu != null ? tile(pct(s.peakGpu), 'peak GPU (computer)') : ''}${tile(hwSec(s.seconds || 0), 'measured')}</div>
    <div class="card hwcard"><h3>CPU · % of the whole computer</h3>${hwChart('jcpu', xs, [{ name: 'This job', short: 'job', values: col(1), fmt: pct }, { name: 'Whole computer', short: 'all', values: col(2), fmt: pct }], { max: 100, fmt: pct, label: 'CPU use over time', width })}</div>
    <div class="card hwcard"><h3>Memory used by this job</h3>${hwChart('jmem', xs, [{ name: 'This job', short: 'job', values: col(3), fmt: hwMb }], { fmt: hwMb, label: 'Memory over time', width })}</div>
    ${hasTemp ? `<div class="card hwcard"><h3>CPU temperature · °C</h3>${hwChart('jtemp', xs, [{ name: 'Hottest CPU sensor', short: '', values: col(5), fmt: (v) => `${Math.round(v)} °C` }], { fmt: (v) => `${Math.round(v)}°`, label: 'Temperature over time', width })}</div>` : ''}
    ${hasGpu ? `<div class="card hwcard"><h3>GPU · % busy (whole computer)</h3>${hwChart('jgpu', xs, [{ name: 'GPU', short: '', values: col(6), fmt: pct }], { max: 100, fmt: pct, label: 'GPU use over time', width })}</div>` : ''}
    ${hwTable(['Time in', 'Job CPU %', 'Computer CPU %', 'Job memory MB', 'Computer memory %', 'CPU °C', 'GPU %'], rows.map((r) => [hwSec(r[0]), r[1], r[2], r[3], r[4], r[5] ?? '–', r[6] ?? '–']))}`;
}

// Health: the computer right now and over the last 15 minutes.
let hwLast = null;
function hardwareCardHtml() {
  if (!hwLast || Date.now() - hwLast.at > 8000) api('GET', '/api/hardware').then((h) => { hwLast = { at: Date.now(), h }; S.hKey = null; if (S.app === 'health') APPS.health.update(); }).catch(() => {});
  const h = hwLast && hwLast.h;
  if (!h || !h.now) return `<div class="card"><h3>This computer</h3><div class="hint">Measuring…</div></div>`;
  const N = h.now, xs = h.series.map((p) => p.t), pct = (v) => `${Math.round(v)}%`;
  return `<div class="card wide"><h3>This computer · last 15 minutes</h3><div class="hwstats">
      <div class="hwstat"><b>${pct(N.cpu)}</b><span>CPU now (${h.cpus} cores)</span></div><div class="hwstat"><b>${pct(N.mem)}</b><span>memory (${hwMb(N.memMb)} of ${hwMb(h.memTotalMb)})</span></div>
      ${N.temp != null ? `<div class="hwstat"><b>${Math.round(N.temp)} °C</b><span>hottest CPU sensor</span></div>` : ''}${N.gpu != null ? `<div class="hwstat"><b>${pct(N.gpu)}</b><span>GPU (${hwMb(N.gpuMem || 0)} in use)</span></div>` : ''}</div>
    ${hwChart('hcpu', xs, [{ name: 'CPU', short: '', values: h.series.map((p) => p.cpu), fmt: pct }], { max: 100, fmt: pct, clock: true, height: 110, label: 'CPU over the last 15 minutes', width: (($('#hBody') || {}).clientWidth || 900) - 64 })}
    <div class="hint" style="margin-top:6px">Each job's own share is on its Hardware tab.</div></div>`;
}
