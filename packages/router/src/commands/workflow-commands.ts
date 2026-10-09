import { readFileSync } from "node:fs";
import { isHerdrEnv } from "../launch/readiness.js";
import { parseBriefInput } from "../workflow/contracts.js";
import { readRevision, type GitRead } from "../workflow/revision.js";
import {
  acceptWorkflow,
  bindWorktree,
  recordDelivery,
  recordResult,
  recoverWorkflow,
  releaseWorkflow,
  reviseWorkflow,
  startWorkflow,
  verifyWorkflow,
  workflowReport,
  type Step,
  type WorkflowDeps,
  type WorkflowReport,
} from "../workflow/service.js";
import type { Backend, WorkflowRepository } from "../store/workflow-repository.js";
import { previewPlan, type CommandResult, type RulesLocation } from "./rules-commands.js";

function refused(error: string, extra: Record<string, unknown> = {}, code = 2): CommandResult {
  return { output: error, json: { ok: false, error, ...extra }, code };
}

function readText(
  file: string,
  what: string,
): { ok: true; text: string } | { ok: false; result: CommandResult } {
  try {
    return { ok: true, text: readFileSync(file, "utf8") };
  } catch (error) {
    return {
      ok: false,
      result: refused(`Cannot read the ${what} ${file}: ${(error as Error).message}`),
    };
  }
}

function requireEvidence(evidence: string | undefined): string | undefined {
  const trimmed = evidence?.trim();
  return trimmed ? trimmed : undefined;
}

function formatReport(report: WorkflowReport): string {
  const { workflow } = report;
  const lines = [
    `Workflow ${workflow.id}: ${workflow.state} (${workflow.backend}, writer role ${workflow.writerRole}, ${workflow.writerDescriptor})`,
    `Worktree: ${workflow.worktreeId}`,
    ...(workflow.identity
      ? [
          `Writer: ${workflow.identity.agentName} (${workflow.identity.kind}) in pane ${workflow.identity.paneId}, session bound`,
        ]
      : ["Writer: not bound"]),
    ...(workflow.externalRunId ? [`agent-collab run: ${workflow.externalRunId}`] : []),
    ...report.attempts.map(
      (attempt) =>
        `  attempt ${attempt.seq} [${attempt.id}] ${attempt.purpose}: send ${attempt.sendState}` +
        (attempt.result
          ? `, result ${attempt.result.status} at ${attempt.result.revision.head.slice(0, 12)}`
          : ", no result") +
        (attempt.sendEvidence ? ` (${attempt.sendEvidence})` : ""),
    ),
    ...report.verification.flatMap((round) => [
      `  verification ${round.verification.role} [${round.verification.id}]`,
      ...round.lanes.map(
        (lane) =>
          `    lane ${lane.index} [${lane.laneId}] ${lane.descriptor}: ${lane.result ?? (lane.state === "failed" ? `failed${lane.error ? `: ${lane.error}` : ""}` : "no result yet")}`,
      ),
    ]),
    ...(workflow.accepted
      ? [
          `Accepted: attempt ${workflow.accepted.attemptId} at ${workflow.accepted.revision.head.slice(0, 12)}`,
        ]
      : []),
    ...(workflow.delivery
      ? [`Delivery: ${workflow.delivery.kind} (${workflow.delivery.evidence})`]
      : []),
    ...(workflow.closingEvidence ? [`Note: ${workflow.closingEvidence}`] : []),
    ...(report.next.length > 0
      ? ["Next:", ...report.next.map((step) => `  ${step}`)]
      : ["Next: nothing; the workflow is closed."]),
    "An idle or finished-looking pane is not a result; only `workflow result` records one.",
  ];
  return lines.join("\n");
}

function fromStep<T>(
  step: Step<T>,
  deps: Pick<WorkflowDeps, "workflows" | "dispatch">,
  workflowId: string | undefined,
  summary: (value: T) => string,
): CommandResult {
  const report = workflowId ? workflowReport(deps, workflowId) : undefined;
  if (!step.ok) {
    return {
      output: [step.error, ...(report ? ["", formatReport(report)] : [])].join("\n"),
      json: {
        ok: false,
        code: step.code,
        error: step.error,
        ...(step.evidence === undefined ? {} : { evidence: step.evidence }),
        ...(report ? { report } : {}),
      },
      code: 2,
    };
  }
  return {
    output: [summary(step.value), ...(report ? ["", formatReport(report)] : [])].join("\n"),
    json: { ok: true, ...(report ? { report } : {}) },
    code: 0,
  };
}

/**
 * `workflow plan`: the brief and every role it names, from the rules file and project policy
 * only. No process, network, credential, or database: the same zero-effect boundary as `plan`.
 */
