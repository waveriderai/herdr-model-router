#!/usr/bin/env python3
"""Log-only Herdr pane watcher.

Each tick reads Herdr through read-only CLI commands, compares each task's lifecycle state
and new pane content with the private state from the previous tick, and appends events for
real changes only. It never prompts, types into, focuses, starts, or closes anything, never
calls a model, and never sends a notification.

Files in the private state directory:

  state.json       tasks, blocker episodes, dedup keys, counters (replaced atomically)
  heartbeat.json   last tick and counters, written every tick (replaced atomically)
  events.jsonl     one appended line per event; summaries are bounded and redacted
  snapshots/       latest redacted screen per task, plus one copy per lifecycle event
  watch.lock       exclusive lock: one watcher per state directory

Raw Herdr stdout, stderr, and error messages are never written or printed.
"""

from __future__ import annotations

import argparse
import difflib
import errno
import fcntl
import hashlib
import json
import os
import re
import signal
import stat
import subprocess
import sys
import tempfile
import time

SCHEMA_VERSION = 1
EXIT_OK = 0
EXIT_DEGRADED = 1
EXIT_CONFIG = 2
EXIT_BUSY = 75

# The only Herdr commands this watcher may run.
READ_ONLY_COMMANDS = frozenset(
    {("agent", "list"), ("agent", "get"), ("pane", "read"), ("session", "list")}
)
STATUSES = frozenset({"idle", "working", "blocked", "done", "unknown"})
HOT_STATUSES = frozenset({"working"})  # polled every tick; everything else waits for discovery
READY_STATUSES = frozenset({"idle", "done"})
HERDR_ERROR_CODES = frozenset(
    {"server_not_running", "agent_not_found", "pane_not_found", "session_not_found",
     "not_found", "invalid_target", "unavailable"}
)
GONE_CODES = frozenset({"agent_not_found", "pane_not_found", "not_found"})
SERVER_CODES = frozenset(
    {"server_not_running", "session_not_found", "unavailable", "timeout", "not_installed",
     "spawn_failed"}
)
# A slow pane is a problem of that task, not proof that Herdr itself is down.
TASK_LEVEL_CODES = frozenset({"timeout", "deadline_exceeded"})
PANE_ID_RE = re.compile(r"^w[0-9A-Za-z]{1,8}:p[0-9A-Za-z]{1,8}$")
NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
TERMINAL_RE = re.compile(r"^term_[0-9a-f]{1,32}$")
SESSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
MAX_STDOUT_BYTES = 8 * 1024 * 1024
DEDUP_KEEP = 5000
SUMMARY_LINES = 8
SUMMARY_LINE_CHARS = 200
SIGNATURE_LINES = 12
FORGET_GONE_SECONDS = 86400

# ---------------------------------------------------------------- redaction

REDACTED = "[REDACTED]"
SECRET_PATTERNS = [
    re.compile(r"(?i)\b(authorization|proxy-authorization)\s*:\s*\S.*"),
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{8,}"),
    re.compile(r"(?i)\b(set-cookie|cookie)\s*:\s*\S.*"),
    re.compile(
        r"(?i)\b([A-Za-z0-9_]*(api[_-]?key|token|secret|password|passwd|pwd|cookie|"
        r"session[_-]?id|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_]*)"
        r"([\"']?\s*[:=]\s*)(\"[^\"]*\"|'[^']*'|\S+)"
    ),
    re.compile(r"\bsk-(ant-)?[A-Za-z0-9_-]{16,}"),
    re.compile(r"\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"\bglpat-[A-Za-z0-9_-]{16,}"),
    re.compile(r"\bxox[abposr]-[A-Za-z0-9-]{10,}"),
    re.compile(r"\b(AKIA|ASIA)[0-9A-Z]{16}\b"),
    re.compile(r"\bAIza[0-9A-Za-z_-]{30,}"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"),
    re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),
]
SECRET_ENV_RE = re.compile(r"(?i)(key|token|secret|password|passwd|cookie|auth|credential)")
ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]")


