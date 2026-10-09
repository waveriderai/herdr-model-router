import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { redactCollectorText } from "../collectors/normalizer.js";
import {
  closeCreatedPane,
  dispatchPlan,
  orphanNote,
  preflightLaunches,
  readReadiness,
  reviseTask,
  startNativeAgent,
  type DispatchDeps,
  type ResolvedLaunch,
} from "../rules/dispatch.js";
import { HERDR_KIND } from "../rules/native-argv.js";
import type { PlannedLane, RoutePlan } from "../rules/plan.js";
import type { ReadinessKind } from "../rules/readiness.js";
import { worktreeIdentity } from "../rules/rules-source.js";
import {
  DELIVERED_SEND_STATES,
  FINAL_WORKFLOW_STATES,
  UNRESOLVED_SEND_STATES,
  WorkflowStateError,
  WriterAuthorityError,
  type Backend,
  type Intent,
  type OperationLease,
  type SendState,
  type Workflow,
  type WorkflowAttempt,
  type WorkflowRepository,
  type WorkflowState,
} from "../store/workflow-repository.js";
import {
  ROUTE_CONTRACT,
  type AgentCollabPort,
  type CollabCall,
  type CollabStatus,
} from "./agent-collab.js";
import { ArtifactConflictError, type ArtifactStore } from "./artifacts.js";
import {
  BRIEF_VERSION_V2,
  canonicalJson,
  parseResult,
  RESULT_VERSION,
  RESULT_VERSION_V2,
  sameRevision,
  sha256,
  type BriefInput,
  type BriefRecord,
  type ResolvedSkills,
  type Revision,
  type WorkflowResult,
  type WriterResult,
} from "./contracts.js";
import { evaluateSkillEvidence, resolveSkills, skillSourcesChanged } from "./skills.js";
import {
  canonicalCwd,
  checkStopped,
  compareIdentity,
  identityFromLive,
  type BoundIdentity,
} from "./identity.js";
import { isAncestor, readCommitContent, readRevision, type GitRead } from "./revision.js";
import type { CoordinatorRepository } from "../store/coordinator-repository.js";

/** Everything a workflow step may touch. Built only for real (non-preview) commands. */
export interface WorkflowDeps {
  workflows: WorkflowRepository;
  dispatch: DispatchDeps;
  artifacts: ArtifactStore;
  git: GitRead;
  /** The agent-collab CLI, when it resolved on PATH. */
  collab?: AgentCollabPort;
  /** The caller's environment: HERDR_PANE_ID decides whether a worker is calling. */
  callerEnv: NodeJS.Dict<string>;
  /** Plans a role from the rules file in a directory; pure (files only). */
  planRole: (input: {
    role: string;
    cwd: string;
    readOnly: boolean;
    parent?: string;
  }) => { ok: true; plan: RoutePlan } | { ok: false; error: string };
  /** How long one collab dispatch may wait for the writer to start working. */
  collabDispatchTimeoutMs?: number;
  /** Coordinator bootstraps: which panes are workers, and which coordinator started what. */
  coordinators?: CoordinatorRepository;
}

export type Step<T> =
  { ok: true; value: T } | { ok: false; code: string; error: string; evidence?: unknown };

const fail = <T>(code: string, error: string, evidence?: unknown): Step<T> => ({
  ok: false,
  code,
  error,
  ...(evidence === undefined ? {} : { evidence }),
});

/** Turns a refused transition or artifact conflict into a step failure; anything else propagates. */
function caught<T>(error: unknown): Step<T> {
  if (error instanceof WorkflowStateError || error instanceof WriterAuthorityError) {
    return fail(error.code, error.message);
  }
  if (error instanceof ArtifactConflictError) return fail(error.code, error.message);
  throw error;
}

function guardStep<T>(action: () => Step<T>): Step<T> {
  try {
    return action();
  } catch (error) {
    return caught(error);
  }
}

/**
 * Runs one coordinator step while it holds the workflow's operation slot. The slot is taken
 * before any await and released at the end, so two steps on one workflow never interleave;
 * every transition inside commits only while the slot is still held.
 */
async function withOperation<T>(
  deps: WorkflowDeps,
  workflowId: string,
  name: string,
  expectation: Parameters<WorkflowRepository["reserveOperation"]>[2],
  body: (lease: OperationLease, workflow: Workflow) => Promise<Step<T>> | Step<T>,
): Promise<Step<T>> {
  let lease: OperationLease;
  try {
    lease = deps.workflows.reserveOperation(workflowId, name, expectation);
  } catch (error) {
    return caught(error);
  }
  try {
    return await body(lease, deps.workflows.get(workflowId)!);
  } catch (error) {
    return caught(error);
  } finally {
    deps.workflows.releaseOperation(lease);
  }
}

/** The same operation slot for a step with no awaits. */
function withOperationSync<T>(
  deps: WorkflowDeps,
  workflowId: string,
  name: string,
  expectation: Parameters<WorkflowRepository["reserveOperation"]>[2],
  body: (lease: OperationLease, workflow: Workflow) => Step<T>,
): Step<T> {
  let lease: OperationLease;
  try {
    lease = deps.workflows.reserveOperation(workflowId, name, expectation);
  } catch (error) {
    return caught(error);
  }
  try {
    return body(lease, deps.workflows.get(workflowId)!);
  } catch (error) {
    return caught(error);
  } finally {
    deps.workflows.releaseOperation(lease);
  }
}

const OWNER_FILE = "owner-capability";

function revisionNow(deps: WorkflowDeps, cwd: string): Step<{ root: string; revision: Revision }> {
  const read = readRevision(cwd, deps.git);
  return read.ok
    ? { ok: true, value: { root: read.root, revision: read.revision } }
    : fail("revision-unreadable", read.error);
}

/**
 * Coordinator steps refuse a caller running inside the bound writer's pane or a verifier
 * lane's pane. Same-user processes elsewhere are trusted: HMR is not an OS sandbox.
 */
function refuseWorkerCaller(deps: WorkflowDeps, workflow: Workflow): Step<null> {
  const caller = deps.callerEnv.HERDR_PANE_ID;
  if (!caller) return { ok: true, value: null };
  const workerPanes = new Set<string>();
  if (workflow.identity) workerPanes.add(workflow.identity.paneId);
  for (const verification of deps.workflows.verifications(workflow.id)) {
    if (!verification.taskId) continue;
    for (const lane of deps.dispatch.store.lanes(verification.taskId)) {
      if (lane.paneId) workerPanes.add(lane.paneId);
    }
  }
  return workerPanes.has(caller)
    ? fail(
        "worker-caller",
        `This command runs in pane ${caller}, which is a worker of workflow ${workflow.id}. A worker cannot record results, verify, revise, accept, deliver, or release.`,
      )
    : { ok: true, value: null };
}

function loadWorkflow(deps: WorkflowDeps, id: string): Step<Workflow> {
  const workflow = deps.workflows.get(id);
  return workflow
    ? { ok: true, value: workflow }
    : fail("unknown-workflow", `Unknown workflow ${id}.`);
}

function skillSourcesOf(brief: BriefRecord): ResolvedSkills | undefined {
  return brief.version === BRIEF_VERSION_V2 ? brief.skillSources : undefined;
}

/**
 * The shared-skill block of a lane prompt: the catalog entry of every resolved skill (never its
 * body), the references it must read, and the mode requested for this one attempt.
 */
/** The one line that tells an attempt's agents its mode; also how the mode record is checked. */
function modeLine(attemptId: string, modes: readonly string[]): string {
  return modes.length > 0
    ? `Mode requested for attempt ${attemptId} only: ${modes.join(", ")}. Apply it to this attempt; it is not a standing mode for later turns.`
    : `No mode is requested for attempt ${attemptId}.`;
}

function skillLines(
  sources: ResolvedSkills,
  input: { attemptId: string; modes: readonly string[]; lane: "writer" | "verifier" },
): string[] {
  return [
    "",
    "Shared skills (catalog only: read a skill's SKILL.md in full when you use it, and only these files):",
    ...sources.skills.map(
      (skill) =>
        `- ${skill.name}${skill.required ? " [required]" : ""}: ${skill.description} SKILL.md: ${skill.file} (sha256 ${skill.sha256})` +
        skill.references
          .map((ref) => `\n  reference ${ref.path}: ${ref.file} (sha256 ${ref.sha256})`)
          .join(""),
    ),
    ...(sources.unavailable.length > 0
      ? [`Unavailable optional skills: ${sources.unavailable.join(", ")}.`]
      : []),
    modeLine(input.attemptId, input.modes),
    ...(input.lane === "verifier" && input.modes.length > 0
      ? [
          'You stay read-only in this mode: apply its reading, checking and review steps, and do not perform any step that writes (editing, formatting, committing, or anything else that changes the worktree). Name each write-only step you did not perform in that skill\'s "reason". Report the mode applied only if you applied every step a read-only lane can; otherwise report it skipped with the reason.',
        ]
      : []),
    "A skill or mode request grants no authority of its own: it adds nothing beyond this brief's scope, the authorization the user gave for this task, and the project's own policy.",
    "If a required skill, reference, or a tool it needs is unavailable, report that skill as blocked or skipped with the reason; never report a skill you did not use as applied. A required skill you did not use is reported not-used, and the coordinator decides whether that is acceptable.",
    `Report "skills" with one entry per listed skill: name, the sha256 of the SKILL.md you read, read, status (applied | not-used | skipped | blocked), the references you read with their sha256, and evidence${input.lane === "writer" ? " of how you applied it" : ""}.`,
  ];
}

function skillEvidenceTemplate(sources: ResolvedSkills | undefined) {
  return sources
    ? {
        skills: sources.skills.map((skill) => ({
          name: skill.name,
          sha256: "<sha256 of the SKILL.md you read>",
          read: "true | false",
          status: "applied | not-used | skipped | blocked",
          references: skill.references.map((ref) => ({ path: ref.path, sha256: "<sha256>" })),
          evidence: "<what you did with it>",
        })),
      }
    : {};
}

/** The text the writer receives. It carries its own identity so the result can be checked. */
export function writerPrompt(input: {
  brief: BriefRecord;
  attemptId: string;
  purpose: "initial" | "revision";
  delta?: string;
  /** Modes requested for this attempt only. */
  modes?: readonly string[];
}): string {
  const { brief } = input;
  const sources = skillSourcesOf(brief);
  const version = sources ? RESULT_VERSION_V2 : RESULT_VERSION;
  const lines = [
    `HMR workflow ${brief.workflowId}, attempt ${input.attemptId}: you are the only writer for role "${brief.writerRole}" in this worktree.`,
    "",
    input.purpose === "initial"
      ? "Brief (JSON):"
      : "Revision requested by the coordinator. The original brief still applies; the requested changes follow it.",
    canonicalJson(brief),
    ...(input.delta ? ["", "Requested changes:", input.delta] : []),
    ...(sources
      ? skillLines(sources, {
          attemptId: input.attemptId,
          modes: input.modes ?? [],
          lane: "writer",
        })
      : []),
    "",
    "Work only inside the allowed scope. Do not commit, push, accept, release, or start another task, and do not call `hmr workflow` coordinator commands.",
    `When you stop, run \`hmr workflow fingerprint\` in this directory and reply with exactly one JSON object (${version}):`,
    canonicalJson({
      version,
      workflowId: brief.workflowId,
      attemptId: input.attemptId,
      lane: "writer",
      status: "impl-complete | blocked | failed",
      revision: {
        head: "<from hmr workflow fingerprint>",
        content: "<from hmr workflow fingerprint>",
      },
      changedPaths: ["<relative paths>"],
      checks: [{ command: "<command>", result: "pass | fail | not-run" }],
      blockers: [],
      ...skillEvidenceTemplate(sources),
    }),
    "Revisions for this workflow arrive in this same session.",
  ];
  return lines.join("\n");
}

