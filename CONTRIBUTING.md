# Contributing

Thanks for helping. Issues and focused pull requests are welcome.

## Set up

```sh
npm ci
npm run verify
```

`npm run verify` builds the shared heartbeat types, then runs typecheck, lint, the Prettier
check, every test, and the build. CI runs the same command on every pull request, on Ubuntu
and macOS with Node 22 and 24.

Use Node 22.12 or newer (`.nvmrc`). That is the floor the locked dependencies declare
(`better-sqlite3` 13: `>=22`; `commander` 15: `>=22.12.0`; Vitest 5:
`^22.12.0 || ^24.0.0 || >=26.0.0`), and `npm ci` warns `EBADENGINE` below it. On Node 20 the
`better-sqlite3` native addon crashes with SIGSEGV on its first database call.

## Ground rules

- **No real credentials or accounts.** Tests and examples use synthetic rules, fake CLIs, and
  fake Herdr clients. Never add API keys, tokens, cookies, provider caches, account names,
  email addresses, absolute home-directory paths, runtime databases, or your personal
  `pstack-models.mdc`.
- **No live calls in tests.** No TypeSafe request, provider API call, real Herdr pane, or
  network access. Inject the fakes that already exist (`createTypeSafeClient`,
  `createProcessAdapter`, `createHerdr`).
- **Keep previews pure.** `roles`, `plan`, and rules-mode `run --dry-run` must not start a
  process, open the router database, read a credential store, or use the network.
  `test/cli/rules-cli.test.ts` checks this; keep it passing.
- **Fail closed.** A missing CLI, flag, model, or read-only mode refuses the launch. Never
  fall back to another model, an API key, or an unrestricted mode.
- **Exact models.** Keep native model ids exact. Do not map them to rolling aliases.
- **English** for code, docs, examples, and commit messages.

## Pull requests

- One logical change per pull request, with tests for behavior changes.
- Describe what changed, why, and how you verified it (the commands you ran and their result).
- Update `README.md`, `docs/`, and `CHANGELOG.md` when user-visible behavior changes.

## Reporting security issues

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
