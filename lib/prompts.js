'use strict';
// What each agent is told and how it is started: roster helpers, memory and feedback, the system prompt, model choice and the claude command line. Moved out of server.js unchanged.

function install(ctx) {
  const { addEvent, agents, canRunCommands, commandMode, DATA, fs, handoffsOf, home, lessons, now, os, path, PORT, readJson, ROOT,
    savedHandoffs, skillProposals, spawn, ticketBudget, ticketOfAgent, touch, UPLOADS } = ctx;

  function expandTools(roster, preset) {
    const out = [];
    for (const t of roster.toolPresets[preset] || []) {
      if (t.startsWith('@')) out.push(...expandTools(roster, t.slice(1)));
      else out.push(t);
    }
    return out;
  }

  function defOf(roster, a) {
    return a.customDef || roster.roles[a.role];
  }

  function childRolesFor(roster, a) {
    const def = defOf(roster, a);
    if (a.depth + 1 > (def.maxDepth || roster.defaults.maxDepth)) return [];
    const roles = (def.children || []).map((c) => (c === 'self' ? a.role : c)).filter((c) => roster.roles[c]);
    if (def.allowCustom !== false && a.role !== roster.root) roles.push('custom');
    return [...new Set(roles)];
  }

  function rolePrompt(def) {
    if (def.agentFile) {
      const body = fs.readFileSync(home(def.agentFile), 'utf8');
      const m = body.match(/^---\n[\s\S]*?\n---\n?/);
      return (m ? body.slice(m[0].length) : body).trim() + (def.prompt ? '\n\n' + def.prompt : '');
    }
    return def.prompt || '';
  }

  const MEMORY_DIR = path.join(DATA, 'memory');
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  const MEMORY_MAX = 6000;

  function readMemory(id) {
    try { return fs.readFileSync(path.join(MEMORY_DIR, id + '.md'), 'utf8'); } catch { return ''; }
  }

  function writeMemory(agentId, content) {
    const a = agents.get(agentId);
    if (!a) return { error: 'Unknown agent.' };
    if (a.twinOf) return { error: 'You are a second desk: the memory belongs to your lead and is read-only for you. Send a lesson with add_lesson, or put team facts in the team library.' };
    let text = String(content || '').trim();
    if (!text) return { error: 'Empty memory; send the full revised text.' };
    const secret = require('./secrets').findSecret(text);
    if (secret) return { error: require('./secrets').refusal(secret) };
    const cut = text.length > MEMORY_MAX;
    if (cut) text = text.slice(0, MEMORY_MAX);
    const file = path.join(MEMORY_DIR, agentId + '.md');
    const prev = readMemory(agentId);
    if (prev) fs.writeFileSync(path.join(MEMORY_DIR, agentId + '.prev.md'), prev);
    fs.writeFileSync(file, text + '\n');
    a.memoryVersion = (a.memoryVersion || 0) + 1;
    a.memoryUpdatedAt = now();
    addEvent(a, { kind: 'memory', text, version: a.memoryVersion });
    touch(a);
    return { message: `Memory saved (version ${a.memoryVersion}${cut ? `, cut to ${MEMORY_MAX} characters — keep it shorter` : ''}).` };
  }

  function giveFeedback(fromId, toName, text) {
    const n = String(toName || '').trim().toLowerCase();
    const to = [...agents.values()].find((x) => x.id.toLowerCase() === n || (x.persona || '').toLowerCase() === n);
    if (!to) return { error: `No one called "${toName}".` };
    const from = fromId === 'user' ? null : agents.get(fromId);
    const t = from && ticketOfAgent(from);
    const fb = { from: from ? from.id : 'user', fromPersona: from ? from.persona : 'the user', text: String(text || '').slice(0, 4000), ticketN: t ? t.n : null, t: now(), seen: false };
    to.feedback = to.feedback || [];
    to.feedback.push(fb);
    if (to.feedback.length > 30) to.feedback.splice(0, to.feedback.length - 30);
    addEvent(to, { kind: 'feedback', from: fb.from, fromPersona: fb.fromPersona, text: fb.text });
    if (from) addEvent(from, { kind: 'msg_out', to: to.id, toPersona: to.persona, text: '(feedback) ' + fb.text });
    touch(to);
    return { message: `${to.persona} will get this at the start of their next task.` };
  }

  function pendingFeedback(a) {
    return (a.feedback || []).filter((f) => !f.seen);
  }

  // Standing instructions: what the user tells a lead once and wants on every job ("when you fix a bug, add a short
  // brief and a commit message"). Unlike feedback they are never used up; a second desk follows its lead's.
  const STANDING_MAX = 20;
  function standingOf(a) {
    const lead = a && a.twinOf ? agents.get(a.twinOf) || a : a;
    return (lead && lead.standing) || [];
  }

  function setStanding(agentId, op, text, id) {
    const a = agents.get(agentId);
    if (!a || !a.resident || a.twinOf) return { error: 'Standing instructions are for team leads.' };
    a.standing = a.standing || [];
    if (op === 'remove') {
      const i = a.standing.findIndex((x) => x.id === id);
      if (i < 0) return { error: 'No such instruction.' };
      a.standing.splice(i, 1);
    } else {
      const t = String(text || '').trim().slice(0, 1500);
      if (!t) return { error: 'Empty instruction.' };
      const secret = require('./secrets').findSecret(t);
      if (secret) return { error: require('./secrets').refusal(secret) };
      if (a.standing.length >= STANDING_MAX) return { error: `${a.persona} already has ${STANDING_MAX} standing instructions; remove one first.` };
      a.standing.push({ id: require('crypto').randomBytes(4).toString('hex'), text: t, t: now() });
      addEvent(a, { kind: 'feedback', from: 'user', fromPersona: 'the user', text: `(standing instruction) ${t}` });
    }
    a.standingVersion = (a.standingVersion || 0) + 1;
    touch(a);
    return { ok: true, standing: a.standing, message: `${a.persona} follows this from their next job on.` };
  }

  function standingVersion(a) {
    const lead = a.twinOf ? agents.get(a.twinOf) || a : a;
    return lead.standingVersion || 0;
  }

  function standingLines(a) {
    return standingOf(a).map((x) => `- ${x.text}`);
  }

  function teamOf(roster, a) {
    const key = a.resident ? a.twinOf || a.id : a.homeId;
    const def = key && roster.roles[key];
    if (!def || !def.team) return null;
    return { key, room: def.room, dir: path.join(ROOT, def.team.docs), references: (def.team.references || []).map(home), router: def.team.router ? home(def.team.router) : null };
  }

  function systemPrompt(roster, a, childRoles) {
    const def = defOf(roster, a);
    const parent = a.parentId && agents.get(a.parentId);
    const parts = [rolePrompt(def)];
    for (const doc of def.preload || []) {
      try { parts.push('', `## Reference: ${doc} (already loaded for you; do not Read it again)`, '', fs.readFileSync(home(doc), 'utf8').slice(0, 20000)); } catch {}
    }
    if (def.reportStyle === 'short') {
      parts.push('', '## Report format',
        'Your report goes into your lead\'s context, so keep it under ~300 words: the direct answer first, then the evidence as file:line ' +
        'with one line each on what it shows, then the likely root cause and where a fix belongs, then open questions. Never paste whole ' +
        'files or long listings; quote at most a few lines when the exact code matters.');
    }
    parts.push('', '## Workplace',
      `Your name is ${a.persona}. You are the ${def.name} (agent ${a.id}) in the user's office of AI agents.`);
    if (a.resident) {
      parts.push('You are permanent staff: this process stays alive between tickets and you remember earlier tickets. ' +
        'Each message starts with a header saying who it is from and which ticket it belongs to. Handle one message per turn.');
      if (a.twinOf) {
        const lead = agents.get(a.twinOf);
        parts.push(`You are a second desk of ${lead ? lead.persona : 'your lead'}: they are busy with another ticket, so you took this one. ` +
          'You have their instructions, tools and memory, and you own this ticket end to end (answer, plans, questions, commands). ' +
          'The memory is theirs and read-only for you: do not call `update_memory`; send what you learned with `add_lesson` or the team library. ' +
          'You stop after a while idle; later messages on your tickets go back to them.');
      }
    } else {
      const lead = agents.get(a.homeId);
      parts.push(`You are permanent staff on ${lead ? `${lead.persona}'s team (${lead.room})` : 'the team'}. Between tasks you sit idle at your desk; ` +
        'each task starts a fresh conversation, so your memory (below) is how you carry experience from one task to the next.');
      parts.push(`This task comes from ${parent.persona}, the ${parent.name}, for ticket #${a.ticketN}. ` +
        'Your final message is your report back to them: make it complete and self-contained, they see nothing else of your work.');
    }
    parts.push('The user watches a live view of the office. Call `report_progress` at each meaningful step with one or two plain sentences.');
    if (childRoles.length) {
      parts.push('You may start sub-agents with `delegate` (several in parallel in one call). It is your call whether a task needs them: ' +
        'do small things yourself, split broad or parallel work across specialists. The built-in Agent/Task tool is disabled.');
      parts.push('', '## Model and effort for sub-agents',
        'You do not pick models. The office decides each sub-agent\'s model and effort with an expected-value model: it estimates the task\'s ' +
        'difficulty from the role and your brief, the chance each model/effort succeeds (from this office\'s real track record), the cost, ' +
        'and the price of a failure, and takes the best value. So write briefs that make the difficulty clear (what is hard about it, what ' +
        'is at stake). The choice and its numbers come back to you in the delegation result. Only if you have concrete evidence the choice ' +
        `is wrong for this task, set \`pin_model: true\` with \`model\`, \`effort\` and a one-line \`pin_reason\`. You cannot go above ${modelOf(roster, a).model}. ` +
        (ticketBudget() != null ? 'Each ticket has a budget; if it runs out, new sub-agents wait until the user raises it.' : 'Jobs have no dollar budget; the user\'s plan usage limits are what count, so do not spend on teammates you do not need.'));
    } else if (!def.assignTo) {
      parts.push('You cannot start sub-agents: do the work yourself.');
    }
    const standing = standingLines(a);
    if (standing.length) {
      parts.push('', '## The user\'s standing instructions to you',
        'The user told you these directly. Follow them on every ticket they apply to, on top of your role instructions; they win over your memory when the two disagree.',
        ...standing);
    }
    const memory = readMemory(a.twinOf || a.id);
    parts.push('', '## Your memory', memory.trim() || '(Empty — this is your first task. Start building it at the end.)');
    parts.push(...lessons.promptBlock(a.twinOf ? agents.get(a.twinOf) || a : a));
    if (a.staff) {
      const recent = (a.history || []).slice(-5).map((h) => `#${h.n || '?'} ${h.title} — ${h.outcome}`).join('; ');
      parts.push(`Track record: ${a.tasksDone || 0} tasks done, ${a.tasksFailed || 0} not completed.${recent ? ` Recent: ${recent}.` : ''}`);
    }
    const fb = pendingFeedback(a);
    if (fb.length) {
      parts.push('', '## Feedback since your last task', ...fb.map((f) => `- From ${f.fromPersona}${f.ticketN ? ` (ticket #${f.ticketN})` : ''}: ${f.text}`),
        'Take it seriously: change how you work, and fold the lesson into your memory.');
    }
    if (a.twinOf) parts.push('', '## Learning from your work',
      'When something on this ticket taught a lesson worth keeping, send it with `add_lesson`; code or project facts the team needs go to the team library (`add_to_team_docs`).');
    else parts.push('', '## Learning from your work',
      (a.resident ? 'When you finish a ticket' : 'Before your final report') + ', call `update_memory` with your full revised memory if you learned anything about doing your job better. ' +
      'Rewrite it rather than append: keep it under ~500 words, concrete and current. Good entries: approaches that worked or wasted time, ' +
      'checks you should always do, mistakes to avoid, how your lead wants things reported, where to look first. ' +
      'Drop entries that turned out wrong or no longer matter. Facts about the code or project that the whole team needs belong in the ' +
      'team library (`add_to_team_docs`), not in your memory. ' +
      (childRoles.length ? 'When someone you delegated to did notably good or weak work, tell them with `give_feedback` so they improve.' : ''));
    parts.push('', '## Scripts first',
      'Mechanical work (counting, finding files or definitions, call sites, comparing, checking XML, uncommitted changes) is done with the ' +
      '`script` tool: exact, instant, free. Never do it by hand or delegate it. Read in parts: `outline`, `search` or `find-def` to find the ' +
      'lines, then `show file:from-to` (several files at once) or Read with offset/limit. Everything you read is re-read on every later call. ' +
      'Search with `search`, not `grep -r` in Bash: it takes several folders at once and never reads media or huge files, so a repository with ' +
      'gigabytes of assets takes seconds instead of minutes. Where a repository stands (branch, HEAD, uncommitted changes, submodules, whether ' +
      'a commit is in the history, the full diff) is one `repo-state` call, not a chain of git commands. ' +
      'A mechanical step no script covers goes on the "script-ideas" page (`add_to_team_docs`).');
    const teamScripts = (() => { const t = teamOf(roster, a); try { return t ? JSON.parse(fs.readFileSync(path.join(t.dir, 'scripts', 'manifest.json'), 'utf8')) : []; } catch { return []; } })();
    if (teamScripts.length) {
      parts.push('', `## Your team's own scripts`,
        'These know this team\'s repository and answer in one call what otherwise takes many searches. Reach for them before searching by hand:',
        ...teamScripts.map((x) => `- \`${x.usage}\`: ${x.does}`));
    }
    parts.push('', '## Past tickets',
      'Before non-trivial work, call `search_tickets` with the key terms (component, error text, file name). An earlier ticket may ' +
      'already hold the root cause, the fix that was made, or the user\'s verdict on a similar answer. Do not redo solved work blindly.');
    if (a.resident && !def.assignTo && childRoles.length) {
      parts.push('', '## You manage; teammates do the long work',
        'Your conversation lasts the whole job and is re-read on every call, so it is the most expensive context in the office. Keep it small: ' +
        'read only what you need to decide, plan, write precise briefs (goal, files with line numbers, constraints, how to check), and review ' +
        'short reports. Hand long reading, searching, multi-file edits, test runs and fix loops to teammates, who start fresh each time and ' +
        'usually run on cheaper models. Do small, quick things yourself.');
      parts.push('', '## Plans for big tickets',
        'Before a big piece of work (two or more teammates at once, any opus teammate, or work you expect to cost more than ' +
        `$${roster.defaults.planOverUsd || 2}), call \`propose_plan\` with a short plan: the steps, who does what on which model and effort, ` +
        'and an honest cost estimate in USD. The user approves, adjusts or rejects it; follow their adjustments. ' +
        'The office refuses a big delegation until the plan is approved. Small tickets need no plan. ' +
        'Write the plan\'s steps as a numbered list; while you work through an approved plan, pass `step` (the number of the step you are on) to `report_progress` so the user sees the plan tick off.');
    }
    if (a.resident && !def.assignTo) {
      parts.push('', '## Asking the user',
        'If the ticket is ambiguous in a way that changes what you would do, or you need something only the user has (a log, a ' +
        'screenshot, a decision between options), call `ask_user`. The ticket waits for their reply. Do not ask for things you can ' +
        'find out yourself, and ask everything you need in one question. Files the user attaches are listed in the ticket; open them with Read.');
    }
    parts.push('', '## Shared files',
      'Change files only with Edit/MultiEdit (just the changed lines) or Write (new files, full rewrites), never sed or redirection: the ' +
      'user reviews and can undo those changes. If another agent edits the same file you both get a heads-up; agree with `ask`/`send_message` ' +
      'who changes what.');
    parts.push('', '## Colleagues',
      '`colleagues` lists who is here; `send_message` leaves a short note; `ask` asks and waits. Messages to you arrive after your tool calls ' +
      'marked [Mail]; answer an `ask` with `send_message` and its reply_to id.');
    const team = teamOf(roster, a);
    // The area router: for leads, and for staff too when the team says it holds working knowledge (team.routerForStaff).
    if (team && team.router && fs.existsSync(team.router) && (a.resident || (roster.roles[team.key].team || {}).routerForStaff)) {
      parts.push('', '## Your area (router)', `From ${team.router}, loaded for you because CLAUDE.md is only a map:`, '', fs.readFileSync(team.router, 'utf8').slice(0, 20000));
    }
    if (team) {
      parts.push('', '## Team library',
        `Your team (${team.room}) keeps documentation in ${team.dir} — start with INDEX.md there.` +
        (team.references.length ? ` Reference docs also live in: ${team.references.join(', ')}.` : '') +
        ' Read the pages relevant to your task before you decide on an approach. When you learn something durable that future ' +
        'teammates would need (a verified fact with file:line evidence, a pitfall, where something lives, a decision and why), ' +
        'record it with `add_to_team_docs`. Do not record guesses.');
    }
    if (canRunCommands(roster, a) && commandMode(roster) !== 'off') {
      parts.push('', '## Terminal commands',
        'Your Bash tool only allows a short list of commands. For anything else (builds, test runs, installs, starting or checking a program, ' +
        'scripts with arguments), use `run_command`: it runs `bash -lc` in the folder you give, shows the command and its live output to the user, ' +
        'and returns the exit code and output. ' +
        (commandMode(roster) === 'ask' ? 'The user approves each command before it runs, so put related steps in one command (joined with &&) and say why in `reason`. ' : 'Commands run without asking, so be careful. ') +
        'Commit, push, sudo, system upgrades and rm -rf are blocked; when one of those is needed, tell the user what to run. ' +
        'Commands cannot read input: use non-interactive flags (-y, --yes, CI=1). Set `timeout_sec` for long builds (default 300, max 1800).');
    }
    parts.push(...skillProposals.promptFor(roster, a));
    const ccSkills = claudeSkillsFor(roster, a);
    if (ccSkills.length) {
      parts.push('', '## Claude Code skills for your team',
        'These skills from ~/.claude/skills hold the team\'s proven procedures. When a task matches one, call the `Skill` tool with its name before you start, and follow it:',
        ...ccSkills.map((s) => `- ${s.name}: ${s.description}`),
        'A skill may tell you to start a subagent with the Agent tool. That tool is not available here: use `delegate` with the matching roster role instead ' +
        '(or do the step yourself if you cannot delegate).');
    }
    const handoffs = handoffsOf(roster, a);
    if (handoffs) {
      const saved = savedHandoffs(handoffs).sort((x, y) => y.mtime - x.mtime)
        .map((s) => `${s.name} (${new Date(s.mtime).toISOString().slice(0, 10)})`);
      parts.push('', '## Project handoffs (continuing work across chats)',
        `Each project in ${handoffs.root} can have a handoff file in ${handoffs.dir}/<Folder>.md: the project's current state and a log ` +
        'of past sessions. When a ticket names a project, its handoff is put at the top of the ticket for you; when the user refers to a ' +
        'project only indirectly ("the GIF app", "continue where we stopped"), Read its file yourself. Treat it as your own notes from last ' +
        'time: continue from its next steps instead of exploring again, and check details against the code before relying on them.',
        'When you finish work on a project, and whenever the user says they are wrapping up or asks for a summary, call ' +
        '`save_project_handoff` before your final answer, once per project you worked on. `state` is the full current state, rewritten ' +
        'each time (what the project is and how to run it, what works, decisions and why, open problems, next steps in order, key files). ' +
        '`session` is this chat: what the user asked, what you did, files changed, what the user decided or corrected. Run the `handoff-facts` script first (job number or project folder) for the facts, and `project-info` when you start on a project. Write both so a ' +
        'fresh session with no other context can carry on.',
        `Handoffs saved so far: ${saved.length ? saved.join(', ') : 'none yet'}.`);
    }
    if (def.assignTo) {
      const projects = readJson('projects.json');
      parts.push('', '## Known projects', ...projects.map((p) =>
        `- ${p.name} — ${p.path} — owner: ${p.department}. ${p.description || ''}`));
    }
    return parts.join('\n');
  }

  function modelOf(roster, a) {
    const def = defOf(roster, a);
    if (a.resident) return { model: def.model || roster.defaults.residentModel || 'opus',
      effort: (a.id !== roster.root && a.runEffort) || def.effort || roster.defaults.residentEffort || 'high' };
    return { model: a.model || def.model || roster.defaults.model, effort: a.effort || def.effort || roster.defaults.effort };
  }

  // How big each role's fixed instructions and tool definitions are (scripts/prompt-size.js): what every call of that role re-sends.
  async function promptSizes() {
    const roster = readJson('roster.json');
    const out = [];
    const leadsList = roster.residents.filter((k) => k !== roster.root);
    const sample = [roster.root, ...leadsList, ...[...new Set(leadsList.flatMap((k) => roster.roles[k].children || []))].filter((r) => r !== 'custom')];
    for (const role of sample) {
      const def = roster.roles[role];
      if (!def) continue;
      const resident = roster.residents.includes(role);
      const home = resident ? role : leadsList.find((k) => (roster.roles[k].children || []).includes(role));
      const a = resident ? { id: role, role, resident: true, persona: def.persona || role, name: def.name, inbox: [] }
        : { id: `size-${role}`, role, staff: true, homeId: home, parentId: home, persona: 'Sample', name: def.name, ticketN: 0, history: [] };
      let text = '';
      try { text = systemPrompt(roster, a, childRolesFor(roster, a)); } catch (e) { out.push({ role, error: e.message }); continue; }
      const sections = text.split(/\n(?=## )/).map((x) => ({ name: (x.match(/^## (.*)/) || [null, '(role instructions)'])[1], chars: x.length }));
      const args = buildArgs(roster, a);
      const mcpEnv = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers.workplace.env;
      const toolsJson = await new Promise((resolve) => {
        const c = spawn(process.execPath, [path.join(ROOT, 'lib', 'mcp-delegate.js')], { env: { ...process.env, ...mcpEnv }, stdio: ['pipe', 'pipe', 'ignore'] });
        let buf = '';
        const done = (v) => { try { c.kill(); } catch {} resolve(v); };
        c.stdout.on('data', (d) => { buf += d; const line = buf.split('\n').find((l) => /"id":\s*2\b/.test(l)); if (line) done(line); });
        c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'size', version: '1' } } }) + '\n');
        c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
        setTimeout(() => done(''), 4000);
      });
      let tools = [];
      try { tools = JSON.parse(toolsJson).result.tools.map((t) => ({ name: t.name, chars: JSON.stringify(t).length })); } catch {}
      out.push({ role, resident, promptChars: text.length, sections, toolChars: tools.reduce((n, t) => n + t.chars, 0), tools });
    }
    return out;
  }

  function buildArgs(roster, a) {
    a.standingSeen = standingVersion(a);
    const def = defOf(roster, a);
    const me = modelOf(roster, a);
    const childRoles = childRolesFor(roster, a);
    const team = teamOf(roster, a);
    const help = childRoles.filter((r) => r !== 'custom').map((r) => {
      const d = roster.roles[r];
      return `- ${r}: ${d.name} — ${d.description} (usual: ${d.model || roster.defaults.model}/${d.effort || roster.defaults.effort})`;
    }).join('\n');
    const assignTo = def.assignTo || [];
    const assignHelp = assignTo.map((r) => `- ${r}: ${roster.roles[r].persona}, ${roster.roles[r].name} — ${roster.roles[r].description}`).join('\n');
    const mcp = { mcpServers: { workplace: {
      type: 'stdio', command: process.execPath, args: [path.join(ROOT, 'lib', 'mcp-delegate.js')],
      env: { WORKPLACE_AGENT_ID: a.id, WORKPLACE_PORT: String(PORT),
             WORKPLACE_CHILD_ROLES: childRoles.join(','), WORKPLACE_CHILD_ROLES_HELP: help,
             WORKPLACE_ASSIGN_TO: assignTo.join(','), WORKPLACE_ASSIGN_HELP: assignHelp,
             WORKPLACE_HAS_TEAM: teamOf(roster, a) ? '1' : '',
             WORKPLACE_HANDOFFS: handoffsOf(roster, a) ? '1' : '',
             WORKPLACE_CAN_EDIT: canRunCommands(roster, a) ? '1' : '',
             WORKPLACE_CAN_RUN: canRunCommands(roster, a) && commandMode(roster) !== 'off' ? commandMode(roster) : '',
             WORKPLACE_TEAM_SCRIPTS: team ? path.join(team.dir, 'scripts') : '',
             WORKPLACE_SCRIPTS: ['all', ...(a.resident && a.id !== roster.root ? ['lead'] : []), ...(team && roster.roles[team.key].team.office ? ['office'] : [])].join(','),
             WORKPLACE_MAX_MODEL: me.model,
             WORKPLACE_CAN_ASK_USER: a.resident && a.id !== roster.root ? '1' : '' } } } };
    const allowed = [...expandTools(roster, def.tools || 'readonly'), 'mcp__workplace__report_progress',
      ...(childRoles.length ? ['mcp__workplace__delegate', 'mcp__workplace__wait_for_team'] : []), ...(assignTo.length ? ['mcp__workplace__assign'] : []),
      'mcp__workplace__colleagues', 'mcp__workplace__send_message', 'mcp__workplace__ask', ...(team ? ['mcp__workplace__add_to_team_docs', 'mcp__workplace__propose_skill'] : []),
      ...(handoffsOf(roster, a) ? ['mcp__workplace__save_project_handoff'] : []),
      ...(canRunCommands(roster, a) && commandMode(roster) !== 'off' ? ['mcp__workplace__run_command'] : []),
      ...(canRunCommands(roster, a) ? ['mcp__workplace__request_edit_access'] : []),
      ...(a.twinOf ? [] : ['mcp__workplace__update_memory']), 'mcp__workplace__add_lesson', 'mcp__workplace__remember_for_project', 'mcp__workplace__recall_project', 'mcp__workplace__give_feedback', ...(childRoles.length ? ['mcp__workplace__staff'] : []),
      ...(claudeSkillsFor(roster, a).length ? ['Skill'] : []),
      'mcp__workplace__search_tickets', 'mcp__workplace__script', ...(a.resident && a.id !== roster.root ? ['mcp__workplace__ask_user', 'mcp__workplace__propose_plan'] : []), `Read(/${UPLOADS}/**)`];
    const addDirs = [...(team ? [team.dir, ...team.references] : []), UPLOADS];
    if (a.resident && team) allowed.push(`Edit(/${team.dir}/**)`, `Write(/${team.dir}/**)`, `MultiEdit(/${team.dir}/**)`);
    const hook = [{ type: 'command', command: `${process.execPath} ${path.join(ROOT, 'lib', 'mail-hook.js')}` }];
    const settings = { autoMemoryEnabled: false, hooks: { PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|Read', hooks: hook }], PostToolUse: [{ matcher: '*', hooks: hook }] } };
    // Preferences → Agents & teams → Web access off: no agent gets WebSearch or WebFetch.
    const noWeb = roster.defaults.allowWeb === 0;
    return ['-p', '--output-format', 'stream-json', '--verbose',
      '--settings', JSON.stringify(settings),
      ...(addDirs.length ? ['--add-dir', ...addDirs] : []),
      ...(a.resident ? ['--include-partial-messages'] : []),
      '--model', me.model,
      '--effort', me.effort,
      '--thinking-display', roster.defaults.thinkingDisplay || 'summarized',
      '--permission-mode', def.permissionMode || 'default',
      '--mcp-config', JSON.stringify(mcp), '--strict-mcp-config',
      '--tools', ...builtinTools(noWeb ? allowed.filter((x) => !WEB_TOOLS.includes(x)) : allowed),
      '--append-system-prompt', systemPrompt(roster, a, childRoles),
      '--allowedTools', ...(noWeb ? allowed.filter((x) => !WEB_TOOLS.includes(x)) : allowed),
      '--disallowedTools', ...roster.alwaysDisallowed, ...(noWeb ? WEB_TOOLS : [])];
  }

  const WEB_TOOLS = ['WebSearch', 'WebFetch'];
  const BUILTIN_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LSP', 'Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebSearch', 'WebFetch', 'Skill']);

  // Claude Code skills (~/.claude/skills) a team may use, from its team.claudeSkills: a list of names, "*" for all, or
  // "work-area" for every skill that mentions the work repository (defaults.workArea.repo), so new ones join by themselves.
  function claudeSkillsFor(roster, a) {
    const key = a.resident ? a.twinOf || a.id : a.homeId;
    const want = key && roster.roles[key] && roster.roles[key].team && roster.roles[key].team.claudeSkills;
    if (!want) return [];
    const dir = path.join(os.homedir(), '.claude', 'skills');
    const W = require('./work-area').workArea(ROOT);
    const out = [];
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    for (const n of names) {
      let text;
      try { text = fs.readFileSync(path.join(dir, n, 'SKILL.md'), 'utf8'); } catch { continue; }
      const desc = ((text.match(/^description:\s*(.*)$/m) || [])[1] || '').trim();
      const ok = want === '*' || (Array.isArray(want) && want.includes(n)) || (want === 'work-area' && W.repo && (text.includes(W.repo) || text.includes(W.tilde(W.repo))));
      const first = desc.split(/(?<=[.;—])\s/)[0].replace(/\s+in \/home\/\S+/, '');
      if (ok) out.push({ name: n, description: first.length > 110 ? first.slice(0, 107) + '…' : first });
    }
    return out;
  }
  function builtinTools(allowed) {
    return [...new Set(allowed.map((t) => t.split('(')[0]).filter((t) => BUILTIN_TOOLS.has(t)))];
  }

  function childEnv(a) {
    const compact = Number(readJson('roster.json').defaults.autoCompactTokens) || 0;
    const env = { ...process.env, ...(compact > 0 ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(compact) } : {}), MCP_TOOL_TIMEOUT: '86400000', MCP_TIMEOUT: '30000', WORKPLACE_AGENT_ID: a.id, WORKPLACE_PORT: String(PORT), ENABLE_TOOL_SEARCH: 'false', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    return env;
  }

  return { expandTools, defOf, childRolesFor, MEMORY_DIR, readMemory, writeMemory, giveFeedback, pendingFeedback, standingOf, standingLines, standingVersion, setStanding, teamOf,
    modelOf, promptSizes, buildArgs, claudeSkillsFor, childEnv };
}

module.exports = { install };
