import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { HerdrPaneClient } from "../launch/herdr-client.js";

/**
 * Cursor writer pane guard (AGENT-285, Kai 2026-10-14 10:39 PM PT: "Auto-decline Cursor's
 * out-of-workspace prompt"). Cursor asks "Write to this file? / in <path>" when its own Write
 * tool targets a path outside the workspace that no deny rule covers (a NEW entry directly in
 * one of the worktree's ancestors). The guard answers that one prompt with Cursor's reject key
 * and a short reason, and nothing else. It never sends an approve, allowlist or run-mode key.
 */

/** The only keys the guard ever sends. `esc` is Cursor's "Reject & propose changes"; `enter`
 * submits the reason field that opens after it. Never `y`, `tab` or `shift+tab`. */
export const CURSOR_DECLINE_KEY = "esc";
export const CURSOR_SUBMIT_KEY = "enter";
export const CURSOR_GUARD_KEYS: readonly string[] = [CURSOR_DECLINE_KEY, CURSOR_SUBMIT_KEY];

export const CURSOR_DECLINE_REASON =
  "Declined by hmr: writes outside the worktree are blocked. Stay inside the worktree.";

const QUESTION = /^\s*Write to this file\?\s*$/;
const TARGET = /^\s*in (\/.+?)\s*$/;
const REJECT_OPTION = /^\s*(?:→\s*)?Reject & propose changes \(esc or n or p\)\s*$/;
const PROCEED_OPTION = /^\s*(?:→\s*)?Proceed \(y\)\s*$/;
const REASON_FIELD = /Tell the agent what to do instead \(Enter to send/;

function canonical(target: string): string {
  // The file is new, so resolve its nearest existing ancestor.
  let dir = path.resolve(target);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(dir), ...rest);
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return path.resolve(target);
      rest.unshift(path.basename(dir));
      dir = parent;
    }
  }
}

function inside(file: string, root: string): boolean {
  return file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * The out-of-worktree path of a Cursor "Write to this file?" prompt on screen, or undefined.
 * Matches only the exact Write prompt shape: the question line, the `in <absolute path>` line
 * right after it, and both the Proceed and Reject options. Inside the worktree only a path
 * under its `.cursor` (any letter case) is matched; any other prompt is left for a human.
 */
export function detectCursorOutOfWorkspacePrompt(
  screen: string | undefined,
  worktree: string,
): string | undefined {
  if (!screen) return undefined;
  const lines = screen.split("\n");
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!QUESTION.test(lines[i]!)) continue;
    const target = TARGET.exec(lines[i + 1]!)?.[1];
    if (!target) continue;
    const after = lines.slice(i + 2, i + 8);
    if (!after.some((line) => PROCEED_OPTION.test(line))) continue;
    if (!after.some((line) => REJECT_OPTION.test(line))) continue;
    const root = canonical(worktree);
    const file = canonical(target);
    if (!inside(file, root)) return target;
    // Inside the worktree only Cursor's live settings (`.cursor`, any letter case) are
    // declined; Cursor shows them as a "Protected config file" Write prompt (review round 8).
    const segments = path.relative(root, file).split(path.sep);
    if (segments.some((segment) => segment.toLowerCase() === ".cursor")) return target;
    return undefined;
  }
  return undefined;
}

export function detectCursorReasonField(screen: string | undefined): boolean {
  return !!screen && REASON_FIELD.test(screen);
}

export interface CursorGuardDeps {
  pane: Pick<HerdrPaneClient, "getAgent" | "readPane" | "sendKeys" | "sendText" | "paneState">;
  sleep: (ms: number) => Promise<void>;
  log: (entry: Record<string, unknown>) => void;
  now?: () => Date;
}

export interface CursorGuardInput {
  paneId: string;
  worktree: string;
  laneId: string;
  pollMs?: number;
  /** Stop after this many polls (tests); unlimited by default. */
  maxPolls?: number;
  /** Called once, after the first poll that saw Cursor in the pane and read its screen. */
  onReady?: () => void;
  /** Consecutive polls without sight of the pane before the guard gives up (default 8). */
  maxBlindPolls?: number;
  /** Consecutive undelivered declines before the guard gives up (default 3). */
  maxFailedDeclines?: number;
}

async function screenOf(deps: CursorGuardDeps, paneId: string): Promise<string | undefined> {
  try {
    return await deps.pane.readPane(paneId, { source: "visible", lines: 60 });
  } catch {
    return undefined;
  }
}

export type CursorGuardOutcome =
  /** The pane closed or stopped running Cursor: the guard's job is over. */
  | "ended"
  /** The guard could not see the pane (agent or screen) for `maxBlindPolls` polls in a row. */
  | "blind"
  /** Declining failed (key not delivered or not taken) `maxFailedDeclines` times in a row. */
  | "stuck";