def env_secrets() -> list[str]:
    """Values of this process's credential-like environment variables, longest first."""
    values = {
        v for k, v in os.environ.items() if SECRET_ENV_RE.search(k) and len(v) >= 8
    }
    return sorted(values, key=len, reverse=True)


# A whole private key block; an unterminated one runs to the end of the screen, and an end
# marker whose header scrolled away takes everything above it.
PEM_BLOCK_RE = re.compile(
    r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|\Z)", re.S
)
PEM_TAIL_RE = re.compile(r"\A.*?-----END [A-Z0-9 ]*PRIVATE KEY-----", re.S)


def redact(text: str, secrets: list[str], home: str | None) -> str:
    text = ANSI_RE.sub("", text)
    text = PEM_BLOCK_RE.sub(REDACTED, text)
    text = PEM_TAIL_RE.sub(REDACTED, text)
    for value in secrets:
        text = text.replace(value, REDACTED)
    for pattern in SECRET_PATTERNS:
        text = pattern.sub(REDACTED, text)
    if home and len(home) > 1:
        text = text.replace(home, "~")
    return "".join(ch for ch in text if ch.isprintable() or ch in "\n\t")


# ---------------------------------------------------------------- content comparison

LEADING_GLYPHS_RE = re.compile(r"^[^\w\[(<>$#@`'\"]+")
# Status, footer, and progress chrome that agent TUIs redraw in place. Only on these lines
# are counters ignored; in ordinary output a changed value is new content.
CHROME_RE = re.compile(
    r"(?i)esc to (interrupt|cancel)|ctrl\+c to (interrupt|cancel)|\? for shortcuts|"
    r"context left|auto-compact|[↑↓]\s*[\d.]+\s*k?\s*tokens|"
    r"^\s*[✻✶✳✢✽✺·*●◐◓◑◒\u2800-\u28ff]\s*\w[\w ]*…"
)
# Values such chrome redraws: elapsed times, clocks, percentages, token counts.
VOLATILE_RE = re.compile(
    r"\b\d{1,2}:\d{2}(:\d{2})?\b|"
    r"\b\d+(\.\d+)?\s*(ms|s|sec|m|min|h|k|K|M|%|tokens?)(?![\w])|"
    r"\b\d+(\.\d+)?%"
)


def line_key(line: str) -> str:
    """A comparison key: ordinary output is literal apart from spacing; only TUI chrome
    ignores its leading spinner glyphs and redrawn counters."""
    key = line.strip()
    if CHROME_RE.search(line):
        key = LEADING_GLYPHS_RE.sub("", key)
        key = re.sub(r"#(\s*#)+", "#", VOLATILE_RE.sub("#", key))
    return re.sub(r"\s+", " ", key).strip()


def new_lines(previous: list[str], current: list[str]) -> list[str]:
    """Lines of `current` absent from `previous`, aligned so that a rolling window, a fixed
    footer, and redrawn counters do not count as new content."""
    pk = [line_key(x) for x in previous]
    ck = [line_key(x) for x in current]
    matcher = difflib.SequenceMatcher(None, pk, ck, autojunk=False)
    out = []
    for tag, _, _, j1, j2 in matcher.get_opcodes():
        if tag in ("insert", "replace"):
            out.extend(i for i in range(j1, j2) if ck[i])
    return [current[i] for i in out]


def summarize(lines: list[str], limit: int) -> str:
    picked = [x.strip()[:SUMMARY_LINE_CHARS] for x in lines if x.strip()][-SUMMARY_LINES:]
    text = "\n".join(picked)
    return text[-limit:] if len(text) > limit else text


def signature(lines: list[str]) -> str:
    keys = [k for k in (line_key(x) for x in lines) if k][-SIGNATURE_LINES:]
    return digest("\n".join(keys))


def digest(text: str, size: int = 16) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:size]


# ---------------------------------------------------------------- private files


class UnsafePath(Exception):
    """A state path that is a symlink, not ours, or not the expected type."""


