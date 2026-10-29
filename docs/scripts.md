# Scripts

Everything mechanical is a script that agents call, never model work. Usage for each is in `scripts/manifest.json`; every script also runs from the command line (`node scripts/<name>.js`).

[← Back to the README](../README.md)

## Scripts first

Anything mechanical is done by a script in `scripts/` (Node, no dependencies; each one also works from the
command line), never by an agent:

| Script | Does |
|---|---|
| `count` | exact line (wc -l), non-empty line, word and byte counts |
| `find-files` | find files by name, case-insensitive glob, skipping build/.git folders |
| `find-def` | where a class/struct/enum/function/macro/alias is defined or declared |
| `call-sites` | every use of a symbol, grouped by file, without its definitions and comments |
| `diff-files` | byte-for-byte compare (sha1), whitespace-only check, unified diff; also directories |
| `xml-check` | XML well-formedness with xmllint |
| `changed-files` | uncommitted changes in a git repo (read-only: status + diff --stat) |
| `repo-state` | where a git repo stands: branch, HEAD, upstream, uncommitted changes, submodules with their own changes, whether a commit from a ticket is in the history; `--diff` adds the full diff, submodules included; `--log N` the last N commit subjects, to write a commit message in the same style |
| `route` | which lead the routing rules would pick for a ticket |
| `library-check` | duplicate notes and file:line references that no longer match the code |
| `weekly-report` | a team's week in numbers: tickets, costs, ratings, staff, problems |
| `choose-model` | the expected-value model's pick of model and effort for a task, with the full table |
| `jev` | ask Jev (TypeSafe router via OpenRouter) which model and effort fit a task |
| `skills-scan` | every Claude Code and office skill: type, size in tokens, uses, pinned model |
| `suggest-routines` | jobs done by hand 3+ times and repeated corrections, as routine/memory suggestions |
| `cache-report` | cold prompt-cache reloads in your chats and whether keep-warm pings would pay |
| `workspace-map` | draft the CLAUDE.md map and department routers (writes only a proposal), or list images without descriptions |
| `artifacts-index` | rebuild the artifacts inbox page, newest first, searchable |
| `token-usage` | where Claude Code tokens went: by kind, source, project, model, day; what fills the context (tool results carried per call); biggest results; costliest sessions |
| `usage-index` | every model call on this machine with exact token counts, attributed to you, agent, team, job, project, model; context breakdown per call |
| `routing-report` | how model picks turned out: Jev vs EV vs overrides vs pins — done rate, cost, time, ratings, sent back, retried |
| `arms-selftest` | tests ARMS approvals (memory map, skills, status line, keep-warm), keep-warm pings and Recos setup in a throwaway HOME; proves real ~/.claude is untouched |
| `show` | line ranges from one or more files with line numbers (instead of several sed -n or whole-file reads) |
| `outline` | classes, functions, methods and headings with line numbers, to find what to read (py, js/ts, c/c++, java/kotlin, go, rust, md, sh) |
| `search` | code search grouped by file, several folders at once, skipping .git/node_modules/build folders, media/binary files and files over 5 MB (`--max-size`), with optional file type and context lines |
| `project-info` | what a project is and how to install, build, test and run it (detected from its files), plus commands that worked in earlier jobs and its handoff |
| `sqlite` | read-only SQLite: tables with row counts and columns, or a query's rows as a table |
| `web-shot` | screenshot of a web page or local HTML with headless Chrome (then Read the PNG to look at it) |
| `job-cost` | where a job's usage went: per agent and model, cache reads/writes/output, context size, what filled it, and where to save |
| `handoff-facts` | facts for save_project_handoff: jobs, files changed, commands and results, questions and answers, costs, commands that worked |
| `ui-check` | after any change to the Agentic OS window: clicks through every app, menu, Preferences and job state in a throwaway copy (fake agents, nothing spent) and lists JS errors, dead buttons, off-screen buttons and overflowing layouts, with screenshots (about 45 s) |
| `api-check` | after any change to the Agentic OS server: exercises its API in a throwaway copy (fake agents, nothing spent) — jobs, follow-ups, recall, commands and the block list, plans, handoffs, skills, settings, restart, a fresh clone — and lists what broke (about 5 s) |
| `prompt-size` | how many tokens each role's fixed instructions and office tools take (what every call re-sends), by section |
| `agent-eval` | after changing agent instructions: real agents on a cheap model in a throwaway office, checking they read in parts, use scripts, refuse to commit, propose plans and save handoffs (a few cents); `--json` for the office's own scheduled runs |

- **Agents** call them through the `script` tool, which every agent has, God included. Each script is tagged `for: all | lead | office` in the manifest, and an agent sees only the scripts meant for it (office ones for the team that maintains this office), which keeps every call's tool list short. A hook blocks shell commands
  a script already covers (`wc`, `find -name`, `diff`/`cmp`, `xmllint --noout`, `git status`, `git diff --stat`, `sed -n A,Bp file`,
  recursive `grep -r`) and tells the agent which script to call, with the arguments already translated. A leading `cd dir &&`,
  `timeout N` and a trailing `| head`/`| tail` don't hide a command from it. The Health sheet shows script runs and redirected commands per agent. Agents
  note repeated mechanical steps on their library's `script-ideas` page so they can become scripts.
- **Team scripts**: a team can keep scripts that only make sense for its own repository in its library folder
  (`teams/<team>/scripts/manifest.json` plus `<name>.js`, same format as `scripts/`). Only that team's lead and staff see
  them in the `script` tool, and git ignores them with the rest of `teams/`. The prompt points agents at them.
- **Routing**: tickets without a project go through `route` first. A path or keywords that clearly belong to one
  lead send the ticket straight there (projects have `keywords`, editable under ⚙; "Personal projects" also uses
  its subfolder names). God is asked only when nothing matches or two leads match.
- **Libraries**: the "All pages" list at the end of each INDEX.md is kept up to date by `library-check` after every
  note. A tidy-up runs the check first and wakes the lead only for duplicates or stale references.
- **Weekly review**: `weekly-report` writes the report. The lead is involved only when something went wrong (a 👎,
  an unfinished ticket or teammate task, a cost spike), and then only to find the cause.
