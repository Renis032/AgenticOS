#!/usr/bin/env node
// Hook installed in every agent process. PreToolUse: lets the workplace save a file before its first edit on a
// ticket (for review and undo). PostToolUse: reports file edits so agents touching the same file are warned,
// and delivers unread mail from colleagues into the agent's context.
'use strict';
const http = require('http');

const id = process.env.WORKPLACE_AGENT_ID;
const port = Number(process.env.WORKPLACE_PORT || 4747);
const token = (() => { try { return require('fs').readFileSync(require('path').join(__dirname, 'data', 'app-token'), 'utf8').trim(); } catch { return ''; } })();
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

function call(method, path, body) {
  return new Promise((resolve) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: '127.0.0.1', port, path, method, timeout: 3000,
      headers: { 'x-agentos-token': token, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) } }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve({}); } });
    });
    req.on('error', () => resolve({}));
    req.on('timeout', () => { req.destroy(); resolve({}); });
    req.end(data || undefined);
  });
}

function words(cmd) {
  return (cmd.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((w) => w.replace(/^(["'])(.*)\1$/, '$2'));
}

function wholeFileRewrite(file, content) {
  const fs = require('fs'), path = require('path'), crypto = require('crypto');
  let old;
  try { old = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const before = old.split('\n'), after = String(content || '').split('\n');
  if (before.length < 60 || after.length < 30) return null;
  const have = new Map();
  for (const l of before) have.set(l, (have.get(l) || 0) + 1);
  let same = 0;
  for (const l of after) { const n = have.get(l); if (n) { same++; have.set(l, n - 1); } }
  if (same / after.length < 0.6) return null;
  const mark = path.join(__dirname, 'data', 'usage', 'write-nudges', `${id}-${crypto.createHash('sha1').update(file).digest('hex').slice(0, 12)}`);
  try { if (Date.now() - fs.statSync(mark).mtimeMs < 15 * 60000) return null; } catch {}
  try { fs.mkdirSync(path.dirname(mark), { recursive: true }); fs.writeFileSync(mark, ''); } catch {}
  return { lines: after.length, changed: after.length - same };
}

function onceFor(kind, file) {
  const fs = require('fs'), path = require('path'), crypto = require('crypto');
  const mark = path.join(__dirname, 'data', 'usage', 'read-nudges', `${id}-${kind}-${crypto.createHash('sha1').update(file).digest('hex').slice(0, 12)}`);
  try { if (Date.now() - fs.statSync(mark).mtimeMs < 15 * 60000) return false; } catch {}
  try { fs.mkdirSync(path.dirname(mark), { recursive: true }); fs.writeFileSync(mark, ''); } catch {}
  return true;
}

function wholeFileRead(file, input) {
  if (input.offset != null || input.limit != null || input.pages) return null;
  if (/\.(png|jpe?g|gif|webp|pdf|ipynb)$/i.test(file)) return null;
  const fs = require('fs');
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (!st.isFile() || st.size < 20000) return null;
  let lines = 0;
  try { const b = fs.readFileSync(file); for (let i = 0; i < b.length; i++) if (b[i] === 10) lines++; } catch { return null; }
  if (lines < 500) return null;
  return onceFor('read', file) ? { lines, kb: Math.round(st.size / 1024) } : null;
}

function scriptFor(command) {
  const cdm = command.trim().match(/^cd\s+(\S+)\s*&&\s*/);
  const cd = cdm ? cdm[1].replace(/^(["'])(.*)\1$/, '$2') : null;
  let cmd = command.trim().slice(cdm ? cdm[0].length : 0);
  if (/[|;&`$<>]|\n/.test(cmd.replace(/2>\/dev\/null/g, ''))) return null;
  cmd = cmd.replace(/\s*2>\/dev\/null/g, '');
  const w = words(cmd);
  const at = (p) => (cd && !/^[/~]/.test(p) ? `${cd.replace(/\/$/, '')}/${p === '.' ? '' : p}`.replace(/\/$/, '') || '/' : p);
  const files = (from) => w.slice(from).filter((x) => !x.startsWith('-')).map(at);
  if (w[0] === 'wc' && files(1).length) return { name: 'count', args: files(1) };
  if (w[0] === 'xmllint' && w.includes('--noout') && files(1).length) return { name: 'xml-check', args: files(1) };
  if (w[0] === 'sed' && w[1] === '-n' && files(3).length === 1) {
    const r = (w[2] || '').match(/^(\d+)(?:,(\d+))?p$/);
    if (r) return { name: 'show', args: [`${files(3)[0]}:${r[1]}-${r[2] || r[1]}`] };
  }
  if ((w[0] === 'diff' || w[0] === 'cmp') && files(1).length === 2) return { name: 'diff-files', args: files(1) };
  if (w[0] === 'find' && !w.some((x) => ['-exec', '-execdir', '-delete', '-newer', '-mtime', '-mmin', '-size', '-perm', '-user', '-ok', '-printf', '-fprint'].includes(x))) {
    const i = w.findIndex((x) => x === '-name' || x === '-iname');
    if (i > 0 && w[i + 1]) return { name: 'find-files', args: [w[i + 1], ...(w[1] && !w[1].startsWith('-') ? [at(w[1])] : cd ? [cd] : [])] };
  }
  if (w[0] === 'git') {
    const rest = w.slice(1).filter((x, k, arr) => !(x === '-C' || arr[k - 1] === '-C'));
    const dir = w.includes('-C') ? [at(w[w.indexOf('-C') + 1])] : cd ? [cd] : [];
    if (rest[0] === 'status' && rest.length <= 3 && rest.slice(1).every((x) => /^(-s|--short|--porcelain(=v1)?|-uno|-u|--untracked-files(=\w+)?)$/.test(x))) return { name: 'changed-files', args: dir };
    if (rest[0] === 'diff' && rest.slice(1).every((x) => /^(--stat|--name-only|--name-status|--shortstat|HEAD)$/.test(x)) && rest.length > 1) return { name: 'changed-files', args: dir };
  }
  return null;
}

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', async () => {
  if (!id) process.exit(0);
  const parts = [];
  try {
    const ev = JSON.parse(input || '{}');
    const file = ev.tool_input && (ev.tool_input.file_path || ev.tool_input.notebook_path);
    if (ev.hook_event_name === 'PreToolUse') {
      const whole = ev.tool_name === 'Read' && file && wholeFileRead(file, ev.tool_input || {});
      if (whole) {
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
          permissionDecisionReason: `Office rule (token saving): ${file} has ${whole.lines} lines (${whole.kb} KB). Read whole, all of it stays in your context and is re-read on every later step. ` +
            'First find the part you need: the `script` tool with find-def (where a symbol is defined) or call-sites (where it is used), or Grep with -n. Then Read with offset and limit around those lines. ' +
            'If you really need the whole file, send the same Read again and it will go through.' } }));
        process.exit(0);
      }
      const big = ev.tool_name === 'Write' && file && wholeFileRewrite(file, (ev.tool_input || {}).content);
      if (big) {
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
          permissionDecisionReason: `Office rule (token saving): this Write re-sends all ${big.lines} lines of ${file} to change about ${big.changed}, and the whole text stays in your context for every later step. ` +
            'Use Edit (or MultiEdit) for the parts that change. If you really are rewriting most of the file, send the same Write again and it will go through.' } }));
        process.exit(0);
      }
      if (EDIT_TOOLS.includes(ev.tool_name) && file) {
        const r = await call('POST', '/api/files/before', { agentId: id, file });
        if (r && r.deny) {
          process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: r.deny } }));
          process.exit(0);
        }
      }
      const use = ev.tool_name === 'Bash' && scriptFor(String((ev.tool_input || {}).command || ''));
      if (use) {
        call('POST', '/api/script-nudge', { agentId: id, script: use.name });
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
          permissionDecisionReason: `Office rule: mechanical work goes through office scripts. Call the \`script\` tool instead: name "${use.name}", args ${JSON.stringify(use.args)}. ` +
            'Relative paths resolve from your working folder, so prefer absolute paths.' } }));
      }
      process.exit(0);
    }
    if (EDIT_TOOLS.includes(ev.tool_name) && file) {
      const r = await call('POST', '/api/files/touch', { agentId: id, file });
      if (r.warning) parts.push(r.warning);
    }
  } catch {}
  const mail = await call('GET', '/api/mail/unread?agentId=' + encodeURIComponent(id));
  if (mail.text) parts.push(mail.text);
  if (parts.length) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: parts.join('\n\n') } }));
  process.exit(0);
});
