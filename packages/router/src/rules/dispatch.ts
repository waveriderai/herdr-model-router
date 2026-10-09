import { createHash } from "node:crypto";
import { redactCollectorText } from "../collectors/normalizer.js";
import type { CommandResult, HerdrClient, HerdrPaneClient } from "../launch/herdr-client.js";
import { herdrError, parseHerdrPaneId } from "../launch/herdr-launcher.js";
import {
  NotOwnerError,
  OwnershipConflictError,
  TaskClosedError,
  UnresolvedAttemptError,
  type AttemptState,
  type DispatchAttempt,
  type DispatchLane,
  type DispatchRepository,
  type DispatchTask,
} from "../store/dispatch-repository.js";
import type { Provider } from "./descriptor.js";
import { launchScript, paneCommand } from "./launch-script.js";
import {
  HERDR_KIND,
  missingCapabilities,
  nativeLaunch,
  PROVIDER_EXECUTABLE,
  type NativeLaunch,
} from "./native-argv.js";
import type { RoutePlan } from "./plan.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 500;

/** Where the per-lane launch scripts live (private to the user) and how they are removed. */
export interface LaunchFiles {
  write(laneId: string, content: string): string;
  remove(path: string): void;
}

export interface DispatchDeps {
  store: DispatchRepository;
  herdr: HerdrClient;
  pane: Pick<HerdrPaneClient, "getAgent">;
  /** Runs `<absolute executable> --help` without a shell. */
  probeHelp: (executable: string) => Promise<CommandResult>;
  /** Absolute path of an executable on the router's PATH, or undefined. Reads only. */
  resolveExecutable: (name: string) => string | undefined;
  launchFiles: LaunchFiles;
  /** Variable names (not values) the launched CLI keeps; see `launchEnvNames`. */
  launchEnvNames: readonly string[];
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
}

/** A lane's launch with argv[0] replaced by the resolved absolute executable. */
export interface ResolvedLaunch extends NativeLaunch {
  executable: string;
}

export interface LaneOutcome {
  laneId: string;
  index: number;
  descriptor: string;
  argv: string[];
  state: DispatchLane["state"];
  paneId?: string;
  agentName?: string;
  attempt?: Pick<DispatchAttempt, "id" | "state" | "evidence">;
  error?: string;
}

export type DispatchResult =
  | { ok: true; task: DispatchTask; lanes: LaneOutcome[] }
  | {
      ok: false;
      code: "capability-missing" | "ownership-conflict" | "launch-unsupported";
      error: string;
      owner?: unknown;
    };

/**
 * Every lane's argv, with its executable resolved to an absolute path and checked against
 * that file's own --help, before anything is created. A missing executable or flag fails the
 * whole dispatch closed.
 */
export async function preflightLaunches(
  plan: RoutePlan,
  deps: Pick<DispatchDeps, "probeHelp" | "resolveExecutable">,
): Promise<
  | { ok: true; launches: ResolvedLaunch[] }
  | { ok: false; code: "capability-missing" | "launch-unsupported"; error: string }
> {
  const launches: ResolvedLaunch[] = [];
  const help = new Map<Provider, { executable: string; text: string | undefined }>();
  for (const lane of plan.lanes) {
    const built = nativeLaunch(lane, plan.access);
    if (!built.ok)
      return { ok: false, code: "launch-unsupported", error: `lane ${lane.index}: ${built.error}` };
    const name = PROVIDER_EXECUTABLE[lane.provider];
    if (!help.has(lane.provider)) {
      const executable = deps.resolveExecutable(name);
      if (!executable) {
        return {
          ok: false,
          code: "capability-missing",
          error: `lane ${lane.index}: \`${name}\` is not on PATH; the ${lane.provider} CLI is missing. Nothing was launched and no other model or API key is tried.`,
        };
      }
      const result = await deps.probeHelp(executable);
      help.set(lane.provider, {
        executable,
        text: result.ok ? `${result.stdout}\n${result.stderr}` : undefined,
      });
    }
    const probed = help.get(lane.provider)!;
    if (probed.text === undefined) {
      return {
        ok: false,
        code: "capability-missing",
        error: `lane ${lane.index}: \`${probed.executable} --help\` failed; the ${lane.provider} CLI is missing or broken. Nothing was launched and no other model or API key is tried.`,
      };
    }
    const missing = missingCapabilities(probed.text, built.launch.requiredHelp);
    if (missing.length > 0) {
      return {
        ok: false,
        code: "capability-missing",
        error: `lane ${lane.index}: the installed ${lane.provider} CLI does not list ${missing.join(", ")}; the router will not launch it without that enforcement.`,
      };
    }
    launches.push({
      ...built.launch,
      executable: probed.executable,
      argv: [probed.executable, ...built.launch.argv.slice(1)],
    });
  }
  return { ok: true, launches };
}

