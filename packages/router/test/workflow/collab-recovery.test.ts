import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { worktreeIdentity } from "../../src/rules/rules-source.js";
import type { AgentCollabPort, CollabCall } from "../../src/workflow/agent-collab.js";
import { createAgentCollab } from "../../src/workflow/agent-collab.js";
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
import { fakeAgentCollab, type FakeCollab } from "../helpers/fake-agent-collab.js";
import { BRIEF, harness, WORKFLOW_RULES, type Harness } from "../helpers/workflow-harness.js";

type Operation = "dispatch" | "receipt" | "requestChanges" | "accept" | "release";

/**
 * The real fake process applies the call, then the reply is lost: the adapter reports an
 * unknown outcome although agent-collab changed its state.
 */
function lossy(
  port: AgentCollabPort,
  lose: Operation,
  counts: Record<string, number>,
): AgentCollabPort {
  const wrap =
    <A, T>(name: Operation, call: (input: A) => Promise<CollabCall<T>>) =>
    async (input: A): Promise<CollabCall<T>> => {
      counts[name] = (counts[name] ?? 0) + 1;
      const result = await call(input);
      return name === lose ? { kind: "unknown", error: "reply lost after the call" } : result;
    };
  return {
    ...port,
    dispatch: wrap("dispatch", port.dispatch),
    receipt: wrap("receipt", port.receipt),
    requestChanges: wrap("requestChanges", port.requestChanges),
    accept: wrap("accept", port.accept),
    release: wrap("release", port.release),
  };
}

function collabHarness(port: AgentCollabPort): Harness {
  const h = harness({ collab: port });
  h.workflows.setBinding(worktreeIdentity(h.repo), "agent-collab");
  return h;
}

async function startedCollab(h: Harness) {
  const started = await startWorkflow(h.deps, { brief: BRIEF, cwd: h.repo });
  if (!started.ok) throw new Error(`${started.code}: ${started.error}`);
  return started.value;
}

async function writerResult(h: Harness, workflowId: string, attemptId: string) {
  return recordResult(h.deps, {
    workflowId,
    expectedAttemptId: attemptId,
    text: h.writerResult({ workflowId, attemptId }),
  });
}

async function passVerifiers(h: Harness, workflowId: string, attemptId: string) {
  const verified = await verifyWorkflow(h.deps, { workflowId, expectedAttemptId: attemptId });
  if (!verified.ok) throw new Error(verified.error);
  for (const lane of verified.value.lanes.flatMap((round) => round.lanes)) {
    const recorded = await recordResult(h.deps, {
      workflowId,
      expectedAttemptId: attemptId,
      laneId: lane.laneId,
      text: h.verifierResult({ workflowId, attemptId, laneId: lane.laneId, status: "pass" }),
    });
    if (!recorded.ok) throw new Error(recorded.error);
  }
}

