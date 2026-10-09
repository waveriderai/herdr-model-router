import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { recordResult, startWorkflow, verifyWorkflow } from "../../src/workflow/service.js";
import { BRIEF, harness, WORKFLOW_RULES } from "../helpers/workflow-harness.js";

const INHERITING = WORKFLOW_RULES.replace(
  "checkers: codex:gpt-6.1-sol@xhigh, claude:claude-opus-5-5@high",
  "checkers: inherit-parent, claude:claude-opus-5-5@high, inherit-parent",
);

describe("parent aliases in a workflow (R4)", () => {
  it("refuses a start whose roles need a parent that was not given", async () => {
    const h = harness();
    writeFileSync(h.rulesFile, INHERITING);
    expect(await startWorkflow(h.deps, { brief: BRIEF, cwd: h.repo })).toMatchObject({
      ok: false,
      code: "plan-refused",
    });
    expect(h.herdr.calls).toEqual([]);
  });

  it("keeps the start's parent for verification, with every lane in order", async () => {
    const h = harness();
    const rulesBefore = INHERITING;
    writeFileSync(h.rulesFile, rulesBefore);
    const started = await startWorkflow(h.deps, {
      brief: BRIEF,
      cwd: h.repo,
      parent: "codex:gpt-6.1-sol@high",
    });
    if (!started.ok) throw new Error(started.error);
    const { workflow, attempt } = started.value;
    expect(workflow.parentDescriptor).toBe("codex:gpt-6.1-sol@high");
    // The parent is part of the recorded brief, so its identity covers it.
    const brief = JSON.parse(
      readFileSync(path.join(h.home, "workflows", workflow.id, "brief.json"), "utf8"),
    );
    expect(brief.parent).toBe("codex:gpt-6.1-sol@high");
    writeFileSync(path.join(h.repo, "greeting.txt"), "hello\n");
    await recordResult(h.deps, {
      workflowId: workflow.id,
      expectedAttemptId: attempt.id,
      text: h.writerResult({ workflowId: workflow.id, attemptId: attempt.id }),
    });
    const verified = await verifyWorkflow(h.deps, {
      workflowId: workflow.id,
      expectedAttemptId: attempt.id,
    });
    if (!verified.ok) throw new Error(verified.error);
    expect(verified.value.lanes[0]!.lanes.map((lane) => lane.descriptor)).toEqual([
      "codex:gpt-6.1-sol@high",
      "claude:claude-opus-5-5@high",
      "codex:gpt-6.1-sol@high",
    ]);
    // The user's rules file is never rewritten.
    expect(readFileSync(h.rulesFile, "utf8")).toBe(rulesBefore);
  });
});
