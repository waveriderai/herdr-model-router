# Configuration

Local state lives under `MODEL_ROUTER_HOME` when it is set, otherwise the platform config
directory: `~/Library/Application Support/model-router` on macOS,
`$XDG_CONFIG_HOME/model-router` (default `~/.config/model-router`) on Linux, and
`%APPDATA%\model-router` on Windows.

`MODEL_ROUTER_HOME/config.json` example:

```json
{
  "accounts": [
    {
      "id": "acct_personal_cursor",
      "label": "personal cursor",
      "provider": "cursor",
      "agent": "cursor",
      "ownership": "personal",
      "collectorPreference": ["official-cli", "local-session", "browser-dashboard"],
      "enabledModels": ["cursor:grok-4.6"],
      "enabled": true,
      "credentialRef": "env:CURSOR_API_KEY"
    }
  ],
  "coordinator": {
    "url": "https://example.invalid",
    "readerCredentialRef": "env:COORDINATOR_READER_TOKEN"
  },
  "typesafe": {
    "apiKeyRef": "keychain:model-router-typesafe"
  },
  "enrichment": {
    "enabled": true
  },
  "liveEffort": {
    "enabled": false
  }
}
```

Credential values stay in the environment or keychain. The router stores references
only (`env:NAME` or `keychain:NAME`). `keychain:NAME` reads the macOS login Keychain
generic password with service `NAME` (`security find-generic-password -s NAME -w`); add
one with `security add-generic-password -a "$USER" -s NAME -w`. For `typesafe.apiKeyRef`,
`TYPESAFE_API_KEY` is used when the reference has no value. Shared `reserveFloor` cannot be set below `0.40`.
`collectorPreference` lists collector kinds in preference order. `router run` uses only
`local-session` collectors unless you pass `--usage`, which runs the full chain
(official-cli/api, local-session, browser).
`enrichment.enabled` defaults to `true`. Set it to `false` to prevent `router run` from
resolving pull request size through GitHub; `--no-enrich` disables it for one invocation.
`liveEffort.enabled` defaults to `false`. Set it to `true` to let the router change the
reasoning effort of a running Opus 5.5 (`anthropic:claude-opus`) or GPT 6 Astra
(`openai:gpt-6-astra`) pane instead of opening a new one; see "Live effort switching" in the
README. When `false`, phases always open a new pane and `router effort` reports `disabled`.
`MODEL_ROUTER_COORDINATOR_URL` overrides the file URL.
Coordinator URLs must use HTTPS; HTTP is accepted only for `localhost`, `127.0.0.1`, or
`[::1]` during local development.

## Usage numbers

Rules mode chooses the account for a lane's model by remaining quota (see
[Accounts](rules.md#accounts)). It reads the usage collector's snapshot, `~/hmr-usage/usage.json` by default. Set
`HMR_USAGE_FILE` to read another path. Today an unmanaged local collector, outside this
repository, owns that file and its 5-minute schedule. `scripts/cli-watchers/collect.py` (see
[CLI watchers](cli-watchers.md)) is its candidate replacement. It is not installed or
scheduled, and it writes only to the `--state-dir` it is given.

```json
{
  "updated": "2026-10-13T08:25:20+00:00",
  "ok": true,
  "rows": [
    { "provider": "claude", "window": "Weekly", "used_pct": 23, "resets_at": "...", "error": null },
    { "provider": "cursor", "window": "Total", "used_pct": 0, "resets_at": "...", "error": null },
    { "provider": "grok", "window": null, "used_pct": null, "error": "TimeoutExpired: 120s" }
  ]
}
```

- `provider` is the account: the provider id from the rules (`claude`, `cursor`, `grok`,
  `codex`).
- An account's remaining quota is `100 - used_pct` of its most-used window.
- A row with `error` and no `used_pct` gives that account no reading. An account with no
  reading ranks below every account with one.
- A file older than 30 minutes, or one that does not parse, is not used. `plan` says why.
  Without numbers, each lane runs on the account the rules file names.
- The router reads this file only, also for `plan` and `--dry-run`. It runs no collector and
  reads no credential.

An account is **low** below 20% remaining (the collector alerts at 80% used). A
`first-version` account that is low gives the first version to the account with the most
remaining quota. No account is assumed low or high without a reading.
