#!/usr/bin/env bash
# Pull the latest code and reinstall everything: CLI, skill, channel registration, config.
#
#   ./scripts/update.sh          update the branch you are on
#   pr-channel update            the same thing from anywhere
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
# Only tracked changes block a fast-forward; untracked files (stray notes, a local
# scratch dir) are none of our business.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "refusing to update: $ROOT has uncommitted changes to tracked files" >&2
  git status --short --untracked-files=no >&2
  exit 1
fi

# A branch that has been merged and deleted upstream would otherwise fail the pull with
# a bare "couldn't find remote ref". Fall back to the default branch and say so.
if ! git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  DEFAULT="$(git remote show origin | sed -n 's/.*HEAD branch: //p')"
  DEFAULT="${DEFAULT:-main}"
  echo "branch '$BRANCH' no longer exists on origin (merged); switching to $DEFAULT"
  git fetch -q origin "$DEFAULT"
  git checkout -q "$DEFAULT" 2>/dev/null || git checkout -q -b "$DEFAULT" "origin/$DEFAULT"
  BRANCH="$DEFAULT"
fi

BEFORE="$(git rev-parse HEAD)"
git pull --ff-only origin "$BRANCH"
AFTER="$(git rev-parse HEAD)"

if [ "$BEFORE" = "$AFTER" ]; then
  echo "already up to date on $BRANCH ($(git rev-parse --short HEAD))"
else
  echo "updated $BRANCH: $(git rev-parse --short "$BEFORE") -> $(git rev-parse --short "$AFTER")"
  git log --oneline "$BEFORE..$AFTER" | sed 's/^/  /'
fi

# Always reinstall: the skill, the channel registration and the config live outside the
# checkout, so pulling alone does not update them.
"$ROOT/scripts/install.sh"

echo
echo "Sessions pick up a new skill only when they start, so restart any that are open."
