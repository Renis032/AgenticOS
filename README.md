# Agentic OS

A permanent team of Claude agents, run like an operating system: every agent is a process in one live tree,
every task is a job.

```
./agentos                 # start the server if needed and open the Agentic OS window
./agentos status          # is it running, how many processes and jobs
./agentos stop [-f]       # stop; refuses while agents are working unless -f
./agentos restart
./agentos install         # add it to your applications menu (uninstall removes it)
```

It is a desktop program: a native GTK window (`app/agentos-window.py`, Python 3 + WebKitGTK, both part of Ubuntu)
over a local Node backend. No browser, no web address, no phone access. The backend listens only on 127.0.0.1 and
answers only requests that carry the app token in `data/app-token` (readable only by you): the window, its own agents
and the `agentos` commands. Opening the address in a browser gets "Agentic OS only opens in its own window". Closing
the window quits Agentic OS; if jobs are still running it asks first: stop them and quit, or keep them running in the
background (reopen the window from the applications menu). `./agentos stop` ends everything. F5 or Ctrl+R reloads,
Ctrl +/− zooms. No npm install (Node 18 built-ins only).
Uses your Claude Code login. `./start.sh` and `./stop.sh` still work.

## The apps

| App | Key | What it is |
|---|---|---|
| **Processes** | `p` | The full process tree. God (PID 1) is the root; each lead is a permanent process under it; staff sit under their lead while idle and, while working, under whoever started them, so delegations nest as deep as they go. Columns: PID, model/effort, state, job, live activity (thinking in purple), cost, tasks. Filter by name or job, hide idle staff, fold branches. Select a process for its inspector: thinking and messages (Mind), memory, last report, track record and feedback, children, and actions (kill, fresh session, weekly review, reset, message, feedback, follow-up). |
| **Jobs** | `j` | Every ticket: thread, the job's own **process tree** (who started whom, with state and cost per process), changes with diff and undo, timeline with **replay** (the tree and the thread as they were at each moment). Plans to approve, questions to answer, pause/resume/stop, budget, rating, attachments, archive. |
| **New job** | `n` | Write the task, attach files, pick a project or let routing decide (shows live which lead the rules would pick), lead effort, start after the limit resets. The `$ new job…` box in the dock does the same. |
| **Messages** | `m` | Each team's room: what teammates say to each other, and questions you ask a whole team. |
| **Memory** | `y` | What every agent has learned, by team. |
| **Library** | `l` | Each team's documentation as a file browser, with the library check and tidy-up. |
| **Terminal** | `t` | `ps`, `jobs`, `open <pid\|#job>`, `kill <pid>`, `new <text>`, and every office script (`count`, `find-def`, `call-sites`, `diff-files`, `route`…). |
| **Usage** | `u` | Plan limits (also in the top bar), pace, estimated window size, spend by day, team and model. |
| **Tokens** | `k` | Every model call on this machine (your Claude Code chats, every agent, tests), with the exact token counts from the API: by kind (fresh input, cache write 5 min / 1 h, cache read, output, thinking, web searches), by day, hour, weekday, source, team, agent, role, job, project, model, main thread vs subagents, service tier and stop reason. Filters for all of them; click a day or a row to filter. **Cache read** shows what every call re-read from the prompt cache: by source and in detail (each tool's results, Claude's own Write/Edit text, the fixed system prompt and tools, listings, reminders, your messages; spread over each call's exact cache read), by context size with what starting fresh at 100k/150k/200k/300k would have saved, by model with its price, cold reloads, and the single items that cost the most to carry (size × number of calls that re-read them); every chat has the same breakdown. **Context** shows what filled the context (each tool's results, Claude's own Write/Edit text, CLAUDE.md, skill and tool listings, reminders, your messages, the fixed system prompt and tool definitions) and the biggest single items. **Sessions** and **Every call** list everything; open a session for a bar per call and, per call, the exact usage and cost, what entered the context since the previous call, what the context held, and which tools Claude used. Long chats right now, Jev's OpenRouter calls, and **Save as CSV** (one row per call, to ~/Downloads). |
| **Health** | `h` | System, Claude login, leads' sessions, script use, problems, self-test, server log. |
| **Settings** | `,` | Roles, models, instructions, projects and routing keywords, new teams. |

`Ctrl/⌘+K` opens the launcher (apps, jobs, processes, actions); `?` lists the keys; arrow keys move through
processes and jobs, ←/→ fold the tree. Notifications: 🔔 desktop notifications, 🔊 sounds; toasts always.

## ARMS (Apps, Routines, Memory, Skills)

Built from the *ARMS Agentic OS v2* guide: twelve levels, three per part. The **ARMS** app (`a`) shows the checklist
with what's done (it checks itself; you can also tick by hand) and an **Approvals** list: anything that changes your
Claude Code setup (`~/.claude`) waits there until you approve it, and the old file is backed up first.

| | Level 1 | Level 2 | Level 3 |
|---|---|---|---|
| **Skills** (`s`) | Catalog of every skill by type (database, artifact, procedure), size in tokens, uses. **Run** any skill in the background with `claude -p`, model and effort next to the button, a report per run; save it as a run button. New **database skill** (references + wildcards: 8 of 10 follow the references, 2 are wildcards) and **artifact skill** (HTML brand book, artifacts inbox at `/artifacts/`, `scripts/artifacts-index.js`). | **Model routing**: pin fixed-step skills to a model (`model:` in SKILL.md). Everything else, skills and sub-agents, is decided by **Jev** (`typesafe/jev-router` via OpenRouter, 4 s timeout) with the EV script as fallback. Every pick is logged with time and cost (`data/arms/routing.jsonl`), with an on/off switch. | **Teach**: feedback on a skill's output → Claude finds the principle and folds it in (sharper, not longer); you see the diff first; `CHANGELOG.md` records what changed and why. |
| **Routines** (`r`) | Scheduled jobs, **active** (always hands you the result) or **passive** (answers `NOTHING TO FLAG` and archives itself silently unless something is worth your attention). | Cost per routine this week, most expensive first; **caps** ($/week; a capped routine skips runs and tells you); **Optimise** asks the lead to cut the fat and show before/after. | **Recos** (`c`): every Friday a script finds jobs you did by hand 3+ times (Claude Code history and Agentic OS jobs) and repeated corrections; pick cards into a cart, copy it or set them up. |
| **Memory** | **Map**: CLAUDE.md becomes a map (global rules kept, WORK notes moved word for word to `~/.claude/departments/work.md`, routers for personal projects and Agentic OS); leads get their area's router in their instructions. Image captions per folder with a cheap model. | **Compaction rules** in CLAUDE.md; **cache report** (cold reloads over 30 days and whether keep-warm pays); optional **keep-warm** pings every 50 min for up to 4 h; cache state in the status line and on each lead. | `/note` (park feedback in the skill's own `NOTES.md`, apply later on a small model) and `/calibrate` (save a lesson, link memories, fix the skill it belongs to); repeated corrections appear in Recos. |
| **Apps** | `/search-connectors`: maker's tools → community CLI → API → MCP, lightest first, keys in `~/.config/agentos/keys/`. | **Usage mod**: a Claude Code status line with 5-hour/weekly limits and cache warm/cold (no tokens). | **Review** micro app (`v`, own window, `/review`): approve finished jobs with comments on the answer and every changed file, copy comments or send them to the lead, saved as you type; built on the shared UI parts library (`public/ui/parts.css`, `parts.js`). |

