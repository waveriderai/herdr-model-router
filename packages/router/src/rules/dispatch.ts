import { createHash } from "node:crypto";
import { redactCollectorText } from "../collectors/normalizer.js";
import type { CommandResult, HerdrClient, HerdrPaneClient } from "../launch/herdr-client.js";
import { herdrError, parseHerdrPaneId } from "../launch/herdr-launcher.js";
import {
  NotOwnerError,
  OwnershipConflictError,
  WorkflowTaskError,
  TaskClosedError,
  UnresolvedAttemptError,
  type AttemptState,
  type DispatchAttempt,
  type DispatchLane,
  type DispatchRepository,
  type DispatchTask,
} from "../store/dispatch-repository.js";
import { WriterAuthorityError } from "../store/workflow-repository.js";
import type { Provider } from "./descriptor.js";
import { launchScript, paneCommand } from "./launch-script.js";
import {
  extractPaneText,
  hasReadinessEvidence,
  screenVerdict,
  type ReadinessKind,
  type ScreenVerdict,
} from "./readiness.js";
import {
  HERDR_KIND,
  missingCapabilities,
  nativeLaunch,
  PROVIDER_EXECUTABLE,
  type NativeLaunch,
} from "./native-argv.js";
import type { RoutePlan } from "./plan.js";
import {
  canonicalCwd,
  compareIdentity,
  identityFromLive,
  type BoundIdentity,
} from "../workflow/identity.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 500;
const SCREEN_LINES = 80;

/** Where the per-lane launch scripts live (private to the user) and how they are removed. */
export interface LaunchFiles {
  write(laneId: string, content: string): string;
  remove(path: string): void;
}

export interface DispatchDeps {
  store: DispatchRepository;
  herdr: HerdrClient;
  /** Agent lookup and screen reads, used only on panes this task owns. */
  pane: Pick<HerdrPaneClient, "getAgent" | "readPane">;
  /** Runs `<absolute executable> --help` without a shell. */
  probeHelp: (executable: string) => Promise<CommandResult>;
  /** Absolute path of an executable on the router's PATH, or undefined. Reads only. */
  resolveExecutable: (name: string) => string | undefined;
  launchFiles: LaunchFiles;
  /** Variable names (not values) the launched CLI keeps; see `launchEnvNames`. */
  launchEnvNames: readonly string[];
  /**
   * Values the operator set explicitly for the router (`MODEL_ROUTER_HOME`), passed literally
   * so a launched CLI's own `hmr` calls open the same router home.
   */
  launchFixedEnv?: Readonly<Record<string, string>>;
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
      code: "capability-missing" | "ownership-conflict" | "launch-unsupported" | "writer-authority";
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
    if (!hasReadinessEvidence(built.launch.kind)) {
      return {
        ok: false,
        code: "launch-unsupported",
        error: `lane ${lane.index}: the router cannot yet confirm that ${lane.provider} is at its ordinary prompt, so it will not launch or prompt it`,
      };
    }
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
  /** Runs after the `sending` attempt is durable and before the prompt goes out. */
  onBegin?: (attempt: DispatchAttempt) => void;
  /** The workflow sending it, when the lane is a workflow's writer. */
  workflowId?: string;
}): Promise<DispatchAttempt> {
  const { deps } = input;
  const attempt = deps.store.beginAttempt({
    laneId: input.lane.id,
    purpose: input.purpose,
    promptSha256: promptSha256(input.text),
    ...(input.workflowId ? { workflowId: input.workflowId } : {}),
  });
  input.onBegin?.(attempt);
  const { state, evidence } = await promptOnce(deps, input.agentName, input.text);
  deps.store.finishAttempt(attempt.id, state, evidence);
  return deps.store.getAttempt(attempt.id)!;
}

/**
 * Submits one prompt and classifies what Herdr showed. The caller records `sending` first and
 * this outcome after; anything unclassifiable is `unknown`, which is never retried.
 */
