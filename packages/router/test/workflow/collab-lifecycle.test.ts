import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { worktreeIdentity } from "../../src/rules/rules-source.js";
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
import { FAKE_OWNER, fakeAgentCollab, type FakeCollab } from "../helpers/fake-agent-collab.js";
import { BRIEF, harness, type Harness } from "../helpers/workflow-harness.js";

function collabHarness(collab: FakeCollab | undefined): Harness {
  const h = harness(collab ? { collab: collab.port } : {});
  h.workflows.setBinding(worktreeIdentity(h.repo), "agent-collab");
  return h;
}

/** Every text value stored anywhere in the router database. */
function databaseText(h: Harness): string {
  const tables = h.db.prepare("select name from sqlite_master where type = 'table'").all() as {
    name: string;
  }[];
  return tables
    .map((table) => JSON.stringify(h.db.prepare(`select * from ${table.name}`).all()))
    .join("\n");
}

async function passAllVerifiers(h: Harness, workflowId: string, attemptId: string) {
  const verified = await verifyWorkflow(h.deps, { workflowId, expectedAttemptId: attemptId });
  if (!verified.ok) throw new Error(`${verified.code}: ${verified.error}`);
  for (const lane of verified.value.lanes.flatMap((round) => round.lanes)) {
    const text = h.verifierResult({ workflowId, attemptId, laneId: lane.laneId, status: "pass" });
    const recorded = await recordResult(h.deps, {
      workflowId,
      expectedAttemptId: attemptId,
      text,
      laneId: lane.laneId,
    });
    if (!recorded.ok) throw new Error(recorded.error);
  }
}

