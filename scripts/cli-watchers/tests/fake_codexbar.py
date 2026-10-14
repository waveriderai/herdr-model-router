"""Fake `codexbar` for collector tests.

Reads a scenario from the JSON file named by FAKE_CODEXBAR_SPEC:

  {"log": "<path>", "providers": {"cursor": {"stdout": <json> | "raw": "<text>",
   "exit": 0, "sleep": 0, "stderr": "<text>", "child_sleep": 0}}}

Each call appends its argv to `log`. `child_sleep` starts a grandchild that outlives the
fake unless the caller kills the whole process group.
"""

import json
import os
import subprocess
import sys
import time


def main() -> int:
    with open(os.environ["FAKE_CODEXBAR_SPEC"]) as f:
        spec = json.load(f)
    argv = sys.argv[1:]
    provider = argv[argv.index("--provider") + 1] if "--provider" in argv else "all"
    if spec.get("log"):
        with open(spec["log"], "a") as f:
            f.write(json.dumps({"argv": argv, "pid": os.getpid(), "t": time.time()}) + "\n")
    case = spec.get("providers", {}).get(provider)
    if case is None:
        sys.stdout.write(json.dumps([{"provider": provider, "error": {"kind": "provider",
                                      "code": 1, "message": "not enabled"}}]))
        return 1
    if case.get("child_sleep"):
        child = subprocess.Popen([sys.executable, "-c",
                                  f"import time; time.sleep({case['child_sleep']})"])
        if spec.get("child_pid_file"):
            with open(spec["child_pid_file"], "w") as f:
                f.write(str(child.pid))
    if case.get("stderr"):
        sys.stderr.write(case["stderr"])
        sys.stderr.flush()
    if case.get("sleep"):
        time.sleep(case["sleep"])
    if "raw" in case:
        sys.stdout.write(case["raw"])
    elif "stdout" in case:
        sys.stdout.write(json.dumps(case["stdout"]))
    sys.stdout.flush()
    return case.get("exit", 0)


if __name__ == "__main__":
    sys.exit(main())