**Jev needs an OpenRouter key**: put it alone in `~/.config/agentos/openrouter.key` (`chmod 600`), never in chat.
Without it the EV script decides. Test: `node scripts/jev.js "list the files in a folder"`.

**Security**: the backend only listens on this machine, requires the app token on every request, and checks the Host
and Origin headers, so no web page or other device can reach it.

## Who works here

| Resident | Role | Room |
|---|---|---|
| **God** | Dispatcher — reads every ticket and hands it to the lead who owns it; never does the work | Front Desk |
| **Atanas** | WORK Tech Lead — everything in ~/repo/baseline | WORK Team |
| **Renko** | Personal Projects Lead — ~/Personal/Projects, this office, research, everything non-WORK | Personal Projects |

Residents are **always alive**: each is one long-running `claude` process that keeps its memory
across tickets, has an inbox, and restarts itself (resuming the same session) if it dies.
"Reset session" on their character sheet starts a new conversation (their memory file stays).

Leads decide per ticket whether to work alone or hire **sub-agents** — roster specialists
(WORK analysts, implementer, reviewers, researcher) or a **custom** specialist they invent on the spot.
Staff are permanent: they appear under their lead in the process tree and move under whoever starts them while they work.

## How a ticket flows

1. You send a ticket. If you picked a project in the dropdown it goes **straight to that project's lead**;
   with "Let the manager decide" it lands in God's inbox and God `assign`s it to Atanas and/or Renko.
