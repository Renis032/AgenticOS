---
name: search-connectors
description: Connect Claude to any app, even with no official connector, by the lightest way that works. Use when the user asks to connect, integrate or "get data from" an app or service.
---

Find the way in, checking in this order, and pick the lightest one that works:
1. **The maker's own tools** (an official CLI or SDK).
2. **A community CLI**: one short command that returns just the answer. Lightest on usage.
3. **The app's API**, usually with an API key. Heavier: replies are long.
4. **A community MCP server.** Heaviest: its full tool list loads into every chat. Keep MCPs few.

Rules:
- Search before deciding; note what exists for each step and why you skipped it.
- Never ask for keys in chat. If a key is needed, have the user paste it into a file (`~/.config/agentos/keys/<app>.key`, mode 600) and read it from there.
- Install nothing system-wide without asking; never run `sudo apt upgrade` or equivalents.
- Test with one real read (for example, list one item) before calling it done.
- Finish with: what you picked, why, the exact command or call to use it, and where the key lives.
