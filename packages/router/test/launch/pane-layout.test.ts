import { describe, expect, it } from "vitest";
import type { CommandResult } from "../../src/launch/herdr-client.js";
import {
  closeFinished,
  placeMain,
  placeWorker,
  planWorker,
  ticketOf,
  workerAgentName,
  workerLabel,
  type LayoutPane,
} from "../../src/launch/pane-layout.js";
import { createReviewGuard } from "../../src/launch/review-guard.js";

const ok = (result: unknown): CommandResult => ({
  ok: true,
  code: 0,
  stdout: JSON.stringify({ result }),
  stderr: "",
});
const okText = (stdout: string): CommandResult => ({ ok: true, code: 0, stdout, stderr: "" });
const bad = (stderr = "boom"): CommandResult => ({ ok: false, code: 1, stdout: "", stderr });

function fakeRun(handler: (argv: readonly string[]) => CommandResult) {
  const calls: string[][] = [];
  return {
    calls,
    run: async (argv: readonly string[]) => {
      calls.push([...argv]);
      return handler(argv);
    },
  };
}

const env = {
  HERDR_PANE_ID: "w1:p1",
  HERDR_TAB_ID: "w1:t2",
  HERDR_WORKSPACE_ID: "w1",
  HOME: "/Users/x",
};
const pane = (id: string, label?: string, tab = "w1:t2", extra: Record<string, unknown> = {}) => ({
  pane_id: id,
  tab_id: tab,
  agent_status: "idle",
  ...(label ? { label } : {}),
  ...extra,
});

describe("§13 names", () => {
  it("derives the ticket from HMR_TICKET or the cwd", () => {
    expect(ticketOf({ HMR_TICKET: "agent-519" }, "/x")).toBe("AGENT-519");
    expect(ticketOf({}, "/Users/x/herdr-worktrees/repo/AGENT-77")).toBe("AGENT-77");
    expect(ticketOf({}, "/Users/x/projects/repo")).toBeUndefined();
  });
  it("labels and names workers within Herdr's 32-char limit", () => {
    expect(workerLabel(2, "review", "AGENT-123")).toBe("W2 review · AGENT-123");
    expect(workerAgentName(1, "writer", "AGENT-123")).toBe("w1-writer-agent-123");
    expect(
      workerAgentName(3, "a-very-long-role-name-indeed", "AGENT-123456").length,
    ).toBeLessThanOrEqual(32);
    expect(workerAgentName(3, "a-very-long-role-name-indeed", "AGENT-123456")).toMatch(
      /^[a-z][a-z0-9_-]{0,31}$/,
    );
  });
});

describe("planWorker", () => {
  const p = (id: string, label?: string): LayoutPane => ({
    paneId: id,
    tabId: "t",
    status: "idle",
    ...(label ? { label } : {}),
  });
  it("splits MAIN right at 0.5 for the first worker", () => {
    expect(planWorker("m", [p("m")])).toEqual({
      target: "m",
      direction: "right",
      ratio: 0.5,
      n: 1,
    });
  });
  it("splits the bottom-most worker down for later workers and reuses a freed slot number", () => {
    expect(planWorker("m", [p("m"), p("a", "W1 writer · AGENT-1")])).toEqual({
      target: "a",
      direction: "down",
      n: 2,
    });
    expect(planWorker("m", [p("m"), p("b", "W2 review · AGENT-1")])).toEqual({
      target: "b",
      direction: "down",
      n: 1,
    });
  });
  it("is full at MAIN + 3 workers", () => {
    expect(planWorker("m", [p("m"), p("a"), p("b"), p("c")])).toEqual({ full: true });
  });
});

