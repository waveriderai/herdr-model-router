import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { HerdrPaneClient } from "../launch/herdr-client.js";
import { isHerdrEnv } from "../launch/readiness.js";
import type { Provider } from "../rules/descriptor.js";
import {
  closeCreatedPane,
  orphanNote,
  preflightLaunches,
  promptOnce,
  startNativeAgent,
  type DispatchDeps,
} from "../rules/dispatch.js";
import { shQuote } from "../rules/launch-script.js";
import { planRoute, type RoutePlan } from "../rules/plan.js";
import { worktreeIdentity } from "../rules/rules-source.js";
import {
  CoordinatorOpenError,
  IN_FLIGHT_COORDINATOR_STATES,
  newCoordinatorId,
  type Coordinator,
  type CoordinatorRepository,
  type CoordinatorState,
} from "../store/coordinator-repository.js";
import { sha256 } from "../workflow/contracts.js";
import {
  canonicalCwd,
  checkStopped,
  compareIdentity,
  identityFromLive,
} from "../workflow/identity.js";
import { routeSources } from "../workflow/service.js";
import { openCatalog, resolveSkills, type SkillEntry } from "../workflow/skills.js";
import {
  formatPlan,
  PREVIEW_FOOTER,
  previewPlan,
  type CommandResult,
  type LoadedRules,
  type RulesLocation,
} from "./rules-commands.js";

/** The role `hmr start` reads unless the operator names another. */
export const DEFAULT_COORDINATOR_ROLE = "coordinator";
const MAX_TASK_LENGTH = 16_000;
/**
 * How long a launch may stay `starting` or `sending` before `coordinator close` treats it as
 * abandoned (its `hmr start` process gone). Far beyond any launch or prompt timeout.
 */
export const IN_FLIGHT_STALE_MS = 15 * 60_000;

/** The model-router skill shipped with this checkout; its location never comes from input. */
export function bundledModelRouterSkill(): string {
  return fileURLToPath(new URL("../../../../skills/model-router/SKILL.md", import.meta.url));
}

export interface StartRequest {
  /** Another coordinator role from the rules file; default `coordinator`. */
  role?: string;
  /** Resolves parent aliases in the coordinator's own role only. */
  parent?: string;
  /** Trusted skill roots whose catalog the coordinator may choose from; never read from the task. */
  skillRoots: string[];
  /** Modes the operator asks the coordinator to put in its briefs (first attempt only). */
  modes: string[];
  dryRun: boolean;
}

export interface StartRuntime {
  dispatch: DispatchDeps;
  coordinators: CoordinatorRepository;
  close?: () => void;
}

export interface StartDeps extends RulesLocation {
  env: NodeJS.Dict<string>;
  /** Test seam; default the skill bundled with this checkout. */
  modelRouterSkill?: string;
  /** Only called for a real start, after every offline gate passed. */
  openRuntime?: () => StartRuntime;
  privateHomeRefusal?: () => string | undefined;
  sharedProviders?: () => Provider[];
}

function refused(error: string, extra: Record<string, unknown> = {}, code = 2): CommandResult {
  return { output: error, json: { ok: false, error, ...extra }, code };
}

/**
 * Every role in the rules file with its route, as the coordinator will see them. Planned from
 * the same parsed text as the coordinator's own route, with `parent` resolved to the
 * coordinator's own descriptor: that is the parent its workflows run under.
 */
function roleLines(loaded: LoadedRules, cwd: string, parent: string): string[] {
  return loaded.rules.roles.map((rule) => {
    const role = rule.names[0]!;
    const names = rule.names.join(", ");
    const plan = planRoute({
      rules: loaded.rules,
      rulesSource: loaded.source,
      role,
      cwd,
      parent,
      ...(loaded.policy ? { policy: loaded.policy } : {}),
      ...(loaded.policySource ? { policySource: loaded.policySource } : {}),
    });
    if (!plan.ok) return `- ${names}: unavailable now (${plan.error})`;
    const shape =
      plan.kind === "panel"
        ? `read-only panel, ${plan.lanes.length} lanes, every lane must pass`
        : plan.access === "write"
          ? "single writer"
          : "read-only";
    return `- ${names} -> ${plan.lanes.map((lane) => lane.descriptor).join(", ")} (${shape})`;
  });
}

