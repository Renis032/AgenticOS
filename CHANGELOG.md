# Changelog

All notable changes to Agentic OS are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Team skills on delegate** (`skills` on `delegate`, `lib/skills.js`): a lead hands any teammate up to three team skills.
  Each is loaded into the teammate's prompt with its `source:` agent file and `preload:` docs. A teammate is role plus
  skills: reused with its own memory and track record, and the model choice keys on both. Skills may also be `for: <role>`.
- **README**: a good-practices overview, what's new and new screenshots.
- **Outside text is fenced** (`lib/untrusted.js`): GitHub issue and email jobs are marked; on them web tools and network commands are off and every command asks.
- **Knowledge search** (`lib/retrieval.js`, `search_knowledge`): BM25 merged with Ollama embeddings when available, scoped to the agent's team; top passages join a new job's brief.
- **Retries and a circuit breaker** (`lib/resilience.js`) for temporary API failures.
- **Job priority and a limit on lead jobs at once** (`lib/scheduling.js`, `defaults.maxLeadJobs`, default 4).
- **A trace per job** (`lib/tracing.js`, `/api/tickets/:id/trace`, OpenTelemetry JSON export on the Timeline).
- **Eval gate on instruction changes** (`lib/evals.js`, `defaults.agentEvalOnChange`): a confirmed regression can be rolled back from Health.
- **Decision record** (`lib/audit.js`, `data/audit.jsonl`): a hash-chained log of approvals, shown in Health.
- **Talk to the lead** (Messages, or Talk on a lead's panel): a chat that answers questions from the lead's memory and jobs
  without interrupting it, and drafts new jobs or changes to its jobs for you to confirm (`lib/lead-chat.js`, `/api/teams/:lead/talk`).
- **Meaning view in the Brain**: similar knowledge sits together, by Ollama embeddings or, without them, shared words
  (`lib/similar.js`, `/api/brain/similarity`).
- **Deeper**: a composer button that rewrites a draft as a deeper version of the same task, for review before sending
  (`lib/deepen.js`, `/api/deepen`).
- **Overnight mode**: an Overnight page with a queue, a spending cap, a finish time and *Work while I sleep*. A job that
  needs you waits and frees its slot, usage limits hold new work without ending the run, and reaching the cap pauses jobs
  in progress. One report in the morning, also on Telegram (`lib/overnight.js`, `/api/overnight`).
- **Live preview with click-to-fix**: a Preview tab on every job. Point at an element and comment; the element and a
  screenshot reach the lead as a follow-up. Runs through a proxy on `localhost`, with loopback targets only. New lead tool
  `show_preview` (`lib/preview.js`).
- **Job chains** and **forks**: *Then…* and *Start after* start a job when another is done, with its result; *⑂ fork*
  starts a job from any moment of a thread (`lib/job-links.js`).
- **Change walkthrough**: a guided tour of a job's changes in reading order, on the Changes tab (`lib/walkthrough.js`,
  task `walkthrough` in Preferences → Models).
- **Acceptance criteria on plans**: `propose_plan` now requires `done_when`, and the plan shows them in the window and
  on Telegram before you approve. The lead reports on each with the new `report_evidence` tool (`POST
  /api/report-evidence`) and is sent back once if it answers without doing so. The job shows each criterion with its
  evidence. The reviewer now judges them, and jobs with criteria are reviewed even when their checks pass.
- A message to a job that hasn't started now joins its request instead of starting it early.
- The keep-warm ping no longer stops the whole office when a session's folder has been removed.
- **Other model providers** for the office's one-shot tasks (Preferences → Models): Ask the office, the reviewer for
  jobs without checks, the new-lead wizard, talking a lesson over, and routing a job the rules cannot place. Each can
  use OpenAI or anything OpenAI-compatible (OpenRouter, LM Studio, llama.cpp, vLLM), Google Gemini, or Ollama on this
  computer, with its own model picked from the provider's live list; leads and specialists stay on Claude. A provider
  that fails falls back to Claude unless that is turned off, and each task shows its calls, failures and speed. A
  routing model must name a real lead, or God routes the job as before. Keys are checked before they are saved and
  kept in `data/providers.json` (readable only by you); a local model's `<think>` text is left out of its answers.
  API: `/api/providers`, `/api/providers/<openai|gemini|ollama>`, `/api/providers/task/<task>`, `/api/providers/test/<task>`
  (`lib/providers.js`; `oneShot(prompt, model, effort, task)` in `lib/ask-office.js`).
