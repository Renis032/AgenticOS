#!/usr/bin/env node
// Stdio MCP server injected into every agent process. It exposes the tools an agent
// uses to talk to the workplace: assign tickets, delegate work to sub-agents and report progress.
// Each call is forwarded to the workplace server over HTTP, tagged with this agent's id.
'use strict';
const http = require('http');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const AGENT_ID = process.env.WORKPLACE_AGENT_ID;
const PORT = Number(process.env.WORKPLACE_PORT || 4747);
const TOKEN = (() => { try { return fs.readFileSync(path.join(__dirname, '..', 'data', 'app-token'), 'utf8').trim(); } catch { return ''; } })();
const ROLES = (process.env.WORKPLACE_CHILD_ROLES || '').split(',').filter(Boolean);
const ROLES_HELP = process.env.WORKPLACE_CHILD_ROLES_HELP || '';
const ASSIGN_TO = (process.env.WORKPLACE_ASSIGN_TO || '').split(',').filter(Boolean);
const ASSIGN_HELP = process.env.WORKPLACE_ASSIGN_HELP || '';
const ALL_MODELS = ['haiku', 'sonnet', 'opus'];
const MODELS = ALL_MODELS.slice(0, ALL_MODELS.indexOf(process.env.WORKPLACE_MAX_MODEL || 'opus') + 1);

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': data.length, 'x-agentos-token': TOKEN } },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('Bad reply: ' + buf.slice(0, 200))); }
        });
      });
    req.setTimeout(0);
    req.on('error', reject);
    req.end(data);
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path, headers: { 'x-agentos-token': TOKEN } }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

