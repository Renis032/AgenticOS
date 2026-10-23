#!/usr/bin/env bash
# Replaces this repository's history with one fresh commit of the current, cleaned files, so earlier commits that held
# runtime data (data/: job conversations, logs, the app token), the team libraries and the local roster are gone.
# You run this yourself; it never pushes. Afterwards push with:  git push --force origin main
#
# usage: scripts/clean-git-history.sh [--yes]
set -euo pipefail
cd "$(dirname "$0")/.."

branch="$(git branch --show-current)"
[ -n "$branch" ] || { echo "Not on a branch."; exit 1; }

echo "1/5  Staging the current files (.gitignore keeps data/, teams/, roster.json and projects.json out)…"
git add -A

leaks="$(git diff --cached --name-only --diff-filter=AM | grep -E '^(data/|teams/|roster\.json$|projects\.json$)' || true)"
[ -z "$leaks" ] || { echo "Refusing: these local files are staged:"; echo "$leaks"; exit 1; }

# Words that must never be committed come from the local roster.json (defaults.workArea: name, repo, private), not from this file.
pattern="$(node -e '
  let w = {}; try { w = require("./roster.json").defaults.workArea || {}; } catch {}
  const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const words = [w.name, w.repo && w.repo.replace(/^~\//, ""), ...(w.private || [])].filter(Boolean).map(esc);
  process.stdout.write(words.join("|"));')"
hits=""
[ -z "$pattern" ] || hits="$(git grep --cached -nIiE "$pattern" -- . ':!*.css' || true)"
if [ -n "$hits" ]; then
  echo "Refusing: work-related text is still in the files to commit:"; echo "$hits" | head -20; exit 1
fi

echo
echo "This rewrites '$branch' to a single commit and deletes all earlier commits from this clone."
echo "A full backup of the old history is saved first."
if [ "${1:-}" != "--yes" ]; then
  read -r -p "Continue? [y/N] " ok
  [ "$ok" = "y" ] || [ "$ok" = "Y" ] || { echo "Cancelled; nothing changed except the staging above."; exit 1; }
fi

backup="$HOME/agentos-history-backup-$(date +%Y%m%d-%H%M%S).bundle"
echo "2/5  Backing up the old history to $backup"
git bundle create "$backup" --all >/dev/null

echo "3/5  Creating one fresh commit of the current files…"
git checkout -q --orphan agentos-clean
git commit -q -m "Agentic OS

History restarted from a clean tree: runtime data, team libraries and the local roster are kept out of git."

echo "4/5  Replacing '$branch'…"
git branch -D "$branch" >/dev/null
git branch -m "$branch"

echo "5/5  Removing the old commits from this clone…"
git for-each-ref --format='%(refname)' refs/original/ 2>/dev/null | xargs -r -n1 git update-ref -d
git reflog expire --expire=now --all
git gc -q --prune=now --aggressive

echo
echo "Done. $(git rev-list --count HEAD) commit on '$branch'. Backup: $backup"
echo "Next, publish it (this replaces the history on GitHub):"
echo "    git push --force origin $branch"
echo "Until that push, the old commits stay reachable here through origin/$branch."
echo "GitHub can keep unreferenced old commits reachable by their hash for a while; if that matters, delete and recreate the"
echo "repository on GitHub before pushing, or ask GitHub support to purge cached views."