function verifierPrompt(input: {
  brief: BriefRecord;
  workflowId: string;
  attemptId: string;
  laneId: string;
  role: string;
  revision: Revision;
  /** The modes of the attempt under verification; they apply to its verifiers too. */
  modes: readonly string[];
}): string {
  const sources = skillSourcesOf(input.brief);
  const version = sources ? RESULT_VERSION_V2 : RESULT_VERSION;
  return [
    `HMR workflow ${input.workflowId}: read-only verification lane ${input.laneId} for role "${input.role}". Do not modify any file.`,
    `Verify the worktree at revision head ${input.revision.head}, content ${input.revision.content} (check with \`hmr workflow fingerprint\`).`,
    "Brief (JSON):",
    canonicalJson(input.brief),
    ...(sources
      ? skillLines(sources, { attemptId: input.attemptId, modes: input.modes, lane: "verifier" })
      : []),
    `Reply with exactly one JSON object (${version}):`,
    canonicalJson({
      version,
      workflowId: input.workflowId,
      attemptId: input.attemptId,
      lane: "verifier",
      verifierLaneId: input.laneId,
      status: "pass | fail | blocked",
      revision: input.revision,
      changedPaths: [],
      checks: [{ command: "<command>", result: "pass | fail | not-run" }],
      blockers: [],
      ...skillEvidenceTemplate(sources),
    }),
  ].join("\n");
}

/**
 * The modes one attempt was sent with, recorded before its prompt and never changed. The record
 * is trusted only when the attempt's recorded prompt still has the SHA-256 the database holds
 * and states exactly these modes: a missing, unreadable or altered record fails closed instead
 * of reading as "no mode".
 */
function attemptModes(
  deps: Pick<WorkflowDeps, "artifacts" | "workflows">,
  workflowId: string,
  attemptId: string,
): Step<string[]> {
  const broken = (why: string) =>
    fail<string[]>(
      "skill-gate-integrity",
      `The mode record of attempt ${attemptId} cannot be trusted (${why}); the skill gate fails closed.`,
    );
  const attempt = deps.workflows.getAttempt(attemptId);
  if (!attempt || attempt.workflowId !== workflowId) return broken("unknown attempt");
  let modes: unknown;
  let prompt: string;
  try {
    modes = (
      JSON.parse(deps.artifacts.read(workflowId, `modes-${attemptId}.json`)) as {
        modes?: unknown;
      }
    ).modes;
    prompt = deps.artifacts.read(workflowId, `prompt-${attemptId}.txt`);
  } catch {
    return broken("its mode or prompt file is missing or unreadable");
  }
  if (!Array.isArray(modes) || !modes.every((mode) => typeof mode === "string")) {
    return broken("its mode file is malformed");
  }
  if (sha256(prompt) !== attempt.promptSha256) return broken("its prompt file was changed");
  if (!prompt.includes(modeLine(attemptId, modes))) {
    return broken("its mode file does not match the prompt that was sent");
  }
  return { ok: true, value: modes };
}

/** Refuses when a skill source the brief was bound to changed or disappeared since start. */
function skillsUnchanged(brief: BriefRecord): Step<null> {
  const sources = skillSourcesOf(brief);
  const changed = sources ? skillSourcesChanged(sources) : [];
  return changed.length === 0
    ? { ok: true, value: null }
    : fail(
        "skill-changed",
        `Skill sources bound to this workflow changed since it started: ${changed.join(", ")}. Nothing was sent; start a new workflow to use the new sources.`,
      );
}

/** Reads the brief recorded for a workflow, checking it is the brief whose SHA-256 was bound. */
function recordedBrief(deps: WorkflowDeps, workflow: Workflow): Step<BriefRecord> {
  const text = deps.artifacts.read(workflow.id, "brief.json");
  if (sha256(text) !== workflow.briefSha256) {
    return fail(
      "brief-changed",
      `The recorded brief of ${workflow.id} no longer matches its SHA-256; nothing is sent.`,
    );
  }
  return { ok: true, value: JSON.parse(text) as BriefRecord };
}

function ownerCapability(deps: WorkflowDeps, workflow: Workflow): Step<string> {
  try {
    return { ok: true, value: deps.artifacts.read(workflow.id, OWNER_FILE).trim() };
  } catch {
    return fail(
      "capability-missing",
      `The agent-collab owner capability of ${workflow.id} is not on file; recover through agent-collab manually.`,
    );
  }
}

function needCollab(deps: WorkflowDeps): Step<AgentCollabPort> {
  return deps.collab
    ? { ok: true, value: deps.collab }
    : fail(
        "backend-unavailable",
        "This worktree is bound to agent-collab, but `agent-collab` is not on PATH. HMR does not fall back to standalone ownership.",
      );
}

/**
 * Runs one external mutation: a durable intent with what it expects to change first (refused
 * while another is unresolved), then the call, then what was observed. An unknown outcome
 * stays unknown and blocks every other external mutation until `workflow recover` reconciles
 * it from read-only backend status. Nothing is replayed.
 */
async function external<T>(
  deps: WorkflowDeps,
  workflowId: string,
  intent: Parameters<WorkflowRepository["beginIntent"]>[1],
  call: () => Promise<CollabCall<T>>,
  /** What a successful reply showed, recorded on the intent. Never a secret. */
  observe: (value: T) => string = () => "ok",
): Promise<CollabCall<T> & { intentId: string }> {
  const recorded = deps.workflows.beginIntent(workflowId, intent);
  const outcome = await call();
  // Success is only `observed` here: the intent becomes `done` in the same transaction as the
  // local transition (see `applied`), so a crash between the two leaves it for recovery.
  deps.workflows.finishIntent(
    recorded.id,
    outcome.kind === "ok" ? "observed" : outcome.kind === "refused" ? "refused" : "unknown",
    outcome.kind === "ok" ? observe(outcome.value) : redactCollectorText(outcome.error),
  );
  return { ...outcome, intentId: recorded.id };
}

/** Finishes an observed intent; called inside the commit that applies its local transition. */
function applied(deps: WorkflowDeps, intentId: string): void {
  deps.workflows.finishIntent(intentId, "done", "applied locally");
}

function externalFailure<T>(
  operation: string,
  outcome: Exclude<CollabCall<unknown>, { kind: "ok" }>,
): Step<T> {
  return outcome.kind === "refused"
    ? fail("backend-refused", `agent-collab ${operation} refused: ${outcome.error}`)
    : fail(
        "backend-unknown",
        `agent-collab ${operation} did not answer clearly (${outcome.error}). Nothing is retried; run \`workflow recover\` to reconcile it from agent-collab status.`,
      );
}

function sendStateOf(state: string): SendState {
  const known: SendState[] = ["sending", "sent", "working", "blocked", "unknown", "not-delivered"];
  return known.find((candidate) => candidate === state) ?? "unknown";
}

function stateAfterSend(sendState: SendState): WorkflowState {
  return DELIVERED_SEND_STATES.includes(sendState) ? "dispatched" : "unknown";
}

const REOPENED = {
  accepted_attempt_id: null,
  accepted_head: null,
  accepted_content: null,
  acceptance_evidence: null,
} as const;

// ---------------------------------------------------------------------------------------
// bind / start
// ---------------------------------------------------------------------------------------

export function bindWorktree(
  deps: Pick<WorkflowDeps, "workflows">,
  cwd: string,
  backend: Backend,
): Step<{ worktreeId: string; backend: Backend }> {
  const worktreeId = worktreeIdentity(cwd);
  return guardStep(() => {
    deps.workflows.setBinding(worktreeId, backend);
    return { ok: true, value: { worktreeId, backend } };
  });
}

export interface StartInput {
  brief: BriefInput;
  cwd: string;
  /** Resolves `parent`, `auto` and `inherit-parent` lanes; persisted for verify and revise. */
  parent?: string;
  /** Optional caller-chosen workflow id (tests); default a random one. */
  workflowId?: string;
  /** The operator's trusted skill roots, in precedence order (`--skills-root`). */
  skillRoots?: readonly string[];
}

/**
 * Read-only agent-collab preflight, before any pane exists: the capabilities handshake (the
 * `hmr.rules-route/v1` contract and this writer's kind), the CLI's own `verify` and `project`
 * for this worktree, and the project's own model constraint. The rules file decides the writer;
 * agent-collab takes it as a frozen route and never picks a default model. A project pin can
 * only refuse: the rules file is never rewritten and no other model is substituted.
 */
async function collabPreflight(
  collab: AgentCollabPort,
  input: { worktreeId: string; lane: PlannedLane; classification: BriefInput["classification"] },
): Promise<Step<null>> {
  const capabilities = await collab.capabilities();
  if (capabilities.kind !== "ok") {
    return fail(
      "backend-capability",
      `agent-collab capabilities ${capabilities.kind}: ${capabilities.error}. This agent-collab cannot take a ${ROUTE_CONTRACT} writer route; nothing was started.`,
    );
  }
  const kind = HERDR_KIND[input.lane.provider];
  const kinds = capabilities.value.writer_kinds["rules-route"] ?? [];
  if (!capabilities.value.route_contracts.includes(ROUTE_CONTRACT) || !kinds.includes(kind)) {
    return fail(
      "backend-capability",
      `agent-collab does not offer ${ROUTE_CONTRACT} for a ${kind} writer (it offers ${capabilities.value.route_contracts.join(", ") || "no route contract"}; kinds ${kinds.join(", ") || "none"}). Nothing was started.`,
    );
  }
  const verified = await collab.verify({ worktree: input.worktreeId });
  if (verified.kind !== "ok") {
    return fail("backend-preflight", `agent-collab verify ${verified.kind}: ${verified.error}`);
  }
  const project = await collab.project({ worktree: input.worktreeId });
  if (project.kind !== "ok") {
    return fail("backend-preflight", `agent-collab project ${project.kind}: ${project.error}`);
  }
  if (canonicalCwd(project.value.worktree) !== input.worktreeId) {
    return fail(
      "backend-identity",
      `agent-collab resolves this worktree to ${project.value.worktree}, not ${input.worktreeId}; the two authorities would not agree on one lock.`,
    );
  }
  const policy = project.value.model_policy;
  // Without a project constraint the rules file's exact route is the result.
  if (policy.source === "defaults") return { ok: true, value: null };
  const smallFix = input.classification === "bounded-small-fix";
  const required = smallFix ? policy.bounded_small_fix : policy.default;
  if (input.lane.provider !== "claude" || input.lane.model !== required) {
    return fail(
      "backend-model-policy",
      `The rules file routes the writer to ${input.lane.descriptor}, but this project's ${policy.source} constraint in agent-collab allows only claude ${required} for ${smallFix ? "an explicitly classified bounded small fix" : "implementation"}. Nothing was started; the rules file is not rewritten and no other model is used.`,
      { policy },
    );
  }
  return { ok: true, value: null };
}

/**
 * SHA-256 of the rules file and project policy the writer route came from: the digests of the
 * exact text the plan was parsed from. Both files are read once more before anything starts;
 * if either changed since planning, the route no longer describes the file, so nothing starts.
 */
export function routeSources(plan: RoutePlan): Step<{ rules: string; policy: string | null }> {
  const planned = { rules: plan.rulesSource.sha256, policy: plan.policySha256 ?? null };
  if (!planned.rules || (plan.policySource && !planned.policy)) {
    return fail(
      "rules-unreadable",
      "The plan carries no digest of its rules source; nothing was started.",
    );
  }
  let now: { rules: string; policy: string | null };
  try {
    now = {
      rules: sha256(readFileSync(plan.rulesSource.path, "utf8")),
      policy: plan.policySource ? sha256(readFileSync(plan.policySource, "utf8")) : null,
    };
  } catch (error) {
    return fail(
      "rules-unreadable",
      `The rules file or project policy behind this route could not be read again (${(error as Error).message}); nothing was started.`,
    );
  }
  if (now.rules !== planned.rules || now.policy !== planned.policy) {
    return fail(
      "rules-changed",
      `${now.rules !== planned.rules ? plan.rulesSource.path : plan.policySource} changed after the route was planned; nothing was started. Run the command again to plan from the current file.`,
    );
  }
  return { ok: true, value: { rules: planned.rules, policy: planned.policy } };
}

/** The frozen route agent-collab receives. HMR planned it; agent-collab only validates it. */
export function rulesRoute(input: {
  lane: PlannedLane;
  role: string;
  classification: BriefInput["classification"];
  worktreeId: string;
  cwd: string;
  sources: { rules: string; policy: string | null };
  workflowId: string;
  briefSha256: string;
}): Record<string, string | null> {
  return {
    version: ROUTE_CONTRACT,
    provider: input.lane.provider,
    kind: HERDR_KIND[input.lane.provider],
    model: input.lane.model,
    effort: input.lane.effort,
    descriptor: input.lane.descriptor,
    role: input.role,
    classification: input.classification,
    worktree: input.worktreeId,
    cwd: input.cwd,
    rules_sha256: input.sources.rules,
    policy_sha256: input.sources.policy,
    workflow_id: input.workflowId,
    brief_sha256: input.briefSha256,
  };
}

