import { mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bindWriterIdentity } from "../../src/rules/dispatch.js";

const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), "hmr-bind-")));

function pane(sessionAfter: number) {
  let calls = 0;
  return {
    getAgent: async (paneId: string) => {
      calls += 1;
      return {
        agent: "cursor" as const,
        status: "idle" as const,
        paneId,
        name: "hmr-cursor-1",
        cwd,
        ...(calls > sessionAfter ? { sessionId: "sess-1" } : {}),
      };
    },
    readPane: async () => undefined,
    sendText: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
    sendKeys: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
  };
}

describe("writer binding waits for a late Cursor session hook (AGENT-285)", () => {
  it("binds once the session id arrives after the prompt shows", async () => {
    const bound = await bindWriterIdentity(
      { pane: pane(2), sleep: async () => {}, pollMs: 500 },
      { paneId: "w1:p1", agentName: "hmr-cursor-1", cwd },
    );
    expect(bound.ok).toBe(true);
  });
  it("still refuses when no session id ever arrives", async () => {
    const bound = await bindWriterIdentity(
      { pane: pane(1_000), sleep: async () => {}, pollMs: 500 },
      { paneId: "w1:p1", agentName: "hmr-cursor-1", cwd },
    );
    expect(bound).toMatchObject({ ok: false });
  });
});
