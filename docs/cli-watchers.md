# CLI watchers

Local, read-only helpers that run beside Herdr. They use only the Python standard library and
live in `scripts/cli-watchers/`.

## Usage collector

`scripts/cli-watchers/collect.py` reads provider usage through the installed CodexBar CLI and
writes it to a private state directory. It replaces the unmanaged AGENT-197 collector. Rules
mode reads the result through `HMR_USAGE_FILE` (see
[Usage numbers](configuration.md#usage-numbers)).

### Run one round

```sh
python3 scripts/cli-watchers/collect.py --state-dir "<state-dir>" --report
```

`--state-dir` (or `HMR_USAGE_DIR`) is required; the collector has no default output path.
`--report` prints one anonymous line per meter to stdout: provider, account ID, meter ID,
used percentage, reset time, provider update time, collection time, `fresh` or `stale`, and
the error code.

| Option                | Default                     | Meaning                                                  |
| --------------------- | --------------------------- | -------------------------------------------------------- |
| `--providers`         | `codex,claude,cursor,grok`  | Providers, called one at a time.                         |
| `--codexbar`          | `CODEXBAR_BIN`, then `PATH` | CodexBar CLI path.                                       |
| `--provider-timeout`  | `60`                        | Seconds for one provider call.                           |
| `--round-deadline`    | `240`                       | Seconds for the whole round. Keep it below the schedule. |
| `--stale-after`       | `30`                        | Minutes after which a provider update time is stale.     |
| `--forget-after-days` | `14`                        | Days after which an unseen meter is dropped from state.  |
| `--warn-pct`          | `80`                        | Local alert threshold.                                   |
| `--all-accounts`      | off                         | Pass `--all-accounts` to CodexBar.                       |

Exit codes: `0` every meter is fresh; `1` the round was written but some provider failed or
some meter is stale; `2` invalid configuration or an unsafe state path; `75` another round holds the lock, so this
round wrote nothing.

### What one round does

1. Takes an exclusive, non-blocking `flock` on `<state-dir>/collect.lock`. A second round
   exits with `75` instead of waiting.
2. Runs `codexbar usage --provider <id> --format json --no-color` for each provider in its own
   process group. The provider timeout is capped by the time left in the round deadline. On
   expiry the whole process group is killed. Providers that the deadline skips are recorded
   as `deadline_exceeded`.
3. Keeps stdout in memory only and discards stderr unread. It projects an allowlist:
   `primary`, `secondary`, `tertiary`, every `usage.extraRateWindows` entry (for example
   Cursor `cursor-grok-bot`), `usedPercent`, `resetsAt`, `windowMinutes`, and
   `usage.updatedAt`.
4. Replaces account identity with `acct-<12 hex>`. The ID is an HMAC-SHA256, keyed by
   `<state-dir>/account.key`, over the provider and the account ID, email, and organization.
   The identity never leaves memory. An entry without any identity field is not trusted: the
   collector records `ambiguous_account` and keeps no reading, `last_good`, or delta for it.
5. Merges with `state.json`, appends one line to `history.jsonl`, appends threshold alerts
   to `alerts.jsonl`, and atomically replaces `state.json` and `usage.json`.

Every round sets the state directory to mode `0700` and its files to mode `0600`, including a
reused directory; `history.jsonl` keeps its earlier lines. The collector exits with `2` and
writes nothing when the directory or one of its files is a symlink, has another owner, or is
not the expected type. Keep the state directory outside any Git checkout.

### Meters

A meter is one provider, anonymous account, and meter ID. Standard windows use the slot name
(`primary`, `secondary`, `tertiary`); extra windows use their CodexBar `id`. Cursor
`cursor-grok-bot` is therefore a Cursor meter, separate from the `grok` provider.

Provider labels and titles are free text and are never stored. A standard window keeps its
CodexBar label only when it is one of a fixed vocabulary (`Session`, `Hourly`, `Daily`,
`Weekly`, `Monthly`, `Total`, `Usage`, `Requests`, `Credits`, `Auto`, `API`, `Premium`,
`Opus`, `Sonnet`, `Cursor`, `Grok`); otherwise its label is the slot name. An extra window's
label is its meter ID.

Each entry of `usage.json` `meters` (and of each `history.jsonl` line) has:

| Field              | Meaning                                                                          |
| ------------------ | -------------------------------------------------------------------------------- |
| `provider`         | CodexBar provider ID.                                                            |
| `account`          | Anonymous account ID; `null` for a provider-level failure.                       |
| `meter`            | Meter ID; `null` for a provider-level failure.                                   |
| `kind`             | `standard`, `extra`, `account`, or `provider`.                                   |
| `label`            | Fixed-vocabulary label or meter ID (see below).                                  |
| `window_minutes`   | Window length, or `null`.                                                        |
| `used_pct`         | This round's reading, or `null` when there is none.                              |
| `resets_at`        | Reset time of this round's reading, UTC.                                         |
| `provider_updated` | Provider's `updatedAt` for this reading, UTC.                                    |
| `collected_at`     | Time of this round, UTC.                                                         |
| `error`            | Bounded error code, or `null`.                                                   |
| `stale`            | `true` when there is no current reading (see below).                             |
| `delta_pct`        | Increase since the last good reading in the same reset cycle, or `null`.         |
| `last_good`        | Last fresh reading: `used_pct`, `resets_at`, `provider_updated`, `collected_at`. |

A meter is stale when this round has no valid reading for it. It is also stale when the
provider update time is missing, invalid, or more than 5 minutes in the future
(`invalid_timestamp`), older than `--stale-after`,
or when its reset time passed more than 120 seconds ago. A stale reading never replaces
`last_good` and never yields a delta. A failure never produces `0`.

A meter seen before that is absent from this round stays in the output with `used_pct: null`
and `stale: true`. Its error is `missing_window` when its account answered,
`account_missing` when the provider answered without that account, or the provider's error
code. An account that answers with no valid window at all, on any round, gets a `kind:
"account"` record with `missing_window`, and the round is not `ok`. A provider that offers
only some slots (for example only `secondary`) is a complete answer.

`delta_pct` is computed only against the same provider, account, and meter, and only when
both normalized reset times are exactly equal. A moved reset time, a different account, or a
decreasing reading gives `null`.

### Error codes

| Code                | Cause                                                                               |
| ------------------- | ----------------------------------------------------------------------------------- |
| `timeout`           | The provider timeout expired.                                                       |
| `deadline_exceeded` | The round deadline stopped or skipped the provider.                                 |
| `nonzero_exit`      | CodexBar exited non-zero and its output names no provider error.                    |
| `auth_failed`       | CodexBar reported a login, cookie, or credential problem.                           |
| `provider_error`    | CodexBar reported another provider error.                                           |
| `malformed_json`    | stdout is not JSON.                                                                 |
| `empty_output`      | stdout is empty.                                                                    |
| `unexpected_shape`  | The JSON has no usable usage entry.                                                 |
| `oversized_output`  | stdout is larger than 4 MiB.                                                        |
| `invalid_value`     | A window's percentage is missing, non-numeric, or out of range.                     |
| `invalid_timestamp` | The provider update time is missing, invalid, or more than 5 minutes in the future. |
| `missing_window`    | A known meter, or every window of an account, is absent.                            |
| `account_missing`   | A known account is absent from the provider's answer.                               |
| `ambiguous_account` | An entry has no identity.                                                           |
| `not_installed`     | The CodexBar path does not exist.                                                   |
| `spawn_failed`      | CodexBar could not be started.                                                      |

Provider messages are classified in memory and are never stored. Extra windows without a
valid ID are counted in `round.dropped_extra_windows`.

### Compatibility with the router reader

`usage.json` keeps the shape the router reads: `updated`, `ok`, and `rows`. `rows` holds the
standard windows and provider-level failures only. A row carries `used_pct` only when the
reading is current. A stale row has `used_pct: null` and an error code (`stale_source` when
the round itself succeeded). Extra windows such as `cursor-grok-bot` appear only in `meters`,
so a model-scoped meter does not lower a whole account's remaining quota in the router.

### Alerts

When a fresh reading reaches `--warn-pct`, the collector appends one line to `alerts.jsonl`
with `"posted": false`. It alerts once per meter and reset cycle. The collector sends nothing.

## Pane watcher

`scripts/cli-watchers/watch.py` records what Herdr agents do, as a local event log. It is
log-only: it never prompts, types into, focuses, starts, or closes a pane or agent, never calls
a model, and never sends a notification. Nothing reads its events yet.

### Run it

```sh
# One tick (the default), every agent in one Herdr session:
python3 scripts/cli-watchers/watch.py --state-dir "<state-dir>" --session default

# Four ticks, 10 seconds apart, limited to two panes:
python3 scripts/cli-watchers/watch.py --state-dir "<state-dir>" --session default \
  --pane w1:p1 --pane w1:p2 --ticks 4 --interval 10
```

`--session` is required and is passed to every call as `herdr --session <name>`, so the watcher
never depends on the pane or session it runs in. A session with no running server reports
`server_not_running`; the watcher does not create one.

| Option                 | Default                   | Meaning                                                |
| ---------------------- | ------------------------- | ------------------------------------------------------ |
| `--state-dir`          | `CLI_WATCHERS_STATE_DIR`  | Private state directory. Required.                     |
| `--session`            | none                      | Herdr session to read. Required.                       |
| `--herdr`              | `HERDR_BIN`, then `herdr` | Herdr CLI path.                                        |
| `--pane`               | every agent               | Watch only this pane (repeatable).                     |
| `--workspace`          | every workspace           | Watch only this workspace's panes.                     |
| `--discovery-interval` | `300`                     | Seconds between discoveries.                           |
| `--interval`           | `20`                      | Seconds between ticks of a `--ticks` run.              |
| `--timeout`            | `15`                      | Seconds per Herdr call.                                |
| `--tick-deadline`      | `60`                      | Seconds per tick; later calls in the tick are skipped. |
| `--read-lines`         | `120`                     | Rows per read of a running pane (10-2000).             |
| `--summary-chars`      | `600`                     | Maximum event summary length.                          |
| `--once` / `--ticks N` | one tick                  | Number of ticks in this run.                           |

Exit codes: `0` the last tick had no error; `1` some Herdr call failed; `2` invalid
configuration or an unsafe state path; `75` another watcher holds the lock.

### Herdr commands

The watcher runs only these Herdr 0.9.3 commands. Any other command is refused in code.

| Command                                                  | Used for                                         |
| -------------------------------------------------------- | ------------------------------------------------ |
| `agent list`                                             | Discovery of every agent.                        |
| `agent get <pane>`                                       | Discovery with `--pane`; polling a running task. |
| `pane read <pane> --source recent-unwrapped --lines <n>` | New output of a running task.                    |
| `pane read <pane> --source visible`                      | Final screen after a task stops running.         |

Herdr can collect application history from an idle agent when a read asks for more rows than
the screen holds. The final read after a task stops running therefore uses `--source visible`,
which asks for no extra rows. Reads do not mark a completion as seen.

From Herdr's JSON, the watcher keeps only the pane ID, `agent_status`, the agent kind and name,
`state_change_seq`, and a digest of `terminal_id` plus `agent_session.value`. It drops `cwd`,
terminal titles, and every other field. Herdr's stderr is read only for its `error.code`, which
is kept only when it is one of a fixed list.

### One tick

1. **Discovery** runs when `--discovery-interval` has passed, on the first tick, and right after
   Herdr recovers from an outage. It lists agents (`agent list`, or `agent get` per `--pane`).
   New agents produce `task_discovered`. An agent missing from a successful discovery produces
   `task_gone`. A failed discovery changes no task.
2. **Polling** runs every tick, only for tasks whose status is `working`: `agent get`, then a
   `recent-unwrapped` read. A task that is `idle`, `done`, `blocked`, or `unknown` leaves the
   polled set and is checked again only at discovery.
3. **Comparison**: a task is read only when it is running or its status, agent instance, or
   Herdr state sequence changed. The new screen is aligned with the stored one
   (`difflib`), so a rolling window and a fixed footer are not new content. Ordinary output is
   compared literally, apart from spacing: a changed sign, mark, clock, percentage, or number
   (`-10` to `+10`, `Disk usage: 99%`) is new content. Only on recognized TUI chrome (lines
   with `esc to interrupt`, `? for shortcuts`, `Context left`, `auto-compact`, token arrows, or
   a spinner-led `Working…` status) are leading spinner glyphs, elapsed times, clocks,
   percentages, and token counts ignored. An unchanged check writes no event.
4. **Final capture**: when a task stops running (or blocks) and its final screen cannot be read,
   the lifecycle event is still logged, and the task keeps a pending final capture. It stays
   out of the polled set; each later discovery retries the read, even when the task's status is
   unchanged. The first successful read logs `final_output_recovered` once.

The task identity is `<session>/<pane>`. The agent instance is a digest of the terminal ID and
the agent session ID. A new instance on the same pane produces `task_restarted`; the task keeps
its history and its open blocker.

### Events

`events.jsonl` gets one line per event. Each event has `id`, `at`, `type`, `session`, `task`,
`pane`, `agent`, `name`, `instance`, `status`, `prev_status`, `needs_human`, `summary`, and
`error`. A summary holds at most 8 new lines of at most 200 characters each, redacted.

| Type                     | When                                                                                                                                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task_discovered`        | A new agent.                                                                                                                                                                                                                                         |
| `started`                | A task starts running.                                                                                                                                                                                                                               |
| `output`                 | A running task printed new lines.                                                                                                                                                                                                                    |
| `completed`              | A task went from running to `idle` or `done`; summary is the final new text.                                                                                                                                                                         |
| `blocker`                | A task is waiting for an approval or answer. `needs_human: true`.                                                                                                                                                                                    |
| `blocker_resolved`       | The task left that blocked state. A blocked task that finished also logs `completed`.                                                                                                                                                                |
| `final_output_recovered` | A final screen that could not be read at a `completed`, `blocker`, `blocker_resolved`, or `status_changed` event was read at a later discovery. `recovered_for` names that event; `summary` holds the recovered new lines. Once per pending capture. |
| `status_changed`         | Any other status change, such as to `unknown`.                                                                                                                                                                                                       |
| `task_restarted`         | Same pane, new agent instance.                                                                                                                                                                                                                       |
| `task_gone`              | The agent left the pane. This is not a completion.                                                                                                                                                                                                   |
| `read_failed`            | A read failed or timed out; once per failure episode.                                                                                                                                                                                                |
| `read_recovered`         | Reads of that task work again.                                                                                                                                                                                                                       |
| `herdr_unavailable`      | Herdr did not answer (`server_not_running`, discovery timeout, ...); once per outage.                                                                                                                                                                |
| `herdr_recovered`        | Herdr answers again; discovery runs at once.                                                                                                                                                                                                         |

The deduplication key is a digest of the task, the agent instance, the event type, and a digest
of the event content. A key already logged is not logged again and counts as `deduped`.

A task has at most one open blocker episode. While it stays blocked, screen churn, status
formatting, a watcher restart, or an agent restart that shows the same question does not log
another `blocker`. The episode closes with `blocker_resolved` when the task leaves `blocked`.
A later block, or a move of Herdr's `state_change_seq` while the task still looks blocked
(it left and returned between two reads), logs a new `blocker`. Two tasks blocked on the same
question each get their own event.

### State, heartbeat, and privacy

- `state.json`: tasks, the last read lines of each task, blocker episodes, dedup keys,
  the open outage, and cumulative counters. Replaced atomically.
- `heartbeat.json`: written at the end of every tick, also when discovery or reads fail. It
  holds the tick time, whether discovery ran and succeeded, the open outage, the task, polled,
  and open-blocker counts, this tick's counts, and cumulative `detected`, `deduped`,
  `human_judgment`, `errors`, `herdr_calls`, and `ticks`.
- `snapshots/`: the latest screen of each task, plus one copy per `blocker`,
  `blocker_resolved`, and `completed` event, and per `status_changed` event that ends a
  running state.
- `watch.lock`: an exclusive, non-blocking lock held for the whole run.

Every screen is redacted before it is stored, compared, or summarized. Redaction removes
terminal escape codes, email addresses, `Authorization` and `Cookie` headers, bearer tokens,
`key=value` secrets (names containing `key`, `token`, `secret`, `password`, `cookie`,
`session_id`, `credential`), common API key and token formats (`sk-`, `ghp_`,
`github_pat_`, `glpat-`, `xox?-`, `AKIA`, `AIza`, JWTs), whole private key PEM blocks (to the
end of the screen when the end marker is not visible, and from the top of the screen when only
the end marker is), the values of the
watcher's own credential-like environment variables, and the home directory path. Redaction is
pattern based; keep the state directory private.

The directory tree is `0700` and every file `0600`, including a reused directory. A symlinked
or foreign-owned state path stops the watcher with exit `2`. The watcher prints one line per
tick with counts and event types only.

### launchd (DevPro)

`scripts/cli-watchers/launchd/local.cli-watchers.watch.plist.template` runs one tick every
`StartInterval` seconds. It has no `KeepAlive`: launchd does not restart a failed watcher, and
the watcher never restarts Herdr. Nothing in this repository installs or loads it.

**Deferred to Step 3.** Rendering, copying, bootstrapping, starting, and stopping the job are
cutover steps. This change does not perform or authorize them. The commands below are for that
later step.

Render it (example values; use absolute paths):

```sh
STATE_DIR="$HOME/cli-watchers/watch"
mkdir -m 700 -p "$STATE_DIR"
sed -e "s#@LABEL@#local.cli-watchers.watch#g" \
    -e "s#@PYTHON@#/usr/bin/python3#g" \
    -e "s#@WATCH_PY@#$PWD/scripts/cli-watchers/watch.py#g" \
    -e "s#@STATE_DIR@#$STATE_DIR#g" \
    -e "s#@SESSION@#default#g" \
    -e "s#@HERDR@#$(command -v herdr)#g" \
    -e "s#@DISCOVERY_INTERVAL@#300#g" \
    -e "s#@START_INTERVAL@#30#g" \
    -e "s#@PATH@#/usr/bin:/bin#g" \
    scripts/cli-watchers/launchd/local.cli-watchers.watch.plist.template \
    > "$STATE_DIR/local.cli-watchers.watch.plist"
plutil -lint "$STATE_DIR/local.cli-watchers.watch.plist"
```

Start, stop, and inspect:

```sh
cp "$STATE_DIR/local.cli-watchers.watch.plist" ~/Library/LaunchAgents/
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/local.cli-watchers.watch.plist
launchctl print "gui/$(id -u)/local.cli-watchers.watch"
launchctl bootout "gui/$(id -u)/local.cli-watchers.watch"   # stop
cat "$STATE_DIR/heartbeat.json"
```

Recovery:

- Heartbeat stale: check `launchctl print` and `launchd.err.log`. A tick that exits `75`
  found another watcher holding the lock; let it finish.
- `outage` set in the heartbeat: Herdr is not answering. The watcher keeps every task and logs
  `herdr_recovered` and rediscovers when Herdr answers. It never restarts Herdr.
- Corrupt `state.json`: stop the job and move the file aside. The next tick starts fresh
  and logs `task_discovered` for every agent again.
- Remove the job: `launchctl bootout` it and delete the copied plist.

## Known limits

- Redaction is pattern based. An unknown secret format can reach a snapshot, so keep every
  state directory private.
- Deduplication keys use Herdr's `state_change_seq`. Without it (older Herdr), two identical
  completions of one agent instance collapse into one event. Herdr 0.9.3 reports it.
- A task that stays blocked while its question changes, with no `state_change_seq` move, keeps
  one blocker episode.
- Identical new output repeated by one agent instance is logged once.
- `account.key` is written in place on first use. A crash during that write leaves an invalid
  key, and the collector then fails until the file is removed by hand.

## Retention

Nothing is pruned automatically. The collector's `history.jsonl` and `alerts.jsonl`, and the
watcher's `events.jsonl` and per-event snapshots in `snapshots/`, grow with every round or
event. Prune or archive them by hand only after stopping the jobs that write them, and keep any
evidence still needed for review.

## Tests

```sh
npm run test:cli-watchers
```

The tests run `collect.py` and `watch.py` as subprocesses against fake CLIs
(`scripts/cli-watchers/tests/fake_codexbar.py`, `fake_herdr.py`) in temporary directories. They
never call CodexBar, Herdr, a provider, or a model.