/**
 * Starts a workflow: plans the writer role, runs the backend preflight, records the brief,
 * then hands the one writer to the worktree's bound authority. Standalone takes SQLite
 * ownership before any pane exists; agent-collab starts the native CLI without a task, binds
 * its session, acquires, and then lets agent-collab submit the single prompt.
 */
export async function startWorkflow(
  deps: WorkflowDeps,
  input: StartInput,
): Promise<Step<{ workflow: Workflow; attempt: WorkflowAttempt }>> {
  const caller = deps.callerEnv.HERDR_PANE_ID;
  const worker = caller ? deps.coordinators?.workerAt(caller) : undefined;
  if (worker) {
    return fail(
      "worker-caller",
      `This command runs in pane ${caller}, a worker of ${worker}. A worker cannot start a workflow.`,
    );
  }
  const parent = input.parent ? { parent: input.parent } : {};
  const planned = deps.planRole({
    role: input.brief.writerRole,
    cwd: input.cwd,
    readOnly: false,
    ...parent,
  });
  if (!planned.ok) return fail("plan-refused", planned.error);
  const plan = planned.plan;
  if (plan.access !== "write" || plan.lanes.length !== 1) {
    return fail(
      "writer-role",
      `Role "${plan.role}" is not a single-lane writer role; a workflow needs exactly one writer.`,
    );
  }
  for (const role of input.brief.verifierRoles) {
    const verifier = deps.planRole({ role, cwd: input.cwd, readOnly: true, ...parent });
    if (!verifier.ok) return fail("plan-refused", `verifier role ${role}: ${verifier.error}`);
  }
  let skillSources: ResolvedSkills | undefined;
  if (input.brief.version === BRIEF_VERSION_V2) {
    const resolved = resolveSkills(input.skillRoots ?? [], input.brief.skills);
    if (!resolved.ok) return fail(resolved.code, resolved.error);
    skillSources = resolved.value;
  }
  const worktreeId = worktreeIdentity(input.cwd);
  const backend = deps.workflows.binding(worktreeId).backend;
  let collab: AgentCollabPort | undefined;
  let sources: { rules: string; policy: string | null } | undefined;
  if (backend === "agent-collab") {
    const resolved = needCollab(deps);
    if (!resolved.ok) return resolved;
    collab = resolved.value;
    const checked = await collabPreflight(collab, {
      worktreeId,
      lane: plan.lanes[0]!,
      classification: input.brief.classification,
    });
    if (!checked.ok) return checked;
    const read = routeSources(plan);
    if (!read.ok) return read;
    sources = read.value;
  }
  const baseline = revisionNow(deps, input.cwd);
  if (!baseline.ok) return baseline;
  const preflight = await preflightLaunches(plan, deps.dispatch);
  if (!preflight.ok) return fail(preflight.code, preflight.error);

  const workflowId = input.workflowId ?? `wf_${randomUUID()}`;
  const attemptId = `wfa_${randomUUID()}`;
  const recordFields = {
    workflowId,
    baseline: baseline.value.revision,
    writerDescriptor: plan.lanes[0]!.descriptor,
    ...parent,
  };
  const brief: BriefRecord =
    input.brief.version === BRIEF_VERSION_V2
      ? { ...input.brief, ...recordFields, skillSources: skillSources! }
      : { ...input.brief, ...recordFields };
  const briefText = canonicalJson(brief);
  const modes = input.brief.version === BRIEF_VERSION_V2 ? input.brief.skills.modes : [];
  const prompt = writerPrompt({ brief, attemptId, purpose: "initial", modes });
  let opened: ReturnType<WorkflowRepository["createWorkflow"]>;
  try {
    opened = deps.workflows.createWorkflow({
      id: workflowId,
      attemptId,
      worktreeId,
      backend,
      briefSha256: sha256(briefText),
      writerRole: plan.role,
      writerDescriptor: plan.lanes[0]!.descriptor,
      ...(input.parent ? { parentDescriptor: input.parent } : {}),
      cwd: canonicalCwd(input.cwd),
      baseline: baseline.value.revision,
      promptSha256: sha256(prompt),
    });
  } catch (error) {
    return caught(error);
  }
  const { lease } = opened;
  // A workflow started from an open coordinator's pane is that coordinator's role assignment.
  const coordinator = caller ? deps.coordinators?.openAtPane(caller) : undefined;
  if (coordinator && coordinator.worktreeId === worktreeId) {
    deps.coordinators!.link(coordinator.id, workflowId);
  }
  try {
    deps.artifacts.write(workflowId, "brief.json", briefText);
    deps.artifacts.write(workflowId, `modes-${attemptId}.json`, canonicalJson({ modes }));
    deps.artifacts.write(workflowId, `prompt-${attemptId}.txt`, prompt);
    return collab && sources
      ? await startCollab(
          deps,
          lease,
          opened.workflow,
          opened.attempt,
          plan,
          prompt,
          collab,
          preflight.launches[0]!,
          rulesRoute({
            lane: plan.lanes[0]!,
            role: plan.role,
            classification: input.brief.classification,
            worktreeId,
            cwd: opened.workflow.cwd,
            sources,
            workflowId,
            briefSha256: opened.workflow.briefSha256,
          }),
        )
      : await startStandalone(deps, lease, opened.workflow, opened.attempt, plan, prompt);
  } catch (error) {
    return caught(error);
  } finally {
    deps.workflows.releaseOperation(lease);
  }
}

async function startStandalone(
  deps: WorkflowDeps,
  lease: OperationLease,
  workflow: Workflow,
  attempt: WorkflowAttempt,
  plan: RoutePlan,
  prompt: string,
): Promise<Step<{ workflow: Workflow; attempt: WorkflowAttempt }>> {
  const result = await dispatchPlan({
    plan,
    prompt,
    worktreeId: workflow.worktreeId,
    deps: deps.dispatch,
    workflowId: workflow.id,
    laneText: () => prompt,
    onTaskCreated: (task) =>
      deps.workflows.commit(lease, () =>
        deps.workflows.setFields(workflow.id, { task_id: task.id }),
      ),
    beforeSend: async ({ identity }) => {
      if (!identity) {
        return { ok: false, error: "the writer's identity was not bound; no prompt was sent" };
      }
      if (identity.cwd !== workflow.cwd) {
        return {
          ok: false,
          error: `The writer runs in ${identity.cwd}, not ${workflow.cwd}; no prompt was sent.`,
        };
      }
      deps.workflows.commit(lease, () => deps.workflows.bindIdentity(workflow.id, identity));
      return { ok: true };
    },
    // The dispatch attempt is linked before the prompt goes out, so a crash mid-send stays
    // recoverable from the workflow.
    onAttemptBegun: (_lane, begun) =>
      deps.workflows.commit(lease, () =>
        deps.workflows.updateAttempt(attempt.id, {
          backendAttempt: begun.id,
          sendState: "sending",
        }),
      ),
  });
  if (!result.ok) {
    deps.workflows.commit(lease, () => {
      deps.workflows.setState(workflow.id, "failed", { closing_evidence: result.error });
      deps.workflows.updateAttempt(attempt.id, {
        sendState: "not-delivered",
        sendEvidence: result.error,
      });
    });
    return fail(result.code, result.error);
  }
  const lane = result.lanes[0]!;
  if (!lane.attempt) {
    const error = lane.error ?? "the writer did not start; no prompt was sent";
    // An unconfirmed pane close may leave a CLI running: keep the worktree held and inspectable.
    const orphan = lane.paneId !== undefined;
    deps.workflows.commit(lease, () => {
      deps.workflows.setState(workflow.id, orphan ? "unknown" : "failed", {
        closing_evidence: error,
      });
      deps.workflows.updateAttempt(attempt.id, { sendState: "not-delivered", sendEvidence: error });
    });
    return orphan
      ? fail("writer-orphan", error, { paneId: lane.paneId, worktreeHeld: true })
      : fail("writer-not-started", error, {
          promptSent: false,
          paneClosed: true,
          ownershipReleased: true,
        });
  }
  const sendState = sendStateOf(lane.attempt.state);
  const sent = lane.attempt;
  deps.workflows.commit(lease, () => {
    deps.workflows.updateAttempt(attempt.id, {
      sendState,
      backendAttempt: sent.id,
      ...(sent.evidence ? { sendEvidence: sent.evidence } : {}),
    });
    deps.workflows.setState(workflow.id, stateAfterSend(sendState));
  });
  return {
    ok: true,
    value: {
      workflow: deps.workflows.get(workflow.id)!,
      attempt: deps.workflows.getAttempt(attempt.id)!,
    },
  };
}

async function startCollab(
  deps: WorkflowDeps,
  lease: OperationLease,
  workflow: Workflow,
  attempt: WorkflowAttempt,
  plan: RoutePlan,
  prompt: string,
  collab: AgentCollabPort,
  launch: ResolvedLaunch,
  route: Record<string, string | null>,
): Promise<Step<{ workflow: Workflow; attempt: WorkflowAttempt }>> {
  type Started = { workflow: Workflow; attempt: WorkflowAttempt };
  /** Ends the start: final `failed` only when no pane can still run, else held as `unknown`. */
  const endStart = (
    code: string,
    error: string,
    pane: { id: string; closed: boolean } | undefined,
  ): Step<Started> => {
    const held = pane !== undefined && !pane.closed;
    deps.workflows.commit(lease, () => {
      if (pane) {
        deps.workflows.setFields(workflow.id, { start_pane_closed: pane.closed ? "1" : "0" });
      }
      deps.workflows.updateAttempt(attempt.id, { sendState: "not-delivered", sendEvidence: error });
      deps.workflows.setState(workflow.id, held ? "unknown" : "failed", {
        closing_evidence: redactCollectorText(error),
      });
    });
    return fail(held ? "writer-orphan" : code, error, { promptSent: false, pane: pane ?? null });
  };
  const started = await startNativeAgent({
    deps: deps.dispatch,
    laneId: workflow.id,
    cwd: plan.cwd,
    launch,
    onPaneCreated: (paneId) =>
      deps.workflows.commit(lease, () =>
        deps.workflows.setFields(workflow.id, { start_pane_id: paneId }),
      ),
  });
  if (!started.ok) return endStart("writer-not-started", started.error, started.pane);
  const closeAndEnd = async (code: string, error: string) => {
    const closed = await closeCreatedPane(deps.dispatch.herdr, started.paneId);
    return endStart(code, error + orphanNote(started.paneId, closed), {
      id: started.paneId,
      closed,
    });
  };
  let live;
  try {
    live = await deps.dispatch.pane.getAgent(started.paneId);
  } catch {
    live = undefined;
  }
  if (!live) {
    return closeAndEnd(
      "agent-missing",
      `Herdr did not report the agent in pane ${started.paneId}; nothing was acquired.`,
    );
  }
  const identity = identityFromLive(live, started.agentName);
  if (!identity.ok) return closeAndEnd(identity.code, identity.error);
  const complete = compareIdentity(live, identity.identity);
  if (!complete.ok) return closeAndEnd(complete.code, complete.error);
  if (identity.identity.cwd !== workflow.cwd) {
    return closeAndEnd(
      "cwd-changed",
      `The writer runs in ${identity.identity.cwd}, not ${workflow.cwd}.`,
    );
  }
  if (identity.identity.kind !== route.kind) {
    return closeAndEnd(
      "kind-changed",
      `Pane ${started.paneId} runs ${identity.identity.kind}, not the routed ${route.kind}.`,
    );
  }
  deps.workflows.commit(lease, () => deps.workflows.bindIdentity(workflow.id, identity.identity));
  const briefFile = deps.artifacts.path(workflow.id, "brief.json");
  const routeText = canonicalJson(route);
  const routeFile = deps.artifacts.write(workflow.id, "route.json", routeText);
  const acquired = await external(
    deps,
    workflow.id,
    {
      operation: "acquire",
      attemptId: attempt.id,
      payload: {
        pane: started.paneId,
        agent: started.agentName,
        session: identity.identity.sessionId,
        route: sha256(routeText),
      },
    },
    () =>
      collab.acquire({
        worktree: workflow.worktreeId,
        agent: started.agentName,
        kind: identity.identity.kind,
        pane: started.paneId,
        session: identity.identity.sessionId,
        coordinator: `hmr:${workflow.id}`,
        briefFile,
        routeFile,
      }),
    // The run and attempt, never the owner capability, so recovery can find the run.
    (value) => JSON.stringify({ runId: value.runId, attempt: value.attempt }),
  );
  if (acquired.kind === "refused") {
    return closeAndEnd("backend-refused", `agent-collab refused the acquire: ${acquired.error}`);
  }
  if (acquired.kind === "unknown") {
    // The lock may be held by a run whose capability HMR never saw. Leave the pane; never re-acquire.
    const error = `${acquired.error}. agent-collab may hold the worktree for a run HMR cannot address. Recover manually with \`agent-collab recover --worktree ${workflow.worktreeId}\`; HMR will not acquire again.`;
    deps.workflows.commit(lease, () =>
      deps.workflows.setState(workflow.id, "unknown", { closing_evidence: error }),
    );
    return fail("acquire-unknown", error);
  }
  try {
    deps.artifacts.write(workflow.id, OWNER_FILE, `${acquired.value.ownerToken}\n`);
  } catch (error) {
    const message = `agent-collab run ${acquired.value.runId} was acquired, but its owner capability could not be saved (${(error as Error).message}). Manual recovery through agent-collab is required.`;
    deps.workflows.commit(lease, () => {
      deps.workflows.setState(workflow.id, "unknown", {
        external_run_id: acquired.value.runId,
        closing_evidence: message,
      });
      // Without the capability nothing can be reconciled: manual recovery only.
      deps.workflows.finishIntent(acquired.intentId, "unknown", "owner capability not saved");
    });
    return fail("capability-unsaved", message);
  }
  deps.workflows.commit(lease, () => {
    deps.workflows.setFields(workflow.id, { external_run_id: acquired.value.runId });
    deps.workflows.updateAttempt(attempt.id, { backendAttempt: acquired.value.attempt });
    applied(deps, acquired.intentId);
  });
  return dispatchCollab(
    deps,
    lease,
    workflow.id,
    attempt.id,
    prompt,
    collab,
    acquired.value.ownerToken,
  );
}

