# ARMS

Apps, Routines, Memory and Skills, built from the ARMS Agentic OS v2 guide.

[← Back to the README](../README.md)

## ARMS (Apps, Routines, Memory, Skills)

Built from the *ARMS Agentic OS v2* guide: twelve levels, three per part. The **ARMS** app (`a`) shows the checklist
with what's done (it checks itself; you can also tick by hand) and an **Approvals** list: anything that changes your
Claude Code setup (`~/.claude`) waits there until you approve it, and the old file is backed up first.

| | Level 1 | Level 2 | Level 3 |
|---|---|---|---|
| **Skills** (`s`) | Catalog of every skill by type (database, artifact, procedure), size in tokens, uses. **Run** any skill in the background with `claude -p`, model and effort next to the button, a report per run; save it as a run button. New **database skill** (references + wildcards: 8 of 10 follow the references, 2 are wildcards) and **artifact skill** (HTML brand book, artifacts inbox at `/artifacts/`, `scripts/artifacts-index.js`). | **Model routing**: pin fixed-step skills to a model (`model:` in SKILL.md). Everything else, skills and sub-agents, is decided by **Jev** (`typesafe/jev-router` via OpenRouter, 4 s timeout) with the EV script as fallback. Every pick is logged with time and cost (`data/arms/routing.jsonl`), with an on/off switch. | **Teach**: feedback on a skill's output → Claude finds the principle and folds it in (sharper, not longer); you see the diff first; `CHANGELOG.md` records what changed and why. |
| **Routines** (`r`) | Scheduled jobs, **active** (always hands you the result) or **passive** (answers `NOTHING TO FLAG` and archives itself silently unless something is worth your attention). | Cost per routine this week, most expensive first; **caps** ($/week; a capped routine skips runs and tells you); **Optimise** asks the lead to cut the fat and show before/after. | **Recos** (`c`): every Friday a script finds jobs you did by hand 3+ times (Claude Code history and Agentic OS jobs) and repeated corrections; pick cards into a cart, copy it or set them up. |
| **Memory** | **Map**: CLAUDE.md becomes a map (global rules kept, your work notes moved word for word to their own router (`defaults.workArea` in the local `roster.json`), routers for personal projects and Agentic OS); leads get their area's router in their instructions. Image captions per folder with a cheap model. | **Compaction rules** in CLAUDE.md; **cache report** (cold reloads over 30 days and whether keep-warm pays); optional **keep-warm** pings every 50 min for up to 4 h; cache state in the status line and on each lead. | `/note` (park feedback in the skill's own `NOTES.md`, apply later on a small model) and `/calibrate` (save a lesson, link memories, fix the skill it belongs to); repeated corrections appear in Recos. |
| **Apps** | `/search-connectors`: maker's tools → community CLI → API → MCP, lightest first, keys in `~/.config/agentos/keys/`. | **Usage mod**: a Claude Code status line with 5-hour/weekly limits and cache warm/cold (no tokens). | **Review** micro app (`v`, own window, `/review`): approve finished jobs with comments on the answer and every changed file, copy comments or send them to the lead, saved as you type; built on the shared UI parts library (`public/ui/parts.css`, `parts.js`). |

**Jev needs an OpenRouter key**: put it alone in `~/.config/agentos/openrouter.key` (`chmod 600`), never in chat.
Without it the EV script decides. Test: `node scripts/jev.js "list the files in a folder"`.

**Security**: the backend only listens on this machine, requires the app token on every request, and checks the Host
and Origin headers, so no web page or other device can reach it.