- **Sandboxed projects**: tick *Sandbox* on a project in Teams & roles and its jobs are worked on inside Docker. The
  job gets its own desk (a twin of its lead, `<lead>~s<job number>`), and every agent on it runs in a container that
  sees only the project folder (or the job's worktree) at its real path, the team library, and read only the office's
  agent tools, the job's attachments; the rest of the home folder is not there. Its terminal commands and checks run
  in a throwaway container too. Agents run as you (files stay yours), the edit hook and undo work as usual, an API key
  reaches the container by name only, and the Claude login is copied into the desk's own home. Without Docker or the
  image the job pauses and says what is missing; it never falls back to running on the computer. The image
  (`sandbox/Dockerfile`, built from Preferences → Agents & teams → Sandbox) matches your Claude Code version.
  `npm run test:sandbox` runs a real sandboxed job and checks what the container could see. Known limit: the agent
  tools read the office's token, so a sandboxed agent can too (as any agent can today). Docker from snap only sees
  visible folders in your home directory; the office says so when that gets in the way. (`lib/sandbox.js`)
- The server logs when something holds it up for more than half a second (`event loop blocked for … ms`), and the
  window check keeps the server's log next to its screenshots.
- **Gmail connector** (Preferences → Connectors), signed in with Google OAuth: *Connect Gmail* opens Google's sign-in in
  your browser, which comes back to the office on a loopback address (PKCE and a single-use state, so only a sign-in the
  office started can finish; tokens refresh by themselves and are kept in `data/oauth.json`, readable only by you).
  Permissions are Gmail read-only plus compose for drafts. Emails you put under a label (default `agentos`) open as
  jobs, optionally on one project, without their quoted history and with a plain notice that the email is data from
  outside, not instructions. *Draft a reply* on a finished job saves its answer as a reply draft in the same Gmail
  thread; nothing is ever sent, marked or deleted. Needs a Google OAuth client (type "Desktop app"), entered in
  Preferences or shipped by a build through `AGENTOS_GOOGLE_CLIENT_ID` / `_SECRET`. API: `/api/gmail`,
  `/api/gmail/client`, `/api/gmail/connect`, `/api/gmail/settings`, `/api/gmail/poll`, `/api/gmail/job/<id>/draft`;
  the shared sign-in is `lib/oauth.js` (`/oauth/<provider>/callback`), ready for more providers.
- **GitHub connector** (Preferences → Connectors), over GitHub's REST API with a fine-grained token (no `gh` needed; a
  signed-in `gh`'s token can be used instead of pasting one). Projects are linked to their repositories from
  `git remote`. Issues with a chosen label (default `agentos`) open as jobs on their project, and any issue can be
  imported by number; a routine can run *when CI fails on GitHub*, told which Actions run failed. From a finished job,
  **Comment on #N** posts its answer on its issue and **Open draft PR** pushes the files it changed to a new branch
  `agentos/job-N` and opens a draft pull request that closes the issue — only on your click, never by an agent. The
  commit is built in a throwaway index from your HEAD, so your branch, index and working files are never touched, and
  the token reaches git only through the environment. One repository the token cannot reach no longer stops the others.
  API: `/api/github`, `/api/github/link`, `/api/github/poll`, `/api/github/import`, `/api/github/job/<id>[/comment|/pr]`
  (`lib/github.js`).
- **Hardware while jobs run**: each job has a *Hardware* tab with what its own processes used — its agents and the
  tools they ran, its terminal commands and its checks — next to the whole computer: CPU, memory, the hottest CPU
  sensor and, with an NVIDIA card, the GPU, as charts with a hover readout and a table view, plus peaks and averages.
  Health shows *This computer* over the last 15 minutes. Sampled every 2 seconds while a job has processes (every 15
  otherwise) from `/proc` on Linux and `ps` on macOS, without starting anything except `nvidia-smi` when present. A
  job's samples are kept in `data/hardware/<job id>.json` and its peaks on the job (`t.hw`).
  API: `GET /api/hardware`, `GET /api/hardware/job/<id>` (`lib/hardware.js`).
- **Share a report** (Today → *Share a report*, or Ctrl K): what the team did over the last 7–90 days, for all teams
  or one team or project — done, not finished and in progress, by team and by project, with what each took and cost.
  Save it as a standalone HTML page (light and dark, prints cleanly) or copy it as Markdown. Costs and answer summaries
  can be left out; nothing from inside a job goes in beyond the start of its answer, and anything that looks like a key
  or password is replaced by [redacted]. API: `GET /api/reports?days=&lead=&project=&costs=&summaries=&format=json|html|md`
  (`lib/reports.js`; `redact()` in `lib/secrets.js`).
- **Triggered routines**: a routine can run *when something happens* instead of on a clock — when a job fails, when a
  project's checks fail (optionally only on one project), or when files change in a folder (changes are gathered for a
  minute, hidden and temporary files ignored). Each run is told what set it off: the failed job, its checks' output and
  its last answer, or the files that changed. A cooldown (15 minutes unless set) and the weekly cap bound a burst, and a
  routine's own jobs never set routines off, so they cannot loop. Also **every weekday** (Mon–Fri) as a schedule.
