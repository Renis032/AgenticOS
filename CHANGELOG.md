# Changelog

All notable changes to Agentic OS are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
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
