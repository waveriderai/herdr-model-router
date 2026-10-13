# HMR usage collector (AGENT-197)

`collect.py` reads CodexBar (`codexbar usage --provider <p> --json`) for codex, claude, cursor and grok every 5 minutes on DevPro and writes:

- `~/hmr-usage/usage.json`: latest reading per provider and window (written atomically).
- `~/hmr-usage/history.jsonl`: one line per run, kept for threshold tuning (Phase 3 step 5).
- `~/hmr-usage/alerts.jsonl`: one entry each time a window crosses 80% (`posted: false` until a poster sends it to the HMR room). The flag resets when usage drops below 80%.

Rows contain provider, plan, source, window, used %, reset time and error only. Account emails from CodexBar are never written.

## Install (DevPro)

```
mkdir -p ~/hmr-usage/bin && cp tools/usage-collector/collect.py ~/hmr-usage/bin/
crontab -e
*/5 * * * * /usr/bin/python3 "$HOME/hmr-usage/bin/collect.py" >>"$HOME/hmr-usage/collect.log" 2>&1
```

## Known limits

- The collector does not pass `--source`, so CodexBar picks the source from its own config (default `auto`). Claude can fall back to the CLI and Cursor can use local app auth, not only browser cookies. Each row's `source` field records what CodexBar used. Pin it in CodexBar's config if you need a fixed source.
- A provider that fails (non-zero exit, JSON error, no usage windows, timeout) gets an `error` row and `ok: false`. Errors carry an exit code or error kind, never CodexBar's free-text message.
- Runs are serialized by `~/hmr-usage/collect.lock`; a run that starts while the previous one is active exits without writing. Each provider call times out after 60s (240s worst case, inside the 5-minute interval).
- `warn_state.json` is written atomically; if it is ever corrupt the collector resets it (a window above 80% may alert once more).
- Posting `alerts.jsonl` to the room is not wired yet.
- `gpt-*` "at capacity" errors are provider-side and do not show up here.
