#!/usr/bin/env node
// Stdio MCP server for Claude Code sessions outside the office (your own terminal chats), so they can use what the
// office knows: its jobs, memories, team libraries, project memory and handoffs. Read-only, and no model is called:
// every tool reads facts the office gathers itself. Needs the office running (`./agentos`).
// Add it once with: claude mcp add --scope user agentos -- node ~/agent-workplace/lib/mcp-office.js
'use strict';
const http = require('http');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.WORKPLACE_PORT || 4747);
const TOKEN_FILE = path.join(__dirname, '..', 'data', 'app-token');
const MAX_TEXT = 30000;

// Read on every call: the token is made on the office's first start, which may come after this server's.
function get(p) {
  let token = '';
  try { token = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {}
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p, headers: { 'x-agentos-token': token } }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) return reject(new Error('the office refused the request (app token mismatch)'));
        try { resolve(JSON.parse(buf)); } catch { reject(new Error('Bad reply: ' + buf.slice(0, 200))); }
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error('the office took too long to answer')));
    req.on('error', reject);
  });
}

const tools = [
  {
    name: 'office_recall',
    description: 'Search what the Agentic OS office knows: earlier jobs (requests, answers, files changed, cost, ratings), ' +
      'the leads\' memories, team libraries and project handoffs, plus who is working on what right now. Use it before ' +
      're-deriving something the office may already have worked out, or when the user refers to past office work. ' +
      'Returns the matching facts; jobs are cited as #N (open one with office_job).',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'A question or keywords, e.g. "free spins recovery bug" or "why did #37 cost so much".' } },
      required: ['query'],
    },
  },
  {
    name: 'office_job',
    description: 'One office job in detail: what was asked, who worked on it with which model, files changed, the answer, the user\'s rating and a cost breakdown.',
    inputSchema: {
      type: 'object',
      properties: { n: { type: 'number', description: 'The job number (#N).' } },
      required: ['n'],
    },
  },
  {
    name: 'office_project',
    description: 'Where a project stands according to the office: its folder and checks, the user\'s standing instructions, ' +
      'decisions and known failures, its latest jobs, and for personal projects the handoff from the last session. ' +
      'Give a query to get only the memory entries matching it.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The project name (e.g. "EGT baseline") or a personal project\'s folder name. A wrong name lists the known ones.' },
        query: { type: 'string', description: 'Optional: keywords to filter the project\'s memory.' },
      },
      required: ['name'],
    },
  },
];

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function textResult(id, text, isError) {
  const s = String(text || '');
  send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '\n… (cut)' : s }], isError: !!isError } });
}

async function callTool(id, name, args) {
  try {
    if (name === 'office_recall') {
      const r = await get('/api/office/facts?q=' + encodeURIComponent(args.query || ''));
      if (r.error) return textResult(id, r.error, true);
      const cited = (r.sources || []).length ? `\n\nJobs to open with office_job: ${r.sources.map((s) => `#${s.n} ${s.title}`).join('; ')}` : '';
      return textResult(id, r.text + cited);
    }
    if (name === 'office_job') {
      const r = await get('/api/office/job?n=' + encodeURIComponent(args.n));
      return textResult(id, r.error || r.text, !!r.error);
    }
    if (name === 'office_project') {
      const r = await get(`/api/office/project?name=${encodeURIComponent(args.name || '')}&q=${encodeURIComponent(args.query || '')}`);
      return textResult(id, r.error || r.text, !!r.error);
    }
    textResult(id, 'Unknown tool: ' + name, true);
  } catch (e) {
    const down = /ECONNREFUSED/.test(e.message);
    textResult(id, down ? 'The Agentic OS office is not running. The user can start it with `./agentos` in ~/agent-workplace.' : 'Office error: ' + e.message, true);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: (params && params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'agentos', version: '1.0.0' } } });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools } });
  } else if (method === 'tools/call') {
    callTool(id, params.name, params.arguments || {});
  } else if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  }
});
