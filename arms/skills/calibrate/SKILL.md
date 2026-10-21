---
name: calibrate
description: Save a lesson the user taught so it is never needed twice. Use when the user corrects the same thing again, says "remember this", or explicitly calls /calibrate. Offer /calibrate instead of saving important lessons quietly.
---

When the user corrects you on something that matters, or corrects the same thing twice, offer: "Want me to /calibrate this?" Do not save it silently.

On /calibrate:
1. State the lesson as one principle (the why, not the instance) and the situations it applies to. Confirm it in one line if it is unclear.
2. Save it as a memory: one file in the project memory folder with frontmatter (`name`, `description`, `metadata.type: feedback`), the principle, **Why:** and **How to apply:**. Add one line to `MEMORY.md` linking it. Update an existing memory instead of duplicating one.
3. Link related memories with `[[their-name]]`.
4. If the lesson belongs to a skill (the mistake happened while following it), fix that skill too: fold the principle into its SKILL.md (sharper, not longer), show the diff, and after approval write it and add a line to the skill's `CHANGELOG.md`.
5. Reply with what was saved and what changed.
