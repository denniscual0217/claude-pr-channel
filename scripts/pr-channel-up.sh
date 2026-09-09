#!/usr/bin/env bash
# Make sure the dispatcher is running and this repo's webhook is forwarded here.
#
#   ./scripts/pr-channel-up.sh owner/repo
#
# Idempotent: if the repo is already covered it does nothing and leaves in-flight work
# alone.
set -euo pipefail

REPO="${1:-}"
[ -n "$REPO" ] || { echo "usage: $0 owner/repo" >&2; exit 2; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${PR_CHANNEL_RUN_DIR:-$HOME/.claude-pr-channel}"
PORT="${PR_CHANNEL_PORT:-8787}"
mkdir -p "$RUN_DIR"
touch "$RUN_DIR/repos" "$RUN_DIR/hooks"

running() { [ -f "$RUN_DIR/pids" ] && while read -r p; do kill -0 "$p" 2>/dev/null && return 0; done < "$RUN_DIR/pids"; return 1; }

if running && grep -qxF "$REPO" "$RUN_DIR/repos"; then
  echo "already forwarding $REPO -> http://127.0.0.1:$PORT/webhook"
  exit 0
fi

grep -qxF "$REPO" "$RUN_DIR/repos" || echo "$REPO" >> "$RUN_DIR/repos"
mapfile -t REPOS < <(grep -v '^[[:space:]]*$' "$RUN_DIR/repos" | sort -u)

if running; then
  echo "adding $REPO; restarting the dispatcher"
  while read -r p; do kill "$p" 2>/dev/null || true; done < "$RUN_DIR/pids"
  sleep 2
fi

# `gh webhook forward` creates a fresh webhook every run and leaves the previous one
# active, so without this the repo accumulates hooks that keep firing with a dead secret.
# Only ids this script recorded are removed; the team's own integrations are never
# touched.
if [ -s "$RUN_DIR/hooks" ]; then
  while IFS=' ' read -r hook_repo hook_id; do
    [ -n "${hook_id:-}" ] || continue
    gh api -X DELETE "repos/$hook_repo/hooks/$hook_id" >/dev/null 2>&1 && echo "removed stale hook $hook_id on $hook_repo" || true
  done < "$RUN_DIR/hooks"
  : > "$RUN_DIR/hooks"
fi

# Persisted so a restart does not invalidate the webhooks GitHub already signs with it.
# 0600, in the run directory, never printed and never committed.
if [ ! -s "$RUN_DIR/secret" ]; then
  (umask 077; openssl rand -hex 32 > "$RUN_DIR/secret")
fi
chmod 600 "$RUN_DIR/secret"
export GITHUB_WEBHOOK_SECRET="$(cat "$RUN_DIR/secret")"

export PR_CHANNEL_PORT="$PORT"
export PR_CHANNEL_REPO_ALLOWLIST="$(IFS=,; echo "${REPOS[*]}")"
export PR_CHANNEL_DB_PATH="${PR_CHANNEL_DB_PATH:-$RUN_DIR/channel.db}"
export PR_CHANNEL_COMMENT_AUTHORS="${PR_CHANNEL_COMMENT_AUTHORS:-$(gh api user --jq .login)}"

cd "$ROOT"
npm run build >/dev/null
: > "$RUN_DIR/pids"

node dist/index.js > "$RUN_DIR/dispatcher.log" 2>&1 &
echo "$!" >> "$RUN_DIR/pids"
sleep 2

for repo in "${REPOS[@]}"; do
  before="$(gh api "repos/$repo/hooks" --jq '[.[] | select(.config.url | contains("webhook-forwarder.github.com")) | .id] | join(" ")' 2>/dev/null || echo "")"
  gh webhook forward \
    --events='issue_comment,pull_request,pull_request_review,pull_request_review_comment,check_run,workflow_run' \
    --repo="$repo" \
    --url="http://127.0.0.1:$PORT/webhook" \
    --secret="$GITHUB_WEBHOOK_SECRET" > "$RUN_DIR/forward-${repo//\//-}.log" 2>&1 &
  echo "$!" >> "$RUN_DIR/pids"
  sleep 4
  for id in $(gh api "repos/$repo/hooks" --jq '.[] | select(.config.url | contains("webhook-forwarder.github.com")) | .id' 2>/dev/null); do
    case " $before " in *" $id "*) ;; *) echo "$repo $id" >> "$RUN_DIR/hooks" ;; esac
  done
done

echo "forwarding: ${REPOS[*]}"
echo "dispatcher: http://127.0.0.1:$PORT/webhook   logs: $RUN_DIR"
