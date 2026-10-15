import { mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  installCursorShim,
  loosenedCursorArgs,
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

  it("refuses arguments that would loosen approvals or the sandbox", () => {
    expect(loosenedCursorArgs(["--model", "x"])).toEqual([]);
    expect(loosenedCursorArgs(["--sandbox", "enabled"])).toEqual([]);
    expect(loosenedCursorArgs(["-f"])).toEqual(["-f"]);
    expect(loosenedCursorArgs(["--yolo"])).toEqual(["--yolo"]);
    expect(loosenedCursorArgs(["--sandbox", "disabled"])).toEqual(["--sandbox disabled"]);
    expect(loosenedCursorArgs(["--sandbox=disabled"])).toEqual(["--sandbox=disabled"]);
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
