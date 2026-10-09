import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { worktreeIdentity } from "../../src/rules/rules-source.js";
import { sha256 } from "../../src/workflow/contracts.js";
import {
  acceptWorkflow,
  recordDelivery,
  recordResult,
  recoverWorkflow,
  releaseWorkflow,
  reviseWorkflow,
  startWorkflow,
  verifyWorkflow,
} from "../../src/workflow/service.js";
import { fakeAgentCollab, type FakeCollab } from "../helpers/fake-agent-collab.js";
import { BRIEF, harness, type Harness } from "../helpers/workflow-harness.js";

/** One writer role per provider; the rules file alone decides which CLI and model run. */
const PROVIDER_RULES = [
  "---",
  "description: Synthetic multi-provider writer roles",
  "---",
  "writer: claude:claude-opus-5-5@high",
  "grok writer: grok:grok-4.7@high",
  "codex writer: codex:gpt-6.1-sol@high",
  "checkers: codex:gpt-6.1-sol@xhigh",
  "",
].join("\n");

const WRITERS = [
  { role: "writer", provider: "claude", model: "claude-opus-5-5" },
  { role: "grok writer", provider: "grok", model: "grok-4.7" },
  { role: "codex writer", provider: "codex", model: "gpt-6.1-sol" },
] as const;

function providerHarness(collab: FakeCollab): Harness {
  const h = harness({ collab: collab.port });
  writeFileSync(h.rulesFile, PROVIDER_RULES);
  h.workflows.setBinding(worktreeIdentity(h.repo), "agent-collab");
  return h;
}

async function writerResult(h: Harness, workflowId: string, attemptId: string) {
  const recorded = await recordResult(h.deps, {
    workflowId,
    expectedAttemptId: attemptId,
    text: h.writerResult({ workflowId, attemptId }),
  });
  if (!recorded.ok) throw new Error(`${recorded.code}: ${recorded.error}`);
}

async function passVerifiers(h: Harness, workflowId: string, attemptId: string) {
  const verified = await verifyWorkflow(h.deps, { workflowId, expectedAttemptId: attemptId });
  if (!verified.ok) throw new Error(`${verified.code}: ${verified.error}`);
  for (const lane of verified.value.lanes.flatMap((round) => round.lanes)) {
    const recorded = await recordResult(h.deps, {
      workflowId,
      expectedAttemptId: attemptId,
      laneId: lane.laneId,
      text: h.verifierResult({ workflowId, attemptId, laneId: lane.laneId, status: "pass" }),
    });
    if (!recorded.ok) throw new Error(`${recorded.code}: ${recorded.error}`);
  }
}

