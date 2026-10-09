import path from "node:path";
import { describe, expect, it } from "vitest";
import { executeRun, type RunDeps } from "../../src/commands/run.js";
import { createWriterGates } from "../../src/commands/runtime.js";
import { createHerdrClient, type HerdrAgentInfo } from "../../src/launch/herdr-client.js";
import { worktreeIdentity } from "../../src/rules/rules-source.js";
import { EffortChangeRepository } from "../../src/store/effort-change-repository.js";
import { SessionRepository } from "../../src/store/session-repository.js";
import { dispatchPlan } from "../../src/rules/dispatch.js";
import { startWorkflow } from "../../src/workflow/service.js";
import { cursorModel, fakeTypeSafe, personal, usageFor } from "../cli/fixtures.js";
import { FakePane, noSleep } from "../live-effort/fake-pane.js";
import { launchedSession, opusAccount, opusModel } from "../live-effort/fixtures.js";
import { initRepo, tempDir } from "../workspace/git-fixtures.js";
import { BRIEF, harness, type Harness } from "../helpers/workflow-harness.js";

const NEXT = "Implement the approved plan";

/** A Claude pane Herdr finds by pane id too, reporting where its agent runs. */
class PaneAt extends FakePane {
  constructor(private readonly cwd: string) {
    super({ agent: "claude", level: "medium" });
  }
  override async getAgent(target: string): Promise<HerdrAgentInfo | undefined> {
    const live = await super.getAgent(target === this.paneId ? this.agentName : target);
    return live ? { ...live, cwd: this.cwd } : undefined;
  }
}

