import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { worktreeIdentity } from "../../src/rules/rules-source.js";
import {
  recordResult,
  releaseWorkflow,
  reviseWorkflow,
  startWorkflow,
} from "../../src/workflow/service.js";
import { fakeAgentCollab } from "../helpers/fake-agent-collab.js";
import { fakeHerdr, ok, type FakeHerdr } from "../helpers/fake-herdr.js";
import { BRIEF, harness, type Harness } from "../helpers/workflow-harness.js";

/** A pid no process has: the slot of a crashed operation. */
const DEAD_PID = 2 ** 22 + 54321;

/** Holds the Nth prompt in flight until `release()` is called. */
function barrier(holdPrompt: number) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => (entered = resolve));
  const herdr = fakeHerdr({
    prompt: async (_target, count) => {
      if (count !== holdPrompt) return undefined;
      entered();
      await gate;
      return ok(JSON.stringify({ result: { agent: { agent_status: "working" } } }));
    },
  });
  return { herdr, release, reached };
}

async function withResult(h: Harness) {
  const started = await startWorkflow(h.deps, { brief: BRIEF, cwd: h.repo });
  if (!started.ok) throw new Error(`${started.code}: ${started.error}`);
  const { workflow, attempt } = started.value;
  writeFileSync(path.join(h.repo, "greeting.txt"), "hello\n");
  const recorded = await recordResult(h.deps, {
    workflowId: workflow.id,
    expectedAttemptId: attempt.id,
    text: h.writerResult({ workflowId: workflow.id, attemptId: attempt.id }),
  });
  if (!recorded.ok) throw new Error(recorded.error);
  return { workflow, attempt };
}

describe("one coordinator operation at a time (serialized across async I/O)", () => {
  it("refuses an abort while a revision prompt is in flight, and never releases under it", async () => {
    const { herdr, release, reached } = barrier(2);
    const h = harness({ herdr });
    const { workflow, attempt } = await withResult(h);
    const revising = reviseWorkflow(h.deps, {
      workflowId: workflow.id,
      expectedAttemptId: attempt.id,
      delta: "One more change.",
    });
    await reached;
    // The revision holds the workflow; the abort changes nothing.
    expect(h.workflows.get(workflow.id)!.operation?.name).toBe("revise");
    const aborted = await releaseWorkflow(h.deps, {
      workflowId: workflow.id,
      evidence: "stop",
      abort: true,
    });
    expect(aborted).toMatchObject({ ok: false, code: "operation-in-progress" });
    expect(h.dispatch.store.ownerOf(workflow.worktreeId)?.taskId).toBe(workflow.taskId);
    // The revision's attempt was linked to its dispatch attempt before submission.
    const pending = h.workflows.currentAttempt(workflow.id)!;
    expect(pending).toMatchObject({ purpose: "revision", sendState: "sending" });
    expect(pending.backendAttempt).toMatch(/^att_/);
    release();
    expect(await revising).toMatchObject({ ok: true });
    expect(h.workflows.get(workflow.id)).toMatchObject({ state: "dispatched" });
    expect(h.workflows.get(workflow.id)!.operation).toBeUndefined();
    expect(h.dispatch.store.ownerOf(workflow.worktreeId)?.taskId).toBe(workflow.taskId);
  });

  it("lets only one of two concurrent result recordings through", async () => {
    const h = harness();
    const started = await startWorkflow(h.deps, { brief: BRIEF, cwd: h.repo });
    if (!started.ok) throw new Error(started.error);
    const { workflow, attempt } = started.value;
    writeFileSync(path.join(h.repo, "greeting.txt"), "hello\n");
    const text = h.writerResult({ workflowId: workflow.id, attemptId: attempt.id });
    const both = await Promise.all([
      recordResult(h.deps, { workflowId: workflow.id, expectedAttemptId: attempt.id, text }),
      recordResult(h.deps, { workflowId: workflow.id, expectedAttemptId: attempt.id, text }),
    ]);
    expect(both.filter((result) => result.ok)).toHaveLength(1);
    expect(both.find((result) => !result.ok)).toMatchObject({ ok: false });
    expect(h.workflows.get(workflow.id)!.state).toBe("receipt");
  });

  it("takes over the slot of a crashed operation, but not of a live one", async () => {
    const h = harness();
    const { workflow } = await withResult(h);
    const hold = (pid: number) =>
      h.db
        .prepare(
          "update workflows set op_token = 'op_held', op_name = 'revise', op_pid = ?, op_host = ?, op_started_at = 'x' where id = ?",
        )
        .run(pid, os.hostname(), workflow.id);
    hold(process.ppid);
    expect(
      await releaseWorkflow(h.deps, { workflowId: workflow.id, evidence: "stop", abort: true }),
    ).toMatchObject({
      ok: false,
      code: "operation-in-progress",
    });
    hold(DEAD_PID);
    expect(
      await releaseWorkflow(h.deps, { workflowId: workflow.id, evidence: "stop", abort: true }),
    ).toMatchObject({
      ok: true,
    });
    expect(h.workflows.get(workflow.id)!.state).toBe("aborted");
  });
});