export async function promptOnce(
  deps: Pick<DispatchDeps, "herdr" | "timeoutMs">,
  target: string,
  text: string,
): Promise<{ state: Exclude<AttemptState, "sending">; evidence: string }> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let result: CommandResult;
  try {
    result = await deps.herdr.prompt({
      target,
      text,
      until: ["working", "blocked"],
      timeoutMs,
    });
  } catch (error) {
    return {
      state: "unknown",
      evidence: `prompt call threw: ${redactCollectorText(String(error))}`,
    };
  }
  const output = `${result.stdout}${result.stderr}`;
  if (result.ok) {
    const state = observedState(result.stdout);
    return { state, evidence: `herdr agent prompt --wait observed ${state}` };
  }
  if (output.includes("agent_blocked")) {
    return {
      state: "not-delivered",
      evidence: "herdr rejected the prompt with agent_blocked before sending any input",
    };
  }
  if (output.includes("agent_prompt_stalled")) {
    // Herdr accepted the submission but saw no activity within its 5s window.
    const waited = await deps.herdr.waitFor({ target, until: ["working", "blocked"], timeoutMs });
    const state = waited.ok ? observedState(waited.stdout) : "sent";
    return {
      state,
      evidence: waited.ok
        ? `submission accepted; a later wait observed ${state}`
        : "submission accepted (agent_prompt_stalled); no working or blocked state observed yet",
    };
  }
  return {
    state: "unknown",
    evidence: redactCollectorText(
      herdrError(result, "herdr agent prompt returned no delivery evidence"),
    ),
  };
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
/** Reads the visible screen of a pane this task owns and judges it. Never sends input. */
export async function readReadiness(
  deps: Pick<DispatchDeps, "pane">,
  paneId: string,
  kind: ReadinessKind,
): Promise<ScreenVerdict> {
  let raw: string | undefined;
  try {
    raw = await deps.pane.readPane(paneId, { source: "visible", lines: SCREEN_LINES });
  } catch {
    raw = undefined;
  }
  return screenVerdict(kind, extractPaneText(raw));
}

/**
 * Waits until Herdr reports the expected native agent kind, idle and ready, AND the pane's
 * own screen shows that CLI's ordinary input prompt with no startup dialog. Another kind or
 * a dialog fails at once (a dialog never clears without input, and the router sends none);
 * no ready prompt before the timeout fails as unready.
 */
async function observeAgent(
  deps: Pick<DispatchDeps, "pane" | "sleep" | "timeoutMs" | "pollMs">,
  paneId: string,
  expected: ReadinessKind,
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
      const verdict = await readReadiness(deps, paneId, expected);
      if (verdict.state === "dialog") {
        return {
          ok: false,
          error: `${verdict.reason}. No prompt was sent and the pane was closed`,
        };
      }
      if (verdict.state === "ready" && info.status === "idle" && info.interactiveReady !== false) {
        return { ok: true };
      }
      last =
        verdict.state === "not-ready"
          ? `${info.agent} is ${info.status}; ${verdict.reason}`
          : `${info.agent} is ${info.status}${info.interactiveReady === false ? " (not ready)" : ""}`;
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
  return error instanceof TaskClosedError ||
    error instanceof NotOwnerError ||
    error instanceof WorkflowTaskError
    ? error.message
    : undefined;
}

export type NativeStart =
  | { ok: true; paneId: string; agentName: string }
  /**
   * `pane` is absent when no pane was created. `closed: false` means Herdr did not confirm
   * the close: the pane may still run the CLI, so the caller keeps it on record.
   */
  | { ok: false; error: string; pane?: { id: string; closed: boolean } };

/** Closes a pane this launch created and reports whether Herdr confirmed it. */
export async function closeCreatedPane(
  herdr: Pick<HerdrClient, "closePane">,
  paneId: string,
): Promise<boolean> {
  try {
    return (await herdr.closePane(paneId)).ok;
  } catch {
    return false;
  }
}

export function orphanNote(paneId: string, closed: boolean): string {
  return closed
    ? ""
    : ` Closing pane ${paneId} was not confirmed; it may still run the CLI (no prompt was sent).`;
}

/**
 * Starts one native CLI in a new pane, with no task: split the pane, run the CLI from the
 * pane's own shell through `env -i`, wait until Herdr and the screen both show the CLI ready
 * with no startup dialog, then name the agent. Any failure after the pane exists closes that
 * pane and reports whether the close was confirmed. Shared by rules-mode dispatch and both
 * workflow backends; it never sends a prompt.
 */
