#!/usr/bin/env bash
# Route the next phase of an earlier quota-mode router session.

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

echo "Herdr Model Router — resume a session"
echo

if ! router session --list --limit 10; then
  hold
  exit 1
fi

echo
echo "Leave the session id empty to use the most recent session."
read -r -p "session id> " session || session=""
read -r -p "next phase task> " task || task=""

if [ -z "${task// /}" ]; then
  echo "Cancelled."
  exit 0
fi

if [ -z "${session// /}" ]; then
  session="$(router session --json 2>/dev/null | node "$PLUGIN_ROOT/herdr-plugin/latest-session-id.mjs" 2>/dev/null || true)"
fi

if [ -z "$session" ]; then
  echo "No earlier session to resume." >&2
  hold
  exit 1
fi

echo
if router run --routing-mode quota "$task" --session "$session"; then
  notify "Herdr Model Router" "Resumed session $session" done
else
  notify "Herdr Model Router" "Resume failed — see the pane for details" request
  hold
  exit 1
fi

hold
