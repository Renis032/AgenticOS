# Operations

Usage limits, token saving, configuration, restarting and development.

[← Back to the README](../README.md)

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

## Config

- `roster.json` — residents, roles, tool presets, `alwaysDisallowed` (no commit/push/sudo/apt upgrade/rm -rf),
  team libraries. Changes apply to the next agent started; residents pick them up on restart.
- `projects.json` — known projects, shown in the ticket box (picking one skips God) and to God for routing.
- `data/` — agents, tickets, inboxes and every agent's activity log (survives restarts); `uploads/` (attachments),
  `snapshots/` (files saved before edits, for undo), `limits.json`, `backups/` (old copies from upgrades).
- Env: `WORKPLACE_PORT` (4747), `WORKPLACE_MAX_RUNNING` (8 concurrent sub-agents).

## Restarting and updates

`./agentos restart --when-idle` (or ☰ → *Restart Agentic OS when idle*, the *Update ready* chip in the title bar, or the tray menu)
lets running work finish, holds new work, and — when the code changed since the server started — first runs `api-check` and a
quick `ui-check` against the new version in throwaway copies. If either fails, the restart is called off with a notification
saying what broke, and the office stays on the version that works (`--no-check` skips the checks; `defaults.checkBeforeRestart:
false` turns them off). Then it starts a fresh server; the window reloads by itself and queued jobs
continue. `./agentos restart --cancel` cancels it; plain `./agentos restart` stops everything at once. The title bar
says **Update ready** when the server code changed since it started (restart) or the window's files changed (reload).

## Development

- **Layout**: `server.js` only wires things together; every part of the server is a module in `lib/` (an `install(ctx)`
  that gets what it uses from server.js). [Architecture](architecture.md) lists every module and what it owns. The window
  is `public/os.html` with its styles in `public/ui/os.css` and its code in `public/ui/os/*.js` (classic scripts sharing
  one scope, loaded in order); the native wrapper is `app/agentos-window.py`.
- **The usual checks**: `npm test` (every file parses, then the API check), `npm run lint`, and `npm run test:ui` when
  the window changed. CI runs them on every push and pull request.
- **Check the server after every change**: `node scripts/api-check.js` (a few seconds, costs nothing) starts a throwaway copy with
  fake agents and an empty `data/`, and checks the token wall, jobs and follow-ups, taking back a queued message, commands and the
  block list, plans and automatic approval, handoffs, the Projects board, skills, libraries, mail, changes and undo, the timeline,
  settings, restart, scripts, and that a fresh clone starts from the example config.
- **Check the agents after changing their instructions**: `node scripts/agent-eval.js` runs real agents on Haiku in a throwaway
  office (a few cents) and checks they read large files in parts, count with scripts, refuse to commit, propose a plan before a
  team of three, and save a project handoff when you wrap up. The office also runs it by itself (`defaults.agentEvalDays`,
  1 = daily, 0 = only by hand; Preferences → Agents & teams) once it has been idle for 20 minutes and both usage windows
  are under half, keeps every run in `data/evals.jsonl`, and shows them in **Health** as a grid: one column per run,
  ◆ where the agents' instructions (`roster.json`, `lib/mcp-delegate.js`) changed since the run before. A behaviour that
  passed last time and fails now is a notification. **Run now** in Health runs it straight away.
  `node scripts/prompt-size.js --detail` shows how many tokens each
  role's fixed instructions and office tools take, by section.
- **Check the window after every change**: `node scripts/ui-check.js` (about 45 s, costs nothing) clicks through every
  app, menu, Preferences section and job state in a throwaway copy with fake agents on a virtual screen, and lists
  JavaScript errors, buttons with no action, buttons pushed off screen and layouts that overflow, with a screenshot per
  step. `--quick` for a shorter run, `--out <dir>` to keep the screenshots somewhere. It also drags, searches, steps through
  time and waits on the Brain map (the map must stop drawing when idle), and shows the Brain in the light theme.
- **Checks never leave offices running**: each throwaway office gets `AGENTOS_TEST_PARENT` (the check's PID) and shuts itself
  down within 3 s once that process is gone, even if the check was killed before its own clean-up. The UI check also stops
  its virtual screen on Ctrl-C or SIGTERM.
- **Git**: `data/` (agents, jobs, conversations, logs, uploads, the app token), `teams/` (libraries, handoffs, team skills),
  `roster.json` and `projects.json` are local and ignored; a fresh clone starts from `roster.example.json` and
  `projects.example.json`. Anything about your day job is configured only in the local `roster.json` (`defaults.workArea`,
  including a `private` list of words that must never be committed). `scripts/clean-git-history.sh` (you run it; it never
  pushes) replaces the repository's history with one clean commit after checking that no local file or private word is in it,
  and backs the old history up to a bundle first.

## Costs

Job costs come from the exact token counts in Claude Code's transcripts, priced per model at API list prices (Opus 5.5 $4 in /
$20 out / $0.20 cache read; Sonnet 5.5 $2 / $10 / $0.20; Haiku 5.5 $0.10 / $0.50; cache writes 1.25× or 2× input). The office
recomputes them every 10 minutes and shortly after each turn; Claude Code's own running total (which undercounts 1-hour cache
writes) is kept as `costRecordedUsd`. On a Claude plan you don't pay these amounts; they show relative weight and track the
usage limits. `node scripts/job-cost.js <#job>` explains one job: per agent and model, cache reads vs writes vs output, context
size, what filled it, and where to save.

