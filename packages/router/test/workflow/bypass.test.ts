import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { executeWorkflowStatus } from "../../src/commands/workflow-commands.js";
import { worktreeIdentity } from "../../src/rules/rules-source.js";
import { BYPASS_FLAGS } from "../../src/rules/native-argv.js";
import {
  recordResult,
  reviseWorkflow,
  startWorkflow,
  verifyWorkflow,
} from "../../src/workflow/service.js";
import { fakeAgentCollab } from "../helpers/fake-agent-collab.js";
import { BRIEF, harness, type Harness } from "../helpers/workflow-harness.js";

const RULES = [
  "writer: claude:claude-opus-5-5@high",
  "codex writer: codex:gpt-6.1-sol@high",
  "cursor writer: cursor:composer-2",
  "checkers: codex:gpt-6.1-sol@xhigh, claude:claude-opus-5-5@high",
  "",
].join("\n");

function bypassHarness(rules = RULES, options: Parameters<typeof harness>[0] = {}): Harness {
  const h = harness(options);
  writeFileSync(h.rulesFile, rules);
  return h;
}

/** The bypass flags a launch script passes as their own argv elements. */
function bypassFlags(script: string): string[] {
  return BYPASS_FLAGS.filter((flag) => script.includes(`'${flag}'`));
}

async function start(h: Harness, role: string, bypassPermissions?: boolean) {
  const started = await startWorkflow(h.deps, {
    brief: { ...BRIEF, writerRole: role },
    cwd: h.repo,
    ...(bypassPermissions ? { bypassPermissions } : {}),
  });
  if (!started.ok) throw new Error(`${started.code}: ${started.error}`);
  return started.value;
}

async function writerResult(h: Harness, workflowId: string, attemptId: string) {
  writeFileSync(path.join(h.repo, "greeting.txt"), `hello ${attemptId}\n`);
  const recorded = await recordResult(h.deps, {
    workflowId,
    expectedAttemptId: attemptId,
    text: h.writerResult({ workflowId, attemptId }),
  });
  if (!recorded.ok) throw new Error(`${recorded.code}: ${recorded.error}`);
  const pane = h.workflows.get(workflowId)!.identity!.paneId;
  h.herdr.panes.get(pane)!.status = "idle";
}