2. The lead works it, hiring sub-agents with `delegate` if they want.
3. **The lead answers you directly** on the ticket. God never rewrites answers.
4. Reply on the ticket to follow up; it goes to the lead who owns it. Or message a lead directly from their sheet.

## Models, effort and budgets

- Leads run on Opus 5.5 (`defaults.residentModel`) at **high** effort by default (`residentEffort`).
  Each ticket can set the lead's effort: the "effort" box next to the project picker, else the project's
  `leadEffort` in `projects.json` (WORK baseline: xhigh), else God's choice when it routes the ticket.
  A lead switches effort by restarting its process on the same session, so it keeps its memory.
- God only routes, so it runs on Haiku at low effort with a fresh session every ticket
  (`roles.manager.model`/`effort`, `defaults.rootFreshEvery`). Picking a project skips God entirely; the
  ticket box remembers your last project.
- **Sub-agents' model and effort are chosen by an expected-value model** (`scripts/choose-model.js`), not by the
  leads. For each task it:
  1. rates the difficulty (easy / medium / hard) from the role's usual setting and words in the brief;
  2. estimates each option's chance of success (haiku/low … opus/xhigh) from a starting guess updated with this
     office's track record for that role (done or not, and 👎 ratings);
  3. estimates the cost from what that role really cost on that model;
  4. picks the highest **EV = chance × value − cost − (1 − chance) × (retry + damage of a wrong result)**.
  The value of a good result is `defaults.taskValueUsd` (easy $1, medium $4, hard $12). When a usage limit is above
  70%, costs weigh more. The choice and its numbers appear in the job thread (hover the model in the job's process
  tree) and go back to the lead with the results. A lead can override only with `pin_model` and a stated reason, and
  never above its own model. Try it: `node scripts/choose-model.js work-implementer "fix the Spain free-round history"`
  (or `choose-model …` in the Terminal app).
- Every ticket shows its cost. (Claude reports a running session total on each turn; the office
  records only the difference, so a lead's long session isn't counted again on every ticket.) At its budget (`defaults.ticketBudgetUsd`, $5) new sub-agents pause and the
  ticket asks you to raise it (+$5 / +$10) or stop. Sub-agents report cost when they finish, so a ticket can
  overshoot a little.

## Working with tickets

- **Attach files**: 📎, drag them into the ticket box or paste a screenshot. Agents get read access to them
  (`data/uploads/`), and images are shown to them. Follow-ups can carry files too.
- **Questions to you**: a lead can call `ask_user` when the answer changes what it would do. The ticket shows
  "❓ needs your answer" with clickable options; your next reply on the ticket answers it.
- **Changes tab**: every file an agent edits with Edit/Write/MultiEdit is saved before its first edit on that ticket.
  The tab shows the diff per file, with **Undo** (per file or all), which restores the saved copy. It never
  touches git. Agents are told not to edit with sed or shell redirection, because those edits can't be tracked.
- **Timeline tab**: who worked when and what each stretch cost.
- **Rate the answer** 👍/👎 with a note: it goes to the lead as feedback for their next ticket.
- **Search**: the box above the list filters tickets. Agents use `search_tickets` to check earlier work
  (including your ratings) before starting.
- **Start after the 5-hour limit resets**: the ticket waits as *scheduled* and starts a minute after the reset
  (or press **Start now**).
- **Archive** closed tickets to hide them; "Show archived" brings them back.

## Scripts first

Anything mechanical is done by a script in `scripts/` (Node, no dependencies; each one also works from the
command line), never by an agent:

| Script | Does |
|---|---|
| `count` | exact line / word / byte counts (same as `wc -l`) |
| `find-files` | find files by name, skipping build and .git folders |
| `find-def` | where a class, function, macro or alias is defined (a folder or a single file) |
| `call-sites` | every use of a symbol, grouped by file, without its definitions and comments |
| `diff-files` | byte-for-byte compare (sha1), whitespace-only check, unified diff; folders too |
| `xml-check` | XML well-formedness (xmllint) |
| `changed-files` | uncommitted changes in a git repo (read-only) |
| `route` | which lead a ticket goes to by the routing rules |
| `library-check` | duplicate notes and `file:line` references that no longer match the code |
| `weekly-report` | a team's week: tickets, costs, ratings, staff, problems |