**Compacting long sessions**: agents run with `CLAUDE_CODE_AUTO_COMPACT_WINDOW` set to `defaults.autoCompactTokens` (150k by
default; Preferences → Agents & teams), so a long job summarises its history instead of re-reading an ever longer context on
every call. `job-cost`'s "avg context" shows the effect.

## Telegram: run the office from your phone

Plans, questions, terminal commands and edit-access requests that need you can also arrive in Telegram, with the same
buttons as the window (Approve / Reject, Run / Run all on this job / Don't run, the question's options, Allow / Deny).
For a question without options, reply to its message with your answer. You get a note when a job fails and, if you
turn it on, when one finishes (with 👍 / 👎, Follow up and Details).

From the chat you can also run jobs (the bot's menu lists the commands; `/help` explains them):

| Send | What happens |
|---|---|
| `/new fix the login page` | starts a job, routed like one from the window; `/new recipe-box: add dark mode` picks the project |
| any other text | offered as a new job, started only when you tap *Start the job* (a stray message never starts work) |
| `#12 make it blue` | a follow-up on job #12 (or the answer to its open question); `#12` alone shows the job |
| a reply to any message about a job | a follow-up on that job |
| `/jobs`, `/job 12` | jobs in progress and finished in the last day; one job as a card |
| `/pause 12`, `/resume 12`, `/stop 12` | as in the window; stopping asks you to confirm |
| `/watch 12` | the job's card, kept up to date as the job moves (at most every 10 s) |
| `/ps` | every lead and running specialist: model and effort, state, job and what it is doing |
| `/usage` | the 5-hour and weekly windows, when they reset, and today's spend against the daily limit |
| `/waiting` | sends again whatever waits for you, at the bottom of the chat |
| `/projects` | project names to use with `/new` |

A job card shows the status, lead, cost against the budget, who is working on it right now and on what, the last few
messages and the answer, with Refresh, Pause / Resume / Stop (Start now for a scheduled job), Follow up and Live
updates. Jobs you start or follow up from Telegram get a live card and always get their finished/failed note.

1. In Telegram, open **@BotFather**, send `/newbot`, pick a name, and copy the token it gives you (`123456789:ABC…`).
2. In Agentic OS: **Preferences → Notifications → Telegram**, paste the token. The office checks it and shows a 6-digit code.
3. Send that code to your new bot (or `/start <code>`). That chat is now linked; **Send a test** to check.

- Only the linked chat is listened to; messages and button presses from anyone else are ignored.
- The office polls Telegram (no webhook, nothing exposed to the internet), only while a token is set. Whatever piled up
  while the office was off is skipped at start, so old button presses never act later.
- When you decide something in the window, its Telegram message is updated ("Decided in the window: …") and its
  buttons disappear; a decision in Telegram shows up in the job like one made in the window.
- The token, the linked chat and the settings are kept in `data/telegram.json` (readable only by you, ignored by git).
  The API never returns the token. **Disconnect** forgets all of it.

## Background, tray and start at login

With a tray (AppIndicator / StatusNotifier, e.g. KDE), closing the window while jobs run hides it to the tray: the icon shows
"N working · N need you" and turns to attention when something waits for you; its menu opens the window, starts a new job,
restarts when idle, or quits. `./agentos autostart on` (or Preferences → General → *Start at login*) starts Agentic OS at login,
in the tray, so agents can work before you open the window; `./agentos --background` does the same by hand.

## Leads manage, teammates do the long work

A lead's conversation lasts the whole job and is re-read on every call, so leads are told to plan, brief and review while
teammates with fresh contexts do long reading, edits and test runs. When a lead's own context passes `defaults.leadContextNudge`
(100k tokens, Preferences → Agents & teams), the office reminds it, as mail after its next tool call and again every 50k more,
to hand the rest to a teammate.

## Cost per successful job

Usage → *Cost per successful job* (`lib/outcomes.js`, `GET /api/outcomes?days=30`): per lead and per project, jobs,
success rate, check failures, retries (checks sent back, rework, resumes), median time, cost, and cost per success. A
success is a job that ended done with its checks passing, not rated down, not undone and not followed up within two
hours. Failed and reworked jobs still cost money, so cost per success is the number to compare, not cost per job. The
recent jobs that didn't succeed are listed with why.

## Learning from outcomes

Besides 👍/👎 (now also right on the answer), two signals count against a job's model choice: a follow-up within 2 hours of
the answer (rework) and undoing its changes. The weekly report lists both.

## Housekeeping

Backups in `data/backups` (copies saved before changes) older than `defaults.keepBackupsDays` (30) are pruned once a day.

## Saving state and backups

- **State files** (`data/agents.json`, `tickets.json`, `teams.json`) are saved at most half a second after a change, however
  busy the office is. Each is written to a temporary file and renamed into place, so a crash never leaves half a file, and an
  unchanged file is not rewritten. Every 10 minutes the previous version is kept as `<file>.bak`. A file that cannot be
  read at start-up is moved aside as `<file>.corrupt-<time>` and its `.bak` is loaded instead (the log says so).
- **Daily backups** (`lib/backups.js`): a minute after start-up and then hourly, if the newest backup is more than a day
  old, all of `data/` is packed into `backups/agentos-data-<date>.tgz` (next to `data/`, ignored by git). The usage cache
  and old code copies are left out because they rebuild or are disposable, and so is the app token. The newest
  `defaults.keepDataBackups` (7) are kept.
- **Back up now and Restore** are in Preferences → Data & backups. Restoring saves the request, restarts the office as
  soon as nothing is running, and before loading anything packs the current data into `before-restore-<date>.tgz` (the last
  3 are kept), then unpacks the chosen backup. The app token and server log stay, so the window reconnects by itself. To
  undo a restore, restore the before-restore backup.
