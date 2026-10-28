# Changelog

All notable changes to Agentic OS are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Telegram approvals: plans, questions, commands and edit-access requests arrive in a linked Telegram chat with the
  same buttons as the window; optional notes when a job finishes (Preferences → Notifications, `lib/telegram.js`).
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