describe("a start that fails before any prompt (rollback)", () => {
  it("rolls back a start with no native session: pane closed, lease freed, abort confirms it", async () => {
    const herdr = fakeHerdr({ detect: () => ({ session: undefined }) });
    const h = harness({ herdr });
    const started = await startWorkflow(h.deps, { brief: BRIEF, cwd: h.repo });
    expect(started).toMatchObject({
      ok: false,
      code: "writer-not-started",
      evidence: { promptSent: false, paneClosed: true, ownershipReleased: true },
    });
    const workflow = h.workflows.list(1)[0]!;
    expect(workflow.state).toBe("failed");
    expect(h.dispatch.store.ownerOf(workflow.worktreeId)).toBeUndefined();
    expect(
      await releaseWorkflow(h.deps, {
        workflowId: workflow.id,
        evidence: "no session",
        abort: true,
      }),
    ).toMatchObject({
      ok: true,
    });
    // The worktree is free: the next start gets as far as launching its own writer again.
    const again = await startWorkflow(h.deps, { brief: BRIEF, cwd: h.repo });
    expect(again).toMatchObject({ ok: false, code: "writer-not-started" });
  });

  it("keeps the worktree held when the new pane's close is not confirmed", async () => {
    const herdr: FakeHerdr = fakeHerdr({
      detect: () => ({ session: undefined }),
      close: () => false,
    });
    const h = harness({ herdr });
    const started = await startWorkflow(h.deps, { brief: BRIEF, cwd: h.repo });
    expect(started).toMatchObject({ ok: false, code: "writer-orphan" });
    const workflow = h.workflows.list(1)[0]!;
    expect(workflow.state).toBe("unknown");
    expect(h.dispatch.store.ownerOf(workflow.worktreeId)?.taskId).toBe(workflow.taskId);
    // Nothing proves the pane stopped: neither the workflow nor the legacy task path frees it.
    expect(
      await releaseWorkflow(h.deps, { workflowId: workflow.id, evidence: "x", abort: true }),
    ).toMatchObject({
      ok: false,
      code: "start-held",
    });
    expect(() => h.dispatch.store.closeTask(workflow.taskId!, "released", "x")).toThrow(
      /belongs to open workflow/,
    );
    expect(h.herdr.prompts).toEqual([]);
  });

  it("does the same for an agent-collab start whose pane close is not confirmed", async () => {
    const fake = fakeAgentCollab();
    fake.setMode({ acquire: "refuse" });
    const herdr = fakeHerdr({ close: () => false });
    const h = harness({ herdr, collab: fake.port });
    h.workflows.setBinding(worktreeIdentity(h.repo), "agent-collab");
    expect(await startWorkflow(h.deps, { brief: BRIEF, cwd: h.repo })).toMatchObject({
      ok: false,
      code: "writer-orphan",
    });
    const workflow = h.workflows.list(1)[0]!;
    expect(workflow).toMatchObject({ state: "unknown", startPane: { closed: false } });
    expect(
      await releaseWorkflow(h.deps, { workflowId: workflow.id, evidence: "x", abort: true }),
    ).toMatchObject({
      ok: false,
    });
    // With a confirmed close the same refusal is a final, rolled-back failure.
    const closed = fakeAgentCollab();
    closed.setMode({ acquire: "refuse" });
    const h2 = harness({ collab: closed.port });
    h2.workflows.setBinding(worktreeIdentity(h2.repo), "agent-collab");
    expect(await startWorkflow(h2.deps, { brief: BRIEF, cwd: h2.repo })).toMatchObject({
      ok: false,
      code: "backend-refused",
    });
    expect(h2.workflows.list(1)[0]).toMatchObject({ state: "failed", startPane: { closed: true } });
  });
});
