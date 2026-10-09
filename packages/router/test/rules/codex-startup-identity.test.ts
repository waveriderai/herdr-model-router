import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dispatchPlan } from "../../src/rules/dispatch.js";
import { codexStatusSession } from "../../src/rules/codex-identity.js";
import { parseRules } from "../../src/rules/mdc-parser.js";
import { planRoute, type RoutePlan } from "../../src/rules/plan.js";
import { compareIdentity } from "../../src/workflow/identity.js";
import { deps, fakeHerdr, ok, screen, type FakePane } from "../helpers/fake-herdr.js";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/rules/pstack-models.mdc",
);
const parsed = parseRules(readFileSync(FIXTURE, "utf8"));
if (!parsed.ok) throw new Error(parsed.error);

function plan(role: string): RoutePlan {
  const result = planRoute({
    rules: parsed.ok ? parsed.rules : [],
    rulesSource: { path: FIXTURE, origin: "flag" },
    role,
    cwd: "/work/project",
  });
  if (!result.ok) throw new Error(result.error);
  return result;
}

/** The UUID the synthetic `/status` card shows on its Session line. */
const STATUS_UUID = "019a0f3e-5b7c-7d21-9c4e-2f6a8b1d3e57";
const UNRELATED_UUID = "7c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5";
const CARD = screen("codex-status");

/** A fresh Codex that is ready but has not reported a session to Herdr yet. */
const fresh =
  (patch: Partial<FakePane> = {}) =>
  (_pane: string, executable: string): Partial<FakePane> =>
    executable === "codex" ? { session: undefined, statusCard: CARD, ...patch } : {};

async function writer(herdr: ReturnType<typeof fakeHerdr>, role = "feature") {
  const { deps: d, db } = deps(herdr);
  const result = await dispatchPlan({
    plan: plan(role),
    prompt: "Implement the feature",
    worktreeId: "/work/project",
    deps: d,
  });
  if (!result.ok) throw new Error(result.error);
  return { result, lane: result.lanes[0]!, store: d.store, db };
}

const probeCalls = (herdr: ReturnType<typeof fakeHerdr>) =>
  herdr.calls.filter((call) =>
    ["send-text", "send-keys", "report-agent-session"].includes(call[1]!),
  );

