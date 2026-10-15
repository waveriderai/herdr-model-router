import { mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  installCursorShim,
  disallowedCursorLeadArgs,
  runGuardedLead,
  pathWithoutShim,
  shimDir,
  shimScript,
  ZSHRC_BEGIN,
} from "../../src/launch/cursor-lead.js";

const tmp = () => realpathSync(mkdtempSync(path.join(os.tmpdir(), "hmr-lead-")));

describe("Herdr cursor-agent lead shim (Kai 11:18 PM PT)", () => {
  it("routes only Herdr panes without a per-launch config through the sandboxed lead", () => {
    const script = shimScript("/n/node", "/r/cli.js");
    expect(script).toContain('if [ -n "$HERDR_PANE_ID" ] && [ -z "$CURSOR_CONFIG_DIR" ]; then');
    expect(script).toContain('cursor-lead -- "$@"');
    expect(script).toContain('cursor-lead --passthrough -- "$@"');
  });

  it("keeps the shim out of hmr's and the lead's executable lookup", () => {
    const home = "/h/router";
    expect(pathWithoutShim(`${shimDir(home)}:/usr/bin:/bin`, home)).toBe("/usr/bin:/bin");
  });

  it("allows only --model, --resume, --continue and prompt text (review round 10)", () => {
    expect(disallowedCursorLeadArgs(["--model", "x", "fix the bug"])).toEqual([]);
    expect(disallowedCursorLeadArgs(["--model=x", "--resume=abc-1", "--continue"])).toEqual([]);
    for (const bad of [
      "-f",
      "-pf",
      "--force",
      "--yolo",
      "-w",
      "--workspace",
      "--add-dir",
      "--worktree",
      "--sandbox",
      "--sandbox=disabled",
      "--",
      "-m",
    ]) {
      expect(disallowedCursorLeadArgs([bad, "x"])).toEqual([bad]);
    }
    expect(disallowedCursorLeadArgs(["--model", "-f"])).toEqual(["--model", "-f"]);
  });

  function exe(body: string): string {
    const file = path.join(tmp(), "bin.sh");
    writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  }
  const quiet = { write: () => true };

  it("stops cursor-agent when the guard exits or never becomes ready", async () => {
    const ready = path.join(tmp(), "ready");
    const exited = await runGuardedLead({
      real: exe("sleep 5; exit 0"),
      args: [],
      env: process.env,
      nodePath: "/bin/sh",
      guardArgs: ["-c", "exit 3"],
      guardEnv: process.env,
      readyFile: ready,
      stderr: quiet,
    });
    expect(exited).not.toBe(0);
    const timedOut = await runGuardedLead({
      real: exe("sleep 5; exit 0"),
      args: [],
      env: process.env,
      nodePath: "/bin/sh",
      guardArgs: ["-c", "sleep 5"],
      guardEnv: process.env,
      readyFile: ready,
      stderr: quiet,
      readyMs: 300,
    });
    expect(timedOut).not.toBe(0);
  });

  it("runs cursor-agent to completion under a ready guard", async () => {
    const ready = path.join(tmp(), "ready");
    const code = await runGuardedLead({
      real: exe("sleep 1; exit 0"),
      args: [],
      env: process.env,
      nodePath: "/bin/sh",
      guardArgs: ["-c", `touch '${ready}'; sleep 5`],
      guardEnv: process.env,
      readyFile: ready,
      stderr: quiet,
      readyMs: 3000,
    });
    expect(code).toBe(0);
  });

  it("installs a 0700 shim and one Herdr-only PATH block in ~/.zshrc, idempotently", () => {
    const home = tmp();
    writeFileSync(path.join(home, ".zshrc"), "export FOO=1");
    const input = { routerHome: path.join(home, "router"), home, nodePath: "/n", cliPath: "/c" };
    installCursorShim(input);
    installCursorShim(input);
    const rc = readFileSync(path.join(home, ".zshrc"), "utf8");
    expect(rc.startsWith("export FOO=1\n")).toBe(true);
    expect(rc.split(ZSHRC_BEGIN)).toHaveLength(2);
    expect(rc).toContain('[ -n "$HERDR_PANE_ID" ] && export PATH=');
    const shim = path.join(shimDir(input.routerHome), "cursor-agent");
    expect(statSync(shim).mode & 0o777).toBe(0o700);
  });
});
