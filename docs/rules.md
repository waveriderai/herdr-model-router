# Rules mode

Rules mode is the default for `router run` (also `hmr run`). It reads a role table, applies the
project's restrictions, and starts each lane on the provider's native CLI.

## Grammar

```text
---                          optional YAML frontmatter, skipped
description: anything
---
# a comment line
name[, alias...]: lane[, lane...]   # trailing comments after whitespace are ignored
```

- The entry separator is the first colon followed by whitespace. Descriptors use
  `provider:model` with no space.
- Role names compare case-insensitively with whitespace collapsed. A name defined twice is an
  error for the whole file.
- A lane that cannot be parsed marks that entry invalid. `roles` shows it; planning that role
  fails with the parse error. Other roles stay usable.

### Lanes

| Lane                               | Meaning                                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `provider:model@effort`            | Exact native route                                                                                    |
| `provider:model`                   | Exact native route at the CLI's default effort                                                        |
| `parent`, `auto`, `inherit-parent` | The descriptor passed with `--parent`                                                                 |
| `grok-4.7-xhigh-fast`              | Legacy Cursor selector, read as `grok:grok-4.7@xhigh`; Cursor's fast variant has no native equivalent |

| Provider   | CLI             | Efforts                                 | Read-only mode                    |
| ---------- | --------------- | --------------------------------------- | --------------------------------- |
| `claude`   | `claude`        | low, medium, high, xhigh, max           | `--permission-mode plan`          |
| `codex`    | `codex`         | low, medium, high, xhigh, max, ultra    | `--sandbox read-only`             |
| `grok`     | `grok` (native) | low, medium, high, xhigh                | `--permission-mode plan`          |
| `cursor`   | Cursor agent    | none (encode reasoning in the model id) | `--mode plan`                     |
| `opencode` | `opencode`      | none                                    | none: read-only lanes are refused |

Model ids must match `[A-Za-z0-9][A-Za-z0-9._/-]*`. Each value is one argv element; nothing is
passed through a shell. Rolling or automatic aliases (`default`, `best`, `auto`, `fable`,
`opus`, `sonnet`, `haiku`, `opusplan`, and any `*-latest`) are refused in rules, policy pins,
and `--parent`; write the full model id, such as `claude-opus-5-5`.

## Access

- More than one lane: a **panel**. Every lane runs, in order, read-only. A panel never takes
  writer ownership.
- One lane: a **writer** unless `--read-only` is given, or the project policy lists
  `writerRoles` and this role is not in it.
- A policy that lists a panel role as a writer is refused.

## Project policy

`<project>/.model-router/policy.json`:

| Key                | Effect                                                                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`          | Must be `1`                                                                                                                                                                   |
| `allowedProviders` | Lanes on other providers refuse the plan                                                                                                                                      |
| `pins`             | Role → exact descriptor (every lane) or list (lane by lane). Every key naming the role or one of its aliases must hold; any mismatch refuses the plan, whatever the key order |
| `writerRoles`      | Single-lane roles allowed to write                                                                                                                                            |

Any other key is rejected. A policy cannot add models, credentials, commands, environment, or
permissions.

## Launch

`router run "<task>" --role <role>` without `--dry-run`:

1. Plans the role (same code as `plan`).
2. Requires `HERDR_ENV=1`.
3. Refuses lanes on a provider that has a `shared` account in `config.json`: rules mode does
   not hold shared-quota reservations. Use quota mode for shared accounts.
4. Resolves each provider's executable on `PATH` to an absolute path (`claude`, `codex`,
   `grok`, `cursor-agent`, `opencode`), runs that file's `--help`, and checks every flag it is
   about to pass. A missing CLI or flag stops the run before anything is created. No other
   model or API key is tried.
5. Records the task and lanes. A writer takes ownership of the worktree (the real path of the
   nearest checkout root) in the same transaction, or is refused if another task owns it.
6. For each lane in order:
   1. `herdr pane split --cwd <working directory>`.
   2. Write a private launch script (`<router home>/launch/<lane>.sh`, mode 0600) that `cd`s to
      the working directory and `exec`s `/usr/bin/env -i <allowlist> <absolute CLI> <argv>`.
      Every value is single-quoted; allowlisted variables are copied with `${NAME+"NAME=$NAME"}`
      from the pane's own shell, so the CLI gets that pane's `HERDR_*` context and none of the
      API keys or cloud credentials the shell's rc files export.
   3. `herdr pane run <pane> "/bin/sh '<script>'"`, then poll `herdr agent get <pane>` until
      Herdr reports the expected kind, `idle`, and interactive-ready. Another kind, or no ready
      agent before the timeout, closes the pane and fails the lane. The script is deleted.
   4. `herdr agent rename <pane> <name>`, then send the prompt once.

The allowlist is `HOME`, `PATH`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `TERM_PROGRAM`,
`TERM_PROGRAM_VERSION`, `COLORTERM`, `LANG`, `LC_ALL`, `LC_CTYPE`, `LC_MESSAGES`, `TMPDIR`,
`XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, `XDG_RUNTIME_DIR`,
`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, and Herdr's `HERDR_*` context. Each CLI's persistent login
(config files, OS keychain) is untouched and operator-owned; the router does not claim every
credential source a CLI can read is disabled.

A failed lane is recorded with its error and the next lane still runs. The run reports how many
lanes received the prompt; it does not claim success unless all did.

## Attempts

Each prompt is an attempt, written as `sending` before it goes out:

| State                | Meaning                                                  |
| -------------------- | -------------------------------------------------------- |
| `working`, `blocked` | Herdr saw the agent react                                |
| `sent`               | Herdr accepted the input; no reaction observed yet       |
| `not-delivered`      | Herdr rejected it before sending input (`agent_blocked`) |
| `unknown`            | No evidence either way (timeout, unrecognized error)     |
| `sending`            | The router stopped before recording an outcome           |

`unknown` and `sending` block every further prompt to that lane. Inspect the pane, then:

```sh
router task recover <attempt-id> --delivered --evidence "prompt visible in the pane"
router task recover <attempt-id> --not-delivered --evidence "pane shows no input"
```

## Writer lifecycle

```sh
router task status <task-id>
router task revise <task-id> "<revision>"     # same agent, same pane, same model
router task complete <task-id> --evidence "<what shows it is done>"
router task release <task-id> --stopped --evidence "<what shows the writer stopped>"
```

A revision checks that the original agent of the same kind still runs in the recorded pane; if
not, it refuses and never relaunches. The task's open status and current worktree ownership
are checked again in the same database transaction that reserves the attempt, so a task that
was completed, released, or replaced while the revision waited on Herdr sends nothing.
`complete` is refused while a launch is still dispatching; a stopped router's task is closed
with `release --stopped`, and a dispatch never reopens a task closed under it. Ownership is released only by `complete`, `release`, or automatically when
a launch never sent any prompt. It is never taken over by another task.

## Semantic mode

`--routing-mode semantic` without `--role` asks TypeSafe to choose one role from the rules
file. The key comes from `config.json` `typesafe.apiKeyRef` or `TYPESAFE_API_KEY`, and is looked
up only in this mode. The answer must be a role name and nothing else; anything outside the
role list is refused. The chosen role is then planned exactly like an explicit one.
