import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CommandResult, HerdrClient, HerdrPaneClient } from "../../src/launch/herdr-client.js";
import { dispatchPlan, reviseTask, type DispatchDeps } from "../../src/rules/dispatch.js";
import { parseRules } from "../../src/rules/mdc-parser.js";
import { planRoute, type RoutePlan } from "../../src/rules/plan.js";
import { launchFilesIn, openDispatchDeps } from "../../src/commands/rules-runtime.js";
import {
  executeTaskClose,
  executeTaskRecover,
  executeTaskStatus,
} from "../../src/commands/task-commands.js";
import { openDatabase } from "../../src/store/database.js";
import { DispatchRepository } from "../../src/store/dispatch-repository.js";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/rules/pstack-models.mdc",
);
const parsed = parseRules(readFileSync(FIXTURE, "utf8"));
if (!parsed.ok) throw new Error(parsed.error);
const rules = parsed.rules;

function plan(role: string, extra: Partial<Parameters<typeof planRoute>[0]> = {}): RoutePlan {
  const result = planRoute({
    rules,
    rulesSource: { path: FIXTURE, origin: "flag" },
    role,
    cwd: "/work/project",
    ...extra,
  });
  if (!result.ok) throw new Error(result.error);
  return result;
}

const ok = (stdout = ""): CommandResult => ({ ok: true, code: 0, stdout, stderr: "" });
const failed = (stdout: string, stderr = ""): CommandResult => ({
  ok: false,
  code: 1,
  stdout,
  stderr,
});

const HELP: Record<string, string> = {
  claude: '--model <m>\n--effort <level>\n--permission-mode <mode> (choices: "plan")',
  codex:
    "-m, --model <MODEL>\n-c, --config <k=v>\n-s, --sandbox <MODE> [possible values: read-only, workspace-write]",
  grok: "-m, --model <MODEL>\n--reasoning-effort <E>\n--permission-mode <MODE> [possible values: default, plan]",
  "cursor-agent": '--model <model>\n--mode <mode> (choices: "plan", "ask")',
};

const KIND_BY_EXECUTABLE: Record<string, string> = {
  claude: "claude",
  codex: "codex",
  grok: "grok",
  "cursor-agent": "cursor",
};

interface FakePane {
  /** Detected agent kind, or undefined while nothing is detected. */
  kind?: string;
  status: "idle" | "working" | "blocked" | "unknown";
  ready: boolean;
  name?: string;
  gone?: boolean;
}

interface FakeHerdr extends HerdrClient {
  calls: string[][];
  prompts: { target: string; text: string }[];
  scripts: string[];
  panes: Map<string, FakePane>;
  pane: Pick<HerdrPaneClient, "getAgent">;
}

/**
 * A Herdr stand-in. `pane run` reads the launch script the router wrote and "starts" the
 * executable it names; `detect` can override what Herdr then reports for the pane.
 */
