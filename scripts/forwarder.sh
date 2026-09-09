#!/usr/bin/env bash
# Keep one `gh webhook forward` alive for a repo.
#
# It exits on its own — "websocket: close 1006 (abnormal closure)" — and a dead forwarder
# is invisible from the outside: GitHub keeps returning 202 to the forwarding service,
# which simply has no subscriber to hand deliveries to. Those events are lost for good,
# because the dispatcher never sees them and backfill only replays what it received.
set -uo pipefail

REPO="${1:?repo required}"
PORT="${2:?port required}"
RUN_DIR="${PR_CHANNEL_RUN_DIR:-$HOME/.claude-pr-channel}"
SLUG="${REPO//\//-}"
LOG="$RUN_DIR/forward-$SLUG.log"
EVENTS='issue_comment,pull_request,pull_request_review,pull_request_review_comment,check_run,workflow_run'

stamp() { date -u +%H:%M:%SZ; }
note() { echo "[$(stamp)] $*" >> "$LOG"; }

cleanup() {
  for id in $(gh api "repos/$REPO/hooks" --jq '.[] | select(.config.url | contains("webhook-forwarder.github.com")) | .id' 2>/dev/null); do
    gh api -X DELETE "repos/$REPO/hooks/$id" >/dev/null 2>&1 && note "removed forwarding hook $id"
  done
  rm -f "$RUN_DIR/hooks-$SLUG"
}
trap 'note "supervisor stopping"; cleanup; exit 0' TERM INT

delay=2
while true; do
  # gh creates a fresh webhook on every start, so any earlier one must go or the repo
  # accumulates hooks that fire at a port nobody is listening on.
  cleanup
  note "starting forwarder for $REPO -> 127.0.0.1:$PORT"
  gh webhook forward --events="$EVENTS" --repo="$REPO" \
    --url="http://127.0.0.1:$PORT/webhook" --secret="$GITHUB_WEBHOOK_SECRET" >> "$LOG" 2>&1 &
  child=$!

  # Record the hook this run created, so `stop` can remove exactly it.
  ( sleep 4
    gh api "repos/$REPO/hooks" --jq '.[] | select(.config.url | contains("webhook-forwarder.github.com")) | .id' 2>/dev/null \
      | head -1 > "$RUN_DIR/hooks-$SLUG" ) &

  wait "$child"
  note "forwarder exited (status $?); restarting in ${delay}s"
  sleep "$delay"
  delay=$(( delay < 60 ? delay * 2 : 60 ))
done
