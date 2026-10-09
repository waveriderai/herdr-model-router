import { mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dispatchPlan, reviseTask } from "../../src/rules/dispatch.js";
import { worktreeIdentity } from "../../src/rules/rules-source.js";
import { fakeHerdr } from "../helpers/fake-herdr.js";
import { harness, type Harness } from "../helpers/workflow-harness.js";

/** A rules-mode writer task (no workflow) started in the harness repository. */
async function writerTask(h: Harness) {
  const planned = h.deps.planRole({ role: "writer", cwd: h.repo, readOnly: false });
  if (!planned.ok) throw new Error(planned.error);
  const dispatched = await dispatchPlan({
    plan: planned.plan,
    prompt: "Initial scoped task",
    worktreeId: worktreeIdentity(h.repo),
    deps: h.dispatch,
  });
  if (!dispatched.ok) throw new Error(dispatched.error);
  const lane = h.dispatch.store.lanes(dispatched.task.id)[0]!;
  return { task: dispatched.task, lane, pane: h.herdr.panes.get(lane.paneId!)! };
}

const revise = (h: Harness, taskId: string) =>
  reviseTask({ taskId, text: "Approved correction", deps: h.dispatch });

describe("rules-mode writer continuity is bound to its native session (R8, R17)", () => {
  it("records the session, directory and name before the first prompt, and revises that session", async () => {
    const h = harness();
    const { task, lane } = await writerTask(h);
    expect(lane).toMatchObject({
      sessionId: `sess-${lane.paneId}`,
      sessionCwd: realpathSync(h.repo),
      agentName: expect.stringMatching(/^hmr-claude-/),
    });
    expect(await revise(h, task.id)).toMatchObject({ ok: true });
    expect(h.herdr.prompts).toHaveLength(2);
  });

  it.each([
    [
      "a replacement session in the same pane",
      (pane: { session?: string }) => (pane.session = "replacement"),
      "session-changed",
    ],
    ["a renamed agent", (pane: { name?: string }) => (pane.name = "someone-else"), "name-changed"],
    [
      "no session reported any more",
      (pane: { session?: string }) => (pane.session = undefined),
      "session-missing",
    ],
    [
      "another working directory",
      (pane: { cwd?: string }) =>
        (pane.cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), "hmr-elsewhere-")))),
      "cwd-changed",
    ],
  ] as const)("refuses a revision to %s, sending nothing", async (_label, change, code) => {
    const h = harness();
    const { task, pane } = await writerTask(h);
    change(pane as never);
    expect(await revise(h, task.id)).toMatchObject({ ok: false, code });
    expect(h.herdr.prompts).toHaveLength(1);
  });

  it("refuses continuity for a lane recorded without a session, instead of adopting one", async () => {
    const h = harness();
    const { task, lane } = await writerTask(h);
    h.db
      .prepare("update dispatch_lanes set session_id = null, session_cwd = null where id = ?")
      .run(lane.id);
    expect(await revise(h, task.id)).toMatchObject({ ok: false, code: "identity-missing" });
    expect(h.herdr.prompts).toHaveLength(1);
  });

  it("does not start a writer whose Herdr record lacks a session, but still runs read-only lanes", async () => {
    const herdr = fakeHerdr({ detect: () => ({ session: undefined }) });
    const h = harness({ herdr });
    const writer = h.deps.planRole({ role: "writer", cwd: h.repo, readOnly: false });
    if (!writer.ok) throw new Error(writer.error);
    const refused = await dispatchPlan({
      plan: writer.plan,
      prompt: "x",
      worktreeId: worktreeIdentity(h.repo),
      deps: h.dispatch,
    });
    expect(refused.ok && refused.lanes[0]).toMatchObject({ state: "failed" });
    expect(h.herdr.prompts).toEqual([]);
    expect(h.dispatch.store.ownerOf(worktreeIdentity(h.repo))).toBeUndefined();
    const panel = h.deps.planRole({ role: "checkers", cwd: h.repo, readOnly: true });
    if (!panel.ok) throw new Error(panel.error);
    const reviewed = await dispatchPlan({
      plan: panel.plan,
      prompt: "Review",
      worktreeId: worktreeIdentity(h.repo),
      deps: h.dispatch,
    });
    expect(reviewed.ok && reviewed.lanes.map((lane) => lane.state)).toEqual([
      "prompted",
      "prompted",
    ]);
  });
});