function fakeHerdr(
  script: {
    detect?: (paneId: string, executable: string) => FakePane;
    prompt?: (target: string, count: number) => CommandResult;
    onRename?: (paneId: string, name: string) => void;
    onGetAgent?: (target: string) => void;
  } = {},
): FakeHerdr {
  const calls: string[][] = [];
  const prompts: { target: string; text: string }[] = [];
  const scripts: string[] = [];
  const panes = new Map<string, FakePane>();
  let count = 0;
  const find = (target: string) =>
    [...panes.entries()].find(
      ([id, pane]) => !pane.gone && (id === target || pane.name === target),
    );
  return {
    calls,
    prompts,
    scripts,
    panes,
    async splitCurrent(options) {
      calls.push(["pane", "split", options?.cwd ?? ""]);
      count += 1;
      panes.set(`w1:p${count}`, { status: "unknown", ready: false });
      return ok(JSON.stringify({ result: { pane: { pane_id: `w1:p${count}` } } }));
    },
    async startAgent() {
      throw new Error("rules mode must not use herdr agent start");
    },
    async runInPane(paneId, command) {
      calls.push(["pane", "run", paneId, command]);
      const scriptPath = /^\/bin\/sh '(.+)'$/.exec(command)?.[1];
      if (!scriptPath) return failed("", "unexpected command");
      const text = readFileSync(scriptPath, "utf8");
      scripts.push(text);
      const last = text.trim().split("\n").at(-1)!.trim();
      const executable = path.basename(/^'([^']+)'/.exec(last)![1]!);
      const pane = panes.get(paneId)!;
      Object.assign(
        pane,
        script.detect?.(paneId, executable) ?? {
          kind: KIND_BY_EXECUTABLE[executable],
          status: "idle",
          ready: true,
        },
      );
      return ok();
    },
    async renameAgent(target, name) {
      calls.push(["agent", "rename", target, name]);
      script.onRename?.(target, name);
      const pane = panes.get(target);
      if (!pane?.kind) return failed("", "no agent");
      pane.name = name;
      return ok();
    },
    async waitFor(input) {
      calls.push(["agent", "wait", input.target, ...(input.until ?? [])]);
      return ok(JSON.stringify({ result: { agent: { agent_status: "idle" } } }));
    },
    async prompt(input) {
      prompts.push({ target: input.target, text: input.text });
      calls.push(["agent", "prompt", input.target]);
      return (
        script.prompt?.(input.target, prompts.length) ??
        ok(JSON.stringify({ result: { agent: { agent_status: "working" } } }))
      );
    },
    async closePane(paneId) {
      calls.push(["pane", "close", paneId]);
      const pane = panes.get(paneId);
      if (pane) pane.gone = true;
      return ok();
    },
    pane: {
      async getAgent(target) {
        script.onGetAgent?.(target);
        const found = find(target);
        if (!found?.[1].kind) return undefined;
        const [paneId, pane] = found;
        return {
          agent: pane.kind!,
          status: pane.status,
          paneId,
          interactiveReady: pane.ready,
          ...(pane.name ? { name: pane.name } : {}),
        };
      },
    },
  };
}

function deps(herdr: FakeHerdr, overrides: Partial<DispatchDeps> = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "hmr-dispatch-"));
  const db = openDatabase({ home });
  const probed: string[] = [];
  const value: DispatchDeps = {
    store: new DispatchRepository(db),
    herdr,
    pane: herdr.pane,
    probeHelp: async (executable) => {
      probed.push(executable);
      const help = HELP[path.basename(executable)];
      return help ? ok(help) : { ok: false, code: 1, stdout: "", stderr: "spawn ENOENT" };
    },
    resolveExecutable: (name) => (name in HELP ? `/opt/fake bin/${name}` : undefined),
    launchFiles: launchFilesIn(home),
    launchEnvNames: ["HERDR_PANE_ID", "HOME", "PATH"],
    sleep: async () => {},
    pollMs: 10,
    timeoutMs: 50,
    ...overrides,
  };
  return { deps: value, probed, home, db };
}