describe("native Codex startup identity (U8)", () => {
  it("binds the UUID the pane's own /status shows, then sends the writer task exactly once", async () => {
    const herdr = fakeHerdr({ detect: fresh() as never });
    const { lane, store } = await writer(herdr);
    expect(lane.state).toBe("prompted");
    const paneId = lane.paneId!;
    expect(probeCalls(herdr)).toEqual([
      ["pane", "send-text", paneId, "/status"],
      ["pane", "send-keys", paneId, "enter"],
      ["pane", "report-agent-session", paneId, "herdr:codex", "codex", STATUS_UUID],
    ]);
    // The report precedes the one original prompt, which carries the task, never /status.
    const reportAt = herdr.calls.findIndex((call) => call[1] === "report-agent-session");
    const promptAt = herdr.calls.findIndex((call) => call[1] === "prompt");
    expect(reportAt).toBeGreaterThan(-1);
    expect(promptAt).toBeGreaterThan(reportAt);
    expect(herdr.prompts).toHaveLength(1);
    expect(herdr.prompts[0]!.text).toContain("Implement the feature");
    // /status is a local command: nothing was submitted to the model before the task.
    const pane = herdr.panes.get(paneId)!;
    expect(pane.submitted).toBeUndefined();
    expect(pane.sessionSource).toBe("herdr:codex");
    expect(store.getLane(lane.laneId)!.sessionId).toBe(STATUS_UUID);
    // The provider hook later reports the same id: the bound identity still holds.
    pane.sessionSource = "codex";
    const live = await herdr.pane.getAgent(paneId);
    const bound = {
      agentName: lane.agentName!,
      kind: "codex",
      paneId,
      sessionId: STATUS_UUID,
      cwd: "/work/project",
    };
    expect(compareIdentity(live, bound)).toMatchObject({ ok: true });
    pane.session = UNRELATED_UUID;
    expect(compareIdentity(await herdr.pane.getAgent(paneId), bound)).toMatchObject({
      ok: false,
      code: "session-changed",
    });
  });

  it("takes only the Session line, never another UUID on the screen", async () => {
    const card = CARD.replace(
      "│  Agents.md:",
      `│  Resume hint:          codex resume ${UNRELATED_UUID}       │\n│  Agents.md:`,
    );
    const herdr = fakeHerdr({
      detect: fresh({ statusCard: card, history: `last run ${UNRELATED_UUID}\n` }) as never,
    });
    const { lane } = await writer(herdr);
    expect(lane.state).toBe("prompted");
    expect(herdr.calls.find((call) => call[1] === "report-agent-session")?.[5]).toBe(STATUS_UUID);
  });

  it.each([
    ["no status output", undefined, /no Session line/],
    [
      "a card whose only UUID is unrelated",
      CARD.replace(/^│ {2}Session:.*\n/m, `│  Resume:  codex resume ${UNRELATED_UUID}  │\n`),
      /no Session line/,
    ],
    [
      "two different Session ids",
      CARD.replace(
        /^(│ {2}Session:.*\n)/m,
        `$1│  Session:              ${UNRELATED_UUID}              │\n`,
      ),
      /more than one Session id/,
    ],
    [
      "a malformed Session value",
      // A UUID prefix may still be painting: it is waited for, never completed or accepted.
      CARD.replace(STATUS_UUID, "019a0f3e-5b7c-7d21-9c4e"),
      /incomplete/,
    ],
  ])("fails closed on %s: no report, no task, pane closed", async (_label, card, error) => {
    const herdr = fakeHerdr({ detect: fresh({ statusCard: card }) as never });
    const { lane, result } = await writer(herdr);
    expect(lane.state).toBe("failed");
    expect(lane.error).toMatch(error);
    expect(lane.error).toContain("no prompt was sent");
    // Account and usage lines are never repeated.
    expect(lane.error).not.toMatch(/SYNTHETIC_ACCOUNT_DETAILS|limit|used/);
    expect(herdr.calls.some((call) => call[1] === "report-agent-session")).toBe(false);
    expect(herdr.prompts).toEqual([]);
    expect(herdr.calls).toContainEqual(["pane", "close", "w1:p1"]);
    expect(result.task.status).toBe("failed");
  });

  it("fails closed when Herdr does not read back the reported session", async () => {
    const herdr = fakeHerdr({
      detect: fresh() as never,
      // Herdr accepts the report, but another id is what it then reports for the pane.
      report: (paneId) => {
        herdr.panes.get(paneId)!.session = UNRELATED_UUID;
        return ok();
      },
    });
    const { lane } = await writer(herdr);
    expect(lane.state).toBe("failed");
    expect(lane.error).toMatch(/read back/);
    expect(herdr.prompts).toEqual([]);
    expect(herdr.calls).toContainEqual(["pane", "close", "w1:p1"]);
  });

  it.each([
    ["blocked after naming", { onRename: "blocked" }, /blocked/],
    ["in another directory", { cwd: "/elsewhere" }, /\/elsewhere/],
  ] as const)("does not probe a pane whose identity is %s", async (_label, change, error) => {
    const herdr = fakeHerdr({
      detect: fresh("cwd" in change ? { cwd: change.cwd } : {}) as never,
      onRename: (paneId) => {
        if ("onRename" in change) herdr.panes.get(paneId)!.status = change.onRename;
      },
    });
    const { lane } = await writer(herdr);
    expect(lane.state).toBe("failed");
    expect(lane.error).toMatch(error);
    expect(probeCalls(herdr)).toEqual([]);
    expect(herdr.prompts).toEqual([]);
  });

  it("does not press Enter unless the input box holds exactly /status", async () => {
    const herdr = fakeHerdr({ detect: fresh({ input: "draft " }) as never });
    const { lane } = await writer(herdr);
    expect(lane.state).toBe("failed");
    // Other text fails at once; it is not waited out.
    expect(lane.error).toMatch(/did not hold exactly \/status/);
    expect(herdr.calls.some((call) => call[1] === "send-keys")).toBe(false);
    expect(herdr.panes.get("w1:p1")!.submitted).toBeUndefined();
    expect(herdr.prompts).toEqual([]);
  });

  it("reads the /status echo Codex draws on a true-color background", async () => {
    const herdr = fakeHerdr({
      detect: fresh({ inputStyle: (text) => `\u001b[48;2;65;69;76m${text}\u001b[0m` }) as never,
    });
    const { lane } = await writer(herdr);
    expect(lane.state).toBe("prompted");
    expect(herdr.calls).toContainEqual(["pane", "send-keys", "w1:p1", "enter"]);
    expect(herdr.prompts).toHaveLength(1);
  });

  it.each([
    [
      "drawn dim like a placeholder",
      (text: string) => `\u001b[2;48;2;65;69;76m${text}\u001b[0m`,
      // A dim echo reads as the empty box: waited for, never accepted.
      /did not show \/status within \d+ms/,
    ],
    [
      "with other text after it",
      (text: string) => `\u001b[48;2;65;69;76m${text} now\u001b[0m`,
      /did not hold exactly \/status/,
    ],
  ])("does not press Enter for an echo %s", async (_label, inputStyle, error) => {
    const herdr = fakeHerdr({ detect: fresh({ inputStyle }) as never });
    const { lane } = await writer(herdr);
    expect(lane.state).toBe("failed");
    expect(lane.error).toMatch(error);
    expect(herdr.calls.some((call) => call[1] === "send-keys")).toBe(false);
    expect(herdr.prompts).toEqual([]);
  });

  it("waits for Codex to repaint the typed /status, then presses Enter once", async () => {
    // The first read after typing still shows the empty box; the next shows `/status`.
    const herdr = fakeHerdr({ detect: fresh({ echoLag: 1 }) as never });
    const { lane } = await writer(herdr);
    expect(lane.error).toBeUndefined();
    expect(lane.state).toBe("prompted");
    const paneId = lane.paneId!;
    expect(probeCalls(herdr)).toEqual([
      ["pane", "send-text", paneId, "/status"],
      ["pane", "send-keys", paneId, "enter"],
      ["pane", "report-agent-session", paneId, "herdr:codex", "codex", STATUS_UUID],
    ]);
    expect(herdr.prompts).toHaveLength(1);
    expect(herdr.panes.get(paneId)!.submitted).toBeUndefined();
  });

  it("fails without Enter when /status never appears within the bound", async () => {
    const herdr = fakeHerdr({ detect: fresh({ echoLag: 1_000 }) as never });
    const { lane } = await writer(herdr);
    expect(lane.state).toBe("failed");
    expect(lane.error).toMatch(/did not show \/status within \d+ms/);
    expect(herdr.calls.filter((call) => call[1] === "send-text")).toHaveLength(1);
    expect(herdr.calls.some((call) => call[1] === "send-keys")).toBe(false);
    expect(herdr.calls).toContainEqual(["pane", "close", "w1:p1"]);
    expect(herdr.prompts).toEqual([]);
  });

  it("fails without Enter when the identity changes while waiting for the echo", async () => {
    const herdr = fakeHerdr({
      detect: fresh({ echoLag: 1 }) as never,
      onGetAgent: (target) => {
        const pane = herdr.panes.get(target);
        // Once /status is typed, the agent starts working: not the idle Codex it was.
        if (pane?.input === "/status") pane.status = "working";
      },
    });
    const { lane } = await writer(herdr);
    expect(lane.state).toBe("failed");
    expect(lane.error).toMatch(/identity changed before Enter .*working/);
    expect(herdr.calls.some((call) => call[1] === "send-keys")).toBe(false);
    expect(herdr.prompts).toEqual([]);
  });

  it("does not press Enter when the screen shows no Codex input line", async () => {
    const herdr = fakeHerdr({
      detect: fresh() as never,
      // After readiness, the layout changes to one with no `›` input line.
      onRename: (paneId) => {
        herdr.panes.get(paneId)!.screen = "Working…\n";
      },
    });
    const { lane } = await writer(herdr);
    expect(lane.state).toBe("failed");
    expect(lane.error).toMatch(/input box/);
    expect(herdr.calls.some((call) => call[1] === "send-keys")).toBe(false);
    expect(herdr.prompts).toEqual([]);
  });

  it("skips the probe when Herdr already reports the session", async () => {
    const herdr = fakeHerdr();
    const { lane } = await writer(herdr);
    expect(lane.state).toBe("prompted");
    expect(probeCalls(herdr)).toEqual([]);
    expect(herdr.prompts).toHaveLength(1);
  });

  it("leaves other providers unchanged: a Claude writer without a session is refused as before", async () => {
    const herdr = fakeHerdr({ detect: () => ({ session: undefined }) as never });
    const { lane } = await writer(herdr, "bug-fix");
    expect(lane.state).toBe("failed");
    expect(lane.error).toMatch(/reports no session id for the claude agent/);
    expect(probeCalls(herdr)).toEqual([]);
    expect(herdr.prompts).toEqual([]);
  });
});

