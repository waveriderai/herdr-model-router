import { mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { HerdrAgentInfo } from "../../src/launch/herdr-client.js";
import {
  checkStopped,
  compareIdentity,
  identityFromLive,
  type BoundIdentity,
} from "../../src/workflow/identity.js";

const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), "hmr-id-")));
const BOUND: BoundIdentity = {
  agentName: "hmr-claude-1",
  kind: "claude",
  paneId: "w1:p1",
  sessionId: "sess-1",
  cwd,
};
const LIVE: HerdrAgentInfo = {
  name: "hmr-claude-1",
  agent: "claude",
  status: "idle",
  paneId: "w1:p1",
  sessionId: "sess-1",
  cwd,
};

const paneWith = (live: HerdrAgentInfo | undefined) => ({ getAgent: async () => live });

describe("bound writer identity", () => {
  it("binds only when Herdr reports a session and a directory", () => {
    expect(identityFromLive(LIVE, "hmr-claude-1")).toEqual({ ok: true, identity: BOUND });
    const { sessionId: _s, ...noSession } = LIVE;
    void _s;
    expect(identityFromLive(noSession, "hmr-claude-1")).toMatchObject({
      ok: false,
      code: "session-missing",
      error: expect.stringContaining("the Herdr integration for claude must report its session"),
    });
    const { cwd: _c, ...noCwd } = LIVE;
    void _c;
    expect(identityFromLive(noCwd, "hmr-claude-1")).toMatchObject({
      ok: false,
      code: "cwd-missing",
    });
  });

  it.each([
    ["a missing agent", undefined, "agent-missing"],
    ["an agent without a name", { ...LIVE, name: undefined }, "name-missing"],
    ["a renamed agent in the same pane and session", { ...LIVE, name: "other" }, "name-changed"],
    ["another pane", { ...LIVE, paneId: "w1:p2" }, "pane-changed"],
    ["another kind", { ...LIVE, agent: "codex" }, "kind-changed"],
    ["no session", { ...LIVE, sessionId: undefined }, "session-missing"],
    ["a new session in the same pane", { ...LIVE, sessionId: "sess-2" }, "session-changed"],
    ["another directory", { ...LIVE, cwd: os.tmpdir() }, "cwd-changed"],
  ] as const)("refuses %s", (_label, live, code) => {
    expect(compareIdentity(live as HerdrAgentInfo | undefined, BOUND)).toMatchObject({
      ok: false,
      code,
    });
  });

  it("treats only a matching idle or done writer as stopped", async () => {
    expect(await checkStopped(paneWith(LIVE), BOUND)).toMatchObject({ ok: true });
    expect(await checkStopped(paneWith({ ...LIVE, status: "done" }), BOUND)).toMatchObject({
      ok: true,
    });
    for (const status of ["working", "blocked", "unknown"] as const) {
      expect(await checkStopped(paneWith({ ...LIVE, status }), BOUND)).toMatchObject({
        ok: false,
        code: "not-stopped",
      });
    }
    expect(await checkStopped(paneWith(undefined), BOUND)).toMatchObject({
      ok: false,
      code: "agent-missing",
    });
    expect(
      await checkStopped({ getAgent: async () => Promise.reject(new Error("herdr down")) }, BOUND),
    ).toMatchObject({ ok: false, code: "agent-missing" });
    // A stopped-looking agent with another session is not the bound writer.
    expect(await checkStopped(paneWith({ ...LIVE, sessionId: "sess-2" }), BOUND)).toMatchObject({
      ok: false,
      code: "session-changed",
    });
  });
});
