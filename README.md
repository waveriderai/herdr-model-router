# Herdr Model Router

Route a coding task to the models your role rules name, and start them in Herdr panes on the
subscriptions you already have.

```sh
hmr roles
hmr plan --role reviewers
hmr run "Review the parser change" --role reviewers
```

You keep one rules file, `pstack-models.mdc`, that says which model each role uses. The router
reads it, applies your project's restrictions, and starts each lane with that provider's own
CLI (`grok`, `codex`, `claude`, or Cursor's agent) using the login that CLI already has. It does
not call any routing API by default, does not read or store provider credentials, and does not
choose a model for you.

> **Pre-release.** This is a fork of [agent-router](https://github.com/nidhi-singh02/agent-router)
> (MIT). See [NOTICE.md](NOTICE.md). Read [Security](SECURITY.md) before routing work on shared
> machines or accounts.

## What it does

- **Rules first.** `roles`, `plan` and `run --dry-run` read only the rules file and the
  project policy. No network, no credential store, no child process, no router database.
- **Explicit roles.** You name the role. Without one the router lists the roles; it never
  guesses from keywords.
- **Exact models.** Lanes use `provider:model@effort` with the provider's exact native model
  id. Nothing is rewritten to a rolling alias.
- **Panels run every lane.** A role with several lanes is a read-only panel: every lane runs,
  in order, duplicates included. It is not a fallback list.
- **One writer per worktree.** A writer task owns its worktree until you close it with
  evidence. Revisions go to the same agent, pane, and model.
- **At most one send per attempt.** If the router cannot tell whether a prompt arrived, it
  records `unknown` and refuses to send again until you record what you saw.
- **Opt-in TypeSafe.** `--routing-mode semantic` lets TypeSafe pick a role from your rules for
  one invocation. The upstream quota ranking stays available as `--routing-mode quota`.

## Prerequisites

- Node.js 22.12 or newer (CI runs 22 and 24), and a C/C++ toolchain (`better-sqlite3` builds
  natively when no prebuilt binary matches). Node 20 is not supported: the locked
  `better-sqlite3`, `commander`, and Vitest versions require Node 22.
- [Herdr](https://herdr.dev) 0.9 or newer, to launch panes. Previews work without it.
- The CLIs your rules name, each logged in on its own: `grok`, `codex`, `claude`, or Cursor's
  `cursor-agent`. OpenCode remains a legacy quota-mode provider.

## Install

```sh
git clone https://github.com/waveriderai/herdr-model-router.git
cd herdr-model-router
npm ci
npm run build
npm link -w @agent-router/router   # puts `hmr` and `router` on your PATH
```

`hmr` and `router` are the same CLI. After `git pull`, run `npm run build` again.

## Try it without logging in to anything

```sh
hmr roles --rules examples/pstack-models.example.mdc
hmr plan --rules examples/pstack-models.example.mdc --role reviewers
```

The plan lists every lane, the exact argv each would run, and ends with
`Preview only: no model, pane, network, credential, or router state was touched.`

## Rules file

The router looks for `pstack-models.mdc` in this order and uses the first it finds:

1. `--rules <path>`
2. `<project>/.model-router/pstack-models.mdc`
3. `<project>/.cursor/rules/pstack-models.mdc`
4. `~/.cursor/rules/pstack-models.mdc`

`<project>` is the nearest directory above the current one that contains `.git`.

```text
---
description: per-role model choices
alwaysApply: true
---
# comments start with #
feature, refactoring: codex:gpt-6.1-sol@high
bug-fix: claude:claude-opus-5-5@xhigh
judgment and prose: inherit-parent
reviewers: claude:claude-opus-5-5@high, codex:gpt-6.1-sol@high, claude:claude-opus-5-5@high
```

- Names left of `: ` are one role and its aliases. Lanes right of it run in order.
- A lane is `provider:model@effort`. Providers: `grok` (the native grok CLI), `codex`,
  `claude`, `cursor`, `opencode`. Cursor and OpenCode take no `@effort`; write the exact model
  id Cursor lists.
- `parent`, `auto` and `inherit-parent` run on the parent's model. Pass it explicitly with
  `--parent provider:model@effort`; without it the router refuses.
- The legacy Cursor selector `grok-4.7-xhigh-fast` is read as `grok:grok-4.7@xhigh`, and the
  plan says that Cursor's fast variant has no native equivalent. Any other unrecognized value
  is an error, never a guess. Rolling aliases such as `opus`, `sonnet`, `opusplan`, `default`,
  or `*-latest` are refused; write the full model id.

See [Rules mode](docs/rules.md) for the full grammar, access rules, and task lifecycle.

## Project policy

A project can restrict routing in `.model-router/policy.json` (see
[examples/.model-router/policy.json](examples/.model-router/policy.json)):

```json
{
  "version": 1,
  "allowedProviders": ["claude", "codex", "grok"],
  "pins": { "bug-fix": "claude:claude-opus-5-5@xhigh" },
  "writerRoles": ["feature", "refactoring", "bug-fix"]
}
```

The policy only narrows the rules. A pin that disagrees with the rules refuses the plan; it
never replaces the model. Unknown keys (models, commands, environment, credentials) are
rejected.

## Running tasks

```sh
hmr run "Fix the crash in the parser" --role bug-fix      # writer, one lane
hmr run "Review the parser change" --role reviewers      # read-only panel, every lane
hmr task status <task-id>
hmr task revise <task-id> "Also cover the empty input"
hmr task complete <task-id> --evidence "tests pass at <commit>"
```

`run` needs `HERDR_ENV=1` (a Herdr pane). Before creating anything it finds each CLI on your
`PATH` as an absolute path (Cursor is always `cursor-agent`, never a bare `agent`) and checks
that file's own `--help` for the flags it is about to pass, and stops if one is missing.
Read-only lanes use each CLI's enforced read-only mode: `claude --permission-mode plan`,
`codex --sandbox read-only`, `grok --permission-mode plan`, Cursor `--mode plan`. The router
never passes a bypass or auto-approve flag.

Each lane starts in a new pane: the router types one fixed command into the pane's shell, which
`exec`s the absolute CLI through `/usr/bin/env -i` with a short variable allowlist. Whatever your
shell rc exports, including provider API keys and cloud credentials, does not reach the CLI;
the pane's own Herdr context does. Herdr must then report the expected agent kind, idle and
ready, **and** the pane's own screen must show that CLI's ordinary input prompt with no
startup dialog, before the router names and prompts it; anything else closes the pane. The same
screen check runs before every `task revise`; a writer that is not at its prompt is left alone
and nothing is sent.

**Before routing to a CLI in a new directory, open that CLI yourself there once** and finish
any first-run step it shows: workspace or folder trust, login, update prompts, permission
questions. The router never answers these dialogs (a typed task would land in their hotkeys);
it refuses the lane and tells you which dialog it saw.

A pane going idle is not completion. A task ends only with `task complete --evidence` or, for a
writer that stopped, `task release --stopped --evidence`. When an attempt is `unknown`, inspect
the pane and record it with `task recover <attempt> --delivered|--not-delivered --evidence`.

## Coordinator workflow

For work split between one writer and independent reviewers, a coordinator (you, or an agent
running the `model-router` skill) drives `hmr workflow`:

```sh
hmr workflow plan --brief brief.json          # preview; reads files only
hmr workflow start --brief brief.json         # one writer, one prompt
hmr workflow result <id> --attempt <a> --file result.json
hmr workflow verify <id> --attempt <a>        # read-only verifier lanes, writer stopped
hmr workflow result <id> --attempt <a> --lane <lane> --file lane.json
hmr workflow revise <id> --attempt <a> --file changes.txt   # same writer session
hmr workflow accept <id> --attempt <a> --evidence "..."
hmr workflow delivery <id> --evidence "PR #12, CI green"    # or --not-applicable
hmr workflow release <id> --evidence "..."
```

Briefs and results are versioned JSON (`hmr.brief/v1` and `/v2`, `hmr.result/v1` and `/v2`; see
[examples/workflow](examples/workflow)). A result names its workflow, attempt, and the exact
worktree revision (HEAD plus a fingerprint of every tracked and non-ignored untracked file); a
the router refuses a stale attempt or a changed worktree. Verification, acceptance, and release need the
writer's exact session in its pane, positively idle or done. Acceptance needs every verifier
lane to pass. The router releases nothing before the coordinator records delivery. See
[Coordinator workflow](docs/rules.md#coordinator-workflow).

Each worktree has one writer authority, either the router's own lease (`standalone`, the default) or
the optional private `agent-collab` CLI (`hmr workflow bind --backend agent-collab`). Every HMR
writer entrance follows that binding. On agent-collab the writer is whatever the rules file
names (Claude, Codex, or Grok); agent-collab receives that exact route and never substitutes a
default model, and a project pin there can only refuse. A process that writes to the worktree without going
through HMR or the bound authority is outside what HMR can control. Quota-mode `run` takes the same
authority and holds it until its writer task is closed with `task complete`.

### Shared skills and modes

A `hmr.brief/v2` brief can ask for shared skills by name, such as a pstack `poteto-mode`, from
directories you trust:

```sh
hmr workflow plan  --brief brief.json --skills-root ~/path/to/skills
hmr workflow start --brief brief.json --skills-root ~/path/to/skills
hmr workflow revise <id> --attempt <a> --file changes.txt --mode poteto-mode   # per attempt
hmr workflow accept <id> --attempt <a> --evidence "..." [--waive-skill <skill>]
```

Workers get each skill's path and digest, not its text, and report what they read and applied
(`hmr.result/v2`). A missing skill or reference refuses before anything starts; a changed one
refuses later steps; acceptance needs the writer's and every verifier's report to match, and
an evaluated skip needs an explicit waiver. Reports are claims, not proof. A mode applies to
one attempt only, and no skill or mode request authorizes merging, deploying, or messaging. See
[Shared skills](docs/rules.md#shared-skills).

### Start from a task

```sh
hmr start "Add CSV export to the report page" --dry-run   # route and roles; touches nothing
hmr start "Add CSV export to the report page" [--skills-root <dir>] [--mode poteto-mode]
hmr coordinator status <id>
```

`start` reads the `coordinator` role in your rules file (for example
`coordinator: codex:gpt-6.1-sol@high`), starts that CLI, and gives it the `model-router` skill,
your roles, and the task once. The coordinator chooses the roles and drives `hmr workflow`.
There is no classifier and no default model: without a coordinator role, `start` refuses. The
coordinator is a control role with its CLI's ordinary permissions, not a writer and not
read-only. A Bot that can run commands may call `hmr start` or write a brief itself; see
[`examples/workflow/bot-brief.example.json`](examples/workflow/bot-brief.example.json).

## Provider status

Live checks for this release, each through the router in a real Herdr pane in a fresh
directory:

| Provider   | Model checked                 | Result                                                                               |
| ---------- | ----------------------------- | ------------------------------------------------------------------------------------ |
| `grok`     | `grok-4.7` at `high`          | Responded with the expected smoke text                                               |
| `codex`    | `gpt-6.1-sol` at `high`       | Unverified: the CLI showed its interactive update menu; the router did not prompt it |
| `claude`   | `claude-sonnet-5-5` at `high` | Unverified: first-run workspace trust dialog                                         |
| `cursor`   | `grok-4.7-high`               | Unverified: first-run workspace trust dialog                                         |
| `opencode` | —                             | Not supported for launch: no verified ready-prompt evidence                          |

In the same run the launched `grok` and `cursor-agent` processes, and a fake executable in a
real pane, were checked for API-key and cloud-credential variables: none were present.
Credential values were never read. This is not a promise that every provider or model works;
see [Provider support](docs/provider-support.md).

## Other modes

- `--routing-mode semantic`: TypeSafe picks one role from your rules file for this run. It
  sends the task text to TypeSafe and is billed by TypeSafe. It cannot change lanes, models,
  efforts, pins, or panels, and an explicit `--role` skips it.
- `--routing-mode quota`: the upstream quota-aware ranking across configured accounts, with
  sessions, worktrees, and live effort switching. See [Quota mode](docs/quota-mode.md).

## Herdr plugin

`herdr-plugin.toml` exposes route, status, sessions, resume, and usage-refresh actions. See
[herdr-plugin/README.md](herdr-plugin/README.md).

## Development

```sh
npm ci
npm run verify   # build shared types, typecheck, lint, format check, tests, build
```

Tests use synthetic rules and fake CLIs only. See [CONTRIBUTING.md](CONTRIBUTING.md) and
[AGENTS.md](AGENTS.md).

## Privacy

Rules mode stores tasks, lanes, and prompt attempts in the router's SQLite database
(`MODEL_ROUTER_HOME`) only when it launches. It stores a SHA-256 of each prompt, not the prompt.
A launched CLI keeps only `HOME`, `PATH`, user and shell names, locale, terminal, temp and
`XDG_*` directories, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, and its pane's `HERDR_*` context, all read
from the new pane's shell. Provider API keys and cloud credentials in your environment are
dropped. Each CLI still uses its own persistent login (its config files or the OS keychain); that
configuration is yours to manage, and the router does not claim to disable every credential
source a CLI can read. See [Privacy](docs/privacy.md).

## License

MIT. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