def check_private(path: str, want_dir: bool) -> None:
    st = os.lstat(path)
    kind_ok = stat.S_ISDIR(st.st_mode) if want_dir else stat.S_ISREG(st.st_mode)
    if not kind_ok or st.st_uid != os.geteuid():
        raise UnsafePath(f"{os.path.basename(path)} is not a private {'dir' if want_dir else 'file'}")
    os.chmod(path, 0o700 if want_dir else 0o600)


def prepare_state_dir(state_dir: str) -> None:
    """Create the state tree, or tighten a reused one to 0700 dirs and 0600 files."""
    for directory in (state_dir, os.path.join(state_dir, "snapshots")):
        os.makedirs(directory, mode=0o700, exist_ok=True)
        check_private(directory, want_dir=True)
        for name in os.listdir(directory):
            path = os.path.join(directory, name)
            if name == "snapshots" and directory == state_dir:
                continue
            check_private(path, want_dir=False)


def write_atomic(path: str, payload: object, text: bool = False) -> None:
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-")
    try:
        with os.fdopen(fd, "w") as f:
            if text:
                f.write(payload)  # type: ignore[arg-type]
            else:
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


def acquire_lock(state_dir: str) -> int | None:
    fd = os.open(os.path.join(state_dir, "watch.lock"),
                 os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        os.close(fd)
        if exc.errno in (errno.EWOULDBLOCK, errno.EAGAIN, errno.EACCES):
            return None
        raise
    return fd


def new_state(session: str) -> dict:
    return {"version": SCHEMA_VERSION, "session": session, "tasks": {}, "dedup": {},
            "outage": None, "last_discovery": None, "force_discovery": True,
            "counters": {"ticks": 0, "detected": 0, "deduped": 0, "human_judgment": 0,
                         "errors": 0, "herdr_calls": 0}}


def load_state(path: str, session: str) -> dict:
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return new_state(session)
    with os.fdopen(fd) as f:
        try:
            data = json.load(f)
        except ValueError:
            return new_state(session)
    if (not isinstance(data, dict) or data.get("version") != SCHEMA_VERSION
            or data.get("session") != session or not isinstance(data.get("tasks"), dict)):
        return new_state(session)
    return data


# ---------------------------------------------------------------- Herdr access


class Herdr:
    def __init__(self, binary: str, session: str, timeout: float, counters: dict) -> None:
        self.binary = binary
        self.session = session
        self.timeout = timeout
        self.counters = counters

    def call(self, *command: str, deadline: float) -> tuple[str | None, str]:
        """(error code or None, stdout). stderr is read only for Herdr's error code."""
        if tuple(command[:2]) not in READ_ONLY_COMMANDS:
            raise ValueError("not a read-only Herdr command")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return "deadline_exceeded", ""
        self.counters["herdr_calls"] = self.counters.get("herdr_calls", 0) + 1
        argv = [self.binary, "--session", self.session, *command]
        try:
            proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, start_new_session=True)
        except FileNotFoundError:
            return "not_installed", ""
        except OSError:
            return "spawn_failed", ""
        try:
            out, err = proc.communicate(timeout=min(self.timeout, remaining))
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            proc.communicate()
            return "timeout", ""
        if len(out) > MAX_STDOUT_BYTES:
            return "oversized_output", ""
        if proc.returncode == 0:
            return None, out.decode("utf-8", errors="replace")
        if proc.returncode == 2:
            return "cli_usage_error", ""
        code = "herdr_error"
        try:
            parsed = json.loads(err.decode("utf-8", errors="replace"))
            candidate = parsed.get("error", {}).get("code")
            if candidate in HERDR_ERROR_CODES:
                code = candidate
        except (ValueError, AttributeError):
            pass
        return code, ""