/** One guarded `agent-collab dispatch` for an attempt. HMR itself sends nothing. */
async function dispatchCollab(
  deps: WorkflowDeps,
  lease: OperationLease,
  workflowId: string,
  attemptId: string,
  prompt: string,
  collab: AgentCollabPort,
  owner: string,
): Promise<Step<{ workflow: Workflow; attempt: WorkflowAttempt }>> {
  const workflow = deps.workflows.get(workflowId)!;
  const attempt = deps.workflows.getAttempt(attemptId)!;
  const ready = await guardWriterReady(deps, workflow.identity!);
  if (!ready.ok) {
    // Nothing was sent: the attempt stays pending and can be resumed once the writer is ready.
    deps.workflows.commit(lease, () =>
      deps.workflows.updateAttempt(attempt.id, { sendEvidence: ready.error }),
    );
    return ready;
  }
  const promptName = `prompt-${attempt.id}.txt`;
  const promptFile = deps.artifacts.write(workflowId, promptName, prompt);
  deps.workflows.commit(lease, () =>
    deps.workflows.updateAttempt(attempt.id, { sendState: "sending" }),
  );
  const sent = await external(
    deps,
    workflowId,
    {
      operation: "dispatch",
      attemptId: attempt.id,
      backendAttempt: attempt.backendAttempt!,
      payload: { prompt: promptName },
    },
    () =>
      collab.dispatch({
        runId: workflow.externalRunId!,
        owner,
        attempt: attempt.backendAttempt!,
        promptFile,
        timeoutMs: deps.collabDispatchTimeoutMs ?? 120_000,
      }),
  );
  const sendState: SendState =
    sent.kind === "ok" && sent.value.submitted
      ? "sent"
      : sent.kind === "refused"
        ? "not-delivered"
        : "unknown";
  const evidence =
    sent.kind === "ok"
      ? `agent-collab dispatch outcome ${sent.value.outcome}`
      : redactCollectorText(sent.error);
  deps.workflows.commit(lease, () => {
    deps.workflows.updateAttempt(attempt.id, { sendState, sendEvidence: evidence });
    deps.workflows.setState(workflowId, stateAfterSend(sendState));
    if (sent.kind === "ok") {
      if (sent.value.submitted) applied(deps, sent.intentId);
      else deps.workflows.finishIntent(sent.intentId, "unknown", evidence);
    }
  });
  return {
    ok: true,
    value: {
      workflow: deps.workflows.get(workflowId)!,
      attempt: deps.workflows.getAttempt(attempt.id)!,
    },
  };
}

/** The writer must be the bound session, idle at its ordinary prompt, with no dialog showing. */
async function guardWriterReady(deps: WorkflowDeps, identity: BoundIdentity): Promise<Step<null>> {
  const stopped = await checkStopped(deps.dispatch.pane, identity);
  if (!stopped.ok) return fail(stopped.code, `${stopped.error} Nothing was sent.`);
  const screen = await readReadiness(
    deps.dispatch,
    identity.paneId,
    identity.kind as ReadinessKind,
  );
  if (screen.state !== "ready") return fail("not-ready", `${screen.reason}. Nothing was sent.`);
  return { ok: true, value: null };
}

// ---------------------------------------------------------------------------------------
// result / verify
// ---------------------------------------------------------------------------------------

export interface ResultInput {
  workflowId: string;
  expectedAttemptId: string;
  text: string;
  /** Required for a verifier lane's result. */
  laneId?: string;
}

/**
 * Records one lane's explicit result for the current attempt. An idle pane is never a result;
 * a stale attempt, wrong identity, or a revision that is not the worktree's current one is refused.
 */
export async function recordResult(
  deps: WorkflowDeps,
  input: ResultInput,
): Promise<Step<{ workflow: Workflow; result: WorkflowResult }>> {
  const loaded = loadWorkflow(deps, input.workflowId);
  if (!loaded.ok) return loaded;
  const caller = refuseWorkerCaller(deps, loaded.value);
  if (!caller.ok) return caller;
  const parsed = parseResult(input.text);
  if (!parsed.ok) return fail("invalid-result", parsed.error);
  const result = parsed.value;
  if (result.workflowId !== loaded.value.id) {
    return fail(
      "wrong-workflow",
      `The result names workflow ${result.workflowId}, not ${loaded.value.id}.`,
    );
  }
  if (result.attemptId !== input.expectedAttemptId) {
    return fail(
      "wrong-attempt",
      `The result names attempt ${result.attemptId}, but --attempt is ${input.expectedAttemptId}.`,
    );
  }
  if (result.lane === "verifier" && (!input.laneId || input.laneId !== result.verifierLaneId)) {
    return fail("wrong-lane", `A verifier result needs --lane ${result.verifierLaneId}.`);
  }
  const states: WorkflowState[] =
    result.lane === "writer" ? ["dispatched"] : ["verifying", "reviewed"];
  return withOperation(
    deps,
    input.workflowId,
    "result",
    { from: states, expectedAttemptId: input.expectedAttemptId },
    async (lease, workflow) => {
      const now = revisionNow(deps, workflow.cwd);
      if (!now.ok) return now;
      if (!sameRevision(result.revision, now.value.revision)) {
        return fail(
          "stale-revision",
          "The result's revision is not the worktree's current revision; the work changed after it was reported, or the report is old.",
          { reported: result.revision, current: now.value.revision },
        );
      }
      return result.lane === "writer"
        ? recordWriterResult(deps, lease, workflow, input.expectedAttemptId, result, input.text)
        : recordVerifierResult(deps, lease, workflow, input.expectedAttemptId, result, input.text);
    },
  );
}

function applyWriterResult(
  deps: WorkflowDeps,
  workflowId: string,
  attemptId: string,
  result: WriterResult,
  text: string,
): void {
  deps.workflows.recordResult(attemptId, {
    sha256: sha256(text),
    status: result.status,
    revision: result.revision,
  });
  deps.workflows.setState(workflowId, "receipt");
}

async function recordWriterResult(
  deps: WorkflowDeps,
  lease: OperationLease,
  workflow: Workflow,
  attemptId: string,
  result: WriterResult,
  text: string,
): Promise<Step<{ workflow: Workflow; result: WorkflowResult }>> {
  const attempt = deps.workflows.getAttempt(attemptId)!;
  if (!DELIVERED_SEND_STATES.includes(attempt.sendState)) {
    return fail(
      "attempt-unresolved",
      `Attempt ${attemptId} is ${attempt.sendState}; a result is recorded only for a delivered attempt. Recover the attempt first.`,
    );
  }
  if (attempt.result) return fail("result-exists", `Attempt ${attemptId} already has a result.`);
  const name = `result-${attemptId}.json`;
  deps.artifacts.write(workflow.id, name, text);
  let intentId: string | undefined;
  if (workflow.backend === "agent-collab") {
    const collab = needCollab(deps);
    if (!collab.ok) return collab;
    const owner = ownerCapability(deps, workflow);
    if (!owner.ok) return owner;
    const status = result.status === "failed" ? "error" : result.status;
    const backendAttempt = attempt.backendAttempt!;
    const receipt = await external(
      deps,
      workflow.id,
      { operation: "receipt", attemptId, backendAttempt, payload: { status, result: name } },
      () =>
        collab.value.receipt({
          runId: workflow.externalRunId!,
          owner: owner.value,
          attempt: backendAttempt,
          status,
          noteFile: deps.artifacts.path(workflow.id, name),
        }),
    );
    if (receipt.kind !== "ok") return externalFailure("receipt", receipt);
    intentId = receipt.intentId;
  }
  deps.workflows.commit(lease, () => {
    applyWriterResult(deps, workflow.id, attemptId, result, text);
    if (intentId) applied(deps, intentId);
  });
  return { ok: true, value: { workflow: deps.workflows.get(workflow.id)!, result } };
}

function verificationLanes(
  deps: Pick<WorkflowDeps, "workflows" | "dispatch">,
  workflow: Workflow,
  attemptId: string,
) {
  const latestByRole = new Map<string, ReturnType<WorkflowRepository["verifications"]>[number]>();
  for (const verification of deps.workflows.verifications(workflow.id, attemptId)) {
    latestByRole.set(verification.role, verification);
  }
  return [...latestByRole.values()].map((verification) => {
    const results = new Map(
      deps.workflows.verifierResults(verification.id).map((row) => [row.laneId, row]),
    );
    const lanes = verification.taskId ? deps.dispatch.store.lanes(verification.taskId) : [];
    return {
      verification,
      lanes: lanes.map((lane) => ({
        laneId: lane.id,
        index: lane.index,
        descriptor: lane.descriptor,
        state: lane.state,
        ...(lane.error ? { error: lane.error } : {}),
        result: results.get(lane.id)?.status ?? null,
      })),
    };
  });
}

function recordVerifierResult(
  deps: WorkflowDeps,
  lease: OperationLease,
  workflow: Workflow,
  attemptId: string,
  result: Extract<WorkflowResult, { lane: "verifier" }>,
  text: string,
): Step<{ workflow: Workflow; result: WorkflowResult }> {
  const rounds = verificationLanes(deps, workflow, attemptId);
  const round = rounds.find((entry) =>
    entry.lanes.some((lane) => lane.laneId === result.verifierLaneId),
  );
  if (!round) {
    return fail(
      "wrong-lane",
      `Lane ${result.verifierLaneId} is not a current verification lane of ${workflow.id}.`,
    );
  }
  if (!sameRevision(round.verification.revision, result.revision)) {
    return fail(
      "stale-revision",
      "The verifier reported a revision other than the one it was asked to verify.",
    );
  }
  if (round.lanes.find((lane) => lane.laneId === result.verifierLaneId)!.result) {
    return fail("result-exists", `Lane ${result.verifierLaneId} already has a result.`);
  }
  deps.artifacts.write(workflow.id, `verifier-${result.verifierLaneId}.json`, text);
  deps.workflows.commit(lease, () => {
    deps.workflows.recordVerifierResult({
      verificationId: round.verification.id,
      laneId: result.verifierLaneId,
      resultSha256: sha256(text),
      status: result.status,
    });
    const complete = verificationLanes(deps, workflow, attemptId).every(
      (entry) => entry.lanes.length > 0 && entry.lanes.every((lane) => lane.result !== null),
    );
    deps.workflows.setState(workflow.id, complete ? "reviewed" : "verifying");
  });
  return { ok: true, value: { workflow: deps.workflows.get(workflow.id)!, result } };
}

/**
 * Starts every verifier role's read-only lanes on the current revision. The writer must be
 * confirmed stopped first (full identity, idle or done) and the worktree must still be at the
 * revision the writer reported.
 */
