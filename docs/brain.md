# The brain

What the agents know, how work moves through the office, and what to improve in both. Open it with **Brain** (`B`).

[← Back to the README](../README.md)

The brain is built on demand from what the office already records — nothing extra is logged. The server part is
`lib/brain.js` (`/api/brain/knowledge`, `/flow`, `/findings`, `/node`, `/action`); the window part is
`public/ui/os/brain.js`. Results are cached for a minute; **Refresh** rebuilds them.

## Knowledge: everything the agents know

Two views of the same data, switched in the toolbar (the choice is remembered):

- **Map** (default, `public/ui/os/brainmap.js`): the knowledge on a flat plane, each node drawn as a sprite: a badge in
  its kind's colour with the kind's icon (the same artwork as the legend, `spriteSvg` in `brain.js`). Leads wear a gold
  ring. Each lead's team forms a cluster around its lead, and projects sit between the clusters. Sprites pop in on open,
  grow when hovered, and pulses travel along links that carry activity (read, wrote, taught, led, worked on, proposed).
  God only routes jobs, so it is not on the map (it still appears in Flow, where routing is shown).
- **Table**: sortable, for exact numbers.

The map is a physics simulation. Links are springs and every node pushes the others away, so **dragging one figure pulls
its neighbours along** and the rest make room. A released figure keeps its momentum and settles back into its lobe.
Drag empty space to pan, scroll to zoom, double-click to fit everything in view. Hover to highlight a node's
connections, and click for its details, content and fixes. The chips above show and hide each kind of node (jobs start
hidden). Reduced motion turns off the pop-in, the hover lift and the pulses. The UI check (`scripts/ui-check.js`, step
`brain-map-drag`) drags the busiest agent and fails if its neighbours don't follow.


### Nodes

Every kind has its own colour and icon (colours are `--c-<kind>` in `os.css`, from the reference categorical palette;
instructions are slate). Eight colours cannot all be told apart by colour alone, so the icon, the legend and the Table
view carry the kind too. Size grows with the number of tokens. A **dashed gold outline** means *carried in every call*:
the text is part of the instructions of the agents that hold it, so it is paid again on each of their calls.

| Sprite | Colour | Kind | Where it comes from |
|---|---|---|---|
| person, round | blue | **Agent**: lead (large, gold ring) or staff | `data/agents.json`, `roster.json` |
| bookmark | violet | **Memory**: what one agent remembers (carried) | `data/memory/<agent>.md` |
| open book | aqua | **Library page**: team notes, pitfalls, how-tos | `teams/<team>/*.md` |
| sparkle | yellow | **Skill**: an approved team skill, or a Claude Code skill the team may use | `teams/<team>/skills/*/SKILL.md`, `~/.claude/skills` |
| page with arrow | magenta | **Project handoff**: where a project stands | `teams/personal/projects/<Project>.md` |
| list | slate | **Instructions**: area routers and role files (carried) | `roster.json` → `team.router`, `agentFile` |
| folder | green | **Project** | `projects.json`, project folders with a handoff |
| inbox, round | orange | **Job**: the last 40 jobs | `data/tickets.json` |

### Links

| Link | Meaning |
|---|---|
| reports to | staff → their lead |
| on call for | a specialist hired for one project → that project (they are off the team otherwise; see [Agents](agents.md)) |
| remembers | agent → its memory |
| follows | agent → router or role file it carries |
| library | lead → a page of its team library |
| wrote | agent → library page it added an entry to (from the `### date — Name` headers) |
| taught | job → the page or skill that came out of it (`ticket #N` in the entry, `proposed-by` in the skill) |
| proposed / guides / available to | who proposed a skill, whom it guides, which team may use a Claude Code skill |
| keeps / describes / on | lead → handoff, handoff → project, job → project |
| led / worked on | lead → job, staff → job (from their task history) |
| read | agent → knowledge it opened in the last 30 days (Read of the file, or the Skill tool), with a count |

### Numbers

- **Tokens** — characters ÷ 4.
- **Carried per week** — tokens × the calls in the last 7 days of every agent that carries it. Calls are counted from the
  agents' event logs (tool calls and turns), so it is an estimate of how much of the office's input this one file is.
- **Reads (30 d)** — how often an agent opened it. Pages and skills with no reads are not helping anyone.
- **Updated** — the file's last change.

## Flow: how work moves through the office

Eight stages, left to right, for the last 7, 30 or 90 days. Each stage counts its own unit (jobs, model picks, teammate
tasks, tool calls, events), so band thickness compares flows **between the same two stages**; hover a band or a stage for
exact numbers and cost, click a stage for details. The panel on the right shows where the work goes.

| Stage | What it shows | Source |
|---|---|---|
| Comes in | your jobs, weekly reviews, routines, self-tests | job records |
| Routed by | you picked the project · routing rules placed it · God decided | the job's thread (`assign`, routing note) |
| Lead | which lead owned it; average context per call and model calls from the transcripts | job records, `usage-index` |
| Teammate model picked by | Jev, the expected-value model, a reused decision, a pin, or the track record overruling | `data/arms/routing.jsonl` |
| Teammate roles | which specialists did the work, how many finished, on which models | `data/arms/outcomes.jsonl` |
| Work done | tool calls by kind: read & search, edit files, shell, terminal commands, scripts, web, talk, delegate, ask you, learn, skills | agents' event logs |
| Outcome | done · failed or cut off · stopped by you · still open | job records |
| Signals & learning | 👍 / 👎, rework, undone changes; memory updates, library notes, handoffs saved, skills proposed | job records, event logs |

## Optimize: what to improve

Worked out from the live data each time you open it, most serious first. Each finding says why, how much it costs or
saves, and offers a fix.

| Finding | Rule | Fix |
|---|---|---|
| Carried in every call | a memory over 700 tokens, or a router or role file over 1,500, that went into calls in the last 7 days; serious above 2M tokens a week | ask the agent to trim its memory to under 400 words (it does so at the start of its next task) · open the file |
| Lead context | a lead averaged over 100k tokens of context per call in 30 days (serious over 150k) | the delegate reminder and compaction settings |
| Stale page | a library page not updated for 21 days and not read in 30 | archive it (moves to `teams/<team>/archive/`; move it back to restore) |
| Unused skill | a team skill approved over 7 days ago and never read | archive it |
| Handoff behind | a project job finished after the handoff was last saved | ask the lead to update it (via `handoff-facts` + `save_project_handoff`) |
| Repeated knowledge | a paragraph in two pages, memories or handoffs is half the same (5-word shingles, Jaccard ≥ 0.5) | tidy the library (the lead merges duplicates and fixes stale references) · open both |
| Routing | more than 20% of jobs needed God to route them | add project keywords in Teams & roles |
| Opus share | more than half of teammate tasks ran on Opus | rate answers so the track record can justify cheaper models |
| Failing role | a specialist finished under 70% of at least 3 tasks | review its instructions in Teams & roles |
| Rework | answers needed a follow-up within 2 hours, or changes were undone | open the jobs to see what was missed |

## Related

- `node scripts/job-cost.js <#job>` — one job's cost in detail; `node scripts/prompt-size.js --detail` — what each role carries.
- [Operations](operations.md) — costs, compaction, delegate reminders, outcome signals.