- **Team templates** (Teams & roles → New team lead → *Start from a template*): ready-made teams to start from — an
  Indie SaaS team, a Content studio, a Research desk and a Bug fixing team, each a lead with instructions, routing
  keywords and three specialists. A template opens in the wizard's review form, so every field can be changed before
  the lead is created; a name already in use is swapped for a free one. *Save as template* on any team keeps it as
  your own (`data/team-templates.json`). API: `GET/POST /api/config/team/templates`, `GET …/templates/<id>/draft`,
  `DELETE …/templates/<id>` (`lib/team-templates.js`).
- **One-command install** (`install.sh`, `curl -fsSL …/install.sh | bash`) for Linux, macOS and WSL: checks git, curl,
  Node and Claude Code (offering Anthropic's installer for Claude Code), clones or updates `~/agent-workplace`
  (`AGENTOS_DIR`), runs setup and opens the office; never uses sudo. `AGENTOS_OPEN=0` for unattended installs.
- **A guided first job**: *Start your first job* on Today fills in a read-only one for your first project (what it
  does, how to run and test it, three improvements), so a new user sees a whole job in a minute without risk.
- Setup knows macOS and WSL: no GTK window asked for there (the office opens in the browser), `brew` hints on macOS,
  and the Claude Code hint names its installer. `./agentos stop` works on macOS (no `/proc`) through the shutdown API.
- **Desktop app** for macOS, Windows and Linux (`desktop/`, Electron 45): runs the office's server on Electron's own
  Node, so no Node install is needed, and opens the same window with a tray icon, notifications, the same closing
  choices and start at login. `npm run dist:linux` / `dist:mac` / `dist:win` build installers. An installed app keeps
  the office in the user's app-data folder and refreshes only its code on update. Agents and their commands never
  inherit `ELECTRON_RUN_AS_NODE`, so an Electron project under test still starts as Electron.
- **Browser mode**: `./agentos --browser` (or `-b`) opens the office in your default browser on macOS, WSL or any
  Linux; without the GTK window installed, `./agentos` does this by itself. The browser gets in with a one-time launch
  code valid for a minute (`POST /__launch`, token required), so the app token never appears in a URL or history.
- **Account** in Preferences: agents can sign in with an Anthropic API key instead of your Claude Code login. The key
  is checked with Anthropic before it is saved, kept in `data/auth.json` (readable only by you) and never shown again
  beyond its last four characters. With a key, billing is per use: the 5-hour and weekly meters give way to today's
  spend, no plan window holds new work, and the daily spending limit is the guard. Switch back to the login any time
  without losing the key. API: `GET/POST/DELETE /api/auth`, `POST /api/auth/mode` (`lib/auth.js`).
- **Needs you** in the sidebar (key `W`): every plan, question, command, edit access, budget stop, change to apply,
  skill proposal and lesson waiting for you, with a badge counting them. Anything newly waiting that the server did not
  already announce (changes to apply, an interrupted job) now raises a notification too.
- Talk a lesson over: **Discuss** on a lesson draft lets you explain what you mean; the lead answers and rewrites the
  line, and gets your explanation as feedback once you keep it. API: `POST /api/agents/<id>/lesson-drafts/<lid>/chat`.
- Rating requests can be cleared: *Don't ask for this job* under the rating box, *clear* on Today's reminder, or
  Preferences → Notifications → *Ask me to rate answers* to turn them off.
- The *Update ready* chip in the title bar is one button: click it and the office restarts onto the new version as soon as
  every agent is idle (after checking it), and the window reloads by itself.
- Review opens inside the main window instead of a separate one, in the window's theme; its *open in Agentic OS*
  link opens the job there.
- Every toast has an × to dismiss it (on an undo toast it runs the action now).
- **Send now** on a queued follow-up: if its agent is busy on that job, the message reaches it after its next step
  instead of after the whole turn; if the agent is on another job, it moves to the front of the line.
  API: `POST /api/tickets/<id>/send-now`.
- Right-click **Jobs** in the sidebar → *Mark all as read* clears the “N new” badge.
- Undo/Redo in every message box (job thread, new job, agent chat, team chat, Ask the office): buttons, Ctrl+Z and
  Ctrl+Shift+Z / Ctrl+Y. It also brings back a message the box cleared on Send.
- Standing instructions for a lead: in Processes, **Keep as instruction** saves something you tell a lead once
  ("when you fix a bug, add a short brief on why this fix and a commit message like the others"); it goes into their
  system prompt on every job until you remove it from the new *Instructions* tab. A lead mid-session gets the change on
  its next message. API: `/api/agents/<id>/standing`.
- Lessons to review show why: `add_lesson` now requires `reasoning` (what happened and why the lesson would have
  prevented it), and the draft records what made the office ask; both appear on the review card.
- `repo-state --log N`: the last N commit subjects, so a lead without `git log` can match the repository's style.
- The office in your own Claude Code sessions: a read-only MCP server (`lib/mcp-office.js`) with `office_recall`,
  `office_job` and `office_project`, backed by new no-model endpoints `/api/office/facts`, `/api/office/job` and
  `/api/office/project`. Add it with `claude mcp add --scope user agentos -- node ~/agent-workplace/lib/mcp-office.js`.
- A reviewer for jobs without checks: one Sonnet call reads the request, answer, diff and commands and says PASS or
  FAIL with concrete problems; a FAIL goes back to the lead, and concerns that remain are flagged on a job closed done
  (Preferences → *Review jobs without checks*, `reviewAnswers`, on when files changed by default).
- Telegram approvals: plans, questions, commands and edit-access requests arrive in a linked Telegram chat with the
  same buttons as the window; optional notes when a job finishes (Preferences → Notifications, `lib/telegram.js`).
- Telegram control: start jobs (`/new`, or just send the task and confirm), follow up (`#12 …` or reply to any
  message about a job), job cards with Pause / Resume / Stop / Start now that update live as the job moves, 👍 / 👎 on
  finished jobs, notes when a job fails, and `/jobs`, `/job 12`, `/ps`, `/usage`, `/waiting`, `/projects`, `/help`.
- Second desks (twins): a busy lead hands a job for another ticket to a temporary twin with the same role and
  memory, so new jobs don't queue behind long ones (`leadTwins`, `twinIdleMinutes`). Each queued job reports what it
  is waiting behind and its place in line.
- A shorter sidebar: the six daily apps stay; Insights and Tools fold away.
- Needs you: plans, commands, questions and edit-access requests in one compact panel above the reply box; long plans
  show their first steps, and each decision appears once.
- New job shows live who will take the job and why, at what effort, and what similar jobs cost; templates for the usual
  kinds of job, plus your own.
- Today: an activity feed, job costs over the last 14 days, and suggestions (stale projects, failed jobs, answers to rate).
- A five-step tour of the real controls, and friendlier empty states.
- Ask the office (Ctrl+J): questions about the office answered on Haiku from facts the office gathers itself (jobs,
  cost breakdowns, memories, libraries, handoffs), citing jobs you can open.
- Suggested answers: a question asked without choices gets one-click answers from its own wording (yes/no, a list in
  the question, "A, B or C?"), in the job, on Today and in Telegram; keys 1–5 pick one (`lib/suggest-answers.js`).
- Lesson review: lessons the leads write after a job went wrong wait on Today until you keep, edit or drop them; only
  kept ones reach the agents (`reviewLessons`, on by default).
- New team lead wizard: explain the lead's purpose in plain words; a draft of its routing, keywords, instructions and
  specialists to review and edit before creating it (`lib/lead-wizard.js`).
- Checks before done: a project's or job's checks run by the office after the lead answers; real exit codes decide,
  failures go back to the lead, then fail the job with the evidence (`lib/verify.js`).
- Interrupted jobs resume with what already happened, so nothing is done twice; stuck agents are flagged with Ask for
  a status and Restart; stopping kills an agent's whole process group (`lib/recovery.js`, `lib/kill-group.js`).
- Separate workspaces: jobs on the same git project work in their own worktrees, reviewed and applied without commits
  (`lib/workspaces.js`).
- Access and limits: web access off, folders agents may always edit, your own never-run and run-without-asking command
  lists, and a daily spending limit.
- Project memory: instructions, decisions, known failures and job outcomes per project; each job gets only what is
  relevant (`lib/project-memory.js`, tools `remember_for_project` and `recall_project`).
- Cost per successful job in Usage, per lead and per project (`lib/outcomes.js`).
- `npm run screenshots` regenerates the README screenshots from the demo office; the demo no longer reads your real
  project folders or notes, and seeds handoffs and project memory.
- Looks: Champagne (the default), Graphite (flat, neutral greys, system blue) and Midnight (navy, teal), each in
  light and dark (Preferences → Appearance → Look, `public/ui/themes.css`).
- Agent answers render *italics*.
- Inline diffs in the conversation, work steps folded into "who worked how long", undo toasts instead of confirm
  dialogs, plan costs as a share of the 5-hour window, plan progress in the job list, lead avatars with status in the
  title bar, rate a finished job from its toast, drop files anywhere, keys for Needs you (G, X, I, Alt+↑/↓), a back
  button on narrow windows, shapes for job states, a getting-set-up checklist, and loading placeholders.
- Accessibility: keyboard access to every clickable row, visible focus, labels on icon buttons, WCAG AA text contrast,
  and respect for the system's reduce-motion setting.

### Fixed
- **Rehiring a custom specialist with new `instructions` now replaces the old ones.** They used to be dropped without a
  word; the change is now on the teammate's record and the job thread says "new instructions".
- **The office no longer freezes for seconds at a time.** A profile of the server found work that held up every
  request: the ARMS checklist grepped every Claude Code transcript (4+ s; now counted in the background every 10
  minutes), the Brain re-read all event logs on each view (now read once and then only what was added, keeping just the
  fields it uses), Tokens and the weekly review added up every transcript on the server's thread (now in a worker
  thread, `lib/usage-worker.js`), a job's Changes ran one `diff` per file on every view (now cached, and the first
  view runs them in parallel without blocking), the Projects board matched every job against every project on each
  request (now once per job), and the sandbox asked Docker synchronously (up to 13 s with snap's Docker). In a full
  window check the server went from 9–15 stalls over half a second (worst 14 s) to none.
- **Memory**: what only ever grew is now bounded — team batches nobody collected, who-edits-which-file records, long-chat
  warnings, and the new diff cache (1,500 diffs and 32 MB). Recent agent events kept in memory have very long fields
  trimmed (the whole event stays in the log on disk), specialists keep 400 instead of 1,500, and a specialist idle for
  half an hour gives its events back; on today's data that is 26 MB → 16.5 MB with everything loaded, and less as idle
  specialists let go. `npm run test:soak [rounds]` runs hundreds of jobs and live connections through a throwaway office
  and checks the heap, open handles and connections level off (`SOAK_SNAPSHOTS=1` compares heap snapshots to find a
  leak). `GET /api/health/memory` reports the server's memory.
- A twin desk's events, stop and message requests (`/api/agents/<lead>~2/…`) were refused because of the `~` in its name.
- The hook command given to every agent is quoted, so an office in a folder with spaces (an installed app's
  `…/Agentic OS/office`, or any path like `~/My Projects/agentos`) no longer breaks every agent's hook.
- Settings no longer breaks on a project whose checks are saved as one line (`"npm test ;; npm run lint"`).
- Long chats open at once: a job thread shows its latest 30 messages and a team room its latest 40. Scroll to the
  top or click **Show earlier** for the rest; what you were reading stays in place.
- The “N new messages” button over a thread no longer has blurry text (it sat on a half pixel).
- Opening a job could throw `undefined is not an object (evaluating 'h.past')` from the message box's undo history.
- ARMS: the "How picks turned out" table header no longer floats over the next card when the page scrolls; the
  Model routing card is full width when it has the table, and a table header inside a card no longer sticks.
- A retired second desk stayed in Processes for good, shown as *down* and *restarting…* like a crashed lead. It now
  shows **retiring…** while its process stops, then **retired** with when and why, and leaves the tree after three
  minutes (`lib/residents.js`, `lib/state.js`, `public/ui/os/processes.js`).
- Stopping a job God was routing could leave God shown as offline over its freshly started process, so mail to God
  failed until its next job (`lib/residents.js`).
- Colours written as `rgba(…))` with an extra parenthesis were ignored by the browser, so some tints never showed.
- Emoji with no font on the system (paperclip, thumbs, file, folder) drew as empty boxes; they are SVG icons now.
- A job that arrived while its lead was restarting for a fresh session waited instead of going to a second desk.

## [0.1.0] - 2026-10-28

First public version.

### Added
- The office: a dispatcher (God), permanent leads with memory and team libraries, and specialists hired per task,
  each a real `claude` process in one live process tree.
- Jobs with live progress, follow-ups, plans with cost estimates, questions, terminal-command approvals, per-job cost,
  notifications and reminders; undo for every file an agent changed.
- Routing rules that send jobs straight to the right lead without the dispatcher; quick questions get a lower effort
  automatically for faster answers.
- The window (WebKitGTK): Today, Jobs, Processes, Projects, Brain, Skills, Preferences, tray and start at login.
- Office scripts for mechanical work (search, show, outline, find-def, call-sites, repo-state, …), a hook that
  redirects shell commands a script covers, and team-only scripts kept in a team's own folder.
- `search` that skips media and huge files, so repositories with gigabytes of assets are searched in seconds.
- `./agentos setup`, a first-run wizard, and `./agentos demo`, a throwaway office with stand-in agents (nothing spent).
- Checks that spend nothing: `npm test` (syntax + API check) and `npm run test:ui` (window check); CI on every push.
- MIT license, contributing guide, security policy, issue and pull request templates.

### Fixed
- Creating a new team from the window failed with "agents is not defined".

[Unreleased]: https://github.com/Renis032/AgenticOS/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Renis032/AgenticOS/releases/tag/v0.1.0
