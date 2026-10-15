import { chmodSync, mkdtempSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureMode } from "../../src/config/ensure-mode.js";

describe("ensureMode (AGENT-285: no chmod a Cursor sandbox would refuse)", () => {
  it("leaves an already-private path alone and fixes a wrong mode", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hmr-mode-"));
    chmodSync(dir, 0o700);
    const before = statSync(dir).ctimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    ensureMode(dir, 0o700);
    // chmod, even a no-op one, updates ctime; ensureMode must not have called it.
    expect(statSync(dir).ctimeMs).toBe(before);
    chmodSync(dir, 0o755);
    ensureMode(dir, 0o700);
    expect(statSync(dir).mode & 0o7777).toBe(0o700);
    // A special bit (sticky) with the right rwx bits is still cleared.
    chmodSync(dir, 0o1700);
    ensureMode(dir, 0o700);
    expect(statSync(dir).mode & 0o7777).toBe(0o700);
  });
});
