#!/usr/bin/env python3
"""HMR usage collector (AGENT-197). Read-only; strips account identity."""
import json, os, subprocess, tempfile, datetime
D = os.path.expanduser("~/hmr-usage")
CB = "/opt/homebrew/bin/codexbar"
WARN = 80
PROVIDERS = ["codex", "claude", "cursor", "grok"]
def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
rows, errs = [], []
for pid in PROVIDERS:
    try:
        r = subprocess.run([CB, "usage", "--provider", pid, "--json"], capture_output=True, text=True, timeout=120)
        d = json.loads(r.stdout); d = d if isinstance(d, list) else [d]
        for x in d:
            u = x.get("usage") or {}; labels = x.get("rateWindowLabels") or {}
            for slot in ("primary", "secondary", "tertiary"):
                w = u.get(slot)
                if not w: continue
                rows.append({"provider": pid, "plan": u.get("loginMethod"), "source": x.get("source"),
                    "window": labels.get(slot, slot), "window_minutes": w.get("windowMinutes"),
                    "used_pct": w.get("usedPercent"), "resets_at": w.get("resetsAt"),
                    "provider_updated": u.get("updatedAt"), "error": None})
    except Exception as e:
        errs.append(pid)
        rows.append({"provider": pid, "window": None, "used_pct": None, "resets_at": None,
                     "error": type(e).__name__ + ": " + str(e)[:200]})
out = {"updated": now(), "ok": not errs, "rows": rows}
sp = os.path.join(D, "warn_state.json")
state = json.load(open(sp)) if os.path.exists(sp) else {}
for r in rows:
    k = "%s:%s" % (r["provider"], r["window"]); u = r["used_pct"]
    if u is None: continue
    if u >= WARN and not state.get(k):
        state[k] = True
        with open(os.path.join(D, "alerts.jsonl"), "a") as f:
            f.write(json.dumps({"at": out["updated"], "key": k, "used_pct": u, "resets_at": r["resets_at"], "posted": False}) + "\n")
    elif u < WARN:
        state[k] = False
json.dump(state, open(sp, "w"))
fd, tmp = tempfile.mkstemp(dir=D)
with os.fdopen(fd, "w") as f: json.dump(out, f, indent=1)
os.replace(tmp, os.path.join(D, "usage.json"))
with open(os.path.join(D, "history.jsonl"), "a") as f: f.write(json.dumps(out) + "\n")
