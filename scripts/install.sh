#!/usr/bin/env bash
# Install on this machine: build, put `pr-channel` on PATH, install the skill.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v node >/dev/null || { echo "node is required (v24+, for node:sqlite)" >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 24 ] || { echo "node 24+ required, found $(node -v) (node:sqlite)" >&2; exit 1; }
command -v gh >/dev/null || { echo "the GitHub CLI (gh) is required" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "run: gh auth login" >&2; exit 1; }
gh extension list 2>/dev/null | grep -q gh-webhook || gh extension install cli/gh-webhook

npm install --silent
npm run build >/dev/null

# Override with PR_CHANNEL_BIN_DIR to install somewhere else.
if [ -n "${PR_CHANNEL_BIN_DIR:-}" ]; then BIN="$PR_CHANNEL_BIN_DIR"; mkdir -p "$BIN"
elif [ -w /usr/local/bin ]; then BIN=/usr/local/bin
else BIN="$HOME/.local/bin"; mkdir -p "$BIN"; fi
if [ "$BIN/pr-channel" -ef "$ROOT/bin/pr-channel" ]; then
  echo "pr-channel already at $BIN/pr-channel"
else
  ln -sf "$ROOT/bin/pr-channel" "$BIN/pr-channel"
fi
echo "installed $BIN/pr-channel"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "  note: $BIN is not on PATH — add it to your shell profile" ;; esac

# Register the channel at user scope so every project and worktree picks it up without
# a .mcp.json of its own. Re-adding is how you update the path, so remove first.
claude mcp remove pr-channel --scope user >/dev/null 2>&1 || true
claude mcp add pr-channel --scope user -- node "$ROOT/dist/channel/channel-bin.js" >/dev/null
echo "registered MCP channel server 'pr-channel' (user scope)"

SKILL_DIR="${PR_CHANNEL_SKILL_DIR:-$HOME/.claude/skills}/pr-channel"
mkdir -p "$SKILL_DIR"
if [ "$SKILL_DIR/SKILL.md" -ef "$ROOT/skills/pr-channel/SKILL.md" ]; then
  echo "skill already at $SKILL_DIR/SKILL.md"
else
  cp "$ROOT/skills/pr-channel/SKILL.md" "$SKILL_DIR/SKILL.md"
fi
echo "installed $SKILL_DIR/SKILL.md"
RUN_DIR="${PR_CHANNEL_RUN_DIR:-$HOME/.claude-pr-channel}"
mkdir -p "$RUN_DIR"
if [ ! -f "$RUN_DIR/config" ]; then
  cat > "$RUN_DIR/config" <<'CFG'
# Settings for pr-channel on this machine. KEY=VALUE, no quotes, no export.
# Anything set in the environment overrides these for a single run.
# See `pr-channel config` for what is currently in effect.

# PR_CHANNEL_PORT=8787
# Logins whose comments may drive a session. Defaults to the authenticated gh user.
# PR_CHANNEL_COMMENT_AUTHORS=your-login,a-colleague
# Check names that make up "all required green".
# PR_CHANNEL_REQUIRED_CHECKS=ci/lint,ci/test
# PR_CHANNEL_LEASE_TIMEOUT_MS=60000

CFG
  echo "created $RUN_DIR/config"
fi

if pgrep -f 'dist/inde[x].js' >/dev/null 2>&1; then
  echo
  echo "NOTE: a dispatcher is already running with the previous settings."
  echo "      Run 'pr-channel stop' and start again for this install to take effect."
fi

echo
echo "Done."
echo
echo "Start sessions with the channel attached:"
echo "  claude --dangerously-load-development-channels server:pr-channel"
echo "Then, inside a PR's checkout: /pr-channel <number>"
