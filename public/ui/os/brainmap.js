'use strict';
// The brain map: the knowledge graph on a flat plane, each node drawn as a sprite (no libraries): a coloured badge with
// the kind's icon, the same artwork as the legend (spriteSvg in brain.js), rasterised once per kind. Leads wear a gold
// ring; a dashed gold outline means "carried in every call". Sprites pop in on open and grow when hovered.
// Each team is a lobe around its lead. Links are springs and every node repels the others, so dragging one node pulls its
// neighbours along and the rest make room; a released node keeps its momentum and settles. Drag empty space to pan,
// scroll to zoom, double-click to fit.

const BrainMap = (() => {
  let st = null;
  const SHELL = { agent: 80, memory: 190, page: 235, skill: 225, handoff: 210, instructions: 175, project: 120, job: 165 };
  const REST = { 'reports to': 64, 'on call for': 60, remembers: 50, follows: 95, library: 115, wrote: 125, read: 145, guides: 105, 'available to': 125, proposed: 125, keeps: 95, describes: 55, led: 125, 'worked on': 125, on: 75, taught: 115 };
  const ORDER = ['agent', 'project', 'instructions', 'memory', 'handoff', 'skill', 'page', 'job'];

  function cssColor(name) { return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim() || '#888'; }
  function hexToRgb(h) { const m = h.replace('#', '').match(/.{2}/g); return m && m.length >= 3 ? m.slice(0, 3).map((x) => parseInt(x, 16)) : [150, 150, 150]; }
  // A rounded square path (CanvasRenderingContext2D.roundRect is newer than the window's WebKit).
  function tilePath(ctx, x, y, s, rad) {
    ctx.beginPath(); ctx.moveTo(x + rad, y); ctx.arcTo(x + s, y, x + s, y + s, rad); ctx.arcTo(x + s, y + s, x, y + s, rad);
    ctx.arcTo(x, y + s, x, y, rad); ctx.arcTo(x, y, x + s, y, rad); ctx.closePath();
  }

  function start(host, data, opts) {
    stop();
    const canvas = document.createElement('canvas');
    canvas.className = 'bmap';
    host.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    const reduced = pref('motion', 'full') === 'reduced';
    const light = document.documentElement.dataset.theme === 'light' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: light)').matches);
    const colors = { gold: hexToRgb(cssColor('accent')), text: cssColor('text'), bg: cssColor('bg'), muted: hexToRgb(cssColor('muted')) };
    // One sprite per kind, rasterised large so it stays sharp when zoomed in.
    const sprites = Object.fromEntries(Object.keys(SHELL).map((t) => { const img = new Image(); img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(spriteSvg(t, 160, cssColor(`c-${t}`)))}`; return [t, img]; }));
    const leads = data.nodes.filter((n) => n.type === 'agent' && n.resident && !/manager|god/i.test(n.id + n.label));
    const centers = {};
    leads.forEach((n, i) => { const a = leads.length > 1 ? (i / (leads.length - 1) - 0.5) * 2 : 0; centers[n.id.slice(6)] = [a * 260, 0]; });
    const nodes = data.nodes.map((n) => ({ ...n, r: n.type === 'agent' ? (n.resident ? 21 : 12.5) : n.type === 'job' ? 9.5 : n.type === 'project' ? 14 : Math.max(10, Math.min(20, 8 + Math.sqrt(n.tokens || 0) / 6)) }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const edges = data.edges.filter((e) => byId.has(e.from) && byId.has(e.to)).map((e) => ({ ...e, a: byId.get(e.from), b: byId.get(e.to) }));
    // Which lobe each node belongs to: its own team, or the team of the agent it is most connected to.
    for (const n of nodes) if (n.type === 'agent') n.team = n.resident ? n.id.slice(6) : n.team;
    for (let pass = 0; pass < 2; pass++) for (const e of edges) { if (!e.a.team && e.b.team) e.a.team = e.b.team; if (!e.b.team && e.a.team) e.b.team = e.a.team; }
    const prevAll = (st && st.prev) || (opts && opts.positions) || {};
    let fresh = 0;
    for (const n of nodes) {
      n.c = (n.type === 'project' || n.type === 'job' || n.onCall !== undefined) ? [0, 0] : centers[n.team] || [0, 0];
      const prev = prevAll[n.id];
      if (prev) [n.x, n.y] = prev;
      else { fresh++; const th = Math.random() * Math.PI * 2, rad = SHELL[n.type] * (0.5 + Math.random() * 0.6); n.x = n.c[0] + rad * Math.cos(th); n.y = n.c[1] + rad * Math.sin(th); }
      n.vx = n.vy = 0; n.lift = 0;
    }
    const now = performance.now();
    st = { canvas, ctx, nodes, edges, byId, colors, sprites, light, reduced, k: 1, px: 0, py: 0, lastTouch: 0,
      hover: null, sel: opts && opts.sel, drag: null, pan: null, pulses: [], onSelect: opts && opts.onSelect, onHover: opts && opts.onHover, q: '', t0: now, raf: 0 };
    // Sprites pop onto the plane one kind after another.
    const sorted = [...nodes].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
    sorted.forEach((n, i) => { n.born = reduced || !fresh ? 0 : now + 120 + i * 7; });
    st.active = edges.filter((e) => ['read', 'wrote', 'taught', 'led', 'worked on', 'proposed'].includes(e.kind));
    resize();
    // A new layout settles before it is shown, then the view fits it.
    if (fresh > nodes.length / 3) for (let i = 0; i < 220; i++) step();
    fit();
    wire();
    loop();
    return st;
  }
  function stop() {
    if (!st) return;
    if (st.move) { window.removeEventListener('mousemove', st.move); window.removeEventListener('mouseup', st.up); }
    cancelAnimationFrame(st.raf);
    const prev = st.nodes ? Object.fromEntries(st.nodes.map((n) => [n.id, [n.x, n.y]])) : st.prev;
    if (st.canvas) st.canvas.remove();
    window.removeEventListener('resize', resize);
    st = { prev };
  }
  function resize() {
    if (!st || !st.canvas || !st.canvas.parentElement) return;
    const r = st.canvas.parentElement.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    st.w = r.width; st.h = r.height;
    st.canvas.width = r.width * dpr; st.canvas.height = r.height * dpr;
    st.canvas.style.width = `${r.width}px`; st.canvas.style.height = `${r.height}px`;
    st.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  // Zoom and centre so every figure is in view.
  function fit() {
    if (!st.nodes.length) return;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const n of st.nodes) { x0 = Math.min(x0, n.x - n.r); x1 = Math.max(x1, n.x + n.r); y0 = Math.min(y0, n.y - n.r); y1 = Math.max(y1, n.y + n.r + 14); }
    st.k = Math.max(0.35, Math.min(1.6, Math.min((st.w - 60) / (x1 - x0 || 1), (st.h - 60) / (y1 - y0 || 1))));
    st.px = -((x0 + x1) / 2) * st.k; st.py = -((y0 + y1) / 2) * st.k;
  }
  const toScreen = (x, y) => [st.w / 2 + st.px + x * st.k, st.h / 2 + st.py + y * st.k];
  const toWorld = (sx, sy) => [(sx - st.w / 2 - st.px) / st.k, (sy - st.h / 2 - st.py) / st.k];

  // ---------------------------------------------------------------- physics
  function step() {
    const N = st.nodes;
    for (let i = 0; i < N.length; i++) {
      const a = N[i];
      for (let j = i + 1; j < N.length; j++) {
        const b = N[j];
        const dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy + 0.01;
        if (d2 > 62500) continue;
        const d = Math.sqrt(d2), min = (a.r + b.r) * 1.7;
        const f = Math.min(3, 1100 / d2 + (d < min ? (min - d) * 0.1 : 0)) / d;
        a.vx -= dx * f; a.vy -= dy * f; b.vx += dx * f; b.vy += dy * f;
      }
    }
    for (const e of st.edges) {
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
      const k = ((d - (REST[e.kind] || 100)) / d) * 0.018;
      e.a.vx += dx * k; e.a.vy += dy * k; e.b.vx -= dx * k; e.b.vy -= dy * k;
    }
    for (const n of N) {
      // Each node is drawn softly to its ring around its lobe's centre: agents in the middle, knowledge further out.
      const dx = n.x - n.c[0], dy = n.y - n.c[1], d = Math.sqrt(dx * dx + dy * dy) || 1;
      const k = ((SHELL[n.type] - d) / d) * 0.004;
      n.vx += dx * k; n.vy += dy * k;
      if (st.drag && st.drag.n === n) continue;
      n.vx *= 0.84; n.vy *= 0.84;
      const sp = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
      if (sp > 18) { n.vx *= 18 / sp; n.vy *= 18 / sp; }
      n.x += n.vx; n.y += n.vy;
    }
  }

  // ---------------------------------------------------------------- drawing
  function draw(now) {
    const { ctx, w, h, colors, k } = st;
    ctx.clearRect(0, 0, w, h);
    // The plane: a dot grid that pans and zooms with the map, and a soft glow under each lobe.
    const sp = 28 * k;
    if (sp > 9) {
      const ox = ((st.w / 2 + st.px) % sp + sp) % sp, oy = ((st.h / 2 + st.py) % sp + sp) % sp;
      ctx.fillStyle = `rgba(${colors.muted.join(',')},${st.light ? 0.16 : 0.09})`;
      for (let gx = ox; gx < w; gx += sp) for (let gy = oy; gy < h; gy += sp) ctx.fillRect(gx - 0.6, gy - 0.6, 1.2, 1.2);
    }
    const lobes = {};
    for (const n of st.nodes) if (n.team && n.type !== 'project' && n.type !== 'job') { const l = (lobes[n.team] = lobes[n.team] || [0, 0, 0]); l[0] += n.x; l[1] += n.y; l[2]++; }
    for (const l of Object.values(lobes)) {
      const [sx, sy] = toScreen(l[0] / l[2], l[1] / l[2]), rad = 260 * k;
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, rad);
      g.addColorStop(0, `rgba(${colors.gold.join(',')},${st.light ? 0.08 : 0.06})`); g.addColorStop(1, `rgba(${colors.gold.join(',')},0)`);
      ctx.fillStyle = g; ctx.fillRect(sx - rad, sy - rad, rad * 2, rad * 2);
    }
    for (const n of st.nodes) {
      const [sx, sy] = toScreen(n.x, n.y);
      const target = n.id === st.hover || (st.drag && st.drag.n === n) ? 1 : 0;
      n.lift += (target - n.lift) * (st.reduced ? 1 : 0.18);
      const grow = n.born ? Math.max(0, Math.min(1, (now - n.born) / 420)) : 1;
      const pop = grow >= 1 ? 1 : 1 + 2.2 * Math.pow(grow - 1, 3) + 1.2 * Math.pow(grow - 1, 2); // ease out with a small overshoot
      n.p = { sx, sy, r: n.r * k * pop * (1 + 0.14 * n.lift), up: 0, show: grow > 0 };
    }
    const focus = st.hover || st.sel;
    const near = new Set();
    if (focus) { near.add(focus); for (const e of st.edges) { if (e.a.id === focus) near.add(e.b.id); if (e.b.id === focus) near.add(e.a.id); } }
    const q = st.q;
    const match = (n) => !q || `${n.label} ${n.sub || ''}`.toLowerCase().includes(q);
    // Links run centre to centre, under the sprites.
    ctx.lineCap = 'round';
    const ink = st.light ? '60,50,35' : '170,175,190';
    for (const e of st.edges) {
      if (!e.a.p.show || !e.b.p.show) continue;
      const on = focus && (e.a.id === focus || e.b.id === focus);
      ctx.strokeStyle = on ? `rgba(${colors.gold.join(',')},0.85)` : `rgba(${ink},${focus ? 0.05 : 0.14})`;
      ctx.lineWidth = on ? 1.6 : 0.9;
      ctx.beginPath(); ctx.moveTo(e.a.p.sx, e.a.p.sy); ctx.lineTo(e.b.p.sx, e.b.p.sy); ctx.stroke();
    }
    if (!st.reduced) {
      if (st.active.length && Math.random() < 0.22) st.pulses.push({ e: st.active[(Math.random() * st.active.length) | 0], t: 0, v: 0.008 + Math.random() * 0.012 });
      ctx.globalCompositeOperation = st.light ? 'source-over' : 'lighter';
      st.pulses = st.pulses.filter((p) => (p.t += p.v) < 1);
      for (const p of st.pulses) {
        const x = p.e.a.p.sx + (p.e.b.p.sx - p.e.a.p.sx) * p.t, y = p.e.a.p.sy + (p.e.b.p.sy - p.e.a.p.sy) * p.t, rad = 5 * Math.min(1.4, k);
        const gg = ctx.createRadialGradient(x, y, 0, x, y, rad);
        gg.addColorStop(0, `rgba(${colors.gold.join(',')},0.9)`); gg.addColorStop(1, `rgba(${colors.gold.join(',')},0)`);
        ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    // Sprites, small ones first so leads and big pages sit on top; the hovered and selected ones last.
    const front = (n) => (n.id === st.hover || n.id === st.sel ? 1e6 : 0) + n.r;
    const order = st.nodes.filter((n) => n.p.show && n.p.r > 0.3).sort((a, b) => front(a) - front(b));
    const gold = (a) => `rgba(${colors.gold.join(',')},${a})`;
    for (const n of order) {
      const { sx, sy, r } = n.p, dim = (focus && !near.has(n.id)) || (q && !match(n)), img = st.sprites[n.type];
      const round = BT[n.type].badge === 'circle', glow = (n.id === st.sel || n.id === st.hover) && !dim;
      const outline = (pad) => { if (round) { ctx.beginPath(); ctx.arc(sx, sy, r + pad, 0, Math.PI * 2); } else tilePath(ctx, sx - r - pad, sy - r - pad, 2 * (r + pad), (r + pad) * 0.52); };
      ctx.globalAlpha = dim ? 0.2 : 1;
      if (img.complete && img.naturalWidth) {
        ctx.shadowColor = glow ? gold(0.8) : `rgba(0,0,0,${st.light ? 0.2 : 0.5})`; ctx.shadowBlur = glow ? 18 : 7; ctx.shadowOffsetY = glow ? 0 : 2;
        ctx.drawImage(img, sx - r, sy - r, 2 * r, 2 * r);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      }
      if (n.type === 'agent' && n.resident) { ctx.strokeStyle = gold(0.95); ctx.lineWidth = 2; outline(3.5); ctx.stroke(); }
      if (n.carried) { ctx.strokeStyle = gold(0.7); ctx.lineWidth = 1.4; ctx.setLineDash([3, 3]); outline(3.5); ctx.stroke(); ctx.setLineDash([]); }
      if (n.id === st.sel) { ctx.strokeStyle = gold(1); ctx.lineWidth = 2.5; outline(6.5); ctx.stroke(); }
    }
    ctx.globalAlpha = 1;
    // Labels on top of everything: below the figure, or above it when that spot is taken; leads first, then projects.
    ctx.textAlign = 'center'; ctx.lineJoin = 'round';
    const placed = [], hit = (b) => placed.some((p) => b[0] < p[2] && b[2] > p[0] && b[1] < p[3] && b[3] > p[1]);
    const rank = (n) => (n.type === 'agent' && n.resident ? 0 : n.id === focus ? 1 : n.type === 'project' ? 2 : 3);
    for (const n of order.filter((n) => !((focus && !near.has(n.id)) || (q && !match(n)))).sort((a, b) => rank(a) - rank(b))) {
      if (!((n.type === 'agent' && n.resident) || n.type === 'project' || near.has(n.id) || (q && match(n)) || k > 1.5)) continue;
      const { sx, sy, r } = n.p, big = n.type === 'agent' && n.resident;
      ctx.font = `${big ? 600 : 500} ${big ? 12.5 : 11.5}px Inter, system-ui, sans-serif`;
      const t = n.label.length > 26 ? n.label.slice(0, 25) + '…' : n.label, tw = ctx.measureText(t).width / 2 + 3;
      const spot = [sy + r + 16, sy - r - 8].map((y) => [sx - tw, y - 11, sx + tw, y + 3]).find((b) => !hit(b));
      if (!spot) continue;
      placed.push(spot);
      ctx.lineWidth = 3; ctx.strokeStyle = colors.bg; ctx.fillStyle = colors.text;
      ctx.strokeText(t, sx, spot[3] - 3); ctx.fillText(t, sx, spot[3] - 3);
    }
  }
  function loop() {
    if (!st || !st.canvas || !document.body.contains(st.canvas)) { if (st && st.canvas) stop(); return; }
    step();
    draw(performance.now());
    st.raf = requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------- interaction
  function pick(mx, my) {
    let best = null;
    for (const n of st.nodes) {
      if (!n.p || !n.p.show) continue;
      const r = n.p.r + 5, dx = mx - n.p.sx, dy = my - (n.p.sy - n.p.up);
      if (dx * dx + dy * dy <= r * r && (!best || n.p.sy > best.p.sy)) best = n;
    }
    return best;
  }
  function wire() {
    const c = st.canvas;
    const pos = (ev) => { const r = c.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
    c.onmousedown = (ev) => {
      const [mx, my] = pos(ev);
      const n = pick(mx, my);
      if (n) { const [wx, wy] = toWorld(mx, my); st.drag = { n, moved: false, start: [mx, my], grab: [n.x - wx, n.y - wy], hist: [] }; c.style.cursor = 'grabbing'; }
      else st.pan = { x: ev.clientX, y: ev.clientY, px: st.px, py: st.py, moved: false };
      ev.preventDefault();
    };
    st.move = (ev) => {
      if (!st || !st.canvas) return;
      const [mx, my] = pos(ev);
      if (st.drag) {
        const n = st.drag.n, [wx, wy] = toWorld(mx, my), x = wx + st.drag.grab[0], y = wy + st.drag.grab[1];
        st.drag.hist.push([x - n.x, y - n.y]); if (st.drag.hist.length > 4) st.drag.hist.shift();
        n.x = x; n.y = y; n.vx = n.vy = 0;
        st.drag.moved = st.drag.moved || Math.abs(mx - st.drag.start[0]) + Math.abs(my - st.drag.start[1]) > 3;
        return;
      }
      if (st.pan) {
        st.px = st.pan.px + ev.clientX - st.pan.x; st.py = st.pan.py + ev.clientY - st.pan.y;
        st.pan.moved = st.pan.moved || Math.abs(ev.clientX - st.pan.x) + Math.abs(ev.clientY - st.pan.y) > 3;
        return;
      }
      if (ev.target !== c) { if (st.hover) { st.hover = null; st.onHover && st.onHover(null); } return; }
      const n = pick(mx, my);
      const id = n ? n.id : null;
      if (id !== st.hover) { st.hover = id; c.style.cursor = id ? 'pointer' : 'grab'; }
      st.onHover && st.onHover(n, ev);
    };
    st.up = () => {
      if (!st) return;
      if (st.drag) {
        const n = st.drag.n;
        if (!st.drag.moved) { st.sel = n.id; st.onSelect && st.onSelect(n.id); }
        else { const h = st.drag.hist; if (h.length) { n.vx = h.reduce((a, d) => a + d[0], 0) / h.length; n.vy = h.reduce((a, d) => a + d[1], 0) / h.length; } }
        st.drag = null; st.canvas.style.cursor = 'grab';
      } else if (st.pan) {
        if (!st.pan.moved) { st.sel = null; st.onSelect && st.onSelect(null); }
        st.pan = null;
      }
    };
    window.addEventListener('mousemove', st.move);
    window.addEventListener('mouseup', st.up);
    window.addEventListener('resize', resize);
    c.onwheel = (ev) => {
      ev.preventDefault();
      const [mx, my] = pos(ev), [wx, wy] = toWorld(mx, my);
      st.k = Math.max(0.3, Math.min(4, st.k * (ev.deltaY < 0 ? 1.12 : 0.89)));
      st.px = mx - st.w / 2 - wx * st.k; st.py = my - st.h / 2 - wy * st.k;
    };
    c.ondblclick = () => fit();
  }
  return {
    start,
    stop,
    select: (id) => { if (st) st.sel = id; },
    search: (q) => { if (st) st.q = String(q || '').trim().toLowerCase(); },
    positions: () => (st && st.nodes ? Object.fromEntries(st.nodes.map((n) => [n.id, [n.x, n.y]])) : null),
    // Where a node is on the canvas and what it links to (used by scripts/ui-check.js to test dragging).
    screenOf: (id) => { const n = st && st.byId && st.byId.get(id); return n && n.p ? { x: n.p.sx, y: n.p.sy - n.p.up, links: st.edges.filter((e) => e.a === n || e.b === n).map((e) => (e.a === n ? e.b.id : e.a.id)) } : null; },
  };
})();
