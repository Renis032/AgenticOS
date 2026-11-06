'use strict';
// The usage index (scripts/usage-index.js: every model call Claude Code made, parsed from its transcripts) runs in a
// worker thread: its queries read and add up hundreds of files and tens of thousands of calls, which on the server's
// own thread held up every request for seconds. The worker keeps the index's caches warm between queries; if it dies
// it is started again on the next query. call(name, ...args) returns a promise of what the function returns.
const path = require('path');
const { Worker, isMainThread, parentPort } = require('worker_threads');

const FUNCS = ['overview', 'calls', 'liveChats', 'cacheRead', 'csv', 'session'];

if (!isMainThread && parentPort) {
  const U = require(path.join(__dirname, '..', 'scripts', 'usage-index.js'));
  parentPort.on('message', async ({ id, fn, args }) => {
    try {
      if (!FUNCS.includes(fn)) throw new Error(`unknown function ${fn}`);
      parentPort.postMessage({ id, ok: true, value: await U[fn](...(args || [])) });
    } catch (e) { parentPort.postMessage({ id, ok: false, error: e.message }); }
  });
}

function create({ timeoutMs = 120000 } = {}) {
  let w = null, seq = 0;
  const waiting = new Map();
  function start() {
    w = new Worker(__filename);
    w.unref();
    w.on('message', (m) => { const p = waiting.get(m.id); if (!p) return; waiting.delete(m.id); clearTimeout(p.timer); if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error)); });
    const fail = (e) => { for (const p of waiting.values()) { clearTimeout(p.timer); p.reject(e); } waiting.clear(); w = null; };
    w.on('error', fail);
    w.on('exit', (code) => fail(new Error(`the usage worker stopped (${code})`)));
  }
  function call(fn, ...args) {
    if (!w) start();
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error('the usage index took too long')); }, timeoutMs);
      waiting.set(id, { resolve, reject, timer });
      w.postMessage({ id, fn, args });
    });
  }
  const api = Object.fromEntries(FUNCS.map((f) => [f, (...a) => call(f, ...a)]));
  return { ...api, call, stop: () => { if (w) w.terminate(); w = null; }, pending: () => waiting.size };
}

module.exports = { create, FUNCS };