export function executeWorkflowPlan(
  location: RulesLocation,
  briefFile: string,
  parent?: string,
): CommandResult {
  const read = readText(briefFile, "brief");
  if (!read.ok) return read.result;
  const parsed = parseBriefInput(read.text);
  if (!parsed.ok) return refused(parsed.error, { code: "invalid-brief" });
  const brief = parsed.value;
  // The same parent resolves every parent alias in the writer and verifier roles.
  const withParent = parent !== undefined ? { parent } : {};
  const writer = previewPlan(location, { role: brief.writerRole, ...withParent });
  if (!writer.ok) return writer.result;
  if (writer.plan.access !== "write" || writer.plan.lanes.length !== 1) {
    return refused(`Role "${writer.plan.role}" is not a single-lane writer role.`, {
      code: "writer-role",
    });
  }
  const verifiers = [];
  for (const role of brief.verifierRoles) {
    const verifier = previewPlan(location, { role, readOnly: true, ...withParent });
    if (!verifier.ok) return verifier.result;
    verifiers.push(verifier.plan);
  }
  const lines = [
    `Workflow brief "${brief.title}"`,
    `Writer: role ${writer.plan.role} -> ${writer.plan.lanes[0]!.descriptor} (write)`,
    ...verifiers.map(
      (plan) =>
        `Verifier: role ${plan.role} -> ${plan.lanes.map((lane) => lane.descriptor).join(", ")} (read-only, ${plan.lanes.length} lane(s), every lane must pass)`,
    ),
    "Preview only: no process, pane, credential store, network, or router state was touched.",
  ];
  return {
    output: lines.join("\n"),
    json: { ok: true, preview: true, effects: [], brief, writer: writer.plan, verifiers },
    code: 0,
  };
}

/** `workflow fingerprint`: the revision a result must report. Reads Git and files only. */
export function executeWorkflowFingerprint(cwd: string, git: GitRead): CommandResult {
  const read = readRevision(cwd, git);
  if (!read.ok) return refused(read.error);
  return {
    output: `head ${read.revision.head}\ncontent ${read.revision.content}`,
    json: { ok: true, revision: read.revision },
    code: 0,
  };
}

export function executeWorkflowBind(
  deps: Pick<WorkflowDeps, "workflows">,
  cwd: string,
  backend: string,
): CommandResult {
  if (backend !== "standalone" && backend !== "agent-collab") {
    return refused("--backend must be standalone or agent-collab");
  }
  const bound = bindWorktree(deps, cwd, backend satisfies Backend);
  if (!bound.ok) return refused(bound.error, { code: bound.code });
  return {
    output: `Worktree ${bound.value.worktreeId} uses the ${bound.value.backend} writer authority for every HMR writer entrance.`,
    json: { ok: true, ...bound.value },
    code: 0,
  };
}

export async function executeWorkflowStart(
  deps: WorkflowDeps,
  input: { cwd: string; briefFile: string; env: NodeJS.Dict<string>; parent?: string },
): Promise<CommandResult> {
  if (!isHerdrEnv(input.env)) {
    return refused(
      "HERDR_ENV=1 is required to start a workflow; run inside a Herdr pane, or preview with `workflow plan`.",
    );
  }
  const read = readText(input.briefFile, "brief");
  if (!read.ok) return read.result;
  const parsed = parseBriefInput(read.text);
  if (!parsed.ok) return refused(parsed.error, { code: "invalid-brief" });
  const started = await startWorkflow(deps, {
    brief: parsed.value,
    cwd: input.cwd,
    ...(input.parent !== undefined ? { parent: input.parent } : {}),
  });
  const id = started.ok ? started.value.workflow.id : undefined;
  return fromStep(started, deps, id, ({ workflow, attempt }) =>
    attempt.sendState === "sent" ||
    attempt.sendState === "working" ||
    attempt.sendState === "blocked"
      ? `Workflow ${workflow.id} started; the writer received attempt ${attempt.id} once. This is dispatch, not completion.`
      : `Workflow ${workflow.id}: attempt ${attempt.id} is ${attempt.sendState}. Nothing is resent; inspect with \`workflow recover ${workflow.id}\`.`,
  );
}

export function executeWorkflowStatus(
  deps: Pick<WorkflowDeps, "workflows" | "dispatch">,
  id: string | undefined,
  limit = 20,
): CommandResult {
  if (!id) {
    const workflows = deps.workflows.list(limit);
    return {
      output:
        workflows.length === 0
          ? "No workflows yet."
          : workflows
              .map(
                (workflow) =>
                  `${workflow.id}  ${workflow.state}  ${workflow.backend}  ${workflow.writerRole}  ${workflow.createdAt}`,
              )
              .join("\n"),
      json: workflows,
      code: 0,
    };
  }
  const report = workflowReport(deps, id);
  if (!report) return refused(`Unknown workflow ${id}.`);
  return { output: formatReport(report), json: report, code: 0 };
}

export async function executeWorkflowResult(
  deps: WorkflowDeps,
  input: { workflowId: string; attempt: string; file: string; lane?: string },
): Promise<CommandResult> {
  const read = readText(input.file, "result");
  if (!read.ok) return read.result;
  const recorded = await recordResult(deps, {
    workflowId: input.workflowId,
    expectedAttemptId: input.attempt,
    text: read.text,
    ...(input.lane ? { laneId: input.lane } : {}),
  });
  return fromStep(recorded, deps, input.workflowId, ({ result }) =>
    result.lane === "writer"
      ? `Recorded the writer's ${result.status} result for attempt ${result.attemptId}. A result is not acceptance and releases nothing.`
      : `Recorded verifier lane ${result.verifierLaneId}: ${result.status}.`,
  );
}

