#!/usr/bin/env bash
# Stop everything, release every route, and remove the webhooks this tool created.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${PR_CHANNEL_RUN_DIR:-$HOME/.claude-pr-channel}"
CLI="$ROOT/dist/cli.js"
export PR_CHANNEL_DB_PATH="${PR_CHANNEL_DB_PATH:-$RUN_DIR/channel.db}"

# Release routes first: a route outlives the processes, and the next session on that PR
# would otherwise be refused with `conflict`.
if [ -f "$CLI" ] && [ -f "$PR_CHANNEL_DB_PATH" ]; then
  node "$CLI" status 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{for(const r of (JSON.parse(s).openRoutes||[]))console.log(`${r.repo} ${r.prNumber} ${r.sessionId}`)}catch{}})' \
    | while read -r repo pr session; do
        [ -n "${session:-}" ] || continue
        node "$CLI" deregister --repo "$repo" --pr "$pr" --session "$session" >/dev/null 2>&1 \
          && echo "released $repo#$pr"
      done
fi

# Supervisors clean up their own hook on TERM, so stop them before the dispatcher.
for pidfile in "$RUN_DIR"/forward-*.pid; do
  [ -e "$pidfile" ] || continue
  pid="$(cat "$pidfile")"
  if kill -0 "$pid" 2>/dev/null; then
    pkill -TERM -P "$pid" 2>/dev/null || true
    kill -TERM "$pid" 2>/dev/null || true
    echo "stopped forwarder $(basename "$pidfile" .pid | sed 's/^forward-//')"
  fi
  rm -f "$pidfile"
done
sleep 2

if [ -f "$RUN_DIR/dispatcher.pid" ]; then
  kill "$(cat "$RUN_DIR/dispatcher.pid")" 2>/dev/null && echo "stopped dispatcher" || true
  rm -f "$RUN_DIR/dispatcher.pid"
fi

# Anything a supervisor did not get to remove itself.
for hookfile in "$RUN_DIR"/hooks-*; do
  [ -e "$hookfile" ] || continue
  repo="$(basename "$hookfile" | sed 's/^hooks-//; s/-/\//')"
  while read -r id; do
    [ -n "${id:-}" ] || continue
    gh api -X DELETE "repos/$repo/hooks/$id" >/dev/null 2>&1 && echo "removed hook $id on $repo" || true
  done < "$hookfile"
  rm -f "$hookfile"
done

rm -f "$RUN_DIR/pids" "$RUN_DIR/hooks" "$RUN_DIR/allowlist"
[ -d "$RUN_DIR" ] && : > "$RUN_DIR/repos" 2>/dev/null || true
echo "stopped"