describe("workflow writer permission bypass", () => {
  it("launches the writer fenced by default, records no bypass and reports none", async () => {
    const h = bypassHarness();
    const { workflow } = await start(h, "writer");
    expect(workflow).not.toHaveProperty("writerBypass");
    expect(bypassFlags(h.herdr.scripts[0]!)).toEqual([]);
    expect(h.herdr.scripts[0]).toContain("'--permission-mode' 'dontAsk'");
    expect(executeWorkflowStatus(h.deps, workflow.id).output).not.toContain("Permissions:");
  });

  it("bypasses only the writer with --dangerously-bypass-permissions; verifiers stay read-only", async () => {
    const h = bypassHarness();
    const { workflow, attempt } = await start(h, "writer", true);
    expect(workflow.writerBypass).toBe("flag");
    expect(bypassFlags(h.herdr.scripts[0]!)).toEqual(["--dangerously-skip-permissions"]);
    expect(h.herdr.scripts[0]).not.toContain("--permission-mode");
    expect(executeWorkflowStatus(h.deps, workflow.id).output).toContain(
      "Permissions: bypass (from --dangerously-bypass-permissions). The writer's CLI skips its approvals and sandbox, so nothing keeps its writes inside this worktree",
    );
    expect(executeWorkflowStatus(h.deps, workflow.id).json).toMatchObject({
      workflow: { writerBypass: "flag" },
    });

    await writerResult(h, workflow.id, attempt.id);
    const verified = await verifyWorkflow(h.deps, {
      workflowId: workflow.id,
      expectedAttemptId: attempt.id,
    });
    expect(verified.ok).toBe(true);
    const verifiers = h.herdr.scripts.slice(1);
    expect(verifiers).toHaveLength(2);
    for (const script of verifiers) expect(bypassFlags(script)).toEqual([]);
    expect(verifiers[0]).toContain("'--sandbox' 'read-only'");
    expect(verifiers[1]).toContain("'--permission-mode' 'plan'");
  });

  it("bypasses a writer the rules file opts in, without the flag; verifiers stay read-only", async () => {
    const h = bypassHarness(`# hmr: bypass-permissions writer\n${RULES}`);
    const { workflow, attempt } = await start(h, "writer");
    expect(workflow.writerBypass).toBe("rules");
    expect(bypassFlags(h.herdr.scripts[0]!)).toEqual(["--dangerously-skip-permissions"]);
    expect(executeWorkflowStatus(h.deps, workflow.id).output).toContain(
      "Permissions: bypass (from the rules file's bypass-permissions)",
    );
    await writerResult(h, workflow.id, attempt.id);
    expect(
      await verifyWorkflow(h.deps, { workflowId: workflow.id, expectedAttemptId: attempt.id }),
    ).toMatchObject({ ok: true });
    for (const script of h.herdr.scripts.slice(1)) expect(bypassFlags(script)).toEqual([]);
  });

  it("refuses the flag for a read-only writer role before anything starts", async () => {
    const h = bypassHarness();
    const started = await startWorkflow(h.deps, {
      brief: { ...BRIEF, writerRole: "checkers" },
      cwd: h.repo,
      bypassPermissions: true,
    });
    expect(started).toMatchObject({ ok: false, code: "plan-refused" });
    expect(!started.ok && started.error).toContain("Refused (bypass-read-only)");
    expect(h.herdr.calls).toEqual([]);
    expect(h.workflows.list(5)).toEqual([]);
  });

  it("refuses a rules opt-in for a writer role that runs read-only before anything starts", async () => {
    const h = bypassHarness(`# hmr: bypass-permissions writer\n${RULES}`);
    mkdirSync(path.join(h.repo, ".model-router"));
    writeFileSync(
      path.join(h.repo, ".model-router", "policy.json"),
      JSON.stringify({ version: 1, writerRoles: ["codex writer"] }),
    );
    const started = await startWorkflow(h.deps, { brief: BRIEF, cwd: h.repo });
    expect(started).toMatchObject({ ok: false, code: "plan-refused" });
    expect(!started.ok && started.error).toContain("Refused (bypass-read-only)");
    expect(!started.ok && started.error).toContain('"# hmr: bypass-permissions" line');
    expect(h.herdr.calls).toEqual([]);
    expect(h.workflows.list(5)).toEqual([]);
  });

  it("obeys a project policy that forbids a bypass: the flag refuses, the rules opt-in runs fenced", async () => {
    const h = bypassHarness(`# hmr: bypass-permissions writer\n${RULES}`);
    mkdirSync(path.join(h.repo, ".model-router"));
    writeFileSync(
      path.join(h.repo, ".model-router", "policy.json"),
      JSON.stringify({ version: 1, forbidBypassPermissions: true }),
    );
    const refused = await startWorkflow(h.deps, {
      brief: BRIEF,
      cwd: h.repo,
      bypassPermissions: true,
    });
    expect(refused).toMatchObject({ ok: false, code: "plan-refused" });
    expect(!refused.ok && refused.error).toContain("Refused (bypass-forbidden)");
    expect(h.herdr.calls).toEqual([]);

    const { workflow } = await start(h, "writer");
    expect(workflow).not.toHaveProperty("writerBypass");
    expect(bypassFlags(h.herdr.scripts[0]!)).toEqual([]);
  });

  it("keeps the start's permissions on every revision; the flag cannot widen a fenced writer", async () => {
    const fenced = bypassHarness();
    const plain = await start(fenced, "writer");
    await writerResult(fenced, plain.workflow.id, plain.attempt.id);
    const prompts = fenced.herdr.prompts.length;
    const widened = await reviseWorkflow(fenced.deps, {
      workflowId: plain.workflow.id,
      expectedAttemptId: plain.attempt.id,
      delta: "Fix the spelling.",
      bypassPermissions: true,
    });
    expect(widened).toMatchObject({ ok: false, code: "bypass-not-started" });
    expect(fenced.herdr.prompts).toHaveLength(prompts);
    expect(fenced.workflows.attempts(plain.workflow.id)).toHaveLength(1);

    const h = bypassHarness();
    const { workflow, attempt } = await start(h, "writer", true);
    await writerResult(h, workflow.id, attempt.id);
    const restated = await reviseWorkflow(h.deps, {
      workflowId: workflow.id,
      expectedAttemptId: attempt.id,
      delta: "Fix the spelling.",
      bypassPermissions: true,
    });
    if (!restated.ok) throw new Error(`${restated.code}: ${restated.error}`);
    await writerResult(h, workflow.id, restated.value.attempt.id);
    const kept = await reviseWorkflow(h.deps, {
      workflowId: workflow.id,
      expectedAttemptId: restated.value.attempt.id,
      delta: "One more.",
    });
    if (!kept.ok) throw new Error(`${kept.code}: ${kept.error}`);
    // Same session throughout: one launch, and the record still says how it started.
    expect(h.herdr.scripts).toHaveLength(1);
    expect(kept.value.workflow.writerBypass).toBe("flag");
  });

  it("gives a Cursor writer --force with no per-launch config, sandbox flag or pane guard", async () => {
    const fencedHarness = bypassHarness();
    await start(fencedHarness, "cursor writer");
    expect(fencedHarness.herdr.scripts[0]).toContain("'--sandbox' 'enabled'");
    expect(fencedHarness.herdr.scripts[0]).toContain("CURSOR_CONFIG_DIR");

    const h = bypassHarness();
    const guard = vi.fn(() => ({ ok: true as const }));
    h.dispatch.startCursorGuard = guard;
    const { workflow } = await start(h, "cursor writer", true);
    expect(workflow.writerBypass).toBe("flag");
    const script = h.herdr.scripts[0]!;
    expect(bypassFlags(script)).toEqual(["--force"]);
    expect(script).not.toContain("'--sandbox'");
    expect(script).not.toContain("CURSOR_CONFIG_DIR");
    expect(guard).not.toHaveBeenCalled();
  });

  it("gives a Codex writer its own full bypass instead of the hmr-writer profile", async () => {
    const h = bypassHarness();
    const { workflow } = await start(h, "codex writer", true);
    expect(workflow.writerBypass).toBe("flag");
    const script = h.herdr.scripts[0]!;
    expect(bypassFlags(script)).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
    expect(script).not.toContain("hmr-writer");
    expect(script).not.toContain("'--ask-for-approval'");
  });

  it("carries the bypass in the agent-collab route; an ordinary route has no permissions key", async () => {
    const collab = fakeAgentCollab();
    const h = bypassHarness(RULES, { collab: collab.port });
    h.workflows.setBinding(worktreeIdentity(h.repo), "agent-collab");
    const { workflow } = await start(h, "writer", true);
    expect(workflow.writerBypass).toBe("flag");
    expect(collab.state().runs.r1!.route).toMatchObject({
      version: "hmr.rules-route/v1",
      descriptor: "claude:claude-opus-5-5@high",
      permissions: "bypass",
      bypass_from: "flag",
    });
    expect(bypassFlags(h.herdr.scripts[0]!)).toEqual(["--dangerously-skip-permissions"]);
  });
});