export async function verifyWorkflow(
  deps: WorkflowDeps,
  input: { workflowId: string; expectedAttemptId: string },
): Promise<Step<{ workflow: Workflow; lanes: ReturnType<typeof verificationLanes> }>> {
  const loaded = loadWorkflow(deps, input.workflowId);
  if (!loaded.ok) return loaded;
  const caller = refuseWorkerCaller(deps, loaded.value);
  if (!caller.ok) return caller;
  return withOperation(
    deps,
    input.workflowId,
    "verify",
    { from: ["receipt", "reviewed", "verifying"], expectedAttemptId: input.expectedAttemptId },
    async (lease, workflow) => {
      const gate = await writerStoppedAtResult(deps, workflow, input.expectedAttemptId);
      if (!gate.ok) return gate;
      const brief = recordedBrief(deps, workflow);
      if (!brief.ok) return brief;
      const unchanged = skillsUnchanged(brief.value);
      if (!unchanged.ok) return unchanged;
      // The attempt's mode reaches its verifiers too; an untrusted mode record sends nothing.
      let modes: string[] = [];
      if (skillSourcesOf(brief.value)) {
        const recorded = attemptModes(deps, workflow.id, input.expectedAttemptId);
        if (!recorded.ok) return recorded;
        modes = recorded.value;
      }
      const revision = gate.value.revision;
      // Set first: a role whose lanes fail to start still leaves the workflow verifying.
      deps.workflows.commit(lease, () => deps.workflows.setState(workflow.id, "verifying"));
      for (const role of brief.value.verifierRoles) {
        const planned = deps.planRole({
          role,
          cwd: workflow.cwd,
          readOnly: true,
          ...(workflow.parentDescriptor ? { parent: workflow.parentDescriptor } : {}),
        });
        if (!planned.ok) return fail("plan-refused", `verifier role ${role}: ${planned.error}`);
        if (planned.plan.access !== "read") {
          return fail("verifier-writes", `Verifier role ${role} is not read-only.`);
        }
        const verification = deps.workflows.addVerification({
          workflowId: workflow.id,
          attemptId: input.expectedAttemptId,
          role,
          revision,
        });
        const dispatched = await dispatchPlan({
          plan: planned.plan,
          prompt: "",
          worktreeId: workflow.worktreeId,
          deps: deps.dispatch,
          onTaskCreated: (task) => deps.workflows.linkVerificationTask(verification.id, task.id),
          laneText: (lane, task) => {
            const laneId = deps.dispatch.store
              .lanes(task.id)
              .find((entry) => entry.index === lane.index)!.id;
            return verifierPrompt({
              brief: brief.value,
              workflowId: workflow.id,
              attemptId: input.expectedAttemptId,
              laneId,
              role,
              revision,
              modes,
            });
          },
        });
        if (!dispatched.ok) {
          return fail(dispatched.code, `verifier role ${role}: ${dispatched.error}`);
        }
      }
      return {
        ok: true,
        value: {
          workflow: deps.workflows.get(workflow.id)!,
          lanes: verificationLanes(deps, workflow, input.expectedAttemptId),
        },
      };
    },
  );
}

/**
 * The gate shared by verify, accept and release: the expected attempt is current and has an
 * explicit result, the writer is positively stopped with its full identity, and the worktree
 * is still exactly at the reported revision.
 */
async function writerStoppedAtResult(
  deps: WorkflowDeps,
  workflow: Workflow,
  expectedAttemptId: string,
): Promise<Step<{ attempt: WorkflowAttempt; revision: Revision }>> {
  const attempt = deps.workflows.currentAttempt(workflow.id);
  if (!attempt || attempt.id !== expectedAttemptId) {
    return fail(
      "stale-attempt",
      `Attempt ${expectedAttemptId} is not the current attempt of ${workflow.id}${attempt ? ` (current: ${attempt.id})` : ""}.`,
    );
  }
  if (!attempt.result) {
    return fail(
      "no-result",
      `Attempt ${attempt.id} has no recorded result; an idle writer is not a result.`,
    );
  }
  if (!workflow.identity) {
    return fail("identity-missing", `Workflow ${workflow.id} has no bound writer identity.`);
  }
  const stopped = await checkStopped(deps.dispatch.pane, workflow.identity);
  if (!stopped.ok) return fail(stopped.code, stopped.error);
  const now = revisionNow(deps, workflow.cwd);
  if (!now.ok) return now;
  if (!sameRevision(now.value.revision, attempt.result.revision)) {
    return fail(
      "revision-changed",
      "The worktree changed after the writer's result; verify and acceptance need the reported revision.",
      { reported: attempt.result.revision, current: now.value.revision },
    );
  }
  return { ok: true, value: { attempt, revision: now.value.revision } };
}

// ---------------------------------------------------------------------------------------
// revise
// ---------------------------------------------------------------------------------------

/**
 * Sends one revision to the same writer session as a new attempt. Never after an unresolved
 * send: an unknown attempt is recovered or aborted, not bypassed with a revision. With
 * `resume`, sends the current attempt's recorded prompt while it is still pending: no part of
 * it was ever submitted (a refusal or crash before submission), so this is its first send.
 */
export async function reviseWorkflow(
  deps: WorkflowDeps,
  input: {
    workflowId: string;
    expectedAttemptId: string;
    delta?: string;
    resume?: boolean;
    /** Modes requested for this revision only; none unless asked again. */
    modes?: readonly string[];
  },
): Promise<Step<{ workflow: Workflow; attempt: WorkflowAttempt }>> {
  const loaded = loadWorkflow(deps, input.workflowId);
  if (!loaded.ok) return loaded;
  const caller = refuseWorkerCaller(deps, loaded.value);
  if (!caller.ok) return caller;
  if (input.resume) return resumeRevision(deps, input.workflowId, input.expectedAttemptId);
  const delta = input.delta;
  if (!delta) return fail("delta-missing", "A revision needs the requested changes.");
  return withOperation(
    deps,
    input.workflowId,
    "revise",
    { from: ["receipt", "reviewed", "accepted"], expectedAttemptId: input.expectedAttemptId },
    async (lease, workflow) => {
      const current = deps.workflows.currentAttempt(workflow.id)!;
      if (UNRESOLVED_SEND_STATES.includes(current.sendState)) {
        return fail(
          "attempt-unresolved",
          `Attempt ${current.id} is ${current.sendState}; it is never retried or bypassed with a revision.`,
        );
      }
      if (!workflow.identity) {
        return fail("identity-missing", `Workflow ${workflow.id} has no bound writer identity.`);
      }
      // Same session, idle or done, at its ordinary prompt: checked before any attempt exists.
      const ready = await guardWriterReady(deps, workflow.identity);
      if (!ready.ok) return fail(ready.code, `${ready.error} The writer is not relaunched.`);
      const brief = recordedBrief(deps, workflow);
      if (!brief.ok) return brief;
      const modes = [...(input.modes ?? [])];
      const sources = skillSourcesOf(brief.value);
      const unknownMode = modes.find(
        (mode) => !sources?.skills.some((skill) => skill.name === mode),
      );
      if (unknownMode) {
        return fail(
          "mode-unavailable",
          `Mode ${unknownMode} is not one of this workflow's resolved skills (${sources?.skills.map((skill) => skill.name).join(", ") || "none"}); a revision cannot add a new skill source.`,
        );
      }
      const unchanged = skillsUnchanged(brief.value);
      if (!unchanged.ok) return unchanged;
      const attemptId = `wfa_${randomUUID()}`;
      const prompt = writerPrompt({
        brief: brief.value,
        attemptId,
        purpose: "revision",
        delta,
        modes,
      });
      deps.artifacts.write(workflow.id, `modes-${attemptId}.json`, canonicalJson({ modes }));
      deps.artifacts.write(workflow.id, `prompt-${attemptId}.txt`, prompt);
      if (workflow.backend === "standalone") {
        // Recorded before anything is sent, and linked to the dispatch attempt before
        // submission, so a crash at any point stays recoverable.
        deps.workflows.commit(lease, () => {
          deps.workflows.addAttempt(workflow.id, sha256(prompt), attemptId);
          deps.workflows.setState(workflow.id, "revision", REOPENED);
        });
        return sendStandaloneRevision(deps, lease, workflow, attemptId, prompt);
      }
      const collab = needCollab(deps);
      if (!collab.ok) return collab;
      const owner = ownerCapability(deps, workflow);
      if (!owner.ok) return owner;
      const deltaName = `delta-${attemptId}.txt`;
      const deltaFile = deps.artifacts.write(workflow.id, deltaName, delta);
      const fromAttempt = current.backendAttempt!;
      // The local attempt exists only once agent-collab confirms its new attempt; the intent
      // carries everything needed to record it if the answer is lost.
      const changes = await external(
        deps,
        workflow.id,
        {
          operation: "request-changes",
          attemptId,
          backendAttempt: fromAttempt,
          payload: { from: fromAttempt, attemptId, promptSha256: sha256(prompt), delta: deltaName },
        },
        () =>
          collab.value.requestChanges({
            runId: workflow.externalRunId!,
            owner: owner.value,
            attempt: fromAttempt,
            noteFile: deltaFile,
          }),
      );
      if (changes.kind !== "ok") return externalFailure("request-changes", changes);
      deps.workflows.commit(lease, () => {
        deps.workflows.addAttempt(workflow.id, sha256(prompt), attemptId);
        deps.workflows.updateAttempt(attemptId, { backendAttempt: changes.value.attempt });
        deps.workflows.setState(workflow.id, "revision", REOPENED);
        applied(deps, changes.intentId);
      });
      return dispatchCollab(deps, lease, workflow.id, attemptId, prompt, collab.value, owner.value);
    },
  );
}

async function sendStandaloneRevision(
  deps: WorkflowDeps,
  lease: OperationLease,
  workflow: Workflow,
  attemptId: string,
  prompt: string,
): Promise<Step<{ workflow: Workflow; attempt: WorkflowAttempt }>> {
  const revised = await reviseTask({
    taskId: workflow.taskId!,
    text: prompt,
    deps: deps.dispatch,
    workflowId: workflow.id,
    onBegin: (begun) =>
      deps.workflows.commit(lease, () =>
        deps.workflows.updateAttempt(attemptId, { backendAttempt: begun.id, sendState: "sending" }),
      ),
  });
  if (!revised.ok) {
    // Refused before submission: the attempt stays pending and can be resumed.
    deps.workflows.commit(lease, () =>
      deps.workflows.updateAttempt(attemptId, { sendEvidence: revised.error }),
    );
    return fail(
      revised.code,
      `${revised.error} The revision stays pending; resume it with \`workflow revise ${workflow.id} --attempt ${attemptId} --resume\`.`,
    );
  }
  const sendState = sendStateOf(revised.attempt.state);
  deps.workflows.commit(lease, () => {
    deps.workflows.updateAttempt(attemptId, {
      sendState,
      backendAttempt: revised.attempt.id,
      ...(revised.attempt.evidence ? { sendEvidence: revised.attempt.evidence } : {}),
    });
    deps.workflows.setState(workflow.id, stateAfterSend(sendState));
  });
  return {
    ok: true,
    value: {
      workflow: deps.workflows.get(workflow.id)!,
      attempt: deps.workflows.getAttempt(attemptId)!,
    },
  };
}