describe("placeWorker", () => {
  it("labels MAIN, splits it right, and labels the worker", async () => {
    const f = fakeRun((argv) => {
      if (argv[2] === "list")
        return ok({ panes: [pane("w1:p1"), pane("w1:p9", undefined, "w1:t1")] });
      if (argv[2] === "split") return ok({ pane: { pane_id: "w1:p5" } });
      return ok({});
    });
    const placed = await placeWorker(
      { run: f.run, env },
      { cwd: "/w/AGENT-519", role: "feature", access: "write" },
    );
    expect(placed).toEqual({
      ok: true,
      paneId: "w1:p5",
      label: "W1 writer · AGENT-519",
      agentName: "w1-writer-agent-519",
      ticket: "AGENT-519",
    });
    expect(f.calls).toContainEqual(["herdr", "pane", "rename", "w1:p1", "MAIN · AGENT-519"]);
    expect(f.calls).toContainEqual([
      "herdr",
      "pane",
      "split",
      "w1:p1",
      "--direction",
      "right",
      "--ratio",
      "0.5",
      "--cwd",
      "/w/AGENT-519",
      "--no-focus",
    ]);
    expect(f.calls).toContainEqual(["herdr", "pane", "rename", "w1:p5", "W1 writer · AGENT-519"]);
  });
  it("queues past the cap and refuses when no slot frees, starting nothing", async () => {
    const f = fakeRun((argv) =>
      argv[2] === "list"
        ? ok({
            panes: [
              pane("w1:p1", "MAIN · AGENT-1"),
              pane("w1:p2", "W1 writer · AGENT-1"),
              pane("w1:p3", "W2 review · AGENT-1"),
              pane("w1:p4", "W3 review · AGENT-1"),
            ],
          })
        : ok({}),
    );
    let slept = 0;
    const placed = await placeWorker(
      {
        run: f.run,
        env,
        queueTimeoutMs: 0,
        sleep: async () => {
          slept += 1;
        },
      },
      { cwd: "/w/AGENT-1", role: "review gate", access: "read" },
    );
    expect(placed.ok).toBe(false);
    expect(placed.ok ? "" : placed.error).toMatch(/cap reached/);
    expect(f.calls.some((c) => c[2] === "split")).toBe(false);
    expect(slept).toBe(0);
  });
  it("takes the slot once a worker closes while queued", async () => {
    let lists = 0;
    const f = fakeRun((argv) => {
      if (argv[2] === "list") {
        lists += 1;
        const workers =
          lists === 1
            ? [
                pane("w1:p2", "W1 writer · AGENT-1"),
                pane("w1:p3", "W2 review · AGENT-1"),
                pane("w1:p4", "W3 review · AGENT-1"),
              ]
            : [pane("w1:p2", "W1 writer · AGENT-1"), pane("w1:p4", "W3 review · AGENT-1")];
        return ok({ panes: [pane("w1:p1", "MAIN · AGENT-1"), ...workers] });
      }
      if (argv[2] === "split") return ok({ pane: { pane_id: "w1:p7" } });
      return ok({});
    });
    const placed = await placeWorker(
      { run: f.run, env, queueTimeoutMs: 60_000, sleep: async () => {} },
      { cwd: "/w/AGENT-1", role: "review gate", access: "read" },
    );
    expect(placed).toMatchObject({ ok: true, label: "W2 review · AGENT-1" });
    expect(f.calls).toContainEqual([
      "herdr",
      "pane",
      "split",
      "w1:p4",
      "--direction",
      "down",
      "--cwd",
      "/w/AGENT-1",
      "--no-focus",
    ]);
  });
  it("falls back (legacy) without Herdr context or ticket", async () => {
    const f = fakeRun(() => ok({}));
    expect(
      await placeWorker({ run: f.run, env: {} }, { cwd: "/w/AGENT-1", role: "x", access: "read" }),
    ).toMatchObject({ ok: false, legacy: true });
    expect(
      await placeWorker({ run: f.run, env }, { cwd: "/w/none", role: "x", access: "read" }),
    ).toMatchObject({ ok: false, legacy: true });
  });
});

