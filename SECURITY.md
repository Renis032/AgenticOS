# Security

Agentic OS runs AI agents that can read and change files and run commands on your computer, on your behalf. This page
explains what protects you, what you should know, and how to report a problem.

## What protects you

- **Local only.** The backend listens on `127.0.0.1` and refuses any request without the app token
  (`data/app-token`, created on first start and readable only by your user). The window presents the token once for a
  session cookie, and links to other sites open in your browser, not inside the app.
- **Your login, your data.** Agents use your own Claude Code login. Jobs, conversations, memories and configuration
  stay in this folder (`data/`, `teams/`, `roster.json`, `projects.json`, all ignored by git).
- **Edits stay in scope.** An agent edits only inside its job's project and scratch folders; anything else is blocked
  with a request you can approve or refuse. Every file is saved before an agent's first edit on a job, so the job's
  changes can be undone.
- **Commands ask first.** Terminal commands follow the mode you choose in Preferences: ask (the default), allow, or
  off. Commands on the block list never run.
- **Never commits or pushes.** Agents are told not to, and the agent eval checks that they don't.
- **Secrets stay out of what agents keep.** A memory, team-library page or lesson that contains something that looks
  like a password, key or token is refused, so secrets don't end up in files the agents re-read on every job.

## What you should know

- Agents act with your user's permissions inside the scope above. Review plans and command requests before approving
  them, especially in repositories that matter.
- Text an agent reads (web pages, files, issues) can contain instructions. Agents treat it as data, but no defence
  against prompt injection is perfect; keep command approval on for untrusted material.
- Anything sent to an agent is sent to Anthropic's API as part of the prompt, under your Claude account's terms.

## Reporting a vulnerability

Please report security problems privately through
[GitHub's private vulnerability reporting](https://github.com/Renis032/AgenticOS/security/advisories/new), not as a
public issue. Include what you found, how to reproduce it, and what an attacker could do with it. You'll get an answer
within a week.

Only the latest version on `main` receives security fixes.