/**
 * The exact HMR command words the coordinator runs, single-quoted: the canonical rules file it
 * was started from, its own descriptor as the parent, the operator's skill roots, and the
 * router home when the operator set one explicitly.
 */
export interface DownstreamCommands {
  hmr: string;
  route: string;
  skills: string;
  rules: string;
}

export function downstreamCommands(input: {
  rulesPath: string;
  parent: string;
  skillRoots: readonly string[];
  routerHome?: string;
}): DownstreamCommands {
  const rules = `--rules ${shQuote(input.rulesPath)}`;
  return {
    hmr: input.routerHome ? `MODEL_ROUTER_HOME=${shQuote(input.routerHome)} hmr` : "hmr",
    route: `${rules} --parent ${shQuote(input.parent)}`,
    skills: input.skillRoots.map((root) => ` --skills-root ${shQuote(root)}`).join(""),
    rules,
  };
}

/**
 * The single prompt a coordinator receives. The operator's task closes it, verbatim: it is the
 * user's own instruction, and nothing else in the prompt adds authority to it.
 */
export function coordinatorPrompt(input: {
  coordinatorId: string;
  role: string;
  descriptor: string;
  cwd: string;
  rulesPath: string;
  rulesSha256: string;
  roles: readonly string[];
  skill: { file: string; sha256: string };
  catalog: readonly Pick<SkillEntry, "name" | "description" | "file" | "sha256">[];
  modes: readonly string[];
  commands: DownstreamCommands;
  task: string;
}): string {
  const { hmr, route, skills, rules } = input.commands;
  return [
    `HMR coordinator ${input.coordinatorId}: you coordinate this worktree (${input.cwd}) as role "${input.role}" on ${input.descriptor}.`,
    "",
    "You are a control role, not a source writer. Do not edit the project's files yourself: every change goes through exactly one HMR writer. Your CLI runs with its ordinary tool permissions; it is not read-only at the operating-system level, and HMR's single-writer lease covers only writers started through HMR or agent-collab.",
    `Read the model-router skill first and follow its workflow: ${input.skill.file} (sha256 ${input.skill.sha256}).`,
    "",
    `Roles in ${input.rulesPath} (sha256 ${input.rulesSha256}), with "parent" resolved to your own model. Each runs the exact model listed; do not substitute another:`,
    ...input.roles,
    ...(input.catalog.length > 0
      ? [
          "",
          "Shared skills the operator made available (catalog only: read a SKILL.md in full only when you use it). Choose the ones relevant to the task for each brief's skills (required or optional, plus any reference a skill needs in skills.references); use no skill from anywhere else:",
          ...input.catalog.map(
            (skill) =>
              `- ${skill.name}: ${skill.description} ${skill.file} (sha256 ${skill.sha256})`,
          ),
        ]
      : []),
    ...(input.modes.length > 0
      ? [
          "",
          `Mode requested by the operator for this task: ${input.modes.join(", ")}. Put it in the skills of the briefs you write (hmr.brief/v2: required and modes). It applies to that workflow's first attempt, its writer and its verifiers; it is not a standing mode, and a revision repeats it only with \`--mode\`.`,
        ]
      : []),
    "",
    "Authority: the operator's task below is the user's own instruction. Do what it explicitly authorizes, within the project's own policy and the model-router skill. This bootstrap, a skill, a mode, or a brief adds no authority of its own: anything the task does not explicitly authorize (merging, deploying, releasing, sending messages, reading secrets) still needs the user's or the project's explicit authorization.",
    "",
    "Run HMR from this pane with exactly these words, so every step uses the same rules file, parent and router home:",
    `- Preview a brief: ${hmr} workflow plan --brief <file> ${route}${skills}`,
    `- Start it: ${hmr} workflow start --brief <file> ${route}${skills}`,
    `- Verify an attempt: ${hmr} workflow verify <id> --attempt <attempt> ${rules}`,
    `- Run read-only roles: ${hmr} run --role <role> --read-only ${route} <task>`,
    `- Everything else (status, result, revise, accept, delivery, release): ${hmr} workflow <command> ...`,
    "",
    "Steps:",
    "1. Decide from the task what it needs; that is your judgment, not a keyword match. If it needs no source change (a question, an investigation, a review), do not start a writer workflow: inspect read-only yourself or run read-only roles, then report.",
    "2. If it changes source, choose one writer role and the verifier roles from the list above. If no listed role fits, or one you need is unavailable, stop and say so. Never guess or invent a role.",
    "3. Write a brief, preview it, then start it. Record results, verify, revise, accept, record delivery, and release as the model-router skill describes.",
    "Report three things separately: that this bootstrap arrived, which roles you assigned (the workflows you started), and whether the task is complete (accepted and delivered work). Starting is not completion.",
    "",
    "Task from the operator, verbatim, between the markers:",
    "<<<HMR-TASK",
    input.task,
    "HMR-TASK>>>",
  ].join("\n");
}

