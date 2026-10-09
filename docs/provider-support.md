# Provider support

## Rules mode

Rules mode builds each lane's argv from the descriptor and checks it against the installed
CLI's `--help` before every launch. Versions checked locally for this release (help text only;
no live launch):

| Provider   | CLI checked                                     | argv (writer / read-only extra)                                                |
| ---------- | ----------------------------------------------- | ------------------------------------------------------------------------------ |
| `claude`   | Claude Code 2.1.295                             | `claude --model <id> [--effort <e>]` / `--permission-mode plan`                |
| `codex`    | codex-cli 0.161.0                               | `codex --model <id> [-c model_reasoning_effort="<e>"]` / `--sandbox read-only` |
| `grok`     | grok 1.0.50 (native xAI CLI, Herdr kind `grok`) | `grok --model <id> [--reasoning-effort <e>]` / `--permission-mode plan`        |
| `cursor`   | Cursor Agent 2026.10.01 (`cursor-agent`)        | `cursor-agent --model <id>` / `--mode plan`                                    |
| `opencode` | not installed here                              | `opencode --model <provider/model>`; read-only lanes refused                   |

The router starts the absolute executable it resolved on `PATH` inside the new pane (through
`env -i`, see [Rules mode](rules.md#launch)), requires Herdr to detect the matching agent kind,
and requires the pane's screen to show that CLI's ordinary prompt with no startup dialog
([readiness check](rules.md#readiness-check)). On some machines a bare `agent` is another
vendor's CLI, which is why Cursor is always `cursor-agent`.

Coordinator workflows bind the writer's native session id and working directory from Herdr's
agent record (`agent_session`, `foreground_cwd`). A provider whose Herdr integration does not
report a session cannot be a workflow writer; the router refuses it before any prompt and
names the missing session. The agent-collab backend takes a Claude writer only.

### Live checks

One read-only panel was run through the router in real Herdr panes, in a fresh directory, with
the prompt "Respond with exactly ROUTER_SMOKE_OK":

| Provider | Model                         | Result                                                                                             |
| -------- | ----------------------------- | -------------------------------------------------------------------------------------------------- |
| `grok`   | `grok-4.7` at `high`          | Verified: the pane showed `ROUTER_SMOKE_OK`                                                        |
| `codex`  | `gpt-6.1-sol` at `high`       | Unverified: interactive update menu at start; Herdr never reported it ready and no prompt was sent |
| `claude` | `claude-sonnet-5-5` at `high` | Unverified: first-run workspace trust dialog                                                       |
| `cursor` | `grok-4.7-high`               | Unverified: first-run workspace trust dialog                                                       |

That run predates the readiness check. The router now refuses all three dialogs before
prompting. Claude, Cursor and Codex become checkable once an operator has opened each CLI
in the directory and finished its trust or update step.

The same run checked the environment of the real `grok` and `cursor-agent` processes, and of
a fake executable launched by the final router in a real pane, for API-key and cloud-credential
variable names and synthetic canary values. None were present, and credential values were never
read. Persistent CLI logins (config files, OS keychain) are operator-owned and were not changed.

### Coordinator workflow live checks

Both writer authorities were run end to end in real Herdr panes, on a test worktree whose
first-run trust step the operator had already completed, with the operator's own existing
subscriptions:

| Role               | Provider and model         | Result                                                                   |
| ------------------ | -------------------------- | ------------------------------------------------------------------------ |
| Writer             | `claude:claude-opus-5-5`   | Verified: received the brief in one session and reported its result      |
| Read-only verifier | `claude:claude-sonnet-5-5` | Verified: ran read-only on the reported revision and reported its result |

- Standalone: start, result, verify, accept, delivery and release completed. This run had no
  revision.
- agent-collab: preflight, acquire, dispatch, receipt, request-changes, a correction sent as a
  second attempt to the same writer session and pane, re-verification, accept, a local
  delivery recorded as not applicable, and release completed. Afterwards agent-collab reported
  the worktree unlocked.

In the same tests:

- In a directory not yet trusted, the CLI showed its workspace trust screen. The router
  refused the lane and sent no prompt.
- In a narrow pane, the CLI's composer was not fully visible. The readiness check refused it,
  and the router closed that pane with no prompt sent. The same roles worked in wide panes, one
  role per Herdr tab.

The router never answers a trust, login, update or permission dialog. Before routing a CLI in
a new directory, open it there once yourself and finish its first-run steps. Keep each lane's
pane wide enough to show the CLI's whole input box; one role per tab avoids squeezed splits.
Only the providers and models listed in these tables were checked live; other models and
providers are not claimed.

## Quota mode

Availability and quota still come from collectors. The catalog is operator-curated
launch profiles, not a claim that a model is currently offered.

| Agent                | Verified locally (this workspace)                                                                                              | Usage collection                                                                                                                  | Notes                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Cursor `agent`       | `--model cursor-grok-4.6-medium`. No `--thinking`. Do not pass `--force` by default. Medium effort is encoded in the model ID. | Parser fixtures only. Live usage commands are not wired.                                                                          | `--list-models` was not run; it may consume quota.                                                                        |
| Claude Code `claude` | `--model` and `--effort` (`low`, `medium`, `high`; `xhigh` and `max` for Opus 5.5). The router does not map `ultra` to Claude. | Fixture: five-hour window missing → estimated weekly + diagnostic.                                                                | Opus 5.5 live effort switching: `/effort` slider, "this session only" (Claude Code 2.1.283).                              |
| Codex `codex`        | `--model` only. No reasoning-effort flag in `codex --help`.                                                                    | Local-session: `~/.codex/statusline-quota-cache.json` `{ weekly_left, at }` (percent remaining, Unix seconds, 15-minute max age). | The router does not write this file. GPT 6 Astra live effort switching: `Alt+.` / `Alt+,`, next turn (codex-cli 0.156.1). |
| OpenCode             | Interactive start: `--model provider/model`. `--variant` exists on `opencode run`, not the TUI flags used for Herdr start.     | Harness auth/models only; quota belongs to the underlying provider.                                                               |                                                                                                                           |

Browser dashboard parsers are fragile estimated fallbacks against sanitized HTML fixtures.
They never copy cookie databases.

Local 2026-09-17 CLI dry runs did not attach a live dashboard; browser `--dry-run` reported unknown five-hour usage.
