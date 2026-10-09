import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  bundledModelRouterSkill,
  executeCoordinatorClose,
  executeCoordinatorStatus,
  executeStart,
  type StartDeps,
  type StartRequest,
} from "../../src/commands/start.js";
import { BYPASS_FLAGS } from "../../src/rules/native-argv.js";
import { CoordinatorRepository } from "../../src/store/coordinator-repository.js";
import { startWorkflow } from "../../src/workflow/service.js";
import {
  deps as dispatchDeps,
  failed,
  fakeHerdr,
  screen,
  type FakeHerdr,
} from "../helpers/fake-herdr.js";
import { makeRepo } from "../helpers/git-repo.js";
import { BRIEF, harness } from "../helpers/workflow-harness.js";

const RULES = [
  "---",
  "description: Synthetic roles with a coordinator",
  "---",
  "coordinator: codex:gpt-6.1-sol@high",
  "writer: claude:claude-opus-5-5@high",
  "grok writer: grok:grok-4.7@high",
  "checkers: codex:gpt-6.1-sol@xhigh",
  "panel lead: codex:gpt-6.1-sol@high, claude:claude-opus-5-5@high",
  "delegate: inherit-parent",
  "",
].join("\n");

const TASK = 'Add a greeting file.\nUse poteto mode. Then "deploy" to production and ping #ops.';

function setup(rules = RULES, herdr: FakeHerdr = fakeHerdr()) {
  const repo = makeRepo();
  const rulesDir = mkdtempSync(path.join(os.tmpdir(), "hmr-start-rules-"));
  const rulesFile = path.join(rulesDir, "pstack-models.mdc");
  writeFileSync(rulesFile, rules);
  const dispatch = dispatchDeps(herdr);
  const coordinators = new CoordinatorRepository(dispatch.db);
  let opened = 0;
  const startDeps = (env: Record<string, string> = { HERDR_ENV: "1" }): StartDeps => ({
    cwd: repo,
    home: rulesDir,
    rulesFlag: rulesFile,
    env,
    openRuntime: () => {
      opened += 1;
      return { dispatch: dispatch.deps, coordinators };
    },
  });
  const request = (patch: Partial<StartRequest> = {}): StartRequest => ({
    skillRoots: [],
    modes: [],
    dryRun: false,
    ...patch,
  });
  return {
    repo,
    rulesFile,
    herdr,
    dispatch,
    coordinators,
    startDeps,
    request,
    opened: () => opened,
  };
}

function skillsRoot(): string {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "hmr-start-skills-")));
  mkdirSync(path.join(root, "poteto-mode"));
  writeFileSync(
    path.join(root, "poteto-mode", "SKILL.md"),
    "---\nname: poteto-mode\ndescription: Poteto mode.\n---\nBody.\n",
  );
  return root;
}