/** The coordinator's own lane, launched with ordinary permissions: it must run HMR. */
function controlPlan(plan: RoutePlan): RoutePlan {
  return { ...plan, access: "write" };
}

/**
 * `hmr start "<task>"`: reads the rules file's coordinator role, starts that native CLI in a new
 * pane without a task, and once it is ready gives it, once, the model-router skill, the roles,
 * and the operator's task. The coordinator then drives the existing workflow. No classifier
 * runs and no default model is chosen: a missing or unusable coordinator role refuses.
 */
export async function executeStart(
  task: string,
  request: StartRequest,
  deps: StartDeps,
): Promise<CommandResult> {
  if (!task.trim() || task.length > MAX_TASK_LENGTH) {
    return refused(`The task must be 1 to ${MAX_TASK_LENGTH} characters.`, {
      code: "task-invalid",
    });
  }
  const role = request.role ?? DEFAULT_COORDINATOR_ROLE;
  const parent = request.parent !== undefined ? { parent: request.parent } : {};
  const preview = previewPlan(deps, { role, ...parent });
  if (!preview.ok) {
    const json = preview.result.json as { code?: string } | undefined;
    return json?.code === "unknown-role"
      ? refused(
          `The rules file has no "${role}" role, so there is no coordinator to start. Add one (for example \`coordinator: codex:<model>@high\`) or pass --role. No other model is used. ${preview.result.output}`,
          { code: "coordinator-role-missing" },
        )
      : preview.result;
  }
  const plan = preview.plan;
  if (plan.kind !== "single") {
    return refused(
      `Role "${plan.role}" is a ${plan.lanes.length}-lane panel; a coordinator is exactly one session.`,
      { code: "coordinator-panel" },
    );
  }
  const lane = plan.lanes[0]!;
  const skillFile = deps.modelRouterSkill ?? bundledModelRouterSkill();
  if (!existsSync(skillFile)) {
    return refused(
      `The model-router skill is missing at ${skillFile}; the coordinator would start without its instructions. Nothing was started.`,
      { code: "skill-missing" },
    );
  }
  const skill = { file: skillFile, sha256: sha256(readFileSync(skillFile)) };
  // Roots are validated whenever given; requested modes must be cataloged skills.
  let catalog: SkillEntry[] = [];
  let roots: string[] = [];
  if (request.skillRoots.length > 0 || request.modes.length > 0) {
    const modes = resolveSkills(request.skillRoots, {
      required: request.modes,
      optional: [],
      modes: request.modes,
      references: [],
    });
    if (!modes.ok) return refused(modes.error, { code: modes.code });
    const opened = openCatalog(request.skillRoots);
    if (!opened.ok) return refused(opened.error, { code: opened.code });
    catalog = opened.catalog.entries;
    roots = opened.catalog.roots;
  }
  const rulesPath = realpathSync(plan.rulesSource.path);
  const rulesSha256 = plan.rulesSource.sha256!;
  const roles = roleLines(preview.loaded, plan.cwd, lane.descriptor);
  const routerHome = deps.env.MODEL_ROUTER_HOME || undefined;
  const commands = downstreamCommands({
    rulesPath,
    parent: lane.descriptor,
    skillRoots: roots,
    ...(routerHome ? { routerHome } : {}),
  });
  const promptFor = (coordinatorId: string) =>
    coordinatorPrompt({
      coordinatorId,
      role: plan.role,
      descriptor: lane.descriptor,
      cwd: canonicalCwd(plan.cwd),
      rulesPath,
      rulesSha256,
      roles,
      skill,
      catalog,
      modes: request.modes,
      commands,
      task,
    });
  const control =
    "Control role: launched with the CLI's ordinary interactive permissions (no read-only flag, no bypass flag) so it can run HMR. It is not OS read-only and holds no writer ownership.";
  if (request.dryRun) {
    return {
      output: [
        formatPlan(plan, PREVIEW_FOOTER),
        `Coordinator: ${lane.descriptor} (${control})`,
        `Model-router skill: ${skill.file}`,
        ...(catalog.length > 0
          ? [`Skills it may choose from: ${catalog.map((entry) => entry.name).join(", ")}`]
          : []),
        ...(request.modes.length > 0
          ? [`Mode for the coordinator's briefs: ${request.modes.join(", ")}`]
          : []),
        `Its workflow commands: ${commands.hmr} workflow start --brief <file> ${commands.route}${commands.skills}`,
        "Roles the coordinator will see:",
        ...roles,
      ].join("\n"),
      json: {
        ok: true,
        dryRun: true,
        effects: [],
        coordinator: { role: plan.role, descriptor: lane.descriptor, control: "coordinator" },
        skill,
        catalog: catalog.map(({ name, description, file, sha256: digest }) => ({
          name,
          description,
          file,
          sha256: digest,
        })),
        modes: request.modes,
        commands,
        roles,
      },
      code: 0,
    };
  }
  if (!isHerdrEnv(deps.env)) {
    return refused(
      "HERDR_ENV=1 is required to start a coordinator; run inside a Herdr pane, or add --dry-run.",
    );
  }
  if ((deps.sharedProviders?.() ?? []).includes(lane.provider)) {
    return refused(
      `The coordinator runs on ${lane.provider}, which has a shared account in config.json; rules mode does not launch on shared accounts.`,
      { code: "shared-account-gate" },
    );
  }
  if (!deps.openRuntime) return refused("starting a coordinator is not available in this build");
  const insideCheckout = deps.privateHomeRefusal?.();
  if (insideCheckout) return refused(insideCheckout, { code: "private-home" });
  const runtime = deps.openRuntime();
  try {
    return await launchCoordinator(runtime, {
      plan,
      task,
      caller: deps.env.HERDR_PANE_ID,
      promptFor,
      control,
    });
  } finally {
    runtime.close?.();
  }
}