describe("panel dispatch (AE4)", () => {
  it("attempts every lane in order, records a failed lane, and reports a partial outcome", async () => {
    const herdr = fakeHerdr({
      detect: (_pane, executable) =>
        executable === "codex"
          ? { kind: "codex", status: "blocked", ready: false }
          : { kind: KIND_BY_EXECUTABLE[executable], status: "idle", ready: true },
    });
    const { deps: d, probed } = deps(herdr);
    const result = await dispatchPlan({
      plan: plan("reviewers"),
      prompt: "Review the diff",
      worktreeId: "/work/project",
      deps: d,
    });
    if (!result.ok) throw new Error(result.error);
    expect(probed).toEqual(["/opt/fake bin/claude", "/opt/fake bin/codex"]);
    expect(result.task).toMatchObject({ kind: "panel", access: "read", status: "partial" });
    expect(
      result.lanes.map((lane) => [
        lane.index,
        lane.descriptor,
        lane.state,
        lane.attempt?.state ?? null,
      ]),
    ).toEqual([
      [1, "claude:claude-opus-5-5@high", "prompted", "working"],
      [2, "codex:gpt-6.1-sol@xhigh", "failed", null],
      [3, "claude:claude-opus-5-5@high", "prompted", "working"],
    ]);
    expect(result.lanes[1]?.error).toBe(
      "codex did not become ready in pane w1:p2 (codex is blocked (not ready)); no prompt was sent",
    );
    expect(new Set(result.lanes.map((lane) => lane.laneId)).size).toBe(3);
    // Each pane runs exactly the resolved absolute binary with single-quoted native argv.
    expect(herdr.scripts.map((text) => text.trim().split("\n").at(-1)!.trim())).toEqual([
      "'/opt/fake bin/claude' '--model' 'claude-opus-5-5' '--effort' 'high' '--permission-mode' 'plan'",
      "'/opt/fake bin/codex' '--model' 'gpt-6.1-sol' '-c' 'model_reasoning_effort=\"xhigh\"' '--sandbox' 'read-only'",
      "'/opt/fake bin/claude' '--model' 'claude-opus-5-5' '--effort' 'high' '--permission-mode' 'plan'",
    ]);
    expect(herdr.scripts[0]).toContain("exec /usr/bin/env -i \\\n");
    expect(herdr.scripts[0]).toContain("cd '/work/project' || exit 97");
    // The unready pane is closed and never named or prompted.
    expect(herdr.calls).toContainEqual(["pane", "close", "w1:p2"]);
    expect(herdr.calls.filter((call) => call[1] === "rename").map((call) => call[2])).toEqual([
      "w1:p1",
      "w1:p3",
    ]);
    expect(herdr.prompts.map((prompt) => prompt.text)).toEqual([
      'Review the diff\n\n(Read-only panel lane 1 of 3 for role "reviewers". Do not modify files.)',
      'Review the diff\n\n(Read-only panel lane 3 of 3 for role "reviewers". Do not modify files.)',
    ]);
    // A panel never takes the worktree's writer ownership.
    expect(d.store.ownerOf("/work/project")).toBeUndefined();
    expect(
      herdr.calls
        .filter((call) => call[1] === "split")
        .every((call) => call[2] === "/work/project"),
    ).toBe(true);
  });

  it("fails closed when the pane runs a different agent than the lane's provider", async () => {
    // As on a machine where the `agent` command is another vendor's CLI.
    const herdr = fakeHerdr({ detect: () => ({ kind: "grok", status: "idle", ready: true }) });
    const { deps: d } = deps(herdr);
    const result = await dispatchPlan({
      plan: plan("cursor reader"),
      prompt: "Read it",
      worktreeId: "/w/mismatch",
      deps: d,
    });
    expect(result.ok && result.lanes[0]).toMatchObject({
      state: "failed",
      error: "pane w1:p1 runs grok, not cursor; refusing to name or prompt it",
    });
    expect(herdr.calls.map((call) => call.slice(0, 2).join(" "))).toEqual([
      "pane split",
      "pane run",
      "pane close",
    ]);
    expect(herdr.scripts[0]).toContain("'/opt/fake bin/cursor-agent' '--model' 'composer-2'");
    expect(herdr.prompts).toEqual([]);
    expect(d.store.ownerOf("/w/mismatch")).toBeUndefined();
  });

  it("fails closed before creating anything when a CLI is missing or lacks a flag", async () => {
    const herdr = fakeHerdr();
    const missing = deps(herdr, {
      probeHelp: async () => ({ ok: false, code: 1, stdout: "", stderr: "ENOENT" }),
    });
    expect(
      await dispatchPlan({
        plan: plan("explorer"),
        prompt: "Map it",
        worktreeId: "/w",
        deps: missing.deps,
      }),
    ).toEqual({
      ok: false,
      code: "capability-missing",
      error:
        "lane 1: `/opt/fake bin/grok --help` failed; the grok CLI is missing or broken. Nothing was launched and no other model or API key is tried.",
    });
    const absent = deps(herdr, { resolveExecutable: () => undefined });
    expect(
      await dispatchPlan({
        plan: plan("explorer"),
        prompt: "Map",
        worktreeId: "/w",
        deps: absent.deps,
      }),
    ).toMatchObject({
      ok: false,
      code: "capability-missing",
      error: expect.stringContaining("`grok` is not on PATH"),
    });
    const old = deps(herdr, {
      probeHelp: async () => ok("-m, --model <MODEL>\n--reasoning-effort <E>"),
    });
    expect(
      await dispatchPlan({
        plan: plan("explorer", { readOnly: true }),
        prompt: "Map it",
        worktreeId: "/w",
        deps: old.deps,
      }),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("does not list --permission-mode, plan"),
    });
    expect(herdr.calls).toEqual([]);
    expect(missing.deps.store.listTasks(10)).toEqual([]);
  });
});