const tools = [];
if (ASSIGN_TO.length) {
  tools.push({
    name: 'assign',
    description:
      'Hand the current ticket (or part of it) to a permanent team lead. Returns immediately; the lead works ' +
      'on it and answers the user directly. Write a complete, self-contained brief. Leads:\n' + ASSIGN_HELP,
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', enum: ASSIGN_TO, description: 'Which lead owns this.' },
        brief: { type: 'string', description: 'The full brief: user words, context, paths, project, what done means.' },
        effort: { type: 'string', enum: ['medium', 'high', 'xhigh', 'max'],
          description: "How hard the lead should think. Omit for the default (high). Use xhigh for real bugs, multi-step implementation or anything ambiguous; max only for the hardest problems; medium for quick questions." },
      },
      required: ['to', 'brief'],
    },
  });
}
if (ROLES.length) {
  tools.push({
    name: 'delegate',
    description:
      'Start one or more sub-agents. All assignments run in parallel; the call returns when every one has ' +
      'finished, with each final report. Work goes to your staff: a free teammate of that role is reused ' +
      '(check `staff` to see who is on your team and how experienced they are); if nobody suitable is free, someone new ' +
      'is hired. Roster roles join your team. A custom specialist is on call for this project only (reused when the project ' +
      'comes back, off your team otherwise) unless you set `stay: "team"` because the role is useful beyond this project. It returns when everyone has finished — or earlier, if a colleague asks you a question meanwhile: then answer it with ' +
      '`send_message` and call `wait_for_team` with the batch_id to keep waiting (your sub-agents keep working). Write each task as a complete, self-contained brief: a sub-agent ' +
      'cannot see your conversation. You decide whether a task needs sub-agents at all.\nRoster roles:\n' + ROLES_HELP +
      (ROLES.includes('custom') ? '\n- custom: a specialist you design yourself. Give it `name` (job title), ' +
        '`instructions` (who it is, how it should work) and `access` ("readonly" or "edit"). It works in your directory.' : ''),
    inputSchema: {
      type: 'object',
      properties: {
        assignments: {
          type: 'array', minItems: 1, maxItems: 6,
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', enum: ROLES, description: 'Roster role, or "custom".' },
              who: { type: 'string', description: 'Optional: a specific teammate (see `staff`) to give this to, if they are free.' },
              stay: { type: 'string', enum: ['team', 'project'], description: 'Optional: "team" keeps this person on your team for good (a role useful across projects); "project" keeps them on call for this project only. Default: roster roles "team", custom "project".' },
              title: { type: 'string', description: 'Short name for this sub-task (3-8 words), shown on the dashboard.' },
              task: { type: 'string', description: 'The full brief: goal, context, relevant paths, what to return.' },
              name: { type: 'string', description: 'custom only: job title, e.g. "Shader Expert".' },
              instructions: { type: 'string', description: 'custom only: the specialist\'s standing instructions.' },
              access: { type: 'string', enum: ['readonly', 'edit'], description: 'custom only: file access. Default readonly.' },
              pin_model: { type: 'boolean', description: 'Leave out: the office picks model and effort with its expected-value model. Set true only with evidence the choice is wrong for this task.' },
              model: { type: 'string', enum: MODELS, description: 'Only with pin_model: haiku < sonnet < opus.' },
              effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'], description: 'Only with pin_model.' },
              pin_reason: { type: 'string', description: 'Only with pin_model: one line of evidence for overriding the expected-value choice.' },
            },
            required: ['role', 'title', 'task'],
          },
        },
      },
      required: ['assignments'],
    },
  });
}
if (ROLES.length) {
  tools.push({
    name: 'wait_for_team',
    description: 'Keep waiting for the sub-agents of an earlier `delegate` call that returned early because of a question. ' +
      'Returns their reports when all are done (or returns early again on the next question).',
    inputSchema: { type: 'object', properties: { batch_id: { type: 'string' } }, required: ['batch_id'] },
  });
}
if (ROLES.length) {
  tools.push({
    name: 'staff',
    description: 'List your permanent team: each teammate\'s role, whether they are free, their track record and their last task.',
    inputSchema: { type: 'object', properties: {} },
  });
}
tools.push({
  name: 'update_memory',
  description: 'Replace your personal memory with a revised version. It is shown to you at the start of every future task, ' +
    'so it is how you improve over time. Send the FULL text (not a diff), under ~500 words: what works, what to avoid, ' +
    'checks to always do, how your lead wants reports. Code facts for the whole team go in the team library instead.',
  inputSchema: { type: 'object', properties: { content: { type: 'string', description: 'Your complete revised memory, in Markdown.' } }, required: ['content'] },
});
tools.push({
  name: 'add_lesson',
  description: 'Save ONE line (under 200 characters) you learned from a job that went wrong: what to do differently next time. ' +
    'Lessons are kept apart from your memory and shown at the start of every session; the oldest drops off after 8. ' +
    'Use it when you are told a job failed, was rated 👎, needed rework or was undone.',
  inputSchema: { type: 'object', properties: { lesson: { type: 'string', description: 'One line, e.g. "Run the tests before reporting a fix as done."' } }, required: ['lesson'] },
});
tools.push({
  name: 'give_feedback',
  description: 'Give a teammate feedback on work they did for you, so they improve. They receive it at the start of their next ' +
    'task. Be specific: what was good or weak, and what to do differently.',
  inputSchema: {
    type: 'object',
    properties: { to: { type: 'string', description: 'Teammate name.' }, feedback: { type: 'string' } },
    required: ['to', 'feedback'],
  },
});
// Only the scripts meant for this agent (manifest "for": all, lead, office), so the tool description stays short.
const SCRIPT_FOR = (process.env.WORKPLACE_SCRIPTS || 'all').split(',');
const readManifest = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).filter((x) => SCRIPT_FOR.includes(x.for || 'all')); } catch { return []; } };
// Office scripts, then this team's own (<team docs>/scripts), which only its agents see.
const SCRIPTS = [...readManifest(path.join(__dirname, '..', 'scripts')), ...(process.env.WORKPLACE_TEAM_SCRIPTS ? readManifest(process.env.WORKPLACE_TEAM_SCRIPTS) : [])];
if (SCRIPTS.length) {
  tools.push({
    name: 'script',
    description: 'Run an office script: exact, instant and free. Use it for all mechanical work instead of doing it by hand or delegating it. ' +
      'Relative paths are resolved from your working folder.\n' + SCRIPTS.map((x) => `- ${x.usage}: ${x.does.split(/[;(]/)[0].trim()}`).join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', enum: SCRIPTS.map((x) => x.name) },
        args: { type: 'array', items: { type: 'string' }, description: 'Arguments, one per item, e.g. ["parseArgs", "src", "--lang", "js"].' },
      },
      required: ['name'],
    },
  });
}
tools.push({
  name: 'search_tickets',
  description: 'Search earlier tickets (requests, answers, files changed, the user\'s rating) by key terms. Use it before ' +
    'non-trivial work: a past ticket may already hold the root cause or the fix.',
  inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Key terms: component, class, error text, file name.' } }, required: ['query'] },
});
if (process.env.WORKPLACE_CAN_ASK_USER) {
  tools.push({
    name: 'ask_user',
    description: 'Ask the user a question about your current ticket and wait for the reply. Use it only when the answer changes ' +
      'what you will do, or you need something only they have (a log, a screenshot, a decision). Ask everything in one go.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'A clear, self-contained question with the context they need.' },
        options: { type: 'array', items: { type: 'string' }, description: 'Short choices the user can click (2-5, a few words each). Give them whenever the answer is a choice; the user can still type their own.' },
      },
      required: ['question'],
    },
  });
}
if (process.env.WORKPLACE_CAN_ASK_USER) {
  tools.push({
    name: 'propose_plan',
    description: 'Ask the user to approve your plan before big work (two or more teammates, an opus teammate, or more than a couple of dollars). ' +
      'Waits for their decision: approved, approved with changes (follow them), or rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: 'Short Markdown plan: steps, who does what on which model/effort, what the user gets at the end.' },
        estimate_usd: { type: 'number', description: 'Honest total cost estimate for the ticket in USD.' },
      },
      required: ['plan', 'estimate_usd'],
    },
  });
}
tools.push({
  name: 'colleagues',
  description: 'List everyone currently in the office: name, role, status, ticket and what they are working on.',
  inputSchema: { type: 'object', properties: {} },
});
tools.push({
  name: 'send_message',
  description: 'Send a short note to a colleague by name (see `colleagues`). Non-blocking. Use reply_to to answer a question you received.',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Colleague name, e.g. "Viktor".' },
      text: { type: 'string', description: 'The message.' },
      reply_to: { type: 'string', description: 'Id of the question you are answering, if any.' },
    },
    required: ['to', 'text'],
  },
});
tools.push({
  name: 'ask',
  description: 'Ask a colleague a question and wait for their answer (default up to 5 minutes). Use it when you need a fact ' +
    'they own before you can continue. Someone who is waiting on their own sub-agents only reads mail when those finish.',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Colleague name.' },
      question: { type: 'string', description: 'A specific, self-contained question.' },
      timeout_minutes: { type: 'number', description: 'How long to wait, 1-15. Default 5.' },
    },
    required: ['to', 'question'],
  },
});
if (process.env.WORKPLACE_HAS_TEAM) {
  tools.push({
    name: 'add_to_team_docs',
    description: 'Record durable knowledge in your team library so future teammates make better decisions: a verified fact ' +
      'with evidence, a pitfall, where something lives, a decision and its reason. Appends to a page (default "notes").',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'string', description: 'Page name, e.g. "notes", "pitfalls", "status-line". Created if missing.' },
        text: { type: 'string', description: 'Markdown. Be concrete; include file:line evidence where relevant.' },
      },
      required: ['text'],
    },
  });
}
if (process.env.WORKPLACE_CAN_RUN) {
  tools.push({
    name: 'run_command',
    description: 'Run a shell command (bash -lc) in a folder inside the home directory and get its exit code and output. ' +
      'The user sees the command and its live output' + (process.env.WORKPLACE_CAN_RUN === 'ask' ? ' and approves it before it runs' : '') + '. ' +
      'Use it for builds, tests, installs and running programs that your Bash tool does not allow. Commit, push, sudo, upgrades and rm -rf are blocked.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line. Join related steps with &&. Must not wait for input.' },
        cwd: { type: 'string', description: 'Working folder, absolute or ~/…. Default: your working folder.' },
        reason: { type: 'string', description: 'One line for the user: why this command is needed.' },
        timeout_sec: { type: 'number', description: 'Stop it after this many seconds (default 300, max 1800).' },
      },
      required: ['command', 'reason'],
    },
  });
}
if (process.env.WORKPLACE_CAN_EDIT) {
  tools.push({
    name: 'request_edit_access',
    description: 'Ask the user to let you edit files in a folder outside this job\'s edit area (its project folder, team library and scratch folders). ' +
      'Waits for their decision. Use it only when the job really needs changes there.',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'The folder, absolute or ~/…; grants it and everything inside.' },
        reason: { type: 'string', description: 'One line for the user: what you need to change there and why.' },
      },
      required: ['folder', 'reason'],
    },
  });
}
if (process.env.WORKPLACE_HAS_TEAM) {
  tools.push({
    name: 'propose_skill',
    description: 'Propose a skill (saved instructions) that would make you or your team better or cheaper on future jobs: a procedure you keep ' +
      're-deriving, a checklist that would have prevented a mistake, how to work in a project or area. The user approves or rejects it; you do not wait. ' +
      'To improve an existing skill, propose it under the same name with the full new text.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short kebab-case name, e.g. "python-project-testing".' },
        description: { type: 'string', description: 'One line: when to use it (this is how agents decide to read it).' },
        why: { type: 'string', description: 'The evidence: which jobs, what was repeated or went wrong, what it will save.' },
        scope: { type: 'string', enum: ['me', 'team'], description: 'Only for you, or for your whole team.' },
        content: { type: 'string', description: 'The skill itself in Markdown: concrete steps, checks and pitfalls. Keep it focused and short.' },
      },
      required: ['name', 'description', 'why', 'content'],
    },
  });
}
if (process.env.WORKPLACE_HANDOFFS) {
  tools.push({
    name: 'save_project_handoff',
    description: 'Save where a personal project stands so the next chat about it continues from here. Call it when you finish work ' +
      'on a project or the user wraps up, once per project. Rewrites the current state and adds this session to the log.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'The project\'s folder name in ~/Personal/Projects, e.g. "RecipeBox".' },
        state: { type: 'string', description: 'Markdown, the full current state: what it is and how to run it, what works, decisions and why, open problems, next steps in order, key files.' },
        session: { type: 'string', description: 'Markdown summary of this chat: what the user asked, what you did, files changed, what the user decided or corrected.' },
      },
      required: ['project', 'state', 'session'],
    },
  });
}
tools.push({
  name: 'report_progress',
  description:
    'Post a short status update to the office dashboard so the user can follow along ' +
    '(what you are doing now, what you found, what is next). Use it at each meaningful step.',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', description: 'One or two sentences.' },
      percent: { type: 'number', description: 'Optional rough completion estimate, 0-100.' },
      step: { type: 'number', description: 'While working through an approved plan: the number of the plan step you are on now (1 = first).' },
    },
    required: ['status'],
  },
});

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function textResult(id, text, isError) {
  send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: !!isError } });
}

