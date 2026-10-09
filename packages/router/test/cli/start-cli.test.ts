import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every way the CLI could start a process or open the router database is recorded, so the
// offline paths of `start` can be shown to have done neither.
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

const RULES = [
  "---",
  "description: Synthetic roles",
  "---",
  "coordinator: claude:claude-opus-5-5@high",
  "writer: grok:grok-4.7@high",
  "reviewers: codex:gpt-6.1-sol@high",
  "",
].join("\n");

function sandbox(rules: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), "hmr-start-cli-"));
  const project = path.join(root, "project");
  mkdirSync(path.join(project, ".git"), { recursive: true });
  mkdirSync(path.join(project, ".model-router"), { recursive: true });
  writeFileSync(path.join(project, ".model-router", "pstack-models.mdc"), rules);
  return { root, project, home: path.join(root, "home"), routerHome: path.join(root, "router") };
}

async function cli(
  box: ReturnType<typeof sandbox>,
  args: string[],
  env: Record<string, string> = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const createTypeSafeClient = vi.fn();
  const code = await runCli(["node", "hmr", ...args], {
    stdout: { write: (chunk) => out.push(chunk) > 0 },
    stderr: { write: (chunk) => err.push(chunk) > 0 },
    env: { HOME: box.home, MODEL_ROUTER_HOME: box.routerHome, PATH: "/nonexistent", ...env },
    cwd: box.project,
    rulesOverrides: { createTypeSafeClient },
  });
  return { code, out: out.join(""), err: err.join(""), createTypeSafeClient };
}

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  effects.processes.length = 0;
  effects.databases.length = 0;
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network used"));
});
afterEach(() => fetchSpy.mockRestore());

function expectNoEffects(box: ReturnType<typeof sandbox>, result: Awaited<ReturnType<typeof cli>>) {
  expect(effects.processes).toEqual([]);
  expect(effects.databases).toEqual([]);
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(result.createTypeSafeClient).not.toHaveBeenCalled();
  expect(existsSync(box.routerHome)).toBe(false);
}

describe("hmr start (CLI)", () => {
  it("previews the rules file's coordinator with zero effects, even with a TypeSafe key around", async () => {
    const box = sandbox(RULES);
    const result = await cli(box, ["start", "Add a greeting file.", "--dry-run", "--json"], {
      TYPESAFE_API_KEY: "ts-not-an-opt-in",
    });
    expect(result.code).toBe(0);
    const json = JSON.parse(result.out);
    expect(json).toMatchObject({
      dryRun: true,
      effects: [],
      coordinator: { role: "coordinator", descriptor: "claude:claude-opus-5-5@high" },
    });
    expect(json.roles).toContain("- writer -> grok:grok-4.7@high (single writer)");
    expectNoEffects(box, result);
  });

  it("refuses without a coordinator role instead of picking a model", async () => {
    const box = sandbox(RULES.replace("coordinator: claude:claude-opus-5-5@high\n", ""));
    const result = await cli(box, ["start", "Add a greeting file.", "--dry-run"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain('no "coordinator" role');
    expectNoEffects(box, result);
  });

  it("refuses a real start outside Herdr before opening any state", async () => {
    const box = sandbox(RULES);
    const result = await cli(box, ["start", "Add a greeting file."]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("HERDR_ENV=1");
    expectNoEffects(box, result);
  });
});
