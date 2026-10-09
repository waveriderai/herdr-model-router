#!/usr/bin/env bash
# Prompt for a role and a task, then launch every lane of that role in new panes.

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

echo "Herdr Model Router — route a task"
echo
if ! router roles; then
  hold
  exit 1
fi
echo
echo "Pick a role from the list above, then describe the task. Empty input cancels."
read -r -p "role> " role || role=""
read -r -p "task> " task || task=""

if [ -z "${role// /}" ] || [ -z "${task// /}" ]; then
  echo "Cancelled."
  exit 0
fi

echo
if router run "$task" --role "$role"; then
  notify "Herdr Model Router" "Dispatched $role: ${task:0:60}" done
else
  notify "Herdr Model Router" "Routing failed — see the pane for details" request
  hold
  exit 1
fi

hold
