# CLI usage collection and log-only pane watching

## Goal and authority

Implement the local usage collector first, then a deterministic Herdr pane watcher. Deliver an open PR and stop before Step 3 cutover. The task document is `~/cli-watchers/TASK-usage-and-watcher.md`. The current request overrides automatic merge and deployment policy.

## Baseline and constraints

Baseline commit: `004324629f542131fd7431114e2550b4fb927bee`. The target branch is `codex/cli-watchers/usage-and-watcher`; the starting tree is clean. DevPro is the execution host. The existing collector is an unmanaged local file run by cron every five minutes. Neither local runtime directory is a git repository.

Keep implementation in this repository under `scripts/cli-watchers/`, with tests and English operator documentation. Back up the existing collector into private local scratch before implementation. Do not install or replace the runtime collector, alter cron or launchd, enable paused routines, edit ForceCommand, expose public ports, upload runtime data, send notifications, prompt panes, dispatch development, merge, or deploy. Real provider data and pane captures remain local and untracked. Never print credentials, account emails, raw provider JSON, or raw pane content.

Codex owns planning, acceptance, commits, PR creation, and CI. Claude Opus authors implementation through the existing interactive Herdr subscription and agent-collab writer lock. The ce-work engine gate must be checked. Its bundled detached headless controller is incompatible with the required same-worktree interactive adapter, so record that limitation explicitly rather than claiming the bundled controller ran or falling back to Codex implementation.

## U1. Repair usage collection

Files: `scripts/cli-watchers/collect.py`, collector tests, and collector documentation.

Preserve primary, secondary, and tertiary windows; include `usage.extraRateWindows` with stable meter identities, especially Cursor `cursor-grok-bot`, separate from provider Grok. Each row carries an anonymous account identifier, provider, meter ID, used percentage, provider update time, collection time, reset time, and a bounded error code. Do not persist raw identities, credentials, provider errors, or payloads. Scope retained readings by provider, account, meter, and reset cycle; never infer consumption across accounts or resets.

Use an exclusive nonblocking process lock, configurable provider timeout and total round deadline, and checked CLI exit codes. Missing windows, invalid data, authentication failures, nonzero exits, and timeouts must produce error/stale records rather than zero usage. Preserve the last successful reading and its time. Append history and atomically replace latest state. Keep all runtime files outside git with restrictive permissions.

Inspect installed CodexBar help, then inspect real Cursor JSON in memory through an allowlist. Add synthetic tests for all windows, multiple accounts, missing fields, nonzero exit, timeout, global deadline, stale reads, reset changes, atomic output, and concurrent rounds. Run one real collection into a private scratch output directory and report only anonymous readings and timestamps. Codex must accept U1 before U2 starts.

## U2. Implement a log-only watcher

Depends on U1 acceptance. Files: `scripts/cli-watchers/watch.py`, watcher tests, parameterized launchd template, and operator documentation.

Use only verified read-only Herdr CLI/API commands. Low-frequency discovery finds tasks/panes; high-frequency polling reads only running tasks. Idle/done panes leave the active set. Compare lifecycle state and new content, with a task/session-aware restart identity. Persist local full snapshots privately; events contain only a bounded redacted summary of new content. Nothing is sent to a bot in this version.

Deduplicate using task/pane ID, event type, and content digest. The same unresolved blocker must remain suppressed across content churn and watcher restarts, but resolution and a genuinely new blocker must be visible. Record heartbeats and detected, deduplicated, and human-judgment event counts. Recover state safely after restart. Never invoke any LLM or mutating Herdr command.

Use synthetic Herdr fakes for tests of unchanged output, completion, blocker, error, restart, idle removal, discovery frequency, dedup persistence, secret redaction, and failed reads. Perform bounded real read-only smoke runs against this task's explicitly identified pane, storing captures locally. Provide concrete parameterized DevPro launchd files and start/stop/recovery instructions without installing or loading them.

## Verification and delivery

Run focused Python tests, inspect baseline-to-final changes, and run `npm run verify` as the repository gate. Reuse relevant passing evidence. Inspect all staged paths for personal identifiers and runtime data before publishing. Open a PR with implementation, validation, and the explicit cutover stop condition. Observe CI on the final head. Do not merge or deploy.

## Deferred Step 3

Routine replacement, schedule changes, cutover, live notification delivery, coordinator assignment, and automated retries of service startup remain unexecuted. Stop and report after U1 and U2 and the PR are ready for review.

## Acceptance checkpoint

U1 and U2 are complete and accepted after independent review. The final collector rejects missing windows, unidentified accounts, invalid or future provider timestamps, and cross-reset deltas. The watcher preserves ordinary output values and diff prefixes, redacts complete private-key blocks, logs completion after blocker resolution, and recovers failed final captures at discovery frequency.

`npm run verify` passed with Node 24: 992 Vitest tests and 61 Python tests. The DevPro system Python 3.9.6 passed the full Python suite; the final watcher changes also passed its 25 watcher tests on that interpreter. Live validation used private local evidence only. It confirmed the Cursor Grok Bot meter and distinct Grok provider, and unchanged watcher ticks produced no events.

The PR contains source, synthetic tests, and documentation only. CI evidence belongs to the published PR head. The existing collector, cron job, launchd jobs, and paused routines remain unchanged. U3 is unexecuted and requires separate cutover authorization.
