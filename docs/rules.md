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
- `# fallback: a, then b` (also `a, b` or `a then b`) is the role's fallback order. It belongs
  to the role entry above it: as that entry's trailing comment, or on a comment line before
  the next entry. It may follow a sentence in the comment (`# UI code. fallback: a, then b`).
  Prose such as `fallback stays per policy` (no colon) declares nothing. A second fallback line
  for one role marks that role invalid. An entry that is not a lane (`cursor Auto`) is kept
  and skipped at plan time with a note.

### Lanes

| Lane                               | Meaning                                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `provider:model@effort`            | Exact native route                                                                                    |
| `provider:model`                   | Exact native route at the CLI's default effort                                                        |
| `parent`, `auto`, `inherit-parent` | The descriptor passed with `--parent`                                                                 |
| `grok-4.7-xhigh-fast`              | Legacy Cursor selector, read as `grok:grok-4.7@xhigh`; Cursor's fast variant has no native equivalent |

| Provider   | CLI             | Efforts                                 |
| ---------- | --------------- | --------------------------------------- |
| `claude`   | `claude`        | low, medium, high, xhigh, max           |
| `codex`    | `codex`         | low, medium, high, xhigh, max, ultra    |
| `grok`     | `grok` (native) | low, medium, high, xhigh                |
| `cursor`   | Cursor agent    | none (encode reasoning in the model id) |
| `opencode` | `opencode`      | none                                    |

Each lane's permission flags follow its access; see [Permission defaults](#permission-defaults).

Model ids must match `[A-Za-z0-9][A-Za-z0-9._/-]*`. Each value is one argv element; nothing is
passed through a shell. Rolling or automatic aliases (`default`, `best`, `auto`, `fable`,
`opus`, `sonnet`, `haiku`, `opusplan`, and any `*-latest`) are refused in rules, policy pins,
and `--parent`; write the full model id, such as `claude-opus-5-5`.

## Access

- More than one lane: a **panel**. The lanes that remain run, in order, read-only. A panel never
  takes writer ownership. A `parent` / `auto` / `inherit-parent` lane that resolves to a model
  already in the panel is not launched: a second copy of the same model does not add a review,
  and it does not re-run tests the writer already recorded. A selector written twice still runs
  twice. The rules file is not rewritten.
- One lane: a **writer** unless `--read-only` is given, or the project policy lists
  `writerRoles` and this role is not in it.
- A policy that lists a panel role as a writer is refused.

## Permission defaults

Each lane launches with the permission profile of its access. Every flag is one the CLI itself
enforces, and the router checks it in the installed CLI's `--help` before launching.

| Profile   | Auto-approved                                                      | Who gets it                                                          |
| --------- | ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| read-only | File reads and web fetches; never edits                            | Panels, `--read-only`, globally read-only roles, verifiers           |
| writer    | Also edits inside its working directory (the worktree); sandbox on | Single-lane writers                                                  |
| control   | Nothing beyond the CLI's ordinary prompts                          | The coordinator (`hmr start`)                                        |
| bypass    | Everything: the CLI's full approval and sandbox bypass             | Only an opted-in writer; see [Permission bypass](#permission-bypass) |

| Provider   | read-only                                                                                                                                   | writer                                                                                                | bypass                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `claude`   | `--permission-mode plan --allowedTools Read,Grep,Glob,WebFetch,WebSearch`                                                                   | `--permission-mode dontAsk --setting-sources "" --settings <allow list + sandbox + Herdr hooks JSON>` | `--dangerously-skip-permissions`             |
| `codex`    | `--sandbox read-only --ask-for-approval never --search`                                                                                     | `--ask-for-approval never` + the `hmr-writer` permission profile (below)                              | `--dangerously-bypass-approvals-and-sandbox` |
| `grok`     | `--sandbox hmr-read-only-<home tag> --allow Read --allow Grep --allow WebFetch --allow WebSearch --deny Edit --deny Write --always-approve` | `--sandbox hmr-writer-<home tag> --allow 'Edit(./**)' --always-approve`                               | `--always-approve`                           |
| `cursor`   | `--mode plan`                                                                                                                               | `--sandbox enabled` + own `CURSOR_CONFIG_DIR` (allowlist, sandbox on)                                 | `--force`                                    |
| `opencode` | refused: no enforceable read-only mode                                                                                                      | no flags                                                                                              | refused: no known bypass flag                |

