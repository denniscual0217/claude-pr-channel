#!/usr/bin/env bash
# Pull the latest code and reinstall everything: CLI, skill, channel registration, config.
#
#   ./scripts/update.sh          update the branch you are on
#   pr-channel update            the same thing from anywhere
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ -n "$(git status --porcelain)" ]; then
  echo "refusing to update: $ROOT has uncommitted changes" >&2
  git status --short >&2
  exit 1
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
