import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Questions, SystemOneRequest, SystemOneResult } from "@typesafe-ai/sdk";
import type { TypeSafePort } from "../../src/semantic/typesafe-client.js";

// Every way the CLI could start a process or open the router database is recorded, so a
// preview can be shown to have done neither.
const effects = vi.hoisted(() => ({ processes: [] as string[], databases: [] as string[] }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      effects.processes.push(`${name} ${String(args[0])}`);
      throw new Error(`unexpected ${name} in an offline command`);
    };
  return {
    ...actual,
    spawn: record("spawn"),
    spawnSync: record("spawnSync"),
    exec: record("exec"),
    execSync: record("execSync"),
    execFile: record("execFile"),
    execFileSync: record("execFileSync"),
  };
});

vi.mock("better-sqlite3", async (importOriginal) => {
  const actual = await importOriginal<{ default: new (...args: unknown[]) => unknown }>();
  function Recorded(this: unknown, ...args: unknown[]) {
    effects.databases.push(String(args[0]));
    return new actual.default(...args);
  }
  return { default: Recorded };
});

const { runCli } = await import("../../src/cli.js");

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/rules/pstack-models.mdc",
);

interface Sandbox {
  root: string;
  home: string;
  routerHome: string;
  project: string;
}

function sandbox(): Sandbox {
  const root = mkdtempSync(path.join(os.tmpdir(), "hmr-cli-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  mkdirSync(path.join(home, ".cursor/rules"), { recursive: true });
  writeFileSync(path.join(home, ".cursor/rules/pstack-models.mdc"), readFileSync(FIXTURE, "utf8"));
  mkdirSync(path.join(project, ".git"), { recursive: true });
  return { root, home, project, routerHome: path.join(root, "router-home") };
}

function fakeTypeSafe(answers: Record<string, unknown>): TypeSafePort {
  const calls: SystemOneRequest[] = [];
  return {
    calls,
    async systemOne<const Q extends Questions>(
      request: SystemOneRequest<Q>,
    ): Promise<SystemOneResult<Q>> {
      calls.push(request as SystemOneRequest);
      return {
        model: "fake",
        answers: answers as SystemOneResult<Q>["answers"],
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  };
}

async function cli(
  box: Sandbox,
  args: string[],
  extra: { env?: Record<string, string>; client?: TypeSafePort } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const createTypeSafeClient = vi.fn<(key: string) => TypeSafePort>(
    () => extra.client ?? fakeTypeSafe({}),
  );
  const readKeychain = vi.fn<(service: string) => string | undefined>(() => undefined);
  const code = await runCli(["node", "router", ...args], {
    stdout: { write: (chunk) => out.push(chunk) > 0 },
    stderr: { write: (chunk) => err.push(chunk) > 0 },
    env: {
      HOME: box.home,
      MODEL_ROUTER_HOME: box.routerHome,
      PATH: "/nonexistent",
      ...extra.env,
    },
    cwd: box.project,
    rulesOverrides: { createTypeSafeClient, readKeychain },
  });
  return { code, out: out.join(""), err: err.join(""), createTypeSafeClient, readKeychain };
}

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  effects.processes.length = 0;
  effects.databases.length = 0;
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network used"));
});
afterEach(() => {
  fetchSpy.mockRestore();
});

function expectNoEffects(box: Sandbox, result: Awaited<ReturnType<typeof cli>>) {
  expect(effects.processes).toEqual([]);
  expect(effects.databases).toEqual([]);
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(result.createTypeSafeClient).not.toHaveBeenCalled();
  expect(result.readKeychain).not.toHaveBeenCalled();
  expect(existsSync(box.routerHome)).toBe(false);
}

describe("offline rules preview (AE1, AE2)", () => {
  it("plans an aliased role from the user rules with literal lanes and zero effects", async () => {
    const box = sandbox();
    const result = await cli(box, ["plan", "--role", "refactoring", "--json"], {
      env: { TYPESAFE_API_KEY: "ts-ambient-key-not-an-opt-in" },
    });
    expect(result.code).toBe(0);
    const json = JSON.parse(result.out);
    expect(json).toMatchObject({
      ok: true,
      role: "refactoring",
      roleNames: ["feature", "refactoring"],
      kind: "single",
      access: "write",
      rulesSource: { path: path.join(box.home, ".cursor/rules/pstack-models.mdc"), origin: "user" },
      cwd: box.project,
      effects: [],
      dispatch: "not-started",
      launchable: true,
    });
    expect(json.lanes).toEqual([
      expect.objectContaining({ index: 1, descriptor: "codex:gpt-6.1-sol@high", from: "rule" }),
    ]);
    expect(json.launches).toEqual([
      {
        ok: true,
        index: 1,
        kind: "codex",
        argv: ["codex", "--model", "gpt-6.1-sol", "-c", 'model_reasoning_effort="high"'],
      },
    ]);
    expect(result.out).not.toContain("ts-ambient-key");
    expectNoEffects(box, result);
  });

  it("dry-runs a three-lane panel in order, duplicates kept, with an ambient key and no opt-in", async () => {
    const box = sandbox();
    const result = await cli(
      box,
      ["run", "Review the parser change", "--role", "reviewers", "--dry-run"],
      {
        env: { TYPESAFE_API_KEY: "ts-ambient-key-not-an-opt-in", HERDR_ENV: "1" },
      },
    );
    expect(result.code).toBe(0);
    expect(result.out).toContain("Kind: panel, 3 lanes, every lane runs; access: read-only");
    expect(result.out.match(/^Lane \d: .*$/gm)).toEqual([
      "Lane 1: claude:claude-opus-5-5@high [rule]",
      "Lane 2: codex:gpt-6.1-sol@xhigh [rule]",
      "Lane 3: claude:claude-opus-5-5@high [rule]",
    ]);
    expect(result.out.match(/^ {2}argv: .*$/gm)).toEqual([
      "  argv: claude --model claude-opus-5-5 --effort high --permission-mode plan",
      '  argv: codex --model gpt-6.1-sol -c model_reasoning_effort="xhigh" --sandbox read-only',
      "  argv: claude --model claude-opus-5-5 --effort high --permission-mode plan",
    ]);
    expect(result.out).toContain(
      "Preview only: no model, pane, network, credential, or router state was touched.",
    );
    expectNoEffects(box, result);
  });

  it("reports the available roles instead of guessing when no role is given", async () => {
    const box = sandbox();
    const result = await cli(box, ["run", "Fix the flaky test", "--json"], {
      env: { TYPESAFE_API_KEY: "ts-ambient-key-not-an-opt-in" },
    });
    expect(result.code).toBe(2);
    const json = JSON.parse(result.out);
    expect(json).toMatchObject({ ok: false, code: "role-required" });
    expect(json.availableRoles).toEqual([
      "feature",
      "refactoring",
      "bug-fix",
      "legacy writer",
      "explorer",
      "judgment and prose",
      "hardest tasks",
      "synthesizer",
      "reviewers",
      "arena runners",
      "cursor reader",
    ]);
    expectNoEffects(box, result);
  });

  it("lists roles, panels and invalid entries", async () => {
    const box = sandbox();
    const result = await cli(box, ["roles"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("  feature, refactoring: codex:gpt-6.1-sol@high\n");
    expect(result.out).toContain(
      "  arena runners: inherit-parent, inherit-parent, grok:grok-4.7@xhigh  [panel, 3 lanes]\n",
    );
    expectNoEffects(box, result);
  });

  it("shows the legacy Grok translation and resolves parent lanes from --parent", async () => {
    const box = sandbox();
    const result = await cli(box, [
      "plan",
      "--role",
      "arena runners",
      "--parent",
      "claude:claude-opus-5-5@max",
    ]);
    expect(result.code).toBe(0);
    expect(result.out.match(/^Lane \d: .*$/gm)).toEqual([
      "Lane 1: claude:claude-opus-5-5@max [parent via inherit-parent]",
      "Lane 2: claude:claude-opus-5-5@max [parent via inherit-parent]",
      "Lane 3: grok:grok-4.7@xhigh [rule]",
    ]);
    expect(result.out).toContain(
      "  argv: grok --model grok-4.7 --reasoning-effort xhigh --permission-mode plan",
    );
    expect(result.out).toContain(
      "  note: legacy Cursor selector grok-4.7-xhigh-fast mapped to native grok:grok-4.7@xhigh; Cursor's fast variant has no native grok equivalent",
    );
    expectNoEffects(box, result);
  });

  it("refuses a parent alias without --parent", async () => {
    const box = sandbox();
    const result = await cli(box, ["plan", "--role", "synthesizer"]);
    expect(result.code).toBe(2);
    expect(result.err).toBe(
      'Refused (parent-unresolved): role "synthesizer" uses parent; pass --parent provider:model@effort to say which model the parent runs\n',
    );
    expectNoEffects(box, result);
  });

  it("refuses a project pin conflict and a forbidden policy key", async () => {
    const box = sandbox();
    mkdirSync(path.join(box.project, ".model-router"), { recursive: true });
    writeFileSync(
      path.join(box.project, ".model-router/policy.json"),
      JSON.stringify({ version: 1, pins: { feature: "codex:gpt-6.1-sol@xhigh" } }),
    );
    const pinned = await cli(box, [
      "run",
      "Add the endpoint",
      "--role",
      "feature",
      "--dry-run",
      "--json",
    ]);
    expect(pinned.code).toBe(2);
    expect(JSON.parse(pinned.out)).toEqual({
      ok: false,
      code: "pin-conflict",
      role: "feature",
      error:
        'project policy pin "feature" requires codex:gpt-6.1-sol@xhigh for role "feature", but the rules resolve lane 1 to codex:gpt-6.1-sol@high; nothing was planned',
      pinKey: "feature",
      expected: ["codex:gpt-6.1-sol@xhigh"],
      actual: ["codex:gpt-6.1-sol@high"],
    });
    writeFileSync(
      path.join(box.project, ".model-router/policy.json"),
      JSON.stringify({ version: 1, env: { OPENAI_API_KEY: "sk-test" } }),
    );
    const invalid = await cli(box, ["plan", "--role", "feature"]);
    expect(invalid.code).toBe(2);
    expect(invalid.err).toContain('invalid project policy: (root): Unrecognized key: "env"');
    expectNoEffects(box, invalid);
  });

  it("prefers a project rules file over the user file", async () => {
    const box = sandbox();
    mkdirSync(path.join(box.project, ".model-router"), { recursive: true });
    writeFileSync(
      path.join(box.project, ".model-router/pstack-models.mdc"),
      "feature: claude:claude-opus-5-5@low\n",
    );
    const result = await cli(box, ["plan", "--role", "feature", "--json"]);
    expect(JSON.parse(result.out)).toMatchObject({
      rulesSource: {
        path: path.join(box.project, ".model-router/pstack-models.mdc"),
        origin: "project",
      },
      lanes: [expect.objectContaining({ descriptor: "claude:claude-opus-5-5@low" })],
    });
  });

  it("answers to the hmr name", async () => {
    const box = sandbox();
    const out: string[] = [];
    await runCli(["node", "/usr/local/bin/hmr", "--help"], {
      stdout: { write: (chunk) => out.push(chunk) > 0 },
      env: { HOME: box.home, MODEL_ROUTER_HOME: box.routerHome },
      cwd: box.project,
    });
    expect(out.join("")).toMatch(/^Usage: hmr /);
  });
});

describe("effect detectors (canaries for the assertions above)", () => {
  it("records the database a task command opens and the process a launch starts", async () => {
    const box = sandbox();
    const status = await cli(box, ["task", "status"]);
    expect(status.code).toBe(0);
    expect(effects.databases).toEqual([path.join(box.routerHome, "state.sqlite")]);
    // A codex on PATH makes the launch reach its first process: the --help capability probe.
    const bin = path.join(box.root, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "codex"), "#!/bin/sh\n", { mode: 0o755 });
    const launch = await cli(box, ["run", "Add the endpoint", "--role", "feature"], {
      env: { HERDR_ENV: "1", PATH: bin },
    });
    expect(launch.code).toBe(1);
    expect(effects.processes).toEqual([`spawn ${path.join(bin, "codex")}`]);
  });
});

describe("rolling model aliases are refused before any effect", () => {
  it("refuses them in the rules file and in --parent, even for a real launch", async () => {
    const box = sandbox();
    writeFileSync(
      path.join(box.home, ".cursor/rules/pstack-models.mdc"),
      "planner: claude:opus@high\nsynthesizer: parent\n",
    );
    const fromRules = await cli(box, ["plan", "--role", "planner"]);
    expect(fromRules.code).toBe(2);
    expect(fromRules.err).toContain('"opus" is a rolling or automatic model alias');
    expectNoEffects(box, fromRules);
    const fromParent = await cli(
      box,
      ["run", "Summarize", "--role", "synthesizer", "--parent", "claude:opusplan"],
      { env: { HERDR_ENV: "1" } },
    );
    expect(fromParent.code).toBe(2);
    expect(fromParent.err).toContain('"opusplan" is a rolling or automatic model alias');
    expectNoEffects(box, fromParent);
  });
});

describe("semantic mode is per-invocation opt-in (AE2)", () => {
  it("skips the classifier entirely when a role is given", async () => {
    const box = sandbox();
    const result = await cli(
      box,
      [
        "run",
        "Implement it",
        "--routing-mode",
        "semantic",
        "--role",
        "bug-fix",
        "--dry-run",
        "--json",
      ],
      { env: { TYPESAFE_API_KEY: "ts-key" } },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({
      role: "bug-fix",
      lanes: [expect.objectContaining({ descriptor: "claude:claude-opus-5-5@xhigh" })],
      notes: ["explicit --role given; the TypeSafe classifier was not called"],
      effects: [],
    });
    expectNoEffects(box, result);
  });

  it("lets TypeSafe pick only a role; lanes and efforts still come from the rules", async () => {
    const box = sandbox();
    const client = fakeTypeSafe({
      role: { type: "choice", choice: "reviewers", confidence: 0.8, probabilities: {} },
    });
    const result = await cli(
      box,
      ["run", "Second opinion on the diff", "--routing-mode", "semantic", "--dry-run", "--json"],
      {
        env: { TYPESAFE_API_KEY: "ts-key" },
        client,
      },
    );
    expect(result.code).toBe(0);
    expect(result.createTypeSafeClient).toHaveBeenCalledWith("ts-key");
    expect(client.calls).toHaveLength(1);
    expect(Object.keys(client.calls[0]!.questions)).toEqual(["role"]);
    const json = JSON.parse(result.out);
    expect(json.role).toBe("reviewers");
    expect(json.lanes.map((lane: { descriptor: string }) => lane.descriptor)).toEqual([
      "claude:claude-opus-5-5@high",
      "codex:gpt-6.1-sol@xhigh",
      "claude:claude-opus-5-5@high",
    ]);
    expect(json.effects).toEqual(["typesafe-classification"]);
    expect(effects.databases).toEqual([]);
  });

  it.each([
    [
      { role: { type: "choice", choice: "deploy", confidence: 0.9, probabilities: {} } },
      /not a role in the rules file/,
    ],
    [
      {
        role: { type: "choice", choice: "feature", confidence: 0.9, probabilities: {} },
        model: { type: "choice", choice: "gpt-6", confidence: 1, probabilities: {} },
      },
      /fields beyond a role \(model\)/,
    ],
  ])("refuses a classifier answer outside its authority", async (answers, message) => {
    const box = sandbox();
    const result = await cli(box, ["run", "Do it", "--routing-mode", "semantic", "--dry-run"], {
      env: { TYPESAFE_API_KEY: "ts-key" },
      client: fakeTypeSafe(answers),
    });
    expect(result.code).toBe(2);
    expect(result.err).toMatch(message);
  });

  it("fails without a key instead of falling back to another route", async () => {
    const box = sandbox();
    const result = await cli(box, [
      "run",
      "Do it",
      "--routing-mode",
      "semantic",
      "--dry-run",
      "--json",
    ]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.out)).toMatchObject({ ok: false, code: "typesafe-unavailable" });
    expect(result.createTypeSafeClient).not.toHaveBeenCalled();
    expect(effects.processes).toEqual([]);
  });

  it("keeps the legacy quota flags behind --routing-mode quota", async () => {
    const box = sandbox();
    const result = await cli(box, ["run", "Do it", "--role", "feature", "--worktree"]);
    expect(result.code).toBe(2);
    expect(result.err).toBe("--worktree need --routing-mode quota\n");
    expectNoEffects(box, result);
  });
});
