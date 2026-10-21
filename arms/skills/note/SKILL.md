---
name: note
description: Park feedback for a skill or app in that skill's own NOTES.md without fixing it now. Use when the user types /note mid-task ("/note <skill>: <feedback>"), or says to note something for later. Apply parked notes only when the user says "apply".
model: haiku
---

Two modes.

**Park** (`/note <skill>: <feedback>` or `/note <feedback>` while a skill is in use):
1. Find the skill: `~/.claude/skills/<skill>/` (or the skill used most recently in this chat). If it is ambiguous, ask which one in one short question.
2. Append one line to `~/.claude/skills/<skill>/NOTES.md` under `## Parked feedback`:
   `- YYYY-MM-DD: <the feedback, in the user's words> (context: <one short clause>)`
3. Reply with one line: what was parked and where. Do not change the skill. Go back to the task.

**Apply** (`/note apply [skill]`):
1. Read the skill's SKILL.md and every parked line in NOTES.md.
2. For each note, find the principle behind it. Fold the principles into SKILL.md so it gets sharper, not longer: replace or merge rules instead of stacking new ones.
3. Show the diff and wait for approval. After approval, write SKILL.md, move the applied notes to `## Applied` with today's date, and add one line per change to `CHANGELOG.md` (what changed and why).
4. Use the smallest model that can do the edit.
