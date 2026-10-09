import { reviseTask, type DispatchDeps } from "../rules/dispatch.js";
import { UnresolvedAttemptError, type DispatchRepository } from "../store/dispatch-repository.js";
import type { CommandResult } from "./rules-commands.js";

const NOT_COMPLETION =
  "An idle or finished-looking pane is not completion: a task completes only with `task complete <id> --evidence ...`.";

function fail(error: string, code = 2, extra: Record<string, unknown> = {}): CommandResult {
  return { output: error, json: { ok: false, error, ...extra }, code };
}

function requireEvidence(evidence: string | undefined): string | undefined {
  const trimmed = evidence?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/** Everything recorded for one task: lanes, attempts, ownership. Read from the store only. */
export function taskReport(store: DispatchRepository, id: string) {
  const task = store.getTask(id);
  if (!task) return undefined;
  const lanes = store.lanes(id).map((lane) => ({ ...lane, attempts: store.attempts(lane.id) }));
  return { task, ownership: store.ownershipOfTask(id) ?? null, lanes };
}

export function executeTaskStatus(
  store: DispatchRepository,
  id: string | undefined,
  limit = 20,
): CommandResult {
  if (!id) {
    const tasks = store.listTasks(limit);
    return {
      output:
        tasks.length === 0
          ? "No rules-mode tasks yet."
          : tasks
              .map(
                (task) =>
                  `${task.id}  ${task.status}  ${task.access === "write" ? "writer" : "read-only"}  ${task.role}  ${task.createdAt}`,
              )
              .join("\n"),
      json: tasks,
      code: 0,
    };
  }
  const report = taskReport(store, id);
  if (!report) return fail(`Unknown task ${id}.`);
  const lines = [
    `Task ${report.task.id}: ${report.task.status} (${report.task.kind}, ${report.task.access === "write" ? "writer" : "read-only"}, role ${report.task.role})`,
    `Worktree: ${report.task.worktreeId}${report.ownership ? ` (owned since ${report.ownership.acquiredAt})` : ""}`,
    ...(report.task.closingEvidence ? [`Closing evidence: ${report.task.closingEvidence}`] : []),
    ...report.lanes.flatMap((lane) => [
      `Lane ${lane.index} [${lane.id}] ${lane.descriptor}: ${lane.state}${lane.paneId ? ` pane ${lane.paneId}` : ""}${lane.agentName ? ` agent ${lane.agentName}` : ""}${lane.error ? ` error: ${lane.error}` : ""}`,
      ...lane.attempts.map(
        (attempt) =>
          `  attempt ${attempt.seq} [${attempt.id}] ${attempt.purpose}: ${attempt.state === "sending" ? "sending (no outcome recorded; the router may have stopped mid-send)" : attempt.state}${attempt.evidence ? ` (${attempt.evidence})` : ""}`,
      ),
    ]),
    NOT_COMPLETION,
  ];
  return { output: lines.join("\n"), json: report, code: 0 };
}

export function executeTaskClose(
  store: DispatchRepository,
  id: string,
  input: { status: "complete" | "released"; evidence?: string; stopped?: boolean },
): CommandResult {
  const evidence = requireEvidence(input.evidence);
  if (!evidence)
    return fail(
      "--evidence <text> is required: say what shows the task is finished or the writer stopped.",
    );
  if (input.status === "released" && !input.stopped) {
    return fail(
      "Release needs --stopped: confirm the writer has stopped. Use `task complete` for finished work.",
    );
  }
  try {
    const task = store.closeTask(id, input.status, evidence);
    return {
      output: `Task ${task.id} is ${task.status}; its worktree ownership was released.`,
      json: { ok: true, task },
      code: 0,
    };
  } catch (error) {
    return fail(
      (error as Error).message,
      2,
      error instanceof UnresolvedAttemptError ? { attempt: error.attempt } : {},
    );
  }
}

export function executeTaskRecover(
  store: DispatchRepository,
  attemptId: string,
  input: { delivered?: boolean; notDelivered?: boolean; evidence?: string },
): CommandResult {
  const evidence = requireEvidence(input.evidence);
  if (Boolean(input.delivered) === Boolean(input.notDelivered)) {
    return fail("Pass exactly one of --delivered or --not-delivered.");
  }
  if (!evidence) return fail("--evidence <text> is required: say what you saw in the pane.");
  try {
    const attempt = store.recoverAttempt(attemptId, Boolean(input.delivered), evidence);
    return {
      output: `Attempt ${attempt.id} recorded as ${attempt.state}.`,
      json: { ok: true, attempt },
      code: 0,
    };
  } catch (error) {
    return fail((error as Error).message);
  }
}

export async function executeTaskRevise(
  deps: DispatchDeps,
  id: string,
  text: string,
): Promise<CommandResult> {
  const result = await reviseTask({ taskId: id, text, deps });
  if (!result.ok) return fail(result.error, 2, { code: result.code });
  const { attempt, lane } = result;
  const delivered = ["sent", "working", "blocked"].includes(attempt.state);
  return {
    output:
      `Revision attempt ${attempt.id} to ${lane.agentName} in pane ${lane.paneId} (${lane.descriptor}): ${attempt.state}` +
      `${attempt.evidence ? ` (${attempt.evidence})` : ""}\n${NOT_COMPLETION}`,
    json: {
      ok: delivered,
      taskId: id,
      laneId: lane.id,
      paneId: lane.paneId,
      agentName: lane.agentName,
      attempt,
    },
    code: delivered ? 0 : 1,
  };
}