async function resumeRevision(
  deps: WorkflowDeps,
  workflowId: string,
  attemptId: string,
): Promise<Step<{ workflow: Workflow; attempt: WorkflowAttempt }>> {
  return withOperation(
    deps,
    workflowId,
    "revise",
    { from: ["revision", "starting"], expectedAttemptId: attemptId },
    async (lease, workflow) => {
      const attempt = deps.workflows.getAttempt(attemptId)!;
      if (attempt.sendState !== "pending") {
        return fail(
          "not-pending",
          `Attempt ${attemptId} is ${attempt.sendState}; only a revision that was never submitted is resumed.`,
        );
      }
      if (!workflow.identity) {
        return fail("identity-missing", `Workflow ${workflow.id} has no bound writer identity.`);
      }
      const prompt = deps.artifacts.read(workflow.id, `prompt-${attemptId}.txt`);
      if (sha256(prompt) !== attempt.promptSha256) {
        return fail(
          "prompt-changed",
          `The recorded prompt of attempt ${attemptId} no longer matches its SHA-256.`,
        );
      }
      if (workflow.backend === "standalone") {
        if (workflow.state === "starting") {
          return fail(
            "not-pending",
            "A standalone start is not resumed; inspect it with `workflow recover`.",
          );
        }
        if (attempt.backendAttempt) {
          return fail(
            "attempt-unresolved",
            `Attempt ${attemptId} reached the dispatch store; recover it instead of resuming.`,
          );
        }
        const ready = await guardWriterReady(deps, workflow.identity);
        if (!ready.ok) return ready;
        return sendStandaloneRevision(deps, lease, workflow, attemptId, prompt);
      }
      const collab = needCollab(deps);
      if (!collab.ok) return collab;
      const owner = ownerCapability(deps, workflow);
      if (!owner.ok) return owner;
      // Only when agent-collab itself shows this attempt current and never dispatched.
      const status = await collab.value.status({ runId: workflow.externalRunId! });
      if (status.kind !== "ok") {
        return fail("backend-unknown", `agent-collab status ${status.kind}: ${status.error}`);
      }
      const backend = status.value.attempts?.find(
        (entry) => entry.attempt_id === attempt.backendAttempt,
      );
      if (
        !attempt.backendAttempt ||
        status.value.current_attempt !== attempt.backendAttempt ||
        !backend ||
        backend.dispatch_state
      ) {
        return fail(
          "not-pending",
          `agent-collab does not show attempt ${attempt.backendAttempt ?? "(none)"} as current and undispatched; nothing was sent.`,
        );
      }
      return dispatchCollab(deps, lease, workflow.id, attemptId, prompt, collab.value, owner.value);
    },
  );
}

// ---------------------------------------------------------------------------------------
// accept / delivery / release
// ---------------------------------------------------------------------------------------

/**
 * Records the coordinator's acceptance of the current attempt at its exact revision, with its
 * evidence. Every verifier lane must have reported `pass` on that revision; acceptance never
 * releases.
 */
export async function acceptWorkflow(
  deps: WorkflowDeps,
  input: {
    workflowId: string;
    expectedAttemptId: string;
    evidence: string;
    /** Skills whose skipped or blocked report the coordinator evaluated and accepts anyway. */
    waiveSkills?: readonly string[];
  },
): Promise<Step<{ workflow: Workflow }>> {
  const loaded = loadWorkflow(deps, input.workflowId);
  if (!loaded.ok) return loaded;
  const caller = refuseWorkerCaller(deps, loaded.value);
  if (!caller.ok) return caller;
  return withOperation(
    deps,
    input.workflowId,
    "accept",
    { from: ["reviewed"], expectedAttemptId: input.expectedAttemptId },
    async (lease, workflow) => {
      const gate = await writerStoppedAtResult(deps, workflow, input.expectedAttemptId);
      if (!gate.ok) return gate;
      const status = gate.value.attempt.result!.status;
      if (status !== "impl-complete") {
        return fail(
          "not-complete",
          `The writer reported ${status}; only an impl-complete result is accepted.`,
        );
      }
      const brief = recordedBrief(deps, workflow);
      if (!brief.ok) return brief;
      const unchanged = skillsUnchanged(brief.value);
      if (!unchanged.ok) return unchanged;
      const rounds = verificationLanes(deps, workflow, input.expectedAttemptId);
      for (const role of brief.value.verifierRoles) {
        const round = rounds.find((entry) => entry.verification.role === role);
        if (!round) {
          return fail(
            "verification-missing",
            `Verifier role ${role} has not verified attempt ${input.expectedAttemptId}.`,
          );
        }
        if (!sameRevision(round.verification.revision, gate.value.revision)) {
          return fail("verification-stale", `Verifier role ${role} verified another revision.`);
        }
        const notPassed = round.lanes.filter((lane) => lane.result !== "pass");
        if (round.lanes.length === 0 || notPassed.length > 0) {
          const described =
            notPassed
              .map(
                (lane) =>
                  `lane ${lane.index} ${lane.result ?? (lane.state === "failed" ? "failed to start" : "has no result")}`,
              )
              .join(", ") || "no lanes";
          return fail(
            "verification-incomplete",
            `Verifier role ${role}: ${described}. A partial panel is not a pass.`,
            round.lanes,
          );
        }
      }
      const gated = skillGate(deps, workflow, brief.value, input.expectedAttemptId, [
        ...new Set(input.waiveSkills ?? []),
      ]);
      if (!gated.ok) return gated;
      const waivers = gated.value?.waivers ?? [];
      if (waivers.length > 0) {
        deps.artifacts.write(
          workflow.id,
          `waivers-${input.expectedAttemptId}.json`,
          canonicalJson({ attemptId: input.expectedAttemptId, waivers }),
        );
      }
      const waived =
        waivers.length > 0
          ? `\n(waived skills, evaluated by the coordinator: ${waivers.map((waiver) => `${waiver.name} ${waiver.status} in ${waiver.lane}${waiver.reason ? ` (${waiver.reason})` : ""}`).join("; ")})`
          : "";
      const acceptance = `${input.evidence}${waived}`;
      const evidenceName = `acceptance-${input.expectedAttemptId}.txt`;
      let acceptIntent: string | undefined;
      const evidenceFile = deps.artifacts.write(workflow.id, evidenceName, acceptance);
      if (workflow.backend === "agent-collab") {
        const collab = needCollab(deps);
        if (!collab.ok) return collab;
        const owner = ownerCapability(deps, workflow);
        if (!owner.ok) return owner;
        const backendAttempt = gate.value.attempt.backendAttempt!;
        const accepted = await external(
          deps,
          workflow.id,
          {
            operation: "accept",
            attemptId: input.expectedAttemptId,
            backendAttempt,
            payload: { revision: gate.value.revision, evidence: evidenceName },
          },
          () =>
            collab.value.accept({
              runId: workflow.externalRunId!,
              owner: owner.value,
              attempt: backendAttempt,
              noteFile: evidenceFile,
            }),
        );
        if (accepted.kind !== "ok") return externalFailure("accept", accepted);
        acceptIntent = accepted.intentId;
      }
      deps.workflows.commit(lease, () => {
        applyAcceptance(
          deps,
          workflow.id,
          input.expectedAttemptId,
          gate.value.revision,
          acceptance,
        );
        if (acceptIntent) applied(deps, acceptIntent);
      });
      return { ok: true, value: { workflow: deps.workflows.get(workflow.id)! } };
    },
  );
}

function applyAcceptance(
  deps: WorkflowDeps,
  workflowId: string,
  attemptId: string,
  revision: Revision,
  evidence: string,
): void {
  deps.workflows.setState(workflowId, "accepted", {
    accepted_attempt_id: attemptId,
    accepted_head: revision.head,
    accepted_content: revision.content,
    acceptance_evidence: evidence,
    closing_evidence: null,
  });
}

/**
 * Records authorized delivery evidence, or that delivery does not apply.
 *
 * - Not applicable: the worktree still holds exactly the accepted HEAD and content.
 * - Delivered as a Git commit: that commit's own tree must contain exactly the accepted
 *   content and descend from the accepted HEAD. Working-tree bytes do not count, so a commit
 *   that left accepted files out, or an accepted worktree that also held unrelated dirty
 *   files, is refused rather than recorded as delivered.
 */
export function recordDelivery(
  deps: WorkflowDeps,
  input: { workflowId: string; evidence: string; notApplicable: boolean; commit?: string },
): Step<{ workflow: Workflow }> {
  const loaded = loadWorkflow(deps, input.workflowId);
  if (!loaded.ok) return loaded;
  const caller = refuseWorkerCaller(deps, loaded.value);
  if (!caller.ok) return caller;
  return withOperationSync(
    deps,
    input.workflowId,
    "delivery",
    { from: ["accepted"] },
    (lease, workflow) => {
      if (!workflow.accepted) {
        return fail("state-conflict", `Workflow ${workflow.id} has no recorded acceptance.`);
      }
      const accepted = workflow.accepted.revision;
      const now = revisionNow(deps, workflow.cwd);
      if (!now.ok) return now;
      let deliveredHead: string;
      if (input.notApplicable) {
        if (
          now.value.revision.content !== accepted.content ||
          now.value.revision.head !== accepted.head
        ) {
          return fail(
            "content-changed",
            "Delivery was declared not applicable, but the worktree is no longer at the accepted HEAD and content.",
            { accepted, current: now.value.revision },
          );
        }
        deliveredHead = accepted.head;
      } else {
        const commit = readCommitContent(deps.git, now.value.root, input.commit ?? "HEAD");
        if (!commit.ok) return fail("commit-unreadable", commit.error);
        if (commit.content !== accepted.content) {
          return fail(
            "commit-content",
            `Commit ${commit.head} does not contain exactly the accepted files: one is missing, different, or extra (for example unrelated work in progress that was part of the accepted worktree). Nothing was recorded; HMR never commits for you.`,
            { accepted, commit: commit.head },
          );
        }
        if (!isAncestor(deps.git, now.value.root, accepted.head, commit.head)) {
          return fail(
            "head-diverged",
            `The accepted HEAD ${accepted.head} is not an ancestor of ${commit.head}.`,
          );
        }
        deliveredHead = commit.head;
      }
      deps.workflows.commit(lease, () =>
        deps.workflows.setState(workflow.id, "delivered", {
          delivery_kind: input.notApplicable ? "not-applicable" : "delivered",
          delivery_evidence: input.evidence,
          delivered_head: deliveredHead,
        }),
      );
      return { ok: true, value: { workflow: deps.workflows.get(workflow.id)! } };
    },
  );
}

/**
 * Ends the workflow and gives the worktree back. A normal release needs delivery; an abort
 * needs evidence. Both need the bound writer positively stopped (full identity, idle or done):
 * an unknown or missing status refuses, so nothing is ever released on a guess. A start that
 * never bound a writer can be ended only when no pane it created can still be running.
 */
export async function releaseWorkflow(
  deps: WorkflowDeps,
  input: { workflowId: string; evidence: string; abort: boolean },
): Promise<Step<{ workflow: Workflow }>> {
  const loaded = loadWorkflow(deps, input.workflowId);
  if (!loaded.ok) return loaded;
  const caller = refuseWorkerCaller(deps, loaded.value);
  if (!caller.ok) return caller;
  if (input.abort && loaded.value.state === "failed") return confirmRolledBack(deps, loaded.value);
  const from: WorkflowState[] = input.abort
    ? [
        "starting",
        "dispatched",
        "unknown",
        "receipt",
        "verifying",
        "reviewed",
        "revision",
        "accepted",
        "delivered",
      ]
    : ["delivered"];
  return withOperation(
    deps,
    input.workflowId,
    input.abort ? "release-abort" : "release",
    { from },
    async (lease, workflow) => {
      if (!workflow.identity) {
        if (!input.abort) {
          return fail("identity-missing", `Workflow ${workflow.id} never bound a writer identity.`);
        }
        return abortUnbound(deps, lease, workflow, input.evidence);
      }
      const stopped = await checkStopped(deps.dispatch.pane, workflow.identity);
      if (!stopped.ok) return fail(stopped.code, `${stopped.error} Nothing was released.`);
      if (!input.abort) {
        const now = revisionNow(deps, workflow.cwd);
        if (!now.ok) return now;
        if (now.value.revision.content !== workflow.accepted?.revision.content) {
          return fail(
            "content-changed",
            "The worktree changed after delivery; nothing was released.",
          );
        }
      }
      let releaseIntent: string | undefined;
      if (workflow.backend === "agent-collab") {
        const collab = needCollab(deps);
        if (!collab.ok) return collab;
        const owner = ownerCapability(deps, workflow);
        if (!owner.ok) return owner;
        const operation = input.abort ? "release-abort" : "release";
        const evidenceName = `${operation}.txt`;
        const noteFile = deps.artifacts.write(workflow.id, evidenceName, input.evidence);
        const released = await external(
          deps,
          workflow.id,
          { operation, payload: { evidence: evidenceName } },
          () =>
            collab.value.release({
              runId: workflow.externalRunId!,
              owner: owner.value,
              abort: input.abort,
              noteFile,
            }),
        );
        if (released.kind !== "ok") {
          return externalFailure(input.abort ? "release --abort" : "release", released);
        }
        releaseIntent = released.intentId;
      }
      deps.workflows.commit(lease, () => {
        applyRelease(deps, workflow, input.abort, input.evidence);
        if (releaseIntent) applied(deps, releaseIntent);
      });
      return { ok: true, value: { workflow: deps.workflows.get(workflow.id)! } };
    },
  );
}