export async function executeWorkflowVerify(
  deps: WorkflowDeps,
  input: { workflowId: string; attempt: string },
): Promise<CommandResult> {
  const verified = await verifyWorkflow(deps, {
    workflowId: input.workflowId,
    expectedAttemptId: input.attempt,
  });
  return fromStep(
    verified,
    deps,
    input.workflowId,
    () =>
      "Read-only verifier lanes started on the writer's exact revision. Record each lane's result with `workflow result --lane`.",
  );
}

export async function executeWorkflowRevise(
  deps: WorkflowDeps,
  input: { workflowId: string; attempt: string; file?: string; resume?: boolean },
): Promise<CommandResult> {
  let delta: string | undefined;
  if (input.resume) {
    if (input.file) return refused("--resume sends the recorded prompt; it takes no --file.");
  } else {
    if (!input.file)
      return refused("--file <changes> is required (or --resume for a pending revision).");
    const read = readText(input.file, "revision request");
    if (!read.ok) return read.result;
    if (!read.text.trim()) return refused("The revision request is empty.");
    delta = read.text;
  }
  const revised = await reviseWorkflow(deps, {
    workflowId: input.workflowId,
    expectedAttemptId: input.attempt,
    ...(delta ? { delta } : {}),
    ...(input.resume ? { resume: true } : {}),
  });
  return fromStep(
    revised,
    deps,
    input.workflowId,
    ({ attempt }) =>
      `Revision attempt ${attempt.id} went to the same writer session: ${attempt.sendState}.`,
  );
}

export async function executeWorkflowAccept(
  deps: WorkflowDeps,
  input: { workflowId: string; attempt: string; evidence?: string },
): Promise<CommandResult> {
  const evidence = requireEvidence(input.evidence);
  if (!evidence)
    return refused("--evidence <text> is required: say why this revision is accepted.");
  const accepted = await acceptWorkflow(deps, {
    workflowId: input.workflowId,
    expectedAttemptId: input.attempt,
    evidence,
  });
  return fromStep(
    accepted,
    deps,
    input.workflowId,
    () =>
      "Accepted. The writer still holds the worktree until delivery is recorded and the workflow is released.",
  );
}

export async function executeWorkflowDelivery(
  deps: WorkflowDeps,
  input: { workflowId: string; evidence?: string; notApplicable: boolean; commit?: string },
): Promise<CommandResult> {
  const evidence = requireEvidence(input.evidence);
  if (!evidence)
    return refused(
      "--evidence <text> is required: name the authorized delivery (commit, PR, CI) or why none applies.",
    );
  if (input.notApplicable && input.commit) {
    return refused("--commit names delivered work; it cannot be combined with --not-applicable.");
  }
  const delivered = recordDelivery(deps, {
    workflowId: input.workflowId,
    evidence,
    notApplicable: input.notApplicable,
    ...(input.commit ? { commit: input.commit } : {}),
  });
  return fromStep(delivered, deps, input.workflowId, () =>
    input.notApplicable
      ? "Recorded that delivery does not apply."
      : "Recorded the delivery evidence. HMR did not commit, push, merge, or deploy anything.",
  );
}

export async function executeWorkflowRelease(
  deps: WorkflowDeps,
  input: { workflowId: string; evidence?: string; abort: boolean },
): Promise<CommandResult> {
  const evidence = requireEvidence(input.evidence);
  if (!evidence) return refused("--evidence <text> is required.");
  const released = await releaseWorkflow(deps, {
    workflowId: input.workflowId,
    evidence,
    abort: input.abort,
  });
  return fromStep(
    released,
    deps,
    input.workflowId,
    ({ workflow }) =>
      `Workflow ${workflow.id} is ${workflow.state}; the worktree's writer authority is free.`,
  );
}

export async function executeWorkflowRecover(
  deps: WorkflowDeps,
  input: { workflowId: string; delivered?: boolean; notDelivered?: boolean; evidence?: string },
): Promise<CommandResult> {
  const recording = Boolean(input.delivered) || Boolean(input.notDelivered);
  if (recording && Boolean(input.delivered) === Boolean(input.notDelivered)) {
    return refused("Pass at most one of --delivered or --not-delivered.");
  }
  const evidence = requireEvidence(input.evidence);
  if (recording && !evidence)
    return refused("--evidence <text> is required with --delivered or --not-delivered.");
  const recovered = await recoverWorkflow(deps, {
    workflowId: input.workflowId,
    ...(recording
      ? { observed: { delivered: Boolean(input.delivered), evidence: evidence! } }
      : {}),
  });
  if (!recovered.ok) return fromStep(recovered, deps, input.workflowId, () => "");
  return {
    output: formatReport(recovered.value.report),
    json: { ok: true, ...recovered.value },
    code: 0,
  };
}

export type { WorkflowRepository };