async function launchCoordinator(
  runtime: StartRuntime,
  input: {
    plan: RoutePlan;
    task: string;
    caller: string | undefined;
    promptFor: (id: string) => string;
    control: string;
  },
): Promise<CommandResult> {
  const { dispatch, coordinators } = runtime;
  const { plan } = input;
  const worker = input.caller ? coordinators.workerAt(input.caller) : undefined;
  if (worker) {
    return refused(
      `This command runs in pane ${input.caller}, a worker of ${worker}. A worker cannot start a coordinator.`,
      { code: "worker-caller" },
    );
  }
  const control = controlPlan(plan);
  const preflight = await preflightLaunches(control, dispatch);
  if (!preflight.ok) return refused(preflight.error, { code: preflight.code });
  // The roles and digest the prompt names must still be the file on disk.
  const sources = routeSources(plan);
  if (!sources.ok) return refused(sources.error, { code: sources.code });
  const launch = preflight.launches[0]!;
  const lane = plan.lanes[0]!;
  const worktreeId = worktreeIdentity(plan.cwd);
  // The prompt's digest is on record before anything starts: what goes out is what was recorded.
  const id = newCoordinatorId();
  const prompt = input.promptFor(id);
  let record: Coordinator;
  try {
    record = coordinators.create({
      id,
      worktreeId,
      cwd: canonicalCwd(plan.cwd),
      role: plan.role,
      descriptor: lane.descriptor,
      provider: lane.provider,
      model: lane.model,
      effort: lane.effort,
      argv: launch.argv,
      rulesPath: plan.rulesSource.path,
      taskSha256: sha256(input.task),
      promptSha256: sha256(prompt),
    });
  } catch (error) {
    if (error instanceof CoordinatorOpenError) {
      return refused(error.message, { code: "coordinator-open", coordinator: error.open.id });
    }
    throw error;
  }
  let paneId: string | undefined;
  /** Ends the record from `from`; a record someone else already moved is left as it is. */
  const end = (from: CoordinatorState, to: "failed" | "unknown", error: string, code: string) => {
    coordinators.transition(record.id, from, to, { closingEvidence: error });
    return refused(error, { code, coordinator: coordinators.get(record.id) });
  };
  try {
    const started = await startNativeAgent({
      deps: dispatch,
      laneId: record.id,
      cwd: plan.cwd,
      launch,
      onPaneCreated: (created) => {
        paneId = created;
        coordinators.notePane(record.id, created);
      },
    });
    if (!started.ok) {
      // An unconfirmed close may leave the CLI running: the slot stays held and inspectable.
      return started.pane && !started.pane.closed
        ? end("starting", "unknown", started.error, "coordinator-orphan")
        : end("starting", "failed", started.error, "coordinator-not-started");
    }
    const closeWith = async (from: CoordinatorState, error: string, code: string) => {
      const closed = await closeCreatedPane(dispatch.herdr, started.paneId);
      return end(
        from,
        closed ? "failed" : "unknown",
        error + orphanNote(started.paneId, closed),
        code,
      );
    };
    let live;
    try {
      live = await dispatch.pane.getAgent(started.paneId);
    } catch {
      live = undefined;
    }
    if (!live)
      return closeWith(
        "starting",
        `Herdr did not report the agent in pane ${started.paneId}; no prompt was sent.`,
        "agent-missing",
      );
    const identity = identityFromLive(live, started.agentName);
    if (!identity.ok) return closeWith("starting", identity.error, identity.code);
    const complete = compareIdentity(live, identity.identity);
    if (!complete.ok) return closeWith("starting", complete.error, complete.code);
    if (identity.identity.cwd !== canonicalCwd(plan.cwd)) {
      return closeWith(
        "starting",
        `The coordinator runs in ${identity.identity.cwd}, not ${canonicalCwd(plan.cwd)}; no prompt was sent.`,
        "cwd-changed",
      );
    }
    coordinators.bind(record.id, identity.identity);
    if (!coordinators.transition(record.id, "starting", "sending")) {
      const closed = await closeCreatedPane(dispatch.herdr, started.paneId);
      return refused(
        `Coordinator ${record.id} was closed while it started; no prompt was sent.${orphanNote(started.paneId, closed)}`,
        { code: "coordinator-closed", coordinator: coordinators.get(record.id) },
      );
    }
    const sent = await promptOnce(dispatch, started.agentName, prompt);
    if (sent.state === "not-delivered") {
      // Nothing reached the CLI: close the pane HMR created rather than leave it unprompted.
      return closeWith(
        "sending",
        `Coordinator ${record.id} did not take the task (${sent.evidence}); nothing is resent.`,
        "coordinator-not-delivered",
      );
    }
    const state: CoordinatorState =
      sent.state === "working" || sent.state === "blocked"
        ? "prompted"
        : sent.state === "sent"
          ? "sent"
          : "unknown";
    const moved = coordinators.transition(record.id, "sending", state, {
      sendEvidence: sent.evidence,
    });
    const after = coordinators.get(record.id)!;
    const summary = !moved
      ? `Coordinator ${after.id}: the prompt went out once (${sent.evidence}), but the record was already ${after.state}; nothing is resent. Inspect pane ${started.paneId}.`
      : state === "prompted"
        ? `Coordinator ${after.id} (${lane.descriptor}) was given the task once in pane ${started.paneId}; Herdr observed it ${sent.state}. This is the bootstrap only: role assignment shows up as workflows it starts (\`hmr coordinator status ${after.id}\`), and completion only as accepted, delivered work.`
        : state === "sent"
          ? `Coordinator ${after.id} (${lane.descriptor}): the task was submitted once in pane ${started.paneId}, but Herdr has not observed the coordinator start on it (${sent.evidence}). That is not confirmation it read the task; it is never resent. Check the pane or \`hmr coordinator status ${after.id}\`.`
          : `Coordinator ${after.id}: the task may or may not have arrived (${sent.evidence}). It is never resent; inspect pane ${started.paneId}, then \`hmr coordinator close ${after.id} --evidence ...\` once it is stopped.`;
    const ok = moved && (state === "prompted" || state === "sent");
    return {
      output: [summary, input.control].join("\n"),
      json: {
        ok,
        effects: ["herdr-dispatch", "router-state"],
        delivery:
          state === "prompted"
            ? "activity-observed"
            : state === "sent"
              ? "submitted-unobserved"
              : "unknown",
        coordinator: after,
        send: sent,
      },
      code: ok ? 0 : 1,
    };
  } catch (error) {
    // A step threw: keep what is known. Before the prompt, a created pane may still run the
    // CLI; once sending began, the prompt may have gone out. Neither is retried.
    const current = coordinators.get(record.id)!;
    const message = `coordinator start stopped unexpectedly: ${String(error)}`;
    if (current.state === "sending") return end("sending", "unknown", message, "coordinator-error");
    if (current.state === "starting") {
      return end("starting", paneId ? "unknown" : "failed", message, "coordinator-error");
    }
    return refused(message, { code: "coordinator-error", coordinator: current });
  }
}

