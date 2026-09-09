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

if [ -w /usr/local/bin ]; then BIN=/usr/local/bin; else BIN="$HOME/.local/bin"; mkdir -p "$BIN"; fi
ln -sf "$ROOT/bin/pr-channel" "$BIN/pr-channel"
echo "installed $BIN/pr-channel"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "  note: $BIN is not on PATH — add it to your shell profile" ;; esac

SKILL_DIR="$HOME/.claude/skills/pr-channel"
mkdir -p "$SKILL_DIR"
cp "$ROOT/skills/pr-channel/SKILL.md" "$SKILL_DIR/SKILL.md"
echo "installed $SKILL_DIR/SKILL.md"
echo
echo "Done. In a Claude Code session inside a PR's checkout: /pr-channel <number>"
