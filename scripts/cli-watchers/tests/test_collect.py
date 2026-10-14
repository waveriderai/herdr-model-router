"""Behavior tests for collect.py: real subprocess runs against a fake CodexBar CLI."""

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
COLLECT = os.path.join(os.path.dirname(HERE), "collect.py")
FAKE = os.path.join(HERE, "fake_codexbar.py")
sys.path.insert(0, os.path.dirname(HERE))
import collect  # noqa: E402

NOW = "2026-10-14T12:00:00Z"
LATER = "2026-10-14T12:05:00Z"
RESET_A = "2026-10-14T17:00:00Z"
RESET_B = "2026-10-14T22:00:00Z"
EMAIL_1 = "first.person@example.test"
EMAIL_2 = "second.person@example.test"
SECRET = "SECRET-TOKEN-8c1f"


def window(used, resets=RESET_A, minutes=300):
    return {"usedPercent": used, "resetsAt": resets, "windowMinutes": minutes,
            "resetDescription": "in 5h"}


def entry(provider, email=EMAIL_1, updated=NOW, extra=None, **slots):
    usage = {"updatedAt": updated, "accountEmail": email, "loginMethod": "Pro",
             "identity": {"accountEmail": email, "providerID": provider}}
    for slot in ("primary", "secondary", "tertiary"):
        usage[slot] = slots.get(slot)
    if extra is not None:
        usage["extraRateWindows"] = extra
    return {"provider": provider, "source": "web", "usage": usage,
            "rateWindowLabels": {"primary": "Session", "secondary": "Weekly",
                                 "tertiary": "Monthly"}}


def grok_bot(used, resets=RESET_B):
    return {"id": "cursor-grok-bot", "title": "Grok Bot",
            "window": {"usedPercent": used, "resetsAt": resets, "windowMinutes": 10080}}


class Harness:
    def __init__(self, tmp):
        self.tmp = tmp
        self.state = os.path.join(tmp, "state")
        self.log = os.path.join(tmp, "calls.jsonl")
        self.spec = os.path.join(tmp, "spec.json")
        self.bin = os.path.join(tmp, "codexbar")
        with open(self.bin, "w") as f:
            f.write(f'#!/bin/sh\nexec "{sys.executable}" -B "{FAKE}" "$@"\n')
        os.chmod(self.bin, 0o755)

    def scenario(self, providers, **extra):
        with open(self.spec, "w") as f:
            json.dump(dict({"log": self.log, "providers": providers}, **extra), f)

    def command(self, *args, now=NOW, providers=None):
        cmd = [sys.executable, "-B", COLLECT, "--state-dir", self.state,
               "--codexbar", self.bin, "--now", now]
        if providers:
            cmd += ["--providers", ",".join(providers)]
        return cmd + list(args)

    def env(self):
        env = dict(os.environ, FAKE_CODEXBAR_SPEC=self.spec)
        env.pop("HMR_USAGE_DIR", None)
        return env

    def run(self, *args, now=NOW, providers=None, timeout=60):
        return subprocess.run(self.command(*args, now=now, providers=providers),
                              env=self.env(), capture_output=True, text=True,
                              timeout=timeout)

    def latest(self):
        with open(os.path.join(self.state, "usage.json")) as f:
            return json.load(f)

    def history(self):
        path = os.path.join(self.state, "history.jsonl")
        if not os.path.exists(path):
            return []
        with open(path) as f:
            return [json.loads(line) for line in f]

    def calls(self):
        with open(self.log) as f:
            return [json.loads(line) for line in f]

    def meter(self, provider, meter, account=None):
        found = [m for m in self.latest()["meters"]
                 if m["provider"] == provider and m["meter"] == meter
                 and (account is None or m["account"] == account)]
        assert len(found) == 1, (provider, meter, found)
        return found[0]

    def all_output_text(self):
        chunks = []
        for name in os.listdir(self.state):
            if name == "account.key":
                continue
            with open(os.path.join(self.state, name), errors="replace") as f:
                chunks.append(f.read())
        return "\n".join(chunks)


class CollectorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="collect-test-")
        self.h = Harness(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def assert_private(self, text_out):
        for needle in (EMAIL_1, EMAIL_2, SECRET, "first.person", "second.person"):
            self.assertNotIn(needle, text_out)

    # ------------------------------------------------------------ fields and meters

    def test_projects_all_windows_and_keeps_grok_bot_apart_from_grok(self):
        self.h.scenario({
            "cursor": {"stdout": [entry("cursor", primary=window(10), secondary=window(20),
                                        tertiary=window(30), extra=[grok_bot(42.5)])]},
            "grok": {"stdout": [entry("grok", primary=window(7))]},
        })
        r = self.h.run(providers=["cursor", "grok"])
        self.assertEqual(r.returncode, 0, r.stderr)
        bot = self.h.meter("cursor", "cursor-grok-bot")
        self.assertEqual(bot["kind"], "extra")
        self.assertEqual(bot["used_pct"], 42.5)
        self.assertEqual(bot["resets_at"], RESET_B)
        self.assertEqual(bot["provider_updated"], NOW)
        self.assertEqual(bot["collected_at"], NOW)
        self.assertIsNone(bot["error"])
        self.assertFalse(bot["stale"])
        self.assertRegex(bot["account"], r"^acct-[0-9a-f]{12}$")
        for slot, used in (("primary", 10), ("secondary", 20), ("tertiary", 30)):
            self.assertEqual(self.h.meter("cursor", slot)["used_pct"], used)
        self.assertEqual(self.h.meter("grok", "primary")["used_pct"], 7)
        self.assertNotEqual(self.h.meter("grok", "primary")["account"], bot["account"])
        rows = self.h.latest()["rows"]
        self.assertNotIn("cursor-grok-bot", [row["meter"] for row in rows])
        self.assertEqual(len(rows), 4)
        self.assertTrue(self.h.latest()["ok"])

    def test_report_prints_only_anonymous_fields(self):
        self.h.scenario({"cursor": {"stdout": [entry("cursor", primary=window(10),
                                                     extra=[grok_bot(3)])]}})
        r = self.h.run("--report", providers=["cursor"])
        self.assertEqual(r.returncode, 0, r.stderr)
        lines = r.stdout.strip().splitlines()
        self.assertEqual(len(lines), 2)
        self.assertIn("cursor-grok-bot", r.stdout)
        self.assert_private(r.stdout + r.stderr)

    def test_identity_and_secrets_never_persist(self):
        self.h.scenario({"cursor": {"stdout": [entry("cursor", primary=window(10))],
                                    "stderr": f"cookie={SECRET} {EMAIL_1}"}})
        self.h.run(providers=["cursor"])
        self.assert_private(self.h.all_output_text())
        self.assertNotIn("Pro", json.dumps(self.h.latest()["meters"]))

    # ------------------------------------------------------------ accounts

    def test_multiple_accounts_get_distinct_stable_ids_and_no_cross_account_delta(self):
        one = lambda used: entry("cursor", EMAIL_1, primary=window(used))  # noqa: E731
        two = lambda used: entry("cursor", EMAIL_2, primary=window(used))  # noqa: E731
        self.h.scenario({"cursor": {"stdout": [one(10), two(80)]}})
        self.h.run(providers=["cursor"])
        first = {m["account"]: m["used_pct"] for m in self.h.latest()["meters"]}
        self.assertEqual(sorted(first.values()), [10, 80])
        self.h.scenario({"cursor": {"stdout": [two(85), one(12)]}})
        self.h.run(providers=["cursor"], now=LATER)
        second = {m["account"]: m for m in self.h.latest()["meters"]}
        self.assertEqual(set(first), set(second))
        for account, used in first.items():
            m = second[account]
            self.assertEqual(m["delta_pct"], m["used_pct"] - used)
        self.assert_private(self.h.all_output_text())

    def test_entries_without_identity_are_not_mixed(self):
        bare = {"provider": "cursor", "usage": {"updatedAt": NOW, "primary": window(5)}}
        self.h.scenario({"cursor": {"stdout": [bare, dict(bare)]}})
        self.h.run(providers=["cursor"])
        m = self.h.latest()["meters"]
        self.assertEqual(len(m), 1)
        self.assertEqual(m[0]["error"], "ambiguous_account")
        self.assertIsNone(m[0]["used_pct"])

    def test_successive_singleton_rounds_without_identity_are_never_trusted(self):
        for at, used in ((NOW, 10), (LATER, 30)):
            bare = {"provider": "cursor", "usage": {"updatedAt": at, "primary": window(used),
                                                    "extraRateWindows": [grok_bot(used)]}}
            self.h.scenario({"cursor": {"stdout": [bare]}})
            r = self.h.run(providers=["cursor"], now=at)
            self.assertEqual(r.returncode, 1)
            latest = self.h.latest()
            self.assertFalse(latest["ok"])
            self.assertEqual(len(latest["meters"]), 1)
            m = latest["meters"][0]
            self.assertEqual((m["kind"], m["account"], m["error"], m["used_pct"]),
                             ("provider", None, "ambiguous_account", None))
            self.assertIsNone(m["last_good"])
            self.assertIsNone(m["delta_pct"])
            with open(os.path.join(self.h.state, "state.json")) as f:
                self.assertEqual(json.load(f)["meters"], {})
        self.assertNotIn("acct-unidentified", self.h.all_output_text())

    def test_vanished_account_is_reported_not_dropped(self):
        self.h.scenario({"cursor": {"stdout": [entry("cursor", EMAIL_1, primary=window(10)),
                                               entry("cursor", EMAIL_2, primary=window(20))]}})
        self.h.run(providers=["cursor"])
        gone = [m["account"] for m in self.h.latest()["meters"] if m["used_pct"] == 20][0]
        self.h.scenario({"cursor": {"stdout": [entry("cursor", EMAIL_1, primary=window(11))]}})
        r = self.h.run(providers=["cursor"], now=LATER)
        self.assertEqual(r.returncode, 1)
        m = self.h.meter("cursor", "primary", account=gone)
        self.assertEqual(m["error"], "account_missing")
        self.assertTrue(m["stale"])
        self.assertEqual(m["last_good"]["used_pct"], 20)

    # ------------------------------------------------------------ failures

    def test_account_without_any_window_is_a_visible_failure(self):
        self.h.scenario({"cursor": {"stdout": [entry("cursor", extra=[
            {"id": "../bad", "window": {"usedPercent": 5}}, {"title": "no id"}])]}})
        r = self.h.run(providers=["cursor"])
        self.assertEqual(r.returncode, 1)
        latest = self.h.latest()
        self.assertFalse(latest["ok"])
        self.assertEqual(latest["round"]["errors"], {"cursor": "missing_window"})
        self.assertEqual(len(latest["meters"]), 1)
        m = latest["meters"][0]
        self.assertEqual((m["kind"], m["error"], m["stale"], m["used_pct"]),
                         ("account", "missing_window", True, None))
        self.assertRegex(m["account"], r"^acct-[0-9a-f]{12}$")
        self.assertEqual(latest["rows"][0]["error"], "missing_window")

    def test_only_secondary_window_is_a_complete_answer(self):
        self.h.scenario({"codex": {"stdout": [entry("codex", secondary=window(29))]}})
        r = self.h.run(providers=["codex"])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(self.h.latest()["ok"])
        self.assertEqual([m["meter"] for m in self.h.latest()["meters"]], ["secondary"])

    def test_untrustworthy_provider_time_is_stale_and_keeps_last_good(self):
        self.h.scenario({"cursor": {"stdout": [entry("cursor", primary=window(10))]}})
        self.h.run(providers=["cursor"])
        for updated in (None, "not-a-time", "2026-10-14T12:05:00", 12.5e20):
            self.h.scenario({"cursor": {"stdout": [entry("cursor", updated=updated,
                                                         primary=window(20))]}})
            r = self.h.run(providers=["cursor"], now=LATER)
            self.assertEqual(r.returncode, 1, updated)
            m = self.h.meter("cursor", "primary")
            self.assertEqual((m["error"], m["stale"], m["delta_pct"]),
                             ("invalid_timestamp", True, None), updated)
            self.assertEqual(m["last_good"]["used_pct"], 10)
            self.assertEqual(m["last_good"]["collected_at"], NOW)
            self.assertEqual(self.h.latest()["rows"][0]["used_pct"], None)

    def test_untrustworthy_provider_time_on_first_round_sets_no_last_good(self):
        self.h.scenario({"grok": {"stdout": [entry("grok", updated=None,
                                                   primary=window(5))]}})
        self.h.run(providers=["grok"])
        m = self.h.meter("grok", "primary")
        self.assertEqual((m["error"], m["stale"], m["last_good"]),
                         ("invalid_timestamp", True, None))

    def test_free_form_labels_and_titles_are_never_stored(self):
        e = entry("cursor", primary=window(1), secondary=window(2), tertiary=window(3),
                  extra=[dict(grok_bot(4), title=f"{EMAIL_2} {SECRET}")])
        e["rateWindowLabels"] = {"primary": EMAIL_1, "secondary": f"token={SECRET}",
                                 "tertiary": " weekly "}
        self.h.scenario({"cursor": {"stdout": [e]}})
        r = self.h.run("--report", providers=["cursor"])
        self.assertEqual(r.returncode, 0, r.stderr)
        labels = {m["meter"]: m["label"] for m in self.h.latest()["meters"]}
        self.assertEqual(labels, {"primary": "primary", "secondary": "secondary",
                                  "tertiary": "Weekly", "cursor-grok-bot": "cursor-grok-bot"})
        self.h.scenario({"cursor": {"exit": 1, "raw": ""}})
        self.h.run("--report", providers=["cursor"], now=LATER)
        self.assert_private(self.h.all_output_text() + r.stdout + r.stderr)

    def test_nonzero_exit_is_an_error_not_zero_usage(self):
        self.h.scenario({"grok": {"exit": 1, "stderr": SECRET,
                                  "stdout": [entry("grok", primary=window(0))]}})
        r = self.h.run(providers=["grok"])
        self.assertEqual(r.returncode, 1)
        rec = self.h.latest()["meters"]
        self.assertEqual(len(rec), 1)
        self.assertEqual(rec[0]["error"], "nonzero_exit")
        self.assertIsNone(rec[0]["used_pct"])
        row = self.h.latest()["rows"][0]
        self.assertEqual((row["provider"], row["used_pct"], row["error"]),
                         ("grok", None, "nonzero_exit"))
        self.assert_private(self.h.all_output_text() + r.stdout + r.stderr)

    def test_auth_error_entry_becomes_bounded_code(self):
        message = f"Not logged in: cookie {SECRET} for {EMAIL_1}"
        self.h.scenario({"claude": {"exit": 1, "stdout": [
            {"provider": "claude", "error": {"kind": "provider", "code": 1,
                                             "message": message}}]}})
        self.h.run(providers=["claude"])
        self.assertEqual(self.h.latest()["meters"][0]["error"], "auth_failed")
        self.assert_private(self.h.all_output_text())

    def test_malformed_and_empty_output(self):
        self.h.scenario({"codex": {"raw": "{not json " + SECRET},
                         "claude": {"raw": ""},
                         "grok": {"stdout": {"unexpected": True}}})
        self.h.run(providers=["codex", "claude", "grok"])
        errors = {m["provider"]: m["error"] for m in self.h.latest()["meters"]}
        self.assertEqual(errors, {"codex": "malformed_json", "claude": "empty_output",
                                  "grok": "unexpected_shape"})
        self.assertEqual(self.h.latest()["round"]["errors"], errors)
        self.assert_private(self.h.all_output_text())

    def test_invalid_values_never_become_zero(self):
        bad = [{"id": "bot-a", "window": {"usedPercent": "12"}},
               {"id": "bot-b", "window": {"usedPercent": True}},
               {"id": "bot-c", "window": {"usedPercent": -1}},
               {"id": "bot-d", "window": {"usedPercent": 1e9}},
               {"id": "bot-e", "window": None},
               {"id": "../escape", "window": {"usedPercent": 5}},
               {"title": "no id", "window": {"usedPercent": 5}}]
        primary = {"usedPercent": 15, "resetsAt": "not-a-time", "windowMinutes": -5}
        self.h.scenario({"cursor": {"stdout": [entry("cursor", primary=primary, extra=bad)]}})
        self.h.run(providers=["cursor"])
        p = self.h.meter("cursor", "primary")
        self.assertEqual(p["used_pct"], 15)
        self.assertIsNone(p["resets_at"])
        self.assertIsNone(p["window_minutes"])
        for meter in ("bot-a", "bot-b", "bot-c", "bot-d", "bot-e"):
            m = self.h.meter("cursor", meter)
            self.assertEqual(m["error"], "invalid_value", meter)
            self.assertIsNone(m["used_pct"])
            self.assertTrue(m["stale"])
        self.assertEqual(self.h.latest()["round"]["dropped_extra_windows"], 2)

    # ------------------------------------------------------------ staleness and resets

    def test_missing_window_keeps_last_good_and_is_stale(self):
        self.h.scenario({"cursor": {"stdout": [entry("cursor", primary=window(10),
                                                     extra=[grok_bot(40)])]}})
        self.h.run(providers=["cursor"])
        self.h.scenario({"cursor": {"stdout": [entry("cursor", primary=window(11))]}})
        self.h.run(providers=["cursor"], now=LATER)
        bot = self.h.meter("cursor", "cursor-grok-bot")
        self.assertEqual(bot["error"], "missing_window")
        self.assertTrue(bot["stale"])
        self.assertIsNone(bot["used_pct"])
        self.assertEqual(bot["last_good"], {"used_pct": 40, "resets_at": RESET_B,
                                            "provider_updated": NOW, "collected_at": NOW})
        self.assertEqual(bot["collected_at"], LATER)

    def test_failed_round_preserves_last_good(self):
        self.h.scenario({"cursor": {"stdout": [entry("cursor", primary=window(33))]}})
        self.h.run(providers=["cursor"])
        self.h.scenario({"cursor": {"exit": 2, "raw": ""}})
        self.h.run(providers=["cursor"], now=LATER)
        m = self.h.meter("cursor", "primary")
        self.assertEqual((m["error"], m["stale"], m["used_pct"]), ("nonzero_exit", True, None))
        self.assertEqual(m["last_good"]["used_pct"], 33)
        self.assertEqual(m["last_good"]["collected_at"], NOW)
        row = self.h.latest()["rows"][0]
        self.assertIsNone(row["used_pct"])

    def test_future_provider_time_is_invalid_and_never_trusted(self):
        self.h.scenario({"cursor": {"stdout": [entry("cursor", primary=window(10))]}})
        self.h.run(providers=["cursor"])
        for updated in ("2099-01-01T00:00:00Z", "2026-10-14T12:11:00Z"):
            self.h.scenario({"cursor": {"stdout": [entry("cursor", updated=updated,
                                                         primary=window(95))]}})
            r = self.h.run("--warn-pct", "80", providers=["cursor"], now=LATER)
            self.assertEqual(r.returncode, 1, updated)
            m = self.h.meter("cursor", "primary")
            self.assertEqual((m["error"], m["stale"], m["delta_pct"]),
                             ("invalid_timestamp", True, None), updated)
            self.assertEqual(m["last_good"]["used_pct"], 10)
            row = self.h.latest()["rows"][0]
            self.assertEqual((row["used_pct"], row["error"]), (None, "invalid_timestamp"))
        self.assertFalse(os.path.exists(os.path.join(self.h.state, "alerts.jsonl")))
        # Within the 5-minute clock-skew allowance a reading is still trusted.
        self.h.scenario({"cursor": {"stdout": [entry("cursor", updated="2026-10-14T12:09:00Z",
                                                     primary=window(20))]}})
        self.assertEqual(self.h.run(providers=["cursor"], now=LATER).returncode, 0)
        self.assertEqual(self.h.meter("cursor", "primary")["delta_pct"], 10)

    def test_old_provider_data_is_flagged_stale(self):
        self.h.scenario({"grok": {"stdout": [entry("grok", updated="2026-10-01T00:00:00Z",
                                                   primary=window(5))]}})
        r = self.h.run("--stale-after", "30", providers=["grok"])
        self.assertEqual(r.returncode, 1)
        m = self.h.meter("grok", "primary")
        self.assertEqual(m["used_pct"], 5)
        self.assertTrue(m["stale"])
        self.assertIsNone(m["last_good"])
        row = self.h.latest()["rows"][0]
        self.assertEqual((row["used_pct"], row["error"]), (None, "stale_source"))

    def test_reading_for_a_passed_reset_is_stale(self):
        self.h.scenario({"grok": {"stdout": [entry("grok",
                                                   primary=window(90, "2026-10-14T06:00:00Z"))]}})
        self.h.run(providers=["grok"])
        self.assertTrue(self.h.meter("grok", "primary")["stale"])

    def test_delta_only_within_one_reset_cycle(self):
        self.h.scenario({"cursor": {"stdout": [entry("cursor", updated="2026-10-14T16:55:00Z",
                                                     primary=window(50, RESET_A))]}})
        self.h.run(providers=["cursor"], now="2026-10-14T16:55:00Z")
        self.assertFalse(self.h.meter("cursor", "primary")["stale"])
        self.h.scenario({"cursor": {"stdout": [entry("cursor", updated="2026-10-14T17:05:00Z",
                                                     primary=window(60, RESET_B))]}})
        self.h.run(providers=["cursor"], now="2026-10-14T17:05:00Z")
        self.assertIsNone(self.h.meter("cursor", "primary")["delta_pct"])
        self.h.scenario({"cursor": {"stdout": [entry("cursor", updated="2026-10-14T17:10:00Z",
                                                     primary=window(75, RESET_B))]}})
        self.h.run(providers=["cursor"], now="2026-10-14T17:10:00Z")
        self.assertEqual(self.h.meter("cursor", "primary")["delta_pct"], 15)

    def test_a_moved_reset_time_is_a_new_cycle(self):
        for minute, used, resets in ((0, 50, RESET_B), (5, 60, "2026-10-14T22:00:30Z"),
                                     (10, 70, "2026-10-14T22:00:30Z")):
            at = f"2026-10-14T17:{minute:02d}:00Z"
            self.h.scenario({"cursor": {"stdout": [entry("cursor", updated=at,
                                                         primary=window(used, resets))]}})
            self.h.run(providers=["cursor"], now=at)
            m = self.h.meter("cursor", "primary")
            self.assertFalse(m["stale"])
            self.assertEqual(m["delta_pct"], {0: None, 5: None, 10: 10}[minute])

    # ------------------------------------------------------------ time limits

    def test_timeout_kills_the_process_group(self):
        pid_file = os.path.join(self.tmp, "child.pid")
        self.h.scenario({"cursor": {"sleep": 30, "child_sleep": 30,
                                    "stdout": [entry("cursor", primary=window(1))]}},
                        child_pid_file=pid_file)
        start = time.monotonic()
        self.h.run("--provider-timeout", "1", providers=["cursor"])
        self.assertLess(time.monotonic() - start, 15)
        self.assertEqual(self.h.latest()["meters"][0]["error"], "timeout")
        with open(pid_file) as f:
            child = int(f.read())
        time.sleep(0.2)
        with self.assertRaises(ProcessLookupError):
            os.kill(child, 0)

    def test_round_deadline_bounds_the_whole_round(self):
        slow = lambda p: {"sleep": 2, "stdout": [entry(p, primary=window(1))]}  # noqa: E731
        self.h.scenario({"codex": slow("codex"), "claude": slow("claude"),
                         "grok": slow("grok")})
        start = time.monotonic()
        self.h.run("--provider-timeout", "10", "--round-deadline", "3",
                   providers=["codex", "claude", "grok"])
        self.assertLess(time.monotonic() - start, 8)
        errors = {m["provider"]: m["error"] for m in self.h.latest()["meters"]}
        self.assertEqual(errors, {"codex": None, "claude": "deadline_exceeded",
                                  "grok": "deadline_exceeded"})
        self.assertEqual(len(self.h.calls()), 2)

    # ------------------------------------------------------------ files and locking

    def test_concurrent_round_is_refused_without_writes(self):
        self.h.scenario({"cursor": {"sleep": 3, "stdout": [entry("cursor",
                                                                 primary=window(1))]}})
        first = subprocess.Popen(self.h.command(providers=["cursor"]), env=self.h.env(),
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        deadline = time.monotonic() + 10
        while not os.path.exists(self.h.log) and time.monotonic() < deadline:
            time.sleep(0.05)
        second = self.h.run(providers=["cursor"])
        out, err = first.communicate(timeout=30)
        self.assertEqual(second.returncode, collect.EXIT_BUSY, second.stderr)
        self.assertIn("lock", second.stderr)
        self.assertEqual(first.returncode, 0, err)
        self.assertEqual(len(self.h.history()), 1)
        self.assertEqual(len(self.h.calls()), 1)

    def test_outputs_are_private_and_history_appends(self):
        self.h.scenario({"cursor": {"stdout": [entry("cursor", primary=window(1))]}})
        self.h.run(providers=["cursor"])
        self.h.run(providers=["cursor"], now=LATER)
        self.assertEqual([h["updated"] for h in self.h.history()], [NOW, LATER])
        self.assertEqual(stat.S_IMODE(os.stat(self.h.state).st_mode), 0o700)
        names = sorted(os.listdir(self.h.state))
        self.assertEqual(names, ["account.key", "collect.lock", "history.jsonl",
                                 "state.json", "usage.json"])
        for name in names:
            mode = stat.S_IMODE(os.stat(os.path.join(self.h.state, name)).st_mode)
            self.assertEqual(mode, 0o600, name)

    def test_reused_state_paths_are_made_private_and_history_kept(self):
        os.makedirs(self.h.state, mode=0o755)
        os.chmod(self.h.state, 0o755)
        key = "ab" * 32
        old = '{"schema":2,"updated":"2026-10-13T00:00:00Z"}\n'
        for name, text in (("account.key", key + "\n"), ("history.jsonl", old),
                           ("alerts.jsonl", ""), ("usage.json", "{}")):
            path = os.path.join(self.h.state, name)
            with open(path, "w") as f:
                f.write(text)
            os.chmod(path, 0o644)
        self.h.scenario({"cursor": {"stdout": [entry("cursor", primary=window(1))]}})
        r = self.h.run(providers=["cursor"])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(stat.S_IMODE(os.stat(self.h.state).st_mode), 0o700)
        for name in os.listdir(self.h.state):
            mode = stat.S_IMODE(os.stat(os.path.join(self.h.state, name)).st_mode)
            self.assertEqual(mode, 0o600, name)
        self.assertEqual([h["updated"] for h in self.h.history()],
                         ["2026-10-13T00:00:00Z", NOW])
        with open(os.path.join(self.h.state, "account.key")) as f:
            self.assertEqual(f.read().strip(), key)

    def test_symlinked_state_file_is_rejected(self):
        os.makedirs(self.h.state, mode=0o700)
        target = os.path.join(self.tmp, "elsewhere.jsonl")
        with open(target, "w") as f:
            f.write("keep\n")
        os.chmod(target, 0o644)
        os.symlink(target, os.path.join(self.h.state, "history.jsonl"))
        self.h.scenario({"cursor": {"stdout": [entry("cursor", primary=window(1))]}})
        r = self.h.run(providers=["cursor"])
        self.assertEqual(r.returncode, collect.EXIT_CONFIG)
        self.assertIn("unsafe state path", r.stderr)
        with open(target) as f:
            self.assertEqual(f.read(), "keep\n")
        self.assertEqual(stat.S_IMODE(os.stat(target).st_mode), 0o644)
        self.assertFalse(os.path.exists(os.path.join(self.h.state, "usage.json")))

    def test_failed_atomic_write_keeps_previous_file(self):
        path = os.path.join(self.tmp, "latest.json")
        collect.write_atomic(path, {"v": 1})
        with self.assertRaises(TypeError):
            collect.write_atomic(path, {"v": object()})
        with open(path) as f:
            self.assertEqual(json.load(f), {"v": 1})
        self.assertEqual(os.listdir(self.tmp).count("latest.json"), 1)
        self.assertFalse([n for n in os.listdir(self.tmp) if n.startswith(".tmp-")])

    def test_state_dir_is_required(self):
        r = subprocess.run([sys.executable, "-B", COLLECT, "--codexbar", self.h.bin],
                           env=self.h.env(), capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, collect.EXIT_CONFIG)
        self.assertFalse(os.path.exists(self.h.state))

    def test_missing_cli_is_not_installed(self):
        r = subprocess.run([sys.executable, "-B", COLLECT, "--state-dir", self.h.state,
                            "--codexbar", os.path.join(self.tmp, "absent"),
                            "--providers", "cursor", "--now", NOW],
                           env=self.h.env(), capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 1)
        self.assertEqual(self.h.latest()["meters"][0]["error"], "not_installed")

    # ------------------------------------------------------------ alerts and compatibility

    def test_alert_once_per_meter_and_cycle(self):
        self.h.scenario({"cursor": {"stdout": [entry("cursor", primary=window(85, RESET_A))]}})
        self.h.run(providers=["cursor"])
        self.h.run(providers=["cursor"], now=LATER)
        self.h.scenario({"cursor": {"stdout": [entry("cursor", updated="2026-10-14T17:05:00Z",
                                                     primary=window(90, RESET_B))]}})
        self.h.run(providers=["cursor"], now="2026-10-14T17:05:00Z")
        with open(os.path.join(self.h.state, "alerts.jsonl")) as f:
            alerts = [json.loads(line) for line in f]
        self.assertEqual([(a["used_pct"], a["resets_at"], a["posted"]) for a in alerts],
                         [(85, RESET_A, False), (90, RESET_B, False)])

    def test_rows_match_the_router_usage_contract(self):
        self.h.scenario({"cursor": {"stdout": [entry("cursor", primary=window(10),
                                                     extra=[grok_bot(5)])]},
                         "grok": {"exit": 1, "raw": ""}})
        self.h.run(providers=["cursor", "grok"])
        latest = self.h.latest()
        self.assertIsInstance(latest["updated"], str)
        for row in latest["rows"]:
            self.assertIsInstance(row["provider"], str)
            self.assertIsInstance(row["window"], (str, type(None)))
            self.assertIsInstance(row["used_pct"], (int, float, type(None)))
            self.assertIsInstance(row["resets_at"], (str, type(None)))
            self.assertIsInstance(row["error"], (str, type(None)))
        self.assertEqual({(r["provider"], r["used_pct"]) for r in latest["rows"]},
                         {("cursor", 10), ("grok", None)})


class ParseTest(unittest.TestCase):
    def test_parse_time(self):
        self.assertEqual(collect.iso(collect.parse_time("2026-10-14T12:00:00.123456789Z")),
                         "2026-10-14T12:00:00Z")
        self.assertEqual(collect.iso(collect.parse_time("2026-10-14T14:00:00+02:00")),
                         "2026-10-14T12:00:00Z")
        for bad in ("2026-10-14T12:00:00", "yesterday", "1800-01-01T00:00:00Z", True,
                    float("nan"), None, ["x"]):
            self.assertIsNone(collect.parse_time(bad), bad)

    def test_parse_percent(self):
        self.assertEqual(collect.parse_percent(42), 42.0)
        for bad in (True, "5", float("nan"), float("inf"), -0.1, 1000.1, None):
            self.assertIsNone(collect.parse_percent(bad), bad)


if __name__ == "__main__":
    unittest.main()
