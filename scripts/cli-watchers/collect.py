#!/usr/bin/env python3
"""Read-only CodexBar usage collector for HMR.

One round runs `codexbar usage --provider <id> --format json` per provider, projects an
allowlist of fields, replaces account identity with a keyed anonymous ID, and writes:

  usage.json     latest state, replaced atomically (router-compatible `rows` + full `meters`)
  history.jsonl  one appended line per round
  alerts.jsonl   local threshold alerts (never sent anywhere)
  state.json     last good reading per meter, known meters, alert arming
  account.key    local HMAC key for anonymous account IDs

Raw provider output, stderr, credentials, cookies, and account emails are never written or
printed. Provider failures are reduced to the bounded codes in ERROR_CODES.
"""

from __future__ import annotations

import argparse
import datetime as dt
import errno
import fcntl
import hashlib
import hmac
import json
import math
import os
import re
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time

SCHEMA_VERSION = 2
DEFAULT_PROVIDERS = ("codex", "claude", "cursor", "grok")
STANDARD_SLOTS = ("primary", "secondary", "tertiary")
FALLBACK_CODEXBAR = "/opt/homebrew/bin/codexbar"

EXIT_OK = 0
EXIT_DEGRADED = 1
EXIT_CONFIG = 2
EXIT_BUSY = 75

ERROR_CODES = frozenset(
    {
        "account_missing",  # the provider answered, but not for this known account
        "ambiguous_account",  # several entries without identity: not attributable
        "auth_failed",  # the provider reported a login/credential problem
        "deadline_exceeded",  # the round deadline stopped or skipped this provider
        "empty_output",
        "invalid_timestamp",  # the provider update time is missing, invalid, or in the future
        "invalid_value",  # a window whose percentage or shape is not valid
        "malformed_json",
        "missing_window",  # a meter seen before, or every window of an account, is absent
        "nonzero_exit",
        "not_installed",
        "oversized_output",
        "provider_error",  # the provider reported a non-auth error
        "spawn_failed",
        "timeout",  # the per-provider timeout expired
        "unexpected_shape",
    }
)

MAX_STDOUT_BYTES = 4 * 1024 * 1024
METER_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")
PROVIDER_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
AUTH_RE = re.compile(
    r"auth|log ?in|sign ?in|unauthori[sz]ed|forbidden|\b401\b|\b403\b|cookie|credential|"
    r"session expired|token expired|not logged",
    re.IGNORECASE,
)
# A provider update time later than this past the collection time is not trustworthy.
CLOCK_SKEW_SECONDS = 300
# A reading whose reset time passed more than this long ago describes a past cycle.
RESET_GRACE_SECONDS = 120
# Standard window labels kept verbatim; any other provider label becomes the slot name,
# so free-form provider text (which can carry an email or a credential) is never stored.
STANDARD_LABELS = {
    label.lower(): label
    for label in (
        "Session", "Hourly", "Daily", "Weekly", "Monthly", "Total", "Usage", "Requests",
        "Credits", "Auto", "API", "Premium", "Opus", "Sonnet", "Cursor", "Grok",
    )
}


# ---------------------------------------------------------------- validation helpers


def iso(ts: dt.datetime) -> str:
    return ts.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_time(value: object) -> dt.datetime | None:
    """A timezone-aware time between 2000 and 2100, or None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        if not math.isfinite(value):
            return None
        seconds = value / 1000 if value > 1e11 else value
        try:
            parsed = dt.datetime.fromtimestamp(seconds, dt.timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    elif isinstance(value, str):
        text = value.strip()
        if not 10 <= len(text) <= 40:
            return None
        text = re.sub(r"[Zz]$", "+00:00", text)
        # Python < 3.11 accepts only 3 or 6 fractional digits.
        text = re.sub(
            r"\.(\d+)", lambda m: "." + (m.group(1) + "000000")[:6], text, count=1
        )
        try:
            parsed = dt.datetime.fromisoformat(text)
        except ValueError:
            return None
        if parsed.tzinfo is None:
            return None
    else:
        return None
    if not 2000 <= parsed.year <= 2100:
        return None
    return parsed.astimezone(dt.timezone.utc)


def parse_percent(value: object) -> float | None:
    """A finite usage percentage in [0, 1000]; providers can report overage above 100."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value) or value < 0 or value > 1000:
        return None
    return round(float(value), 4)


