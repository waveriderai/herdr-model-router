import { createHash, randomBytes } from "node:crypto";
import { redactCollectorText } from "../collectors/normalizer.js";
import type { AgentId } from "../domain/ids.js";
import type { ReasoningEffort } from "../domain/model-profile.js";
import { buildAgentCommand, herdrAgentKind } from "./agent-command.js";
import { createHerdrClient, type HerdrClient } from "./herdr-client.js";
import { isHerdrEnv } from "./readiness.js";

export function parseHerdrPaneId(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const data = JSON.parse(trimmed) as {
      result?: { pane?: { pane_id?: unknown } };
      pane?: { pane_id?: unknown };
    };
    const id = data.result?.pane?.pane_id ?? data.pane?.pane_id;
    if (typeof id === "string" && id.length > 0) {
      return id;
    }
  } catch {
    // Fall back to the first token of plain-text Herdr output.
  }
  return trimmed.split(/\s+/)[0];
}

// Herdr reports failures as JSON ({"error":{"code":"...","message":"..."}}) on stdout or
// stderr depending on the command.
export function herdrError(result: { stdout: string; stderr: string }, action: string): string {
  for (const stream of [result.stdout, result.stderr]) {
    try {
      const data = JSON.parse(stream.trim()) as {
        error?: { code?: unknown; message?: unknown };
      };
      const code = typeof data.error?.code === "string" ? data.error.code : undefined;
      const message = typeof data.error?.message === "string" ? data.error.message : undefined;
      if (code || message) {
        return `${action}: ${[code, message].filter(Boolean).join(": ")}`;
      }
    } catch {
      // Not JSON; try the next stream.
    }
  }
  const stderr = result.stderr.trim();
  return stderr ? `${action}: ${stderr}` : action;
}

// Herdr agent names must be unique among live agents and match [a-z][a-z0-9_-]{0,31}.
// Deriving the name from the launch token keeps each launch distinct and lets a retry reuse it.
export function herdrAgentName(agent: AgentId, launchToken: string): string {
  const suffix = createHash("sha256").update(launchToken).digest("hex").slice(0, 6);
  return `router-${herdrAgentKind(agent)}-${suffix}`;
}

const HANDOFF_TIMEOUT_MS = 30_000;

export interface LaunchResult {
  ok: boolean;
  error?: string;
  paneCreated?: boolean;
  printed?: string;
  launchToken?: string;
  paneId?: string;
  agentName?: string;
  /**
   * What is known about the handoff. `not-sent`: no input reached any agent (the launch stopped
   * before the prompt, or Herdr's structured `agent_blocked` refused it before sending input).
   * `unknown`: the prompt was submitted or may have been (timeout, stall, unreadable reply).
   * `sent`: the agent started working on it. Absent for dry runs.
   */
  handoff?: "not-sent" | "unknown" | "sent";
  /** A pane this launch created that may still run the agent (its close was not confirmed). */
  paneOpen?: boolean;
}

/** Herdr's own error code for a failed command, read from its JSON reply only. */
function herdrErrorCode(result: { stdout: string; stderr: string }): string | undefined {
  for (const stream of [result.stdout, result.stderr]) {
    try {
      const data = JSON.parse(stream.trim()) as { error?: { code?: unknown } };
      if (typeof data.error?.code === "string") return data.error.code;
    } catch {
      // Not JSON; try the next stream.
    }
  }
  return undefined;
}

async function closeConfirmed(herdr: HerdrClient, paneId: string): Promise<boolean> {
  try {
    return (await herdr.closePane(paneId)).ok;
  } catch {
    return false;
  }
}

