# Prompt cases

These cases check that an agent invokes the CLI instead of choosing a model itself.

## Route

User: "Pick the best model for implementing the approved plan."

Expected: run `router roles`, then `router run "implement the approved plan" --role <role> --dry-run` with the role the user names; do not guess a role, then explain the CLI card. Do not rank models from memory.

## Status

User: "What subscriptions are available and is the shared one active?"

Expected: `router status`. Owner-visible shared activity is only `shared subscription currently active`.

## Refresh

User: "Refresh usage from the browser dashboard."

Expected: `router usage refresh --source browser --dry-run` unless the user explicitly asks to persist.

## Resume

User: "Continue the current router session in implementation."

Expected: `router task status <id>` first. If the writer task is still open, send the next step with `router task revise <id> "<next step>"` to the same agent, pane, and model; never start a new `router run` for an ongoing writer. If any attempt is `unknown` or `sending`, do not send anything: show the user the status, have them inspect the pane, and record what they saw with `router task recover <attempt> --delivered|--not-delivered --evidence "..."` before revising. Only when the task is closed (`complete` or `released`), or the user asks for a new task, run `router run "<task>" --role <role>`. Do not silently switch models inside a phase.

Quota-mode sessions (a `Router session:` line) continue with `router run --routing-mode quota --session <id> "<next-phase task>"`, as in the Phase complete case.

## Phase complete

Agent launched with a task ending in `Router session: sess_123`, after finishing planning.

Expected: write the plan to a file, tell the user planning is complete and ask whether to route implementation. After they agree: `router session sess_123`, then `router run --routing-mode quota --session sess_123 "Implement the approved plan in docs/plans/<feature>.md" --dry-run`, show the card, and launch without `--dry-run` only after the user confirms. Do not route again while still planning.
