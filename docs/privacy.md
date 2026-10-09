# Privacy

## Rules mode (default)

- `roles`, `plan`, and `run --dry-run` read the rules file and `.model-router/policy.json`
  only. They make no network call, start no process, query no credential store, and create no
  router state.
- An ambient `TYPESAFE_API_KEY` is ignored unless `--routing-mode semantic` is given without
  `--role`. Only then is the key looked up and the task text sent to TypeSafe.
- A launch records the task's role, worktree path, rules path, lanes, native argv, pane and
  agent names, and each prompt attempt's state and evidence. Prompts are stored as SHA-256
  hashes, not text.
- The router never reads, stores, or changes provider credentials. Each CLI uses its own login.
- A launched CLI starts through `/usr/bin/env -i` with only the allowlist in
  [Rules mode](rules.md#launch), read from its new pane's shell. API keys and cloud credentials
  exported by your shell are dropped. Persistent CLI auth configuration is operator-owned.
- Launch scripts under `<router home>/launch/` contain only the working directory, executable
  path, and native argv, are mode 0600, and are deleted after the launch is observed.

## Coordinator workflow

- `workflow plan` and `workflow fingerprint` read files and Git only; they write no state.
- Briefs, results, acceptance and release evidence, and the prompts handed to agent-collab are
  kept as files under `<router home>/workflows/<id>/` (directory `0700`, files `0600`). A router
  home inside the target checkout, directly or through a symlink, is refused before anything
  is created, so none of this can land in the checkout. A recorded file is never overwritten.
  SQLite stores only their SHA-256, states, and evidence text.
- The router keeps the agent-collab owner capability in that private directory only, removes it
  on release, and never written to router JSON, SQLite, prompts, or logs. The agent-collab CLI
  accepts it only as its `--owner` argument, so it is visible in the local process table to
  the same user while that call runs.
- The agent-collab subprocess receives the same allowlisted environment as Herdr calls, without
  provider API keys. agent-collab keeps its own copy of the brief in its own state directory.
  On agent-collab, HMR also writes the writer's route (`route.json`: provider, model, effort,
  directories, and digests, no credentials) to the private workflow directory and hands it to
  agent-collab, which keeps its own copy.
- Shared skills are read only from `--skills-root` directories the operator names; a brief
  names skills, never paths. Prompts carry each skill's path and SHA-256, not its contents.
- `start` sends the task text to the coordinator CLI in its pane once. The router database
  keeps only the SHA-256 of the task and of that prompt, the route, and the pane and session.

## Quota mode and shared components

- TypeSafe state must not include credentials, cookies, account labels, or raw heartbeats. Recognizable credentials are rejected locally before the first TypeSafe call; arbitrary sensitive narrative text still remains the caller's responsibility.
- Task enrichment sends a bucketed pull request size to TypeSafe: one of five size
  buckets, one of five file-count buckets, and a boolean — at most ~5.6 bits per run
  describing a repository's diff. No file path, branch name, pull request title, or
  repository name is sent. Disable it with `router run --no-enrich`, or by setting
  `enrichment.enabled` to `false` in config.
- `router effort --session` (live effort switching, off by default) sends TypeSafe the
  agent's one-line sub-step, the session phase, the current effort, and bucketed signals:
  step kind, consecutive failures (`0`, `1`, `2`, `3+`), files touched (`0`, `1-5`,
  `6-20`, `21+`), diff lines (`<50`, `50-300`, `300-1000`, `1000+`), and two booleans. It
  never sends the conversation. The sub-step text is not stored; the local `effort_changes`
  table keeps the source, from/to effort, outcome, confidence, and those bucketed signals.
  Pane text read to confirm a switch is parsed in memory and not stored.
- Coordinator rows store HMAC account fingerprints, opaque lease IDs, state, optional model family, optional reserved capacity, and timestamps.
- Owner UI may show `shared subscription currently active` only.
- Audit storage redacts `sk-` tokens and `Bearer` headers.
- Heartbeat payloads are `{ accountFingerprint, leaseId, modelFamily?, reservedCapacity?, ttlSeconds }`.
- Router state directories are restricted to the current user (`0700`); SQLite, WAL, and SHM files are `0600`.
- Launched Herdr commands receive an allowlisted environment rather than inheriting credential variables.