export function promptSha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Herdr agent names are unique among live agents and match [a-z][a-z0-9_-]{0,31}. */
export function laneAgentName(kind: string, laneId: string): string {
  return `hmr-${kind}-${createHash("sha256").update(laneId).digest("hex").slice(0, 8)}`;
}

function observedState(stdout: string): "working" | "blocked" {
  return /"blocked"/.test(stdout) ? "blocked" : "working";
}

/**
 * Sends one prompt, at most once. The attempt is written as `sending` first; the Herdr
 * response then decides the recorded state. Anything the router cannot classify is
 * `unknown`, which blocks further prompts to the lane until someone records evidence.
 */
export async function sendOnce(input: {
  deps: DispatchDeps;
  lane: DispatchLane;
  agentName: string;
  text: string;
  purpose: DispatchAttempt["purpose"];
}): Promise<DispatchAttempt> {
  const { deps } = input;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const attempt = deps.store.beginAttempt({
    laneId: input.lane.id,
    purpose: input.purpose,
    promptSha256: promptSha256(input.text),
  });
  let state: Exclude<AttemptState, "sending">;
  let evidence: string;
  let result: CommandResult;
  try {
    result = await deps.herdr.prompt({
      target: input.agentName,
      text: input.text,
      until: ["working", "blocked"],
      timeoutMs,
    });
  } catch (error) {
    deps.store.finishAttempt(
      attempt.id,
      "unknown",
      `prompt call threw: ${redactCollectorText(String(error))}`,
    );
    return deps.store.getAttempt(attempt.id)!;
  }
  const output = `${result.stdout}${result.stderr}`;
  if (result.ok) {
    state = observedState(result.stdout);
    evidence = `herdr agent prompt --wait observed ${state}`;
  } else if (output.includes("agent_blocked")) {
    state = "not-delivered";
    evidence = "herdr rejected the prompt with agent_blocked before sending any input";
  } else if (output.includes("agent_prompt_stalled")) {
    // Herdr accepted the submission but saw no activity within its 5s window.
    const waited = await deps.herdr.waitFor({
      target: input.agentName,
      until: ["working", "blocked"],
      timeoutMs,
    });
    state = waited.ok ? observedState(waited.stdout) : "sent";
    evidence = waited.ok
      ? `submission accepted; a later wait observed ${state}`
      : "submission accepted (agent_prompt_stalled); no working or blocked state observed yet";
  } else {
    state = "unknown";
    evidence = redactCollectorText(
      herdrError(result, "herdr agent prompt returned no delivery evidence"),
    );
  }
  deps.store.finishAttempt(attempt.id, state, evidence);
  return deps.store.getAttempt(attempt.id)!;
}

function laneText(
  plan: RoutePlan,
  task: DispatchTask,
  lane: { index: number },
  prompt: string,
): string {
  const role =
    plan.kind === "panel"
      ? `Read-only panel lane ${lane.index} of ${plan.lanes.length} for role "${plan.role}". Do not modify files.`
      : plan.access === "write"
        ? `Writer task ${task.id} for role "${plan.role}". Revisions for this task arrive in this same session.`
        : `Read-only task for role "${plan.role}". Do not modify files.`;
  return `${prompt}\n\n(${role})`;
}

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Waits until Herdr reports the expected native agent kind, ready and idle, in the pane the
 * router created. Any other detected kind is a mismatch; no ready agent before the timeout
 * is unready. Both fail closed.
 */
