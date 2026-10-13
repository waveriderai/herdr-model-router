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
*/5 * * * * /usr/bin/python3 /Users/waverider/hmr-usage/bin/collect.py >>/Users/waverider/hmr-usage/collect.log 2>&1
```

## Known limits

- Claude and Cursor are read through CodexBar's browser-cookie source; if those cookies expire the row shows an `error`.
- Posting `alerts.jsonl` to the room is not wired yet.
- `gpt-*` "at capacity" errors are provider-side and do not show up here.
