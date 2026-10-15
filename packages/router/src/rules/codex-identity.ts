import type { HerdrClient, HerdrPaneClient } from "../launch/herdr-client.js";
import { herdrError } from "../launch/herdr-launcher.js";
import { inputLineText } from "../live-effort/pane-text.js";
import { canonicalCwd } from "../workflow/identity.js";

/**
 * Codex reports its session to Herdr from its SessionStart hook, which fires only with the
 * first model turn. A fresh Codex is ready before that, so a writer could never be bound
 * before its task. Codex's native `/status` command already shows the session: it runs
 * locally, starts no model turn and uses no tool. This reads that line from the pane's own
 * screen and reports it through Herdr's session API, then reads it back. When the hook fires
 * later it reports the same id, and the bound identity's checks still apply.
 */

/** Herdr's supported Codex session channel; the id is observed from native `/status`. */
export const CODEX_STATUS_SOURCE = "herdr:codex";

const STATUS_COMMAND = "/status";
/** Recent unwrapped lines: Herdr does not split a line, though Codex itself may wrap one. */
const STATUS_LINES = 200;
const VISIBLE_LINES = 60;
/** The canonical lowercase UUID shape; `-` marks where a hyphen must be. */
const UUID_SHAPE = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx";
/** A `/status` card line labeled `Session:`, inside the card's border or not. */
const SESSION_LINE = /^([\s│|]*)Session:(.*)$/;
/** Any row: its indentation (the card's border counts) and its content. */
const ROW = /^([\s│|]*)(.*?)[\s│|]*$/;

/** The `/status` card's `Permissions:` field, inside the card's border or not. */
const PERMISSIONS_LINE = /^[\s│|]*Permissions:\s*(.*?)[\s│|]*$/;

/**
 * The permission profile named on the `/status` card ("Permissions: Profile <name> (...)"),
 * "none" when the card has no Permissions field, or "other" when it names no profile (for
 * example a legacy `sandbox_mode` such as "Full access"). Two different values are "other".
 */
export function codexStatusPermissionProfile(
  text: string,
): { state: "none" } | { state: "other"; value: string } | { state: "profile"; name: string } {
  const values = new Set<string>();
  for (const line of text.replace(/\r/g, "").split("\n")) {
    const match = PERMISSIONS_LINE.exec(line);
    if (match) values.add(match[1]!);
  }
  if (values.size === 0) return { state: "none" };
  if (values.size > 1) return { state: "other", value: [...values].join(" / ") };
  const value = [...values][0]!;
  const profile = /^Profile\s+(\S+)(?:\s|$)/.exec(value);
  return profile ? { state: "profile", name: profile[1]! } : { state: "other", value };
}

export type StatusSession =
  | { state: "none" }
  /** A Session field whose id is still being painted: a bare label or a UUID prefix. */
  | { state: "partial" }
  | { state: "found"; sessionId: string }
  | { state: "ambiguous" }
  | { state: "malformed" };

/** How far `value` fits the UUID shape: a full UUID, a prefix of one, or neither. */
function uuidFit(value: string): "full" | "prefix" | "no" {
  if (value.length > UUID_SHAPE.length) return "no";
  for (let at = 0; at < value.length; at += 1) {
    const hyphen = UUID_SHAPE[at] === "-";
    if (hyphen ? value[at] !== "-" : !/[0-9a-f]/.test(value[at]!)) return "no";
  }
  return value.length === UUID_SHAPE.length ? "full" : "prefix";
}

/** Columns of indentation, counting the card's border characters as indentation. */
const indentOf = (lead: string) => lead.length;

/**
 * The session id in the `Session:` field of Codex's `/status` output. The id is the value on
 * the label's line, or, when Codex wraps it, the UUID-only rows indented below the label; only
 * those rows join it, so no other UUID on the screen counts. A value that is not exactly one
 * lowercase UUID (other characters, text after it, or more than 36 characters) is malformed,
 * and two different ids are ambiguous; both fail closed. A bare label or a UUID prefix is
 * partial: the caller waits for the rest within its bound and never completes it itself.
 */
export function codexStatusSession(text: string): StatusSession {
  const lines = text.replace(/\r/g, "").split("\n");
  const ids = new Set<string>();
  let partial = false;
  for (let at = 0; at < lines.length; at += 1) {
    const label = SESSION_LINE.exec(lines[at]!);
    if (!label) continue;
    let value = label[2]!.replace(/[\s│|]+$/, "").trim();
    // Continuation rows: every non-blank row indented past the label belongs to the field
    // (a blank row or one at the label's margin ends it); the joined value must be a UUID.
    while (at + 1 < lines.length) {
      const row = ROW.exec(lines[at + 1]!)!;
      if (row[2] === "" || indentOf(row[1]!) <= indentOf(label[1]!)) break;
      value += row[2]!;
      at += 1;
    }
    const fit = uuidFit(value);
    if (fit === "no") return { state: "malformed" };
    if (fit === "prefix") partial = true;
    else ids.add(value);
  }
  if (ids.size > 1) return { state: "ambiguous" };
  if (partial) return { state: "partial" };
  if (ids.size === 0) return { state: "none" };
  return { state: "found", sessionId: [...ids][0]! };
}