- **Agents** call them through the `script` tool, which every agent has, God included. A hook blocks shell commands
  a script already covers (`wc`, `find -name`, `diff`/`cmp`, `xmllint --noout`, `git status`, `git diff --stat`) and
  tells the agent which script to call. The Health sheet shows script runs and redirected commands per agent. Agents
  note repeated mechanical steps on their library's `script-ideas` page so they can become scripts.
- **Routing**: tickets without a project go through `route` first. A path or keywords that clearly belong to one
  lead send the ticket straight there (projects have `keywords`, editable under ⚙; "Personal projects" also uses
  its subfolder names). God is asked only when nothing matches or two leads match.
- **Libraries**: the "All pages" list at the end of each INDEX.md is kept up to date by `library-check` after every
  note. A tidy-up runs the check first and wakes the lead only for duplicates or stale references.
- **Weekly review**: `weekly-report` writes the report. The lead is involved only when something went wrong (a 👎,
  an unfinished ticket or teammate task, a cost spike), and then only to find the cause.

## Plans, pausing and reviews

- **Plan approval**: before big work (two or more teammates at once, any opus teammate, or more than
  `defaults.planOverUsd`), a lead must `propose_plan`: steps, who does what on which model, and a cost estimate.
  The ticket shows the plan with **Approve** (optionally with changes typed in) and **Reject**. Approving raises the
  budget to 1.3× the estimate if needed. The office refuses a big delegation until the plan is approved
  (`defaults.planApproval: false` turns this off).
- **Pause / Resume** a ticket in progress: the lead and its teammates stop immediately (teammates' unfinished work is
  dropped and redone after resuming; the lead keeps its own conversation). Paused work doesn't count against anyone's
  track record.
- **Weekly review**: every Monday from 09:00 (`reviewDay`, `reviewHour`) each team with tickets that week gets a
  report as a ticket, written by `weekly-report` (free). Only when it flags a problem does the lead look into it,
  update its library, memory and teammates, and add what it changed. "Weekly review" on a lead's sheet runs it now.
- **Fresh sessions**: a lead's conversation is re-read on every turn, so it gets more expensive as it grows. At 150k
  tokens or 7 days (`refreshContextTokens`, `refreshDays`) the lead writes what matters into its memory and starts a
  fresh session. "Fresh session" on its sheet does it now; "Reset" restarts without saving.

## Teams & projects (Settings)

Change each role's usual model and effort and its instructions, add roles to a team, add or edit projects (owner and
default lead effort), and create a **new team**: a new lead process under God, with its own library and message room, which God
starts routing to. Leads pick up changes when they're next idle. Roles that come from `~/.claude/agents/*.md` keep
their instructions there.

## Health & self-test

