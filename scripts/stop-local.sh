#!/usr/bin/env bash
# Stop the dispatcher and forwarders, and remove the webhooks this tool created.
set -euo pipefail
RUN_DIR="${PR_CHANNEL_RUN_DIR:-$HOME/.claude-pr-channel}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT/dist/cli.js"
export PR_CHANNEL_DB_PATH="${PR_CHANNEL_DB_PATH:-$RUN_DIR/channel.db}"

# Release every route before killing anything. A route outlives the processes, so a
# session that ends here would otherwise hold its PR forever and the next session on
# that PR would be refused with `conflict`.
if [ -f "$CLI" ] && [ -f "$PR_CHANNEL_DB_PATH" ]; then
  node "$CLI" status 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{for(const r of (JSON.parse(s).openRoutes||[]))console.log(`${r.repo} ${r.prNumber} ${r.sessionId}`)}catch{}})' \
    | while read -r repo pr session; do
        [ -n "${session:-}" ] || continue
        node "$CLI" deregister --repo "$repo" --pr "$pr" --session "$session" >/dev/null 2>&1 \
          && echo "released $repo#$pr"
      done
fi

if [ -f "$RUN_DIR/pids" ]; then
  while read -r pid; do kill "$pid" 2>/dev/null || true; done < "$RUN_DIR/pids"
  rm -f "$RUN_DIR/pids"
fi

# Left behind, these keep firing at a port nobody is listening on.
if [ -s "$RUN_DIR/hooks" ]; then
  while IFS=' ' read -r repo id; do
    [ -n "${id:-}" ] || continue
    gh api -X DELETE "repos/$repo/hooks/$id" >/dev/null 2>&1 && echo "removed hook $id on $repo" || true
  done < "$RUN_DIR/hooks"
  : > "$RUN_DIR/hooks"
fi
[ -d "$RUN_DIR" ] && : > "$RUN_DIR/repos" 2>/dev/null || true
echo "stopped"