async function callTool(id, name, args) {
  try {
    if (name === 'assign') {
      const r = await post('/api/assign', { agentId: AGENT_ID, to: args.to, brief: args.brief, effort: args.effort });
      return textResult(id, r.error || r.message, !!r.error);
    }
    if (name === 'delegate' || name === 'wait_for_team') {
      const r = name === 'delegate'
        ? await post('/api/delegate', { parentId: AGENT_ID, assignments: args.assignments || [] })
        : await post('/api/wait', { agentId: AGENT_ID, batchId: args.batch_id });
      if (r.error) return textResult(id, r.error, true);
      if (r.batchId) {
        return textResult(id, `Your team is still working (${r.waitingOn.join(', ') || 'finishing up'}). Meanwhile you have mail:\n\n` +
          `${r.question}\n\nAnswer with send_message (use the reply_to id), then call wait_for_team with batch_id "${r.batchId}" to collect their reports.`);
      }
      const text = r.results.map((c) =>
        `### [${c.role}] ${c.title} — ${c.persona}${c.model ? ` (${c.model})` : ''}, ${c.status}${c.why ? `\n_${c.why}_` : ''}\n${c.result || '(no report)'}`).join('\n\n');
      return textResult(id, text);
    }
    if (name === 'staff') {
      const r = await get('/api/staff?agentId=' + encodeURIComponent(AGENT_ID));
      return textResult(id, r.text);
    }
    if (name === 'update_memory') {
      const r = await post('/api/memory', { agentId: AGENT_ID, content: args.content });
      return textResult(id, r.error || r.message, !!r.error);
    }
    if (name === 'add_lesson') {
      const r = await post('/api/lessons', { agentId: AGENT_ID, text: args.lesson });
      return textResult(id, r.error || r.message, !!r.error);
    }
    if (name === 'give_feedback') {
      const r = await post('/api/feedback', { agentId: AGENT_ID, to: args.to, text: args.feedback });
      return textResult(id, r.error || r.message, !!r.error);
    }
    if (name === 'script') {
      const r = await post('/api/script', { agentId: AGENT_ID, name: args.name, args: args.args || [] });
      return textResult(id, r.error || r.message, !!r.error);
    }
    if (name === 'search_tickets') {
      const r = await get('/api/search?agentId=' + encodeURIComponent(AGENT_ID) + '&q=' + encodeURIComponent(args.query || ''));
      return textResult(id, r.text || 'No earlier tickets match.');
    }
    if (name === 'propose_plan') {
      const r = await post('/api/propose-plan', { agentId: AGENT_ID, plan: args.plan, estimateUsd: args.estimate_usd });
      return textResult(id, r.error || r.message, !!r.error);
    }
    if (name === 'ask_user') {
      const r = await post('/api/ask-user', { agentId: AGENT_ID, question: args.question, options: args.options });
      return textResult(id, r.error || r.message, !!r.error);
    }
    if (name === 'colleagues') {
      const r = await get('/api/colleagues?agentId=' + encodeURIComponent(AGENT_ID));
      return textResult(id, r.text);
    }
    if (name === 'send_message') {
      const r = await post('/api/mail/send', { agentId: AGENT_ID, to: args.to, text: args.text, replyTo: args.reply_to });
      return textResult(id, r.error || r.message, !!r.error);
    }
    if (name === 'ask') {
      const r = await post('/api/mail/ask', { agentId: AGENT_ID, to: args.to, question: args.question, timeoutSec: (args.timeout_minutes || 5) * 60 });
      return textResult(id, r.error || r.message, !!r.error);
    }
    if (name === 'add_to_team_docs') {
      const r = await post('/api/docs/add', { agentId: AGENT_ID, page: args.page, text: args.text });
      return textResult(id, r.error || r.message, !!r.error);
    }
    if (name === 'run_command') {
      const r = await post('/api/command/run', { agentId: AGENT_ID, command: args.command, cwd: args.cwd, reason: args.reason, timeout_sec: args.timeout_sec });
      return textResult(id, r.error || r.message, !!r.error);
    }
    if (name === 'request_edit_access') {
      const r = await post('/api/edit-access/request', { agentId: AGENT_ID, folder: args.folder, reason: args.reason });
      return textResult(id, r.error || r.message, !!r.error);
    }
    if (name === 'propose_skill') {
      const r = await post('/api/skill-proposals/propose', { agentId: AGENT_ID, name: args.name, description: args.description, why: args.why, scope: args.scope, content: args.content });
      return textResult(id, r.error || r.message, !!r.error);
    }
    if (name === 'save_project_handoff') {
      const r = await post('/api/handoff/save', { agentId: AGENT_ID, project: args.project, state: args.state, session: args.session });
      return textResult(id, r.error || r.message, !!r.error);
    }
    if (name === 'report_progress') {
      await post('/api/progress', { agentId: AGENT_ID, status: args.status, percent: args.percent, step: args.step });
      return textResult(id, 'Posted.');
    }
    textResult(id, 'Unknown tool: ' + name, true);
  } catch (e) {
    textResult(id, 'Workplace server error: ' + e.message, true);
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
      serverInfo: { name: 'workplace', version: '2.0.0' } } });
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
