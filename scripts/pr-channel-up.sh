#!/usr/bin/env bash
# Make sure the dispatcher is running and this repo's webhook is forwarded here.
#
#   ./scripts/pr-channel-up.sh owner/repo
#
# Each process is tracked by role. A dead forwarder is restarted on its own; it never
# needs the dispatcher killed, which is shared by every session on this machine.
set -euo pipefail

REPO="${1:-}"
[ -n "$REPO" ] || { echo "usage: $0 owner/repo" >&2; exit 2; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${PR_CHANNEL_RUN_DIR:-$HOME/.claude-pr-channel}"
PORT="${PR_CHANNEL_PORT:-8787}"
mkdir -p "$RUN_DIR"
touch "$RUN_DIR/repos"

slug() { echo "${1//\//-}"; }
alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

DISPATCHER_PID="$RUN_DIR/dispatcher.pid"
FORWARDER_PID="$RUN_DIR/forward-$(slug "$REPO").pid"

# Persisted so a restart does not invalidate webhooks GitHub already signs with it.
if [ ! -s "$RUN_DIR/secret" ]; then
  (umask 077; openssl rand -hex 32 > "$RUN_DIR/secret")
fi
chmod 600 "$RUN_DIR/secret"
export GITHUB_WEBHOOK_SECRET="$(cat "$RUN_DIR/secret")"
export PR_CHANNEL_PORT="$PORT"
export PR_CHANNEL_DB_PATH="${PR_CHANNEL_DB_PATH:-$RUN_DIR/channel.db}"
export PR_CHANNEL_COMMENT_AUTHORS="${PR_CHANNEL_COMMENT_AUTHORS:-$(gh api user --jq .login)}"
export PR_CHANNEL_RUN_DIR="$RUN_DIR"

known() { grep -qxF "$REPO" "$RUN_DIR/repos"; }
if ! known; then echo "$REPO" >> "$RUN_DIR/repos"; fi
mapfile -t REPOS < <(grep -v '^[[:space:]]*$' "$RUN_DIR/repos" | sort -u)
export PR_CHANNEL_REPO_ALLOWLIST="$(IFS=,; echo "${REPOS[*]}")"

cd "$ROOT"
pnpm run build >/dev/null

# Nothing survives a restart, so a route last touched before this boot is held by a
# session that no longer exists. Release those, or the next session on that PR is refused
# with `conflict` for a session that died with the machine.
if [ -r /proc/stat ]; then
  boot_epoch="$(awk '/^btime/ {print $2}' /proc/stat)"
  if [ -n "${boot_epoch:-}" ]; then
    released="$(node dist/cli.js prune --stale-before "$(date -u -d "@$boot_epoch" +%Y-%m-%dT%H:%M:%SZ)" 2>/dev/null \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s).released||[];if(r.length)console.log(r.map(x=>`${x.repo}#${x.prNumber}`).join(", "))}catch{}})')"
    [ -n "$released" ] && echo "released routes left by a previous boot: $released"
  fi
fi

# The dispatcher's repo allowlist is fixed at startup, so a repo it was not started with
# means restarting it. Forwarders are left alone: they reconnect to the same port.
allowlist_covers_repo() { [ -f "$RUN_DIR/allowlist" ] && grep -qxF "$REPO" "$RUN_DIR/allowlist"; }

if alive "$DISPATCHER_PID" && allowlist_covers_repo; then
  echo "dispatcher already running (pid $(cat "$DISPATCHER_PID"))"
else
  if alive "$DISPATCHER_PID"; then
    echo "dispatcher does not cover $REPO yet; restarting it"
    kill "$(cat "$DISPATCHER_PID")" 2>/dev/null || true
    sleep 1
  fi
  # setsid: delivery must outlive whatever started it. As a child of the calling shell
  # it dies when that session exits or its process group is reaped, and nothing says so.
  setsid nohup node dist/index.js > "$RUN_DIR/dispatcher.log" 2>&1 < /dev/null &
  echo "$!" > "$DISPATCHER_PID"
  printf '%s\n' "${REPOS[@]}" > "$RUN_DIR/allowlist"
  sleep 2
  alive "$DISPATCHER_PID" && echo "dispatcher started on 127.0.0.1:$PORT" \
    || { echo "dispatcher failed to start; see $RUN_DIR/dispatcher.log" >&2; exit 1; }
fi

if alive "$FORWARDER_PID"; then
  echo "already forwarding $REPO"
else
  [ -f "$FORWARDER_PID" ] && echo "forwarder for $REPO was down; restarting"
  setsid nohup "$ROOT/scripts/forwarder.sh" "$REPO" "$PORT" >> "$RUN_DIR/forward-$(slug "$REPO").log" 2>&1 < /dev/null &
  echo "$!" > "$FORWARDER_PID"
  sleep 5
  alive "$FORWARDER_PID" && echo "forwarding $REPO" || echo "forwarder for $REPO failed to start; see $RUN_DIR/forward-$(slug "$REPO").log" >&2
fi

echo "logs: $RUN_DIR"
