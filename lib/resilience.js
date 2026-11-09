'use strict';
// Temporary API failures. A turn that ends in a transient error (overloaded, 5xx, network) is tried again with growing
// waits instead of failing the job. When several fail close together a circuit breaker stops new turns, so an outage
// does not burn through the queue; after a cool-down one turn goes through as a test, and its result closes the breaker
// or opens it again for longer. Usage limits are a different matter and stay with lib/limits.js.

const TRANSIENT = /\b(overloaded|api error: 5\d\d|internal server error|bad gateway|service unavailable|gateway time-?out|econnreset|econnrefused|etimedout|enotfound|eai_again|socket hang up|fetch failed|connection error|network error|529)\b/i;
const MAX_ERROR_TEXT = 800; // a long answer that happens to mention one of these is not an API failure
const isTransient = (text) => { const s = String(text || ''); return s.length <= MAX_ERROR_TEXT && TRANSIENT.test(s); };

const TRIP_AFTER = 4, WINDOW_MS = 120000, COOL_MS = 60000, MAX_COOL_MS = 900000, PROBE_STALE_MS = 300000;

function install(ctx) {
  const { broadcast, kick, now } = ctx;
  const delay = ctx.retryDelay || ((n) => Math.min(120000, 15000 * 2 ** n) + Math.floor(Math.random() * 5000));
  const B = { state: 'closed', fails: [], openedAt: null, cool: COOL_MS, reopenAt: null, probing: null, why: null, trips: 0 };
  let timer = null;

  function open(why) {
    B.state = 'open';
    B.openedAt = now();
    B.reopenAt = now() + B.cool;
    B.probing = null;
    B.why = String(why || '').slice(0, 200);
    B.trips++;
    clearTimeout(timer);
    timer = setTimeout(() => kick(), B.cool + 50);
    if (timer.unref) timer.unref();
    broadcast({ type: 'notify', kind: 'warn', title: 'The AI service looks down: new work is paused', text: `Trying again in ${Math.round(B.cool / 1000)} seconds. ${B.why}` });
  }

  // May a new turn start now?
  function admit() {
    if (B.state === 'closed') return true;
    if (now() < B.reopenAt) return false;
    if (B.probing && now() - B.probing < PROBE_STALE_MS) return false;
    B.state = 'testing';
    B.probing = now();
    return true;
  }
  function success() {
    B.fails = [];
    if (B.state === 'closed') return;
    const was = B.state;
    Object.assign(B, { state: 'closed', probing: null, cool: COOL_MS, why: null });
    if (was === 'testing') broadcast({ type: 'notify', kind: 'info', title: 'The AI service is back', text: 'Work has resumed.' });
    kick();
  }
  function failure(why) {
    if (B.state === 'testing') { B.cool = Math.min(MAX_COOL_MS, B.cool * 2); return open(why); }
    if (B.state === 'open') return undefined;
    B.fails = B.fails.filter((t) => now() - t < WINDOW_MS);
    B.fails.push(now());
    if (B.fails.length >= TRIP_AFTER) return open(why);
    return undefined;
  }

  return { admit, delay, failure, isTransient, success, view: () => ({ state: B.state, why: B.why, reopenAt: B.state === 'closed' ? null : B.reopenAt, trips: B.trips, recentFailures: B.fails.length }) };
}

module.exports = { install, isTransient };