function applyRelease(deps: WorkflowDeps, workflow: Workflow, abort: boolean, evidence: string) {
  if (workflow.backend === "agent-collab") deps.artifacts.remove(workflow.id, OWNER_FILE);
  else if (workflow.taskId) {
    const task = deps.dispatch.store.getTask(workflow.taskId);
    if (task && !["complete", "released"].includes(task.status)) {
      deps.dispatch.store.closeTask(
        workflow.taskId,
        abort ? "released" : "complete",
        `workflow ${workflow.id}: ${evidence}`,
        { workflowId: workflow.id },
      );
    }
  }
  deps.workflows.setState(workflow.id, abort ? "aborted" : "released", {
    closing_evidence: evidence,
  });
}

/** Why a start that never bound a writer may still have a CLI running, or undefined. */
function unboundPaneMayRun(deps: WorkflowDeps, workflow: Workflow): string | undefined {
  if (workflow.backend === "agent-collab") {
    if (workflow.externalRunId) {
      return `agent-collab run ${workflow.externalRunId} exists; recover it through agent-collab.`;
    }
    if (workflow.startPane && workflow.startPane.closed !== true) {
      return `Pane ${workflow.startPane.id} was created and its close was not confirmed; inspect it before ending the workflow.`;
    }
    return undefined;
  }
  if (!workflow.taskId) return undefined;
  for (const lane of deps.dispatch.store.lanes(workflow.taskId)) {
    if (deps.dispatch.store.attempts(lane.id).length > 0) {
      return `Task ${workflow.taskId} has prompt attempts.`;
    }
    if (lane.paneId) {
      return `Pane ${lane.paneId} was created and its close was not confirmed; inspect it before ending the workflow.`;
    }
  }
  return undefined;
}

/** A failed start that already rolled back: confirms nothing runs and frees a leftover lease. */
function confirmRolledBack(deps: WorkflowDeps, workflow: Workflow): Step<{ workflow: Workflow }> {
  const running = unboundPaneMayRun(deps, workflow);
  if (running) return fail("start-held", running);
  if (workflow.taskId && deps.dispatch.store.ownershipOfTask(workflow.taskId)) {
    deps.dispatch.store.closeTask(
      workflow.taskId,
      "released",
      `workflow ${workflow.id} failed before any prompt`,
      { workflowId: workflow.id },
    );
  }
  return { ok: true, value: { workflow } };
}

/** Ends a start that stopped before binding a writer, once no pane it created can run. */
function abortUnbound(
  deps: WorkflowDeps,
  lease: OperationLease,
  workflow: Workflow,
  evidence: string,
): Step<{ workflow: Workflow }> {
  const running = unboundPaneMayRun(deps, workflow);
  if (running) return fail("start-held", running);
  deps.workflows.commit(lease, () => {
    if (workflow.taskId) {
      const task = deps.dispatch.store.getTask(workflow.taskId);
      if (task && !["complete", "released"].includes(task.status)) {
        deps.dispatch.store.closeTask(
          workflow.taskId,
          "released",
          `workflow ${workflow.id} aborted before binding: ${evidence}`,
          { workflowId: workflow.id },
        );
      }
    }
    deps.workflows.setState(workflow.id, "aborted", { closing_evidence: evidence });
  });
  return { ok: true, value: { workflow: deps.workflows.get(workflow.id)! } };
}

// ---------------------------------------------------------------------------------------
// status / recover
// ---------------------------------------------------------------------------------------

export interface SkillReport {
  /** Modes the current attempt was sent with; null when its mode record cannot be trusted. */
  modes: string[] | null;
  skills: { name: string; required: boolean; file: string; sha256: string }[];
  /** Each recorded lane's claims (writer and verifiers) against the attempt's request. */
  lanes: { lane: string; satisfied: boolean; problems: string[] }[];
  /** Records the gate could not trust: a mode or result file missing, unreadable, or altered. */
  integrity: string[];
  /** Every lane together; absent before the writer's result. */
  evidence?: { satisfied: boolean; problems: string[] };
  /** A lane's skill report is its claim; the coordinator's review decides. */
  claimsAreProof: false;
}

export interface WorkflowReport {
  workflow: Workflow;
  attempts: WorkflowAttempt[];
  verification: ReturnType<typeof verificationLanes>;
  intents: Intent[];
  next: string[];
  skills?: SkillReport;
}

interface SkillWaiver {
  name: string;
  lane: string;
  status: string;
  reason?: string;
}

/** A recorded result file, trusted only at the SHA-256 the database holds for it. */
function recordedResult(
  artifacts: WorkflowDeps["artifacts"],
  workflowId: string,
  name: string,
  digest: string,
): { ok: true; result: WorkflowResult } | { ok: false; problem: string } {
  let text: string;
  try {
    text = artifacts.read(workflowId, name);
  } catch {
    return { ok: false, problem: `${name} is missing or unreadable` };
  }
  if (sha256(text) !== digest) return { ok: false, problem: `${name} was changed` };
  const parsed = parseResult(text);
  return parsed.ok
    ? { ok: true, result: parsed.value }
    : { ok: false, problem: `${name} no longer parses` };
}

/**
 * The skill request of one attempt and how every recorded lane's report meets it: the writer
 * and each verifier lane of the attempt's current verification rounds. Required skills and
 * references bind every lane; a requested mode binds every lane of that attempt.
 */
function skillEvaluation(
  deps: Pick<WorkflowDeps, "artifacts" | "workflows">,
  workflow: Workflow,
  brief: BriefRecord,
  attemptId: string,
  waived: readonly string[],
): { report: SkillReport; waivers: SkillWaiver[] } | undefined {
  const sources = skillSourcesOf(brief);
  if (!sources) return undefined;
  const integrity: string[] = [];
  const recorded = attemptModes(deps, workflow.id, attemptId);
  if (!recorded.ok) integrity.push(recorded.error);
  const modes = recorded.ok ? recorded.value : null;
  const lanes: SkillReport["lanes"] = [];
  const waivers: SkillWaiver[] = [];
  const evaluate = (lane: string, result: WorkflowResult) => {
    const evaluated = evaluateSkillEvidence({
      snapshot: sources,
      modes: modes ?? [],
      skills: result.version === RESULT_VERSION_V2 ? result.skills : undefined,
      waived,
    });
    lanes.push({ lane, satisfied: evaluated.satisfied, problems: evaluated.problems });
    waivers.push(...evaluated.waivedClaims.map((claim) => ({ ...claim, lane })));
  };
  const attempt = deps.workflows.getAttempt(attemptId);
  if (attempt?.result) {
    const writer = recordedResult(
      deps.artifacts,
      workflow.id,
      `result-${attemptId}.json`,
      attempt.result.sha256,
    );
    if (writer.ok && writer.result.lane === "writer") evaluate("writer", writer.result);
    else integrity.push(`writer result: ${writer.ok ? "not a writer result" : writer.problem}`);
  }
  const latestByRole = new Map<string, ReturnType<WorkflowRepository["verifications"]>[number]>();
  for (const verification of deps.workflows.verifications(workflow.id, attemptId)) {
    latestByRole.set(verification.role, verification);
  }
  for (const verification of latestByRole.values()) {
    for (const row of deps.workflows.verifierResults(verification.id)) {
      const lane = `verifier ${verification.role} lane ${row.laneId}`;
      const read = recordedResult(
        deps.artifacts,
        workflow.id,
        `verifier-${row.laneId}.json`,
        row.resultSha256,
      );
      if (read.ok && read.result.lane === "verifier") evaluate(lane, read.result);
      else integrity.push(`${lane}: ${read.ok ? "not a verifier result" : read.problem}`);
    }
  }
  const problems = [
    ...integrity,
    ...lanes.flatMap((entry) => entry.problems.map((problem) => `${entry.lane}: ${problem}`)),
  ];
  return {
    report: {
      modes,
      skills: sources.skills.map(({ name, required, file, sha256: digest }) => ({
        name,
        required,
        file,
        sha256: digest,
      })),
      lanes,
      integrity,
      ...(attempt?.result ? { evidence: { satisfied: problems.length === 0, problems } } : {}),
      claimsAreProof: false,
    },
    waivers,
  };
}

/**
 * Acceptance's skill gate. A v1 brief has none. For a v2 brief every lane's claims must meet
 * the attempt's request; an untrusted record fails closed; each waiver must name a skill some
 * lane actually did not apply, so a waiver is never invented or left unused.
 */
function skillGate(
  deps: Pick<WorkflowDeps, "artifacts" | "workflows">,
  workflow: Workflow,
  brief: BriefRecord,
  attemptId: string,
  waived: readonly string[],
): Step<{ report: SkillReport; waivers: SkillWaiver[] } | undefined> {
  const sources = skillSourcesOf(brief);
  if (!sources) {
    return waived.length > 0
      ? fail(
          "waiver-unused",
          "This workflow's brief requests no skills; there is nothing to waive.",
        )
      : { ok: true, value: undefined };
  }
  const evaluated = skillEvaluation(deps, workflow, brief, attemptId, waived)!;
  const { report, waivers } = evaluated;
  if (report.integrity.length > 0) {
    return fail(
      "skill-gate-integrity",
      `The skill gate cannot trust attempt ${attemptId}'s records: ${report.integrity.join("; ")}. Nothing was accepted.`,
      report,
    );
  }
  if (!report.evidence) {
    return fail("skill-evidence", `Attempt ${attemptId} has no writer result to evaluate.`, report);
  }
  if (!report.evidence.satisfied) {
    return fail(
      "skill-evidence",
      `The lanes' skill reports do not meet what attempt ${attemptId} asked: ${report.evidence.problems.join("; ")}. A required skill or mode a lane did not apply counts only with --waive-skill after you evaluated its reason.`,
      report,
    );
  }
  const unused = waived.filter((name) => !waivers.some((waiver) => waiver.name === name));
  if (unused.length > 0) {
    return fail(
      "waiver-unused",
      `--waive-skill ${unused.join(", ")} matches no skill a lane of attempt ${attemptId} skipped, blocked or did not use; a waiver must name what it excuses.`,
      report,
    );
  }
  return { ok: true, value: evaluated };
}

/** The commands that can make progress now. Never includes a resend of an unresolved attempt. */
export function nextActions(
  workflow: Workflow,
  attempt: WorkflowAttempt | undefined,
  unresolved: Intent | undefined,
): string[] {
  const id = workflow.id;
  const at = attempt ? ` --attempt ${attempt.id}` : "";
  const abort = `workflow release ${id} --abort --evidence <why> (only once the writer is idle or done)`;
  if (FINAL_WORKFLOW_STATES.includes(workflow.state)) return [];
  if (workflow.operation) {
    return [`wait: \`${workflow.operation.name}\` is in progress (workflow status ${id})`];
  }
  if (unresolved) {
    return [
      `workflow recover ${id} (reconciles the unresolved ${unresolved.operation}; nothing is resent)`,
    ];
  }
  switch (workflow.state) {
    case "starting":
      return workflow.backend === "agent-collab" &&
        workflow.externalRunId &&
        attempt?.sendState === "pending" &&
        attempt.backendAttempt
        ? [`workflow revise ${id}${at} --resume (acquired; its prompt was never submitted)`, abort]
        : [`workflow recover ${id}`, abort];
    case "dispatched":
      return [
        `wait for the writer's result, then: workflow result ${id}${at} --file <result.json>`,
        abort,
      ];
    case "unknown":
      return [`workflow recover ${id} (inspect; nothing is resent)`, abort];
    case "receipt":
      return [`workflow verify ${id}${at}`, `workflow revise ${id}${at} --file <changes>`, abort];
    case "verifying":
      return [
        `workflow result ${id}${at} --lane <report.verification[].lanes[].laneId> --file <verifier-result.json>`,
        abort,
      ];
    case "reviewed":
      return [
        `workflow accept ${id}${at} --evidence <why>`,
        `workflow revise ${id}${at} --file <changes>`,
        abort,
      ];
    case "revision":
      return attempt?.sendState === "pending"
        ? [`workflow revise ${id}${at} --resume (its prompt was never submitted)`, abort]
        : [`workflow recover ${id}`, abort];
    case "accepted":
      return [
        `workflow delivery ${id} --evidence <what was delivered> [--commit <rev>]`,
        `workflow delivery ${id} --not-applicable --evidence <why>`,
        `workflow revise ${id}${at} --file <changes> (reopens the acceptance)`,
        abort,
      ];
    case "delivered":
      return [`workflow release ${id} --evidence <delivery reference>`];
    default: {
      return [];
    }
  }
}

