# Agentic OS

A permanent team of Claude agents, run like an operating system: every agent is a process in one live tree, every task
is a job. A desktop app for Ubuntu (GTK + WebKitGTK window over a local Node backend, no npm install), using your Claude
Code login. Everything runs on this computer.

![Today: what needs you, who is working, what finished](docs/screenshots/today.png)

## Getting started

You need Node.js, [Claude Code](https://claude.com/claude-code) logged in (`claude` on your `PATH`), and for the window
`python3-gi` and `gir1.2-webkit2-4.0` (`sudo apt install python3-gi gir1.2-webkit2-4.0`).

```
git clone <this repo> ~/agent-workplace && cd ~/agent-workplace
./agentos                      # first run creates roster.json and projects.json from the .example files
```

Then edit `projects.json` so it lists your own projects (name, folder, which lead owns it, a few keywords for routing),
and `roster.json` if you want other teams or defaults. Both stay on your machine: git ignores them, along with `data/`
(jobs, conversations, logs) and `teams/` (each team's library, skills and project handoffs).

```
./agentos                      # start the server if needed and open the window
./agentos status               # is it running, how many processes and jobs
./agentos restart --when-idle  # finish running work, check the new version, then restart; the window reloads
./agentos restart              # restart now (interrupts running work)
./agentos stop [-f]            # stop; refuses while agents work unless -f
./agentos install              # add it to the applications menu (uninstall removes it)
```

## Day to day

- **Start a job**: `N` (or Ctrl+N), write the task, pick a project or let routing decide. Name a personal project
  (e.g. "continue DianisCommunication") and Renko starts from where its last chat ended.
- **Talk to it** in the job: Enter sends; ↑ in the empty box takes back a message the agent hasn't picked up yet.
  The strip under the conversation shows who is working on what and what it has cost so far.
- **When an agent needs you** (a question, a plan, a command to run) the job says *needs you*, you get a notification,
  and reminders follow if it waits. Plans under an amount you choose can be approved automatically.
- **Brain** (`B`) shows everything the agents know as a graph, how jobs flow through the office, and what to improve.
- **Today** (`D`, the start page) shows what needs you, what's running and what finished; **Projects** (`O`) where every
  personal project stands; **Skills** the skills your agents propose.
- **In the background**: close the window while jobs run and it waits in the tray; `./agentos autostart on` starts it at login.
- **Preferences**: Ctrl+, (theme, notifications, sending, terminal commands, plan approval, reminders…).
- **What a job cost and why**: `node scripts/job-cost.js 28`.

## Screenshots

| | |
|---|---|
| ![A job waiting for plan approval](docs/screenshots/job-plan.png) | ![The brain's knowledge map](docs/screenshots/brain.png) |
| **A job that needs you.** The lead proposes a plan with a cost estimate; approve, change or reject it in place. | **Brain.** Agents, memories, library pages, skills, handoffs and projects as one graph you can drag, search and scrub through time. |
| ![The process tree](docs/screenshots/processes.png) | ![Projects and their handoffs](docs/screenshots/projects.png) |
| **Processes.** Every agent as a process: model and effort, state, current job, activity and cost. | **Projects.** Where each personal project stands, from its handoff; Continue starts a job that picks up there. |

The light theme follows the system or can be picked in Preferences:

![A finished job in the light theme](docs/screenshots/jobs-light.png)

The screenshots come from a throwaway demo office (example roster, made-up projects, a stand-in for `claude` that
spends nothing), captured in the same WebKitGTK engine as the window with `scripts/ui-check-driver.py`.

## Documentation

| Page | What's in it |
|---|---|
| [The brain](docs/brain.md) | the knowledge graph, the decision flow and the optimizer, with every rule and number explained |
| [The window and its apps](docs/window.md) | the title bar, menus, Preferences, and every app (Processes, Jobs, Projects…) |
| [Agents and jobs](docs/agents.md) | who works here, how jobs flow, models, plans, terminal commands, skills, handoffs, libraries |
| [Scripts](docs/scripts.md) | the scripts agents use instead of doing mechanical work by hand |
| [ARMS](docs/arms.md) | apps, routines, memory and skills from the ARMS guide |
| [Operations](docs/operations.md) | usage limits, costs, restarting and checks, tray and autostart, git and development |