const BOOTSTRAP: Record<CoordinatorState, string> = {
  starting: "starting (launch in progress)",
  sending: "sending (prompt in progress)",
  sent: "submitted once; Herdr has not observed the coordinator start on it",
  prompted: "given the task once; Herdr observed activity",
  unknown: "unknown: the prompt may or may not have arrived; never resent",
  failed: "failed: no task was delivered",
  closed: "closed",
};

/** Bootstrap, role assignment, and completion, each from its own evidence. */
export function executeCoordinatorStatus(
  coordinators: CoordinatorRepository,
  id: string | undefined,
): CommandResult {
  if (!id) {
    const list = coordinators.list(20);
    return {
      output:
        list.length === 0
          ? "No coordinators yet."
          : list
              .map(
                (entry) => `${entry.id}  ${entry.state}  ${entry.descriptor}  ${entry.createdAt}`,
              )
              .join("\n"),
      json: list,
      code: 0,
    };
  }
  const record = coordinators.get(id);
  if (!record) return refused(`Unknown coordinator ${id}.`);
  const workflows = coordinators.workflowsOf(id);
  const closed = workflows.filter((workflow) => workflow.state === "released");
  const stages = {
    bootstrap: record.state,
    rolesAssigned: workflows,
    completion:
      workflows.length === 0
        ? "none: no workflow was started by this coordinator"
        : `${closed.length} of ${workflows.length} workflow(s) released; HMR does not judge the task itself complete`,
  };
  return {
    output: [
      `Coordinator ${record.id}: ${record.state} (${record.role}, ${record.descriptor})`,
      `Bootstrap: ${BOOTSTRAP[record.state]}${record.sendEvidence ? ` (${record.sendEvidence})` : ""}`,
      ...(record.identity
        ? [`Pane: ${record.identity.paneId} (${record.identity.agentName})`]
        : []),
      `Roles assigned: ${workflows.length === 0 ? "none yet" : workflows.map((workflow) => `${workflow.writerRole} in ${workflow.id} (${workflow.state})`).join(", ")}`,
      `Completion: ${stages.completion}`,
      ...(record.closingEvidence ? [`Note: ${record.closingEvidence}`] : []),
    ].join("\n"),
    json: { ...record, stages },
    code: 0,
  };
}

