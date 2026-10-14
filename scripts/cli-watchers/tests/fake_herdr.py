"""Fake `herdr` for watcher tests.

Reads a scenario from the JSON file named by FAKE_HERDR_SPEC:

  {"log": "<path>", "session": "test",
   "agents": [{"pane_id": "w1:p1", "agent": "codex", "name": "impl",
               "agent_status": "working", "terminal_id": "term_1", "session": "<uuid>",
               "state_change_seq": 3, "screen": "<recent text>", "visible": "<optional>"}],
   "fail": {"agent list" | "agent get w1:p1" | "pane read w1:p1" | "*":
            {"exit": 1, "code": "server_not_running", "message": "<text>"}},
   "sleep": {"agent list": 2}}

Each call appends its argv to `log`. Like Herdr 0.9.3, errors are JSON on stderr with exit 1,
reads are plain text, and an unknown `--session` reports `server_not_running`.
"""

import json
import os
import sys
import time


def fail(code, message="", exit_code=1, command="cli"):
    sys.stderr.write(json.dumps({"id": f"cli:{command}",
                                 "error": {"code": code, "message": message}}))
    return exit_code


def agent_json(a):
    return {
        "agent": a.get("agent", "codex"),
        "agent_session": {"agent": a.get("agent", "codex"), "kind": "id",
                          "source": "herdr:" + a.get("agent", "codex"),
                          "value": a.get("session", "00000000-0000-0000-0000-000000000000")},
        "agent_status": a.get("agent_status", "idle"),
        "cwd": "/fixture/private/project",
        "foreground_cwd": "/fixture/private/project",
        "focused": False,
        "interactive_ready": True,
        "name": a.get("name"),
        "pane_id": a["pane_id"],
        "revision": 1,
        "state_change_seq": a.get("state_change_seq", 1),
        "tab_id": a["pane_id"].split(":")[0] + ":t1",
        "terminal_id": a.get("terminal_id", "term_1"),
        "terminal_title": "private title someone@example.test",
        "terminal_title_stripped": "private title",
        "workspace_id": a["pane_id"].split(":")[0],
    }


def main() -> int:
    with open(os.environ["FAKE_HERDR_SPEC"]) as f:
        spec = json.load(f)
    argv = sys.argv[1:]
    if spec.get("log"):
        with open(spec["log"], "a") as f:
            f.write(json.dumps({"argv": argv, "t": time.time()}) + "\n")
    if len(argv) < 4 or argv[0] != "--session":
        return fail("usage", exit_code=2)
    session, command = argv[1], argv[2:]
    words = " ".join(command[:3])
    for key in (words, " ".join(command[:2]), "*"):
        if key in spec.get("sleep", {}):
            time.sleep(spec["sleep"][key])
            break
    for key in (words, " ".join(command[:2]), "*"):
        if key in spec.get("fail", {}):
            case = spec["fail"][key]
            return fail(case.get("code", "internal"), case.get("message", ""),
                        case.get("exit", 1))
    if session != spec.get("session", "test"):
        return fail("server_not_running", "no server for session")
    agents = {a["pane_id"]: a for a in spec.get("agents", [])}
    verb = tuple(command[:2])
    if verb == ("agent", "list"):
        print(json.dumps({"id": "cli:agent:list", "result": {
            "type": "agent_list", "agents": [agent_json(a) for a in agents.values()]}}))
        return 0
    if verb == ("agent", "get"):
        a = agents.get(command[2])
        if a is None:
            return fail("agent_not_found", f"no agent {command[2]}")
        print(json.dumps({"id": "cli:agent:get", "result": {"type": "agent_info",
                                                           "agent": agent_json(a)}}))
        return 0
    if verb == ("pane", "read"):
        a = agents.get(command[2])
        if a is None:
            return fail("pane_not_found", f"no pane {command[2]}")
        source = command[command.index("--source") + 1] if "--source" in command else "recent"
        if source == "visible":
            text = a.get("visible", "\n".join(a.get("screen", "").splitlines()[-20:]))
        else:
            lines = int(command[command.index("--lines") + 1]) if "--lines" in command else 50
            text = "\n".join(a.get("screen", "").splitlines()[-lines:])
        sys.stdout.write(text + "\n")
        return 0
    return fail("unsupported", " ".join(command), exit_code=2)


if __name__ == "__main__":
    sys.exit(main())