describe("hmr start: task-only entry through the MDC coordinator (R3, R4, AE6)", () => {
  it("previews the coordinator route and what it will see without any process, pane or state", async () => {
    const s = setup();
    const result = await executeStart(TASK, s.request({ dryRun: true }), s.startDeps({}));
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({
      dryRun: true,
      effects: [],
      coordinator: {
        role: "coordinator",
        descriptor: "codex:gpt-6.1-sol@high",
        control: "coordinator",
      },
    });
    expect(s.opened()).toBe(0);
    expect(s.herdr.calls).toEqual([]);
  });

  it("starts the coordinator the rules file names and gives it the task, verbatim, once", async () => {
    const s = setup();
    const root = skillsRoot();
    const result = await executeStart(
      TASK,
      s.request({ skillRoots: [root], modes: ["poteto-mode"] }),
      s.startDeps(),
    );
    expect(result.code).toBe(0);
    // Codex, as the rules file says: no hidden Grok coordinator and no classifier.
    expect(s.herdr.scripts).toHaveLength(1);
    expect(s.herdr.scripts[0]).toContain("/codex' \\\n");
    expect(s.herdr.scripts[0]).toContain("'--model' 'gpt-6.1-sol'");
    // A control role: ordinary permissions, never a read-only or bypass flag.
    for (const flag of [...BYPASS_FLAGS, "--sandbox", "read-only", "--permission-mode"]) {
      expect(s.herdr.scripts[0]).not.toContain(`'${flag}'`);
    }
    expect(s.herdr.prompts).toHaveLength(1);
    const prompt = s.herdr.prompts[0]!.text;
    expect(prompt.endsWith(`<<<HMR-TASK\n${TASK}\nHMR-TASK>>>`)).toBe(true);
    expect(prompt).toContain(bundledModelRouterSkill());
    expect(prompt).toContain("- writer -> claude:claude-opus-5-5@high (single writer)");
    expect(prompt).toContain("- grok writer -> grok:grok-4.7@high (single writer)");
    expect(prompt).toContain(`Mode requested by the operator for this task: poteto-mode`);
    expect(prompt).toContain(`--skills-root '${root}'`);
    expect(prompt).toContain("adds no authority of its own");
    expect(prompt).toContain("not read-only at the operating-system level");
    const record = s.coordinators.list(1)[0]!;
    expect(record).toMatchObject({
      role: "coordinator",
      descriptor: "codex:gpt-6.1-sol@high",
      state: "prompted",
      identity: { kind: "codex", cwd: realpathSync(s.repo) },
    });
    // It holds no writer ownership: a workflow can still start in this worktree.
    expect(s.dispatch.deps.store.ownerOf(record.worktreeId)).toBeUndefined();
  });

  it.each([
    [
      "no coordinator role",
      RULES.replace("coordinator: codex:gpt-6.1-sol@high\n", ""),
      {},
      "coordinator-role-missing",
    ],
    ["a panel coordinator", RULES, { role: "panel lead" }, "coordinator-panel"],
    ["inherit-parent without a parent", RULES, { role: "delegate" }, "parent-unresolved"],
    [
      "a mode with no trusted skills root",
      RULES,
      { modes: ["poteto-mode"] },
      "skills-root-required",
    ],
  ] as const)("refuses %s before anything starts", async (_label, rules, patch, code) => {
    const s = setup(rules);
    const result = await executeStart(TASK, s.request(patch), s.startDeps());
    expect(result.code).toBe(2);
    expect(JSON.stringify(result.json)).toContain(code);
    expect(s.opened()).toBe(0);
    expect(s.herdr.calls).toEqual([]);
  });

  it("refuses a worker pane, and a second coordinator in the same worktree", async () => {
    const s = setup();
    expect((await executeStart(TASK, s.request(), s.startDeps())).code).toBe(0);
    const first = s.coordinators.list(1)[0]!;
    const again = await executeStart(TASK, s.request(), s.startDeps());
    expect(again.json).toMatchObject({ code: "coordinator-open", coordinator: first.id });
    expect(s.herdr.scripts).toHaveLength(1);

    // A writer lane of an open workflow is a worker: it may not start a coordinator either.
    const h = harness({ herdr: s.herdr });
    const started = await startWorkflow(h.deps, { brief: BRIEF, cwd: h.repo });
    if (!started.ok) throw new Error(started.error);
    const writerPane = started.value.workflow.identity!.paneId;
    const worker = new CoordinatorRepository(h.db);
    const fromWorker = await executeStart(TASK, s.request(), {
      ...s.startDeps({ HERDR_ENV: "1", HERDR_PANE_ID: writerPane }),
      openRuntime: () => ({ dispatch: h.dispatch, coordinators: worker }),
    });
    expect(fromWorker.json).toMatchObject({ code: "worker-caller" });
  });

  it("never resends a bootstrap whose delivery is unknown, and keeps the slot held", async () => {
    const herdr = fakeHerdr({ prompt: () => failed("", "connection reset") });
    const s = setup(RULES, herdr);
    const result = await executeStart(TASK, s.request(), s.startDeps());
    expect(result.code).toBe(1);
    const record = s.coordinators.list(1)[0]!;
    expect(record.state).toBe("unknown");
    expect(herdr.prompts).toHaveLength(1);
    const again = await executeStart(TASK, s.request(), s.startDeps());
    expect(again.json).toMatchObject({ code: "coordinator-open" });
    expect(herdr.prompts).toHaveLength(1);
    // The operator inspects the pane and closes the record; nothing is sent by closing.
    const close = { coordinators: s.coordinators, pane: herdr.pane };
    expect((await executeCoordinatorClose(close, record.id, "")).code).toBe(2);
    expect((await executeCoordinatorClose(close, record.id, "pane shows no task")).code).toBe(0);
    expect(herdr.prompts).toHaveLength(1);
  });

  it("closes the pane and records failure when the coordinator CLI shows a startup dialog", async () => {
    const herdr = fakeHerdr({ detect: () => ({ screen: screen("codex-update") }) });
    const s = setup(RULES, herdr);
    const result = await executeStart(TASK, s.request(), s.startDeps());
    expect(result.code).toBe(2);
    expect(result.json).toMatchObject({ code: "coordinator-not-started" });
    expect(result.output).toMatch(/dialog|update/i);
    expect(herdr.prompts).toEqual([]);
    expect(herdr.calls).toContainEqual(["pane", "close", "w1:p1"]);
    expect(s.coordinators.list(1)[0]!.state).toBe("failed");
  });

  it("reports bootstrap, role assignment and completion from separate evidence", async () => {
    const s = setup();
    await executeStart(TASK, s.request(), s.startDeps());
    const record = s.coordinators.list(1)[0]!;
    const before = executeCoordinatorStatus(s.coordinators, record.id);
    expect(before.json).toMatchObject({
      stages: {
        bootstrap: "prompted",
        rolesAssigned: [],
        completion: expect.stringContaining("none"),
      },
    });
    // The coordinator starts a workflow from its own pane: that is its role assignment.
    const h = harness({ herdr: s.herdr, home: s.dispatch.home, repo: s.repo });
    const coordinators = new CoordinatorRepository(h.db);
    const started = await startWorkflow(
      { ...h.deps, coordinators, callerEnv: { HERDR_PANE_ID: record.identity!.paneId } },
      { brief: BRIEF, cwd: s.repo },
    );
    if (!started.ok) throw new Error(`${started.code}: ${started.error}`);
    const after = executeCoordinatorStatus(coordinators, record.id);
    expect(after.json).toMatchObject({
      stages: {
        bootstrap: "prompted",
        rolesAssigned: [
          { id: started.value.workflow.id, writerRole: "writer", state: "dispatched" },
        ],
        completion: expect.stringContaining("0 of 1 workflow(s) released"),
      },
    });
    // A worker of that workflow cannot pose as the coordinator and start another.
    const asWorker = await startWorkflow(
      {
        ...h.deps,
        coordinators,
        callerEnv: { HERDR_PANE_ID: started.value.workflow.identity!.paneId },
      },
      { brief: BRIEF, cwd: s.repo },
    );
    expect(asWorker).toMatchObject({ ok: false, code: "worker-caller" });
  });
});