describe("writer ownership and at-most-once prompts (AE3)", () => {
  it("keeps one writer per worktree, revises in the same pane, and rejects another task", async () => {
    const herdr = fakeHerdr();
    const { deps: d } = deps(herdr);
    const first = await dispatchPlan({
      plan: plan("bug-fix"),
      prompt: "Fix the crash",
      worktreeId: "/work/project",
      deps: d,
    });
    if (!first.ok) throw new Error(first.error);
    const lane = first.lanes[0]!;
    expect(first.task).toMatchObject({ access: "write", status: "dispatched" });
    expect(d.store.ownerOf("/work/project")?.taskId).toBe(first.task.id);

    const second = await dispatchPlan({
      plan: plan("feature"),
      prompt: "Other work",
      worktreeId: "/work/project",
      deps: d,
    });
    expect(second).toMatchObject({ ok: false, code: "ownership-conflict" });
    expect(second.ok ? "" : second.error).toContain(`owned by writer task ${first.task.id}`);
    expect(herdr.calls.filter((call) => call[1] === "split")).toHaveLength(1);

    const callsBefore = herdr.calls.length;
    const revised = await reviseTask({
      taskId: first.task.id,
      text: "Also cover the empty input",
      deps: d,
    });
    if (!revised.ok) throw new Error(revised.error);
    expect(revised.attempt).toMatchObject({ purpose: "revision", seq: 2, state: "working" });
    expect(herdr.calls.slice(callsBefore)).toEqual([["agent", "prompt", lane.agentName]]);
    expect(herdr.prompts.at(-1)).toEqual({
      target: lane.agentName,
      text: "Also cover the empty input",
    });

    const panel = await dispatchPlan({
      plan: plan("reviewers"),
      prompt: "Review",
      worktreeId: "/work/project",
      deps: d,
    });
    expect(panel.ok).toBe(true);
    expect(
      await reviseTask({ taskId: panel.ok ? panel.task.id : "", text: "x", deps: d }),
    ).toMatchObject({
      ok: false,
      code: "not-writer",
    });
  });

  it("refuses to resend after a timeout and only continues after recorded evidence", async () => {
    const herdr = fakeHerdr({
      prompt: (_target, count) =>
        count === 1 ? failed("", "process killed after timeout") : ok('{"agent_status":"working"}'),
    });
    const { deps: d, home } = deps(herdr);
    const first = await dispatchPlan({
      plan: plan("feature"),
      prompt: "Build it",
      worktreeId: "/w/a",
      deps: d,
    });
    if (!first.ok) throw new Error(first.error);
    expect(first.task.status).toBe("partial");
    const lane = first.lanes[0]!;
    expect(lane.attempt).toEqual({
      id: expect.stringMatching(/^att_/),
      state: "unknown",
      evidence: "herdr agent prompt returned no delivery evidence: process killed after timeout",
    });

    // A restart sees the same record: a new repository on the same database.
    const restarted = { ...d, store: new DispatchRepository(openDatabase({ home })) };
    const status = executeTaskStatus(restarted.store, first.task.id);
    expect(status.output).toContain(`attempt 1 [${lane.attempt!.id}] initial: unknown`);
    expect(status.output).toContain("An idle or finished-looking pane is not completion");

    const blocked = await reviseTask({ taskId: first.task.id, text: "Retry", deps: restarted });
    expect(blocked).toMatchObject({ ok: false, code: "unresolved-attempt" });
    expect(herdr.prompts).toHaveLength(1);
    expect(
      executeTaskClose(restarted.store, first.task.id, {
        status: "complete",
        evidence: "looks done",
      }).code,
    ).toBe(2);

    expect(executeTaskRecover(restarted.store, lane.attempt!.id, { delivered: true }).output).toBe(
      "--evidence <text> is required: say what you saw in the pane.",
    );
    expect(
      executeTaskRecover(restarted.store, lane.attempt!.id, {
        delivered: true,
        evidence: "prompt visible in pane scrollback",
      }).code,
    ).toBe(0);
    const revised = await reviseTask({ taskId: first.task.id, text: "Next step", deps: restarted });
    expect(revised).toMatchObject({ ok: true, attempt: { seq: 2, state: "working" } });
    expect(herdr.prompts).toHaveLength(2);

    expect(
      executeTaskClose(restarted.store, first.task.id, {
        status: "complete",
        evidence: "tests pass at abc123",
      }),
    ).toMatchObject({
      code: 0,
      output: `Task ${first.task.id} is complete; its worktree ownership was released.`,
    });
    expect(restarted.store.ownerOf("/w/a")).toBeUndefined();
  });

  it("treats a sending attempt left by a stopped process as unresolved", async () => {
    const { deps: d } = deps(fakeHerdr());
    const created = d.store.createTask({
      role: "feature",
      kind: "single",
      access: "write",
      worktreeId: "/w/crash",
      cwd: "/w/crash",
      rulesPath: FIXTURE,
      lanes: [
        {
          index: 1,
          descriptor: "codex:gpt-6.1-sol@high",
          provider: "codex",
          model: "gpt-6.1-sol",
          effort: "high",
          argv: ["codex"],
        },
      ],
    });
    const lane = created.lanes[0]!;
    d.store.updateLane(lane.id, {
      agentName: "hmr-codex-x",
      paneId: "w1:p9",
      state: "agent-started",
    });
    d.store.beginAttempt({ laneId: lane.id, purpose: "initial", promptSha256: "0".repeat(64) });
    expect(() =>
      d.store.beginAttempt({ laneId: lane.id, purpose: "revision", promptSha256: "1".repeat(64) }),
    ).toThrow(/is sending: the router cannot tell whether that prompt reached the agent/);
    expect(executeTaskStatus(d.store, created.task.id).output).toContain(
      "initial: sending (no outcome recorded; the router may have stopped mid-send)",
    );
  });

  it("refuses a revision when the original agent is gone instead of relaunching", async () => {
    const herdr = fakeHerdr();
    const { deps: d } = deps(herdr);
    const first = await dispatchPlan({
      plan: plan("feature"),
      prompt: "Build",
      worktreeId: "/w/gone",
      deps: d,
    });
    if (!first.ok) throw new Error(first.error);
    herdr.panes.get(first.lanes[0]!.paneId!)!.gone = true;
    const before = herdr.calls.length;
    expect(await reviseTask({ taskId: first.task.id, text: "More", deps: d })).toMatchObject({
      ok: false,
      code: "agent-gone",
    });
    expect(herdr.calls.length).toBe(before);
    expect(
      executeTaskClose(d.store, first.task.id, {
        status: "released",
        evidence: "pane closed by user",
      }).output,
    ).toBe(
      "Release needs --stopped: confirm the writer has stopped. Use `task complete` for finished work.",
    );
    expect(
      executeTaskClose(d.store, first.task.id, {
        status: "released",
        stopped: true,
        evidence: "pane closed by user",
      }).code,
    ).toBe(0);
    expect(d.store.ownerOf("/w/gone")).toBeUndefined();
  });

  it("releases ownership on its own only when no prompt was ever sent", async () => {
    const herdr = fakeHerdr({ detect: () => ({ status: "unknown", ready: false }) });
    const { deps: d } = deps(herdr);
    const result = await dispatchPlan({
      plan: plan("feature"),
      prompt: "Build",
      worktreeId: "/w/nostart",
      deps: d,
    });
    expect(result).toMatchObject({
      ok: true,
      task: {
        status: "failed",
        closingEvidence: "no prompt was sent; ownership released automatically",
      },
    });
    expect(d.store.ownerOf("/w/nostart")).toBeUndefined();
  });

  it("sends nothing when the task is closed and replaced while a revision waits on Herdr", async () => {
    let replacement: string | undefined;
    let armed = false;
    const herdr = fakeHerdr({
      onGetAgent: () => {
        if (!armed) return;
        armed = false;
        // Another session finishes the original writer and starts a new one meanwhile.
        executeTaskClose(d.store, first.task.id, { status: "complete", evidence: "merged" });
        replacement = d.store.createTask({
          role: "feature",
          kind: "single",
          access: "write",
          worktreeId: "/w/race",
          cwd: "/w/race",
          rulesPath: FIXTURE,
          lanes: [],
        }).task.id;
      },
    });
    const { deps: d } = deps(herdr);
    const dispatched = await dispatchPlan({
      plan: plan("feature"),
      prompt: "Build",
      worktreeId: "/w/race",
      deps: d,
    });
    if (!dispatched.ok) throw new Error(dispatched.error);
    const first = dispatched;
    const promptsBefore = herdr.prompts.length;
    armed = true;
    const revised = await reviseTask({ taskId: first.task.id, text: "One more thing", deps: d });
    expect(revised).toMatchObject({ ok: false, code: "not-owner" });
    expect(revised.ok ? "" : revised.error).toBe(
      `Task ${first.task.id} is complete; no prompt is sent for a closed task.`,
    );
    expect(herdr.prompts.length).toBe(promptsBefore);
    expect(d.store.attempts(first.lanes[0]!.laneId).map((attempt) => attempt.purpose)).toEqual([
      "initial",
    ]);
    expect(d.store.getTask(first.task.id)?.status).toBe("complete");
    expect(d.store.ownerOf("/w/race")?.taskId).toBe(replacement);
  });

  it("refuses a revision from a writer whose ownership moved, even if its task is open", async () => {
    const herdr = fakeHerdr();
    const { deps: d, db } = deps(herdr);
    const first = await dispatchPlan({
      plan: plan("feature"),
      prompt: "Build",
      worktreeId: "/w/moved",
      deps: d,
    });
    if (!first.ok) throw new Error(first.error);
    // Simulate ownership pointing elsewhere (for example, after manual repair of the store).
    const other = d.store.createTask({
      role: "explorer",
      kind: "single",
      access: "read",
      worktreeId: "/w/elsewhere",
      cwd: "/w/elsewhere",
      rulesPath: FIXTURE,
      lanes: [],
    }).task.id;
    db.prepare("update writer_ownership set task_id = ? where worktree_id = ?").run(
      other,
      "/w/moved",
    );
    const promptsBefore = herdr.prompts.length;
    expect(await reviseTask({ taskId: first.task.id, text: "x", deps: d })).toMatchObject({
      ok: false,
      code: "not-owner",
    });
    expect(herdr.prompts.length).toBe(promptsBefore);
  });

  it("never prompts or reopens a writer released while its launch was in progress", async () => {
    let replacement: string | undefined;
    let taskId = "";
    const herdr = fakeHerdr({
      onRename: () => {
        taskId = d.store.listTasks(1)[0]!.id;
        // `complete` is refused while dispatching; a stopped router is released instead.
        expect(
          executeTaskClose(d.store, taskId, { status: "complete", evidence: "too early" }).output,
        ).toBe(
          `Task ${taskId} is still dispatching; it cannot be completed yet. If the router stopped, release it with --stopped and evidence.`,
        );
        executeTaskClose(d.store, taskId, {
          status: "released",
          stopped: true,
          evidence: "router killed",
        });
        replacement = d.store.createTask({
          role: "bug-fix",
          kind: "single",
          access: "write",
          worktreeId: "/w/launch-race",
          cwd: "/w/launch-race",
          rulesPath: FIXTURE,
          lanes: [],
        }).task.id;
      },
    });
    const { deps: d } = deps(herdr);
    const result = await dispatchPlan({
      plan: plan("feature"),
      prompt: "Build",
      worktreeId: "/w/launch-race",
      deps: d,
    });
    if (!result.ok) throw new Error(result.error);
    expect(herdr.prompts).toEqual([]);
    expect(result.lanes[0]).toMatchObject({ state: "failed" });
    expect(result.lanes[0]?.error).toBe(
      `Task ${taskId} is released; no prompt is sent for a closed task. The agent in pane w1:p1 was left running and was not prompted.`,
    );
    expect(result.task).toMatchObject({
      id: taskId,
      status: "released",
      closingEvidence: "router killed",
    });
    expect(d.store.ownerOf("/w/launch-race")?.taskId).toBe(replacement);
  });

  it("stops prompting the remaining panel lanes once the panel task is released", async () => {
    let released = false;
    const herdr = fakeHerdr({
      onRename: () => {
        if (released) return;
        released = true;
        const id = d.store.listTasks(1)[0]!.id;
        executeTaskClose(d.store, id, { status: "released", stopped: true, evidence: "cancelled" });
      },
    });
    const { deps: d } = deps(herdr);
    const result = await dispatchPlan({
      plan: plan("reviewers"),
      prompt: "Review",
      worktreeId: "/w/p",
      deps: d,
    });
    expect(herdr.prompts).toEqual([]);
    expect(result.ok && result.lanes.map((lane) => lane.state)).toEqual([
      "failed",
      "failed",
      "failed",
    ]);
    expect(result.ok && result.task.status).toBe("released");
  });

  it("records agent_blocked as not delivered", async () => {
    const herdr = fakeHerdr({
      prompt: () => failed(JSON.stringify({ error: { code: "agent_blocked" } })),
    });
    const { deps: d } = deps(herdr);
    const result = await dispatchPlan({
      plan: plan("explorer"),
      prompt: "Map",
      worktreeId: "/w/b",
      deps: d,
    });
    expect(result.ok && result.lanes[0]?.attempt).toMatchObject({
      state: "not-delivered",
      evidence: "herdr rejected the prompt with agent_blocked before sending any input",
    });
  });
});