describe("agent-collab replies lost after the effect (KTD12)", () => {
  it("reconciles a lost receipt from status, blocking other mutations until then", async () => {
    const fake = fakeAgentCollab();
    const counts: Record<string, number> = {};
    const h = collabHarness(lossy(fake.port, "receipt", counts));
    const { workflow, attempt } = await startedCollab(h);
    writeFileSync(path.join(h.repo, "greeting.txt"), "hello\n");
    expect(await writerResult(h, workflow.id, attempt.id)).toMatchObject({
      ok: false,
      code: "backend-unknown",
    });
    expect(fake.state().runs.r1!.state).toBe("receipt");
    // Nothing else may mutate while the receipt is unresolved, and nothing is retried.
    expect(await writerResult(h, workflow.id, attempt.id)).toMatchObject({
      ok: false,
      code: "intent-unresolved",
    });
    expect(workflowReport(h.deps, workflow.id)!.next[0]).toContain(
      `workflow recover ${workflow.id}`,
    );
    const recovered = await recoverWorkflow(h.deps, { workflowId: workflow.id });
    expect(recovered.ok && recovered.value.reconciled).toMatchObject({ resolved: "applied" });
    expect(h.workflows.get(workflow.id)!.state).toBe("receipt");
    expect(h.workflows.getAttempt(attempt.id)!.result?.status).toBe("impl-complete");
    expect(counts.receipt).toBe(1);
  });

  it("reconciles a lost request-changes, then sends the pending revision once with --resume", async () => {
    const fake = fakeAgentCollab();
    const counts: Record<string, number> = {};
    const h = collabHarness(lossy(fake.port, "requestChanges", counts));
    const { workflow, attempt } = await startedCollab(h);
    writeFileSync(path.join(h.repo, "greeting.txt"), "helo\n");
    expect(await writerResult(h, workflow.id, attempt.id)).toMatchObject({ ok: true });
    const revised = await reviseWorkflow(h.deps, {
      workflowId: workflow.id,
      expectedAttemptId: attempt.id,
      delta: "Fix the spelling.",
    });
    expect(revised).toMatchObject({ ok: false, code: "backend-unknown" });
    // No local attempt exists until agent-collab is known to have opened one.
    expect(h.workflows.attempts(workflow.id)).toHaveLength(1);
    const recovered = await recoverWorkflow(h.deps, { workflowId: workflow.id });
    expect(recovered.ok && recovered.value.reconciled).toMatchObject({ resolved: "applied" });
    const pending = h.workflows.currentAttempt(workflow.id)!;
    expect(pending).toMatchObject({ backendAttempt: "a2", sendState: "pending" });
    expect(workflowReport(h.deps, workflow.id)!.next[0]).toContain("--resume");
    const resumed = await reviseWorkflow(h.deps, {
      workflowId: workflow.id,
      expectedAttemptId: pending.id,
      resume: true,
    });
    expect(resumed.ok && resumed.value.attempt.sendState).toBe("sent");
    expect(counts.requestChanges).toBe(1);
    expect(fake.state().prompts.filter((entry) => entry.attempt === "a2")).toHaveLength(1);
    // A second resume finds nothing pending and sends nothing.
    expect(
      await reviseWorkflow(h.deps, {
        workflowId: workflow.id,
        expectedAttemptId: pending.id,
        resume: true,
      }),
    ).toMatchObject({ ok: false });
    expect(fake.state().prompts.filter((entry) => entry.attempt === "a2")).toHaveLength(1);
  });

  it("reconciles a lost accept and a lost release without calling either again", async () => {
    for (const lose of ["accept", "release"] as const) {
      const fake = fakeAgentCollab();
      const counts: Record<string, number> = {};
      const h = collabHarness(lossy(fake.port, lose, counts));
      const { workflow, attempt } = await startedCollab(h);
      writeFileSync(path.join(h.repo, "greeting.txt"), "hello\n");
      expect(await writerResult(h, workflow.id, attempt.id)).toMatchObject({ ok: true });
      await passVerifiers(h, workflow.id, attempt.id);
      const accepted = await acceptWorkflow(h.deps, {
        workflowId: workflow.id,
        expectedAttemptId: attempt.id,
        evidence: "checkers pass",
      });
      if (lose === "accept") {
        expect(accepted).toMatchObject({ ok: false, code: "backend-unknown" });
        const recovered = await recoverWorkflow(h.deps, { workflowId: workflow.id });
        expect(recovered.ok && recovered.value.reconciled).toMatchObject({ resolved: "applied" });
        expect(h.workflows.get(workflow.id)!.accepted?.evidence).toBe("checkers pass");
      }
      expect(
        recordDelivery(h.deps, { workflowId: workflow.id, evidence: "local", notApplicable: true }),
      ).toMatchObject({
        ok: true,
      });
      const released = await releaseWorkflow(h.deps, {
        workflowId: workflow.id,
        evidence: "done",
        abort: false,
      });
      if (lose === "release") {
        expect(released).toMatchObject({ ok: false, code: "backend-unknown" });
        const recovered = await recoverWorkflow(h.deps, { workflowId: workflow.id });
        expect(recovered.ok && recovered.value.reconciled).toMatchObject({ resolved: "applied" });
      }
      expect(h.workflows.get(workflow.id)!.state).toBe("released");
      expect(counts[lose === "accept" ? "accept" : "release"]).toBe(1);
    }
    // Two full lifecycles through a real fake-agent-collab process each.
  }, 20_000);

  it("reconciles a lost dispatch from status as delivered, with exactly one submission", async () => {
    const fake = fakeAgentCollab();
    const counts: Record<string, number> = {};
    const h = collabHarness(lossy(fake.port, "dispatch", counts));
    const { workflow, attempt } = await startedCollab(h);
    expect(attempt.sendState).toBe("unknown");
    const recovered = await recoverWorkflow(h.deps, { workflowId: workflow.id });
    expect(recovered.ok && recovered.value.report.workflow.state).toBe("dispatched");
    expect(h.workflows.getAttempt(attempt.id)!.sendState).toBe("sent");
    expect(counts.dispatch).toBe(1);
    expect(fake.state().prompts).toHaveLength(1);
  });

  it("retries a refused receipt with the same result file, and refuses a different one", async () => {
    const fake = fakeAgentCollab();
    const h = collabHarness(fake.port);
    const { workflow, attempt } = await startedCollab(h);
    writeFileSync(path.join(h.repo, "greeting.txt"), "hello\n");
    const text = h.writerResult({ workflowId: workflow.id, attemptId: attempt.id });
    fake.setMode({ receipt: "refuse" });
    expect(
      await recordResult(h.deps, { workflowId: workflow.id, expectedAttemptId: attempt.id, text }),
    ).toMatchObject({
      ok: false,
      code: "backend-refused",
    });
    fake.setMode({});
    // The recorded result is immutable: different bytes for the same attempt are refused.
    const altered = text.replace('"impl-complete"', '"blocked"');
    expect(
      await recordResult(h.deps, {
        workflowId: workflow.id,
        expectedAttemptId: attempt.id,
        text: altered,
      }),
    ).toMatchObject({ ok: false, code: "artifact-conflict" });
    expect(
      await recordResult(h.deps, { workflowId: workflow.id, expectedAttemptId: attempt.id, text }),
    ).toMatchObject({
      ok: true,
    });
  });
});