export function workflowReport(
  deps: Pick<WorkflowDeps, "workflows" | "dispatch"> & Partial<Pick<WorkflowDeps, "artifacts">>,
  id: string,
): WorkflowReport | undefined {
  const workflow = deps.workflows.get(id);
  if (!workflow) return undefined;
  const attempts = deps.workflows.attempts(id);
  const current = attempts.at(-1);
  const skills =
    current && deps.artifacts
      ? reportSkills({ artifacts: deps.artifacts, workflows: deps.workflows }, workflow, current.id)
      : undefined;
  return {
    workflow,
    attempts,
    verification: current ? verificationLanes(deps, workflow, current.id) : [],
    intents: deps.workflows.intents(id),
    next: nextActions(workflow, current, deps.workflows.unresolvedIntent(id)),
    ...(skills ? { skills } : {}),
  };
}

function reportSkills(
  deps: Pick<WorkflowDeps, "artifacts" | "workflows">,
  workflow: Workflow,
  attemptId: string,
): SkillReport | undefined {
  let brief: BriefRecord;
  try {
    brief = JSON.parse(deps.artifacts.read(workflow.id, "brief.json")) as BriefRecord;
  } catch {
    return undefined;
  }
  return skillEvaluation(deps, workflow, brief, attemptId, [])?.report;
}

export type Reconciled = { resolved: "applied" | "not-applied" | "unclear"; note: string };

/** The run an unresolved intent concerns: the recorded one, or an observed acquire's run. */
function intentRunId(workflow: Workflow, intent: Intent): string | undefined {
  if (workflow.externalRunId) return workflow.externalRunId;
  if (intent.operation !== "acquire" || intent.state !== "observed" || !intent.observed)
    return undefined;
  try {
    const observed = JSON.parse(intent.observed) as { runId?: unknown };
    return typeof observed.runId === "string" ? observed.runId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Settles one unresolved external intent from read-only `agent-collab status` of the known
 * run. The status must name exactly that run, the bound native session and pane, and the
 * attempt the operation concerns; anything else stays unresolved with a diagnostic and no
 * local change. An applied effect is recorded locally exactly as a successful reply would
 * have been, in the same transaction that finishes the intent; an effect that did not happen
 * frees the operation for the coordinator. Nothing is resent, re-acquired, or released here.
 */
function reconcileIntent(
  deps: WorkflowDeps,
  lease: OperationLease,
  workflow: Workflow,
  intent: Intent,
  status: CollabStatus,
  runId: string,
): Reconciled {
  const unclear = (note: string): Reconciled => ({ resolved: "unclear", note });
  const identity = workflow.identity;
  if (!identity) return unclear("the workflow has no bound writer to compare with");
  if (status.run_id !== runId) return unclear(`status names run ${status.run_id}, not ${runId}`);
  if (!status.session || status.session !== identity.sessionId) {
    return unclear(`status names session ${status.session ?? "(none)"}, not the bound session`);
  }
  if (!status.pane || status.pane !== identity.paneId) {
    return unclear(
      `status names pane ${status.pane ?? "(none)"}, not the bound pane ${identity.paneId}`,
    );
  }
  const entry = (attemptId: string | undefined) =>
    attemptId
      ? status.attempts?.find((candidate) => candidate.attempt_id === attemptId)
      : undefined;
  const backend = entry(intent.backendAttempt);
  const current =
    intent.backendAttempt !== undefined && status.current_attempt === intent.backendAttempt;
  const settle = (
    resolved: "applied" | "not-applied",
    note: string,
    apply?: () => void,
  ): Reconciled => {
    deps.workflows.commit(lease, () => {
      apply?.();
      deps.workflows.finishIntent(
        intent.id,
        resolved === "applied" ? "done" : "refused",
        `reconciled: ${note}`,
      );
    });
    return { resolved, note };
  };
  switch (intent.operation) {
    case "acquire": {
      let observed: { runId?: unknown; attempt?: unknown } = {};
      try {
        observed = JSON.parse(intent.observed ?? "{}") as typeof observed;
      } catch {
        return unclear("the acquire's observed reply is unreadable");
      }
      if (typeof observed.attempt !== "string" || status.current_attempt !== observed.attempt) {
        return unclear(
          `current attempt ${status.current_attempt ?? "(none)"} is not the acquired one`,
        );
      }
      // Without the saved capability nothing further can be done through HMR.
      const owner = ownerCapability(deps, workflow);
      if (!owner.ok) return unclear(owner.error);
      const attempt = observed.attempt;
      return settle("applied", `agent-collab run ${runId} acquired with attempt ${attempt}`, () => {
        deps.workflows.setFields(workflow.id, { external_run_id: runId });
        deps.workflows.updateAttempt(intent.attemptId!, { backendAttempt: attempt });
      });
    }
    case "dispatch": {
      if (!backend || !current) {
        return unclear(`attempt ${intent.backendAttempt} is not the run's current attempt`);
      }
      if (backend.dispatch_state === "done" && backend.outcome === "submitted") {
        return settle("applied", "dispatch done, outcome submitted", () => {
          deps.workflows.updateAttempt(intent.attemptId!, {
            sendState: "sent",
            sendEvidence: "agent-collab status: dispatch done, outcome submitted",
          });
          deps.workflows.setState(workflow.id, "dispatched");
        });
      }
      if (!backend.dispatch_state) {
        return settle("not-applied", "agent-collab never dispatched it", () => {
          deps.workflows.updateAttempt(intent.attemptId!, {
            sendState: "not-delivered",
            sendEvidence: "agent-collab status: not dispatched",
          });
          deps.workflows.setState(workflow.id, "unknown");
        });
      }
      return unclear(
        `dispatch state ${backend.dispatch_state}, outcome ${backend.outcome ?? "missing"}`,
      );
    }
    case "receipt": {
      if (!backend || !current) {
        return unclear(`attempt ${intent.backendAttempt} is not the run's current attempt`);
      }
      const expected = intent.payload.status;
      if (backend.receipt_status && backend.receipt_status === expected) {
        const text = deps.artifacts.read(workflow.id, String(intent.payload.result));
        const parsed = parseResult(text);
        if (!parsed.ok || parsed.value.lane !== "writer") {
          return unclear("the recorded result artifact is unreadable");
        }
        const result = parsed.value;
        return settle("applied", `receipt ${String(expected)} recorded`, () =>
          applyWriterResult(deps, workflow.id, intent.attemptId!, result, text),
        );
      }
      if (!backend.receipt_status)
        return settle("not-applied", "agent-collab has no receipt for the attempt");
      return unclear(`receipt status ${backend.receipt_status}, not ${String(expected)}`);
    }
    case "request-changes": {
      const from = String(intent.payload.from);
      const attemptId = String(intent.payload.attemptId);
      const order = status.attempts ?? [];
      const fromAt = order.findIndex((candidate) => candidate.attempt_id === from);
      if (fromAt === -1) return unclear(`the reviewed attempt ${from} is not in the run`);
      if (status.current_attempt === from && fromAt === order.length - 1) {
        return settle("not-applied", "agent-collab still has the reviewed attempt current");
      }
      // Only the revision opened from exactly this reviewed attempt is this request's effect.
      const opened = order[fromAt + 1];
      if (
        !opened ||
        fromAt + 1 !== order.length - 1 ||
        status.current_attempt !== opened.attempt_id ||
        (opened.parent !== undefined && opened.parent !== null && opened.parent !== from)
      ) {
        return unclear(
          `no revision opened directly from ${from} is current (current ${status.current_attempt ?? "(none)"})`,
        );
      }
      return settle(
        "applied",
        `agent-collab opened attempt ${opened.attempt_id} from ${from}`,
        () => {
          deps.workflows.addAttempt(workflow.id, String(intent.payload.promptSha256), attemptId);
          deps.workflows.updateAttempt(attemptId, { backendAttempt: opened.attempt_id });
          deps.workflows.setState(workflow.id, "revision", REOPENED);
        },
      );
    }
    case "accept": {
      if (!backend || !current) {
        return unclear(`attempt ${intent.backendAttempt} is not the run's current attempt`);
      }
      if (status.state === "accepted" && backend.accepted_at) {
        const revision = intent.payload.revision as Revision;
        const evidence = deps.artifacts.read(workflow.id, String(intent.payload.evidence));
        return settle(
          "applied",
          `attempt ${intent.backendAttempt} accepted at ${backend.accepted_at}`,
          () => applyAcceptance(deps, workflow.id, intent.attemptId!, revision, evidence),
        );
      }
      if (status.state === "receipt" && !backend.accepted_at) {
        return settle("not-applied", "agent-collab run is still awaiting review");
      }
      return unclear(
        `run state ${status.state}, attempt accepted_at ${backend.accepted_at ?? "(none)"}`,
      );
    }
    case "release":
    case "release-abort": {
      if (status.state === "released") {
        const evidence = deps.artifacts.read(workflow.id, String(intent.payload.evidence));
        return settle(
          "applied",
          `agent-collab run is released${status.released_at ? ` at ${status.released_at}` : ""}`,
          () => applyRelease(deps, workflow, intent.operation === "release-abort", evidence),
        );
      }
      return settle("not-applied", `agent-collab run is ${status.state}`);
    }
    default:
      return unclear(`${intent.operation} is recovered manually through agent-collab`);
  }
}

/**
 * Inspects a workflow after an interruption. Without evidence it reconciles an unresolved
 * agent-collab intent from read-only status. With delivery evidence it records what the
 * operator observed for a standalone send. It never resends, re-acquires, or releases on its own.
 */
export async function recoverWorkflow(
  deps: WorkflowDeps,
  input: { workflowId: string; observed?: { delivered: boolean; evidence: string } },
): Promise<Step<{ report: WorkflowReport; backend?: unknown; reconciled?: Reconciled }>> {
  const loaded = loadWorkflow(deps, input.workflowId);
  if (!loaded.ok) return loaded;
  const observed = input.observed;
  if (observed) {
    const caller = refuseWorkerCaller(deps, loaded.value);
    if (!caller.ok) return caller;
    return withOperation(
      deps,
      input.workflowId,
      "recover",
      { from: ["starting", "dispatched", "unknown", "revision"] },
      (lease, workflow) => {
        if (workflow.backend !== "standalone") {
          return fail(
            "backend-owned",
            "agent-collab owns this attempt; recover reads its status instead of recording evidence.",
          );
        }
        const attempt = deps.workflows.currentAttempt(workflow.id);
        const backendAttempt = attempt?.backendAttempt;
        if (!attempt || !["sending", "unknown"].includes(attempt.sendState) || !backendAttempt) {
          return fail(
            "nothing-to-recover",
            `The current attempt is ${attempt?.sendState ?? "missing"}; only a sending or unknown send is recovered.`,
          );
        }
        deps.workflows.commit(lease, () => {
          deps.dispatch.store.recoverAttempt(
            backendAttempt,
            observed.delivered,
            observed.evidence,
            {
              workflowId: workflow.id,
            },
          );
          deps.workflows.updateAttempt(attempt.id, {
            sendState: observed.delivered ? "sent" : "not-delivered",
            sendEvidence: `recovered: ${observed.evidence}`,
          });
          deps.workflows.setState(workflow.id, observed.delivered ? "dispatched" : "unknown");
        });
        return { ok: true, value: { report: workflowReport(deps, workflow.id)! } };
      },
    );
  }
  const unresolved = deps.workflows.unresolvedIntent(input.workflowId);
  const collab = deps.collab;
  const runId = unresolved ? intentRunId(loaded.value, unresolved) : undefined;
  if (loaded.value.backend !== "agent-collab" || !unresolved || !runId || !collab) {
    return { ok: true, value: { report: workflowReport(deps, input.workflowId)! } };
  }
  return withOperation<{ report: WorkflowReport; backend?: unknown; reconciled?: Reconciled }>(
    deps,
    input.workflowId,
    "recover",
    {
      from: [
        "starting",
        "dispatched",
        "unknown",
        "receipt",
        "verifying",
        "reviewed",
        "revision",
        "accepted",
        "delivered",
      ],
      allowUnresolvedIntent: true,
    },
    async (lease, workflow) => {
      const status = await collab.status({ runId });
      if (status.kind !== "ok") {
        return {
          ok: true,
          value: {
            report: workflowReport(deps, workflow.id)!,
            backend: { kind: status.kind, error: status.error },
          },
        };
      }
      const reconciled = reconcileIntent(deps, lease, workflow, unresolved, status.value, runId);
      return {
        ok: true,
        value: { report: workflowReport(deps, workflow.id)!, backend: status.value, reconciled },
      };
    },
  );
}
