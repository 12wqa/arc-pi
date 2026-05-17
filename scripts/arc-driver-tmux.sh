#!/usr/bin/env bash
# ARC proof-of-concept autodriver for Pi running inside tmux.
# Watches ~/.pi/agent/arc/trigger.json and submits the ARC rollover command
# that the extension has already drafted in Pi's editor.
#
# Usage:
#   # In the Pi pane, get its pane id:
#   tmux display-message -p '#{pane_id}'
#
#   # In another pane/shell:
#   scripts/arc-driver-tmux.sh %12
#
# Env:
#   ARC_TRIGGER_PATH=/path/to/trigger.json
#   ARC_DRIVER_MODE=enter|command   # default enter; command types the command itself
#   ARC_DRIVER_POLL_SECONDS=1

set -euo pipefail

TARGET="${1:-${ARC_TMUX_TARGET:-${TMUX_PANE:-}}}"
TRIGGER="${ARC_TRIGGER_PATH:-$HOME/.pi/agent/arc/trigger.json}"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/arc-pi"
STATE_FILE="$STATE_DIR/driver-last-trigger-id"
MODE="${ARC_DRIVER_MODE:-enter}"
POLL="${ARC_DRIVER_POLL_SECONDS:-1}"

if ! command -v tmux >/dev/null 2>&1; then
  echo "arc-driver-tmux: tmux is required" >&2
  exit 1
fi

if [[ -z "$TARGET" ]]; then
  echo "arc-driver-tmux: target pane required. Example: scripts/arc-driver-tmux.sh %12" >&2
  exit 1
fi

mkdir -p "$STATE_DIR"
touch "$STATE_FILE"

echo "arc-driver-tmux: watching $TRIGGER"
echo "arc-driver-tmux: target pane $TARGET, mode $MODE"
echo "arc-driver-tmux: Ctrl-C to stop"

while true; do
  if [[ -s "$TRIGGER" ]]; then
    payload="$(cat "$TRIGGER" 2>/dev/null || true)"
    id="$(node -e 'try{const fs=require("fs"); const p=process.argv[1]; const j=JSON.parse(fs.readFileSync(p,"utf8")); process.stdout.write(j.id||"");}catch{}' "$TRIGGER")"
    command_text="$(node -e 'try{const fs=require("fs"); const p=process.argv[1]; const j=JSON.parse(fs.readFileSync(p,"utf8")); process.stdout.write(j.command||"/arc-rollover threshold");}catch{process.stdout.write("/arc-rollover threshold")}' "$TRIGGER")"
    last_id="$(cat "$STATE_FILE" 2>/dev/null || true)"

    if [[ -n "$id" && "$id" != "$last_id" ]]; then
      echo "arc-driver-tmux: trigger $id -> $command_text"
      if [[ "$MODE" == "command" ]]; then
        tmux send-keys -t "$TARGET" "$command_text" Enter
      else
        # The extension has already used ctx.ui.setEditorText(command), so Enter is
        # the least invasive path. Use ARC_DRIVER_MODE=command if you prefer typing.
        tmux send-keys -t "$TARGET" Enter
      fi
      printf '%s' "$id" > "$STATE_FILE"
      mv "$TRIGGER" "$TRIGGER.consumed" 2>/dev/null || rm -f "$TRIGGER"
    fi
  fi
  sleep "$POLL"
done
