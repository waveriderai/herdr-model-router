import { realpathSync } from "node:fs";
import type { HerdrAgentInfo, HerdrPaneClient } from "../launch/herdr-client.js";

/** The one native writer a workflow is bound to. Every field is required; none is inferred. */
export interface BoundIdentity {
  agentName: string;
  kind: string;
  paneId: string;
  sessionId: string;
  /** Canonical (real) path. */
  cwd: string;
}

export type IdentityCheck =
  | { ok: true; live: HerdrAgentInfo }
  | { ok: false; code: IdentityRefusal; error: string; live?: HerdrAgentInfo };

export type IdentityRefusal =
  | "agent-missing"
  | "name-missing"
  | "name-changed"
  | "pane-changed"
  | "kind-changed"
  | "session-missing"
  | "session-changed"
  | "cwd-missing"
  | "cwd-changed"
  | "not-stopped";

/** Statuses that prove the writer is not doing anything. Everything else, `unknown` included, refuses. */
export const STOPPED_STATUSES: readonly HerdrAgentInfo["status"][] = ["idle", "done"];

function canonical(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

export function canonicalCwd(value: string): string {
  return canonical(value);
}

/**
 * Builds the identity to bind from what Herdr reports for a freshly started agent. A missing
 * session or cwd is a refusal that names what Herdr did not report, not a generic failure.
 */
export function identityFromLive(
  live: HerdrAgentInfo,
  agentName: string,
): { ok: true; identity: BoundIdentity } | { ok: false; code: IdentityRefusal; error: string } {
  if (!live.sessionId) {
    return {
      ok: false,
      code: "session-missing",
      error:
        `Herdr reports no session id for the ${live.agent} agent in pane ${live.paneId}; ` +
        `the Herdr integration for ${live.agent} must report its session before a writer can be bound. No prompt was sent.`,
    };
  }
  if (!live.cwd) {
    return {
      ok: false,
      code: "cwd-missing",
      error: `Herdr reports no working directory for the agent in pane ${live.paneId}. No prompt was sent.`,
    };
  }
  return {
    ok: true,
    identity: {
      agentName,
      kind: live.agent,
      paneId: live.paneId,
      sessionId: live.sessionId,
      cwd: canonical(live.cwd),
    },
  };
}

/** Compares a live Herdr record with the bound identity: name, pane, kind, session, directory. */
export function compareIdentity(
  live: HerdrAgentInfo | undefined,
  bound: BoundIdentity,
): IdentityCheck {
  if (!live) {
    return {
      ok: false,
      code: "agent-missing",
      error: `Herdr did not report agent ${bound.agentName}; its state is unknown, so nothing is sent or claimed.`,
    };
  }
  const refuse = (code: IdentityRefusal, error: string): IdentityCheck => ({
    ok: false,
    code,
    error,
    live,
  });
  if (!live.name) {
    return refuse(
      "name-missing",
      `Herdr reports no agent name for pane ${live.paneId}; it cannot be confirmed as ${bound.agentName}.`,
    );
  }
  if (live.name !== bound.agentName) {
    return refuse(
      "name-changed",
      `Pane ${live.paneId} runs agent ${live.name}, not the bound ${bound.agentName}.`,
    );
  }
  if (live.paneId !== bound.paneId) {
    return refuse(
      "pane-changed",
      `Agent ${bound.agentName} is in pane ${live.paneId}, not its bound pane ${bound.paneId}.`,
    );
  }
  if (live.agent !== bound.kind) {
    return refuse("kind-changed", `Pane ${bound.paneId} runs ${live.agent}, not ${bound.kind}.`);
  }
  if (!live.sessionId) {
    return refuse(
      "session-missing",
      `Herdr reports no session for pane ${bound.paneId}; the bound session cannot be confirmed.`,
    );
  }
  if (live.sessionId !== bound.sessionId) {
    return refuse(
      "session-changed",
      `Pane ${bound.paneId} runs a different session than the one bound to this workflow.`,
    );
  }
  if (!live.cwd) {
    return refuse("cwd-missing", `Herdr reports no working directory for pane ${bound.paneId}.`);
  }
  if (canonical(live.cwd) !== bound.cwd) {
    return refuse(
      "cwd-changed",
      `The agent in pane ${bound.paneId} runs in ${live.cwd}, not ${bound.cwd}.`,
    );
  }
  return { ok: true, live };
}

/**
 * The writer is stopped only when its full identity matches AND Herdr positively reports it
 * idle or done. A missing record, `unknown`, `working`, or `blocked` all refuse.
 */
export async function checkStopped(
  pane: Pick<HerdrPaneClient, "getAgent">,
  bound: BoundIdentity,
): Promise<IdentityCheck> {
  let live: HerdrAgentInfo | undefined;
  try {
    live = await pane.getAgent(bound.paneId);
  } catch {
    live = undefined;
  }
  const matched = compareIdentity(live, bound);
  if (!matched.ok) return matched;
  if (!STOPPED_STATUSES.includes(matched.live.status)) {
    return {
      ok: false,
      code: "not-stopped",
      error: `Writer ${bound.agentName} is ${matched.live.status}, not idle or done; it is not confirmed stopped.`,
      live: matched.live,
    };
  }
  return matched;
}

/** Looks the writer up by its bound pane and checks identity only (any status). */
export async function checkIdentity(
  pane: Pick<HerdrPaneClient, "getAgent">,
  bound: BoundIdentity,
): Promise<IdentityCheck> {
  let live: HerdrAgentInfo | undefined;
  try {
    live = await pane.getAgent(bound.paneId);
  } catch {
    live = undefined;
  }
  return compareIdentity(live, bound);
}
