# Agents and jobs

Who works here, how jobs flow, plans, terminal commands, skills, libraries.

[← Back to the README](../README.md)

## Who works here

| Resident | Role | Room |
|---|---|---|
| **God** | Dispatcher — reads every ticket and hands it to the lead who owns it; never does the work | Front Desk |
| **(work lead)** | Your day-job lead — everything in your work repository (configured locally in `roster.json`) | Work team |
| **Renko** | Personal Projects Lead — ~/Personal/Projects, this office, research, everything outside work | Personal Projects |

Residents are **always alive**: each is one long-running `claude` process that keeps its memory
across tickets, has an inbox, and restarts itself (resuming the same session) if it dies.
"Reset session" on their character sheet starts a new conversation (their memory file stays).

Leads decide per ticket whether to work alone or hire **sub-agents** — roster specialists
(analysts, implementer, reviewers, researcher) or a **custom** specialist they invent on the spot.
Staff are permanent: they appear under their lead in the process tree and move under whoever starts them while they work.

## How a ticket flows

1. You send a ticket. If you picked a project in the dropdown it goes **straight to that project's lead**;
   with "Let the manager decide" it lands in God's inbox and God `assign`s it to the right lead (or several).
2. The lead works it, hiring sub-agents with `delegate` if they want.
3. **The lead answers you directly** on the ticket. God never rewrites answers.
4. Reply on the ticket to follow up; it goes to the lead who owns it. Or message a lead directly from their sheet.

## Models, effort and budgets

- Leads run on Opus 5.5 (`defaults.residentModel`) at **high** effort by default (`residentEffort`).
  Each ticket can set the lead's effort: the "effort" box next to the project picker, else the project's
  `leadEffort` in `projects.json` (e.g. xhigh for a big work repository), else God's choice when it routes the ticket.
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
  never above its own model. Try it: `node scripts/choose-model.js researcher "compare three note-taking apps"`
  (or `choose-model …` in the Terminal app).
- Every ticket shows its cost. (Claude reports a running session total on each turn; the office
  records only the difference, so a lead's long session isn't counted again on every ticket.) Jobs have no dollar budget by default
  (`defaults.ticketBudgetUsd: null`): on a Claude plan the 5-hour and weekly limits are what count (see Usage limits). Set
  it to a number to bring a per-job budget back: at it, new sub-agents pause and the job asks you to raise it (+$5 / +$10)
  or stop.

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

## Terminal commands

Agents that can edit files (leads and implementers) have `run_command`: a real shell command (`bash -lc`) in a folder
inside your home, for builds, tests, installs and running programs their Bash allow-list doesn't cover. Preferences → Agents
& teams sets it to **Off**, **Ask me first** (default) or **Allow** (`defaults.terminalCommands`). Each command shows in the
job as a card with its folder, reason, live output, exit code and a Stop button. While it waits for you, the job says
"needs you" and offers **Run**, **Run all on this job** and **Don't run**. Commands also stream into the Terminal app. The
`alwaysDisallowed` list (commit, push, sudo, upgrades, `rm -rf`…) is checked anywhere in the command line, including
inside quotes, and pausing or stopping a job stops its commands. In "Ask me first" mode, a command that already succeeded in the
same folder runs without asking (the card says so); `defaults.autoRunKnownCommands: false` makes every command ask.

## Where agents may edit, and secrets

On a job about a project, agents edit only inside that project, their team library and scratch folders (`~/…_test`, `/tmp`).
An edit elsewhere is blocked with a pointer to `request_edit_access`, which shows you the folder and the reason with **Allow on
this job** or **Don't allow**. Jobs with no project are not limited; `defaults.editScope: "home"` (Preferences → Agents & teams)
turns the limit off. Handoffs, skills, team notes and memories that look like they contain a key, token, private key or
password are refused, with a note to refer to where the secret is kept instead.

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

- `teams/<work team>/` — for your day-job team: INDEX can point at a local knowledge base, plus pages agents add
- `teams/personal/`, `teams/front-desk/`
- `teams/personal/projects/<Folder>.md` — **project handoffs** (Personal Projects only): when Renko finishes work on a
  project, or you wrap up, it saves the project's current state and a summary of the chat with `save_project_handoff`.
  Any later ticket that names the project (`DianisCommunication`, `dianis communication`…) starts with that handoff,
  so the work continues where it stopped. Shown in the Library under "Project handoffs"; the last 12 sessions are kept
  (`defaults.handoffSessions`).

Click the bookshelf in a room to read its library. Each lead **tidies** its library on its own after
6 new notes (`defaults.tidyAfterNotes`), when free: merging duplicates, verifying doubtful notes against the
code, and keeping INDEX.md current. It never edits the reference docs. "Tidy now" in the library forces it.

## Teams & projects (Settings)

Change each role's usual model and effort and its instructions, add roles to a team, add or edit projects (owner and
default lead effort), and create a **new team**: a new lead process under God, with its own library and message room, which God
starts routing to. Leads pick up changes when they're next idle. Roles that come from `~/.claude/agents/*.md` keep
their instructions there.

## Plans approved automatically, and reminders

Preferences → Agents & teams → *Plans and reminders* sets, in `roster.json` defaults:
- **Ask for a plan before work above** (`planOverUsd`): the cost at which a lead must show you a plan first.
- **Approve plans automatically** (`autoApprovePlansUsd`, 0 = never) and **only while 5-hour usage is below**
  (`autoApproveUsageMax`): plans under that estimate go ahead by themselves; the job shows "approved automatically".
- **Approve, don't ask again here**: a button on the plan banner that approves this plan and every later one on that job.
- **Remind me when something waits** (`remindAfterMinutes`, quiet between `remindQuietHours`, 22:00–08:00): a plan,
  question or command that waits that long sends a reminder notification.

## Skills agents propose

Every agent with a team has `propose_skill`: a short skill (saved instructions) for itself or its whole team, with its
evidence (which jobs, what was repeated or went wrong). Proposals appear in the **Skills** app under *Proposed by agents*
(with a notification and a badge on the dock) with **Approve and install** or **Reject** and a note that goes back to
the agent as feedback. Approved skills live in `teams/<team>/skills/<name>/SKILL.md`; each agent's instructions list the
skills meant for it, and it reads one when a task matches. Proposing an existing name proposes an update, shown next to
the current version. The Skills catalog lists team skills with "(team)".

## Your work team (local only)

The office supports a day-job team next to Personal Projects, but nothing about it lives in git: its lead, roles, project
and keywords are in your local `roster.json`/`projects.json`, its library in `teams/<team>/`, and its details in
`roster.json` → `defaults.workArea` (`name`, `repo`, `router`, `heading`, `covers`), which the ARMS memory map, the usage
reports and skill runs read. A team can use Claude Code's own skills from `~/.claude/skills`: set its
`team.claudeSkills` to a list of names, `"*"`, or `"work-area"` (every skill that mentions the work repository). Its agents
then get the `Skill` tool and a list of those skills in their instructions.