describe("launch environment", () => {
  it("passes only allowlisted variables to Herdr IPC and CLI probes, and carries no key names into a launch", () => {
    const envs: (NodeJS.ProcessEnv | undefined)[] = [];
    const home = mkdtempSync(path.join(os.tmpdir(), "hmr-env-"));
    const opened = openDispatchDeps(
      {
        MODEL_ROUTER_HOME: home,
        PATH: "/usr/bin",
        HOME: "/home/dev",
        HERDR_ENV: "1",
        HERDR_PANE_ID: "w1:p0",
        CODEX_HOME: "/home/dev/.codex",
        OPENAI_API_KEY: "sk-test-openai",
        ANTHROPIC_API_KEY: "sk-ant-test",
        XAI_API_KEY: "xai-test",
        CURSOR_API_KEY: "cursor-test",
        TYPESAFE_API_KEY: "ts-test",
      },
      {
        createProcessAdapter: (options) => {
          envs.push(options.env);
          return async () => ok();
        },
      },
    );
    opened.close();
    expect(
      opened.launchEnvNames.filter((name) => /KEY|TOKEN|SECRET|CREDENTIAL/.test(name)),
    ).toEqual([]);
    expect(opened.launchEnvNames).toEqual(
      expect.arrayContaining(["HERDR_ENV", "HERDR_PANE_ID", "HOME", "PATH"]),
    );
    expect(envs).toHaveLength(2);
    for (const env of envs) {
      expect(env).toEqual({
        PATH: "/usr/bin",
        HOME: "/home/dev",
        HERDR_ENV: "1",
        HERDR_PANE_ID: "w1:p0",
        CODEX_HOME: "/home/dev/.codex",
      });
    }
  });
});