/** A project constraint in agent-collab (a repo pin file), not its defaults. */
const PINNED = {
  source: "project-pin-file",
  default: "claude-opus-5-5",
  bounded_small_fix: "claude-sonnet-5-5",
  allowed: ["claude-opus-5-5", "claude-sonnet-5-5"],
};

describe("agent-collab preflight and dispatch wait (R5, KTD10)", () => {
  async function startWith(fake: FakeCollab, rules: string, classification?: "bounded-small-fix") {
    const h = collabHarness(fake.port);
    writeFileSync(h.rulesFile, rules);
    const brief = { ...BRIEF, ...(classification ? { classification } : {}) };
    return { h, started: await startWorkflow(h.deps, { brief, cwd: h.repo }) };
  }

  it("takes the rules file's exact model when the project sets no constraint", async () => {
    const fake = fakeAgentCollab();
    const { started } = await startWith(
      fake,
      WORKFLOW_RULES.replace("claude-opus-5-5@high", "claude-opus-4-8@high"),
    );
    expect(started).toMatchObject({ ok: true });
    // agent-collab received the rules file's model, not its own default.
    expect(fake.state().runs.r1!.route).toMatchObject({ model: "claude-opus-4-8", effort: "high" });
  });

  it("refuses a writer model the project constraint does not allow, before any pane exists", async () => {
    const fake = fakeAgentCollab();
    fake.setProject({ model_policy: PINNED });
    const { h, started } = await startWith(
      fake,
      WORKFLOW_RULES.replace("claude-opus-5-5@high", "claude-opus-4-8@high"),
    );
    expect(started).toMatchObject({ ok: false, code: "backend-model-policy" });
    expect(h.herdr.calls).toEqual([]);
    expect(fake.commands()).toEqual([]);
    expect(h.workflows.list(5)).toEqual([]);
  });

  it("uses a pinned project's small-fix model only for an explicitly classified brief", async () => {
    const sonnet = WORKFLOW_RULES.replace(
      "writer: claude:claude-opus-5-5@high",
      "writer: claude:claude-sonnet-5-5@high",
    );
    const pinned = () => {
      const fake = fakeAgentCollab();
      fake.setProject({ model_policy: PINNED });
      return fake;
    };
    // Allowed by the pin, but not the model for ordinary implementation.
    const plain = await startWith(pinned(), sonnet);
    expect(plain.started).toMatchObject({ ok: false, code: "backend-model-policy" });
    expect(plain.h.herdr.calls).toEqual([]);
    const small = await startWith(pinned(), sonnet, "bounded-small-fix");
    expect(small.started).toMatchObject({ ok: true });
    // And an explicit small fix routed to the default model is refused the same way.
    const wrong = await startWith(pinned(), WORKFLOW_RULES, "bounded-small-fix");
    expect(wrong.started).toMatchObject({ ok: false, code: "backend-model-policy" });
  });

  it("refuses when agent-collab's own preflight reports problems or another worktree", async () => {
    const problems = fakeAgentCollab();
    problems.setProject({ problems: ["HERDR_ENV != 1"] });
    const first = await startWith(problems, WORKFLOW_RULES);
    expect(first.started).toMatchObject({ ok: false, code: "backend-preflight" });
    expect(!first.started.ok && first.started.error).toContain("HERDR_ENV != 1");
    const elsewhere = fakeAgentCollab();
    elsewhere.setProject({ worktree: "/somewhere/else" });
    const second = await startWith(elsewhere, WORKFLOW_RULES);
    expect(second.started).toMatchObject({ ok: false, code: "backend-identity" });
    expect(second.h.herdr.calls).toEqual([]);
  });

  it("waits only for the writer to start working, so a long task is delivered, not unknown", async () => {
    const fake = fakeAgentCollab();
    fake.setMode({ dispatch: "long-task" });
    const h = collabHarness(fake.port);
    const started = await startWorkflow(h.deps, { brief: BRIEF, cwd: h.repo });
    expect(started.ok && started.value.attempt.sendState).toBe("sent");
    const dispatch = fake.state().calls.find((call) => call.argv[0] === "dispatch")!.argv;
    expect(dispatch).toEqual(
      expect.arrayContaining(["--wait", "--until", "working", "--until", "blocked"]),
    );
  });

  it("builds the dispatch argv with a bounded working wait (adapter contract)", async () => {
    let argv: readonly string[] = [];
    const port = createAgentCollab({
      executable: "/fake/agent-collab",
      run: async (call) => {
        argv = call;
        return {
          code: 0,
          stdout: JSON.stringify({
            ok: true,
            run_id: "r1",
            attempt: "a1",
            outcome: "submitted",
            sent: true,
          }),
          stderr: "",
          timedOut: false,
        };
      },
    });
    await port.dispatch({
      runId: "r1",
      owner: "a".repeat(48),
      attempt: "a1",
      promptFile: "/p",
      timeoutMs: 120_000,
    });
    expect(argv.slice(argv.indexOf("--wait"))).toEqual([
      "--wait",
      "--until",
      "working",
      "--until",
      "blocked",
      "--timeout-ms",
      "120000",
    ]);
  });
});

