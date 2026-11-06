#!/usr/bin/env bash
# One-command install for Agentic OS on Linux, macOS or WSL:
#   curl -fsSL https://raw.githubusercontent.com/Renis032/AgenticOS/main/install.sh | bash
# Checks what it needs, offers to install Claude Code with Anthropic's own installer, clones (or updates) the office
# into ~/agent-workplace (AGENTOS_DIR to change it), runs the setup wizard and opens it. It never uses sudo: anything
# that needs your package manager is printed for you to run. On Windows, use the desktop app (desktop/) instead.
# AGENTOS_OPEN=0 installs without opening the office (for unattended installs).
set -euo pipefail

REPO="${AGENTOS_REPO:-https://github.com/Renis032/AgenticOS.git}"
DIR="${AGENTOS_DIR:-$HOME/agent-workplace}"
OS="$(uname -s)"
WSL=0; grep -qi microsoft /proc/version 2>/dev/null && WSL=1

b() { printf '\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
no() { printf '  \033[31m✗\033[0m %s\n' "$*"; }
# Questions read the terminal even when this script comes through a pipe; with no terminal, the default is taken.
# /dev/tty can exist without a terminal behind it (CI, cron), so try to open it.
has_tty() { { : < /dev/tty; } 2>/dev/null; }
ask() {
  local q="$1" def="$2" a=""
  if has_tty; then printf '%s [%s] ' "$q" "$def" > /dev/tty; read -r a < /dev/tty || true; fi
  [[ "${a:-$def}" =~ ^[Yy] ]]
}
pm() { if [ "$OS" = "Darwin" ]; then echo "brew install $1"; else echo "sudo apt install $1"; fi; }

b "Installing Agentic OS"
case "$OS" in
  Linux|Darwin) ok "$([ "$OS" = Darwin ] && echo macOS || { [ $WSL = 1 ] && echo 'Linux (WSL)' || echo Linux; })" ;;
  *) no "This installer is for Linux, macOS and WSL. On Windows, use the desktop app (desktop/ in the repository)."; exit 1 ;;
esac

missing=0
if command -v git >/dev/null; then ok "git"; else no "git is missing: $( [ "$OS" = Darwin ] && echo 'xcode-select --install' || pm git )"; missing=1; fi
if command -v curl >/dev/null; then ok "curl"; else no "curl is missing: $(pm curl)"; missing=1; fi
if command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ]; then ok "Node.js $(node -v)"
else no "Node.js 18 or newer is missing: $( [ "$OS" = Darwin ] && echo 'brew install node' || echo 'see https://nodejs.org (or: sudo apt install nodejs)' )"; missing=1; fi
[ $missing = 0 ] || { echo; echo "Install what is missing, then run this again."; exit 1; }

if command -v claude >/dev/null; then ok "Claude Code $(claude --version 2>/dev/null | head -1)"
else
  no "Claude Code is not installed"
  if ask "  Install it now with Anthropic's installer (curl -fsSL https://claude.ai/install.sh | bash)? (y/n)" y; then
    curl -fsSL https://claude.ai/install.sh | bash
    export PATH="$HOME/.local/bin:$PATH"
    command -v claude >/dev/null && ok "Claude Code installed" || { no "Claude Code did not install; see https://claude.com/claude-code"; exit 1; }
  else
    echo "  Install it from https://claude.com/claude-code, then run this again."; exit 1
  fi
fi

echo
if [ -d "$DIR/.git" ]; then
  b "Updating $DIR"
  git -C "$DIR" pull --ff-only || { no "Could not update $DIR (local changes?). It is left as it was."; }
elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  no "$DIR exists and is not an Agentic OS checkout. Set AGENTOS_DIR to another folder."; exit 1
else
  b "Downloading into $DIR"
  git clone --depth 1 "$REPO" "$DIR"
fi

cd "$DIR"
echo
if has_tty; then node scripts/setup.js < /dev/tty; else node scripts/setup.js --yes; fi

echo
if [ "$OS" = Linux ] && [ $WSL = 0 ] && ! python3 -c "import gi; gi.require_version('WebKit2', '4.0')" 2>/dev/null; then
  echo "For the desktop window: sudo apt install python3-gi gir1.2-webkit2-4.0 (until then it opens in your browser)."
fi
if ! claude --version >/dev/null 2>&1 || [ ! -d "$HOME/.claude" ]; then
  echo "Sign in to Claude once: run \`claude\` in a terminal, or add an API key in the office under Preferences → Account."
fi
if [ "${AGENTOS_OPEN:-1}" != 0 ] && ask "Open Agentic OS now? (y/n)" y; then ./agentos; else echo "Start it any time with: $DIR/agentos"; fi
echo "Your first job is ready on the Today page: Getting set up → Start your first job."
