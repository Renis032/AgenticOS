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
Uses your Claude Code login. `./start.sh` and `./stop.sh` still work.

**The look.** `public/ui/os.css` holds the layout; `public/ui/os-lux.css`, loaded after it, holds the finish: deep ink
surfaces (warm ivory in light mode), a champagne-gold accent (the default; others in Preferences → Appearance),
frosted title bar, sidebar and menus, softer corners, and Fraunces for headings, Inter for text, JetBrains Mono for code.
The fonts are bundled in `public/ui/fonts/` (SIL Open Font License, `OFL-LICENSE.txt`), so nothing is fetched from the
internet. Cards rise into place, primary buttons catch a light sweep on hover, and the active app, open questions and
badges glow slowly. Preferences → Appearance → Animations → Reduced turns all of it off. The window's WebKitGTK has no
CSS `color-mix()`, so tints are written as `rgba(var(--x-rgb), alpha)`: each colour has an `--x-rgb` token next to it
(the accent's is set by `applyPrefs` in `shell.js`). Entrance animations only move things and never fade them in,
because WebKit can pause animations in a hidden window and content must never be left invisible.

## Today

The start page (key `D`, changeable in Preferences → General): what needs you, who is working on what, what finished in the
last 24 hours with the first line of each answer, where your projects stand (with *continue*), skill proposals and updates
waiting, and usage against your limits.

## The apps

| App | Key | What it is |
|---|---|---|
| **Processes** | `p` | The full process tree. God (PID 1) is the root; each lead is a permanent process under it; staff sit under their lead while idle and, while working, under whoever started them, so delegations nest as deep as they go. Columns: PID, model/effort, state, job, live activity (thinking in purple), cost, tasks. Filter by name or job, hide idle staff, fold branches. Select a process for its inspector: thinking and messages (Mind), memory, last report, track record and feedback, children, and actions (kill, fresh session, weekly review, reset, message, feedback, follow-up). |
| **Jobs** | `j` | Every ticket: thread, the job's own **process tree** (who started whom, with state and cost per process), changes with diff and undo, timeline with **replay** (the tree and the thread as they were at each moment). Plans to approve, questions to answer, pause/resume/stop, budget, rating, attachments, archive. |
| **New job** | `n` | Write the task, attach files, pick a project or let routing decide (shows live which lead the rules would pick), lead effort, start after the limit resets. The `$ new job…` box in the dock does the same. |
| **Projects** | `o` | One card per personal project from its handoff: current state, next steps, last session, jobs and cost. **Continue** starts a job that picks up where it stopped; the New job page offers the same as one-click chips. |
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

## Health & self-test

**Health** (top bar dot: green/amber/red) shows each lead's process and session size, the Claude login, problems
from the last 48 hours, tasks not completed, and the server log. **Run self-test** sends one small ticket through the
whole office (God's routing, search, a teammate, a question to you, a file edit, undo) and checks each step
(about $0.25, under a minute; the first run hires a cheap Researcher who stays).