**Health** (top bar dot: green/amber/red) shows each lead's process and session size, the Claude login, problems
from the last 48 hours, tasks not completed, and the server log. **Run self-test** sends one small ticket through the
whole office (God's routing, search, a teammate, a question to you, a file edit, undo) and checks each step
(about $0.25, under a minute; the first run hires a cheap Researcher who stays).

## Token saving rules

- **Long chats**: the status line shows the context size of your chat (`ctx 297k`), yellow from 150k and red from 300k
  with the cost of each message; Agentic OS also notifies you at 300k, 500k and 800k. Finish the task, then `/clear` or `/compact`.
- **Agents edit, they don't rewrite**: an agent's Write that would re-send an existing file of 60+ lines to change a
  few of them is refused once with a pointer to Edit; sending the same Write again goes through (a real rewrite).
- **Leads start fresh for every ticket** (`leadFreshPerTicket`), so earlier tickets don't ride along in every call; their
  memory file carries over, and a later follow-up on an old ticket gets the lead's earlier answer and your recent messages
  as context. Within a ticket, a lead is refreshed once its context passes 80k (`refreshContextTokens`).
- **Agents read in parts**: a whole-file Read of a 500+ line file is refused once with directions (find-def, call-sites,
  Grep -n, then Read with offset/limit); the same Read again goes through.
- **Weekly report per team** lists each teammate's calls, cost, cache-read cost and average context against the
  previous period, and flags large or fast-growing contexts.
- **Agents load only the tools they may use** (`--tools`), which removes about 15k tokens of tool definitions from every call.
- **Agents don't use your Claude Code memory**: they run with auto-memory off, so they neither read nor write
  `~/.claude/projects/*/memory`; they keep their own memory in `data/memory`.
- **Model routing**: Jev picks first (6 s limit). A near-identical task for the same role reuses Jev's earlier decision
  (free, instant, 7 days). Your own track record overrules Jev when it clearly disagrees: Jev's model failed this role
  most of the time (4+ tasks), or a cheaper model already succeeds 90%+ (5+ tasks). Every pick is joined to how the task
  went (done, cost, time, your rating, sent back, retried); ARMS shows Jev vs EV vs overrides, and each lead's weekly
  report has the same table for their team (`scripts/routing-report.js`).
- **Testing approvals safely**: ARMS → Approvals → *Test all of them safely* (or `node scripts/arms-selftest.js`)
  runs the memory map, skill installs, status line, keep-warm pings and Recos setup in a throwaway HOME with a fake
  `claude`, and checks that your real `~/.claude` didn't change.

## Usage limits

Every agent run carries Anthropic's report of your plan's limits: how much of the 5-hour window and the
weekly window is used, and when each resets. The top bar shows both; click it for the **Usage limits** sheet:
- reset times, plus a warning when the last hour's pace would hit the limit before the reset;
- estimated size of each window, in API-equivalent dollars and tokens. Anthropic reports only percentages,
  so the office learns the size from how far the bar moves while it spends. Other Claude use moves the same
  bars, so the estimates lean low;
- what each ticket cost as a share of each window (also on the ticket sheet and under the ticket box).

When a window reaches 85% (`defaults.limitPauseAt`), new work pauses: running turns finish, but nothing new starts.
A banner and a notification ask you to **Continue anyway** (it asks again 10 points later) or wait; work resumes
by itself after the reset.
Below that, the sheet shows office spend for the last 14 days, by team and by model.

Refresh makes a tiny Haiku call (about $0.004); the server also does this once at startup. Data lives in `data/limits.json`.

## Shared files

When two agents edit the same file, both get an automatic heads-up (and a note from each other), and they
decide together who changes what. `colleagues` shows who is editing which files.

## Agents talking to each other

Every agent has `colleagues` (who is here), `send_message` (a note) and `ask` (a question that waits
for the answer). Mail reaches a busy agent through a PostToolUse hook (`mail-hook.js`) right after its
next tool call; an idle lead gets it as a new turn. A lead who is waiting on its sub-agents is woken by
a question: `delegate` returns early, they answer, then `wait_for_team` resumes waiting. Conversations show in the
Mind feed, the Messages app and the job thread.

## Team libraries

Each team has documentation its agents read before deciding, and add to with `add_to_team_docs`
(the server writes the page, so read-only agents never get edit rights):

- `teams/work/` — INDEX points at your `~/.claude/docs` knowledge base, plus pages agents add
- `teams/personal/`, `teams/front-desk/`
- `teams/personal/projects/<Folder>.md` — **project handoffs** (Personal Projects only): when Renko finishes work on a
  project, or you wrap up, it saves the project's current state and a summary of the chat with `save_project_handoff`.
  Any later ticket that names the project (`DianisCommunication`, `dianis communication`…) starts with that handoff,
  so the work continues where it stopped. Shown in the Library under "Project handoffs"; the last 12 sessions are kept
  (`defaults.handoffSessions`).

Click the bookshelf in a room to read its library. Each lead **tidies** its library on its own after
6 new notes (`defaults.tidyAfterNotes`), when free: merging duplicates, verifying doubtful notes against the
code, and keeping INDEX.md current. It never edits the reference docs. "Tidy now" in the library forces it.

## Config

- `roster.json` — residents, roles, tool presets, `alwaysDisallowed` (no commit/push/sudo/apt upgrade/rm -rf),
  team libraries. Changes apply to the next agent started; residents pick them up on restart.
- `projects.json` — known projects, shown in the ticket box (picking one skips God) and to God for routing.
- `data/` — agents, tickets, inboxes and every agent's activity log (survives restarts); `uploads/` (attachments),
  `snapshots/` (files saved before edits, for undo), `limits.json`, `backups/` (old copies from upgrades).
- Env: `WORKPLACE_PORT` (4747), `WORKPLACE_MAX_RUNNING` (8 concurrent sub-agents).
