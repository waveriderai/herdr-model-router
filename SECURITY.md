# Security policy

## Supported versions

This project is pre-release. Security fixes land on the default branch.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Report a vulnerability** button on
the repository's Security tab (private vulnerability reporting). Do not open a public issue,
and do not include real credentials, tokens, or account data in the report; describe the
class of problem and a synthetic reproduction.

We aim to acknowledge reports within a week.

## Rules-mode guarantees

These guarantees apply to rules mode. The optional legacy quota mode retains the upstream
workflow; see [Quota mode](docs/quota-mode.md). Reports that break these guarantees are in scope:

- Rules-mode previews (`roles`, `plan`, `run --dry-run`) make no network call, start no process,
  read no credential store, and create no router state.
- The router never reads, stores, copies, or changes provider credentials. A launched native
  CLI starts under `env -i` with a fixed variable allowlist, so provider API keys and cloud
  credentials exported by the user's shell do not reach it. (Each CLI's own persistent login
  is operator-owned and out of scope.)
- Model, role, and prompt values are never evaluated by a shell: Herdr IPC gets separate argv
  elements, and the one launch script quotes every value.
- A launch prompts only an agent whose Herdr-detected kind matches the lane's provider.
- No input is ever sent to a CLI startup, trust, login, update, permission or confirmation
  dialog: every prompt (initial or revision) first requires the lane pane's screen to show
  that CLI's ordinary input prompt.
- A closed, released, or replaced writer task never receives another prompt.
- Read-only lanes run only with the provider CLI's enforced read-only mode; the router never
  passes a permission-bypass or auto-approve flag.
- A project policy can only restrict routing; it cannot add models, commands, environment,
  credentials, or permissions.
- A prompt attempt with an unknown outcome is never resent automatically.
- A worktree's writer ownership is never taken over by another task.

## Out of scope

- The security of the provider CLIs, Herdr, or TypeSafe themselves.
- Actions an agent takes inside a writer pane with the permissions you grant it there.