describe("reconciliation only from the exact run, session, pane and attempt (R15, R17)", () => {
  type Status = Extract<Awaited<ReturnType<AgentCollabPort["status"]>>, { kind: "ok" }>["value"];
  function withStatus(port: AgentCollabPort, rewrite: (status: Status) => Status): AgentCollabPort {
    return {
      ...port,
      status: async (input) => {
        const status = await port.status(input);
        return status.kind === "ok" ? { kind: "ok", value: rewrite(status.value) } : status;
      },
    };
  }

  it.each([
    ["another run", (status: Status) => ({ ...status, run_id: "foreign-run" })],
    ["another session", (status: Status) => ({ ...status, session: "foreign-session" })],
    ["no session", (status: Status) => ({ ...status, session: null })],
    ["another pane", (status: Status) => ({ ...status, pane: "w9:p9" })],
    ["another current attempt", (status: Status) => ({ ...status, current_attempt: "a9" })],
  ])("keeps a lost receipt unresolved when status names %s", async (_label, rewrite) => {
    const fake = fakeAgentCollab();
    const counts: Record<string, number> = {};
    const h = collabHarness(withStatus(lossy(fake.port, "receipt", counts), rewrite));
    const { workflow, attempt } = await startedCollab(h);
    writeFileSync(path.join(h.repo, "greeting.txt"), "hello\n");
    expect(await writerResult(h, workflow.id, attempt.id)).toMatchObject({
      ok: false,
      code: "backend-unknown",
    });
    const recovered = await recoverWorkflow(h.deps, { workflowId: workflow.id });
    expect(recovered.ok && recovered.value.reconciled).toMatchObject({ resolved: "unclear" });
    expect(h.workflows.get(workflow.id)!.state).toBe("dispatched");
    expect(h.workflows.getAttempt(attempt.id)!.result).toBeUndefined();
    expect(h.workflows.unresolvedIntent(workflow.id)).toMatchObject({ operation: "receipt" });
    expect(counts.receipt).toBe(1);
  });

  it("needs the attempt's own acceptance, not only an accepted run", async () => {
    const fake = fakeAgentCollab();
    const counts: Record<string, number> = {};
    const h = collabHarness(
      withStatus(lossy(fake.port, "accept", counts), (status) => ({
        ...status,
        attempts: status.attempts?.map((entry) => ({ ...entry, accepted_at: null })),
      })),
    );
    const { workflow, attempt } = await startedCollab(h);
    writeFileSync(path.join(h.repo, "greeting.txt"), "hello\n");
    expect(await writerResult(h, workflow.id, attempt.id)).toMatchObject({ ok: true });
    await passVerifiers(h, workflow.id, attempt.id);
    expect(
      await acceptWorkflow(h.deps, {
        workflowId: workflow.id,
        expectedAttemptId: attempt.id,
        evidence: "ok",
      }),
    ).toMatchObject({ ok: false, code: "backend-unknown" });
    const recovered = await recoverWorkflow(h.deps, { workflowId: workflow.id });
    expect(recovered.ok && recovered.value.reconciled).toMatchObject({ resolved: "unclear" });
    expect(h.workflows.get(workflow.id)!.state).toBe("reviewed");
  });

  it("links only the revision opened from the reviewed attempt", async () => {
    const fake = fakeAgentCollab();
    const counts: Record<string, number> = {};
    // agent-collab reports a current attempt that was not opened from the reviewed one.
    const h = collabHarness(
      withStatus(lossy(fake.port, "requestChanges", counts), (status) => ({
        ...status,
        attempts: status.attempts?.map((entry) =>
          entry.attempt_id === "a2" ? { ...entry, parent: "a0" } : entry,
        ),
      })),
    );
    const { workflow, attempt } = await startedCollab(h);
    writeFileSync(path.join(h.repo, "greeting.txt"), "helo\n");
    expect(await writerResult(h, workflow.id, attempt.id)).toMatchObject({ ok: true });
    expect(
      await reviseWorkflow(h.deps, {
        workflowId: workflow.id,
        expectedAttemptId: attempt.id,
        delta: "Fix it.",
      }),
    ).toMatchObject({ ok: false, code: "backend-unknown" });
    const recovered = await recoverWorkflow(h.deps, { workflowId: workflow.id });
    expect(recovered.ok && recovered.value.reconciled).toMatchObject({ resolved: "unclear" });
    expect(h.workflows.attempts(workflow.id)).toHaveLength(1);
    expect(h.workflows.get(workflow.id)!.state).toBe("receipt");
  });
});
