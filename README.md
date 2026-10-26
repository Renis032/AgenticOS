# Agentic OS

A permanent team of Claude agents, run like an operating system: every agent is a process in one live tree, every task
is a job. A desktop app for Ubuntu (GTK + WebKitGTK window over a local Node backend, no npm install), using your Claude
Code login. Everything runs on this computer.

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

## Documentation

| Page | What's in it |
|---|---|
| [The brain](docs/brain.md) | the knowledge graph, the decision flow and the optimizer, with every rule and number explained |
| [The window and its apps](docs/window.md) | the title bar, menus, Preferences, and every app (Processes, Jobs, Projects…) |
| [Agents and jobs](docs/agents.md) | who works here, how jobs flow, models, plans, terminal commands, skills, handoffs, libraries |
| [Scripts](docs/scripts.md) | the scripts agents use instead of doing mechanical work by hand |
| [ARMS](docs/arms.md) | apps, routines, memory and skills from the ARMS guide |
| [Operations](docs/operations.md) | usage limits, costs, restarting and checks, tray and autostart, git and development |