def parse_minutes(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        return None
    return value


def standard_label(value: object, slot: str) -> str:
    """A label from the fixed vocabulary, or the slot name."""
    if isinstance(value, str):
        return STANDARD_LABELS.get(value.strip().lower(), slot)
    return slot


# ---------------------------------------------------------------- anonymous accounts


def load_account_key(state_dir: str) -> bytes:
    path = os.path.join(state_dir, "account.key")
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        key = secrets.token_hex(32)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(key + "\n")
        return key.encode()
    with os.fdopen(fd) as f:
        key = f.read().strip()
    if not re.fullmatch(r"[0-9a-f]{64}", key):
        raise ValueError("account.key is not a 64-character hex key")
    return key.encode()


def anonymous_account(key: bytes, provider: str, usage: dict) -> str | None:
    """A stable keyed ID for one provider account; the identity stays in memory."""
    identity = usage.get("identity") if isinstance(usage.get("identity"), dict) else {}

    def field(name: str) -> str:
        value = identity.get(name)
        if not isinstance(value, str) or not value.strip():
            value = usage.get(name)
        return value.strip().lower() if isinstance(value, str) else ""

    parts = [field("accountID"), field("accountEmail"), field("accountOrganization")]
    if not any(parts):
        return None
    material = "\x1f".join([provider] + parts).encode()
    return "acct-" + hmac.new(key, material, hashlib.sha256).hexdigest()[:12]


# ---------------------------------------------------------------- provider calls


def run_codexbar(cmd: list[str], timeout: float) -> tuple[str, int | None, bytes]:
    """('ok' | 'timeout' | 'spawn_failed' | 'not_installed' | 'oversized_output', exit, stdout).

    stderr is discarded unread; stdout stays in memory.
    """
    try:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except FileNotFoundError:
        return "not_installed", None, b""
    except OSError:
        return "spawn_failed", None, b""
    try:
        out, _ = proc.communicate(timeout=max(timeout, 0.01))
    except subprocess.TimeoutExpired:
        kill_group(proc)
        return "timeout", None, b""
    if len(out) > MAX_STDOUT_BYTES:
        return "oversized_output", proc.returncode, b""
    return "ok", proc.returncode, out


def kill_group(proc: subprocess.Popen) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    try:
        proc.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


class ProviderResult:
    def __init__(self, provider: str) -> None:
        self.provider = provider
        self.error: str | None = None  # provider-level code
        self.readings: list[dict] = []  # per account and meter
        self.accounts: set[str] = set()
        self.windowless_accounts: set[str] = set()  # answered without any window
        self.dropped_extra_windows = 0


def classify_error_entry(error: object) -> str:
    if isinstance(error, dict):
        text = " ".join(
            str(error.get(k, "")) for k in ("kind", "message") if isinstance(error.get(k), str)
        )
    elif isinstance(error, str):
        text = error
    else:
        text = ""
    return "auth_failed" if AUTH_RE.search(text) else "provider_error"


def parse_window(window: object) -> tuple[dict | None, str | None]:
    if not isinstance(window, dict):
        return None, "invalid_value"
    used = parse_percent(window.get("usedPercent"))
    if used is None:
        return None, "invalid_value"
    resets = parse_time(window.get("resetsAt"))
    return {
        "used_pct": used,
        "resets_at": iso(resets) if resets else None,
        "window_minutes": parse_minutes(window.get("windowMinutes")),
    }, None


def parse_provider_output(
    provider: str, status: str, exit_code: int | None, stdout: bytes, key: bytes
) -> ProviderResult:
    result = ProviderResult(provider)
    if status != "ok":
        result.error = status
        return result
    text = stdout.decode("utf-8", errors="replace").strip()
    if not text:
        result.error = "nonzero_exit" if exit_code else "empty_output"
        return result
    try:
        data = json.loads(text)
    except ValueError:
        result.error = "nonzero_exit" if exit_code else "malformed_json"
        return result
    entries = data if isinstance(data, list) else [data]
    if not entries or not all(isinstance(e, dict) for e in entries):
        result.error = "nonzero_exit" if exit_code else "unexpected_shape"
        return result

    entry_errors = [classify_error_entry(e["error"]) for e in entries if e.get("error")]
    usable = [e for e in entries if not e.get("error") and isinstance(e.get("usage"), dict)]
    if exit_code and not entry_errors:
        # A failure the output does not attribute: trust none of it.
        result.error = "nonzero_exit"
        return result
    if entry_errors:
        result.error = "auth_failed" if "auth_failed" in entry_errors else "provider_error"
    if not usable:
        result.error = result.error or "unexpected_shape"
        return result

    identified = [e for e in usable if anonymous_account(key, provider, e["usage"])]
    if len(identified) < len(usable):
        # Without identity, a reading cannot be tied to the same account across rounds.
        result.error = result.error or "ambiguous_account"
        usable = identified

    for entry in usable:
        usage = entry["usage"]
        account = anonymous_account(key, provider, usage)
        result.accounts.add(account)
        before = len(result.readings)
        updated = parse_time(usage.get("updatedAt"))
        labels = entry.get("rateWindowLabels")
        labels = labels if isinstance(labels, dict) else {}
        base = {
            "provider": provider,
            "account": account,
            "provider_updated": iso(updated) if updated else None,
            "time_error": None if updated else "invalid_timestamp",
        }
        for slot in STANDARD_SLOTS:
            window = usage.get(slot)
            if window is None:
                continue  # not offered; a meter seen before is reported missing later
            reading, error = parse_window(window)
            result.readings.append(
                dict(
                    base,
                    meter=slot,
                    kind="standard",
                    label=standard_label(labels.get(slot), slot),
                    reading=reading,
                    error=error,
                )
            )
        extras = usage.get("extraRateWindows")
        if extras is not None and not isinstance(extras, list):
            result.dropped_extra_windows += 1
            extras = None
        for extra in extras or []:
            meter = extra.get("id") if isinstance(extra, dict) else None
            if not isinstance(meter, str) or not METER_ID_RE.match(meter):
                result.dropped_extra_windows += 1
                continue
            reading, error = parse_window(extra.get("window"))
            result.readings.append(
                dict(
                    base,
                    meter=meter,
                    kind="extra",
                    label=meter,
                    reading=reading,
                    error=error,
                )
            )
        if len(result.readings) == before:
            # An account with no window at all must not look like a successful empty round.
            result.windowless_accounts.add(account)
            result.error = result.error or "missing_window"
    return result


# ---------------------------------------------------------------- state and merging


def meter_key(provider: str, account: str, meter: str) -> str:
    return f"{provider}|{account}|{meter}"


def same_cycle(a: str | None, b: str | None) -> bool:
    """Exact equality of normalized reset times; any movement starts a new cycle."""
    return a is not None and a == b


def is_stale(record: dict, now: dt.datetime, stale_after: dt.timedelta) -> bool:
    if record["used_pct"] is None:
        return True
    updated = parse_time(record["provider_updated"])
    if updated is None or now - updated > stale_after:
        return True  # no trustworthy provider time, or an old one
    if updated - now > dt.timedelta(seconds=CLOCK_SKEW_SECONDS):
        return True  # a provider time in the future
    resets = parse_time(record["resets_at"])
    if resets is not None and resets < now - dt.timedelta(seconds=RESET_GRACE_SECONDS):
        return True  # the window already reset; this percentage describes a past cycle
    return False


def failure_record(
    provider: str,
    account: str | None,
    meter: str | None,
    kind: str,
    error: str,
    collected_at: str,
    prev: dict | None = None,
) -> dict:
    prev = prev or {}
    if kind == "standard":
        label = standard_label(prev.get("label"), meter)
    else:
        label = meter  # extra windows are labelled by their stable ID
    return {
        "provider": provider,
        "account": account,
        "meter": meter,
        "kind": kind,
        "label": label,
        "window_minutes": prev.get("window_minutes"),
        "used_pct": None,
        "resets_at": None,
        "provider_updated": None,
        "collected_at": collected_at,
        "error": error,
        "delta_pct": None,
        "stale": True,
        "last_good": prev.get("last_good"),
    }


def merge_round(
    state: dict,
    results: dict[str, ProviderResult],
    now: dt.datetime,
    stale_after: dt.timedelta,
    forget_after: dt.timedelta,
) -> list[dict]:
    collected_at = iso(now)
    known: dict = state.setdefault("meters", {})
    records: list[dict] = []
    seen: set[str] = set()

    for result in results.values():
        for r in result.readings:
            k = meter_key(r["provider"], r["account"], r["meter"])
            seen.add(k)
            prev = known.get(k) or {}
            last_good = prev.get("last_good")
            reading = r["reading"]
            record = {
                "provider": r["provider"],
                "account": r["account"],
                "meter": r["meter"],
                "kind": r["kind"],
                "label": r["label"],
                "window_minutes": (reading or {}).get("window_minutes")
                or prev.get("window_minutes"),
                "used_pct": reading["used_pct"] if reading else None,
                "resets_at": reading["resets_at"] if reading else None,
                "provider_updated": r["provider_updated"] if reading else None,
                "collected_at": collected_at,
                "error": r["error"] or (r["time_error"] if reading else None),
                "delta_pct": None,
            }
            record["stale"] = is_stale(record, now, stale_after)
            updated = parse_time(record["provider_updated"])
            if updated is not None and updated - now > dt.timedelta(seconds=CLOCK_SKEW_SECONDS):
                record["error"] = record["error"] or "invalid_timestamp"
            if reading and not record["stale"]:
                if (
                    last_good
                    and same_cycle(last_good.get("resets_at"), record["resets_at"])
                    and record["used_pct"] >= last_good["used_pct"]
                ):
                    record["delta_pct"] = round(record["used_pct"] - last_good["used_pct"], 4)
                last_good = {
                    "used_pct": record["used_pct"],
                    "resets_at": record["resets_at"],
                    "provider_updated": record["provider_updated"],
                    "collected_at": collected_at,
                }
            record["last_good"] = last_good
            known[k] = {
                "provider": record["provider"],
                "account": record["account"],
                "meter": record["meter"],
                "kind": record["kind"],
                "label": record["label"],
                "window_minutes": record["window_minutes"],
                "last_good": last_good,
                "last_seen": collected_at,
            }
            records.append(record)

    for k, prev in sorted(known.items()):
        if k in seen:
            continue
        result = results.get(prev["provider"])
        if result is None:
            continue  # provider not configured this round; keep its memory untouched
        if prev["account"] in result.accounts:
            error = "missing_window"
        elif result.error:
            error = result.error
        else:
            error = "account_missing"
        records.append(
            failure_record(
                prev["provider"], prev["account"], prev["meter"], prev["kind"], error,
                collected_at, prev,
            )
        )

    # An account that answered without any window, and seen with no known meter either.
    for provider, result in results.items():
        for account in sorted(result.windowless_accounts):
            if not any(r["provider"] == provider and r["account"] == account for r in records):
                records.append(
                    failure_record(provider, account, None, "account", "missing_window",
                                   collected_at)
                )

    # Providers that failed and have no known meter still need a visible record.
    for provider, result in results.items():
        if result.error and not any(r["provider"] == provider for r in records):
            records.append(
                failure_record(provider, None, None, "provider", result.error, collected_at)
            )

    for k in list(known):
        last_seen = parse_time(known[k].get("last_seen"))
        if last_seen is None or now - last_seen > forget_after:
            del known[k]
    return records


def compat_rows(records: list[dict]) -> list[dict]:
    """Rows the router's usage reader understands: standard windows only.

    A stale reading never carries `used_pct`, so a consumer cannot mistake it for current.
    """
    rows = []
    for r in records:
        if r["kind"] == "extra":
            continue
        current = r["used_pct"] is not None and not r["stale"]
        rows.append(
            {
                "provider": r["provider"],
                "account": r["account"],
                "meter": r["meter"],
                "window": r["label"],
                "window_minutes": r["window_minutes"],
                "used_pct": r["used_pct"] if current else None,
                "resets_at": r["resets_at"] if current else None,
                "provider_updated": r["provider_updated"],
                "collected_at": r["collected_at"],
                "stale": r["stale"],
                "error": r["error"] or (None if current else "stale_source"),
            }
        )
    return rows


def update_alerts(state: dict, records: list[dict], warn_pct: float) -> list[dict]:
    """One local alert per meter and reset cycle when usage crosses `warn_pct`."""
    armed: dict = state.setdefault("alerts", {})
    alerts = []
    for r in records:
        if r["used_pct"] is None or r["stale"]:
            continue
        k = meter_key(r["provider"], r["account"], r["meter"])
        cycle = r["resets_at"] or "unknown"
        if r["used_pct"] >= warn_pct:
            if armed.get(k) != cycle:
                armed[k] = cycle
                alerts.append(
                    {
                        "at": r["collected_at"],
                        "key": k,
                        "provider": r["provider"],
                        "account": r["account"],
                        "meter": r["meter"],
                        "used_pct": r["used_pct"],
                        "resets_at": r["resets_at"],
                        "posted": False,
                    }
                )
        elif armed.get(k) == cycle:
            del armed[k]
    return alerts


# ---------------------------------------------------------------- files


def load_state(path: str) -> dict:
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return {"version": SCHEMA_VERSION, "meters": {}, "alerts": {}}
    with os.fdopen(fd) as f:
        try:
            data = json.load(f)
        except ValueError:
            data = None
    if not isinstance(data, dict) or data.get("version") != SCHEMA_VERSION:
        return {"version": SCHEMA_VERSION, "meters": {}, "alerts": {}}
    if not isinstance(data.get("meters"), dict) or not isinstance(data.get("alerts"), dict):
        return {"version": SCHEMA_VERSION, "meters": {}, "alerts": {}}
    return data


def write_atomic(path: str, payload: object) -> None:
    directory = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(payload, f, indent=1, sort_keys=True)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def append_lines(path: str, items: list[dict]) -> None:
    if not items:
        return
    data = "".join(json.dumps(i, sort_keys=True, separators=(",", ":")) + "\n" for i in items)
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        os.write(fd, data.encode())
        os.fsync(fd)
    finally:
        os.close(fd)


STATE_FILES = (
    "account.key", "collect.lock", "history.jsonl", "alerts.jsonl", "state.json", "usage.json",
)


class UnsafePath(Exception):
    """A state path that is a symlink, not ours, or not the expected file type."""


def prepare_state_dir(state_dir: str) -> None:
    """Create the state dir, or tighten a reused one to 0700 with 0600 files."""
    os.makedirs(state_dir, mode=0o700, exist_ok=True)
    st = os.lstat(state_dir)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.geteuid():
        raise UnsafePath("state dir is not a directory owned by this user")
    os.chmod(state_dir, 0o700)
    for name in STATE_FILES:
        path = os.path.join(state_dir, name)
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            continue
        except OSError as exc:
            if exc.errno == errno.ELOOP:
                raise UnsafePath(f"{name} is a symlink") from None
            raise
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid():
                raise UnsafePath(f"{name} is not a regular file owned by this user")
            os.fchmod(fd, 0o600)
        finally:
            os.close(fd)


def acquire_lock(state_dir: str) -> int | None:
    fd = os.open(
        os.path.join(state_dir, "collect.lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600
    )
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        os.close(fd)
        if exc.errno in (errno.EWOULDBLOCK, errno.EAGAIN, errno.EACCES):
            return None
        raise
    return fd


# ---------------------------------------------------------------- round


def default_codexbar() -> str:
    return os.environ.get("CODEXBAR_BIN") or shutil.which("codexbar") or FALLBACK_CODEXBAR


def collect(args: argparse.Namespace) -> int:
    state_dir = os.path.abspath(args.state_dir)
    try:
        prepare_state_dir(state_dir)
    except UnsafePath as exc:
        print(f"collect: unsafe state path: {exc}", file=sys.stderr)
        return EXIT_CONFIG
    lock = acquire_lock(state_dir)
    if lock is None:
        print("collect: another round holds the lock; nothing written", file=sys.stderr)
        return EXIT_BUSY
    try:
        return run_round(args, state_dir)
    finally:
        os.close(lock)


def run_round(args: argparse.Namespace, state_dir: str) -> int:
    start = time.monotonic()
    deadline = start + args.round_deadline
    key = load_account_key(state_dir)
    results: dict[str, ProviderResult] = {}
    dropped = 0
    for provider in args.providers:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            results[provider] = parse_provider_output(provider, "deadline_exceeded", None, b"", key)
            continue
        cmd = [args.codexbar, "usage", "--provider", provider, "--format", "json", "--no-color"]
        if args.all_accounts:
            cmd.append("--all-accounts")
        limit = min(args.provider_timeout, remaining)
        status, code, out = run_codexbar(cmd, limit)
        if status == "timeout" and limit < args.provider_timeout:
            status = "deadline_exceeded"
        results[provider] = parse_provider_output(provider, status, code, out, key)
        dropped += results[provider].dropped_extra_windows
        del out

    now = args.now or dt.datetime.now(dt.timezone.utc)
    state_path = os.path.join(state_dir, "state.json")
    state = load_state(state_path)
    records = merge_round(
        state,
        results,
        now,
        dt.timedelta(minutes=args.stale_after),
        dt.timedelta(days=args.forget_after_days),
    )
    alerts = update_alerts(state, records, args.warn_pct)
    errors = {p: r.error for p, r in results.items() if r.error}
    ok = not errors and not any(r["stale"] for r in records)
    collected_at = iso(now)
    round_info = {
        "duration_s": round(time.monotonic() - start, 3),
        "providers": list(args.providers),
        "errors": errors,
        "dropped_extra_windows": dropped,
    }
    latest = {
        "schema": SCHEMA_VERSION,
        "updated": collected_at,
        "ok": ok,
        "round": round_info,
        "rows": compat_rows(records),
        "meters": records,
    }
    append_lines(
        os.path.join(state_dir, "history.jsonl"),
        [{"schema": SCHEMA_VERSION, "updated": collected_at, "ok": ok, "round": round_info,
          "meters": records}],
    )
    append_lines(os.path.join(state_dir, "alerts.jsonl"), alerts)
    write_atomic(state_path, state)
    write_atomic(os.path.join(state_dir, "usage.json"), latest)

    stale = sum(1 for r in records if r["stale"])
    print(
        f"collect: {len(records)} meters, {stale} stale, errors="
        + (",".join(f"{p}:{c}" for p, c in sorted(errors.items())) or "none"),
        file=sys.stderr,
    )
    if args.report:
        for r in records:
            print(
                "\t".join(
                    str(v)
                    for v in (
                        r["provider"],
                        r["account"],
                        r["meter"],
                        r["used_pct"],
                        r["resets_at"],
                        r["provider_updated"],
                        r["collected_at"],
                        "stale" if r["stale"] else "fresh",
                        r["error"] or "-",
                    )
                )
            )
    return EXIT_OK if ok else EXIT_DEGRADED


def positive_float(text: str) -> float:
    value = float(text)
    if not math.isfinite(value) or value <= 0:
        raise argparse.ArgumentTypeError("must be a positive number")
    return value


def provider_list(text: str) -> list[str]:
    items = [p.strip() for p in text.split(",") if p.strip()]
    if not items or not all(PROVIDER_ID_RE.match(p) for p in items):
        raise argparse.ArgumentTypeError("comma-separated lowercase provider IDs")
    if len(set(items)) != len(items):
        raise argparse.ArgumentTypeError("duplicate provider")
    return items


def test_time(text: str) -> dt.datetime:
    parsed = parse_time(text)
    if parsed is None:
        raise argparse.ArgumentTypeError("an ISO 8601 time with a timezone")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Collect CodexBar usage into a private state dir.")
    p.add_argument(
        "--state-dir",
        default=os.environ.get("HMR_USAGE_DIR"),
        help="private output directory (or HMR_USAGE_DIR); required",
    )
    p.add_argument("--codexbar", default=default_codexbar(), help="CodexBar CLI path")
    p.add_argument(
        "--providers", type=provider_list, default=list(DEFAULT_PROVIDERS),
        help="comma-separated provider IDs (default: %(default)s)",
    )
    p.add_argument("--provider-timeout", type=positive_float, default=60.0, help="seconds")
    p.add_argument(
        "--round-deadline", type=positive_float, default=240.0,
        help="seconds for the whole round; keep below the schedule interval",
    )
    p.add_argument("--stale-after", type=positive_float, default=30.0, help="minutes")
    p.add_argument("--forget-after-days", type=positive_float, default=14.0)
    p.add_argument("--warn-pct", type=positive_float, default=80.0)
    p.add_argument("--all-accounts", action="store_true", help="pass --all-accounts to CodexBar")
    p.add_argument(
        "--report", action="store_true",
        help="print one anonymous line per meter to stdout",
    )
    p.add_argument("--now", type=test_time, default=None, help=argparse.SUPPRESS)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if not args.state_dir:
        print("collect: --state-dir or HMR_USAGE_DIR is required", file=sys.stderr)
        return EXIT_CONFIG
    os.umask(0o077)
    return collect(args)


if __name__ == "__main__":
    sys.exit(main())
