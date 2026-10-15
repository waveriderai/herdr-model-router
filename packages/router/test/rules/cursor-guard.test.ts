import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CURSOR_DECLINE_REASON,
  CURSOR_GUARD_KEYS,
  cursorGuardLogger,
  detectCursorOutOfWorkspacePrompt,
  runCursorGuard,
} from "../../src/rules/cursor-guard.js";

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "hmr-guard-")));
const wt = path.join(root, "parent", "wt");
mkdirSync(wt, { recursive: true });

function prompt(target: string): string {
  return [
    "    Editing x.txt",
    " ...x.txt",
    "  probe",
    "",
    " Write to this file?",
    ` in ${target}`,
    "  → Proceed (y)",
    "    Reject & propose changes (esc or n or p)",
    "    Add Write(/Users/.../x.txt) to allowlist? (tab)",
    "    Run Everything (shift+tab)",
  ].join("\n");
}
const REASON =
  "  → Tell the agent what to do instead (Enter to send, empty to skip, Esc to cancel)";

describe("Cursor out-of-workspace guard (AGENT-285, Kai 10:39 PM PT)", () => {
  it("matches the Write prompt for a new file in a parent folder", () => {
    const target = path.join(root, "parent", "new.txt");
    expect(detectCursorOutOfWorkspacePrompt(prompt(target), wt)).toBe(target);
  });

  it("never matches a path inside the worktree, other prompts, or partial screens", () => {
    expect(
      detectCursorOutOfWorkspacePrompt(prompt(path.join(wt, "a", "b.txt")), wt),
    ).toBeUndefined();
    const shell = prompt("/tmp/x").replace(
      "Write to this file?",
      "Run this command outside the sandbox?",
    );
    expect(detectCursorOutOfWorkspacePrompt(shell, wt)).toBeUndefined();
    const noReject = prompt("/tmp/x").replace(
      "Reject & propose changes (esc or n or p)",
      "Skip (esc or n)",
    );
    expect(detectCursorOutOfWorkspacePrompt(noReject, wt)).toBeUndefined();
    expect(detectCursorOutOfWorkspacePrompt("Write to this file?\nin /tmp/x", wt)).toBeUndefined();
    expect(detectCursorOutOfWorkspacePrompt(undefined, wt)).toBeUndefined();
    // A sibling whose name only starts with the worktree's name is outside it.
    const sibling = `${wt}-evil/x.txt`;
    expect(detectCursorOutOfWorkspacePrompt(prompt(sibling), wt)).toBe(sibling);
  });

  it("declines Write prompts for the worktree's live .cursor settings in any letter case", () => {
    for (const dir of [".cursor", ".CURSOR", ".Cursor"]) {
      const target = path.join(wt, dir, "sandbox.json");
      expect(detectCursorOutOfWorkspacePrompt(prompt(target), wt)).toBe(target);
    }
    expect(
      detectCursorOutOfWorkspacePrompt(prompt(path.join(wt, "src", "cursor.ts")), wt),
    ).toBeUndefined();
  });

  function fakePane(screens: string[]) {
    const keys: string[][] = [];
    const texts: string[] = [];
    let i = 0;
    const pane = {
      getAgent: async () => ({ paneId: "w1:p1", agent: "cursor", status: "blocked" }) as never,
      paneState: async () => "present" as const,
      readPane: async () => screens[Math.min(i++, screens.length - 1)],
      sendKeys: async (_: string, k: readonly string[]) => {
        keys.push([...k]);
        return { ok: true, stdout: "", stderr: "", code: 0 } as never;
      },
      sendText: async (_: string, t: string) => {
        texts.push(t);
        return { ok: true, stdout: "", stderr: "", code: 0 } as never;
      },
    };
    return { pane, keys, texts };
  }

  it("declines with esc plus a reason and never sends an approve key", async () => {
    const target = path.join(root, "parent", "new.txt");
    const { pane, keys, texts } = fakePane([
      prompt(target),
      REASON,
      "idle",
      prompt(target),
      REASON,
      "idle",
    ]);
    const logs: Record<string, unknown>[] = [];
    const declines = await runCursorGuard(
      { pane, sleep: async () => {}, log: (e) => logs.push(e) },
      { paneId: "w1:p1", worktree: wt, laneId: "lane1", maxPolls: 4 },
    );
    expect(declines).toBe(2);
    const sent = keys.flat();
    expect(sent.every((k) => CURSOR_GUARD_KEYS.includes(k))).toBe(true);
    for (const approve of ["y", "Y", "tab", "shift+tab", "a", "1", "2"]) {
      expect(sent).not.toContain(approve);
    }
    for (const t of texts) expect(t).toBe(CURSOR_DECLINE_REASON);
    expect(sent[0]).toBe("esc");
    expect(logs[0]).toMatchObject({
      event: "cursor-out-of-workspace-declined",
      target,
      key: "esc",
    });
  });

  it("sends nothing for a prompt inside the worktree or an ordinary screen", async () => {
    const { pane, keys, texts } = fakePane([prompt(path.join(wt, "x")), "idle"]);
    await runCursorGuard(
      { pane, sleep: async () => {}, log: () => {} },
      { paneId: "w1:p1", worktree: wt, laneId: "l", maxPolls: 3 },
    );
    expect(keys).toEqual([]);
    expect(texts).toEqual([]);
  });

  it("reports ready once, only after it has seen the pane running Cursor", async () => {
    const { pane } = fakePane(["idle"]);
    let ready = 0;
    await runCursorGuard(
      { pane, sleep: async () => {}, log: () => {} },
      { paneId: "w1:p1", worktree: wt, laneId: "l", maxPolls: 3, onReady: () => ready++ },
    );
    expect(ready).toBe(1);
    pane.getAgent = async () => undefined as never;
    let notReady = 0;
    await runCursorGuard(
      { pane, sleep: async () => {}, log: () => {} },
      { paneId: "w1:p1", worktree: wt, laneId: "l", maxPolls: 3, onReady: () => notReady++ },
    );
    expect(notReady).toBe(0);
  });

  it("stops when the pane no longer runs Cursor", async () => {
    const { pane, keys } = fakePane([prompt("/etc/x")]);
    pane.getAgent = async () => ({ paneId: "w1:p1", agent: "claude", status: "idle" }) as never;
    await runCursorGuard(
      { pane, sleep: async () => {}, log: () => {} },
      { paneId: "w1:p1", worktree: wt, laneId: "l", maxPolls: 3 },
    );
    expect(keys).toEqual([]);
  });

  it("logs each decline as a 0600 JSON line in the router home", () => {
    const home = path.join(root, "home");
    const log = cursorGuardLogger(home);
    log({ event: "a" });
    log({ event: "b" });
    const file = path.join(home, "cursor-guard.log");
    expect(
      readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l).event),
    ).toEqual(["a", "b"]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
