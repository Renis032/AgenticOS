# The window and its apps

How the desktop window works and what each app does.

[← Back to the README](../README.md)

## The window

It is a desktop program: a native GTK window (`app/agentos-window.py`, Python 3 + WebKitGTK, both part of Ubuntu)
over a local Node backend. No browser, no web address, no phone access. The backend listens only on 127.0.0.1 and
answers only requests that carry the app token in `data/app-token` (readable only by you): the window, its own agents
and the `agentos` commands. Opening the address in a browser gets "Agentic OS only opens in its own window". Closing
the window quits Agentic OS; if jobs are still running it asks first: stop them and quit, or keep them running in the
background (reopen the window from the applications menu). `./agentos stop` ends everything. F5 or Ctrl+R reloads,
Ctrl +/− zooms. The window has its own title bar (drag it, double-click to maximize, window buttons from your
Ubuntu setting), a main menu (☰ or F10), **Preferences** (⚙ or Ctrl+,: theme, accent colour, text size, density,
sidebar, start-up app, what closing does, notifications, sounds, do not disturb, send key, and office settings like terminal commands, automatic plan approval and reminders…), a
**notification center** (🔔), right-click menus on jobs, native dialogs and desktop notifications, and it remembers
its size and position. No npm install (Node 18 built-ins only).
Uses your Claude Code login.