def project_agent(raw: object) -> dict | None:
    """Allowlisted lifecycle fields of one Herdr agent; cwd, titles, and other text dropped."""
    if not isinstance(raw, dict):
        return None
    pane = raw.get("pane_id")
    if not isinstance(pane, str) or not PANE_ID_RE.match(pane):
        return None
    status = raw.get("agent_status")
    status = status if status in STATUSES else "unknown"
    kind = raw.get("agent")
    kind = kind if isinstance(kind, str) and NAME_RE.match(kind) else "unknown"
    name = raw.get("name")
    name = name if isinstance(name, str) and NAME_RE.match(name) else None
    terminal = raw.get("terminal_id")
    terminal = terminal if isinstance(terminal, str) and TERMINAL_RE.match(terminal) else ""
    session = raw.get("agent_session")
    session_value = session.get("value") if isinstance(session, dict) else None
    session_value = session_value if isinstance(session_value, str) else ""
    seq = raw.get("state_change_seq")
    seq = seq if isinstance(seq, int) and not isinstance(seq, bool) else None
    return {
        "pane": pane,
        "status": status,
        "agent": kind,
        "name": name,
        # Terminal plus agent session: a restarted or reused agent gets a new instance.
        "instance": digest(f"{terminal}|{session_value}|{kind}", 12),
        "seq": seq,
    }


def parse_json(text: str) -> dict | None:
    try:
        data = json.loads(text)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


# ---------------------------------------------------------------- watcher