/**
 * Watches one Cursor writer pane until it is gone or no longer runs Cursor, declining every
 * out-of-worktree Write prompt it sees. Ready means it has seen Cursor in the pane AND read the
 * pane's screen. Losing sight of the pane for `maxBlindPolls` polls returns "blind"; the caller
 * then stops the writer (review round 11).
 */
export async function runCursorGuard(
  deps: CursorGuardDeps,
  input: CursorGuardInput,
): Promise<{ declines: number; outcome: CursorGuardOutcome }> {
  const pollMs = input.pollMs ?? 1500;
  const maxBlind = input.maxBlindPolls ?? 8;
  const now = deps.now ?? (() => new Date());
  let declines = 0;
  let blind = 0;
  let failedDeclines = 0;
  const maxFailed = input.maxFailedDeclines ?? 3;
  let ready = false;
  const log = (entry: Record<string, unknown>) => {
    try {
      deps.log(entry);
    } catch {
      /* a lost log line never stops the guard */
    }
  };
  for (let polls = 0; input.maxPolls === undefined || polls < input.maxPolls; polls++) {
    let state: "present" | "absent" | "unknown";
    try {
      state = deps.pane.paneState ? await deps.pane.paneState(input.paneId) : "unknown";
    } catch {
      state = "unknown";
    }
    if (state === "absent") return { declines, outcome: "ended" };
    const info = await deps.pane.getAgent(input.paneId).catch(() => undefined);
    if (info && info.agent !== "cursor") return { declines, outcome: "ended" };
    const screen = info ? await screenOf(deps, input.paneId) : undefined;
    if (!info || screen === undefined) {
      blind++;
      if (blind >= maxBlind) return { declines, outcome: "blind" };
      await deps.sleep(pollMs);
      continue;
    }
    blind = 0;
    if (!ready) {
      ready = true;
      input.onReady?.();
    }
    const target = detectCursorOutOfWorkspacePrompt(screen, input.worktree);
    if (target) {
      const sent = await deps.pane.sendKeys(input.paneId, [CURSOR_DECLINE_KEY]);
      let reason = false;
      if (sent.ok) {
        for (let wait = 0; wait < 10; wait++) {
          await deps.sleep(300);
          if (detectCursorReasonField(await screenOf(deps, input.paneId))) {
            const typed = await deps.pane.sendText(input.paneId, CURSOR_DECLINE_REASON);
            if (typed.ok) await deps.pane.sendKeys(input.paneId, [CURSOR_SUBMIT_KEY]);
            reason = typed.ok;
            break;
          }
        }
      }
      // A decline counts only when Cursor took it: the key went out and the reason field
      // opened. Anything else is a failed attempt (review round 13).
      if (sent.ok && reason) {
        declines++;
        failedDeclines = 0;
      } else {
        failedDeclines++;
      }
      log({
        at: now().toISOString(),
        event: "cursor-out-of-workspace-declined",
        pane: input.paneId,
        lane: input.laneId,
        worktree: input.worktree,
        target,
        key: CURSOR_DECLINE_KEY,
        keySent: sent.ok,
        reasonSent: reason,
      });
      if (failedDeclines >= maxFailed) return { declines, outcome: "stuck" };
    }
    await deps.sleep(pollMs);
  }
  return { declines, outcome: "ended" };
}

/** Appends one JSON line per decline to `<router home>/cursor-guard.log` (0600). */
export function cursorGuardLogger(routerHome: string): (entry: Record<string, unknown>) => void {
  return (entry) => {
    mkdirSync(routerHome, { recursive: true });
    appendFileSync(path.join(routerHome, "cursor-guard.log"), `${JSON.stringify(entry)}\n`, {
      mode: 0o600,
    });
  };
}

/** The file a guard writes once it watches its pane; the launcher waits for it. */
export function cursorGuardReadyFile(routerHome: string, laneId: string): string {
  return path.join(routerHome, "cursor-guard", `${laneId.replace(/[^A-Za-z0-9_-]/g, "_")}.ready`);
}

export function markCursorGuardReady(routerHome: string, laneId: string): void {
  const file = cursorGuardReadyFile(routerHome, laneId);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${process.pid}\n`, { mode: 0o600 });
}

/**
 * PIDs of processes whose environment sets exactly this CURSOR_CONFIG_DIR (one lane's own
 * directory), from `ps -E` output lines of the form "<pid> <command and environment>".
 */
export function pidsWithCursorConfig(psOutput: string, configDir: string): number[] {
  const needle = `CURSOR_CONFIG_DIR=${configDir}`;
  const pids: number[] = [];
  for (const line of psOutput.split("\n")) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line);
    if (!match) continue;
    let from = 0;
    for (;;) {
      const at = match[2]!.indexOf(needle, from);
      if (at < 0) break;
      const next = match[2]![at + needle.length];
      if (next === undefined || next === " ") {
        pids.push(Number(match[1]));
        break;
      }
      from = at + 1;
    }
  }
  return pids.filter((pid) => pid !== process.pid);
}