describe("MDC-selected writers on agent-collab (R1, R2, R5, R12, R13)", () => {
  it.each(WRITERS)(
    "runs a $provider writer end to end with agent-collab as the only prompt sender",
    async ({ role, provider, model }) => {
      const collab = fakeAgentCollab();
      const h = providerHarness(collab);
      const started = await startWorkflow(h.deps, {
        brief: { ...BRIEF, writerRole: role },
        cwd: h.repo,
      });
      if (!started.ok) throw new Error(`${started.code}: ${started.error}`);
      const { workflow, attempt } = started.value;
      expect(workflow.identity).toMatchObject({ kind: provider });
      // HMR started the CLI the rules file names; HMR itself prompted nothing.
      expect(h.herdr.scripts[0]).toMatch(
        new RegExp(`/${provider}' (\\\\\n[\\s\\S]*)?'--model' '${model}'`),
      );
      expect(h.herdr.prompts).toEqual([]);
      // Its tools run with the new pane's own Herdr context and directory, read at launch
      // time from that pane's shell (never copied from the coordinator's process).
      expect(h.herdr.scripts[0]).toContain(`cd '${h.repo}'`);
      expect(h.herdr.scripts[0]).toContain('${HERDR_PANE_ID+"HERDR_PANE_ID=$HERDR_PANE_ID"}');
      // Codex hands its tool commands only what its shell policy sets: the pane's own values.
      expect(h.herdr.scripts[0].includes("shell_environment_policy.set.HERDR_PANE_ID")).toBe(
        provider === "codex",
      );
      // The frozen route carries the rules file's exact choice and where it came from.
      const route = collab.state().runs.r1!.route;
      expect(route).toEqual({
        version: "hmr.rules-route/v1",
        provider,
        kind: provider,
        model,
        effort: "high",
        descriptor: `${provider}:${model}@high`,
        role,
        classification: "implementation",
        worktree: worktreeIdentity(h.repo),
        cwd: realpathSync(h.repo),
        rules_sha256: sha256(PROVIDER_RULES),
        policy_sha256: null,
        workflow_id: workflow.id,
        brief_sha256: workflow.briefSha256,
      });
      const acquire = collab.state().calls.find((call) => call.argv[0] === "acquire")!.argv;
      expect(acquire).toEqual(
        expect.arrayContaining(["--kind", provider, "--session", workflow.identity!.sessionId]),
      );

      writeFileSync(path.join(h.repo, "greeting.txt"), "helo\n");
      await writerResult(h, workflow.id, attempt.id);
      await passVerifiers(h, workflow.id, attempt.id);
      const revised = await reviseWorkflow(h.deps, {
        workflowId: workflow.id,
        expectedAttemptId: attempt.id,
        delta: "Fix the spelling.",
      });
      if (!revised.ok) throw new Error(revised.error);
      writeFileSync(path.join(h.repo, "greeting.txt"), "hello\n");
      const second = revised.value.attempt;
      await writerResult(h, workflow.id, second.id);
      await passVerifiers(h, workflow.id, second.id);
      expect(
        await acceptWorkflow(h.deps, {
          workflowId: workflow.id,
          expectedAttemptId: second.id,
          evidence: "checkers pass",
        }),
      ).toMatchObject({ ok: true });
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
      // Both prompts went to the one acquired run: no second writer, no SQLite lease.
      expect(collab.state().prompts.map((entry) => entry.attempt)).toEqual(["a1", "a2"]);
      expect(h.dispatch.store.ownerOf(workflow.worktreeId)).toBeUndefined();
      // HMR prompted only the read-only verifier lanes, never the writer.
      const writer = workflow.identity!;
      expect(h.herdr.prompts.length).toBeGreaterThan(0);
      expect(
        h.herdr.prompts.filter((p) => p.target === writer.agentName || p.target === writer.paneId),
      ).toEqual([]);
    },
  );

  it("refuses a writer kind this agent-collab does not offer, before any pane exists", async () => {
    const collab = fakeAgentCollab();
    collab.setMode({ capabilities: "claude-only" });
    const h = providerHarness(collab);
    expect(
      await startWorkflow(h.deps, { brief: { ...BRIEF, writerRole: "grok writer" }, cwd: h.repo }),
    ).toMatchObject({ ok: false, code: "backend-capability" });
    expect(h.herdr.calls).toEqual([]);
    expect(collab.commands()).toEqual([]);
  });

  it("refuses a Grok writer in a project pinned to Claude: no pane, prompt, fallback or rewrite", async () => {
    const collab = fakeAgentCollab();
    collab.setProject({
      model_policy: {
        source: "project-config",
        default: "claude-opus-5-5",
        bounded_small_fix: "claude-opus-5-5",
        allowed: ["claude-opus-5-5"],
      },
    });
    const h = providerHarness(collab);
    const started = await startWorkflow(h.deps, {
      brief: { ...BRIEF, writerRole: "grok writer" },
      cwd: h.repo,
    });
    expect(started).toMatchObject({ ok: false, code: "backend-model-policy" });
    expect(!started.ok && started.error).toContain("grok:grok-4.7@high");
    expect(h.herdr.calls).toEqual([]);
    expect(collab.commands()).toEqual([]);
    expect(readFileSync(h.rulesFile, "utf8")).toBe(PROVIDER_RULES);
    expect(h.workflows.list(5)).toEqual([]);
  });

  it("keeps a running writer's route when the rules file changes; a new workflow uses the new route", async () => {
    const collab = fakeAgentCollab();
    const h = providerHarness(collab);
    const started = await startWorkflow(h.deps, {
      brief: { ...BRIEF, writerRole: "grok writer" },
      cwd: h.repo,
    });
    if (!started.ok) throw new Error(started.error);
    const { workflow, attempt } = started.value;
    // The operator now routes the same role to Codex.
    writeFileSync(
      h.rulesFile,
      PROVIDER_RULES.replace(
        "grok writer: grok:grok-4.7@high",
        "grok writer: codex:gpt-6.1-sol@high",
      ),
    );
    writeFileSync(path.join(h.repo, "greeting.txt"), "helo\n");
    await writerResult(h, workflow.id, attempt.id);
    const revised = await reviseWorkflow(h.deps, {
      workflowId: workflow.id,
      expectedAttemptId: attempt.id,
      delta: "Fix the spelling.",
    });
    if (!revised.ok) throw new Error(revised.error);
    // Same Grok session, same acquired run: the revision did not re-plan the writer.
    expect(h.workflows.get(workflow.id)!.identity).toEqual(workflow.identity);
    expect(collab.commands().filter((command) => command === "acquire")).toHaveLength(1);
    expect(collab.state().runs.r1!.route).toMatchObject({ provider: "grok", model: "grok-4.7" });
    expect(h.herdr.scripts).toHaveLength(1);
  });

  it("refuses to start when the rules file changed after the writer route was planned", async () => {
    const collab = fakeAgentCollab();
    const h = providerHarness(collab);
    // The change lands while the backend preflight runs: after planning, before any pane.
    const capabilities = collab.port.capabilities.bind(collab.port);
    collab.port.capabilities = async () => {
      writeFileSync(
        h.rulesFile,
        PROVIDER_RULES.replace("grok:grok-4.7@high", "codex:gpt-6.1-sol@high"),
      );
      return capabilities();
    };
    const started = await startWorkflow(h.deps, {
      brief: { ...BRIEF, writerRole: "grok writer" },
      cwd: h.repo,
    });
    expect(started).toMatchObject({ ok: false, code: "rules-changed" });
    expect(h.herdr.calls).toEqual([]);
    expect(collab.commands()).toEqual([]);
  });

  it("refuses a Codex writer whose pane reports another directory of the same worktree", async () => {
    const collab = fakeAgentCollab();
    const h = providerHarness(collab);
    const sub = path.join(h.repo, "packages");
    mkdirSync(sub);
    const elsewhere = realpathSync(sub);
    h.herdr.panes.clear();
    const herdrDetect = h.herdr;
    const original = herdrDetect.runInPane.bind(herdrDetect);
    herdrDetect.runInPane = async (paneId, command) => {
      const ran = await original(paneId, command);
      herdrDetect.panes.get(paneId)!.cwd = elsewhere;
      return ran;
    };
    const started = await startWorkflow(h.deps, {
      brief: { ...BRIEF, writerRole: "codex writer" },
      cwd: h.repo,
    });
    expect(started).toMatchObject({ ok: false, code: "cwd-changed" });
    expect(collab.commands()).toEqual([]);
    expect(h.herdr.calls).toContainEqual(["pane", "close", "w1:p1"]);
  });

  it("never replays an unclear Grok dispatch; only status reconciles it", async () => {
    const collab = fakeAgentCollab();
    collab.setMode({ dispatch: "timeout" });
    const h = providerHarness(collab);
    const started = await startWorkflow(h.deps, {
      brief: { ...BRIEF, writerRole: "grok writer" },
      cwd: h.repo,
    });
    expect(started.ok && started.value.attempt.sendState).toBe("unknown");
    const workflow = h.workflows.list(1)[0]!;
    expect(
      await reviseWorkflow(h.deps, {
        workflowId: workflow.id,
        expectedAttemptId: h.workflows.currentAttempt(workflow.id)!.id,
        delta: "again",
      }),
    ).toMatchObject({ ok: false });
    const recovered = await recoverWorkflow(h.deps, { workflowId: workflow.id });
    expect(recovered.ok && recovered.value.report.workflow.state).toBe("dispatched");
    expect(collab.commands()).toEqual(["acquire", "dispatch", "status"]);
    expect(collab.state().prompts).toHaveLength(1);
  });
});
