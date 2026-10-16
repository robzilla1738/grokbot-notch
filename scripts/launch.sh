#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${HOME}/Library/Logs/grokbot-notch"
mkdir -p "$LOG_DIR"
chmod 700 "$LOG_DIR"
LOG_FILE="${LOG_DIR}/server.log"
touch "$LOG_FILE"
chmod 600 "$LOG_FILE"
APP_BUNDLE="$ROOT_DIR/GrokBot Notch.app"

if [ ! -d "$APP_BUNDLE" ]; then
  "$ROOT_DIR/scripts/build-mac-app.sh"
fi

# Ensure previous instance is stopped cleanly before relaunching
pkill -f "GrokBotNotch" 2>/dev/null || true
lsof -ti :4789 | xargs kill -9 2>/dev/null || true

nohup node "$ROOT_DIR/server.mjs" >>"$LOG_FILE" 2>&1 &
sleep 0.5

open "$APP_BUNDLE"
echo "GrokBot Notch.app is now running at the top of your screen!"
echo "Local preview & API server: http://127.0.0.1:4789"