describe("native wrapped Session field (U8)", () => {
  const WRAPPED = screen("codex-status-wrapped");
  const [head, tail] = WRAPPED.split("  Session:\n");
  const rows = tail!.split("\n");
  /** The wrapped card with its Session field cut after `rowsShown` continuation rows. */
  const paintedTo = (rowsShown: number) =>
    `${head}  Session:\n${rows.slice(0, rowsShown).join("\n")}\n`;

  it("binds a UUID Codex wraps under a bare Session label", async () => {
    const herdr = fakeHerdr({ detect: fresh({ statusCard: WRAPPED }) as never });
    const { lane } = await writer(herdr);
    expect(lane.error).toBeUndefined();
    expect(lane.state).toBe("prompted");
    expect(probeCalls(herdr).map((call) => call[1])).toEqual([
      "send-text",
      "send-keys",
      "report-agent-session",
    ]);
    expect(herdr.calls.find((call) => call[1] === "report-agent-session")?.[5]).toBe(STATUS_UUID);
    expect(herdr.prompts).toHaveLength(1);
  });

  it("waits while Codex paints the field: label, first fragment, then the rest", async () => {
    const herdr = fakeHerdr({
      detect: fresh({ statusFrames: [paintedTo(0), paintedTo(1), WRAPPED] }) as never,
      onGetAgent: () => {
        // Nothing is reported or prompted before the full id is on screen.
        const pane = herdr.panes.get("w1:p1");
        if (pane?.statusFrame !== undefined && pane.statusFrame < 3) {
          expect(herdr.calls.some((call) => call[1] === "report-agent-session")).toBe(false);
          expect(herdr.prompts).toEqual([]);
        }
      },
    });
    const { lane } = await writer(herdr);
    expect(lane.error).toBeUndefined();
    expect(probeCalls(herdr)).toEqual([
      ["pane", "send-text", "w1:p1", "/status"],
      ["pane", "send-keys", "w1:p1", "enter"],
      ["pane", "report-agent-session", "w1:p1", "herdr:codex", "codex", STATUS_UUID],
    ]);
    expect(herdr.prompts).toHaveLength(1);
  });

  it.each([
    ["an id that stays incomplete", paintedTo(1), /incomplete/],
    [
      "trailing text after the id",
      WRAPPED.replace("  e57\n", "  e57 resumed\n"),
      /not a session UUID/,
    ],
    [
      "a continuation longer than one UUID",
      WRAPPED.replace("  e57\n", "  e57\n                       0a1b\n"),
      /not a session UUID/,
    ],
    [
      "a fragment with characters a UUID cannot hold",
      WRAPPED.replace("  e57\n", "  e5Z\n"),
      /not a session UUID/,
    ],
    [
      "two Session fields with different ids",
      `${WRAPPED}  Session:\n                       ${UNRELATED_UUID}\n`,
      /more than one Session id/,
    ],
    [
      "a UUID that is not under the Session label",
      WRAPPED.replace(/ {2}Session:\n[\s\S]*?e57\n/, `  Session:\n\n  Resume: ${UNRELATED_UUID}\n`),
      /incomplete/,
    ],
  ])("fails closed on %s: no report, no task", async (_label, card, error) => {
    const herdr = fakeHerdr({ detect: fresh({ statusCard: card }) as never });
    const { lane } = await writer(herdr);
    expect(lane.state).toBe("failed");
    expect(lane.error).toMatch(error);
    expect(lane.error).not.toMatch(/SYNTHETIC_ACCOUNT_DETAILS|limit|used/);
    expect(herdr.calls.filter((call) => call[1] === "send-text")).toHaveLength(1);
    expect(herdr.calls.filter((call) => call[1] === "send-keys")).toHaveLength(1);
    expect(herdr.calls.some((call) => call[1] === "report-agent-session")).toBe(false);
    expect(herdr.prompts).toEqual([]);
    expect(herdr.calls).toContainEqual(["pane", "close", "w1:p1"]);
  });
});

