#!/usr/bin/env bash
# Start on boot, so a restart does not silently stop delivery.
#
#   pr-channel service install
#   pr-channel service remove
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT=/etc/systemd/system/pr-channel.service
ACTION="${1:-install}"

command -v systemctl >/dev/null || { echo "systemd is not available on this machine" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "installing a system unit needs root" >&2; exit 1; }

case "$ACTION" in
  install)
    sed -e "s|__ROOT__|$ROOT|g" -e "s|__HOME__|$HOME|g" -e "s|__USER__|$(id -un)|g" \
      "$ROOT/packaging/pr-channel.service" > "$UNIT"
    systemctl daemon-reload
    systemctl enable pr-channel.service >/dev/null
    echo "installed $UNIT and enabled it at boot"
    echo "it brings up every repo listed in \${PR_CHANNEL_RUN_DIR:-\$HOME/.claude-pr-channel}/repos"
    echo "start it now with: systemctl start pr-channel"
    ;;
  remove)
    systemctl disable --now pr-channel.service >/dev/null 2>&1 || true
    rm -f "$UNIT"
    systemctl daemon-reload
    echo "removed $UNIT"
    ;;
  *) echo "usage: pr-channel service install|remove" >&2; exit 2 ;;
esac