export async function launchRoutedAgent(input: {
  env: NodeJS.Dict<string>;
  agent: AgentId;
  launchName: string;
  effort: ReasoningEffort;
  handoff: string;
  dryRun: boolean;
  existingLaunchToken?: string;
  existingPaneId?: string;
  herdr?: HerdrClient;
  /** Working directory for a new pane; omitted, Herdr uses the current pane's directory. */
  cwd?: string;
}): Promise<LaunchResult> {
  if (!isHerdrEnv(input.env) && !input.dryRun) {
    return { ok: false, error: "HERDR_ENV=1 is required to launch a pane" };
  }
  const command = buildAgentCommand({
    agent: input.agent,
    launchName: input.launchName,
    effort: input.effort,
  });
  const printed = redactCollectorText(`start ${command.join(" ")}; send handoff: ${input.handoff}`);
  const launchToken =
    input.existingLaunchToken ?? `launch_${Date.now()}_${randomBytes(4).toString("hex")}`;
  if (input.dryRun) {
    return { ok: true, paneCreated: false, printed, launchToken };
  }
  const agentName = herdrAgentName(input.agent, launchToken);
  const herdr =
    input.herdr ??
    createHerdrClient(async () => ({
      ok: false,
      code: 1,
      stdout: "",
      stderr: "herdr command adapter was not injected",
    }));
  let paneId = input.existingPaneId;
  let paneCreated = false;
  if (!paneId) {
    const split =
      input.cwd === undefined
        ? await herdr.splitCurrent()
        : await herdr.splitCurrent({ cwd: input.cwd });
    if (!split.ok) {
      return {
        ok: false,
        error: herdrError(split, "herdr pane split failed"),
        launchToken,
        handoff: "not-sent",
        paneOpen: false,
      };
    }
    paneId = parseHerdrPaneId(split.stdout);
    if (!paneId) {
      return {
        ok: false,
        error: "herdr pane split did not return a pane id",
        launchToken,
        handoff: "not-sent",
        paneOpen: false,
      };
    }
    paneCreated = true;
  }
  if (!input.existingPaneId) {
    const started = await herdr.startAgent({
      name: agentName,
      kind: herdrAgentKind(input.agent),
      paneId,
      // Herdr runs the kind's own executable; pass only its native arguments after `--`.
      agentArgs: command.slice(1),
    });
    if (!started.ok) {
      const error = herdrError(started, "herdr agent start failed");
      if (paneCreated) {
        // Do not leave an empty shell pane behind for a launch that never started.
        const closed = await closeConfirmed(herdr, paneId);
        return closed
          ? {
              ok: false,
              error,
              launchToken,
              paneCreated: false,
              agentName,
              handoff: "not-sent",
              paneOpen: false,
            }
          : {
              ok: false,
              error,
              launchToken,
              paneId,
              paneCreated,
              agentName,
              handoff: "not-sent",
              paneOpen: true,
            };
      }
      return {
        ok: false,
        error,
        launchToken,
        paneId,
        paneCreated,
        agentName,
        handoff: "not-sent",
        paneOpen: false,
      };
    }
    // `agent start` returns once the agent UI is detected; let startup (MCP, skills) settle
    // first, or a prompt pasted during startup can be dropped.
    const settled = await herdr.waitFor({ target: agentName, timeoutMs: HANDOFF_TIMEOUT_MS });
    if (!settled.ok) {
      // Nothing was sent, but the started agent stays in its pane for inspection, so a writer
      // authority taken for it is not given back.
      return {
        ok: false,
        error: herdrError(settled, "herdr agent wait failed"),
        launchToken,
        paneId,
        paneCreated,
        agentName,
        handoff: "not-sent",
        paneOpen: paneCreated,
      };
    }
  }
  // Wait only until the agent starts working (or asks a question), not for the whole turn.
  // Herdr returns agent_prompt_stalled when the submission produced no activity.
  const prompted = await herdr.prompt({
    target: agentName,
    text: input.handoff,
    until: ["working", "blocked"],
    timeoutMs: HANDOFF_TIMEOUT_MS,
  });
  if (!prompted.ok) {
    const output = `${prompted.stdout}${prompted.stderr}`;
    // Herdr gives an accepted prompt a fixed 5s to show working or blocked, which a slow
    // agent startup can miss even though it did receive the handoff. Confirm with a second
    // wait before calling the launch failed.
    if (output.includes("agent_prompt_stalled")) {
      const recovered = await herdr.waitFor({
        target: agentName,
        until: ["working", "blocked"],
        timeoutMs: HANDOFF_TIMEOUT_MS,
      });
      if (recovered.ok) {
        return { ok: true, paneCreated, printed, launchToken, paneId, agentName, handoff: "sent" };
      }
    }
    // Only Herdr's structured agent_blocked code proves the prompt was refused before any input
    // was sent. Anything else (a stall with no activity seen, a timeout, an unreadable reply)
    // may have delivered it: the outcome is unknown and the handoff is never resent.
    if (herdrErrorCode(prompted) === "agent_blocked") {
      const closed = paneCreated ? await closeConfirmed(herdr, paneId) : false;
      return {
        ok: false,
        error: `agent ${agentName} was blocked, and Herdr refused the handoff before sending any input${closed ? "; its new pane was closed" : ""}.`,
        launchToken,
        ...(closed ? {} : { paneId }),
        paneCreated: paneCreated && !closed,
        printed,
        agentName,
        handoff: "not-sent",
        paneOpen: paneCreated && !closed,
      };
    }
    return {
      ok: false,
      error: `the handoff to agent ${agentName} in pane ${paneId} has an unknown outcome (${herdrError(prompted, "herdr agent prompt").replace(/^herdr agent prompt: ?/, "")}); it may have been received. It is not resent: inspect that pane.`,
      launchToken,
      paneId,
      paneCreated,
      printed,
      agentName,
      handoff: "unknown",
      paneOpen: paneCreated,
    };
  }
  return { ok: true, paneCreated, printed, launchToken, paneId, agentName, handoff: "sent" };
}
