import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  acceptWorkflow,
  recordDelivery,
  recordResult,
  recoverWorkflow,
  releaseWorkflow,
  reviseWorkflow,
  startWorkflow,
  verifyWorkflow,
  workflowReport,
} from "../../src/workflow/service.js";
import { failed, fakeHerdr } from "../helpers/fake-herdr.js";
import { commitAll, gitIn } from "../helpers/git-repo.js";
import { BRIEF, harness, type Harness } from "../helpers/workflow-harness.js";

/** A pid no process has: the slot of a crashed operation. */
const DEAD_PID = 2 ** 22 + 12345;

async function started(h: Harness) {
  const result = await startWorkflow(h.deps, { brief: BRIEF, cwd: h.repo });
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.value;
}

function writerPane(h: Harness, workflowId: string) {
  const identity = h.workflows.get(workflowId)!.identity!;
  return h.herdr.panes.get(identity.paneId)!;
}

async function verifiedLanes(h: Harness, workflowId: string, attemptId: string) {
  const verified = await verifyWorkflow(h.deps, { workflowId, expectedAttemptId: attemptId });
  if (!verified.ok) throw new Error(`${verified.code}: ${verified.error}`);
  return verified.value.lanes.flatMap((round) => round.lanes);
}

describe("standalone workflow (AE5 without agent-collab)", () => {
  it("runs writer, result, verify, revision, re-verify, accept, delivery and release on one session", async () => {
    const h = harness();
    const { workflow, attempt } = await started(h);
    expect(workflow).toMatchObject({
      backend: "standalone",
      state: "dispatched",
      writerDescriptor: "claude:claude-opus-5-5@high",
    });
    expect(attempt.sendState).toBe("working");
    // The writer prompt names its own workflow and attempt; the brief is bound by SHA-256.
    expect(h.herdr.prompts).toHaveLength(1);
    expect(h.herdr.prompts[0]!.text).toContain(
      `HMR workflow ${workflow.id}, attempt ${attempt.id}`,
    );
    expect(h.dispatch.store.ownerOf(workflow.worktreeId)?.taskId).toBe(workflow.taskId);
    const identity = workflow.identity!;
    expect(identity).toMatchObject({ kind: "claude", sessionId: `sess-${identity.paneId}` });

    // An idle writer is not a result.
    expect(
      await verifyWorkflow(h.deps, { workflowId: workflow.id, expectedAttemptId: attempt.id }),
    ).toMatchObject({
      ok: false,
      code: "state-conflict",
    });
    const before = h.writerResult({ workflowId: workflow.id, attemptId: attempt.id });
    writeFileSync(path.join(h.repo, "greeting.txt"), "helo\n");
    expect(
      await recordResult(h.deps, {
        workflowId: workflow.id,
        expectedAttemptId: attempt.id,
        text: before,
      }),
    ).toMatchObject({
      ok: false,
      code: "stale-revision",
    });
    const first = h.writerResult({ workflowId: workflow.id, attemptId: attempt.id });
    expect(
      await recordResult(h.deps, {
        workflowId: workflow.id,
        expectedAttemptId: attempt.id,
        text: first,
      }),
    ).toMatchObject({ ok: true });

    // Verification waits for a positively stopped writer: working, blocked, unknown all refuse.
    for (const status of ["working", "blocked", "unknown"] as const) {
      writerPane(h, workflow.id).status = status;
      expect(
        await verifyWorkflow(h.deps, { workflowId: workflow.id, expectedAttemptId: attempt.id }),
      ).toMatchObject({
        ok: false,
        code: "not-stopped",
      });
    }
    writerPane(h, workflow.id).status = "idle";
    const lanes = await verifiedLanes(h, workflow.id, attempt.id);
    expect(lanes.map((lane) => lane.descriptor)).toEqual([
      "codex:gpt-6.1-sol@xhigh",
      "claude:claude-opus-5-5@high",
    ]);
    expect(h.herdr.prompts).toHaveLength(3);
    expect(h.herdr.prompts[1]!.text).toContain(`read-only verification lane ${lanes[0]!.laneId}`);
    // Verifiers never take the worktree.
    expect(h.dispatch.store.ownerOf(workflow.worktreeId)?.taskId).toBe(workflow.taskId);

    for (const [lane, status] of [
      [lanes[0]!, "pass"],
      [lanes[1]!, "fail"],
    ] as const) {
      const text = h.verifierResult({
        workflowId: workflow.id,
        attemptId: attempt.id,
        laneId: lane.laneId,
        status,
      });
      expect(
        await recordResult(h.deps, {
          workflowId: workflow.id,
          expectedAttemptId: attempt.id,
          text,
          laneId: lane.laneId,
        }),
      ).toMatchObject({ ok: true });
    }
    expect(h.workflows.get(workflow.id)!.state).toBe("reviewed");
    const refused = await acceptWorkflow(h.deps, {
      workflowId: workflow.id,
      expectedAttemptId: attempt.id,
      evidence: "looks fine",
    });
    expect(refused).toMatchObject({ ok: false, code: "verification-incomplete" });

    // The revision goes to the same agent in the same pane as a new attempt; nothing new is split.
    const splitsBefore = h.herdr.calls.filter((call) => call[1] === "split").length;
    const revised = await reviseWorkflow(h.deps, {
      workflowId: workflow.id,
      expectedAttemptId: attempt.id,
      delta: "Spell hello correctly.",
    });
    if (!revised.ok) throw new Error(revised.error);
    const second = revised.value.attempt;
    expect(second).toMatchObject({ seq: 2, purpose: "revision", sendState: "working" });
    expect(h.herdr.prompts.at(-1)).toMatchObject({ target: identity.agentName });
    expect(h.herdr.prompts.at(-1)!.text).toContain("Spell hello correctly.");
    expect(h.herdr.calls.filter((call) => call[1] === "split")).toHaveLength(splitsBefore);

    writeFileSync(path.join(h.repo, "greeting.txt"), "hello\n");
    // The old attempt's result cannot answer the new attempt.
    expect(
      await recordResult(h.deps, {
        workflowId: workflow.id,
        expectedAttemptId: attempt.id,
        text: h.writerResult({ workflowId: workflow.id, attemptId: attempt.id }),
      }),
    ).toMatchObject({
      ok: false,
      code: "stale-attempt",
    });
    expect(
      await recordResult(h.deps, {
        workflowId: workflow.id,
        expectedAttemptId: second.id,
        text: h.writerResult({ workflowId: workflow.id, attemptId: second.id }),
      }),
    ).toMatchObject({ ok: true });
    const relanes = await verifiedLanes(h, workflow.id, second.id);
    for (const lane of relanes) {
      const text = h.verifierResult({
        workflowId: workflow.id,
        attemptId: second.id,
        laneId: lane.laneId,
        status: "pass",
      });
      expect(
        await recordResult(h.deps, {
          workflowId: workflow.id,
          expectedAttemptId: second.id,
          text,
          laneId: lane.laneId,
        }),
      ).toMatchObject({ ok: true });
    }

    // Content changed after verification: acceptance refuses; restoring it is accepted.
    writeFileSync(path.join(h.repo, "greeting.txt"), "hello!\n");
    expect(
      await acceptWorkflow(h.deps, {
        workflowId: workflow.id,
        expectedAttemptId: second.id,
        evidence: "ok",
      }),
    ).toMatchObject({ ok: false, code: "revision-changed" });
    writeFileSync(path.join(h.repo, "greeting.txt"), "hello\n");
    expect(
      await acceptWorkflow(h.deps, {
        workflowId: workflow.id,
        expectedAttemptId: attempt.id,
        evidence: "ok",
      }),
    ).toMatchObject({ ok: false, code: "stale-attempt" });
    expect(
      await acceptWorkflow(h.deps, {
        workflowId: workflow.id,
        expectedAttemptId: second.id,
        evidence: "both checkers pass",
      }),
    ).toMatchObject({ ok: true });
    // Acceptance releases nothing.
    expect(h.dispatch.store.ownerOf(workflow.worktreeId)?.taskId).toBe(workflow.taskId);
    expect(
      await releaseWorkflow(h.deps, { workflowId: workflow.id, evidence: "done", abort: false }),
    ).toMatchObject({ ok: false, code: "state-conflict" });

    // Delivery: a commit of exactly the accepted content moves HEAD forward and is accepted.
    commitAll(h.repo, "deliver greeting");
    expect(
      recordDelivery(h.deps, {
        workflowId: workflow.id,
        evidence: "commit on branch",
        notApplicable: false,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await releaseWorkflow(h.deps, {
        workflowId: workflow.id,
        evidence: "commit on branch",
        abort: false,
      }),
    ).toMatchObject({ ok: true });
    const closed = h.workflows.get(workflow.id)!;
    expect(closed.state).toBe("released");
    expect(h.dispatch.store.ownerOf(workflow.worktreeId)).toBeUndefined();
    expect(h.dispatch.store.getTask(workflow.taskId!)?.status).toBe("complete");
    expect(workflowReport(h.deps, workflow.id)!.next).toEqual([]);
  });

  async function acceptedWorkflow(h: Harness, setup?: () => void) {
    setup?.();
    const { workflow, attempt } = await started(h);
    writeFileSync(path.join(h.repo, "greeting.txt"), "hello\n");
    writeFileSync(path.join(h.repo, "notes.txt"), "second accepted file\n");
    await recordResult(h.deps, {
      workflowId: workflow.id,
      expectedAttemptId: attempt.id,
      text: h.writerResult({ workflowId: workflow.id, attemptId: attempt.id }),
    });
    for (const lane of await verifiedLanes(h, workflow.id, attempt.id)) {
      await recordResult(h.deps, {
        workflowId: workflow.id,
        expectedAttemptId: attempt.id,
        laneId: lane.laneId,
        text: h.verifierResult({
          workflowId: workflow.id,
          attemptId: attempt.id,
          laneId: lane.laneId,
          status: "pass",
        }),
      });
    }
    const accepted = await acceptWorkflow(h.deps, {
      workflowId: workflow.id,
      expectedAttemptId: attempt.id,
      evidence: "both checkers pass",
    });
    expect(accepted).toMatchObject({ ok: true });
    return workflow;
  }

  it("records a commit as delivered only when its tree holds exactly the accepted files", async () => {
    const h = harness();
    const workflow = await acceptedWorkflow(h);
    // The standalone acceptance keeps its evidence.
    expect(h.workflows.get(workflow.id)!.accepted?.evidence).toBe("both checkers pass");
    // A partial commit leaves notes.txt dirty in the worktree: the commit is not the delivery.
    gitIn(h.repo, "add", "greeting.txt");
    gitIn(h.repo, "commit", "-q", "-m", "partial");
    const partial = recordDelivery(h.deps, {
      workflowId: workflow.id,
      evidence: "commit on branch",
      notApplicable: false,
    });
    expect(partial).toMatchObject({ ok: false, code: "commit-content" });
    expect(
      recordDelivery(h.deps, { workflowId: workflow.id, evidence: "n/a", notApplicable: true }),
    ).toMatchObject({
      ok: false,
      code: "content-changed",
    });
    // Committing the rest makes HEAD hold exactly the accepted content.
    commitAll(h.repo, "rest");
    const full = recordDelivery(h.deps, {
      workflowId: workflow.id,
      evidence: "commit on branch",
      notApplicable: false,
    });
    expect(full).toMatchObject({ ok: true });
    expect(h.workflows.get(workflow.id)!.delivery).toMatchObject({
      kind: "delivered",
      head: gitIn(h.repo, "rev-parse", "HEAD").trim(),
    });
  });

  it("refuses commit evidence when the accepted worktree also held unrelated dirty files", async () => {
    const h = harness();
    // Unrelated work in progress was already in the worktree at the baseline.
    const workflow = await acceptedWorkflow(h, () =>
      writeFileSync(path.join(h.repo, "wip.txt"), "unrelated draft\n"),
    );
    gitIn(h.repo, "add", "greeting.txt", "notes.txt");
    gitIn(h.repo, "commit", "-q", "-m", "task files only");
    expect(
      recordDelivery(h.deps, {
        workflowId: workflow.id,
        evidence: "task commit",
        notApplicable: false,
      }),
    ).toMatchObject({ ok: false, code: "commit-content" });
    // A named older commit that lacks the work is refused the same way.
    expect(
      recordDelivery(h.deps, {
        workflowId: workflow.id,
        evidence: "baseline",
        notApplicable: false,
        commit: "HEAD~1",
      }),
    ).toMatchObject({ ok: false, code: "commit-content" });
    // Local-only delivery still works while nothing moved.
    gitIn(h.repo, "reset", "-q", "--soft", "HEAD~1");
    expect(
      recordDelivery(h.deps, {
        workflowId: workflow.id,
        evidence: "local only",
        notApplicable: true,
      }),
    ).toMatchObject({ ok: true });
  });

  it("keeps an unknown send unknown: no result, no revision, no resend, until recovery records evidence", async () => {
    const herdr = fakeHerdr({ prompt: () => failed("", "connection reset") });
    const h = harness({ herdr });
    const { workflow, attempt } = await started(h);
    expect(attempt.sendState).toBe("unknown");
    expect(h.workflows.get(workflow.id)!.state).toBe("unknown");
    const text = h.writerResult({ workflowId: workflow.id, attemptId: attempt.id });
    expect(
      await recordResult(h.deps, { workflowId: workflow.id, expectedAttemptId: attempt.id, text }),
    ).toMatchObject({ ok: false, code: "state-conflict" });
    expect(
      await reviseWorkflow(h.deps, {
        workflowId: workflow.id,
        expectedAttemptId: attempt.id,
        delta: "again",
      }),
    ).toMatchObject({ ok: false, code: "state-conflict" });
    expect(h.herdr.prompts).toHaveLength(1);
    const report = workflowReport(h.deps, workflow.id)!;
    expect(report.next.join("\n")).not.toMatch(/start|revise/);
    // Recovery with pane evidence resolves the attempt without sending anything.
    const recovered = await recoverWorkflow(h.deps, {
      workflowId: workflow.id,
      observed: { delivered: true, evidence: "prompt visible in pane" },
    });
    expect(recovered.ok && recovered.value.report.workflow.state).toBe("dispatched");
    expect(h.herdr.prompts).toHaveLength(1);
    expect(
      await recordResult(h.deps, {
        workflowId: workflow.id,
        expectedAttemptId: attempt.id,
        text: h.writerResult({ workflowId: workflow.id, attemptId: attempt.id }),
      }),
    ).toMatchObject({ ok: true });
  });

  it("refuses to bind a writer whose Herdr record has no session, and sends nothing", async () => {
    const herdr = fakeHerdr({ detect: () => ({ session: undefined }) });
    const h = harness({ herdr });
    const result = await startWorkflow(h.deps, { brief: BRIEF, cwd: h.repo });
    expect(result).toMatchObject({ ok: false, code: "writer-not-started" });
    expect(!result.ok && result.error).toContain("must report its session");
    expect(h.herdr.prompts).toEqual([]);
    expect(h.herdr.calls).toContainEqual(["pane", "close", "w1:p1"]);
    expect(h.workflows.list(5)[0]!.state).toBe("failed");
    expect(h.dispatch.store.ownerOf(h.workflows.list(5)[0]!.worktreeId)).toBeUndefined();
  });

  it("refuses a revision when the bound session changed in the same pane, without relaunching", async () => {
    const h = harness();
    const { workflow, attempt } = await started(h);
    writeFileSync(path.join(h.repo, "greeting.txt"), "hello\n");
    await recordResult(h.deps, {
      workflowId: workflow.id,
      expectedAttemptId: attempt.id,
      text: h.writerResult({ workflowId: workflow.id, attemptId: attempt.id }),
    });
    writerPane(h, workflow.id).session = "sess-replaced";
    expect(
      await reviseWorkflow(h.deps, {
        workflowId: workflow.id,
        expectedAttemptId: attempt.id,
        delta: "more",
      }),
    ).toMatchObject({ ok: false, code: "session-changed" });
    expect(h.herdr.prompts).toHaveLength(1);
    expect(h.workflows.attempts(workflow.id)).toHaveLength(1);
    expect(
      await releaseWorkflow(h.deps, {
        workflowId: workflow.id,
        evidence: "writer replaced",
        abort: true,
      }),
    ).toMatchObject({ ok: false, code: "session-changed" });
  });

  it("refuses coordinator steps from the writer's own pane", async () => {
    const h = harness();
    const { workflow, attempt } = await started(h);
    writeFileSync(path.join(h.repo, "greeting.txt"), "hello\n");
    const asWorker = { ...h.deps, callerEnv: { HERDR_PANE_ID: workflow.identity!.paneId } };
    const text = h.writerResult({ workflowId: workflow.id, attemptId: attempt.id });
    expect(
      await recordResult(asWorker, {
        workflowId: workflow.id,
        expectedAttemptId: attempt.id,
        text,
      }),
    ).toMatchObject({ ok: false, code: "worker-caller" });
    expect(
      await releaseWorkflow(asWorker, { workflowId: workflow.id, evidence: "x", abort: true }),
    ).toMatchObject({ ok: false, code: "worker-caller" });
  });

  it("aborts only a positively stopped writer and frees the worktree", async () => {
    const h = harness();
    const { workflow } = await started(h);
    writerPane(h, workflow.id).status = "unknown";
    expect(
      await releaseWorkflow(h.deps, { workflowId: workflow.id, evidence: "stop", abort: true }),
    ).toMatchObject({ ok: false, code: "not-stopped" });
    writerPane(h, workflow.id).gone = true;
    expect(
      await releaseWorkflow(h.deps, { workflowId: workflow.id, evidence: "stop", abort: true }),
    ).toMatchObject({ ok: false, code: "agent-missing" });
    writerPane(h, workflow.id).gone = false;
    writerPane(h, workflow.id).status = "idle";
    expect(
      await releaseWorkflow(h.deps, { workflowId: workflow.id, evidence: "stop", abort: true }),
    ).toMatchObject({ ok: true });
    expect(h.workflows.get(workflow.id)!.state).toBe("aborted");
    expect(h.dispatch.store.ownerOf(workflow.worktreeId)).toBeUndefined();
  });

  it("refuses a second workflow or writer on the same worktree", async () => {
    const h = harness();
    await started(h);
    expect(await startWorkflow(h.deps, { brief: BRIEF, cwd: h.repo })).toMatchObject({
      ok: false,
      code: "open-workflow",
    });
    expect(h.herdr.prompts).toHaveLength(1);
  });

  it("aborts a start that crashed before binding a writer, and only that", async () => {
    const h = harness();
    const { workflow } = h.workflows.createWorkflow({
      worktreeId: "/work/crashed",
      backend: "standalone",
      briefSha256: "c".repeat(64),
      writerRole: "writer",
      writerDescriptor: "claude:claude-opus-5-5@high",
      cwd: h.repo,
      baseline: h.revision(),
      promptSha256: "d".repeat(64),
    });
    // The start crashed: its operation slot names a process that no longer exists.
    h.db.prepare("update workflows set op_pid = ? where id = ?").run(DEAD_PID, workflow.id);
    expect(
      await releaseWorkflow(h.deps, { workflowId: workflow.id, evidence: "x", abort: false }),
    ).toMatchObject({ ok: false, code: "state-conflict" });
    expect(
      await releaseWorkflow(h.deps, {
        workflowId: workflow.id,
        evidence: "router crashed during start",
        abort: true,
      }),
    ).toMatchObject({ ok: true });
    expect(h.workflows.get(workflow.id)!.state).toBe("aborted");
  });
});
