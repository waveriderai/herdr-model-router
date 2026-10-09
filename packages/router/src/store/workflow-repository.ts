import { randomUUID } from "node:crypto";
import os from "node:os";
import type Database from "better-sqlite3";
import type { BoundIdentity } from "../workflow/identity.js";
import type { Revision } from "../workflow/contracts.js";

export type Backend = "standalone" | "agent-collab";
export const BACKENDS: readonly Backend[] = ["standalone", "agent-collab"];

export type WorkflowState =
  | "starting"
  | "dispatched"
  | "unknown"
  | "receipt"
  | "verifying"
  | "reviewed"
  | "revision"
  | "accepted"
  | "delivered"
  | "released"
  | "aborted"
  | "failed";

export const FINAL_WORKFLOW_STATES: readonly WorkflowState[] = ["released", "aborted", "failed"];

export type SendState =
  "pending" | "sending" | "sent" | "working" | "blocked" | "unknown" | "not-delivered";

export const DELIVERED_SEND_STATES: readonly SendState[] = ["sent", "working", "blocked"];
export const UNRESOLVED_SEND_STATES: readonly SendState[] = ["pending", "sending", "unknown"];

export interface Workflow {
  id: string;
  worktreeId: string;
  backend: Backend;
  state: WorkflowState;
  briefSha256: string;
  writerRole: string;
  writerDescriptor: string;
  cwd: string;
  baseline: Revision;
  /** The parent descriptor that resolved parent aliases at start. */
  parentDescriptor?: string;
  taskId?: string;
  externalRunId?: string;
  /** agent-collab startup pane, and whether its close was confirmed (undefined: still open). */
  startPane?: { id: string; closed?: boolean };
  identity?: BoundIdentity;
  accepted?: { attemptId: string; revision: Revision; evidence?: string };
  delivery?: { kind: "delivered" | "not-applicable"; evidence: string; head?: string };
  closingEvidence?: string;
  /** The coordinator operation in progress, if any. */
  operation?: { name: string; pid: number; host: string; startedAt: string };
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowAttempt {
  id: string;
  workflowId: string;
  seq: number;
  purpose: "initial" | "revision";
  promptSha256: string;
  backendAttempt?: string;
  sendState: SendState;
  sendEvidence?: string;
  result?: { sha256: string; status: string; revision: Revision };
  createdAt: string;
  updatedAt: string;
}

export interface Verification {
  id: string;
  workflowId: string;
  attemptId: string;
  role: string;
  taskId?: string;
  revision: Revision;
  createdAt: string;
}

export interface VerifierResultRow {
  verificationId: string;
  laneId: string;
  resultSha256: string;
  status: "pass" | "fail" | "blocked";
  recordedAt: string;
}

export interface Intent {
  id: string;
  workflowId: string;
  operation: string;
  attemptId?: string;
  backendAttempt?: string;
  /** What the call is expected to change, for read-only reconciliation. Never a secret. */
  payload: Record<string, unknown>;
  state: "pending" | "observed" | "done" | "refused" | "unknown";
  observed?: string;
  createdAt: string;
  updatedAt: string;
}

/** A mutation refused because the workflow is not where the caller expected it to be. */
export class WorkflowStateError extends Error {
  constructor(
    message: string,
    readonly code: string = "state-conflict",
  ) {
    super(message);
  }
}

export class WriterAuthorityError extends Error {
  constructor(
    message: string,
    readonly code:
      "bound-to-agent-collab" | "bound-to-standalone" | "open-workflow" | "writer-owned",
  ) {
    super(message);
  }
}

interface WorkflowRow {
  id: string;
  worktree_id: string;
  backend: Backend;
  state: WorkflowState;
  brief_sha256: string;
  writer_role: string;
  writer_descriptor: string;
  parent_descriptor: string | null;
  cwd: string;
  baseline_head: string;
  baseline_content: string;
  task_id: string | null;
  external_run_id: string | null;
  start_pane_id: string | null;
  start_pane_closed: number | null;
  agent_name: string | null;
  agent_kind: string | null;
  pane_id: string | null;
  session_id: string | null;
  session_cwd: string | null;
  accepted_attempt_id: string | null;
  accepted_head: string | null;
  accepted_content: string | null;
  acceptance_evidence: string | null;
  delivery_kind: "delivered" | "not-applicable" | null;
  delivery_evidence: string | null;
  delivered_head: string | null;
  closing_evidence: string | null;
  op_token: string | null;
  op_name: string | null;
  op_pid: number | null;
  op_host: string | null;
  op_started_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AttemptRow {
  id: string;
  workflow_id: string;
  seq: number;
  purpose: WorkflowAttempt["purpose"];
  prompt_sha256: string;
  backend_attempt: string | null;
  send_state: SendState;
  send_evidence: string | null;
  result_sha256: string | null;
  result_status: string | null;
  result_head: string | null;
  result_content: string | null;
  created_at: string;
  updated_at: string;
}

function workflow(row: WorkflowRow): Workflow {
  const identity =
    row.agent_name && row.agent_kind && row.pane_id && row.session_id && row.session_cwd
      ? {
          agentName: row.agent_name,
          kind: row.agent_kind,
          paneId: row.pane_id,
          sessionId: row.session_id,
          cwd: row.session_cwd,
        }
      : undefined;
  return {
    id: row.id,
    worktreeId: row.worktree_id,
    backend: row.backend,
    state: row.state,
    briefSha256: row.brief_sha256,
    writerRole: row.writer_role,
    writerDescriptor: row.writer_descriptor,
    cwd: row.cwd,
    baseline: { head: row.baseline_head, content: row.baseline_content },
    ...(row.parent_descriptor ? { parentDescriptor: row.parent_descriptor } : {}),
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.external_run_id ? { externalRunId: row.external_run_id } : {}),
    ...(row.start_pane_id
      ? {
          startPane: {
            id: row.start_pane_id,
            ...(row.start_pane_closed === null ? {} : { closed: row.start_pane_closed === 1 }),
          },
        }
      : {}),
    ...(identity ? { identity } : {}),
    ...(row.accepted_attempt_id && row.accepted_head && row.accepted_content
      ? {
          accepted: {
            attemptId: row.accepted_attempt_id,
            revision: { head: row.accepted_head, content: row.accepted_content },
            ...(row.acceptance_evidence ? { evidence: row.acceptance_evidence } : {}),
          },
        }
      : {}),
    ...(row.delivery_kind && row.delivery_evidence
      ? {
          delivery: {
            kind: row.delivery_kind,
            evidence: row.delivery_evidence,
            ...(row.delivered_head ? { head: row.delivered_head } : {}),
          },
        }
      : {}),
    ...(row.closing_evidence ? { closingEvidence: row.closing_evidence } : {}),
    ...(row.op_token && row.op_name && row.op_pid !== null && row.op_host && row.op_started_at
      ? {
          operation: {
            name: row.op_name,
            pid: row.op_pid,
            host: row.op_host,
            startedAt: row.op_started_at,
          },
        }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function attempt(row: AttemptRow): WorkflowAttempt {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    seq: row.seq,
    purpose: row.purpose,
    promptSha256: row.prompt_sha256,
    ...(row.backend_attempt ? { backendAttempt: row.backend_attempt } : {}),
    sendState: row.send_state,
    ...(row.send_evidence ? { sendEvidence: row.send_evidence } : {}),
    ...(row.result_sha256 && row.result_status && row.result_head && row.result_content
      ? {
          result: {
            sha256: row.result_sha256,
            status: row.result_status,
            revision: { head: row.result_head, content: row.result_content },
          },
        }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Workflow columns a transition may set; the state column is set by `setState` itself. */
type WorkflowColumn =
  | "parent_descriptor"
  | "start_pane_id"
  | "start_pane_closed"
  | "acceptance_evidence"
  | "task_id"
  | "external_run_id"
  | "agent_name"
  | "agent_kind"
  | "pane_id"
  | "session_id"
  | "session_cwd"
  | "accepted_attempt_id"
  | "accepted_head"
  | "accepted_content"
  | "delivery_kind"
  | "delivery_evidence"
  | "delivered_head"
  | "closing_evidence";
export type WorkflowFields = Partial<Record<WorkflowColumn, string | null>>;

/** The token that lets one operation commit transitions; held from reservation to release. */
export interface OperationLease {
  workflowId: string;
  token: string;
  name: string;
}

/** A slot held by a process that no longer exists on this host. Other hosts are never stale. */
function operationIsStale(row: Pick<WorkflowRow, "op_pid" | "op_host">): boolean {
  if (row.op_pid === null || row.op_host !== os.hostname()) return false;
  if (row.op_pid === process.pid) return false;
  try {
    process.kill(row.op_pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

const OPEN_STATES_SQL = "state not in ('released', 'aborted', 'failed')";

/**
 * Who may write in a worktree, read and decided inside the caller's transaction. Shared by
 * the workflow store and the rules-mode dispatch store, so every writer entrance sees the
 * same binding, the same open workflow, and the same ownership row.
 */
export function bindingOf(db: Database.Database, worktreeId: string): Backend {
  const row = db
    .prepare("select backend from worktree_bindings where worktree_id = ?")
    .get(worktreeId) as { backend: Backend } | undefined;
  return row?.backend ?? "standalone";
}

export function openWorkflowOn(
  db: Database.Database,
  worktreeId: string,
): { id: string; backend: Backend; state: WorkflowState } | undefined {
  return db
    .prepare(
      `select id, backend, state from workflows where worktree_id = ? and ${OPEN_STATES_SQL}`,
    )
    .get(worktreeId) as { id: string; backend: Backend; state: WorkflowState } | undefined;
}

/**
 * Refusal for a writer that is not part of `allowedWorkflowId`. `undefined` means this writer
 * may take standalone ownership. Does not look at writer_ownership: the caller does.
 */
export function writerAuthorityRefusal(
  db: Database.Database,
  worktreeId: string,
  allowedWorkflowId?: string,
): WriterAuthorityError | undefined {
  if (bindingOf(db, worktreeId) === "agent-collab") {
    return new WriterAuthorityError(
      `Worktree ${worktreeId} is bound to the agent-collab writer authority; HMR does not start a standalone writer there. ` +
        "Use `workflow start` (it goes through agent-collab), or rebind with `workflow bind --backend standalone` when nothing is active.",
      "bound-to-agent-collab",
    );
  }
  const open = openWorkflowOn(db, worktreeId);
  if (open && open.id !== allowedWorkflowId) {
    return new WriterAuthorityError(
      `Worktree ${worktreeId} has open workflow ${open.id} (${open.state}); its writer holds the worktree until that workflow is released.`,
      "open-workflow",
    );
  }
  return undefined;
}

export class WorkflowRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  binding(worktreeId: string): { backend: Backend; explicit: boolean } {
    const row = this.db
      .prepare("select backend from worktree_bindings where worktree_id = ?")
      .get(worktreeId) as { backend: Backend } | undefined;
    return row
      ? { backend: row.backend, explicit: true }
      : { backend: "standalone", explicit: false };
  }

  /** Binds a worktree to one writer authority. Refused while any writer or workflow is active. */
  setBinding(worktreeId: string, backend: Backend): void {
    const bind = this.db.transaction(() => {
      const open = openWorkflowOn(this.db, worktreeId);
      if (open) {
        throw new WriterAuthorityError(
          `Workflow ${open.id} is open on ${worktreeId}; its backend cannot change until it is released or aborted.`,
          "open-workflow",
        );
      }
      const owner = this.db
        .prepare("select task_id from writer_ownership where worktree_id = ?")
        .get(worktreeId) as { task_id: string } | undefined;
      if (owner) {
        throw new WriterAuthorityError(
          `Writer task ${owner.task_id} owns ${worktreeId}; close it before changing the writer authority.`,
          "writer-owned",
        );
      }
      this.db
        .prepare(
          `insert into worktree_bindings (worktree_id, backend, updated_at) values (?, ?, ?)
           on conflict (worktree_id) do update set backend = excluded.backend, updated_at = excluded.updated_at`,
        )
        .run(worktreeId, backend, this.now());
    });
    bind.immediate();
  }

  /** Legacy and rules-mode writer entrances call this before acting; see writerAuthorityRefusal. */
  legacyWriterRefusal(worktreeId: string, allowTaskId?: string): WriterAuthorityError | undefined {
    const refusal = writerAuthorityRefusal(this.db, worktreeId);
    if (refusal) return refusal;
    const owner = this.db
      .prepare("select task_id from writer_ownership where worktree_id = ?")
      .get(worktreeId) as { task_id: string } | undefined;
    return owner && owner.task_id !== allowTaskId
      ? new WriterAuthorityError(
          `Writer task ${owner.task_id} owns ${worktreeId}; no other writer is started there.`,
          "writer-owned",
        )
      : undefined;
  }

  /**
   * Refusal for prompting `paneId` from outside its owner: the bound writer pane of an open
   * workflow, or a lane pane of an open rules-mode writer task.
   */
  writerPaneRefusal(paneId: string, allowTaskId?: string): WriterAuthorityError | undefined {
    const workflow = this.db
      .prepare(`select id from workflows where pane_id = ? and ${OPEN_STATES_SQL} limit 1`)
      .get(paneId) as { id: string } | undefined;
    if (workflow) {
      return new WriterAuthorityError(
        `Pane ${paneId} is the writer of open workflow ${workflow.id}; only that workflow prompts it.`,
        "open-workflow",
      );
    }
    const task = this.db
      .prepare(
        `select o.task_id from writer_ownership o join dispatch_lanes l on l.task_id = o.task_id
         where l.pane_id = ? and o.task_id is not ? limit 1`,
      )
      .get(paneId, allowTaskId ?? null) as { task_id: string } | undefined;
    return task
      ? new WriterAuthorityError(
          `Pane ${paneId} is the writer of task ${task.task_id}; only \`task revise\` prompts it.`,
          "writer-owned",
        )
      : undefined;
  }

  /**
   * Opens a workflow and its first attempt in one IMMEDIATE transaction. The backend must be
   * the worktree's binding, no other workflow may be open, and no standalone writer may own it.
   */
  createWorkflow(input: {
    worktreeId: string;
    backend: Backend;
    briefSha256: string;
    writerRole: string;
    writerDescriptor: string;
    cwd: string;
    baseline: Revision;
    promptSha256: string;
    parentDescriptor?: string;
    id?: string;
    attemptId?: string;
  }): { workflow: Workflow; attempt: WorkflowAttempt; lease: OperationLease } {
    const id = input.id ?? `wf_${randomUUID()}`;
    const attemptId = input.attemptId ?? `wfa_${randomUUID()}`;
    const token = `op_${randomUUID()}`;
    const create = this.db.transaction(() => {
      const bound = bindingOf(this.db, input.worktreeId);
      if (bound !== input.backend) {
        throw new WriterAuthorityError(
          `Worktree ${input.worktreeId} is bound to ${bound}, not ${input.backend}. Nothing was started.`,
          bound === "agent-collab" ? "bound-to-agent-collab" : "bound-to-standalone",
        );
      }
      const open = openWorkflowOn(this.db, input.worktreeId);
      if (open) {
        throw new WriterAuthorityError(
          `Workflow ${open.id} is already open on ${input.worktreeId}. Nothing was started.`,
          "open-workflow",
        );
      }
      const owner = this.db
        .prepare("select task_id from writer_ownership where worktree_id = ?")
        .get(input.worktreeId) as { task_id: string } | undefined;
      if (owner) {
        throw new WriterAuthorityError(
          `Writer task ${owner.task_id} owns ${input.worktreeId}. Nothing was started.`,
          "writer-owned",
        );
      }
      const at = this.now();
      this.db
        .prepare(
          `insert into workflows (id, worktree_id, backend, state, brief_sha256, writer_role, writer_descriptor,
             parent_descriptor, cwd, baseline_head, baseline_content,
             op_token, op_name, op_pid, op_host, op_started_at, created_at, updated_at)
           values (?, ?, ?, 'starting', ?, ?, ?, ?, ?, ?, ?, ?, 'start', ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.worktreeId,
          input.backend,
          input.briefSha256,
          input.writerRole,
          input.writerDescriptor,
          input.parentDescriptor ?? null,
          input.cwd,
          input.baseline.head,
          input.baseline.content,
          token,
          process.pid,
          os.hostname(),
          at,
          at,
          at,
        );
      this.insertAttempt(id, attemptId, 1, "initial", input.promptSha256, at);
    });
    create.immediate();
    return {
      workflow: this.get(id)!,
      attempt: this.getAttempt(attemptId)!,
      lease: { workflowId: id, token, name: "start" },
    };
  }

  private insertAttempt(
    workflowId: string,
    attemptId: string,
    seq: number,
    purpose: WorkflowAttempt["purpose"],
    promptSha: string,
    at: string,
  ): void {
    this.db
      .prepare(
        `insert into workflow_attempts (id, workflow_id, seq, purpose, prompt_sha256, send_state, created_at, updated_at)
         values (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(attemptId, workflowId, seq, purpose, promptSha, at, at);
  }

  /**
   * Reserves the workflow for one coordinator operation before any await: compare-and-set in
   * one IMMEDIATE transaction on its state, current attempt, and a free operation slot. A slot
   * held by a process that no longer exists on this host is taken over; any other holder
   * refuses. With `allowUnresolvedIntent` false, an unresolved external intent also refuses.
   */
  reserveOperation(
    workflowId: string,
    name: string,
    expectation: {
      from: readonly WorkflowState[];
      expectedAttemptId?: string;
      allowUnresolvedIntent?: boolean;
    },
  ): OperationLease {
    const token = `op_${randomUUID()}`;
    const reserve = this.db.transaction(() => {
      const row = this.db.prepare("select * from workflows where id = ?").get(workflowId) as
        WorkflowRow | undefined;
      if (!row) throw new WorkflowStateError(`Unknown workflow ${workflowId}.`, "unknown-workflow");
      if (row.op_token && !operationIsStale(row)) {
        throw new WorkflowStateError(
          `Workflow ${workflowId} is busy: \`${row.op_name}\` started ${row.op_started_at} (pid ${row.op_pid} on ${row.op_host}). Nothing was changed.`,
          "operation-in-progress",
        );
      }
      if (!expectation.from.includes(row.state)) {
        throw new WorkflowStateError(
          `Workflow ${workflowId} is ${row.state}; \`${name}\` needs ${expectation.from.join(" or ")}.`,
        );
      }
      const latest = this.currentAttempt(workflowId);
      if (
        expectation.expectedAttemptId !== undefined &&
        latest?.id !== expectation.expectedAttemptId
      ) {
        throw new WorkflowStateError(
          `Attempt ${expectation.expectedAttemptId} is not the current attempt of ${workflowId}` +
            (latest ? ` (current: ${latest.id})` : "") +
            ". Nothing was changed.",
          "stale-attempt",
        );
      }
      const unresolved = this.unresolvedIntent(workflowId);
      if (unresolved && !expectation.allowUnresolvedIntent) {
        throw new WorkflowStateError(
          `External ${unresolved.operation} for ${workflowId} is ${unresolved.state}; run \`workflow recover ${workflowId}\` first. Nothing was changed.`,
          "intent-unresolved",
        );
      }
      this.db
        .prepare(
          "update workflows set op_token = ?, op_name = ?, op_pid = ?, op_host = ?, op_started_at = ? where id = ?",
        )
        .run(token, name, process.pid, os.hostname(), this.now(), workflowId);
    });
    reserve.immediate();
    return { workflowId, token, name };
  }

  /**
   * Applies a transition only while `lease` still holds the workflow and it is not closed,
   * in one IMMEDIATE transaction. A stale lease, or a workflow another path already ended,
   * changes nothing.
   */
  commit<T>(lease: OperationLease, apply: (current: Workflow) => T): T {
    const run = this.db.transaction(() => {
      const row = this.db.prepare("select * from workflows where id = ?").get(lease.workflowId) as
        WorkflowRow | undefined;
      if (!row || row.op_token !== lease.token) {
        throw new WorkflowStateError(
          `The ${lease.name} operation on ${lease.workflowId} no longer holds it; nothing was recorded.`,
          "operation-lost",
        );
      }
      if (FINAL_WORKFLOW_STATES.includes(row.state)) {
        throw new WorkflowStateError(`Workflow ${lease.workflowId} is already ${row.state}.`);
      }
      return apply(workflow(row));
    });
    return run.immediate();
  }

  /** Ends an operation; a no-op when the lease was already lost. */
  releaseOperation(lease: OperationLease): void {
    this.db
      .prepare(
        "update workflows set op_token = null, op_name = null, op_pid = null, op_host = null, op_started_at = null where id = ? and op_token = ?",
      )
      .run(lease.workflowId, lease.token);
  }

  get(id: string): Workflow | undefined {
    const row = this.db.prepare("select * from workflows where id = ?").get(id) as
      WorkflowRow | undefined;
    return row ? workflow(row) : undefined;
  }

  list(limit: number): Workflow[] {
    return (
      this.db
        .prepare("select * from workflows order by created_at desc, rowid desc limit ?")
        .all(limit) as WorkflowRow[]
    ).map(workflow);
  }

  forTask(taskId: string): Workflow | undefined {
    const row = this.db
      .prepare(
        `select w.* from workflows w
         where w.task_id = ?
            or w.id in (select workflow_id from workflow_verifications where task_id = ?)
         limit 1`,
      )
      .get(taskId, taskId) as WorkflowRow | undefined;
    return row ? workflow(row) : undefined;
  }

  attempts(workflowId: string): WorkflowAttempt[] {
    return (
      this.db
        .prepare("select * from workflow_attempts where workflow_id = ? order by seq")
        .all(workflowId) as AttemptRow[]
    ).map(attempt);
  }

  getAttempt(id: string): WorkflowAttempt | undefined {
    const row = this.db.prepare("select * from workflow_attempts where id = ?").get(id) as
      AttemptRow | undefined;
    return row ? attempt(row) : undefined;
  }

  currentAttempt(workflowId: string): WorkflowAttempt | undefined {
    const row = this.db
      .prepare("select * from workflow_attempts where workflow_id = ? order by seq desc limit 1")
      .get(workflowId) as AttemptRow | undefined;
    return row ? attempt(row) : undefined;
  }

  /**
   * Applies `apply` only while the workflow is in one of `from` and `expectedAttemptId` is its
   * current attempt, all in one IMMEDIATE transaction. A stale caller changes nothing.
   */
  guarded<T>(
    workflowId: string,
    expectation: { from: readonly WorkflowState[]; expectedAttemptId?: string },
    apply: (current: Workflow, attempt: WorkflowAttempt | undefined) => T,
  ): T {
    const run = this.db.transaction(() => {
      const current = this.get(workflowId);
      if (!current)
        throw new WorkflowStateError(`Unknown workflow ${workflowId}.`, "unknown-workflow");
      if (!expectation.from.includes(current.state)) {
        throw new WorkflowStateError(
          `Workflow ${workflowId} is ${current.state}; this step needs ${expectation.from.join(" or ")}.`,
        );
      }
      const latest = this.currentAttempt(workflowId);
      if (
        expectation.expectedAttemptId !== undefined &&
        latest?.id !== expectation.expectedAttemptId
      ) {
        throw new WorkflowStateError(
          `Attempt ${expectation.expectedAttemptId} is not the current attempt of ${workflowId}` +
            (latest ? ` (current: ${latest.id})` : "") +
            ". Nothing was changed.",
          "stale-attempt",
        );
      }
      return apply(current, latest);
    });
    return run.immediate();
  }

  setState(workflowId: string, state: WorkflowState, extra: WorkflowFields = {}): void {
    const columns = Object.keys(extra) as WorkflowColumn[];
    const assignments = [
      "state = ?",
      "updated_at = ?",
      ...columns.map((column) => `${column} = ?`),
    ];
    this.db
      .prepare(`update workflows set ${assignments.join(", ")} where id = ?`)
      .run(state, this.now(), ...columns.map((column) => extra[column] ?? null), workflowId);
  }

  setFields(workflowId: string, fields: WorkflowFields): void {
    const columns = Object.keys(fields) as WorkflowColumn[];
    if (columns.length === 0) return;
    this.db
      .prepare(
        `update workflows set ${columns.map((column) => `${column} = ?`).join(", ")}, updated_at = ? where id = ?`,
      )
      .run(...columns.map((column) => fields[column] ?? null), this.now(), workflowId);
  }

  bindIdentity(workflowId: string, identity: BoundIdentity): void {
    this.setFields(workflowId, {
      agent_name: identity.agentName,
      agent_kind: identity.kind,
      pane_id: identity.paneId,
      session_id: identity.sessionId,
      session_cwd: identity.cwd,
    });
  }

  updateAttempt(
    attemptId: string,
    patch: { sendState?: SendState; sendEvidence?: string; backendAttempt?: string },
  ): void {
    const current = this.getAttempt(attemptId);
    if (!current) throw new Error(`Unknown workflow attempt ${attemptId}`);
    this.db
      .prepare(
        "update workflow_attempts set send_state = ?, send_evidence = ?, backend_attempt = ?, updated_at = ? where id = ?",
      )
      .run(
        patch.sendState ?? current.sendState,
        patch.sendEvidence ?? current.sendEvidence ?? null,
        patch.backendAttempt ?? current.backendAttempt ?? null,
        this.now(),
        attemptId,
      );
  }

  recordResult(
    attemptId: string,
    result: { sha256: string; status: string; revision: Revision },
  ): void {
    this.db
      .prepare(
        "update workflow_attempts set result_sha256 = ?, result_status = ?, result_head = ?, result_content = ?, updated_at = ? where id = ?",
      )
      .run(
        result.sha256,
        result.status,
        result.revision.head,
        result.revision.content,
        this.now(),
        attemptId,
      );
  }

  addAttempt(workflowId: string, promptSha: string, id = `wfa_${randomUUID()}`): WorkflowAttempt {
    const latest = this.currentAttempt(workflowId);
    this.insertAttempt(workflowId, id, (latest?.seq ?? 0) + 1, "revision", promptSha, this.now());
    return this.getAttempt(id)!;
  }

  addVerification(input: {
    workflowId: string;
    attemptId: string;
    role: string;
    revision: Revision;
  }): Verification {
    const id = `wfv_${randomUUID()}`;
    this.db
      .prepare(
        `insert into workflow_verifications (id, workflow_id, attempt_id, role, revision_head, revision_content, created_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workflowId,
        input.attemptId,
        input.role,
        input.revision.head,
        input.revision.content,
        this.now(),
      );
    return this.getVerification(id)!;
  }

  linkVerificationTask(verificationId: string, taskId: string): void {
    this.db
      .prepare("update workflow_verifications set task_id = ? where id = ?")
      .run(taskId, verificationId);
  }

  getVerification(id: string): Verification | undefined {
    const row = this.db.prepare("select * from workflow_verifications where id = ?").get(id) as
      | {
          id: string;
          workflow_id: string;
          attempt_id: string;
          role: string;
          task_id: string | null;
          revision_head: string;
          revision_content: string;
          created_at: string;
        }
      | undefined;
    return row
      ? {
          id: row.id,
          workflowId: row.workflow_id,
          attemptId: row.attempt_id,
          role: row.role,
          ...(row.task_id ? { taskId: row.task_id } : {}),
          revision: { head: row.revision_head, content: row.revision_content },
          createdAt: row.created_at,
        }
      : undefined;
  }

  verifications(workflowId: string, attemptId?: string): Verification[] {
    const rows = this.db
      .prepare(
        `select id from workflow_verifications where workflow_id = ? ${attemptId ? "and attempt_id = ?" : ""} order by created_at, rowid`,
      )
      .all(...(attemptId ? [workflowId, attemptId] : [workflowId])) as { id: string }[];
    return rows.map((row) => this.getVerification(row.id)!);
  }

  verifierResults(verificationId: string): VerifierResultRow[] {
    return (
      this.db
        .prepare(
          "select * from workflow_verifier_results where verification_id = ? order by lane_id",
        )
        .all(verificationId) as {
        verification_id: string;
        lane_id: string;
        result_sha256: string;
        status: VerifierResultRow["status"];
        recorded_at: string;
      }[]
    ).map((row) => ({
      verificationId: row.verification_id,
      laneId: row.lane_id,
      resultSha256: row.result_sha256,
      status: row.status,
      recordedAt: row.recorded_at,
    }));
  }

  recordVerifierResult(input: Omit<VerifierResultRow, "recordedAt">): void {
    this.db
      .prepare(
        "insert into workflow_verifier_results (verification_id, lane_id, result_sha256, status, recorded_at) values (?, ?, ?, ?, ?)",
      )
      .run(input.verificationId, input.laneId, input.resultSha256, input.status, this.now());
  }

  /**
   * Records an external mutation before it is called. Refused while another intent of this
   * workflow is unresolved (a unique index), so two calls can never race or replay.
   */
  beginIntent(
    workflowId: string,
    input: {
      operation: string;
      attemptId?: string;
      backendAttempt?: string;
      payload: Record<string, unknown>;
    },
  ): Intent {
    const id = `wfi_${randomUUID()}`;
    const at = this.now();
    try {
      this.db
        .prepare(
          `insert into workflow_intents (id, workflow_id, operation, attempt_id, backend_attempt, payload, state, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          id,
          workflowId,
          input.operation,
          input.attemptId ?? null,
          input.backendAttempt ?? null,
          JSON.stringify(input.payload),
          at,
          at,
        );
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        throw new WorkflowStateError(
          `Another external operation of ${workflowId} is unresolved; run \`workflow recover ${workflowId}\`.`,
          "intent-unresolved",
        );
      }
      throw error;
    }
    return this.intents(workflowId).find((intent) => intent.id === id)!;
  }

  finishIntent(id: string, state: Exclude<Intent["state"], "pending">, observed: string): void {
    this.db
      .prepare("update workflow_intents set state = ?, observed = ?, updated_at = ? where id = ?")
      .run(state, observed, this.now(), id);
  }

  unresolvedIntent(workflowId: string): Intent | undefined {
    return this.intents(workflowId).find(
      (intent) =>
        intent.state === "pending" || intent.state === "observed" || intent.state === "unknown",
    );
  }

  intents(workflowId: string): Intent[] {
    return (
      this.db
        .prepare("select * from workflow_intents where workflow_id = ? order by created_at, rowid")
        .all(workflowId) as {
        id: string;
        workflow_id: string;
        operation: string;
        attempt_id: string | null;
        backend_attempt: string | null;
        payload: string;
        state: Intent["state"];
        observed: string | null;
        created_at: string;
        updated_at: string;
      }[]
    ).map((row) => ({
      id: row.id,
      workflowId: row.workflow_id,
      operation: row.operation,
      ...(row.attempt_id ? { attemptId: row.attempt_id } : {}),
      ...(row.backend_attempt ? { backendAttempt: row.backend_attempt } : {}),
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      state: row.state,
      ...(row.observed ? { observed: row.observed } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }
}