describe("agent-collab backend (fake agent-collab process)", () => {
  it("runs the whole workflow through agent-collab, holding its lease across review, with no SQLite writer lease", async () => {
    const collab = fakeAgentCollab();
    const h = collabHarness(collab);
    const started = await startWorkflow(h.deps, { brief: BRIEF, cwd: h.repo });
    if (!started.ok) throw new Error(`${started.code}: ${started.error}`);
    const { workflow, attempt } = started.value;
    expect(workflow).toMatchObject({
      backend: "agent-collab",
      state: "dispatched",
      externalRunId: "r1",
    });
    expect(attempt).toMatchObject({ sendState: "sent", backendAttempt: "a1" });
    // HMR started the native CLI (env -i script), then agent-collab was the only prompt sender.
    expect(h.herdr.scripts[0]).toContain("exec /usr/bin/env -i");
    expect(h.herdr.prompts).toEqual([]);
    expect(collab.commands()).toEqual(["acquire", "dispatch"]);
    const calls = collab.state().calls.map((call) => call.argv);
    // The read-only preflight runs first, before any pane exists.
    expect(calls.slice(0, 2).map((argv) => argv[0])).toEqual(["verify", "project"]);
    const acquire = calls.find((argv) => argv[0] === "acquire")!;
    const identity = workflow.identity!;
    expect(acquire).toEqual(
      expect.arrayContaining([
        "--pane",
        identity.paneId,
        "--session",
        identity.sessionId,
        "--kind",
        "claude",
        "--agent",
        identity.agentName,
      ]),
    );
    expect(collab.state().prompts[0]!.prompt).toContain(
      `HMR workflow ${workflow.id}, attempt ${attempt.id}`,
    );
    expect(h.dispatch.store.ownerOf(workflow.worktreeId)).toBeUndefined();

    writeFileSync(path.join(h.repo, "greeting.txt"), "helo\n");
    expect(
      await recordResult(h.deps, {
        workflowId: workflow.id,
        expectedAttemptId: attempt.id,
        text: h.writerResult({ workflowId: workflow.id, attemptId: attempt.id }),
      }),
    ).toMatchObject({ ok: true });
    await passAllVerifiers(h, workflow.id, attempt.id);
    const revised = await reviseWorkflow(h.deps, {
      workflowId: workflow.id,
      expectedAttemptId: attempt.id,
      delta: "Fix the spelling.",
    });
    if (!revised.ok) throw new Error(revised.error);
    expect(revised.value.attempt).toMatchObject({ backendAttempt: "a2", sendState: "sent" });
    writeFileSync(path.join(h.repo, "greeting.txt"), "hello\n");
    const second = revised.value.attempt;
    expect(
      await recordResult(h.deps, {
        workflowId: workflow.id,
        expectedAttemptId: second.id,
        text: h.writerResult({ workflowId: workflow.id, attemptId: second.id }),
      }),
    ).toMatchObject({ ok: true });
    await passAllVerifiers(h, workflow.id, second.id);
    expect(
      await acceptWorkflow(h.deps, {
        workflowId: workflow.id,
        expectedAttemptId: second.id,
        evidence: "checkers pass",
      }),
    ).toMatchObject({ ok: true });
    // Acceptance did not release the external lease.
    expect(collab.state().runs.r1!.state).toBe("accepted");
    expect(
      recordDelivery(h.deps, {
        workflowId: workflow.id,
        evidence: "local-only task",
        notApplicable: true,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await releaseWorkflow(h.deps, {
        workflowId: workflow.id,
        evidence: "nothing to deliver",
        abort: false,
      }),
    ).toMatchObject({ ok: true });
    expect(collab.commands()).toEqual([
      "acquire",
      "dispatch",
      "receipt",
      "request-changes",
      "dispatch",
      "receipt",
      "accept",
      "release",
    ]);
    expect(collab.state().runs.r1!.state).toBe("released");

    // The owner capability reaches agent-collab only as its --owner argument.
    const report = JSON.stringify(workflowReport(h.deps, workflow.id));
    expect(report).not.toContain(FAKE_OWNER);
    expect(databaseText(h)).not.toContain(FAKE_OWNER);
    expect(
      collab
        .state()
        .prompts.map((entry) => entry.prompt)
        .join("\n"),
    ).not.toContain(FAKE_OWNER);
    const artifacts = readdirSync(path.join(h.home, "workflows", workflow.id));
    expect(artifacts).not.toContain("owner-capability");
    for (const name of artifacts) {
      expect(readFileSync(path.join(h.home, "workflows", workflow.id, name), "utf8")).not.toContain(
        FAKE_OWNER,
      );
    }
    for (const call of collab.state().calls) {
      const at = call.argv.indexOf(FAKE_OWNER);
      if (at >= 0) expect(call.argv[at - 1]).toBe("--owner");
      // Only the allowlisted environment reaches the subprocess.
      expect(call.envKeys).not.toEqual(expect.arrayContaining(["OPENAI_API_KEY"]));
      expect(call.envKeys.filter((key) => /API_KEY/.test(key))).toEqual([]);
    }
  });

  it("treats a lost acquire response as unknown: the pane stays, nothing is re-acquired or sent", async () => {
    const collab = fakeAgentCollab({ timeoutMs: 1500 });
    collab.setMode({ acquire: "hang" });
    const h = collabHarness(collab);
    const started = await startWorkflow(h.deps, { brief: BRIEF, cwd: h.repo });
    expect(started).toMatchObject({ ok: false, code: "acquire-unknown" });
    const workflow = h.workflows.list(1)[0]!;
    expect(workflow.state).toBe("unknown");
    expect(h.workflows.intents(workflow.id)).toMatchObject([
      { operation: "acquire", state: "unknown" },
    ]);
    expect(h.herdr.calls.some((call) => call[1] === "close")).toBe(false);
    collab.setMode({});
    expect(await startWorkflow(h.deps, { brief: BRIEF, cwd: h.repo })).toMatchObject({
      ok: false,
      code: "open-workflow",
    });
    expect(collab.commands()).toEqual(["acquire"]);
    expect(h.herdr.prompts).toEqual([]);
  }, 20_000);

  it("closes its new pane when agent-collab refuses the acquire", async () => {
    const collab = fakeAgentCollab();
    collab.setMode({ acquire: "refuse" });
    const h = collabHarness(collab);
    expect(await startWorkflow(h.deps, { brief: BRIEF, cwd: h.repo })).toMatchObject({
      ok: false,
      code: "backend-refused",
    });
    expect(h.herdr.calls).toContainEqual(["pane", "close", "w1:p1"]);
    expect(h.workflows.list(1)[0]!.state).toBe("failed");
  });

  it("keeps an unclear dispatch unknown and only reconciles it from agent-collab status", async () => {
    const collab = fakeAgentCollab();
    collab.setMode({ dispatch: "timeout" });
    const h = collabHarness(collab);
    const started = await startWorkflow(h.deps, { brief: BRIEF, cwd: h.repo });
    expect(started.ok && started.value.attempt.sendState).toBe("unknown");
    const workflow = h.workflows.list(1)[0]!;
    const attempt = h.workflows.currentAttempt(workflow.id)!;
    expect(
      await reviseWorkflow(h.deps, {
        workflowId: workflow.id,
        expectedAttemptId: attempt.id,
        delta: "again",
      }),
    ).toMatchObject({ ok: false });
    const recovered = await recoverWorkflow(h.deps, { workflowId: workflow.id });
    expect(recovered.ok && recovered.value.report.workflow.state).toBe("dispatched");
    expect(h.workflows.currentAttempt(workflow.id)!.sendState).toBe("sent");
    expect(collab.commands()).toEqual(["acquire", "dispatch", "status"]);
  });

  it("refuses without agent-collab instead of falling back to a standalone lease", async () => {
    const h = collabHarness(undefined);
    expect(await startWorkflow(h.deps, { brief: BRIEF, cwd: h.repo })).toMatchObject({
      ok: false,
      code: "backend-unavailable",
    });
    expect(h.herdr.calls).toEqual([]);
    expect(h.workflows.list(5)).toEqual([]);
  });

  it("refuses a non-Claude writer on the agent-collab backend before any process starts", async () => {
    const collab = fakeAgentCollab();
    const h = collabHarness(collab);
    expect(
      await startWorkflow(h.deps, { brief: { ...BRIEF, writerRole: "codex writer" }, cwd: h.repo }),
    ).toMatchObject({ ok: false, code: "backend-model" });
    expect(h.herdr.calls).toEqual([]);
    expect(collab.commands()).toEqual([]);
  });
});
