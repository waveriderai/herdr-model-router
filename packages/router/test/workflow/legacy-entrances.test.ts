import { mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { executeRun, type RunDeps } from "../../src/commands/run.js";
import { createWriterGates } from "../../src/commands/runtime.js";
import {
  executeTaskClose,
  executeTaskRecover,
  executeTaskRevise,
} from "../../src/commands/task-commands.js";
import { createHerdrClient, type HerdrAgentInfo } from "../../src/launch/herdr-client.js";
import { worktreeIdentity } from "../../src/rules/rules-source.js";
import { DispatchRepository, WorkflowTaskError } from "../../src/store/dispatch-repository.js";
import { WorkflowRepository, WriterAuthorityError } from "../../src/store/workflow-repository.js";
import { FakePane, noSleep } from "../live-effort/fake-pane.js";
import { fakeTypeSafe, usageFor } from "../cli/fixtures.js";
import { launchedSession, opusAccount, opusModel, store } from "../live-effort/fixtures.js";

const NEXT = "Implement the approved plan";
const dir = (prefix: string) => realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
const REVISION = { head: "a".repeat(40), content: "b".repeat(64) };

/** A pane Herdr also finds by pane id, reporting the directory its agent runs in. */
class PaneWithCwd extends FakePane {
  constructor(private readonly cwd: string | undefined) {
    super({ agent: "claude", level: "medium" });
  }
  override async getAgent(target: string): Promise<HerdrAgentInfo | undefined> {
    const byName = await super.getAgent(target);
    if (byName) return byName;
    if (target !== this.paneId) return undefined;
    return {
      agent: "claude",
      status: this.status,
      paneId: this.paneId,
      ...(this.cwd ? { cwd: this.cwd } : {}),
    };
  }
}

function continuation(input: { paneCwd: string | undefined; callerCwd: string }) {
  const { sessions, effortChanges, db } = store();
  sessions.save(
    launchedSession({ id: "sess_prev", agent: "claude-code", effort: "medium", phase: "planning" }),
  );
  const pane = new PaneWithCwd(input.paneCwd);
  const herdrCalls: string[][] = [];
  const herdr = createHerdrClient(async (argv) => {
    herdrCalls.push([...argv]);
    return { ok: true, code: 0, stdout: "wJ:p7\n", stderr: "" };
  });
  const deps: RunDeps = {
    accounts: [opusAccount],
    models: [opusModel],
    usage: { [opusAccount.id]: usageFor(opusAccount.id, 0.8) },
    client: fakeTypeSafe({
      phase: "implementation",
      family: "implementation",
      route: `${opusAccount.id}:${opusModel.id}`,
      effort: "high",
    }),
    // Called from another pane, in a directory with no writer authority of its own.
    env: { HERDR_ENV: "1", HERDR_PANE_ID: "wJ:p5" },
    callerEnv: { HERDR_PANE_ID: "wJ:p5" },
    now: new Date("2026-09-17T09:01:00.000Z"),
    herdr,
    herdrPane: pane,
    sessions,
    effortChanges,
    liveEffortEnabled: true,
    sleep: noSleep,
    switchTimeoutMs: 100,
    cwd: input.callerCwd,
    ...createWriterGates(db, pane),
  };
  return {
    deps,
    pane,
    herdrCalls,
    workflows: new WorkflowRepository(db),
    dispatch: new DispatchRepository(db),
  };
}

const prompted = (calls: string[][]) =>
  calls.some((argv) => argv[1] === "agent" && argv[2] === "prompt");

describe("legacy quota --session continuation follows the target pane's writer authority", () => {
  it("refuses an in-place prompt into a pane whose worktree is bound to agent-collab, from an unbound caller cwd", async () => {
    const target = dir("hmr-target-");
    const caller = dir("hmr-caller-");
    const { deps, pane, herdrCalls, workflows } = continuation({
      paneCwd: target,
      callerCwd: caller,
    });
    workflows.setBinding(worktreeIdentity(target), "agent-collab");
    expect(workflows.legacyWriterRefusal(worktreeIdentity(caller))).toBeUndefined();
    const result = await executeRun(NEXT, { dryRun: false, previousSessionId: "sess_prev" }, deps);
    expect(result.code).toBe(2);
    expect(result.output).toContain("bound to the agent-collab writer authority");
    expect(prompted(herdrCalls)).toBe(false);
    expect(pane.keys).toEqual([]);
    expect(pane.texts).toEqual([]);
  });

  it("refuses an in-place prompt into the writer pane of an open workflow", async () => {
    const target = dir("hmr-target-");
    const { deps, pane, herdrCalls, workflows } = continuation({
      paneCwd: target,
      callerCwd: dir("hmr-caller-"),
    });
    const { workflow } = workflows.createWorkflow({
      worktreeId: worktreeIdentity(target),
      backend: "standalone",
      briefSha256: "c".repeat(64),
      writerRole: "feature",
      writerDescriptor: "claude:claude-opus-5-5@high",
      cwd: target,
      baseline: REVISION,
      promptSha256: "d".repeat(64),
    });
    workflows.bindIdentity(workflow.id, {
      agentName: "hmr-claude-x",
      kind: "claude",
      paneId: pane.paneId,
      sessionId: "sess-x",
      cwd: target,
    });
    const result = await executeRun(NEXT, { dryRun: false, previousSessionId: "sess_prev" }, deps);
    expect(result.code).toBe(2);
    expect(result.output).toContain(`is the writer of open workflow ${workflow.id}`);
    expect(prompted(herdrCalls)).toBe(false);
    expect(pane.keys).toEqual([]);
  });

  it("refuses when the target pane's directory cannot be read", async () => {
    const { deps, pane, herdrCalls } = continuation({
      paneCwd: undefined,
      callerCwd: dir("hmr-caller-"),
    });
    const result = await executeRun(NEXT, { dryRun: false, previousSessionId: "sess_prev" }, deps);
    expect(result.code).toBe(2);
    expect(result.output).toContain("writer authority is unknown");
    expect(prompted(herdrCalls)).toBe(false);
    expect(pane.keys).toEqual([]);
  });

  it("still continues in place when the target pane's worktree has no other authority", async () => {
    const { deps, herdrCalls } = continuation({
      paneCwd: dir("hmr-target-"),
      callerCwd: dir("hmr-caller-"),
    });
    const result = await executeRun(NEXT, { dryRun: false, previousSessionId: "sess_prev" }, deps);
    expect(result.code).toBe(0);
    expect(prompted(herdrCalls)).toBe(true);
  });

  it("refuses a fresh quota launch in a collab-bound or workflow-held worktree", async () => {
    const target = dir("hmr-target-");
    const { deps, herdrCalls, workflows } = continuation({ paneCwd: target, callerCwd: target });
    workflows.setBinding(worktreeIdentity(target), "agent-collab");
    const result = await executeRun(NEXT, { dryRun: false }, deps);
    expect(result.code).toBe(2);
    expect(result.json).toMatchObject({ reason: "writer-authority" });
    expect(herdrCalls).toEqual([]);
    // A dry run stays a pure preview.
    expect((await executeRun(NEXT, { dryRun: true }, deps)).code).toBe(0);
  });
});

describe("legacy task commands leave workflow tasks alone", () => {
  it("refuses task complete, release, revise and recover on a workflow's writer task", async () => {
    const target = dir("hmr-target-");
    const { workflows, dispatch } = continuation({ paneCwd: target, callerCwd: target });
    const worktreeId = worktreeIdentity(target);
    const { workflow } = workflows.createWorkflow({
      worktreeId,
      backend: "standalone",
      briefSha256: "c".repeat(64),
      writerRole: "feature",
      writerDescriptor: "claude:claude-opus-5-5@high",
      cwd: target,
      baseline: REVISION,
      promptSha256: "d".repeat(64),
    });
    const { task, lanes } = dispatch.createTask({
      role: "feature",
      kind: "single",
      access: "write",
      worktreeId,
      cwd: target,
      rulesPath: "rules.mdc",
      workflowId: workflow.id,
      lanes: [
        {
          index: 1,
          descriptor: "claude:claude-opus-5-5@high",
          provider: "claude",
          model: "claude-opus-5-5",
          effort: "high",
          argv: ["claude"],
        },
      ],
    });
    workflows.setFields(workflow.id, { task_id: task.id });
    const attempt = dispatch.beginAttempt({
      laneId: lanes[0]!.id,
      purpose: "initial",
      promptSha256: "e".repeat(64),
      workflowId: workflow.id,
    });
    for (const result of [
      executeTaskClose(dispatch, task.id, { status: "complete", evidence: "done" }, workflows),
      executeTaskClose(
        dispatch,
        task.id,
        { status: "released", evidence: "stopped", stopped: true },
        workflows,
      ),
      executeTaskRecover(dispatch, attempt.id, { delivered: true, evidence: "seen" }, workflows),
      await executeTaskRevise({ store: dispatch } as never, task.id, "more", workflows),
    ]) {
      expect(result).toMatchObject({
        code: 2,
        json: { code: "workflow-task", workflowId: workflow.id },
      });
    }
    // The store enforces it too: a caller that passes no workflow dependency is still refused.
    expect(
      executeTaskClose(dispatch, task.id, { status: "released", evidence: "x", stopped: true }),
    ).toMatchObject({
      code: 2,
      output: expect.stringContaining(`belongs to open workflow ${workflow.id}`),
    });
    expect(() => dispatch.recoverAttempt(attempt.id, true, "seen")).toThrow(WorkflowTaskError);
    expect(() =>
      dispatch.beginAttempt({
        laneId: lanes[0]!.id,
        purpose: "revision",
        promptSha256: "f".repeat(64),
      }),
    ).toThrow(WorkflowTaskError);
    expect(dispatch.ownerOf(worktreeId)?.taskId).toBe(task.id);
    expect(dispatch.getAttempt(attempt.id)?.state).toBe("sending");
  });

  it("refuses a second rules-mode writer while a workflow is open, but not a read-only panel", () => {
    const target = dir("hmr-target-");
    const { workflows, dispatch } = continuation({ paneCwd: target, callerCwd: target });
    const worktreeId = worktreeIdentity(target);
    workflows.createWorkflow({
      worktreeId,
      backend: "standalone",
      briefSha256: "c".repeat(64),
      writerRole: "feature",
      writerDescriptor: "claude:claude-opus-5-5@high",
      cwd: target,
      baseline: REVISION,
      promptSha256: "d".repeat(64),
    });
    const lane = {
      index: 1,
      descriptor: "claude:claude-opus-5-5@high",
      provider: "claude",
      model: "claude-opus-5-5",
      effort: "high",
      argv: ["claude"],
    };
    const base = {
      role: "feature",
      kind: "single" as const,
      worktreeId,
      cwd: target,
      rulesPath: "rules.mdc",
      lanes: [lane],
    };
    expect(() => dispatch.createTask({ ...base, access: "write" })).toThrow(WriterAuthorityError);
    expect(dispatch.createTask({ ...base, access: "read" }).task.access).toBe("read");
    expect(dispatch.ownerOf(worktreeId)).toBeUndefined();
  });

  it("refuses any standalone writer on a collab-bound worktree and refuses rebinding while it is owned", () => {
    const target = dir("hmr-target-");
    const { workflows, dispatch } = continuation({ paneCwd: target, callerCwd: target });
    const worktreeId = worktreeIdentity(target);
    const lane = {
      index: 1,
      descriptor: "claude:claude-opus-5-5@high",
      provider: "claude",
      model: "claude-opus-5-5",
      effort: "high",
      argv: ["claude"],
    };
    const base = {
      role: "feature",
      kind: "single" as const,
      access: "write" as const,
      worktreeId,
      cwd: target,
      rulesPath: "rules.mdc",
      lanes: [lane],
    };
    const { task } = dispatch.createTask(base);
    expect(() => workflows.setBinding(worktreeId, "agent-collab")).toThrow(/owns/);
    dispatch.closeTask(task.id, "released", "writer stopped");
    workflows.setBinding(worktreeId, "agent-collab");
    expect(() => dispatch.createTask(base)).toThrow(/agent-collab/);
  });
});