/** Quota-mode deps over the harness database, so quota runs and workflows share one store. */
function quota(
  h: Harness,
  options: {
    failLaunch?: boolean;
    withSession?: boolean;
    /** Scripts a Herdr reply for one command (argv[1] argv[2], e.g. "agent prompt"). */
    reply?: (
      command: string,
    ) => { ok: boolean; code: number; stdout: string; stderr: string } | undefined;
  } = {},
) {
  const sessions = new SessionRepository(h.db);
  const effortChanges = new EffortChangeRepository(h.db);
  if (options.withSession) {
    sessions.save(
      launchedSession({
        id: "sess_prev",
        agent: "claude-code",
        effort: "medium",
        phase: "planning",
      }),
    );
  }
  const pane = new PaneAt(h.repo);
  const calls: string[][] = [];
  const herdr = createHerdrClient(async (argv) => {
    calls.push([...argv]);
    if (options.failLaunch && argv[1] === "pane" && argv[2] === "split") {
      return { ok: false, code: 1, stdout: "", stderr: "split failed" };
    }
    const scripted = options.reply?.(`${argv[1]} ${argv[2]}`);
    if (scripted) return scripted;
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
    cwd: h.repo,
    ...createWriterGates(h.db, pane),
  };
  const prompted = () =>
    calls.some(
      (argv) =>
        (argv[1] === "agent" && (argv[2] === "prompt" || argv[2] === "start")) ||
        argv[2] === "split",
    );
  return { deps, calls, prompted, sessions };
}

const json = (result: { json: unknown }) =>
  result.json as { writerTaskId?: string; sessionId?: string };

describe("quota mode holds the writer authority for the writer's lifetime (R8, R13)", () => {
  it("quota first: a fresh launch keeps the worktree, so a workflow cannot start a second writer", async () => {
    const h = harness();
    const q = quota(h);
    const launched = await executeRun(NEXT, { dryRun: false, noEnrich: true }, q.deps);
    expect(launched.code).toBe(0);
    const taskId = json(launched).writerTaskId!;
    expect(launched.output).toContain(`Writer task ${taskId} holds this worktree`);
    const worktreeId = worktreeIdentity(h.repo);
    expect(h.dispatch.store.ownerOf(worktreeId)?.taskId).toBe(taskId);
    expect(q.sessions.get(json(launched).sessionId!)?.writerTaskId).toBe(taskId);
    // Long after the launch returned, the writer still holds the worktree.
    expect(await startWorkflow(h.deps, { brief: BRIEF, cwd: h.repo })).toMatchObject({
      ok: false,
      code: "writer-owned",
    });
    expect(h.herdr.prompts).toEqual([]);
    // Only ending the writer task frees it.
    h.dispatch.store.closeTask(taskId, "complete", "phase done");
    expect(await startWorkflow(h.deps, { brief: BRIEF, cwd: h.repo })).toMatchObject({ ok: true });
  });

  it("workflow first: a quota launch, fresh or continued in place, is refused with nothing sent", async () => {
    const h = harness();
    expect(await startWorkflow(h.deps, { brief: BRIEF, cwd: h.repo })).toMatchObject({ ok: true });
    const fresh = quota(h);
    const refused = await executeRun(NEXT, { dryRun: false, noEnrich: true }, fresh.deps);
    expect(refused).toMatchObject({ code: 2, json: { reason: "writer-authority" } });
    expect(fresh.calls).toEqual([]);
    const continued = quota(h, { withSession: true });
    const inPlace = await executeRun(
      NEXT,
      { dryRun: false, previousSessionId: "sess_prev", noEnrich: true },
      continued.deps,
    );
    expect(inPlace.code).toBe(2);
    expect(continued.prompted()).toBe(false);
  });

  it("concurrent starts: exactly one of a quota launch and a workflow becomes the writer", async () => {
    const h = harness();
    const q = quota(h);
    const [launched, workflow] = await Promise.all([
      executeRun(NEXT, { dryRun: false, noEnrich: true }, q.deps),
      startWorkflow(h.deps, { brief: BRIEF, cwd: h.repo }),
    ]);
    expect(Number(launched.code === 0) + Number(workflow.ok)).toBe(1);
    const owner = h.dispatch.store.ownerOf(worktreeIdentity(h.repo));
    expect(owner?.taskId).toBe(
      launched.code === 0
        ? json(launched).writerTaskId
        : workflow.ok
          ? workflow.value.workflow.taskId
          : undefined,
    );
  });

  it("an in-place continuation keeps its own chain's task; another chain into that pane is refused", async () => {
    const h = harness();
    const q = quota(h, { withSession: true });
    const first = await executeRun(
      NEXT,
      { dryRun: false, previousSessionId: "sess_prev", noEnrich: true },
      q.deps,
    );
    expect(first.code).toBe(0);
    const taskId = json(first).writerTaskId!;
    const second = await executeRun(
      "Review the change",
      { dryRun: false, previousSessionId: json(first).sessionId!, noEnrich: true },
      q.deps,
    );
    expect(second.code).toBe(0);
    expect(json(second).writerTaskId).toBe(taskId);
    expect(h.dispatch.store.ownerOf(worktreeIdentity(h.repo))?.taskId).toBe(taskId);
    // A different session chain aimed at the same pane is not this writer's chain.
    q.sessions.save(
      launchedSession({
        id: "sess_other",
        agent: "claude-code",
        effort: "medium",
        phase: "planning",
      }),
    );
    const other = await executeRun(
      NEXT,
      { dryRun: false, previousSessionId: "sess_other", noEnrich: true },
      q.deps,
    );
    expect(other.code).toBe(2);
  });

  it("gives the authority back when the launch fails before any handoff", async () => {
    const h = harness();
    const q = quota(h, { failLaunch: true });
    const failed = await executeRun(NEXT, { dryRun: false, noEnrich: true }, q.deps);
    expect(failed.code).toBe(1);
    expect(json(failed).writerTaskId).toBeUndefined();
    expect(h.dispatch.store.ownerOf(worktreeIdentity(h.repo))).toBeUndefined();
  });

  it("a --worktree launch holds its new worktree", async () => {
    const base = tempDir();
    const repo = initRepo(path.join(base, "repo"));
    const h = harness();
    const q = quota(h);
    const deps: RunDeps = {
      ...q.deps,
      accounts: [personal],
      models: [cursorModel],
      usage: { [personal.id]: usageFor(personal.id, 0.8) },
      client: fakeTypeSafe({ family: "implementation", phase: "implementation" }),
      liveEffortEnabled: false,
      cwd: repo,
      worktreeRoot: path.join(base, "worktrees"),
    };
    const launched = await executeRun(
      NEXT,
      { dryRun: false, worktree: true, noEnrich: true },
      deps,
    );
    expect(launched.code).toBe(0);
    const workspace = (launched.json as { workspace: { path: string } }).workspace.path;
    expect(h.dispatch.store.ownerOf(worktreeIdentity(workspace))?.taskId).toBe(
      json(launched).writerTaskId,
    );
    expect(h.workflows.legacyWriterRefusal(worktreeIdentity(workspace))?.code).toBe("writer-owned");
  });

  const herdrFailure = (code: string) => ({
    ok: false,
    code: 1,
    stdout: "",
    stderr: JSON.stringify({ error: { code, message: code } }),
  });

  it.each([
    ["a timeout", { "agent prompt": herdrFailure("timeout") }],
    [
      "an unreadable reply",
      { "agent prompt": { ok: false, code: 1, stdout: "garbled", stderr: "" } },
    ],
    [
      "a stall that a second wait does not resolve",
      {
        "agent prompt": herdrFailure("agent_prompt_stalled"),
        "agent wait#2": herdrFailure("timeout"),
      },
    ],
  ] as const)(
    "keeps the worktree after %s once the handoff was submitted",
    async (_label, script) => {
      const h = harness();
      let waits = 0;
      const q = quota(h, {
        reply: (command) => {
          if (command === "agent wait") waits += 1;
          const key = command === "agent wait" ? `agent wait#${waits}` : command;
          return (script as Record<string, ReturnType<typeof herdrFailure>>)[key];
        },
      });
      const launched = await executeRun(NEXT, { dryRun: false, noEnrich: true }, q.deps);
      expect(launched.code).toBe(1);
      const taskId = json(launched).writerTaskId!;
      expect(taskId).toMatch(/^task_/);
      expect(launched.output).toContain("Nothing is resent");
      expect(launched.output).not.toMatch(/paste|retry/i);
      const worktreeId = worktreeIdentity(h.repo);
      expect(h.dispatch.store.ownerOf(worktreeId)?.taskId).toBe(taskId);
      // The handoff is on record as an unknown attempt with its pane.
      const lane = h.dispatch.store.lanes(taskId)[0]!;
      expect(lane.paneId).toBe("wJ:p7");
      expect(h.dispatch.store.attempts(lane.id).map((attempt) => attempt.state)).toEqual([
        "unknown",
      ]);
      expect(q.calls.filter((argv) => argv[2] === "prompt")).toHaveLength(1);
      // No second writer of any kind gets in.
      expect(await startWorkflow(h.deps, { brief: BRIEF, cwd: h.repo })).toMatchObject({
        ok: false,
        code: "writer-owned",
      });
      const planned = h.deps.planRole({ role: "writer", cwd: h.repo, readOnly: false });
      if (!planned.ok) throw new Error(planned.error);
      const rules = await dispatchPlan({
        plan: planned.plan,
        prompt: "x",
        worktreeId,
        deps: h.dispatch,
      });
      expect(rules).toMatchObject({ ok: false, code: "ownership-conflict" });
      expect((await executeRun(NEXT, { dryRun: false, noEnrich: true }, quota(h).deps)).code).toBe(
        2,
      );
      expect(h.herdr.prompts).toEqual([]);
      // Only an operator who saw the agent stop ends it.
      expect(() => h.dispatch.store.closeTask(taskId, "complete", "done")).toThrow(/unknown/);
      h.dispatch.store.closeTask(taskId, "released", "pane shows the agent stopped");
      expect(h.dispatch.store.ownerOf(worktreeId)).toBeUndefined();
    },
  );

  it("gives the worktree back after Herdr's structured agent_blocked refusal once its pane is closed", async () => {
    const h = harness();
    const q = quota(h, {
      reply: (command) => (command === "agent prompt" ? herdrFailure("agent_blocked") : undefined),
    });
    const refused = await executeRun(NEXT, { dryRun: false, noEnrich: true }, q.deps);
    expect(refused.code).toBe(1);
    expect(json(refused).writerTaskId).toBeUndefined();
    expect(q.calls.some((argv) => argv[1] === "pane" && argv[2] === "close")).toBe(true);
    expect(h.dispatch.store.ownerOf(worktreeIdentity(h.repo))).toBeUndefined();
  });

  it("keeps the worktree after agent_blocked when the pane's close is not confirmed", async () => {
    const h = harness();
    const q = quota(h, {
      reply: (command) =>
        command === "agent prompt"
          ? herdrFailure("agent_blocked")
          : command === "pane close"
            ? herdrFailure("pane_busy")
            : undefined,
    });
    const refused = await executeRun(NEXT, { dryRun: false, noEnrich: true }, q.deps);
    expect(refused.code).toBe(1);
    const taskId = json(refused).writerTaskId!;
    expect(h.dispatch.store.ownerOf(worktreeIdentity(h.repo))?.taskId).toBe(taskId);
    expect(refused.output).toContain("the agent's pane may still be running");
  });
});
