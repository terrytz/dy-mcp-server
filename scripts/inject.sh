#!/usr/bin/env bash
set -euo pipefail

# inject.sh — Patch the 抖音聊天 app.asar to inject the HTTP API server.
#
# Usage:
#   ./inject.sh              # Patch the app
#   ./inject.sh --restore    # Restore the original app.asar from backup
#   ./inject.sh --status     # Check if the app is patched
#
# Requires: Node.js 18+, 抖音聊天 app installed in /Applications

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PATCHER="$SCRIPT_DIR/patch-asar.cjs"

die() { echo "Error: $*" >&2; exit 1; }

[ -f "$PATCHER" ] || die "patch-asar.cjs not found at $PATCHER"

quit_app() {
  if pgrep -f "抖音聊天" >/dev/null 2>&1; then
    echo "  Quitting 抖音聊天..."
    osascript -e 'quit app "抖音聊天"' 2>/dev/null || true
    sleep 2
  fi
}

case "${1:-}" in
  --restore|-r)
    quit_app
    node "$PATCHER" restore
    echo ""
    echo "Restart the app:  open -a '抖音聊天'"
    ;;

  --status|-s)
    node "$PATCHER" status
    ;;

  --help|-h)
    echo "Usage: ./inject.sh [--restore|--status|--help]"
    echo ""
    echo "  (no args)    Patch the app with the API server"
    echo "  --restore    Restore the original unpatched app.asar"
    echo "  --status     Check if the app is currently patched"
    ;;

  *)
    quit_app
    node "$PATCHER" patch

    echo ""
    read -rp "Start 抖音聊天 now? [Y/n] " yn
    case "$yn" in [nN]*) ;; *)
      echo "  Launching 抖音聊天..."
      open -a "抖音聊天"
      echo "  Waiting for API server..."
      for i in $(seq 1 15); do
        if node "$SCRIPT_DIR/../bin/dy" health >/dev/null 2>&1; then
          echo "  API server is up!"
          node "$SCRIPT_DIR/../bin/dy" health
          exit 0
        fi
        sleep 2
      done
      echo "  API server not responding yet. It may take a moment after login."
      ;;
    esac
    ;;
esac