async function observeAgent(
  deps: DispatchDeps,
  paneId: string,
  expected: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const sleep = deps.sleep ?? sleepFor;
  let last = "no agent detected";
  for (let waited = 0; ; waited += pollMs) {
    const info = await deps.pane.getAgent(paneId);
    if (info) {
      if (info.paneId !== paneId) {
        return { ok: false, error: `Herdr reported pane ${info.paneId} for pane ${paneId}` };
      }
      if (info.agent !== expected) {
        return {
          ok: false,
          error: `pane ${paneId} runs ${info.agent}, not ${expected}; refusing to name or prompt it`,
        };
      }
      if (info.status === "idle" && info.interactiveReady !== false) return { ok: true };
      last = `${info.agent} is ${info.status}${info.interactiveReady === false ? " (not ready)" : ""}`;
    }
    if (waited >= timeoutMs) {
      return {
        ok: false,
        error: `${expected} did not become ready in pane ${paneId} (${last}); no prompt was sent`,
      };
    }
    await sleep(pollMs);
  }
}

function guardMessage(error: unknown): string | undefined {
  return error instanceof TaskClosedError || error instanceof NotOwnerError
    ? error.message
    : undefined;
}

/** Launches every lane in order. A failed lane is recorded and the next lane still runs. */
export async function dispatchPlan(input: {
  plan: RoutePlan;
  prompt: string;
  worktreeId: string;
  deps: DispatchDeps;
}): Promise<DispatchResult> {
  const { plan, deps } = input;
  const preflight = await preflightLaunches(plan, deps);
  if (!preflight.ok) return preflight;
  let created;
  try {
    created = deps.store.createTask({
      role: plan.role,
      kind: plan.kind,
      access: plan.access,
      worktreeId: input.worktreeId,
      cwd: plan.cwd,
      rulesPath: plan.rulesSource.path,
      lanes: plan.lanes.map((lane, position) => ({
        index: lane.index,
        descriptor: lane.descriptor,
        provider: lane.provider,
        model: lane.model,
        effort: lane.effort,
        argv: preflight.launches[position]!.argv,
      })),
    });
  } catch (error) {
    if (error instanceof OwnershipConflictError) {
      return { ok: false, code: "ownership-conflict", error: error.message, owner: error.owner };
    }
    throw error;
  }
  const { task } = created;
  const outcomes: LaneOutcome[] = [];
  for (const [position, lane] of created.lanes.entries()) {
    const launch = preflight.launches[position]!;
    const outcome: LaneOutcome = {
      laneId: lane.id,
      index: lane.index,
      descriptor: lane.descriptor,
      argv: launch.argv,
      state: "planned",
    };
    outcomes.push(outcome);
    const fail = (error: string) => {
      outcome.state = "failed";
      outcome.error = redactCollectorText(error);
      deps.store.updateLane(lane.id, { state: "failed", error: outcome.error });
    };
    const closeCreatedPane = async (paneId: string) => {
      await deps.herdr.closePane(paneId);
      delete outcome.paneId;
      deps.store.updateLane(lane.id, { paneId: undefined });
    };
    const split = await deps.herdr.splitCurrent({ cwd: plan.cwd });
    const paneId = split.ok ? parseHerdrPaneId(split.stdout) : undefined;
    if (!split.ok || !paneId) {
      fail(
        split.ok
          ? "herdr pane split did not return a pane id"
          : herdrError(split, "herdr pane split failed"),
      );
      continue;
    }
    outcome.paneId = paneId;
    outcome.state = "pane-created";
    deps.store.updateLane(lane.id, { paneId, state: "pane-created" });

    // The CLI starts from the pane's own shell through `env -i`, so whatever that shell's rc
    // files export (API keys included) never reaches it, while the pane's own Herdr context does.
    let scriptPath: string | undefined;
    let observed: Awaited<ReturnType<typeof observeAgent>>;
    try {
      scriptPath = deps.launchFiles.write(
        lane.id,
        launchScript({
          executable: launch.executable,
          args: launch.argv.slice(1),
          cwd: plan.cwd,
          envNames: deps.launchEnvNames,
        }),
      );
      const ran = await deps.herdr.runInPane(paneId, paneCommand(scriptPath));
      observed = ran.ok
        ? await observeAgent(deps, paneId, launch.kind)
        : { ok: false, error: herdrError(ran, "herdr pane run failed") };
    } catch (error) {
      observed = { ok: false, error: `launch failed: ${String(error)}` };
    } finally {
      if (scriptPath) deps.launchFiles.remove(scriptPath);
    }
    if (!observed.ok) {
      await closeCreatedPane(paneId);
      fail(observed.error);
      continue;
    }
    const agentName = laneAgentName(launch.kind, lane.id);
    const renamed = await deps.herdr.renameAgent(paneId, agentName);
    if (!renamed.ok) {
      await closeCreatedPane(paneId);
      fail(herdrError(renamed, "herdr agent rename failed; no prompt was sent"));
      continue;
    }
    outcome.agentName = agentName;
    outcome.state = "agent-started";
    deps.store.updateLane(lane.id, { agentName, state: "agent-started" });
    let sent: DispatchAttempt;
    try {
      sent = await sendOnce({
        deps,
        lane: deps.store.getLane(lane.id)!,
        agentName,
        text: laneText(plan, task, lane, input.prompt),
        purpose: "initial",
      });
    } catch (error) {
      const message = guardMessage(error);
      if (!message) throw error;
      fail(`${message} The agent in pane ${paneId} was left running and was not prompted.`);
      continue;
    }
    outcome.attempt = {
      id: sent.id,
      state: sent.state,
      ...(sent.evidence ? { evidence: sent.evidence } : {}),
    };
    outcome.state = "prompted";
    deps.store.updateLane(lane.id, { state: "prompted" });
  }
  const delivered = outcomes.filter((outcome) =>
    ["sent", "working", "blocked"].includes(outcome.attempt?.state ?? ""),
  ).length;
  const anyAttempt = outcomes.some((outcome) => outcome.attempt);
  if (plan.access === "write" && !anyAttempt) {
    deps.store.releaseUnsent(task.id, "no prompt was sent; ownership released automatically");
  } else {
    // Never reopens a task that was completed or released while this dispatch ran.
    deps.store.finishDispatch(
      task.id,
      delivered === outcomes.length ? "dispatched" : !anyAttempt ? "failed" : "partial",
    );
  }
  return { ok: true, task: deps.store.getTask(task.id)!, lanes: outcomes };
}