**The look.** `public/ui/os.css` holds the layout; `public/ui/os-lux.css`, loaded after it, holds the finish: deep ink
surfaces (warm ivory in light mode), a champagne-gold accent (the default; others in Preferences → Appearance),
frosted title bar, sidebar and menus, softer corners, and Fraunces for headings, Inter for text, JetBrains Mono for code.
The fonts are bundled in `public/ui/fonts/` (SIL Open Font License, `OFL-LICENSE.txt`), so nothing is fetched from the
internet. Cards rise into place, primary buttons catch a light sweep on hover, and the active app, open questions and
badges glow slowly. Preferences → Appearance → Animations → Reduced turns all of it off. The window's WebKitGTK has no
CSS `color-mix()`, so tints are written as `rgba(var(--x-rgb), alpha)`: each colour has an `--x-rgb` token next to it
(the accent's is set by `applyPrefs` in `shell.js`). Entrance animations only move things and never fade them in,
because WebKit can pause animations in a hidden window and content must never be left invisible.

## The sidebar

The six apps you use every day are always there: Today, Jobs, New job, Projects, Brain and Processes. **Insights**
(Usage, Tokens, Health, Review, Recos) and **Tools** (ARMS, Skills, Routines, Messages, Memory, Library, Terminal, Teams
& roles) fold away; click a heading to open it, and the window remembers. A folded heading shows a dot when something
inside needs a look, and the app you are in stays visible even when its group is folded. With *Icons only* every app
shows. Every app is also one key away (table below) and in Ctrl+K.

## Today

The start page (key `D`, changeable in Preferences → General): what needs you, who is working on what, what finished in the
last 24 hours with the first line of each answer, where your projects stand (with *continue*), skill proposals and updates
waiting, and usage against your limits with a bar per day for job costs over the last 14 days. **Suggested next**
offers projects that haven't moved in a week, failed jobs to retry and recent answers to rate. **Activity** lists what
happened in the last two days: jobs started, plans, questions, answers with files changed and cost.

## Ask the office

The speech-bubble button in the title bar, Ctrl+J, or *Ask the office* in Ctrl+K opens a small chat about the office
itself: "what did Renko do yesterday?", "why did #37 cost $22?", "where are my notes on the RGB config?", "what is
waiting for me?". The office first gathers the facts without a model (`lib/ask-office.js`): who is working on what,
open and recent jobs, the jobs matching your words, the full cost breakdown (the `job-cost` script) of any job you name
or of your most expensive one, and the matching passages in agents' memories, team libraries and project handoffs.
Haiku then words a short answer from those facts only, citing jobs as #N; click one to open it. An answer takes a few
seconds and costs well under a cent. Follow-up questions keep the last three turns; *New chat* starts over.

## Getting started: the tour

Main menu → *Take the tour* (also in Ctrl+K, on Today and on an empty Jobs list) walks through five steps on the real
controls: starting a job, watching it, deciding in *Needs you*, undoing changes, and finding anything with Ctrl+K. It
never starts on its own; Esc or Skip ends it.

## The apps

| App | Key | What it is |
|---|---|---|
| **Processes** | `p` | The full process tree. God (PID 1) is the root; each lead is a permanent process under it; staff sit under their lead while idle and, while working, under whoever started them, so delegations nest as deep as they go. Columns: PID, model/effort, state, job, live activity (thinking in purple), cost, tasks. Filter by name or job, hide idle staff, fold branches. Select a process for its inspector: thinking and messages (Mind), memory, last report, track record and feedback, children, and actions (kill, fresh session, weekly review, reset, message, feedback, follow-up). |
| **Jobs** | `j` | Every ticket: thread (anything waiting on you, such as a plan, a command, a question or an edit outside the project, sits in one **Needs you** panel above the reply box, with long plans shortened to their first steps; a job waiting behind another one says which and how many are ahead), the job's own **process tree** (who started whom, with state and cost per process), changes with diff and undo, timeline with **replay** (the tree and the thread as they were at each moment). Plans to approve, questions to answer, pause/resume/stop, budget, rating, attachments, archive. |
| **New job** | `n` | Write the task (or start from a template: bug report, new feature, code review, research, quick question, or your own saved ones), attach files, pick a project or let the office decide. A card under the box shows live who will take the job and why, at what effort, what similar jobs cost, and whether a second desk takes it because the lead is busy. Start after the limit resets. The `$ new job…` box in the dock does the same. |
| **Projects** | `o` | One card per personal project from its handoff: current state, next steps, last session, jobs and cost. **Continue** starts a job that picks up where it stopped; the New job page offers the same as one-click chips. |
| **Messages** | `m` | Each team's room: what teammates say to each other, and questions you ask a whole team. |
| **Memory** | `y` | What every agent has learned, by team. |
| **Library** | `l` | Each team's documentation as a file browser, with the library check and tidy-up. |
| **Terminal** | `t` | `ps`, `jobs`, `open <pid\|#job>`, `kill <pid>`, `new <text>`, and every office script (`count`, `find-def`, `call-sites`, `diff-files`, `route`…). |
| **Usage** | `u` | Plan limits (also in the top bar), pace, estimated window size, spend by day, team and model. |
| **Tokens** | `k` | Every model call on this machine (your Claude Code chats, every agent, tests), with the exact token counts from the API: by kind (fresh input, cache write 5 min / 1 h, cache read, output, thinking, web searches), by day, hour, weekday, source, team, agent, role, job, project, model, main thread vs subagents, service tier and stop reason. Filters for all of them; click a day or a row to filter. **Cache read** shows what every call re-read from the prompt cache: by source and in detail (each tool's results, Claude's own Write/Edit text, the fixed system prompt and tools, listings, reminders, your messages; spread over each call's exact cache read), by context size with what starting fresh at 100k/150k/200k/300k would have saved, by model with its price, cold reloads, and the single items that cost the most to carry (size × number of calls that re-read them); every chat has the same breakdown. **Context** shows what filled the context (each tool's results, Claude's own Write/Edit text, CLAUDE.md, skill and tool listings, reminders, your messages, the fixed system prompt and tool definitions) and the biggest single items. **Sessions** and **Every call** list everything; open a session for a bar per call and, per call, the exact usage and cost, what entered the context since the previous call, what the context held, and which tools Claude used. Long chats right now, Jev's OpenRouter calls, and **Save as CSV** (one row per call, to ~/Downloads). |
| **Health** | `h` | System, Claude login, leads' sessions, script use, problems, self-test, the agent eval over time, server log. |
| **Settings** | `,` | Roles, models, instructions, projects and routing keywords, new teams. |

## Small things that help

- **What changed, in the conversation.** The *Changed N files* card under a job's answer lists each file with its
  added and removed lines; click one to see its diff right there. *All changes* opens the full Changes tab.
- **Work folds into one line.** Steps an agent takes between your messages and its answer show as "Renko, Teo worked
  4 min · 23 steps"; click to open them.
- **Undo instead of "are you sure?".** Delete, Stop, Reject a plan and Archive wait five seconds behind a toast with an
  Undo button. Closing the window carries out anything still waiting.
- **Cost in your terms.** Plans, the New job card and Today show what an estimate is as a share of your 5-hour window,
  not just dollars.
- **Progress at a glance.** A job working through an approved plan shows "step 3 of 5" and a thin bar in the job list.
- **Who is busy.** A small avatar per lead (and parallel desk) sits in the title bar; the ring shows working, waiting
  for you, free or down. Click one to open what it is doing.
- **One-click answers.** A question from an agent shows its choices (or suggested ones, such as *Yes / No*) as buttons
  in the job, under the job on Today, and in Telegram. On the open job, keys 1–5 pick one.
- **Lessons wait for you.** A lesson a lead writes after a job went wrong appears on Today under *Lessons to review*:
  Keep, Edit (Enter keeps your wording, Escape cancels) or Drop. Only kept ones reach the agents.
- **Rate from the notification.** A finished job's toast has Open, a thumbs-up and a thumbs-down; the rating goes to the
  lead as feedback.
- **Drop files anywhere.** Dragging files onto the window attaches them to the open job's reply, or starts a new job with
  them anywhere else.
- **Keys on an open job.** <kbd>G</kbd> approves, runs or allows the first thing in Needs you, <kbd>X</kbd> refuses it,
  <kbd>I</kbd> jumps to the reply box, <kbd>Alt</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd> move between messages.
- **Narrow windows** show the job list or a job, with *‹ Jobs* to go back.
- **States have shapes** as well as colours: ✓ done, ✕ failed, ■ stopped, ‖ paused, ? needs you, ⋯ queued, ○ idle.
- **Getting set up.** Today shows a short checklist (projects, first job, a rating, Telegram, the tour) that ticks itself
  off and disappears when done or hidden.
- **Placeholders, not "Loading…".** Lists and panels show grey shapes while their content loads.
- Icons are drawn as SVG throughout: the system has no emoji font, so emoji such as 👍 would draw as empty boxes.

## Accessibility

Everything clickable works from the keyboard: Tab reaches rows and cards as well as buttons, Enter or Space opens them,
and focus is always visible. Icon-only buttons carry their tooltip as a label for screen readers. Text colours meet
WCAG AA contrast in both themes. The system's *reduce motion* setting (or Preferences → Appearance → Animations →
Reduced) turns off animations, and the Brain map settles at once instead of drifting.

`Ctrl/⌘+K` opens the launcher: apps, jobs, processes, projects, agents' memories, every Preferences setting by name,
and actions (self-test, agent eval, back up now, while you were away). A match at the start of a name ranks first;
recent picks come first, and an empty box shows them and what waits for you. With three or more letters it also finds
jobs whose text matches, and the last two rows turn what you typed into a new job or a Brain search. `?` lists the keys; arrow keys move through
processes and jobs, ←/→ fold the tree. Notifications: 🔔 desktop notifications, 🔊 sounds; toasts always.

## While you were away

When the office opens after being closed, or the window comes back after 30 minutes in the background, one card sums up
what happened since you last looked: what waits for you, jobs finished and not finished (with what they cost), who was
hired, joined the team or retired, and lessons the leads wrote. Click a row to open it. The time you last looked is kept
in the window (it updates every minute while the window is visible). Turn the card off in Preferences → Notifications;
`Ctrl+K` → **While you were away** shows the last day at any time.

## Health & self-test

**Health** (top bar dot: green/amber/red) shows each lead's process and session size, the Claude login, problems
from the last 48 hours, tasks not completed, and the server log. **Run self-test** sends one small ticket through the
whole office (God's routing, search, a teammate, a question to you, a file edit, undo) and checks each step
(about $0.25, under a minute; the first run hires a cheap Researcher who stays).
