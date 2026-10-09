# Agent instructions

Guidance for AI coding agents working in this repository.

## Layout

- `packages/router` — the CLI (`router`, alias `hmr`).
  - `src/rules/` — rules-mode core: descriptor parsing, the `pstack-models.mdc` parser,
    project policy, pure planning, native argv, and dispatch.
  - `src/commands/rules-*.ts`, `src/commands/task-commands.ts` — rules-mode commands.
  - `src/store/` — SQLite repositories and migrations (`dispatch-repository.ts` holds tasks,
    lanes, attempts, and writer ownership).
  - Everything else under `src/` is the upstream quota mode (`--routing-mode quota`).
- `packages/hermes-heartbeat`, `packages/coordinator` — optional shared-account components.
- `skills/model-router` — the agent skill that calls the CLI.
- `herdr-plugin/`, `herdr-plugin.toml` — the Herdr plugin.
- `docs/` — user documentation. `docs/plans/` holds planning artifacts; do not edit them as
  part of implementation.

## Commands

```sh
npm ci
npm run verify          # the gate CI runs
npx vitest --run <path> # one test file
```

## Rules

- Do not call TypeSafe, provider APIs, or real Herdr panes from tests. Use the existing fakes.
- Do not read, print, or store credentials. Do not add personal rules files, account names,
  absolute home paths, runtime databases, or generated logs.
- Keep rules-mode previews free of processes, network, credential reads, and database writes.
- Never add a permission-bypass flag to a launch, and never fall back to another model or an
  API key when a route is unavailable.
- Do not deploy the coordinator or publish packages.
- Write code, docs, and commit messages in English.
