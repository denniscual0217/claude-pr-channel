#!/usr/bin/env bash
# Start the dispatcher and forward real GitHub webhooks to it, with no public endpoint.
#
#   ./scripts/start-local.sh owner/repo [owner/other-repo ...]
#
# Stop everything with ./scripts/stop-local.sh
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 owner/repo [owner/repo ...]" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${PR_CHANNEL_RUN_DIR:-$HOME/.claude-pr-channel}"
mkdir -p "$RUN_DIR"

PORT="${PR_CHANNEL_PORT:-8787}"

# Generated per run and held only in this process tree. Never written to disk.
# Note: gh webhook forward takes --secret on its command line, so it is visible in `ps`
# to local users. That is acceptable for a dev forwarder; a deployed webhook keeps the
# secret in GitHub's config and the dispatcher's environment instead.
export GITHUB_WEBHOOK_SECRET="$(openssl rand -hex 32)"
export PR_CHANNEL_PORT="$PORT"
export PR_CHANNEL_REPO_ALLOWLIST="$(IFS=,; echo "$*")"
export PR_CHANNEL_DB_PATH="${PR_CHANNEL_DB_PATH:-$RUN_DIR/channel.db}"
# Whose comments may drive a session. Defaults to you; widen it deliberately.
export PR_CHANNEL_COMMENT_AUTHORS="${PR_CHANNEL_COMMENT_AUTHORS:-$(gh api user --jq .login)}"
# What a session may run. Add your project's test command here.
export PR_CHANNEL_ALLOWED_TOOLS="${PR_CHANNEL_ALLOWED_TOOLS:-Bash(gh *),Bash(git *)}"

cd "$ROOT"
npm run build >/dev/null
: > "$RUN_DIR/pids"

node dist/index.js > "$RUN_DIR/dispatcher.log" 2>&1 &
echo "$!" >> "$RUN_DIR/pids"
sleep 2

for repo in "$@"; do
  gh webhook forward \
    --events='issue_comment,pull_request,pull_request_review,pull_request_review_comment,check_run,workflow_run' \
    --repo="$repo" \
    --url="http://127.0.0.1:$PORT/webhook" \
    --secret="$GITHUB_WEBHOOK_SECRET" > "$RUN_DIR/forward-${repo//\//-}.log" 2>&1 &
  echo "$!" >> "$RUN_DIR/pids"
done

sleep 3
echo "dispatcher  http://127.0.0.1:$PORT/webhook"
echo "database    $PR_CHANNEL_DB_PATH"
echo "authors     $PR_CHANNEL_COMMENT_AUTHORS"
echo "tools       $PR_CHANNEL_ALLOWED_TOOLS"
echo "repos       $*"
echo "logs        $RUN_DIR"
echo
echo "Now run /pr-channel <PR number> inside the Claude Code session for that checkout."