- Claude's writer settings are
  `{"sandbox":{"enabled":true,"failIfUnavailable":true,"autoAllowBashIfSandboxed":true,"allowUnsandboxedCommands":false,"network":{"allowedDomains":["fonts.googleapis.com","fonts.gstatic.com"],"allowLocalBinding":true}}}`:
  Bash runs in Claude's sandbox and is auto-approved while sandboxed (no per-command prompt); no command may run outside it. The writer's `permissions.allow` covers Read/Glob/Grep and Edit/Write under the worktree and hmr's state directory; `dontAsk` denies everything else without prompting (no `bypassPermissions`), including any `excludedCommands` entry that would run outside the sandbox. A lane whose screen shows a sandbox-not-applied warning (Grok continues without enforcement) fails closed: no prompt, no fallback. If the sandbox
  cannot start (a missing dependency, an unsupported platform), Claude exits at startup instead
  of running commands unsandboxed, and the lane fails its readiness check. Writers never stop for an approval (Kai, 2026-10-14: "Skip prompts, keep the worktree
  sandbox"). Grok's `--always-approve` is only ever combined with a `--sandbox` profile. Launch preparation (Kai 2026-10-14 8:25 PM PT, `src/rules/launch-prep.ts`, fails closed):
  - Claude writer: loads no settings file at all (user, project or local; allow list = Read/Glob/Grep, Edit in the worktree and hmr home, and `Bash(hmr task complete|status:*)`), so no allow rule,
    sandbox exclusion or hook on disk can widen it; Herdr's status hooks are copied from `settings.json` in
    `CLAUDE_CONFIG_DIR` (else `~/.claude`)
    into hmr's `--settings`.
  - Grok: hmr keeps the `hmr-writer-<tag>` (extends `workspace`, plus hmr's state dir) and
    `hmr-read-only-<tag>` (extends `read-only`) custom profiles in one managed block per router
    home (`<tag>` = first 8 hex of sha256 of the home) of `~/.grok/sandbox.toml`, written atomically. Grok refuses to start when a custom profile cannot apply; the
    sandbox-warning screen guard stays as a second check.
  - Cursor writer: a per-launch `CURSOR_CONFIG_DIR` under `<hmr home>.cursor-private/cursor-config/<lane>`
    (0700 dir, 0600 file) with `approvalMode: allowlist`, sandbox on, `Write(./**)` allowed, the
    whole `cursor-config` tree denied (the writer cannot edit its live permissions), and exact +
    `/**` deny rules for every existing entry outside the worktree, hmr's state dir and $TMPDIR.
    A `.cursor/cli.json` in the worktree or any parent directory that sets `permissions` refuses the launch. Only `authInfo` (the login
    record; the token stays in the keychain) is copied from `~/.cursor/cli-config.json`, on every
    launch; the global config is never changed and hmr never logs in. Dirs older than 7 days are pruned.
    Shell writes to hmr's state dir (Kai 2026-10-15 12:21 AM PT, same as Codex, so `hmr task
complete` runs without a prompt): Cursor reads extra writable roots only from
    `.cursor/sandbox.json`, so hmr writes the worktree's file with `additionalReadwritePaths`
    exactly `[<hmr home>]` (other safe keys kept; git-excluded). The writer cannot change it (Write
    denied on `.cursor`, Cursor's shell sandbox blocks `.cursor`). The config dirs and the guard's
    ready files and log live in `<hmr home>.cursor-private` (0700), outside every writable root.
- Known gaps: a Grok shell `ask` rule still prompts under `--always-approve` (none are configured);
  Cursor's own Write tool still prompts for a NEW file directly inside an ancestor of the worktree
  (Cursor globs have no negation and `*` crosses `/`).
- A Codex writer runs under hmr's own permission profile `hmr-writer` (no `--sandbox` flag, which
  would override `default_permissions`). It extends Codex's built-in `:workspace` sandbox and adds
  only: write access to exactly hmr's state directory (`resolveHome()`: `MODEL_ROUTER_HOME`, else
  `~/Library/Application Support/model-router` on macOS); command networking through Codex's network
  proxy, allowlisted to `fonts.googleapis.com` and `fonts.gstatic.com`; and
  `allow_local_binding = true` so dev servers can listen on and be reached at localhost (Kai GO
  2026-10-14). Every other destination is blocked by the proxy. `sandbox_workspace_write.network_access`
  (full outbound) is never set. Known limit: Codex's macOS seatbelt denies Chromium's Mach port
  registration (`bootstrap_check_in ... MachPortRendezvousServer: Permission denied (1100)`), so
  Playwright/Chromium cannot launch inside a Codex sandbox; no Codex setting changes that.
- Codex documents that a loaded `sandbox_mode` (or `--sandbox`) silently wins over
  `default_permissions`. So hmr types `/status` in every new Codex writer pane and prompts it only
  if the card reads `Permissions: Profile hmr-writer`; otherwise the pane is closed and nothing is
  sent (e.g. `Full access`, another profile, or no Permissions line). On DevPro, Codex 0.162.1 shows
  `Profile hmr-writer` even though `~/.codex/config.toml` sets `sandbox_mode = "danger-full-access"`.
- Writer lanes also get `network.allowedDomains: ["fonts.googleapis.com", "fonts.gstatic.com"]`
  (Next.js font downloads) and `network.allowLocalBinding: true` (Kai, 2026-10-14) so `next build`,
  `next start` and Playwright run inside the sandbox. `allowLocalBinding` is all-or-nothing in Claude
  Code: on macOS a sandboxed command may listen on any local address and connect to any localhost
  port (it cannot be limited to specific ports); bind dev servers to `127.0.0.1`. It has no effect on
  Linux, where each sandboxed command has its own loopback. No extra filesystem paths are granted:
  the worktree and the per-user `$TMPDIR` are writable by default.
- Grok accepts `--permission-mode plan` but ignores it, so read-only Grok lanes use `--allow`
  and `--deny` rules (a `deny` always wins in Grok) plus Grok's `read-only` OS sandbox. A writer's
  `Edit(./**)` is rooted at its working directory, and the `workspace` sandbox lets it write
  only there, `~/.grok`, and temp directories.
- Anything not auto-approved still prompts in the pane. The router never answers a prompt.

## Permission bypass

A writer runs with the `bypass` profile only when you opt in. It is never a default.

- **Per run.** `--dangerously-bypass-permissions` on `hmr run` (rules or semantic mode),
  `workflow plan`, or `workflow start`. It is refused for a read-only plan
  (`bypass-read-only`), under a project policy that forbids it (`bypass-forbidden`), and on
  `opencode`.
- **Per role, in the rules file.** A directive comment lists the roles whose writer launches
  always bypass, without the flag:

      # hmr: bypass-permissions bug-fix, ops maintenance

  Names are normalized like role names, and any alias of a listed role counts. A role listed
  both here and in `# hmr: readonly`, or a panel role, fails the whole file. Planning a listed
  role read-only (a built-in or aliased read-only role, a role the project policy does not list
  as a writer, `--read-only`, or a workflow verifier) refuses the plan with `bypass-read-only`,
  the same as the flag, and the message names this line; remove the role from it. Under a
  policy that forbids a bypass, a listed writer launches with its ordinary writer profile and
  the plan notes why. An older router reports the directive as unknown, so update every router
  that reads the file.

Both say where the bypass came from: `plan` and `run --dry-run` print
`permissions: bypass (from --dangerously-bypass-permissions)` or
`(from the rules file's bypass-permissions)`, and the JSON plan has `bypassFrom: "flag"` or
`"rules"`. `--dry-run` shows the exact argv. A bypassed writer gives up the one-worktree write
fence: its CLI skips its approvals and sandbox, so nothing but HMR's single-writer lease keeps
its writes inside the worktree. Verifier lanes and panels are never bypassed. `hmr start`
refuses a coordinator role listed in the directive (`coordinator-bypass`): a coordinator runs
with the CLI's ordinary permissions. Claude shows a one-time confirmation for its bypass mode;
the router does not answer it, so accept it yourself once in a separate session first.

## Project policy

`<project>/.model-router/policy.json`:

| Key                       | Effect                                                                                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                 | Must be `1`                                                                                                                                                                   |
| `allowedProviders`        | Lanes on other providers refuse the plan                                                                                                                                      |
| `pins`                    | Role → exact descriptor (every lane) or list (lane by lane). Every key naming the role or one of its aliases must hold; any mismatch refuses the plan, whatever the key order |
| `writerRoles`             | Single-lane roles allowed to write                                                                                                                                            |
| `forbidBypassPermissions` | `true`: no lane takes a permission bypass. The per-run flag refuses the plan (`bypass-forbidden`); a rules-file opt-in runs with the ordinary writer profile                  |

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
   3. `herdr pane run <pane> "/bin/sh '<script>'"`, then poll `herdr agent get <pane>` and
      `herdr pane read <pane> --source visible` (only this lane's own pane) until Herdr reports
      the expected kind, `idle`, and interactive-ready **and** the screen passes the readiness
      check below. Another kind, a startup dialog, or no ready prompt before the timeout closes
      the pane and fails the lane. The script is deleted.
   4. `herdr agent rename <pane> <name>`, then send the prompt once.

### Readiness check

Herdr's `idle` is not enough: CLIs show first-run dialogs that look idle, and a typed task
would be read as that dialog's hotkeys. Before every prompt, initial or revision, the router
reads the lane's visible screen (ANSI stripped; matched with whitespace removed so narrow,
wrapped panes still match) and:

1. refuses any workspace-trust, login, update, permission or confirmation dialog, or numbered
   selection menu, even if a composer is also visible;
2. requires positive evidence of that CLI's ordinary input prompt: Claude Code's `❯` line
   between rules with its mode or shortcuts footer, grok's `│ ❯ │` box, Cursor's `→` line with
   its mode footer, Codex's `›` line with its composer footer;
3. treats an unreadable or empty screen as not ready.

Nothing is ever typed into a dialog. A refused launch closes only the router's own pane and
records the lane as failed with no attempt; other panel lanes continue. A refused revision
sends nothing, creates no attempt, and leaves the writer's pane as it is. OpenCode has no
verified ready-prompt evidence, so the router does not launch it. The patterns come from the
CLI versions listed in [Provider support](provider-support.md); a CLI that changes its screen
fails closed until they are updated.

Open each CLI yourself once in a new directory and finish its trust, login, and update steps
before routing to it.

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

Before a writer lane's first prompt the router records the native session, working directory,
and agent name Herdr reports for it; a writer whose Herdr integration reports no session is not
started. A revision checks all of them again (name, kind, pane, session, directory) and the
readiness check: a replacement session in the same pane, a renamed agent, or another directory
refuses, sends nothing, and never relaunches or rebinds. A lane recorded before identity was
kept has none, so its task cannot take revisions; release it and start a new one. The task's
open status and current worktree ownership are checked again in the same database transaction
that reserves the attempt, so a task that was completed, released, or replaced while the
revision waited on Herdr sends nothing. `complete` is refused while a launch is still
dispatching; a stopped router's task is closed with `release --stopped`, and a dispatch never
reopens a task closed under it. Ownership is released only by `complete`, `release`, or
automatically when a launch never sent any prompt and every pane it opened was confirmed
closed. It is never taken over by another task.

## Coordinator workflow

`router workflow` holds one writer task across review, revision, acceptance, and delivery.

```text
start -> dispatched -> result (receipt) -> verify -> reviewed -> accept -> delivery -> release
                ^                                       |           |
                +---------------- revise ---------------+-----------+
```

- **Brief.** `hmr.brief/v1`: title, goal, allowed and excluded paths, the writer role (a
  single-lane role), verifier roles, acceptance, constraints, and an optional
  `classification` (`bounded-small-fix` only when the coordinator says so). `workflow start`
  records it privately with the workflow id, the baseline revision, the writer's exact
  descriptor, and the `--parent` descriptor if one resolved parent aliases; its SHA-256 is the
  brief identity. Verification plans its roles with the same parent. A parent alias that
  resolves to a model already in the panel is not launched. A selector written twice still
  runs twice. The rules file is never rewritten.
- **One step at a time.** Each coordinator step takes the workflow's operation slot in one
  transaction before it waits on anything, and every state change it makes checks it still
  holds the slot. A second step on the same workflow is refused (`operation-in-progress`)
  instead of interleaving, so an abort can never release a writer while a revision is being
  sent. A slot left by a process that no longer exists on this host is taken over.
- **Attempts.** Every prompt to the writer is an attempt with its own id, sent at most once.
  The prompt names the workflow and attempt and asks for one `hmr.result/v1` JSON reply. The
  attempt and its prompt are recorded before anything is sent, and linked to the dispatch
  attempt before the prompt is submitted, so a crash mid-send stays recoverable. A revision
  refused before submission stays `pending` and can be sent once with `revise --resume`.
- **Revision.** HEAD plus a SHA-256 over the bytes of every tracked and non-ignored untracked
  file (`router workflow fingerprint`). Staged, unstaged, and untracked edits change it; ignored
  files do not; it does not depend on the index, so committing exactly the reviewed files keeps
  it.
- **Result.** `workflow result --attempt <current attempt>` records a lane's reply only when its
  workflow, attempt, lane, and revision all match and the revision is the worktree's current
  one. The attempt must have been delivered; an `unknown` send is recovered first. An idle pane
  is never a result.
- **Writer stopped.** Verification, acceptance, release, and abort need the bound writer, by
  name, kind, pane, session, and working directory, with Herdr reporting it `idle` or `done`.
  `working`, `blocked`, `unknown`, or no record refuses. The router claims nothing on a guess.
- **Verify.** Each verifier role runs as a read-only panel on the result's revision. Each lane
  reports its own result. A lane that failed to start or has no result is not a pass.
- **Revise.** Same session, same pane, new attempt, after the same identity and readiness
  checks as `task revise`. Never after an unresolved send. A revision after acceptance reopens
  it.
- **Writer permissions.** Fixed at start and recorded on the workflow (`writerBypass`:
  `flag`, `rules`, or absent). A revision never relaunches the writer, so it keeps them:
  `workflow revise --dangerously-bypass-permissions` restates a bypass the workflow started
  with, and is refused (`bypass-not-started`) on a writer that started without one. Editing the
  rules file or the policy later affects new workflows only. `workflow plan` and
  `workflow status` print a `Permissions: bypass (from ...)` line for a bypassed writer.
- **Accept.** The current attempt's result is `impl-complete`, every verifier lane passed on
  the same revision, and the worktree is still at that revision. Acceptance releases nothing.
- **Delivery.** The coordinator records the authorized delivery or `--not-applicable`. A Git
  delivery names a commit (`--commit`, default `HEAD`) whose own tree must hold exactly the
  accepted content and descend from the accepted HEAD; working-tree bytes do not count, so a
  partial commit, or an accepted worktree that also held unrelated uncommitted files, is
  refused. `--not-applicable` needs the worktree still at the accepted HEAD and content. The
  router never commits, pushes, merges, or deploys.
- **Release.** Ends the workflow and frees the worktree, after delivery and with the writer
  stopped. `--abort --evidence` stops an undelivered workflow under the same stopped check.
- **Failed starts.** A start that sent no prompt and whose new pane Herdr confirmed closed
  rolls back: its lease is freed and the workflow is `failed`, with the reason. If the close
  was not confirmed, the pane may still run the CLI, so the worktree stays held (`unknown`)
  until someone inspects it; a missing writer record never counts as stopped.
- **Callers.** Coordinator steps refuse a caller whose `HERDR_PANE_ID` is the writer's or a
  verifier lane's pane, and `workflow start`, `start` and `coordinator close` refuse a caller in
  any open task's or workflow's worker pane. A caller with no `HERDR_PANE_ID` is not checked.
  The router trusts processes of the same OS user elsewhere. This is a guard, not a sandbox.

### Writer authority

Each worktree is bound to one writer authority, chosen with `router workflow bind --backend
standalone|agent-collab` while nothing is active. The binding lives in the router's database,
never in a repository file. Every writer entrance checks it in the same transaction that takes
ownership:

| Entrance                               | Standalone binding                                                       | agent-collab binding          |
| -------------------------------------- | ------------------------------------------------------------------------ | ----------------------------- |
| `workflow start`                       | SQLite writer lease                                                      | `agent-collab acquire`        |
| `run --role <writer>`                  | refused while a workflow is open                                         | refused                       |
| `run --routing-mode quota`             | takes a writer task for its lifetime                                     | refused                       |
| `--session` continuation               | keeps its chain's writer task; checked against the target pane's own cwd | refused                       |
| `task revise/complete/release/recover` | refused on a workflow's tasks                                            | refused on a workflow's tasks |

Quota mode takes the same writer-task ownership as rules-mode writers, atomically and before
any handoff, and keeps it after the launch returns: the writer task (printed by `run`) holds
the worktree until `task complete` or `task release --stopped`. A launch that fails before any
handoff gives it back. Continuing the same session chain in the same worktree keeps the task.

With agent-collab, the rules file still decides the writer: Claude, Codex, or Grok, with its
exact model and effort. Before any pane exists HMR runs agent-collab's read-only
`capabilities` handshake (it must offer the `hmr.rules-route/v1` contract for that writer's
kind; an older agent-collab without it refuses), then its own `verify` and `project` for the
worktree. agent-collab never picks a default model for these writers. A project constraint in
agent-collab (a pinned model) can only refuse: such a project accepts only a Claude writer on
its pinned `default`, or its `bounded_small_fix` when the brief is explicitly classified as a
bounded small fix. HMR does not rewrite the rules file or pick another model. The effort is
checked by HMR's own project policy. Then HMR starts the native CLI itself (the same `env -i`
launch, readiness, and dialog refusal), binds the session, and calls `agent-collab acquire`
with the frozen route: provider, Herdr kind, model, effort, role, classification, worktree,
exact directory, and the SHA-256 of the rules file, the project policy, and the brief. A
bypassed writer's route also has `permissions: "bypass"` and `bypass_from` (`flag` or
`rules`); an ordinary route has neither key.
agent-collab validates it, keeps it unchanged for the whole run, and refuses a writer in any
other directory, even one inside the same worktree. Editing the rules file later affects new
workflows only; a revision always goes to the same session. agent-collab is then the
only prompt sender (`agent-collab dispatch`, one call, no retries, waiting only until the writer
is `working` or `blocked`, never for the task to finish) and owns receipt,
request-changes, accept, and release; HMR keeps only references. Runs agent-collab created
before this contract keep their old meaning. Every external call is written as an intent first, with the attempt and
the effect it expects; while one is unresolved, every other external call of that workflow is
refused. A successful reply only marks the intent `observed`: it becomes `done` in the same
database transaction as HMR's own matching change, so a process that dies between the two
leaves the intent unresolved for recovery instead of losing it. A call whose answer is lost
stays `unknown` and is never replayed. `workflow recover` reads `agent-collab status` and
changes nothing unless the status names exactly the workflow's run, its bound native session
and pane, and the attempt the call concerns. It then records only what that status shows: a
submitted dispatch of the current attempt, a receipt with the expected status, the revision
opened directly from the reviewed attempt, that attempt's own acceptance (`accepted_at`), a
released run, or an acquired run whose capability was saved (its first prompt is then sent
once with `revise --resume`). An effect the status shows did not happen is recorded as not
applied; anything else stays unresolved with the reason. An `acquire` whose answer is lost, or
whose capability was not saved, may hold the worktree for a run HMR cannot address; recover it
with `agent-collab recover --worktree <path>`.

### Shared skills

A brief at version `hmr.brief/v2` may ask for shared skills by name (`skills.required`,
`optional`, `modes`, and `references` inside a skill). The router reads skills only from the
directories the operator passes as `--skills-root` (repeatable, first root wins a name) and
follows the Agent Skills layout: each skill is a directory with a `SKILL.md` whose frontmatter
`name` matches the directory and has a `description`. A linked skill directory is followed to
where it lives, but its target's parent is not trusted by itself. A declared reference must
resolve, before it is read and again after links are followed, inside an operator root, the
skill's own real directory, or another cataloged skill's real directory. So a pstack sibling
(`../principle-prove-it-works/SKILL.md`) works when that sibling is also linked into a root,
and a file elsewhere in the pstack repository (`../../docs/harness.md`) works only when the
operator also passes the pstack repository itself as a `--skills-root` (a root may hold no
skills directly). An unrelated file next to it (`../../../otherrepo/.env`) is refused. A name
listed twice is requested once; a skill both required and optional is refused. Digests are
of the raw file bytes, as `shasum -a 256` prints them.

- `workflow plan` lists each resolved skill's file and SHA-256; it reads files only.
- `workflow start` refuses a missing or unreadable root, a missing or invalid required skill, a
  broken link, or a missing or untrusted reference before anything starts, and binds the
  resolved files and digests into the brief's SHA-256. A missing optional skill is reported
  unavailable.
- The writer and verifier prompts carry the catalog (name, description, path, digest, required
  references), never the skill bodies, plus the mode requested for that one attempt and a
  statement that no skill or mode adds authority. The attempt's mode applies to its verifiers
  too; they stay read-only, skip any write-only step, and name it in the skill's `reason`. A
  revision runs in a mode only with `workflow revise --mode <skill>`, which may also name an
  optional skill the workflow resolved.
- What an attempt requires is its own modes plus every required skill that was not a mode of
  the first attempt. A first attempt's mode is required there only because it is a mode: on a
  revision without `--mode` for it, the prompts list it as available, not required, and do not
  tell any lane to apply it, and a `not-used` or missing report for it needs no waiver.
- Verify, revise, and accept refuse once a bound skill file changed.
- Results at `hmr.result/v2` report each skill's digest, whether it was read, and `applied`,
  `not-used`, `skipped`, or `blocked`. `workflow accept` refuses until the writer's report and
  every verifier lane's report match the bound digests and required references, and every
  skill the attempt requires is `applied`. A required skill or mode a lane reported
  `not-used`, `skipped` or `blocked` counts only with `--waive-skill <skill>`; each waiver must
  name something a lane did not apply, and is written to `waivers-<attempt>.json` and the
  acceptance evidence with the lane, status and reason. A wrong SKILL.md digest, a missing report or a
  missing bound source cannot be waived. An `applied` report must include every required
  reference at its bound digest. A waiver of a skipped skill records that the whole skill was
  not applied, including reference reads it could not perform; it does not claim those reads
  happened.
- The gate fails closed when its records cannot be trusted: the attempt's mode record must
  match the prompt whose SHA-256 the database holds, and each result file must still have its
  recorded SHA-256. A missing, corrupt or edited record refuses acceptance; it never reads as
  "no mode".
- Reports are the workers' claims, not proof that a skill was followed: the coordinator still
  reviews the work, and `workflow status` labels them as claims.

Version 1 briefs and results are unchanged.

### Coordinator bootstrap

`start "<task>"` reads the rules file's `coordinator` role (or `--role <name>`), which must be a
single lane; `--parent` resolves that role only. With `--dry-run` it prints the route, the
model-router skill it will hand over, the skill catalog, the exact workflow commands, and the
roles the coordinator will see, and touches nothing. Otherwise, inside Herdr, it starts that
native CLI in a new pane with the same `env -i` launch and readiness check, binds its session
and directory, and sends one prompt. It is recorded as `sending` first and never resent. The
prompt holds:

- the model-router skill's path and digest;
- every role with its exact route, planned from the same read of the rules file as the
  coordinator's own route, with `parent` resolved to the coordinator's own descriptor; if the
  file changed after planning, nothing starts;
- the exact commands to run, single-quoted: `--rules` with the canonical rules path, `--parent`
  with the coordinator's descriptor, every `--skills-root`, and `MODEL_ROUTER_HOME=...` when the
  operator set it explicitly (the launched CLI also gets that value, so its own `hmr` calls use
  the same database);
- the catalog of every `--skills-root` (validated even without `--mode`), from which the
  coordinator picks the skills each brief needs, and any `--mode` the operator asked for;
- the task verbatim. The task is the user's own instruction: the coordinator does what it
  explicitly authorizes, within the project's policy. A mode, skill or brief adds no authority.

The coordinator decides from the task whether source must change; a question or review does not
start a writer workflow. That is the model's judgment, not a keyword match.

The coordinator is a control role: it gets the CLI's ordinary permissions, without read-only
or bypass flags, so it can run HMR. It is not OS read-only and holds no writer ownership; HMR's
lease covers only writers started through HMR or agent-collab. One coordinator may be open
per worktree. Its record moves only by compare-and-set: `starting`, `sending`, then `prompted`
(Herdr observed activity), `sent` (Herdr accepted the submission but observed no activity:
not confirmation that it read the task), `unknown`, or `failed`; `closed` and `failed` are final
and a late launch step cannot reopen them. A launch step that throws leaves `unknown` once a
pane exists or the prompt may have gone out, `failed` otherwise.

`coordinator status <id>` reports the bootstrap, the workflows that coordinator started from its
own pane, and how many were released, each from its own record. `coordinator close <id>
--evidence ...` sends nothing and stops nothing. It refuses a launch still `starting` or
`sending` (unless that state is older than 15 minutes), a coordinator whose workflows are still
open, a caller in a worker pane, and any coordinator Herdr does not report idle or done in its
bound pane with the same session; a pane created without a bound identity cannot be confirmed
and stays held. What Herdr reported is recorded next to the operator's evidence. No classifier
runs: with no coordinator role, `start` refuses.

## Semantic mode

`--routing-mode semantic` without `--role` asks TypeSafe to choose one role from the rules
file. The key comes from `config.json` `typesafe.apiKeyRef` or `TYPESAFE_API_KEY`, and is looked
up only in this mode. The answer must be a role name and nothing else; anything outside the
role list is refused. The chosen role is then planned exactly like an explicit one.

## Fallback on quota

A single-lane role's fallback order is checked when it is planned: entries that cannot be
launched, that repeat an earlier model, that need `--parent` without one, or that the project
policy refuses (`allowedProviders`, a pin) are dropped with a note. `plan` lists the rest as
`Fallback N on quota or usage limit`. A panel ignores its fallback line; every lane runs anyway.

At launch, `run` watches for the CLI's own quota or usage-limit message:

- on the new pane's screen before the prompt (Claude Code shows a menu with it), and
- for 20 seconds after the prompt, while the turn ends: when the agent goes idle, the screen
  is checked again. A long turn is left alone after the window. The watch runs only when the
  role has a fallback order.

Before the prompt, no model output exists yet, so any screen line that starts with the
message counts. After the prompt, the evidence must show that the model never ran, counted
from the pane's echo of the prompt. `run` reads the pane's screen just before it sends the
prompt; the echo is an input line (`>`, `›`, `❯`) that opens the prompt and goes on to its
whole text, or Claude Code's `[Pasted text #N]` placeholder, with only that earlier screen
above it (at least one line of it). A line that quotes the prompt in a writer's summary has
the model's output above it, so it is never the anchor; once the real echo scrolls off the
pane, or the prompt is taller than the pane, no quota decision is made after the prompt.

| CLI          | Evidence after the echo                                                   | Model output (never read) |
| ------------ | ------------------------------------------------------------------------- | ------------------------- |
| Codex        | the next line is its own error line, `■ <message>`                        | `• ...`                   |
| Claude Code  | the next line is its own error line, `⎿ <message>`                        | `⏺ ...`                   |
| grok, Cursor | the whole turn is the quota message, at most 3 lines, before the composer | anything else             |

grok and Cursor draw no error glyph of their own, so for them the turn must be the CLI's
quota message and nothing else: it carries no tool call or other output, is followed directly
by the composer the CLI draws again (grok's token line or `│ ❯ │` box, Cursor's `→` line), and
reads as a whole message: an optional `Error:`, the limit phrase, an optional qualifier (a
model id, or `for this cycle`, month, week or period) and HTTP 429, and then only whole items
of the CLI's own advice: the limit resets, try again or retry (followed by nothing but a time
such as `in 4 days 12 hours`, `later`, or `Oct 14 at 9am PT`), upgrade, switch to Auto or
another model, check the plan. Parentheses may hold only a time zone, such as
`(America/Los_Angeles)` or `(UTC+2)`. A summary that merely starts with the phrase is not one, such as
`Rate limit exceeded is now retried.` or
`Rate limit exceeded. Try again later is now shown with a countdown.` or
`Rate limit exceeded. Try again later (now shown with a countdown).`. A writer that ran, even
briefly, prints a tool call or more output first, so quoting a quota message in its summary
is never read as a quota error.

Matched messages are exhausted limits only: `usage limit reached`, `5-hour limit reached`,
`you've hit your (usage) limit`, `quota exceeded`, `insufficient_quota`,
`rate limit exceeded`, `out of credits`, and Codex's
`stream error: exceeded retry limit, last status: 429`. A warning such as
`approaching usage limit` and a context-window limit are not.

On a match the router closes that pane, records the model as skipped on the lane (descriptor,
reason, pane, and the attempt it received), and starts the next entry in a new pane with the
same prompt. A fallback whose CLI is missing or lacks a required flag is skipped the same way.
The task keeps its id and, for a writer, its worktree; `task revise` goes to the model that
took over. `task status` lists every skipped model.

The router does not fall back when:

- the closed pane's close is not confirmed (the old CLI may still run; the lane fails and the
  worktree stays held),
- the prompt's delivery is `unknown` (record it with `task recover` first),
- the task belongs to a coordinator workflow, which binds its writer once.

When the order runs out, the lane fails with every skipped model and its reason. No API key
or unlisted model is tried. A writer whose every model hit its limit has no CLI left running,
so its worktree is released with that evidence.

## Accounts

The router picks the model first, from the rules, then the account (provider CLI) that runs
it. `packages/router/config/model-accounts.json` lists the same model on different accounts
with each CLI's exact id, copied from that CLI's own model list:

| Model                       | Accounts                                                              |
| --------------------------- | --------------------------------------------------------------------- |
| Claude Opus 5.5, Sonnet 5.5 | `claude:<model>@<effort>` or `cursor:<model>-<effort>`                |
| Grok 4.7                    | `grok:grok-4.7@<effort>` or `cursor:grok-4.7-<effort>` (low to xhigh) |
| GPT models (Sol, Astra)     | `codex` only                                                          |
| anything else               | only the account the rules file names                                 |

Remaining quota per account comes from the usage collector (see
[Configuration](configuration.md#usage-numbers)). Among the accounts that can run a lane's
model and that the project policy allows, the one with the most remaining quota wins. An
account with no reading ranks below every account with one. Without a usage file, the lane
runs where the rules file puts it. `plan` notes the account, every candidate's quota, and the
snapshot time. A role with a policy pin keeps its pinned descriptors.

Directives in the rules file change the choice for writers:

| Directive                         | Effect                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `# hmr: first-version <account>`  | A writer's first version (`--phase first`, the default) runs on this account while it has at least 20% left, or no reading. Below 20%, the account with the most remaining quota wins.                                                                                                                                                             |
| `# hmr: fix-accounts <a>[, <b>]`  | `--phase fix` (a fix after review) runs on whichever of these has more quota, with the first model in the role's order (line, then fallbacks) that account can run. If none can (for example the project policy allows none of them, or a pin names another account), the plan is refused (`no-fix-account`); a fix never goes to another account. |
| `# hmr: review-only <account>[,]` | This account never runs a writer lane. A writer role whose model only it runs is refused (`review-only-account`); fallback entries on it are skipped. Read-only roles may still use it.                                                                                                                                                            |

For a single lane, the fallback order becomes: in a fix, the other fix accounts; then the same
model on its other accounts, by remaining quota; then each `# fallback:` model, on its accounts
by remaining quota. A fix falls back only to fix accounts. An older router reports these
directives as unknown, so update every router that reads the file.

`--phase fix` starts a new writer task on the fix account. `task revise` still goes to the
same session, model, and account.

## Read-only roles

`design consultant` and `review gate` are always read-only: they launch with each CLI's
read-only [permission defaults](#permission-defaults).
Mark more roles read-only in the rules file with a directive comment (older parsers ignore it):

    # hmr: readonly coordinator, arch reviewer

A project `.model-router/policy.json` can only tighten access. Listing a globally read-only
role in `writerRoles` refuses the plan (`readonly-writer-conflict`).

## Provider registry

`packages/router/config/providers.json` lists every provider a descriptor may name, with
metadata only: id, display name, agent CLI name, supported efforts, capabilities, cost tier and
fallback eligibility. It holds no launch commands or flags. To add a coding agent, add a registry
entry and a launch adapter in `packages/router/src/rules/native-argv.ts`. A registered provider
without an adapter fails closed at launch. Failover follows only a role's own `# fallback:`
order, after a quota or usage-limit error (see [Fallback on quota](#fallback-on-quota)).
