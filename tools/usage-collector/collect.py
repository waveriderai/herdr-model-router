#!/usr/bin/env python3
"""HMR usage collector (AGENT-197). Read-only; strips account identity."""
import datetime
import fcntl
import json
import os
import subprocess
import sys
import tempfile

D = os.environ.get("HMR_USAGE_DIR") or os.path.expanduser("~/hmr-usage")
CB = os.environ.get("HMR_CODEXBAR") or "/opt/homebrew/bin/codexbar"
WARN = 80
PROVIDERS = ["codex", "claude", "cursor", "grok"]
# 4 providers x 60s = 240s worst case, inside the 5-minute cron interval.
TIMEOUT = 60


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def error_row(pid, msg):
    return {"provider": pid, "plan": None, "source": None, "window": None, "window_minutes": None,
            "used_pct": None, "resets_at": None, "provider_updated": None, "error": msg}


def error_label(x):
    """Short, non-sensitive label for a CodexBar JSON error (never the free-text message)."""
    e = x.get("error")
    if isinstance(e, dict):
        for key in ("kind", "code"):
            if isinstance(e.get(key), (str, int)):
                return "provider error (%s)" % e[key]
    return "provider error"


def read_provider(pid):
    """Return (rows, failed). Any non-success becomes an error row without raw CodexBar output."""
    try:
        r = subprocess.run([CB, "usage", "--provider", pid, "--json"],
                           capture_output=True, text=True, timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        return [error_row(pid, "timeout after %ds" % TIMEOUT)], True
    except OSError as e:
        return [error_row(pid, "cannot run codexbar: " + type(e).__name__)], True
    try:
        d = json.loads(r.stdout)
    except ValueError:
        d = None
    items = d if isinstance(d, list) else [d]
    items = [x for x in items if isinstance(x, dict)]
    if r.returncode != 0:
        label = error_label(items[0]) if items else "provider error"
        return [error_row(pid, "codexbar exit %d: %s" % (r.returncode, label))], True
    if not items:
        return [error_row(pid, "unparseable codexbar output")], True
    rows, failed = [], False
    for x in items:
        if x.get("error"):
            rows.append(error_row(pid, error_label(x)))
            failed = True
            continue
        u = x.get("usage") or {}
        labels = x.get("rateWindowLabels") or {}
        found = False
        for slot in ("primary", "secondary", "tertiary"):
            w = u.get(slot)
            if not w:
                continue
            found = True
            rows.append({"provider": pid, "plan": u.get("loginMethod"), "source": x.get("source"),
                         "window": labels.get(slot, slot), "window_minutes": w.get("windowMinutes"),
                         "used_pct": w.get("usedPercent"), "resets_at": w.get("resetsAt"),
                         "provider_updated": u.get("updatedAt"), "error": None})
        if not found:
            rows.append(error_row(pid, "no usage windows in codexbar output"))
            failed = True
    return rows, failed


def load_state(path):
    """Read warn state; a corrupt or unreadable file resets to empty instead of failing every run."""
    try:
        with open(path) as f:
            s = json.load(f)
        if isinstance(s, dict):
            return s
    except FileNotFoundError:
        return {}
    except (ValueError, OSError):
        pass
    print("%s warn_state.json unreadable; resetting" % now(), file=sys.stderr)
    return {}


def write_atomic(path, obj, **kw):
    fd, tmp = tempfile.mkstemp(dir=D)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(obj, f, **kw)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def main():
    os.makedirs(D, exist_ok=True)
    lock = open(os.path.join(D, "collect.lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("%s previous run still active; skipping" % now(), file=sys.stderr)
        return 0
    rows, errs = [], []
    for pid in PROVIDERS:
        prow, failed = read_provider(pid)
        rows += prow
        if failed:
            errs.append(pid)
    out = {"updated": now(), "ok": not errs, "rows": rows}
    sp = os.path.join(D, "warn_state.json")
    state = load_state(sp)
    for r in rows:
        k = "%s:%s" % (r["provider"], r["window"])
        u = r["used_pct"]
        if u is None:
            continue
        if u >= WARN and not state.get(k):
            state[k] = True
            with open(os.path.join(D, "alerts.jsonl"), "a") as f:
                f.write(json.dumps({"at": out["updated"], "key": k, "used_pct": u,
                                    "resets_at": r["resets_at"], "posted": False}) + "\n")
        elif u < WARN:
            state[k] = False
    write_atomic(sp, state)
    write_atomic(os.path.join(D, "usage.json"), out, indent=1)
    with open(os.path.join(D, "history.jsonl"), "a") as f:
        f.write(json.dumps(out) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
