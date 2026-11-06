'use strict';
// Hardware while jobs run: CPU, memory, temperature and (with an NVIDIA card) GPU, for the computer and for each job.
// A job's share is everything in the process groups working on it: its agents' claude processes (and the tools they
// start), the terminal commands the office runs for it and its project checks. Sampled every 2 seconds while any job
// has processes, every 15 seconds otherwise (a cheap look every 2 seconds notices a job starting); nothing is spawned for the CPU or memory figures (only nvidia-smi, when
// present, every 6 seconds). A job's samples are saved to data/hardware/<job id>.json when it ends, and t.hw holds
// its peaks. Linux reads /proc; macOS uses ps; elsewhere only the computer's figures are kept.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawnSync } = require('child_process');

const BUSY_MS = 2000, IDLE_MS = 15000, MAX_POINTS = 1800, SYSTEM_KEEP_MS = 15 * 60000;
const PROC = fs.existsSync('/proc/self/stat');
const MAC = process.platform === 'darwin';

function install(ctx) {
  const { DATA, agents, procs, procOfCommand, procOfCheck, ticketOfAgent, tickets } = ctx;
  const DIR = path.join(DATA, 'hardware');
  const NCPU = Math.max(1, os.cpus().length);
  const TICK = PROC ? (Number(spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).stdout) || 100) : 100;
  const PAGE = PROC ? (Number(spawnSync('getconf', ['PAGESIZE'], { encoding: 'utf8' }).stdout) || 4096) : 4096;
  const HAS_GPU = spawnSync('nvidia-smi', ['-L'], { encoding: 'utf8', timeout: 4000 }).status === 0;

  const system = [];       // [{ t, cpu, mem, memMb, temp, gpu, gpuMem }]
  const jobs = new Map();  // ticket id -> { t0, cols, rows: [[sec, jobCpu, sysCpu, jobMemMb, sysMemPct, temp, gpu]], peak }
  let lastCpu = cpuTimes(), lastProc = new Map(), lastAt = Date.now(), gpu = null, gpuAt = 0, timer = null;

  function cpuTimes() { return os.cpus().reduce((a, c) => { const t = c.times; a.idle += t.idle; a.total += t.user + t.nice + t.sys + t.idle + t.irq; return a; }, { idle: 0, total: 0 }); }

  function memory() {
    const total = os.totalmem();
    if (PROC) {
      try { const m = /MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8')); if (m) { const used = total - Number(m[1]) * 1024; return { pct: (used / total) * 100, mb: used / 1048576 }; } } catch {}
    }
    const used = total - os.freemem();
    return { pct: (used / total) * 100, mb: used / 1048576 };
  }

  // The hottest CPU-ish sensor in °C, or null.
  function temperature() {
    if (!PROC) return null;
    let best = null;
    const take = (v) => { if (v > 0 && v < 130 && (best === null || v > best)) best = v; };
    try {
      for (const h of fs.readdirSync('/sys/class/hwmon')) {
        const dir = path.join('/sys/class/hwmon', h);
        let name = '';
        try { name = fs.readFileSync(path.join(dir, 'name'), 'utf8').trim(); } catch {}
        if (!/coretemp|k10temp|zenpower|cpu|acpitz|soc|thinkpad/i.test(name)) continue;
        for (const f of fs.readdirSync(dir)) if (/^temp\d+_input$/.test(f)) { try { take(Number(fs.readFileSync(path.join(dir, f), 'utf8')) / 1000); } catch {} }
      }
    } catch {}
    if (best === null) {
      try { for (const z of fs.readdirSync('/sys/class/thermal')) if (z.startsWith('thermal_zone')) { try { take(Number(fs.readFileSync(path.join('/sys/class/thermal', z, 'temp'), 'utf8')) / 1000); } catch {} } } catch {}
    }
    return best === null ? null : Math.round(best * 10) / 10;
  }

  function pollGpu() {
    if (!HAS_GPU || Date.now() - gpuAt < 6000) return;
    gpuAt = Date.now();
    execFile('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used,temperature.gpu', '--format=csv,noheader,nounits'], { timeout: 4000 }, (err, out) => {
      if (err) return;
      const rows = String(out).trim().split('\n').map((l) => l.split(',').map((x) => Number(x.trim())));
      if (rows.length && rows[0].length >= 3) gpu = { util: Math.max(...rows.map((r) => r[0])), memMb: rows.reduce((n, r) => n + r[1], 0), temp: Math.max(...rows.map((r) => r[2])) };
    });
  }

  // Every process: pid -> { pgid, cpuSec (cumulative), rssMb }.
  function processes(cb) {
    if (PROC) {
      // Read asynchronously, so a busy computer's hundreds of processes never hold up the office.
      fs.promises.readdir('/proc').then(async (names) => {
        const out = new Map();
        const list = names.filter((d) => /^\d+$/.test(d));
        for (let i = 0; i < list.length; i += 64) {
          await Promise.all(list.slice(i, i + 64).map((pid) => fs.promises.readFile(`/proc/${pid}/stat`, 'utf8').then((st) => {
            const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
            // after the name: state(0) ppid(1) pgrp(2) ... utime(11) stime(12) ... rss(21)
            out.set(Number(pid), { pgid: Number(f[2]), cpuSec: (Number(f[11]) + Number(f[12])) / TICK, rssMb: (Number(f[21]) * PAGE) / 1048576 });
          }, () => {})));
        }
        cb(out);
      }, () => cb(new Map()));
      return;
    }
    if (!MAC) return cb(new Map());
    execFile('ps', ['-A', '-o', 'pid=,pgid=,rss=,time='], { timeout: 4000, maxBuffer: 8 << 20 }, (err, txt) => {
      const out = new Map();
      if (!err) for (const line of String(txt).split('\n')) {
        const m = line.trim().split(/\s+/);
        if (m.length < 4) continue;
        const parts = m[3].split(/[-:]/).map(Number);
        let sec = 0;
        for (const p of parts) sec = sec * 60 + p;
        if (m[3].includes('-')) sec = parts[0] * 86400 + parts.slice(1).reduce((a, p) => a * 60 + p, 0);
        out.set(Number(m[0]), { pgid: Number(m[1]), cpuSec: sec, rssMb: Number(m[2]) / 1024 });
      }
      cb(out);
    });
  }

  // Which process groups work for which job right now.
  function groupsByJob() {
    const by = new Map();
    const add = (tid, pid) => { if (!tid || !pid) return; if (!by.has(tid)) by.set(tid, new Set()); by.get(tid).add(pid); };
    for (const a of agents.values()) {
      const child = procs.get(a.id);
      if (!child || !child.pid || child.exitCode !== null) continue;
      const t = ticketOfAgent(a);
      if (t && ['open', 'paused'].includes(t.status)) add(t.id, child.pid);
    }
    for (const t of tickets.values()) {
      if (!['open', 'paused'].includes(t.status)) continue;
      for (const c of t.commands || []) if (c.status === 'running') { const ch = procOfCommand(c.id); if (ch) add(t.id, ch.pid); }
      const v = procOfCheck(t.id);
      if (v) add(t.id, v.pid);
    }
    return by;
  }

  function sample() {
    const at = Date.now();
    // Every 2 seconds: is anything working for a job? With nothing working, the computer is sampled every 15 seconds.
    const groups = groupsByJob();
    if (!groups.size && !jobs.size && system.length && at - system[system.length - 1].t < IDLE_MS) return schedule(BUSY_MS);
    const cpuNow = cpuTimes();
    const dTotal = cpuNow.total - lastCpu.total;
    const sysCpu = dTotal > 0 ? Math.max(0, Math.min(100, (1 - (cpuNow.idle - lastCpu.idle) / dTotal) * 100)) : 0;
    lastCpu = cpuNow;
    const mem = memory();
    const temp = temperature();
    pollGpu();
    processes((list) => {
      const dt = Math.max(0.5, (at - lastAt) / 1000);
      lastAt = at;
      const perGroup = new Map();
      for (const [pid, p] of list) {
        const prev = lastProc.get(pid);
        const d = prev ? Math.max(0, p.cpuSec - prev.cpuSec) : 0;
        const g = perGroup.get(p.pgid) || { cpuSec: 0, rssMb: 0 };
        g.cpuSec += d; g.rssMb += p.rssMb;
        perGroup.set(p.pgid, g);
      }
      lastProc = list;
      const s = { t: at, cpu: round(sysCpu), mem: round(mem.pct), memMb: Math.round(mem.mb), temp, gpu: gpu ? gpu.util : null, gpuMem: gpu ? gpu.memMb : null };
      system.push(s);
      while (system.length && system[0].t < at - SYSTEM_KEEP_MS) system.shift();
      for (const [tid, pids] of groups) {
        let cpuSec = 0, rss = 0;
        for (const pg of pids) { const g = perGroup.get(pg); if (g) { cpuSec += g.cpuSec; rss += g.rssMb; } }
        const jobCpu = Math.min(100, (cpuSec / dt / NCPU) * 100);
        record(tid, at, [round(jobCpu), s.cpu, Math.round(rss), s.mem, temp, s.gpu]);
      }
      // A job that ended (done, failed or stopped): save its samples now and let it go from memory.
      for (const tid of [...jobs.keys()]) { const t = tickets.get(tid); if (!t || !['open', 'paused'].includes(t.status)) { persist(tid); jobs.delete(tid); } }
      schedule(BUSY_MS);
    });
  }

  const round = (x) => Math.round(x * 10) / 10;

  function record(tid, at, vals) {
    let J = jobs.get(tid);
    if (!J) {
      J = load(tid) || { t0: at, rows: [], peak: { cpu: 0, memMb: 0, temp: null, gpu: null }, cpuSum: 0, n: 0 };
      jobs.set(tid, J);
    }
    J.rows.push([Math.round((at - J.t0) / 1000), ...vals]);
    const [cpu, , memMb, , temp, g] = vals;
    J.peak.cpu = Math.max(J.peak.cpu, cpu);
    J.peak.memMb = Math.max(J.peak.memMb, memMb);
    if (temp != null) J.peak.temp = Math.max(J.peak.temp || 0, temp);
    if (g != null) J.peak.gpu = Math.max(J.peak.gpu || 0, g);
    J.cpuSum += cpu; J.n++;
    // Long jobs: halve the resolution (keeping each pair's higher value) instead of dropping the start.
    if (J.rows.length > MAX_POINTS) {
      const out = [];
      for (let i = 0; i < J.rows.length; i += 2) {
        const a = J.rows[i], b = J.rows[i + 1];
        out.push(b ? a.map((v, k) => (k === 0 ? a[0] : v == null || b[k] == null ? v ?? b[k] : Math.max(v, b[k]))) : a);
      }
      J.rows = out;
    }
    const t = tickets.get(tid);
    if (t) t.hw = summaryOf(J);
  }

  function summaryOf(J) {
    const last = J.rows[J.rows.length - 1];
    return { peakCpu: J.peak.cpu, avgCpu: J.n ? round(J.cpuSum / J.n) : 0, peakMemMb: J.peak.memMb, peakTemp: J.peak.temp, peakGpu: J.peak.gpu, seconds: last ? last[0] : 0, samples: J.n };
  }

  const fileOf = (tid) => path.join(DIR, `${String(tid).replace(/[^\w-]/g, '')}.json`);
  function load(tid) { try { return JSON.parse(fs.readFileSync(fileOf(tid), 'utf8')); } catch { return null; } }
  function persist(tid) {
    const J = jobs.get(tid);
    if (!J) return;
    try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(fileOf(tid), JSON.stringify(J)); } catch {}
  }

  // Jobs that ended: save their samples and let them go from memory.
  function sweep() {
    for (const tid of [...jobs.keys()]) {
      const t = tickets.get(tid);
      persist(tid);
      if (!t || !['open', 'paused'].includes(t.status)) jobs.delete(tid);
    }
  }

  function schedule(ms) { clearTimeout(timer); timer = setTimeout(sample, ms); timer.unref(); }

  const COLS = ['sec', 'jobCpu', 'sysCpu', 'jobMemMb', 'sysMemPct', 'temp', 'gpu'];
  function view() {
    return { platform: process.platform, cpus: NCPU, memTotalMb: Math.round(os.totalmem() / 1048576), perJob: PROC || MAC, gpu: HAS_GPU,
      temp: system.some((s) => s.temp != null), now: system[system.length - 1] || null, series: system.filter((s, i) => i % 2 === 0 || i === system.length - 1) };
  }
  function jobView(tid) {
    const J = jobs.get(tid) || load(tid);
    const t = tickets.get(tid);
    if (!t) return { error: 'No such job.' };
    return { id: tid, t0: J ? J.t0 : null, cols: COLS, rows: J ? J.rows : [], summary: J ? summaryOf(J) : null, live: jobs.has(tid) && ['open', 'paused'].includes(t.status),
      cpus: NCPU, memTotalMb: Math.round(os.totalmem() / 1048576), perJob: PROC || MAC, gpu: HAS_GPU };
  }

  async function route(req, res, url, p, body, json) {
    if (p === '/api/hardware' && req.method === 'GET') return json(res, 200, view()), true;
    const m = p.match(/^\/api\/hardware\/job\/([\w-]+)$/);
    if (m && req.method === 'GET') { const r = jobView(m[1]); return json(res, r.error ? 404 : 200, r), true; }
    return false;
  }

  // AGENTOS_HARDWARE=0 turns the sampler off (the API then reports nothing).
  if (process.env.AGENTOS_HARDWARE !== '0') { schedule(1000); setInterval(sweep, 60000).unref(); }
  return { route, view, jobView, sweep, persist, sample };
}

module.exports = { install };