export interface CodexIdentityDeps {
  herdr: Pick<HerdrClient, "reportAgentSession">;
  pane: Pick<HerdrPaneClient, "getAgent" | "readPane" | "sendText" | "sendKeys">;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  pollMs: number;
}

type Outcome = { ok: true; probed: boolean } | { ok: false; error: string };

/**
 * Makes sure Herdr reports a session for a Codex the router just started and named. Nothing
 * happens when Herdr already reports one. Otherwise the pane must be idle, named, of kind
 * `codex`, in the planned directory, and show no Session line yet; then `/status` is typed,
 * Enter is pressed only if the input box holds exactly that, and the id on the pane's own
 * Session line is reported and read back. Errors never repeat the card's other lines.
 */
export async function ensureCodexSession(
  deps: CodexIdentityDeps,
  input: {
    paneId: string;
    agentName: string;
    cwd: string;
    /** A writer's permission profile; its /status card must name it or nothing is prompted. */
    expectedPermissionProfile?: string;
  },
): Promise<Outcome> {
  const { paneId } = input;
  const fail = (reason: string): Outcome => ({
    ok: false,
    error: `Codex in pane ${paneId} has not reported its session to Herdr, and ${reason}; no prompt was sent`,
  });
  const failProfile = (reason: string): Outcome => ({
    ok: false,
    error: `Codex in pane ${paneId} could not be confirmed to run under permission profile ${input.expectedPermissionProfile}: ${reason}; no prompt was sent`,
  });
  const expected = canonicalCwd(input.cwd);
  // The same pane, kind, name and directory, idle: anything else is not this launch's Codex.
  const check = async (): Promise<
    { ok: true; sessionId?: string } | { ok: false; reason: string }
  > => {
    let live;
    try {
      live = await deps.pane.getAgent(paneId);
    } catch {
      live = undefined;
    }
    if (!live) return { ok: false, reason: "Herdr no longer reports its agent" };
    if (live.paneId !== paneId) {
      return { ok: false, reason: `Herdr reported pane ${live.paneId} instead` };
    }
    if (live.agent !== "codex") return { ok: false, reason: `the pane runs ${live.agent}` };
    if (live.name !== input.agentName) {
      return { ok: false, reason: `the agent is named ${live.name ?? "nothing"}` };
    }
    const cwd = live.cwd ? canonicalCwd(live.cwd) : undefined;
    if (cwd !== expected) {
      return {
        ok: false,
        reason: `it runs in ${cwd ?? "an unreported directory"}, not ${expected}`,
      };
    }
    if (live.status !== "idle") return { ok: false, reason: `it is ${live.status}, not idle` };
    return { ok: true, ...(live.sessionId ? { sessionId: live.sessionId } : {}) };
  };
  // A session Herdr already reports is left entirely to the caller's identity binding, but a
  // writer's permission profile is only visible on /status, so a writer still types it once.
  const mustCheckProfile = input.expectedPermissionProfile !== undefined;
  const reported = await deps.pane.getAgent(paneId).catch(() => undefined);
  let sessionKnown = reported?.paneId === paneId && Boolean(reported.sessionId);
  if (sessionKnown && !mustCheckProfile) return { ok: true, probed: false };
  const before = await check();
  if (!before.ok) {
    // A reported session in another directory is the caller's identity binding to refuse
    // (cwd-changed); it never reaches a prompt, so no profile check is needed first.
    if (sessionKnown && before.reason.startsWith("it runs in ")) return { ok: true, probed: false };
    return fail(`its identity cannot be confirmed (${before.reason})`);
  }
  if (before.sessionId) {
    if (!mustCheckProfile) return { ok: true, probed: false };
    sessionKnown = true;
  }

  const recent = () =>
    deps.pane
      .readPane(paneId, { source: "recent-unwrapped", lines: STATUS_LINES })
      .catch(() => undefined);
  const permissionLines = (text: string) =>
    text.split("\n").filter((line) => /^[\s│|]*Permissions:/.test(line)).length;
  const baseline = await recent();
  if (baseline === undefined) return fail("its screen could not be read");
  if (!sessionKnown && codexStatusSession(baseline).state !== "none") {
    return fail("its screen already shows a Session line, so a new one could not be told apart");
  }
  const permissionsBefore = permissionLines(baseline);
  const typed = await deps.pane.sendText(paneId, STATUS_COMMAND);
  if (!typed.ok) return fail(herdrError(typed, "typing /status failed"));
  // Enter only when the box holds exactly `/status`; anything else would be a message. Codex
  // repaints the box asynchronously, so an empty or not-yet-drawn box may be waited for within
  // the bound. /status is never typed twice, and any other text fails at once.
  for (let waited = 0; ; waited += deps.pollMs) {
    const still = await check();
    if (!still.ok) {
      return fail(`its identity changed before Enter (${still.reason}), so Enter was not pressed`);
    }
    const echoed = await deps.pane
      .readPane(paneId, { source: "visible", lines: VISIBLE_LINES, ansi: true })
      .catch(() => undefined);
    const draft = echoed === undefined ? undefined : inputLineText("codex", echoed);
    if (draft === STATUS_COMMAND) break;
    if (draft !== undefined && draft !== "") {
      return fail("its input box did not hold exactly /status, so Enter was not pressed");
    }
    if (waited >= deps.timeoutMs) {
      return fail(
        `its input box did not show /status within ${deps.timeoutMs}ms, so Enter was not pressed`,
      );
    }
    await deps.sleep(deps.pollMs);
  }
  const entered = await deps.pane.sendKeys(paneId, ["enter"]);
  if (!entered.ok) return fail(herdrError(entered, "pressing Enter failed"));

  const checkProfile = (text: string | undefined): Outcome | undefined => {
    if (!mustCheckProfile) return undefined;
    if (text === undefined || permissionLines(text) <= permissionsBefore) {
      return failProfile(`its /status showed no new Permissions line within ${deps.timeoutMs}ms`);
    }
    const shown = codexStatusPermissionProfile(text);
    if (shown.state === "none") return failProfile("its /status showed no Permissions line");
    if (shown.state === "other") {
      return failProfile(
        `its /status shows "${shown.value}" (a loaded Codex config's sandbox_mode probably overrides default_permissions)`,
      );
    }
    if (shown.name !== input.expectedPermissionProfile) {
      return failProfile(`its /status shows profile ${shown.name}`);
    }
    return undefined;
  };

  if (sessionKnown) {
    let text: string | undefined;
    for (let waited = 0; ; waited += deps.pollMs) {
      text = await recent();
      if (text !== undefined && permissionLines(text) > permissionsBefore) break;
      if (waited >= deps.timeoutMs) break;
      await deps.sleep(deps.pollMs);
    }
    const refused = checkProfile(text);
    if (refused) return refused;
    const after = await check();
    if (!after.ok) return fail(`its identity changed during /status (${after.reason})`);
    return { ok: true, probed: false };
  }

  let seen: StatusSession = { state: "none" };
  let lastText: string | undefined;
  for (let waited = 0; ; waited += deps.pollMs) {
    const text = await recent();
    if (text !== undefined) {
      lastText = text;
      seen = codexStatusSession(text);
    }
    // A bare or partly painted Session field is waited for, like no field at all.
    if (seen.state !== "none" && seen.state !== "partial") break;
    if (waited >= deps.timeoutMs) break;
    await deps.sleep(deps.pollMs);
  }
  if (seen.state === "none") {
    return fail(`its /status showed no Session line within ${deps.timeoutMs}ms`);
  }
  if (seen.state === "partial") {
    return fail(`its /status Session id was still incomplete after ${deps.timeoutMs}ms`);
  }
  if (seen.state === "ambiguous") return fail("its /status showed more than one Session id");
  if (seen.state === "malformed") return fail("its /status Session line is not a session UUID");
  const sessionId = seen.sessionId;

  const refused = checkProfile(lastText);
  if (refused) return refused;

  // /status starts no turn: the agent must still be idle and the same one.
  const after = await check();
  if (!after.ok) return fail(`its identity changed during /status (${after.reason})`);
  if (after.sessionId && after.sessionId !== sessionId) {
    return fail("Herdr now reports a different session than its /status showed");
  }
  if (!after.sessionId) {
    let sent;
    try {
      sent = await deps.herdr.reportAgentSession({
        paneId,
        source: CODEX_STATUS_SOURCE,
        agent: "codex",
        sessionId,
      });
    } catch (error) {
      return fail(`reporting the session to Herdr failed (${String(error)})`);
    }
    if (!sent.ok) {
      return fail(herdrError(sent, "reporting the session to Herdr failed"));
    }
  }
  const readBack = await check();
  if (!readBack.ok || readBack.sessionId !== sessionId) {
    return fail("Herdr did not read back the session its /status showed");
  }
  return { ok: true, probed: true };
}
