#!/usr/bin/env node
'use strict';
const https = require('https');
const http = require('http');
const { parseArgs, cli, fs, path } = require('./_util');
const os = require('os');

const KEY_FILES = [path.join(os.homedir(), '.config', 'agentos', 'openrouter.key'), path.join(os.homedir(), '.config', 'openrouter', 'key')];
const MODELS = ['haiku', 'sonnet', 'opus'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh'];

function apiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim();
  for (const f of KEY_FILES) { try { const k = fs.readFileSync(f, 'utf8').trim(); if (k) return k; } catch {} }
  return null;
}

function keyStatus() {
  if (process.env.OPENROUTER_API_KEY) return { present: true, where: 'OPENROUTER_API_KEY environment variable' };
  for (const f of KEY_FILES) { try { if (fs.readFileSync(f, 'utf8').trim()) return { present: true, where: f }; } catch {} }
  return { present: false, where: KEY_FILES[0] };
}

const SYSTEM = `You route tasks to one of three Claude models for an agent office. Pick the smallest model and lowest effort that will do the task well.
- haiku: mechanical, clear-cut steps (look up, list, extract, reformat, check spelling, short summaries).
- sonnet: focused analysis or writing with some judgement.
- opus: hard reasoning across many parts, root causes, design, implementation, code review, high stakes.
Effort: low | medium | high | xhigh (more effort = more thinking, slower, costlier).
Reply with JSON only: {"model":"haiku|sonnet|opus","effort":"low|medium|high|xhigh","why":"<12 words"}`;

function post(url, body, key, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = Buffer.from(JSON.stringify(body));
    const req = (u.protocol === 'http:' ? http : https).request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', timeout: timeoutMs,
      headers: { 'content-type': 'application/json', 'content-length': data.length, authorization: `Bearer ${key}`, 'x-title': 'Agentic OS' } }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => { try { const j = JSON.parse(buf); res.statusCode >= 400 ? reject(new Error((j.error && j.error.message) || `HTTP ${res.statusCode}`)) : resolve(j); } catch (e) { reject(new Error(`bad reply (HTTP ${res.statusCode})`)); } });
    });
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end(data);
  });
}

async function route({ task, role, capModel, timeoutMs }) {
  const key = apiKey();
  if (!key) throw new Error('no OpenRouter key');
  const started = Date.now();
  const url = process.env.JEV_URL || 'https://openrouter.ai/api/v1/chat/completions';
  const j = await post(url, {
    model: process.env.JEV_MODEL || 'typesafe/jev-router',
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: `${role ? `Role: ${role}\n` : ''}Task:\n${String(task || '').slice(0, 4000)}` }],
    max_tokens: 80, temperature: 0, response_format: { type: 'json_object' }, usage: { include: true },
  }, key, timeoutMs || 4000);
  if (j.error) throw new Error(j.error.message || 'OpenRouter error');
  const text = (((j.choices || [])[0] || {}).message || {}).content || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`no decision in reply: ${text.slice(0, 80)}`);
  const d = JSON.parse(m[0]);
  let model = String(d.model || '').toLowerCase().replace(/^.*(haiku|sonnet|opus).*$/, '$1');
  if (!MODELS.includes(model)) throw new Error(`unknown model "${d.model}"`);
  if (capModel && MODELS.indexOf(model) > MODELS.indexOf(capModel)) model = capModel;
  const effort = EFFORTS.includes(String(d.effort).toLowerCase()) ? String(d.effort).toLowerCase() : 'medium';
  return { model, effort, why: String(d.why || '').slice(0, 160), ms: Date.now() - started, costUsd: (j.usage && j.usage.cost) || 0, via: j.model || null, tokensIn: (j.usage && j.usage.prompt_tokens) || 0, tokensOut: (j.usage && j.usage.completion_tokens) || 0 };
}

function run(argv) {
  const { pos, opt } = parseArgs(argv);
  if (!pos.length) return `usage: jev "<task>" [--role <role>] [--cap opus]\nkey: ${keyStatus().present ? 'found (' + keyStatus().where + ')' : 'missing — put your OpenRouter key in ' + keyStatus().where}`;
  return route({ task: pos.join(' '), role: opt.role, capModel: opt.cap }).then((r) => `→ ${r.model}/${r.effort} in ${r.ms} ms, $${r.costUsd.toFixed(6)}${r.via ? ` (via ${r.via})` : ''}\n${r.why}`, (e) => `Jev unavailable: ${e.message}`);
}

module.exports = { route, keyStatus, apiKey };
if (require.main === module) Promise.resolve(run(process.argv.slice(2))).then((o) => process.stdout.write(o + '\n'));
