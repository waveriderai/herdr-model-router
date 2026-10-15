import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { startCursorGuardProcess } from "../../src/commands/rules-runtime.js";

function tmp(): string {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), "hmr-guard-start-")));
}

function script(body: string): string {
  const file = path.join(tmp(), "fake-cli.mjs");
  writeFileSync(file, body);
  return file;
}

const input = { paneId: "w1:p1", worktree: "/work", laneId: "lane/1" };

describe("starting hmr's Cursor pane guard (AGENT-285 review round 6)", () => {
  it("fails when the guard exits before it is ready", async () => {
    const cli = script("process.exit(23);");
    const result = await startCursorGuardProcess(input, tmp(), {}, { cli, timeoutMs: 3000 });
    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/exited \(23\) before it was ready/),
    });
  });

  it("fails when the guard never becomes ready", async () => {
    const cli = script("setTimeout(() => {}, 5000);");
    const result = await startCursorGuardProcess(input, tmp(), {}, { cli, timeoutMs: 400 });
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/not ready in time/) });
  });

  it("passes the resolved router home and succeeds once the guard is ready there", async () => {
    // The fake guard marks ready only under the --home it was given, with no env at all.
    const cli = script(`
      import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
      const args = process.argv.slice(2);
      const home = args[args.indexOf("--home") + 1];
      const priv = realpathSync(home) + ".cursor-private";
      mkdirSync(priv + "/cursor-guard", { recursive: true });
      writeFileSync(priv + "/cursor-guard/lane_1.ready", "1");
      setTimeout(() => {}, 200);
    `);
    const home = tmp();
    const result = await startCursorGuardProcess(input, home, {}, { cli, timeoutMs: 3000 });
    expect(result).toEqual({ ok: true });
  });
});
