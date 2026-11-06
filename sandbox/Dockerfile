# The image sandboxed jobs run in (lib/sandbox.js): Claude Code, Node, git and the usual build tools, nothing of the
# user's. Built by the office on first use as agentos-sandbox:<Claude Code version>, matching the version on the computer.
FROM node:22-bookworm-slim

ARG CLAUDE_VERSION=latest
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl python3 python3-pip python3-venv make g++ ripgrep procps less jq \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
 && npm cache clean --force \
 && git config --system --add safe.directory '*'

# The office runs the container as the user's own uid, with HOME at /home/agent (the desk's private folder).
RUN mkdir -p /home/agent && chmod 1777 /home/agent
ENV HOME=/home/agent
