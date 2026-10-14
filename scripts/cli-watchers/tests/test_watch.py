"""Behavior tests for watch.py: real subprocess runs against a fake Herdr CLI."""

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WATCH = os.path.join(ROOT, "watch.py")
FAKE = os.path.join(HERE, "fake_herdr.py")
sys.path.insert(0, ROOT)
import watch  # noqa: E402

READ_ONLY = {("agent", "list"), ("agent", "get"), ("pane", "read")}
EMAIL = "someone.private@example.test"
API_KEY = "sk-ant-api03-" + "Q" * 40
ENV_SECRET = "envsecret-7f3a9c1d2e"
FOOTER = ["", "╭──────────────╮", "│ >            │", "╰──────────────╯", "  ? for shortcuts"]


def screen(body, timer=12, spinner="✻"):
    return "\n".join(list(body) + [f"{spinner} Working… ({timer}s · esc to interrupt)"] + FOOTER)


def agent(pane="w1:p1", status="working", body=("hello",), seq=1, terminal="term_a1",
          session="11111111-1111-1111-1111-111111111111", name="impl", kind="codex",
          visible=None, **screen_args):
    a = {"pane_id": pane, "agent": kind, "name": name, "agent_status": status,
         "terminal_id": terminal, "session": session, "state_change_seq": seq,
         "screen": screen(body, **screen_args)}
    if visible is not None:
        a["visible"] = visible
    return a


QUESTION = ["Allow command `rm -rf build`?", "  1. Yes", "  2. No, and tell Codex what to do"]


class Harness:
    def __init__(self, tmp):
        self.tmp = tmp
        self.state = os.path.join(tmp, "state")
        self.log = os.path.join(tmp, "calls.jsonl")
        self.spec = os.path.join(tmp, "spec.json")
        self.bin = os.path.join(tmp, "herdr")
        with open(self.bin, "w") as f:
            f.write(f'#!/bin/sh\nexec "{sys.executable}" -B "{FAKE}" "$@"\n')
        os.chmod(self.bin, 0o755)

    def scenario(self, agents, **extra):
        with open(self.spec, "w") as f:
            json.dump(dict({"log": self.log, "session": "test", "agents": agents}, **extra), f)

    def command(self, *args, discovery=3600):
        return [sys.executable, "-B", WATCH, "--state-dir", self.state, "--session", "test",
                "--herdr", self.bin, "--discovery-interval", str(discovery),
                "--timeout", "2", *args]

    def env(self):
        env = dict(os.environ, FAKE_HERDR_SPEC=self.spec, FAKE_SERVICE_TOKEN=ENV_SECRET)
        env.pop("CLI_WATCHERS_STATE_DIR", None)
        return env

    def run(self, *args, discovery=3600, timeout=60):
        return subprocess.run(self.command(*args, discovery=discovery), env=self.env(),
                              capture_output=True, text=True, timeout=timeout)

    def calls(self):
        if not os.path.exists(self.log):
            return []
        with open(self.log) as f:
            return [json.loads(line)["argv"] for line in f]

    def reset_calls(self):
        if os.path.exists(self.log):
            os.unlink(self.log)

    def events(self):
        path = os.path.join(self.state, "events.jsonl")
        if not os.path.exists(path):
            return []
        with open(path) as f:
            return [json.loads(line) for line in f]

    def types(self):
        return [e["type"] for e in self.events()]

    def read_json(self, name):
        with open(os.path.join(self.state, name)) as f:
            return json.load(f)

    def task(self, pane="w1:p1"):
        return self.read_json("state.json")["tasks"][f"test/{pane}"]

    def all_output_text(self):
        chunks = []
        for root, _, files in os.walk(self.state):
            for name in files:
                with open(os.path.join(root, name), errors="replace") as f:
                    chunks.append(f.read())
        return "\n".join(chunks)


class WatcherTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="watch-test-")
        self.h = Harness(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def assert_read_only(self):
        for argv in self.h.calls():
            self.assertEqual(argv[:2], ["--session", "test"], argv)
            self.assertIn(tuple(argv[2:4]), READ_ONLY, argv)

    def ok(self, result):
        self.assertIn(result.returncode, (0, 1), result.stderr)
        return result

    # ------------------------------------------------------------ change detection

    def test_unchanged_checks_emit_nothing_and_only_read(self):
        self.h.scenario([agent(body=["build started", "compiling"])])
        self.ok(self.h.run())
        self.assertEqual(self.h.types(), ["task_discovered"])
        for timer, spinner in ((13, "✶"), (14, "✳"), (15, "·")):
            self.h.scenario([agent(body=["build started", "compiling"], timer=timer,
                                   spinner=spinner)])
            r = self.ok(self.h.run())
            self.assertIn("events=0", r.stdout)
        self.assertEqual(self.h.types(), ["task_discovered"])
        self.assert_read_only()
        beat = self.h.read_json("heartbeat.json")
        self.assertEqual(beat["counters"]["ticks"], 4)
        self.assertEqual(beat["counters"]["detected"], 1)
        self.assertEqual(beat["tick"].get("detected", 0), 0)

    def test_running_tasks_are_polled_and_others_wait_for_discovery(self):
        self.h.scenario([agent("w1:p1", "working"), agent("w1:p2", "idle", terminal="term_b"),
                         agent("w1:p3", "done", terminal="term_c")])
        self.ok(self.h.run())
        self.h.reset_calls()
        self.ok(self.h.run())
        calls = self.h.calls()
        self.assertEqual({tuple(c[2:5]) for c in calls},
                         {("agent", "get", "w1:p1"), ("pane", "read", "w1:p1")})
        self.assertTrue(self.h.task("w1:p1")["hot"])
        self.assertFalse(self.h.task("w1:p2")["hot"])

    def test_completion_captures_final_text_and_leaves_the_hot_set(self):
        self.h.scenario([agent(body=["step 1"], seq=1)])
        self.ok(self.h.run())
        final = "\n".join(["step 1", "All 42 tests passed", "Wrote report.md"] + FOOTER)
        self.h.scenario([agent(status="done", body=["step 1"], seq=2, visible=final)])
        self.ok(self.h.run())
        done = [e for e in self.h.events() if e["type"] == "completed"]
        self.assertEqual(len(done), 1)
        self.assertEqual(done[0]["prev_status"], "working")
        self.assertIn("All 42 tests passed", done[0]["summary"])
        self.assertIn("Wrote report.md", done[0]["summary"])
        self.assertNotIn("step 1", done[0]["summary"])
        snap = os.path.join(self.h.state, "snapshots", done[0]["snapshot"])
        with open(snap) as f:
            self.assertIn("Wrote report.md", f.read())
        self.assertFalse(self.h.task()["hot"])
        visible_reads = [c for c in self.h.calls() if c[2:4] == ["pane", "read"]
                         and "visible" in c]
        self.assertEqual(len(visible_reads), 1)
        self.h.reset_calls()
        self.ok(self.h.run())
        self.assertEqual(self.h.calls(), [])  # nothing running, discovery not due

    def test_discovery_runs_on_its_own_interval_and_finds_new_tasks(self):
        self.h.scenario([agent("w1:p1", "idle")])
        self.ok(self.h.run(discovery=0.5))
        self.h.scenario([agent("w1:p1", "idle"), agent("w2:p1", "working", terminal="term_z")])
        self.h.reset_calls()
        self.ok(self.h.run(discovery=0.5))
        self.assertFalse([c for c in self.h.calls() if c[2:4] == ["agent", "list"]])
        time.sleep(0.6)
        self.ok(self.h.run(discovery=0.5))
        self.assertEqual(len([c for c in self.h.calls() if c[2:4] == ["agent", "list"]]), 1)
        found = [e for e in self.h.events() if e["type"] == "task_discovered"]
        self.assertEqual([e["pane"] for e in found], ["w1:p1", "w2:p1"])

    def test_meaningful_value_changes_in_output_are_new_content(self):
        cases = [("Disk usage: 10%", "Disk usage: 99%"),
                 ("Build finished in 12s", "Build finished in 95s"),
                 ("Downloaded 1.2k files", "Downloaded 3.4k files"),
                 ("Memory 512M of 2048M", "Memory 1900M of 2048M"),
                 ("[12:01] deploy ok", "[12:07] deploy failed"),
                 ("-10 requests", "+10 requests"),
                 ("- removed line", "+ removed line"),
                 ("✓ 12 passed", "✗ 12 passed")]
        for before, after in cases:
            self.assertEqual(watch.new_lines([before], [after]), [after], (before, after))
        # Chrome still redraws without counting as content.
        chrome = [("✻ Working… (12s · esc to interrupt)", "✶ Working… (1m 3s · esc to interrupt)"),
                  ("· Thinking… (40s · ↓ 2.1k tokens · esc to interrupt)",
                   "✳ Thinking… (41s · ↓ 2.4k tokens · esc to interrupt)"),
                  ("  Context left until auto-compact: 41%", "  Context left until auto-compact: 39%")]
        for before, after in chrome:
            self.assertEqual(watch.new_lines([before], [after]), [], (before, after))

    def test_rolling_output_reports_only_new_lines(self):
        first = [f"log line {i:03d}" for i in range(100)]
        self.h.scenario([agent(body=first)])
        self.ok(self.h.run("--read-lines", "120"))
        second = [f"log line {i:03d}" for i in range(20, 125)]
        self.h.scenario([agent(body=second, timer=40)])
        self.ok(self.h.run("--read-lines", "120"))
        out = [e for e in self.h.events() if e["type"] == "output"]
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["new_lines"], 25)
        self.assertIn("log line 124", out[0]["summary"])
        self.assertNotIn("log line 099", out[0]["summary"])
        self.assertLessEqual(len(out[0]["summary"].splitlines()), watch.SUMMARY_LINES)
        self.assertLessEqual(len(out[0]["summary"]), 600)

    def test_identical_output_is_deduplicated(self):
        self.h.scenario([agent(body=["a"])])
        self.ok(self.h.run())
        self.h.scenario([agent(body=["a", "retrying"])])
        self.ok(self.h.run())
        self.h.scenario([agent(body=["a"])])
        self.ok(self.h.run())
        self.h.scenario([agent(body=["a", "retrying"])])
        r = self.ok(self.h.run())
        self.assertEqual(self.h.types().count("output"), 1)
        self.assertIn("deduped=1", r.stdout)

    # ------------------------------------------------------------ blockers

    def test_unresolved_blocker_is_reported_once_across_churn_and_restarts(self):
        self.h.scenario([agent(status="blocked", body=QUESTION, seq=5)])
        self.ok(self.h.run(discovery=0.01))
        churn = [QUESTION + ["(press ? for help)"], ["Context left 41%"] + QUESTION]
        for body in churn:
            self.h.scenario([agent(status="blocked", body=body, seq=5, timer=99)])
            self.ok(self.h.run(discovery=0.01))
        # The agent process restarts and shows the same question again.
        self.h.scenario([agent(status="blocked", body=QUESTION, seq=1, terminal="term_new",
                               session="22222222-2222-2222-2222-222222222222")])
        self.ok(self.h.run(discovery=0.01))
        types = self.h.types()
        self.assertEqual(types.count("blocker"), 1, types)
        self.assertEqual(types.count("task_restarted"), 1)
        blocker = [e for e in self.h.events() if e["type"] == "blocker"][0]
        self.assertTrue(blocker["needs_human"])
        self.assertIn("Allow command", blocker["summary"])
        beat = self.h.read_json("heartbeat.json")
        self.assertEqual(beat["counters"]["human_judgment"], 1)
        self.assertGreaterEqual(beat["counters"]["deduped"], 1)
        self.assertEqual(beat["open_blockers"], 1)

    def test_blocked_task_that_finishes_logs_resolution_and_completion(self):
        for final in ("done", "idle"):
            with self.subTest(final=final):
                self.h.reset_calls()
                shutil.rmtree(self.h.state, ignore_errors=True)
                self.h.scenario([agent(status="blocked", body=QUESTION, seq=5)])
                self.ok(self.h.run(discovery=0.01))
                visible = "\n".join(QUESTION + ["  1. Yes", "Removed build/", "Task complete"])
                self.h.scenario([agent(status=final, body=QUESTION, seq=8, visible=visible)])
                self.ok(self.h.run(discovery=0.01))
                self.ok(self.h.run(discovery=0.01))
                self.assertEqual(self.h.types(), ["task_discovered", "blocker",
                                                  "blocker_resolved", "completed"])
                done = self.h.events()[-1]
                self.assertEqual(done["prev_status"], "blocked")
                self.assertIn("Task complete", done["summary"])

    def test_resolution_and_new_blocker_are_both_reported(self):
        self.h.scenario([agent(status="blocked", body=QUESTION, seq=5)])
        self.ok(self.h.run(discovery=0.01))
        self.h.scenario([agent(status="working", body=QUESTION + ["running rm"], seq=6)])
        self.ok(self.h.run(discovery=0.01))
        self.h.scenario([agent(status="blocked", body=QUESTION, seq=7)])
        self.ok(self.h.run(discovery=0.01))
        # Missed the working state in between: Herdr's state sequence moved.
        self.h.scenario([agent(status="blocked", body=["Apply patch?", "  1. Yes"], seq=9)])
        self.ok(self.h.run(discovery=0.01))
        self.assertEqual(
            [t for t in self.h.types() if t.startswith("blocker")],
            ["blocker", "blocker_resolved", "blocker", "blocker_resolved", "blocker"])
        self.assertEqual(self.h.read_json("heartbeat.json")["counters"]["human_judgment"], 3)

    def test_distinct_tasks_with_the_same_question_each_get_an_event(self):
        self.h.scenario([agent("w1:p1", "blocked", QUESTION),
                         agent("w1:p2", "blocked", QUESTION, terminal="term_b")])
        self.ok(self.h.run())
        blockers = [e for e in self.h.events() if e["type"] == "blocker"]
        self.assertEqual(sorted(e["pane"] for e in blockers), ["w1:p1", "w1:p2"])
        self.assertNotEqual(blockers[0]["id"], blockers[1]["id"])

    # ------------------------------------------------------------ failures

    def test_discovery_outage_keeps_tasks_and_recovers_after_service_restart(self):
        self.h.scenario([agent(body=["working on it"])])
        self.ok(self.h.run(discovery=0.01))
        down = {"*": {"exit": 1, "code": "server_not_running", "message": EMAIL}}
        for _ in range(2):
            self.h.scenario([agent(body=["working on it"])], fail=down)
            r = self.h.run(discovery=0.01)
            self.assertEqual(r.returncode, 1)
            beat = self.h.read_json("heartbeat.json")
            self.assertEqual(beat["discovery"], False)
            self.assertEqual(beat["outage"]["code"], "server_not_running")
        self.assertEqual(self.h.types().count("herdr_unavailable"), 1)
        self.assertEqual(self.h.task()["status"], "working")
        self.assertNotIn("task_gone", self.h.types())
        self.assertNotIn("completed", self.h.types())
        # Herdr restarted: same pane, new terminal and agent session.
        self.h.scenario([agent(body=["working on it", "resumed"], terminal="term_b2",
                               session="33333333-3333-3333-3333-333333333333")])
        r = self.ok(self.h.run(discovery=0.01))
        self.assertEqual(r.returncode, 0)
        types = self.h.types()
        self.assertEqual(types.count("herdr_recovered"), 1)
        self.assertEqual(types.count("task_restarted"), 1)
        self.assertIsNone(self.h.read_json("heartbeat.json")["outage"])
        self.assert_private(r)

    def test_read_timeout_and_errors_are_bounded_and_recover(self):
        self.h.scenario([agent(body=["x"])])
        self.ok(self.h.run())
        self.h.scenario([agent(body=["x", "y"])], sleep={"pane read": 5})
        start = time.monotonic()
        r = self.h.run()
        self.assertLess(time.monotonic() - start, 4.5)
        self.assertEqual(r.returncode, 1)
        self.h.scenario([agent(body=["x", "y"])],
                        fail={"pane read w1:p1": {"code": "weird_failure", "message": API_KEY}})
        self.assertEqual(self.h.run().returncode, 1)
        failed = [e for e in self.h.events() if e["type"] == "read_failed"]
        self.assertEqual([e["error"] for e in failed], ["timeout"])
        self.h.scenario([agent(body=["x", "y"])])
        self.ok(self.h.run())
        self.assertEqual(self.h.types()[-2:], ["read_recovered", "output"])
        self.assertNotIn("weird_failure", self.h.all_output_text())
        self.assert_private(r)

    def test_tick_deadline_bounds_a_tick(self):
        self.h.scenario([agent(f"w1:p{i}", "working", terminal=f"term_{i}") for i in range(1, 6)])
        self.ok(self.h.run())
        self.h.scenario([agent(f"w1:p{i}", "working", terminal=f"term_{i}") for i in range(1, 6)],
                        sleep={"agent get": 0.8})
        start = time.monotonic()
        self.h.run("--tick-deadline", "2")
        self.assertLess(time.monotonic() - start, 5)
        self.assertTrue(os.path.exists(os.path.join(self.h.state, "heartbeat.json")))

    def test_explicit_panes_never_touch_other_panes(self):
        self.h.scenario([agent("w1:p1", "working"), agent("w1:p2", "working", terminal="term_b"),
                         agent("w9:p1", "working", terminal="term_c")])
        for _ in range(3):
            self.ok(self.h.run("--pane", "w1:p1", discovery=0.01))
        for argv in self.h.calls():
            self.assertNotEqual(argv[2:4], ["agent", "list"])
            self.assertEqual(argv[4], "w1:p1")
        self.h.scenario([agent("w1:p2", "working", terminal="term_b")])
        self.ok(self.h.run("--pane", "w1:p1", discovery=0.01))
        self.assertEqual(self.h.types(), ["task_discovered", "task_gone"])
        self.assert_read_only()

    # ------------------------------------------------------------ privacy and files

    def assert_private(self, result=None):
        text = self.h.all_output_text()
        if result is not None:
            text += result.stdout + result.stderr
        for needle in (EMAIL, API_KEY, ENV_SECRET, "hunter2pass", "abcdef0123456789secret",
                       "/fixture/private/project", "private title"):
            self.assertNotIn(needle, text)

    def test_private_key_blocks_are_removed_whole(self):
        body = ["MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", "SYNTHETIC-KEY-BODY-DO-NOT-USE",
                "SYNTHETIC-KEY-BODY-DO-NOT-USE-2"]
        full = (["before"] + ["\x1b[33m-----BEGIN RSA PRIVATE KEY-----\x1b[0m"] + body
                + ["-----END RSA PRIVATE KEY-----", "after the key"])
        self.assertNotIn("SYNTHETIC", watch.redact("\n".join(full), [], None))
        self.assertIn("after the key", watch.redact("\n".join(full), [], None))
        truncated = ["-----BEGIN OPENSSH PRIVATE KEY-----"] + body  # rest not on screen yet
        headless = body + ["-----END PRIVATE KEY-----", "done"]  # header scrolled away
        self.assertNotIn("SYNTHETIC", watch.redact("\n".join(truncated), [], None))
        self.assertNotIn("SYNTHETIC", watch.redact("\n".join(headless), [], None))
        self.h.scenario([agent(body=["start"])])
        self.ok(self.h.run())
        self.h.scenario([agent(body=["start"] + full)])
        r1 = self.ok(self.h.run())
        self.h.scenario([agent(status="done", body=["start"] + full, seq=2,
                               visible="\n".join(truncated))])
        r2 = self.ok(self.h.run())
        self.assertIn("output", self.h.types())
        self.assertIn("completed", self.h.types())
        text = self.h.all_output_text() + r1.stdout + r2.stdout + r1.stderr + r2.stderr
        self.assertNotIn("SYNTHETIC-KEY-BODY", text)
        self.assertNotIn("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", text)

    def test_final_text_lost_to_an_outage_is_recovered_once_at_discovery(self):
        self.h.scenario([agent(body=["step 1"], seq=1)])
        self.ok(self.h.run(discovery=3600))
        visible = "\n".join(["step 1", "RESULT: 7 files changed"])
        down = {"pane read w1:p1": {"code": "server_not_running"}}
        self.h.scenario([agent(status="done", body=["step 1"], seq=2, visible=visible)],
                        fail=down)
        self.h.run(discovery=3600)
        self.assertFalse(self.h.task()["hot"])
        self.h.scenario([agent(status="done", body=["step 1"], seq=2, visible=visible)])
        for _ in range(3):  # recovery, then unchanged discoveries
            self.ok(self.h.run(discovery=0.01))
        self.assertEqual(self.h.types(), ["task_discovered", "herdr_unavailable", "completed",
                                          "herdr_recovered", "final_output_recovered"])
        rec = self.h.events()[-1]
        self.assertEqual(rec["recovered_for"], "completed")
        self.assertIn("RESULT: 7 files changed", rec["summary"])
        self.assertTrue(rec["snapshot"])
        self.assertIn("RESULT: 7 files changed", "\n".join(self.h.task()["lines"]))
        self.assertFalse(self.h.task()["hot"])
        self.assertNotIn("pending_final", self.h.task())

    def test_final_text_lost_to_a_read_timeout_is_recovered_once(self):
        self.h.scenario([agent(body=["step 1"], seq=1)])
        self.ok(self.h.run(discovery=3600))
        visible = "\n".join(["step 1"] + QUESTION)
        self.h.scenario([agent(status="blocked", body=["step 1"], seq=2, visible=visible)],
                        sleep={"pane read": 5})
        self.h.run(discovery=3600)
        self.h.scenario([agent(status="blocked", body=["step 1"], seq=2, visible=visible)])
        self.h.reset_calls()
        self.ok(self.h.run(discovery=3600))
        self.assertEqual(self.h.calls(), [])  # not hot: waits for discovery
        for _ in range(3):
            self.ok(self.h.run(discovery=0.01))
        self.assertEqual(self.h.types(), ["task_discovered", "read_failed", "blocker",
                                          "read_recovered", "final_output_recovered"])
        rec = self.h.events()[-1]
        self.assertEqual(rec["recovered_for"], "blocker")
        self.assertIn("Allow command", rec["summary"])
        self.assertEqual(self.h.read_json("heartbeat.json")["counters"]["human_judgment"], 1)

    def test_secrets_are_redacted_in_snapshots_state_events_and_heartbeat(self):
        leaks = [f"contact {EMAIL}", f"export ANTHROPIC_API_KEY={API_KEY}",
                 "Authorization: Bearer abcdef0123456789secret", "password = hunter2pass",
                 f"got {ENV_SECRET} from env", f"key {API_KEY}"]
        self.h.scenario([agent(body=["start"])])
        self.ok(self.h.run())
        self.h.scenario([agent(body=["start"] + leaks)])
        r = self.ok(self.h.run())
        self.h.scenario([agent(status="blocked", body=leaks + QUESTION, seq=4)])
        r2 = self.ok(self.h.run(discovery=0.01))
        self.assertIn("output", self.h.types())
        self.assertIn("[REDACTED]", self.h.all_output_text())
        self.assert_private(r)
        self.assert_private(r2)

    def test_concurrent_watchers_are_refused_without_writes(self):
        self.h.scenario([agent()], sleep={"agent list": 1})
        first = subprocess.Popen(self.h.command(), env=self.h.env(), stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True)
        deadline = time.monotonic() + 10
        while not os.path.exists(self.h.log) and time.monotonic() < deadline:
            time.sleep(0.05)
        second = self.h.run()
        first.communicate(timeout=30)
        self.assertEqual(second.returncode, watch.EXIT_BUSY)
        self.assertIn("lock", second.stderr)
        self.assertEqual(self.h.read_json("heartbeat.json")["counters"]["ticks"], 1)
        self.assertEqual(len(self.h.calls()), 2)  # first watcher's list and read only

    def test_files_are_private_including_reused_paths(self):
        os.makedirs(os.path.join(self.h.state, "snapshots"))
        os.chmod(self.h.state, 0o755)
        os.chmod(os.path.join(self.h.state, "snapshots"), 0o755)
        old = '{"type":"earlier"}\n'
        with open(os.path.join(self.h.state, "events.jsonl"), "w") as f:
            f.write(old)
        os.chmod(os.path.join(self.h.state, "events.jsonl"), 0o644)
        self.h.scenario([agent()])
        self.ok(self.h.run())
        self.assertEqual(self.h.events()[0], {"type": "earlier"})
        for root, dirs, files in os.walk(self.h.state):
            self.assertEqual(stat.S_IMODE(os.stat(root).st_mode), 0o700, root)
            for name in files:
                mode = stat.S_IMODE(os.stat(os.path.join(root, name)).st_mode)
                self.assertEqual(mode, 0o600, name)

    def test_symlinked_state_file_is_rejected(self):
        os.makedirs(self.h.state)
        target = os.path.join(self.tmp, "outside.jsonl")
        with open(target, "w") as f:
            f.write("keep\n")
        os.symlink(target, os.path.join(self.h.state, "events.jsonl"))
        self.h.scenario([agent()])
        r = self.h.run()
        self.assertEqual(r.returncode, watch.EXIT_CONFIG)
        self.assertEqual(self.h.calls(), [])
        with open(target) as f:
            self.assertEqual(f.read(), "keep\n")

    def test_session_is_required_and_passed_explicitly(self):
        r = subprocess.run([sys.executable, "-B", WATCH, "--state-dir", self.h.state,
                            "--herdr", self.h.bin], env=self.h.env(), capture_output=True,
                           text=True, timeout=30)
        self.assertEqual(r.returncode, 2)
        self.h.scenario([agent()], session="other")
        r = self.h.run()
        self.assertEqual(r.returncode, 1)
        self.assertEqual(self.h.types(), ["herdr_unavailable"])

    def test_only_read_only_commands_can_run(self):
        herdr = watch.Herdr("herdr", "test", 1, {})
        for verb in (("agent", "prompt"), ("pane", "send-text"), ("agent", "send-keys"),
                     ("pane", "run"), ("agent", "start"), ("server", "stop")):
            with self.assertRaises(ValueError):
                herdr.call(*verb, "w1:p1", deadline=time.monotonic() + 5)


class LaunchdTemplateTest(unittest.TestCase):
    def test_rendered_template_is_a_valid_one_shot_job(self):
        import plistlib

        path = os.path.join(ROOT, "launchd", "local.cli-watchers.watch.plist.template")
        with open(path) as f:
            text = f.read()
        values = {"@LABEL@": "local.cli-watchers.watch", "@PYTHON@": "/usr/bin/python3",
                  "@WATCH_PY@": "/opt/src/scripts/cli-watchers/watch.py",
                  "@STATE_DIR@": "/opt/state/watch", "@SESSION@": "default",
                  "@HERDR@": "/opt/bin/herdr", "@START_INTERVAL@": "30",
                  "@DISCOVERY_INTERVAL@": "300", "@PATH@": "/usr/bin:/bin"}
        for k, v in values.items():
            text = text.replace(k, v)
        self.assertNotIn("@", text)
        job = plistlib.loads(text.encode())
        self.assertEqual(job["StartInterval"], 30)
        self.assertNotIn("KeepAlive", job)
        self.assertFalse(job.get("RunAtLoad", False))
        args = job["ProgramArguments"]
        self.assertIn("--once", args)
        self.assertEqual(args[args.index("--session") + 1], "default")


if __name__ == "__main__":
    unittest.main()