export interface CloseDeps {
  coordinators: CoordinatorRepository;
  pane: Pick<HerdrPaneClient, "getAgent">;
  /** The caller's own Herdr pane, when it runs in one. */
  callerPane?: string;
  now?: () => number;
}

/**
 * Closes a coordinator's record once its pane is positively seen stopped. It sends nothing,
 * stops nothing, and never closes a launch still in progress or a coordinator whose workflows
 * are still open. The operator's evidence is kept beside what Herdr reported.
 */
export async function executeCoordinatorClose(
  deps: CloseDeps,
  id: string,
  evidence: string | undefined,
): Promise<CommandResult> {
  const { coordinators } = deps;
  const text = evidence?.trim();
  if (!text) return refused("--evidence <text> is required: say what you saw or did in the pane.");
  const worker = deps.callerPane ? coordinators.workerAt(deps.callerPane) : undefined;
  if (worker) {
    return refused(
      `This command runs in pane ${deps.callerPane}, a worker of ${worker}. A worker cannot close a coordinator.`,
      { code: "worker-caller" },
    );
  }
  const record = coordinators.get(id);
  if (!record) return refused(`Unknown coordinator ${id}.`);
  if (record.state === "closed" || record.state === "failed") {
    return refused(`Coordinator ${id} is already ${record.state}; it holds no slot.`, {
      code: "coordinator-final",
    });
  }
  const age = (deps.now ?? Date.now)() - Date.parse(record.updatedAt);
  if (IN_FLIGHT_COORDINATOR_STATES.includes(record.state) && age < IN_FLIGHT_STALE_MS) {
    return refused(
      `Coordinator ${id} is ${record.state}: an \`hmr start\` is still launching it. Nothing was closed; check again with \`hmr coordinator status ${id}\`.`,
      { code: "coordinator-in-flight" },
    );
  }
  const active = coordinators.activeWorkflowsOf(id);
  if (active.length > 0) {
    return refused(
      `Coordinator ${id} still has open workflows: ${active.map((workflow) => `${workflow.id} (${workflow.state})`).join(", ")}. Release or abort them first; nothing was closed.`,
      { code: "coordinator-workflows-open", workflows: active },
    );
  }
  let observed: string;
  if (record.identity) {
    const stopped = await checkStopped(deps.pane, record.identity);
    if (!stopped.ok) {
      return refused(
        `Coordinator ${id} is not confirmed stopped: ${stopped.error} Stop it at its prompt first; nothing was closed.`,
        { code: "coordinator-not-stopped" },
      );
    }
    observed = `Herdr reported ${record.identity.agentName} (session ${record.identity.sessionId}) ${stopped.live.status} in pane ${record.identity.paneId}`;
  } else {
    const pane = record.paneId;
    if (pane) {
      return refused(
        `Coordinator ${id} created pane ${pane} but never bound an identity, so HMR cannot confirm what runs there. Nothing was closed; inspect the pane.`,
        { code: "coordinator-unconfirmed" },
      );
    }
    observed = "no pane was ever created for it";
  }
  if (
    !coordinators.transition(id, record.state, "closed", {
      closingEvidence: `${text} (${observed})`,
    })
  ) {
    return refused(
      `Coordinator ${id} changed while closing; nothing was closed. Check its status.`,
      {
        code: "coordinator-changed",
      },
    );
  }
  return {
    output: `Coordinator ${id} is closed (${observed}); its pane was not touched. A new coordinator may start in this worktree.`,
    json: { ok: true, coordinator: coordinators.get(id) },
    code: 0,
  };
}
