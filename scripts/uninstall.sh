#!/usr/bin/env bash
# Remove this tool from the machine. Stops everything, removes the webhooks it created,
# and unregisters the channel, the CLI and the skill.
#
#   ./scripts/uninstall.sh          keep the run directory (database, config, secret)
#   ./scripts/uninstall.sh --purge  delete it too
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${PR_CHANNEL_RUN_DIR:-$HOME/.claude-pr-channel}"

"$ROOT/scripts/stop-local.sh" || true

claude mcp remove pr-channel --scope user >/dev/null 2>&1 && echo "unregistered MCP channel server" || true

for dir in "${PR_CHANNEL_BIN_DIR:-}" /usr/local/bin "$HOME/.local/bin"; do
  [ -n "$dir" ] && [ -L "$dir/pr-channel" ] && rm -f "$dir/pr-channel" && echo "removed $dir/pr-channel"
done

SKILL_DIR="${PR_CHANNEL_SKILL_DIR:-$HOME/.claude/skills}/pr-channel"
[ -d "$SKILL_DIR" ] && rm -rf "$SKILL_DIR" && echo "removed $SKILL_DIR"

if [ "${1:-}" = "--purge" ]; then
  rm -rf "$RUN_DIR"
  echo "removed $RUN_DIR (database, config and secret)"
else
  echo "kept $RUN_DIR — pass --purge to delete the database, config and secret"
fi
echo "uninstalled"