class Watcher:
    def __init__(self, args: argparse.Namespace, state_dir: str) -> None:
        self.args = args
        self.state_dir = state_dir
        self.state_path = os.path.join(state_dir, "state.json")
        self.state = load_state(self.state_path, args.session)
        self.counters = self.state["counters"]
        self.herdr = Herdr(args.herdr, args.session, args.timeout, self.counters)
        self.secrets = env_secrets()
        self.home = os.path.expanduser("~")
        self.events: list[dict] = []
        self.tick_counts: dict = {}

    # -------------------------------------------------------- events

    def emit(self, etype: str, task: dict | None, material: str, *, summary: str = "",
             needs_human: bool = False, error: str | None = None,
             snapshot: list[str] | None = None, **extra: object) -> None:
        identity = f"{task['key']}|{task['instance']}" if task else f"watcher|{self.args.session}"
        key = digest(f"{identity}|{etype}|{digest(material)}", 24)
        if key in self.state["dedup"]:
            self.count("deduped")
            return
        now = time.time()
        self.state["dedup"][key] = now
        event = {
            "id": key,
            "at": iso(now),
            "type": etype,
            "session": self.args.session,
            "task": task["key"] if task else None,
            "pane": task["pane"] if task else None,
            "agent": task["agent"] if task else None,
            "name": task["name"] if task else None,
            "instance": task["instance"] if task else None,
            "status": task["status"] if task else None,
            "needs_human": needs_human,
            "summary": summary,
            "error": error,
        }
        event.update(extra)
        if snapshot is not None and task:
            event["snapshot"] = self.save_snapshot(task, snapshot, key)
        self.events.append(event)
        self.count("detected")
        self.tick_counts.setdefault("types", {}).setdefault(etype, 0)
        self.tick_counts["types"][etype] += 1
        if needs_human:
            self.count("human_judgment")

    def count(self, name: str, n: int = 1) -> None:
        self.counters[name] = self.counters.get(name, 0) + n
        self.tick_counts[name] = self.tick_counts.get(name, 0) + n

    def save_snapshot(self, task: dict, lines: list[str], event_id: str | None = None) -> str:
        base = digest(task["key"])
        name = f"{base}-{event_id}.txt" if event_id else f"{base}.txt"
        write_atomic(os.path.join(self.state_dir, "snapshots", name),
                     "\n".join(lines) + "\n", text=True)
        return name

    # -------------------------------------------------------- outage tracking

    def server_failed(self, code: str) -> None:
        self.count("errors")
        outage = self.state.get("outage")
        if outage is None:
            self.state["outage"] = {"code": code, "since": iso(time.time()),
                                    "episode": digest(f"{code}|{time.time()}")}
            self.emit("herdr_unavailable", None, self.state["outage"]["episode"], error=code)
        else:
            self.count("deduped")

    def server_ok(self) -> None:
        outage = self.state.get("outage")
        if outage is not None:
            self.state["outage"] = None
            self.state["force_discovery"] = True  # Herdr may have restarted; rediscover
            self.emit("herdr_recovered", None, outage["episode"], error=None,
                      after=outage["code"])

    # -------------------------------------------------------- reads

    def read_screen(self, task: dict, final: bool, deadline: float) -> list[str] | None:
        if final:
            # A visible read requests no extra rows, so Herdr never collects history from
            # an idle application.
            command = ("pane", "read", task["pane"], "--source", "visible")
        else:
            command = ("pane", "read", task["pane"], "--source", "recent-unwrapped",
                       "--lines", str(self.args.read_lines))
        code, out = self.herdr.call(*command, deadline=deadline)
        if code is not None:
            if code in SERVER_CODES and code not in TASK_LEVEL_CODES:
                self.server_failed(code)
            elif task.get("read_error") is None:
                self.count("errors")
                task["read_error"] = code
                task["read_error_episode"] = digest(f"{code}|{time.time()}")
                self.emit("read_failed", task, task["read_error_episode"], error=code)
            else:
                self.count("errors")
                self.count("deduped")
            return None
        self.server_ok()
        if task.get("read_error") is not None:
            self.emit("read_recovered", task, task["read_error_episode"],
                      after=task["read_error"])
            task["read_error"] = None
        text = redact(out, self.secrets, self.home)
        del out
        lines = text.splitlines()[-self.args.read_lines:]
        self.save_snapshot(task, lines)
        task["last_read"] = iso(time.time())
        return lines

    # -------------------------------------------------------- discovery and polling

    def discover(self, deadline: float) -> dict[str, dict] | None:
        """Agent metadata by pane ID; None when Herdr could not answer."""
        if self.args.pane:
            found: dict[str, dict] = {}
            for pane in self.args.pane:
                code, out = self.herdr.call("agent", "get", pane, deadline=deadline)
                if code in GONE_CODES:
                    continue
                if code is not None:
                    self.server_failed(code if code in SERVER_CODES else "discovery_failed")
                    return None
                agent = project_agent((parse_json(out) or {}).get("result", {}).get("agent"))
                if agent is None:
                    self.server_failed("malformed_response")
                    return None
                found[agent["pane"]] = agent
            self.server_ok()
            return found
        code, out = self.herdr.call("agent", "list", deadline=deadline)
        if code is not None:
            self.server_failed(code if code in SERVER_CODES else "discovery_failed")
            return None
        agents = (parse_json(out) or {}).get("result", {}).get("agents")
        if not isinstance(agents, list):
            self.server_failed("malformed_response")
            return None
        self.server_ok()
        found = {}
        for raw in agents:
            agent = project_agent(raw)
            if agent is None:
                continue
            if self.args.workspace and not agent["pane"].startswith(self.args.workspace + ":"):
                continue
            found[agent["pane"]] = agent
        return found

    def poll(self, task: dict, deadline: float) -> dict | None:
        code, out = self.herdr.call("agent", "get", task["pane"], deadline=deadline)
        if code in GONE_CODES:
            self.server_ok()
            return {"pane": task["pane"], "status": "gone"}
        if code is not None:
            if code in SERVER_CODES and code not in TASK_LEVEL_CODES:
                self.server_failed(code)
            else:
                self.count("errors")
            return None
        agent = project_agent((parse_json(out) or {}).get("result", {}).get("agent"))
        if agent is None:
            self.count("errors")
            return None
        self.server_ok()
        return agent

    def tick(self) -> int:
        deadline = time.monotonic() + self.args.tick_deadline
        now = time.time()
        tasks: dict = self.state["tasks"]
        observed: set[str] = set()
        last = self.state.get("last_discovery")
        due = (self.state.get("force_discovery") or last is None
               or now - last >= self.args.discovery_interval)
        discovery_ok = None
        if due:
            found = self.discover(deadline)
            discovery_ok = found is not None
            if found is not None:
                self.state["last_discovery"] = now
                self.state["force_discovery"] = False
                for pane, info in sorted(found.items()):
                    self.observe(info, deadline)
                    observed.add(self.task_key(pane))
                for key, task in sorted(tasks.items()):
                    if key not in observed and task["status"] != "gone":
                        self.observe({"pane": task["pane"], "status": "gone"}, deadline)
                        observed.add(key)
        for key, task in sorted(tasks.items()):
            if key in observed or task["status"] not in HOT_STATUSES:
                continue
            info = self.poll(task, deadline)
            if info is not None:
                self.observe(info, deadline)
        if self.state.get("force_discovery") and self.state.get("outage") is None and not due:
            found = self.discover(deadline)  # Herdr came back this tick
            if found is not None:
                self.state["last_discovery"] = time.time()
                self.state["force_discovery"] = False
                for pane, info in sorted(found.items()):
                    self.observe(info, deadline)
        for key in [k for k, t in tasks.items() if t["status"] == "gone"
                    and now - t.get("gone_at", now) > FORGET_GONE_SECONDS]:
            del tasks[key]
        result = EXIT_OK if not self.tick_counts.get("errors") else EXIT_DEGRADED
        self.finish(discovery_ok)
        return result

    def task_key(self, pane: str) -> str:
        return f"{self.args.session}/{pane}"

    # -------------------------------------------------------- one observation

    def observe(self, info: dict, deadline: float) -> None:
        tasks = self.state["tasks"]
        key = self.task_key(info["pane"])
        task = tasks.get(key)
        status = info["status"]

        if status == "gone":
            if task and task["status"] != "gone":
                prev = task["status"]
                task.update(status="gone", hot=False, gone_at=time.time())
                task["blocker"] = None
                task.pop("pending_final", None)
                self.emit("task_gone", task, f"{prev}|gone", prev_status=prev)
            return

        if task is None:
            task = {"key": key, "pane": info["pane"], "agent": info["agent"],
                    "name": info["name"], "instance": info["instance"], "status": status,
                    "seq": info["seq"], "lines": [], "blocker": None, "read_error": None,
                    "first_seen": iso(time.time())}
            tasks[key] = task
            lines = None
            if status in HOT_STATUSES or status == "blocked":
                lines = self.read_screen(task, final=status != "working", deadline=deadline)
                if lines is not None:
                    task["lines"] = lines
            self.emit("task_discovered", task, f"{info['instance']}|{status}",
                      prev_status=None)
            if status == "blocked":
                self.open_blocker(task, lines or [], info["seq"])
                if lines is None:
                    self.mark_pending(task, "blocker")
            task["hot"] = status in HOT_STATUSES
            return

        prev_status = task["status"]
        prev_seq = task.get("seq")
        restarted = info["instance"] != task["instance"]
        changed = status != prev_status or restarted
        task.update(agent=info["agent"], name=info["name"])

        if restarted:
            old = task["instance"]
            task["instance"] = info["instance"]
            self.emit("task_restarted", task, f"{old}->{info['instance']}",
                      prev_status=prev_status, previous_instance=old)
        task["status"] = status
        task["seq"] = info["seq"]
        task["hot"] = status in HOT_STATUSES

        if not changed and status not in HOT_STATUSES:
            seq_moved = info["seq"] is not None and prev_seq is not None and info["seq"] != prev_seq
            if not (status == "blocked" and seq_moved):
                if task.get("pending_final"):
                    self.recover_final(task, deadline)
                return  # unchanged and not running: no event

        final = status not in HOT_STATUSES
        lines = self.read_screen(task, final=final, deadline=deadline)
        fresh: list[str] = []
        if lines is not None:
            fresh = new_lines(task.get("lines") or [], lines)
            task["lines"] = lines
            task.pop("pending_final", None)

        if status == "blocked":
            self.on_blocked(task, lines, fresh, info["seq"], prev_seq, restarted,
                            prev_status)
            if lines is None:
                self.mark_pending(task, "blocker")
            return
        if task.get("blocker"):
            episode = task["blocker"]
            task["blocker"] = None
            self.emit("blocker_resolved", task, episode["id"], prev_status=prev_status,
                      summary=self.summary(fresh), snapshot=lines)
            if status not in READY_STATUSES:
                if lines is None and final:
                    self.mark_pending(task, "blocker_resolved")
                return
        if status != prev_status:
            if status in READY_STATUSES:
                etype = "completed"
            elif status == "working":
                etype = "started"
            else:
                etype = "status_changed"
            self.emit(etype, task, f"{prev_status}->{status}|{info['seq']}|{digest(chr(10).join(fresh))}",
                      prev_status=prev_status, summary=self.summary(fresh),
                      new_lines=len(fresh), snapshot=lines if final else None)
            if lines is None and final:
                self.mark_pending(task, etype)
            return
        if fresh:
            self.emit("output", task, "\n".join(line_key(x) for x in fresh),
                      summary=self.summary(fresh), new_lines=len(fresh))

    def mark_pending(self, task: dict, etype: str) -> None:
        """The final screen of a stopped task could not be read; retry at discovery."""
        task["pending_final"] = {"for": etype, "since": iso(time.time()),
                                 "id": digest(f"{task['key']}|{etype}|{time.time()}")}

    def recover_final(self, task: dict, deadline: float) -> None:
        pending = task["pending_final"]
        lines = self.read_screen(task, final=True, deadline=deadline)
        if lines is None:
            return  # still unreadable; read_failed is logged once per failure episode
        fresh = new_lines(task.get("lines") or [], lines)
        task["lines"] = lines
        del task["pending_final"]
        if pending["for"] == "blocker" and task.get("blocker"):
            task["blocker"]["signature"] = signature(lines)
        self.emit("final_output_recovered", task, pending["id"], recovered_for=pending["for"],
                  summary=self.summary(fresh), new_lines=len(fresh), snapshot=lines)

    def summary(self, lines: list[str]) -> str:
        return summarize(lines, self.args.summary_chars)

    def open_blocker(self, task: dict, lines: list[str], seq: int | None) -> None:
        episode = {"id": digest(f"{task['key']}|{task['instance']}|{seq}|{time.time()}"),
                   "signature": signature(lines), "seq": seq, "opened": iso(time.time())}
        task["blocker"] = episode
        self.emit("blocker", task, episode["id"], needs_human=True,
                  summary=self.summary(lines), snapshot=lines)

    def on_blocked(self, task: dict, lines: list[str] | None, fresh: list[str],
                   seq: int | None, prev_seq: int | None, restarted: bool,
                   prev_status: str) -> None:
        episode = task.get("blocker")
        sig = signature(lines) if lines is not None else None
        if episode is None:
            self.open_blocker(task, lines or [], seq)
            return
        if restarted and sig is not None and sig != episode["signature"]:
            # A restarted agent waiting on a different question is a new blocker.
            self.emit("blocker_resolved", task, episode["id"], prev_status=prev_status,
                      snapshot=lines)
            self.open_blocker(task, lines or [], seq)
            return
        if (not restarted and seq is not None and episode.get("seq") is not None
                and seq != episode["seq"] and prev_status == "blocked"):
            # Herdr saw the agent leave the blocked state and return between our reads.
            self.emit("blocker_resolved", task, episode["id"], prev_status=prev_status,
                      snapshot=lines)
            self.open_blocker(task, lines or [], seq)
            return
        # Same unresolved blocker: churn, formatting, or a watcher/agent restart.
        episode["seq"] = seq if seq is not None else episode.get("seq")
        self.count("deduped")

    # -------------------------------------------------------- tick end

    def finish(self, discovery_ok: bool | None) -> None:
        self.counters["ticks"] = self.counters.get("ticks", 0) + 1
        dedup = self.state["dedup"]
        if len(dedup) > DEDUP_KEEP:
            for key, _ in sorted(dedup.items(), key=lambda kv: kv[1])[: len(dedup) - DEDUP_KEEP]:
                del dedup[key]
        append_lines(os.path.join(self.state_dir, "events.jsonl"), self.events)
        write_atomic(self.state_path, self.state)
        tasks = self.state["tasks"]
        heartbeat = {
            "at": iso(time.time()),
            "session": self.args.session,
            "ok": not self.tick_counts.get("errors"),
            "discovery": discovery_ok,
            "last_discovery": iso(self.state["last_discovery"])
            if self.state.get("last_discovery") else None,
            "outage": self.state.get("outage"),
            "tasks": len(tasks),
            "hot": sum(1 for t in tasks.values() if t.get("hot")),
            "open_blockers": sum(1 for t in tasks.values() if t.get("blocker")),
            "tick": {k: v for k, v in self.tick_counts.items()},
            "counters": dict(self.counters),
        }
        write_atomic(os.path.join(self.state_dir, "heartbeat.json"), heartbeat)
        types = ",".join(f"{k}:{v}" for k, v in sorted(self.tick_counts.get("types", {}).items()))
        print(f"watch: tick={self.counters['ticks']} events={self.tick_counts.get('detected', 0)} "
              f"deduped={self.tick_counts.get('deduped', 0)} "
              f"human={self.tick_counts.get('human_judgment', 0)} "
              f"errors={self.tick_counts.get('errors', 0)} tasks={heartbeat['tasks']} "
              f"hot={heartbeat['hot']} types={types or '-'}", flush=True)
        self.events = []
        self.tick_counts = {}


