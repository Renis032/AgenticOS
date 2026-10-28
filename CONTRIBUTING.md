# Contributing

Thanks for helping. This guide covers how the code is laid out, the conventions it follows, and how to check and send
a change.

## Getting set up

```bash
git clone https://github.com/Renis032/AgenticOS.git && cd AgenticOS
npm install          # development tools only (ESLint); the app itself has no dependencies
./agentos demo       # a throwaway office with stand-in agents, to see your change without spending anything
```

## Layout

| Path | What it is |
|---|---|
| `server.js` | startup, shared state and wiring; everything else is a module it installs |
| `lib/` | the server's parts, each `install(ctx)` getting what it uses from server.js (see [docs/architecture.md](docs/architecture.md)) |
| `lib/mcp-delegate.js` | the office tools every agent gets over MCP (delegate, plans, scripts, memory…) |
| `lib/mail-hook.js` | the hook on every agent tool call (save before edit, script redirects, mail) |
| `public/` | the window's UI: `os.html`, `ui/os.css`, `ui/os/*.js` (classic scripts sharing one scope) |
| `app/agentos-window.py` | the native GTK + WebKitGTK window and tray |
| `scripts/` | office scripts agents call (listed in `scripts/manifest.json`) and development commands |
| `docs/` | user and operator documentation |

## Conventions

- **No runtime dependencies.** Node's standard library only; development tools live in `devDependencies`.
- **Anything deterministic is a script, never model work.** If agents keep doing a mechanical step by hand, it becomes
  an office script (`scripts/<name>.js` plus a `scripts/manifest.json` entry), or a team script in
  `teams/<team>/scripts/` when it only makes sense for that team's repository.
- **Modules follow the existing pattern**: `module.exports = { install }`, a short header comment saying what the module
  is for, and `install(ctx)` destructuring what it needs.
- **Match the surrounding code**: its naming, comment density and idiom. Comments explain why, not what.
- **Nothing personal in tracked files.** Employer names, private paths and personal data belong only in the ignored
  `roster.json` (`defaults.workArea`) and `projects.json`.

## Checking a change

```bash
npm test           # every file parses, then the API check on a throwaway office (seconds, nothing spent)
npm run lint
npm run test:ui    # if the window changed: clicks through every app on a virtual screen (needs Xvfb)
node scripts/agent-eval.js   # if agent instructions changed: real agents on Haiku (a few cents)
```

CI runs the syntax check, lint and API check on Node 18, 20 and 22, and the window check, on every push and pull request.

## Sending a change

1. Branch from `main`.
2. Keep the change focused; update the docs and `CHANGELOG.md` (under *Unreleased*) when behaviour changes.
3. Write commit messages that say what changed and why, in the
   [Conventional Commits](https://www.conventionalcommits.org/) style: `feat: …`, `fix: …`, `docs: …`, `refactor: …`.
4. Open a pull request and fill in the template.

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