export async function startNativeAgent(input: {
  deps: Pick<
    DispatchDeps,
    | "herdr"
    | "pane"
    | "launchFiles"
    | "launchEnvNames"
    | "launchFixedEnv"
    | "sleep"
    | "timeoutMs"
    | "pollMs"
  >;
  laneId: string;
  cwd: string;
  launch: ResolvedLaunch;
  onPaneCreated?: (paneId: string) => void;
}): Promise<NativeStart> {
  const { deps, launch } = input;
  const split = await deps.herdr.splitCurrent({ cwd: input.cwd });
  const paneId = split.ok ? parseHerdrPaneId(split.stdout) : undefined;
  if (!split.ok || !paneId) {
    return {
      ok: false,
      error: split.ok
        ? "herdr pane split did not return a pane id"
        : herdrError(split, "herdr pane split failed"),
    };
  }
  input.onPaneCreated?.(paneId);
  const closeWith = async (error: string): Promise<NativeStart> => {
    const closed = await closeCreatedPane(deps.herdr, paneId);
    return { ok: false, error: error + orphanNote(paneId, closed), pane: { id: paneId, closed } };
  };
  // The CLI starts from the pane's own shell through `env -i`, so whatever that shell's rc
  // files export (API keys included) never reaches it, while the pane's own Herdr context does.
  let scriptPath: string | undefined;
  let observed: Awaited<ReturnType<typeof observeAgent>>;
  try {
    scriptPath = deps.launchFiles.write(
      input.laneId,
      launchScript({
        executable: launch.executable,
        args: launch.argv.slice(1),
        cwd: input.cwd,
        envNames: deps.launchEnvNames,
        ...(deps.launchFixedEnv ? { fixedEnv: deps.launchFixedEnv } : {}),
        // Codex gives its tool commands only what its shell environment policy sets, so the
        // new pane's Herdr context (and the router home) is set there for this launch alone.
        ...(launch.kind === "codex"
          ? {
              codexContext: [
                ...new Set([
                  ...deps.launchEnvNames.filter((name) => name.startsWith("HERDR_")),
                  ...Object.keys(deps.launchFixedEnv ?? {}),
                ]),
              ],
            }
          : {}),
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
  if (!observed.ok) return closeWith(observed.error);
  const agentName = laneAgentName(launch.kind, input.laneId);
  const renamed = await deps.herdr.renameAgent(paneId, agentName);
  if (!renamed.ok) {
    return closeWith(herdrError(renamed, "herdr agent rename failed; no prompt was sent"));
  }
  return { ok: true, paneId, agentName };
}

/**
 * Reads the identity Herdr reports for a just-named writer and checks it is complete and in
 * the planned directory. The writer's first prompt and every revision need this exact session.
 */
export async function bindWriterIdentity(
  deps: Pick<DispatchDeps, "pane">,
  input: { paneId: string; agentName: string; cwd: string },
): Promise<{ ok: true; identity: BoundIdentity } | { ok: false; error: string }> {
  let live;
  try {
    live = await deps.pane.getAgent(input.paneId);
  } catch {
    live = undefined;
  }
  if (!live) {
    return {
      ok: false,
      error: `Herdr did not report the agent in pane ${input.paneId}; no prompt was sent.`,
    };
  }
  const identity = identityFromLive(live, input.agentName);
  if (!identity.ok) return identity;
  const matched = compareIdentity(live, identity.identity);
  if (!matched.ok) return { ok: false, error: `${matched.error} No prompt was sent.` };
  if (identity.identity.cwd !== canonicalCwd(input.cwd)) {
    return {
      ok: false,
      error: `The writer runs in ${identity.identity.cwd}, not ${canonicalCwd(input.cwd)}; no prompt was sent.`,
    };
  }
  return identity;
}

/** Launches every lane in order. A failed lane is recorded and the next lane still runs. */
export async function dispatchPlan(input: {
  plan: RoutePlan;
  prompt: string;
  worktreeId: string;
  deps: DispatchDeps;
  /** The workflow a writer task belongs to (see DispatchRepository.createTask). */
  workflowId?: string;
  /** Called once the task (and, for a writer, its ownership) is recorded. */
  onTaskCreated?: (task: DispatchTask) => void;
  /** A last gate after the agent is ready, named and bound; refusing closes the pane. */
  beforeSend?: (lane: {
    laneId: string;
    paneId: string;
    agentName: string;
    identity?: BoundIdentity;
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Runs once a lane's `sending` attempt is durable, before its prompt goes out. */
  onAttemptBegun?: (lane: { laneId: string }, attempt: DispatchAttempt) => void;
  /** The text each lane receives; default: the prompt plus the lane's role line. */
  laneText?: (lane: { index: number }, task: DispatchTask) => string;
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
      ...(input.workflowId ? { workflowId: input.workflowId } : {}),
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
    if (error instanceof WriterAuthorityError) {
      return { ok: false, code: "writer-authority", error: error.message };
    }
    throw error;
  }
  const { task } = created;
  input.onTaskCreated?.(task);
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
    const forgetPane = () => {
      delete outcome.paneId;
      deps.store.updateLane(lane.id, { paneId: undefined });
    };
    const started = await startNativeAgent({
      deps,
      laneId: lane.id,
      cwd: plan.cwd,
      launch,
      onPaneCreated: (paneId) => {
        outcome.paneId = paneId;
        outcome.state = "pane-created";
        deps.store.updateLane(lane.id, { paneId, state: "pane-created" });
      },
    });
    if (!started.ok) {
      // A confirmed close forgets the pane; an unconfirmed one stays on record as an orphan.
      if (outcome.paneId && started.pane?.closed !== false) forgetPane();
      fail(started.error);
      continue;
    }
    const { paneId, agentName } = started;
    outcome.agentName = agentName;
    outcome.state = "agent-started";
    deps.store.updateLane(lane.id, { agentName, state: "agent-started" });
    const refuseLane = async (error: string) => {
      const closed = await closeCreatedPane(deps.herdr, paneId);
      if (closed) forgetPane();
      fail(error + orphanNote(paneId, closed));
    };
    let identity: BoundIdentity | undefined;
    if (plan.access === "write") {
      const bound = await bindWriterIdentity(deps, { paneId, agentName, cwd: plan.cwd });
      if (!bound.ok) {
        await refuseLane(bound.error);
        continue;
      }
      identity = bound.identity;
      deps.store.updateLane(lane.id, { sessionId: identity.sessionId, sessionCwd: identity.cwd });
    }
    if (input.beforeSend) {
      const allowed = await input.beforeSend({
        laneId: lane.id,
        paneId,
        agentName,
        ...(identity ? { identity } : {}),
      });
      if (!allowed.ok) {
        await refuseLane(allowed.error);
        continue;
      }
    }
    let sent: DispatchAttempt;
    try {
      sent = await sendOnce({
        deps,
        lane: deps.store.getLane(lane.id)!,
        agentName,
        text: input.laneText
          ? input.laneText(lane, task)
          : laneText(plan, task, lane, input.prompt),
        purpose: "initial",
        ...(input.workflowId ? { workflowId: input.workflowId } : {}),
        ...(input.onAttemptBegun
          ? {
              onBegin: (begun: DispatchAttempt) =>
                input.onAttemptBegun!({ laneId: lane.id }, begun),
            }
          : {}),
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
  // A pane whose close was not confirmed may still run the writer: the worktree stays held.
  const orphaned = outcomes.some((outcome) => outcome.state === "failed" && outcome.paneId);
  if (plan.access === "write" && !anyAttempt && !orphaned) {
    deps.store.releaseUnsent(task.id, "no prompt was sent; ownership released automatically", {
      ...(input.workflowId ? { workflowId: input.workflowId } : {}),
    });
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
  /** Runs after the revision's `sending` attempt is durable, before it is submitted. */
  onBegin?: (attempt: DispatchAttempt) => void;
  /** The workflow revising its own writer; any other caller is refused for a workflow's task. */
  workflowId?: string;
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
  const workflow = deps.store.ownerWorkflow(task.id);
  if (workflow && workflow.id !== input.workflowId) {
    return {
      ok: false,
      code: "workflow-task",
      error: new WorkflowTaskError(task.id, workflow.id).message,
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
  // Continuity needs the session bound at the first prompt. A lane recorded before identity
  // was kept has none, and the router never adopts whatever session the pane runs now.
  if (!lane.sessionId || !lane.sessionCwd) {
    return {
      ok: false,
      code: "identity-missing",
      error:
        `Task ${task.id} has no recorded native session, so the router cannot confirm the writer in pane ${lane.paneId} is the same one. ` +
        `Nothing was sent. Release it with \`task release ${task.id} --stopped --evidence ...\` and start a new writer task.`,
    };
  }
  const expectedKind = HERDR_KIND[lane.provider as Provider];
  let live;
  try {
    live = await deps.pane.getAgent(lane.paneId);
  } catch {
    live = undefined;
  }
  const matched = compareIdentity(live, {
    agentName: lane.agentName,
    kind: expectedKind,
    paneId: lane.paneId,
    sessionId: lane.sessionId,
    cwd: lane.sessionCwd,
  });
  if (!matched.ok) {
    return {
      ok: false,
      code: matched.code === "agent-missing" ? "agent-gone" : matched.code,
      error:
        `${matched.error} The router does not relaunch or rebind a writer for a revision; nothing was sent. ` +
        `Release the task with \`task release ${task.id} --stopped --evidence ...\` and start a new one.`,
    };
  }
  const unresolved = deps.store
    .attempts(lane.id)
    .find((attempt) => attempt.state === "sending" || attempt.state === "unknown");
  if (unresolved) {
    return {
      ok: false,
      code: "unresolved-attempt",
      error: new UnresolvedAttemptError(unresolved).message,
    };
  }
  // The writer must be at its ordinary prompt: a dialog would take the revision as hotkeys.
  const screen = await readReadiness(deps, lane.paneId, expectedKind as ReadinessKind);
  if (screen.state !== "ready") {
    return {
      ok: false,
      code: "not-ready",
      error: `${screen.reason}. Nothing was sent; the writer in pane ${lane.paneId} was left as it is.`,
    };
  }
  try {
    const attempt = await sendOnce({
      deps,
      lane,
      agentName: lane.agentName,
      text: input.text,
      purpose: "revision",
      ...(input.onBegin ? { onBegin: input.onBegin } : {}),
      ...(input.workflowId ? { workflowId: input.workflowId } : {}),
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