def iso(ts: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


# ---------------------------------------------------------------- entry point


def positive(text: str) -> float:
    value = float(text)
    if not value > 0:
        raise argparse.ArgumentTypeError("must be positive")
    return value


def pane_id(text: str) -> str:
    if not PANE_ID_RE.match(text):
        raise argparse.ArgumentTypeError("a Herdr pane ID such as w1:p1")
    return text


def session_name(text: str) -> str:
    if not SESSION_RE.match(text):
        raise argparse.ArgumentTypeError("a Herdr session name")
    return text


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Log-only, read-only Herdr pane watcher.")
    p.add_argument("--state-dir", default=os.environ.get("CLI_WATCHERS_STATE_DIR"),
                   help="private state directory (or CLI_WATCHERS_STATE_DIR); required")
    p.add_argument("--session", type=session_name, required=True,
                   help="Herdr session to read, passed as `herdr --session`")
    p.add_argument("--herdr", default=os.environ.get("HERDR_BIN") or "herdr")
    p.add_argument("--pane", type=pane_id, action="append",
                   help="watch only this pane (repeatable); discovery uses `agent get`")
    p.add_argument("--workspace", help="watch only panes of this workspace ID")
    p.add_argument("--interval", type=positive, default=20.0,
                   help="seconds between ticks in a multi-tick run")
    p.add_argument("--discovery-interval", type=positive, default=300.0,
                   help="seconds between full discoveries")
    p.add_argument("--timeout", type=positive, default=15.0, help="seconds per Herdr call")
    p.add_argument("--tick-deadline", type=positive, default=60.0, help="seconds per tick")
    p.add_argument("--read-lines", type=int, default=120, help="rows per running-pane read")
    p.add_argument("--summary-chars", type=int, default=600)
    runs = p.add_mutually_exclusive_group()
    runs.add_argument("--once", action="store_true", help="run one tick (the default)")
    runs.add_argument("--ticks", type=int, help="run this many ticks, `--interval` apart")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if not args.state_dir:
        print("watch: --state-dir or CLI_WATCHERS_STATE_DIR is required", file=sys.stderr)
        return EXIT_CONFIG
    if args.read_lines < 10 or args.read_lines > 2000 or args.summary_chars < 40:
        print("watch: --read-lines must be 10-2000 and --summary-chars at least 40",
              file=sys.stderr)
        return EXIT_CONFIG
    os.umask(0o077)
    state_dir = os.path.abspath(args.state_dir)
    try:
        prepare_state_dir(state_dir)
    except UnsafePath as exc:
        print(f"watch: unsafe state path: {exc}", file=sys.stderr)
        return EXIT_CONFIG
    lock = acquire_lock(state_dir)
    if lock is None:
        print("watch: another watcher holds the lock; nothing written", file=sys.stderr)
        return EXIT_BUSY
    try:
        watcher = Watcher(args, state_dir)
        ticks = args.ticks if args.ticks else 1
        result = EXIT_OK
        for i in range(ticks):
            if i:
                time.sleep(args.interval)
            result = max(result, watcher.tick())
        return result
    finally:
        os.close(lock)


if __name__ == "__main__":
    sys.exit(main())
