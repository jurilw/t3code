#!/usr/bin/env bash
# NOTIFY_CMD for selfrepair.sh: reads the note on stdin.
#   Always: appends it, stamped in UTC, to $STATE_DIR/ATTENTION.md (the orchestrator reads it).
#   Only when NOTIFY_TELEGRAM=1: also sends it to Juri through the tracker's Telegram bot
#     (token TRACKER_TELEGRAM_TOKEN from ~/fast/life/tracker/config/secrets.env,
#      chat id from telegram.chat_id in ~/fast/life/tracker/config/config.json).
#   NOTIFY_DRY_RUN=1: print the Telegram payload (token redacted) instead of sending it.
# Exit 0 when the note was recorded (and sent, if asked); 1 otherwise.
set -euo pipefail

STATE_DIR="${STATE_DIR:-$HOME/.local/state/t3code-selfrepair}"
TRACKER_CONFIG_DIR="${TRACKER_CONFIG_DIR:-$HOME/fast/life/tracker/config}"
note="$(cat)"
[ -n "$note" ] || { echo "notify.sh: empty note on stdin" >&2; exit 1; }

mkdir -p "$STATE_DIR"
{
  echo "## $(date -u +%Y-%m-%dT%H:%M:%SZ) t3code-selfrepair"
  echo
  echo "$note"
  echo
} >>"$STATE_DIR/ATTENTION.md"

[ "${NOTIFY_TELEGRAM:-}" = 1 ] || exit 0

token="$(sed -n 's/^TRACKER_TELEGRAM_TOKEN=//p' "$TRACKER_CONFIG_DIR/secrets.env" 2>/dev/null | tail -1 | tr -d "\"' ")"
chat_id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["telegram"]["chat_id"])' \
  "$TRACKER_CONFIG_DIR/config.json" 2>/dev/null || true)"
[ -n "$chat_id" ] || { echo "notify.sh: no telegram.chat_id in $TRACKER_CONFIG_DIR/config.json" >&2; exit 1; }
# Telegram caps a message at 4096 characters.
text="T3 Code self-repair needs attention
$(printf '%s' "$note" | head -c 3800)"

if [ "${NOTIFY_DRY_RUN:-}" = 1 ]; then
  echo "DRY RUN: would POST https://api.telegram.org/bot<redacted>/sendMessage"
  echo "chat_id=$chat_id"
  echo "text=$text"
  exit 0
fi
[ -n "$token" ] || { echo "notify.sh: TRACKER_TELEGRAM_TOKEN missing in $TRACKER_CONFIG_DIR/secrets.env" >&2; exit 1; }
curl -fsS --max-time 20 -o /dev/null "https://api.telegram.org/bot$token/sendMessage" \
  --data-urlencode "chat_id=$chat_id" --data-urlencode "text=$text"