export type ReviseResult =
  | { ok: true; task: DispatchTask; lane: DispatchLane; attempt: DispatchAttempt }
  | { ok: false; code: string; error: string };

/**
 * Sends a revision to the exact agent and pane that took the writer task. The router never
 * opens a new pane, changes model, or restarts the writer for a revision.
 */
export async function reviseTask(input: {
  taskId: string;
  text: string;
  deps: DispatchDeps;
}): Promise<ReviseResult> {
  const { deps } = input;
  const task = deps.store.getTask(input.taskId);
  if (!task) return { ok: false, code: "unknown-task", error: `Unknown task ${input.taskId}.` };
  if (task.access !== "write") {
    return {
      ok: false,
      code: "not-writer",
      error: `Task ${task.id} is read-only; only writer tasks take revisions.`,
    };
  }
  const owner = deps.store.ownershipOfTask(task.id);
  if (!owner) {
    return {
      ok: false,
      code: "not-owner",
      error: `Task ${task.id} is ${task.status} and no longer owns its worktree; start a new writer task instead.`,
    };
  }
  const lane = deps.store.lanes(task.id)[0];
  if (!lane?.agentName || !lane.paneId) {
    return {
      ok: false,
      code: "no-agent",
      error: `Task ${task.id} never started an agent; there is no session to revise.`,
    };
  }
  const live = await deps.pane.getAgent(lane.agentName);
  const expectedKind = HERDR_KIND[lane.provider as Provider];
  if (!live || live.paneId !== lane.paneId || live.agent !== expectedKind) {
    return {
      ok: false,
      code: "agent-gone",
      error:
        `Agent ${lane.agentName} is no longer running in pane ${lane.paneId}. The router does not relaunch a writer for a revision; ` +
        `release the task with \`task release ${task.id} --stopped --evidence ...\` and start a new one.`,
    };
  }
  try {
    const attempt = await sendOnce({
      deps,
      lane,
      agentName: lane.agentName,
      text: input.text,
      purpose: "revision",
    });
    return { ok: true, task, lane: deps.store.getLane(lane.id)!, attempt };
  } catch (error) {
    if (error instanceof UnresolvedAttemptError) {
      return { ok: false, code: "unresolved-attempt", error: error.message };
    }
    // Ownership or status changed while this revision waited on Herdr: nothing was sent.
    const message = guardMessage(error);
    if (message) return { ok: false, code: "not-owner", error: message };
    throw error;
  }
}