describe("codexStatusSession", () => {
  it("joins only the Session field's own indented UUID fragments", () => {
    const WRAPPED = screen("codex-status-wrapped");
    expect(codexStatusSession(WRAPPED)).toEqual({ state: "found", sessionId: STATUS_UUID });
    expect(codexStatusSession("  Session:\n")).toEqual({ state: "partial" });
    expect(codexStatusSession("  Session:\n      019a0f3e-5b7c\n")).toEqual({ state: "partial" });
    // A fragment must sit on an indented row; a row at the margin is not part of the field.
    expect(codexStatusSession(`  Session:\n${STATUS_UUID}\n`)).toEqual({ state: "partial" });
    expect(codexStatusSession(`  Session:\n      019a0f3e_5b7c\n`)).toEqual({ state: "malformed" });
    // Hyphens only where a UUID has them.
    expect(codexStatusSession(`  Session:\n      019a0f3e5-b7c\n`)).toEqual({ state: "malformed" });
  });

  it("reads the one Session UUID and nothing else", () => {
    expect(codexStatusSession(CARD)).toEqual({ state: "found", sessionId: STATUS_UUID });
    expect(codexStatusSession(`${CARD}\n${CARD}`)).toEqual({
      state: "found",
      sessionId: STATUS_UUID,
    });
    expect(codexStatusSession(`run ${UNRELATED_UUID}\n`)).toEqual({ state: "none" });
    expect(codexStatusSession(`Session: ${STATUS_UUID.toUpperCase()}\n`)).toEqual({
      state: "malformed",
    });
    expect(codexStatusSession(`Session: ${STATUS_UUID}\n`)).toEqual({
      state: "found",
      sessionId: STATUS_UUID,
    });
    expect(codexStatusSession(`Session: ${STATUS_UUID} extra\n`)).toEqual({
      state: "malformed",
    });
  });
});
