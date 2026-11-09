'use strict';
// The Brain's Meaning view: which pieces of knowledge resemble each other. With an embedding model in Ollama on this
// computer it compares meaning (vectors kept in data/brain-embeddings.json, recomputed only when a file changes);
// without one it compares shared rare words (TF-IDF). Only the view uses this: agents still find things as plain text.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const NEIGHBOURS = 4;
const FLOOR = { embeddings: 0.5, words: 0.08 };
const MAX_CHARS = 6000;
const CACHE_MS = 60000;
const NOT_CONTENT = new Set(['agent', 'job', 'project']);

const words = (s) => String(s).toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) || [];
const normalise = (v) => {
  let sum = 0;
  for (const x of v.values()) sum += x * x;
  const len = Math.sqrt(sum) || 1;
  for (const [k, x] of v) v.set(k, x / len);
  return v;
};
function cosine(a, b) {
  if (a.size > b.size) [a, b] = [b, a];
  let s = 0;
  for (const [k, x] of a) { const y = b.get(k); if (y) s += x * y; }
  return s;
}

// TF-IDF vectors for a list of texts: a word common to nearly everything counts for almost nothing.
function wordVectors(texts) {
  const counts = texts.map((t) => { const c = new Map(); for (const w of words(t)) c.set(w, (c.get(w) || 0) + 1); return c; });
  const df = new Map();
  for (const c of counts) for (const w of c.keys()) df.set(w, (df.get(w) || 0) + 1);
  return counts.map((c) => normalise(new Map([...c].map(([w, n]) => [w, (1 + Math.log(n)) * Math.log(1 + texts.length / df.get(w))]))));
}
const denseVector = (arr) => normalise(new Map(arr.map((x, i) => [i, x])));

// Each item's closest neighbours above the floor, as undirected links, strongest first.
function topLinks(ids, vectors, floor, k = NEIGHBOURS) {
  const best = new Map();
  ids.forEach((id, i) => {
    const near = [];
    ids.forEach((other, j) => { if (i !== j) { const score = cosine(vectors[i], vectors[j]); if (score >= floor) near.push([other, score]); } });
    near.sort((a, b) => b[1] - a[1]);
    for (const [other, score] of near.slice(0, k)) best.set(id < other ? `${id}\n${other}` : `${other}\n${id}`, score);
  });
  return [...best].map(([key, score]) => { const [from, to] = key.split('\n'); return { from, to, score: Math.round(score * 1000) / 1000 }; }).sort((a, b) => b.score - a.score);
}

function install({ DATA, knowledge, ollamaBase, now }) {
  const FILE = path.join(DATA, 'brain-embeddings.json');
  let cache = null;

  async function embeddingModel() {
    const r = await fetch(`${ollamaBase()}/api/tags`, { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    const m = ((j && j.models) || []).map((x) => x.name).find((n) => /embed|bge-|minilm/i.test(n));
    return m || null;
  }

  // One unit vector per item; unchanged files come from the saved vectors.
  async function embed(model, items) {
    let saved = {};
    try { const f = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (f.model === model) saved = f.items || {}; } catch {}
    const hash = (t) => crypto.createHash('sha1').update(t).digest('hex');
    const todo = items.filter((x) => !saved[x.id] || saved[x.id].h !== hash(x.text));
    for (let i = 0; i < todo.length; i += 32) {
      const batch = todo.slice(i, i + 32);
      const r = await fetch(`${ollamaBase()}/api/embed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, input: batch.map((x) => x.text) }), signal: AbortSignal.timeout(120000) });
      const j = await r.json();
      if (!r.ok || !Array.isArray(j.embeddings) || j.embeddings.length !== batch.length) throw new Error((j && j.error) || `embedding failed (${r.status})`);
      batch.forEach((x, n) => { saved[x.id] = { h: hash(x.text), v: j.embeddings[n] }; });
    }
    const kept = Object.fromEntries(items.map((x) => [x.id, saved[x.id]]));
    if (todo.length || Object.keys(saved).length !== items.length) fs.writeFileSync(FILE, JSON.stringify({ model, items: kept }));
    return items.map((x) => denseVector(kept[x.id].v));
  }

  async function build() {
    const items = [];
    for (const n of knowledge().nodes) {
      if (NOT_CONTENT.has(n.type) || !n.file) continue;
      let text = '';
      try { if (fs.statSync(n.file).isFile()) text = fs.readFileSync(n.file, 'utf8').slice(0, MAX_CHARS).trim(); } catch {}
      if (text) items.push({ id: n.id, text });
    }
    const ids = items.map((x) => x.id);
    let model = null, note = null;
    try { model = await embeddingModel(); } catch {}
    if (model) {
      try { return { at: now(), engine: 'embeddings', model, ids, links: topLinks(ids, await embed(model, items), FLOOR.embeddings) }; }
      catch (e) { note = `Ollama could not embed these: ${e.message}`; }
    }
    return { at: now(), engine: 'words', model: null, note, ids, links: topLinks(ids, wordVectors(items.map((x) => x.text)), FLOOR.words) };
  }

  async function similarity(fresh) {
    if (!fresh && cache && now() - cache.at < CACHE_MS) return cache;
    return (cache = await build());
  }

  async function route(req, res, url, p, body, json) {
    if (req.method !== 'GET' || p !== '/api/brain/similarity') return false;
    json(res, 200, await similarity(url.searchParams.get('fresh') === '1'));
    return true;
  }

  return { route, similarity };
}

module.exports = { install, topLinks, wordVectors, denseVector };