describe("placeMain", () => {
  it("creates the project workspace, reuses its first tab as the ticket tab and labels MAIN", async () => {
    const f = fakeRun((argv) => {
      if (argv[0] === "git") return okText("/Users/x/projects/waverider-app/.git\n");
      if (argv[1] === "workspace" && argv[2] === "list")
        return ok({ workspaces: [{ workspace_id: "w2", label: "other" }] });
      if (argv[1] === "workspace" && argv[2] === "create")
        return ok({
          workspace: { workspace_id: "w9" },
          tab: { tab_id: "w9:t1" },
          root_pane: { pane_id: "w9:p1" },
        });
      return ok({});
    });
    const placed = await placeMain(
      { run: f.run, env: { HMR_TICKET: "AGENT-88", HMR_TICKET_SLUG: "Login fix" } },
      {
        cwd: "/Users/x/herdr-worktrees/waverider-app/AGENT-88",
        projectExists: (n) => n === "waverider-app",
      },
    );
    expect(placed).toEqual({
      ok: true,
      paneId: "w9:p1",
      label: "MAIN · AGENT-88",
      agentName: "main-agent-88",
      ticket: "AGENT-88",
    });
    expect(f.calls).toContainEqual([
      "herdr",
      "workspace",
      "create",
      "--cwd",
      "/Users/x/herdr-worktrees/waverider-app/AGENT-88",
      "--label",
      "waverider-app",
      "--no-focus",
    ]);
    expect(f.calls).toContainEqual(["herdr", "tab", "rename", "w9:t1", "AGENT-88 · login-fix"]);
  });
  it("puts a ticket without a project folder into agent-dev and adds a tab to an existing workspace", async () => {
    const f = fakeRun((argv) => {
      if (argv[0] === "git") return okText("/tmp/scratch/.git\n");
      if (argv[1] === "workspace")
        return ok({ workspaces: [{ workspace_id: "w3", label: "agent-dev" }] });
      if (argv[1] === "tab" && argv[2] === "list")
        return ok({ tabs: [{ tab_id: "w3:t1", label: "AGENT-2 · other" }] });
      if (argv[1] === "tab" && argv[2] === "create") return ok({ root_pane: { pane_id: "w3:p8" } });
      return ok({});
    });
    const placed = await placeMain(
      { run: f.run, env: { HMR_TICKET: "AGENT-5" } },
      { cwd: "/tmp/scratch", projectExists: () => false },
    );
    expect(placed).toMatchObject({ ok: true, paneId: "w3:p8" });
    expect(f.calls.find((c) => c[1] === "tab" && c[2] === "create")).toContain("w3");
  });
  it("refuses a second MAIN agent for the same ticket", async () => {
    const f = fakeRun((argv) => {
      if (argv[0] === "git") return okText("/Users/x/projects/r/.git\n");
      if (argv[1] === "workspace") return ok({ workspaces: [{ workspace_id: "w4", label: "r" }] });
      if (argv[1] === "tab") return ok({ tabs: [{ tab_id: "w4:t3", label: "AGENT-9 · x" }] });
      if (argv[1] === "pane")
        return ok({
          panes: [
            pane("w4:p1", "MAIN · AGENT-9", "w4:t3", { agent: "codex", agent_status: "working" }),
          ],
        });
      return ok({});
    });
    const placed = await placeMain(
      { run: f.run, env: { HMR_TICKET: "AGENT-9" } },
      { cwd: "/Users/x/projects/r", projectExists: () => true },
    );
    expect(placed.ok ? "" : placed.error).toMatch(/already has a MAIN agent/);
  });
});

describe("closeFinished", () => {
  it("closes idle/done workers and agentless panes, never MAIN or a working agent", async () => {
    const status: Record<string, Record<string, unknown>> = {
      "w1:p2": { agent: "codex", agent_status: "done" },
      "w1:p3": { agent: "claude", agent_status: "working" },
      "w1:p4": { agent_status: "unknown" },
    };
    const f = fakeRun((argv) => (argv[2] === "get" ? ok({ pane: status[argv[3]!] }) : ok({})));
    const closed = await closeFinished({ run: f.run, env }, ["w1:p1", "w1:p2", "w1:p3", "w1:p4"]);
    expect(closed).toEqual(["w1:p2", "w1:p4"]);
  });
});

describe("review guard", () => {
  const sha = "a".repeat(40);
  it("takes a round for HMR_PR and refuses when review-rounds refuses", async () => {
    const f = fakeRun((argv) => {
      if (argv[0] === "git") return okText(`${sha}\n`);
      if (argv[1] === "take")
        return argv.includes("9") ? bad("REFUSED: cap 3") : okText("round=1 cap=3");
      return bad();
    });
    const guard = createReviewGuard(f.run, { HMR_PR: "waveriderai/Repo#7", HOME: "/h" });
    expect(await guard({ role: "review gate", cwd: "/w" })).toEqual({
      ok: true,
      note: "round=1 cap=3",
    });
    expect(f.calls).toContainEqual([
      "/h/.local/bin/review-rounds",
      "take",
      "--repo",
      "Repo",
      "--pr",
      "7",
      "--sha",
      sha,
      "--role",
      "review gate",
    ]);
    const refused = await createReviewGuard(f.run, { HMR_PR: "Repo#9", HOME: "/h" })({
      role: "review gate",
      cwd: "/w",
    });
    expect(refused.ok).toBe(false);
  });
  it("fails closed without a PR (detached review worktree)", async () => {
    const f = fakeRun((argv) =>
      argv[0] === "git" && argv[3] === "rev-parse" && argv[4] === "HEAD"
        ? okText(`${sha}\n`)
        : argv[0] === "git" && argv[4] === "--abbrev-ref"
          ? okText("HEAD\n")
          : okText("https://github.com/waveriderai/Repo.git\n"),
    );
    const res = await createReviewGuard(f.run, { HOME: "/h" })({ role: "review gate", cwd: "/w" });
    expect(res.ok ? "" : res.error).toMatch(/HMR_PR/);
  });
});
