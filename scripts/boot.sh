#!/usr/bin/env bash
# Bring up every repo this machine was using. Called by the systemd unit at startup and
# safe to run by hand: `up` is idempotent and releases routes left by the previous boot.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${PR_CHANNEL_RUN_DIR:-$HOME/.claude-pr-channel}"

if [ ! -s "$RUN_DIR/repos" ]; then
  echo "no repos recorded in $RUN_DIR/repos; nothing to bring up"
  exit 0
fi

status=0
while read -r repo; do
  [ -n "${repo:-}" ] || continue
  "$ROOT/scripts/pr-channel-up.sh" "$repo" || status=1
done < "$RUN_DIR/repos"
exit "$status"
