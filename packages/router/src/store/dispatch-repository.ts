import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { writerAuthorityRefusal } from "./workflow-repository.js";

export type TaskStatus =
  "dispatching" | "dispatched" | "partial" | "failed" | "complete" | "released";
export type LaneState = "planned" | "pane-created" | "agent-started" | "prompted" | "failed";
/**
 * `sending` is written before the prompt goes out. An attempt left in `sending` (the process
 * stopped mid-send) or `unknown` (no evidence either way) blocks every further prompt to the
 * lane until `recover` records what happened.
 */
export type AttemptState = "sending" | "sent" | "working" | "blocked" | "unknown" | "not-delivered";

export const UNRESOLVED_ATTEMPT_STATES: readonly AttemptState[] = ["sending", "unknown"];

export interface DispatchTask {
  id: string;
  role: string;
  kind: "single" | "panel";
  access: "read" | "write";
  worktreeId: string;
  cwd: string;
  rulesPath: string;
  status: TaskStatus;
  closingEvidence?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DispatchLane {
  id: string;
  taskId: string;
  index: number;
  descriptor: string;
  provider: string;
  model: string;
  effort: string | null;
  argv: string[];
  agentName?: string;
  paneId?: string;
  /** Native session and canonical directory bound before a writer lane's first prompt. */
  sessionId?: string;
  sessionCwd?: string;
  state: LaneState;
  error?: string;
}

export interface DispatchAttempt {
  id: string;
  laneId: string;
  seq: number;
  purpose: "initial" | "revision";
  promptSha256: string;
  state: AttemptState;
  evidence?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Ownership {
  worktreeId: string;
  taskId: string;
  acquiredAt: string;
}

export class OwnershipConflictError extends Error {
  constructor(readonly owner: Ownership) {
    super(
      `Worktree ${owner.worktreeId} is owned by writer task ${owner.taskId} (since ${owner.acquiredAt}). ` +
        `Revise that task, or close it with \`task complete ${owner.taskId} --evidence ...\` or ` +
        `\`task release ${owner.taskId} --stopped --evidence ...\`. Ownership is never taken over silently.`,
    );
  }
}

export class UnresolvedAttemptError extends Error {
  constructor(readonly attempt: DispatchAttempt) {
    super(
      `Attempt ${attempt.id} is ${attempt.state}: the router cannot tell whether that prompt reached the agent, so it will not send another. ` +
        `Inspect the pane, then run \`task recover ${attempt.id} --delivered|--not-delivered --evidence ...\`.`,
    );
  }
}

/** The task was completed or released; nothing more may be sent for it. */
export class TaskClosedError extends Error {
  constructor(readonly task: DispatchTask) {
    super(`Task ${task.id} is ${task.status}; no prompt is sent for a closed task.`);
  }
}

/** A writer task that no longer owns its worktree; another task may own it now. */
export class NotOwnerError extends Error {
  constructor(
    readonly task: DispatchTask,
    readonly owner: Ownership | undefined,
  ) {
    super(
      `Task ${task.id} no longer owns worktree ${task.worktreeId}` +
        (owner ? ` (owned by ${owner.taskId})` : "") +
        "; no prompt was sent.",
    );
  }
}

/**
 * A task that belongs to an open coordinator workflow, changed from outside that workflow.
 * Enforced here, in the store, so no caller can skip it by leaving out a dependency.
 */
export class WorkflowTaskError extends Error {
  constructor(
    readonly taskId: string,
    readonly workflowId: string,
  ) {
    super(
      `Task ${taskId} belongs to open workflow ${workflowId}; change it only with \`workflow\` commands (status, recover, release ${workflowId}).`,
    );
  }
}

const CLOSED_STATUSES: readonly TaskStatus[] = ["complete", "released"];

interface TaskRow {
  id: string;
  role: string;
  kind: DispatchTask["kind"];
  access: DispatchTask["access"];
  worktree_id: string;
  cwd: string;
  rules_path: string;
  status: TaskStatus;
  closing_evidence: string | null;
  created_at: string;
  updated_at: string;
}

interface LaneRow {
  id: string;
  task_id: string;
  lane_index: number;
  descriptor: string;
  provider: string;
  model: string;
  effort: string | null;
  argv_json: string;
  agent_name: string | null;
  pane_id: string | null;
  session_id: string | null;
  session_cwd: string | null;
  state: LaneState;
  error: string | null;
}

interface AttemptRow {
  id: string;
  lane_id: string;
  seq: number;
  purpose: DispatchAttempt["purpose"];
  prompt_sha256: string;
  state: AttemptState;
  evidence: string | null;
  created_at: string;
  updated_at: string;
}

function task(row: TaskRow): DispatchTask {
  return {
    id: row.id,
    role: row.role,
    kind: row.kind,
    access: row.access,
    worktreeId: row.worktree_id,
    cwd: row.cwd,
    rulesPath: row.rules_path,
    status: row.status,
    ...(row.closing_evidence === null ? {} : { closingEvidence: row.closing_evidence }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function lane(row: LaneRow): DispatchLane {
  return {
    id: row.id,
    taskId: row.task_id,
    index: row.lane_index,
    descriptor: row.descriptor,
    provider: row.provider,
    model: row.model,
    effort: row.effort,
    argv: JSON.parse(row.argv_json) as string[],
    ...(row.agent_name === null ? {} : { agentName: row.agent_name }),
    ...(row.pane_id === null ? {} : { paneId: row.pane_id }),
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    ...(row.session_cwd === null ? {} : { sessionCwd: row.session_cwd }),
    state: row.state,
    ...(row.error === null ? {} : { error: row.error }),
  };
}

function attempt(row: AttemptRow): DispatchAttempt {
  return {
    id: row.id,
    laneId: row.lane_id,
    seq: row.seq,
    purpose: row.purpose,
    promptSha256: row.prompt_sha256,
    state: row.state,
    ...(row.evidence === null ? {} : { evidence: row.evidence }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NewTask {
  role: string;
  kind: DispatchTask["kind"];
  access: DispatchTask["access"];
  worktreeId: string;
  cwd: string;
  rulesPath: string;
  /** The workflow this writer task belongs to, if any; other open workflows refuse it. */
  workflowId?: string;
  lanes: {
    index: number;
    descriptor: string;
    provider: string;
    model: string;
    effort: string | null;
    argv: string[];
  }[];
}

/** Durable rules-mode dispatch state. Every multi-step change is one IMMEDIATE transaction. */
export class DispatchRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * Records a task and its planned lanes. A writer task also takes the worktree's ownership in
   * the same transaction, so two writers racing for one worktree cannot both succeed.
   */
  createTask(input: NewTask): { task: DispatchTask; lanes: DispatchLane[] } {
    const create = this.db.transaction(() => {
      const at = this.now();
      if (input.access === "write") {
        const refusal = writerAuthorityRefusal(this.db, input.worktreeId, input.workflowId);
        if (refusal) throw refusal;
        const owner = this.ownerOf(input.worktreeId);
        if (owner) throw new OwnershipConflictError(owner);
      }
      const id = `task_${randomUUID()}`;
      this.db
        .prepare(
          `insert into dispatch_tasks (id, role, kind, access, worktree_id, cwd, rules_path, status, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, 'dispatching', ?, ?)`,
        )
        .run(
          id,
          input.role,
          input.kind,
          input.access,
          input.worktreeId,
          input.cwd,
          input.rulesPath,
          at,
          at,
        );
      if (input.access === "write") {
        this.db
          .prepare(
            "insert into writer_ownership (worktree_id, task_id, acquired_at) values (?, ?, ?)",
          )
          .run(input.worktreeId, id, at);
      }
      const insertLane = this.db.prepare(
        `insert into dispatch_lanes (id, task_id, lane_index, descriptor, provider, model, effort, argv_json, state, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)`,
      );
      for (const planned of input.lanes) {
        insertLane.run(
          `lane_${randomUUID()}`,
          id,
          planned.index,
          planned.descriptor,
          planned.provider,
          planned.model,
          planned.effort,
          JSON.stringify(planned.argv),
          at,
          at,
        );
      }
      return id;
    });
    const id = create.immediate();
    return { task: this.getTask(id)!, lanes: this.lanes(id) };
  }

  /** The open workflow a task belongs to, as its writer or as a verifier panel. */
  ownerWorkflow(taskId: string): { id: string; role: "writer" | "verifier" } | undefined {
    const row = this.db
      .prepare(
        `select id, case when task_id = ? then 'writer' else 'verifier' end as role from workflows
         where (task_id = ? or id in (select workflow_id from workflow_verifications where task_id = ?))
           and state not in ('released', 'aborted', 'failed')
         limit 1`,
      )
      .get(taskId, taskId, taskId) as { id: string; role: "writer" | "verifier" } | undefined;
    return row;
  }

  private refuseOutsideWorkflow(
    taskId: string,
    callerWorkflowId: string | undefined,
    roles: readonly ("writer" | "verifier")[],
  ): void {
    const owner = this.ownerWorkflow(taskId);
    if (owner && roles.includes(owner.role) && owner.id !== callerWorkflowId) {
      throw new WorkflowTaskError(taskId, owner.id);
    }
  }

  getTask(id: string): DispatchTask | undefined {
    const row = this.db.prepare("select * from dispatch_tasks where id = ?").get(id) as
      TaskRow | undefined;
    return row ? task(row) : undefined;
  }

  listTasks(limit: number): DispatchTask[] {
    return (
      this.db
        .prepare("select * from dispatch_tasks order by created_at desc, rowid desc limit ?")
        .all(limit) as TaskRow[]
    ).map(task);
  }

  lanes(taskId: string): DispatchLane[] {
    return (
      this.db
        .prepare("select * from dispatch_lanes where task_id = ? order by lane_index")
        .all(taskId) as LaneRow[]
    ).map(lane);
  }

  getLane(id: string): DispatchLane | undefined {
    const row = this.db.prepare("select * from dispatch_lanes where id = ?").get(id) as
      LaneRow | undefined;
    return row ? lane(row) : undefined;
  }

  attempts(laneId: string): DispatchAttempt[] {
    return (
      this.db
        .prepare("select * from dispatch_attempts where lane_id = ? order by seq")
        .all(laneId) as AttemptRow[]
    ).map(attempt);
  }

  getAttempt(id: string): DispatchAttempt | undefined {
    const row = this.db.prepare("select * from dispatch_attempts where id = ?").get(id) as
      AttemptRow | undefined;
    return row ? attempt(row) : undefined;
  }

  ownerOf(worktreeId: string): Ownership | undefined {
    const row = this.db
      .prepare(
        "select worktree_id, task_id, acquired_at from writer_ownership where worktree_id = ?",
      )
      .get(worktreeId) as { worktree_id: string; task_id: string; acquired_at: string } | undefined;
    return row
      ? { worktreeId: row.worktree_id, taskId: row.task_id, acquiredAt: row.acquired_at }
      : undefined;
  }

  ownershipOfTask(taskId: string): Ownership | undefined {
    const row = this.db
      .prepare("select worktree_id, task_id, acquired_at from writer_ownership where task_id = ?")
      .get(taskId) as { worktree_id: string; task_id: string; acquired_at: string } | undefined;
    return row
      ? { worktreeId: row.worktree_id, taskId: row.task_id, acquiredAt: row.acquired_at }
      : undefined;
  }

  updateLane(
    id: string,
    patch: Partial<
      Pick<DispatchLane, "agentName" | "paneId" | "sessionId" | "sessionCwd" | "state" | "error">
    >,
  ): void {
    const current = this.getLane(id);
    if (!current) throw new Error(`Unknown lane ${id}`);
    const next = { ...current, ...patch };
    this.db
      .prepare(
        "update dispatch_lanes set agent_name = ?, pane_id = ?, session_id = ?, session_cwd = ?, state = ?, error = ?, updated_at = ? where id = ?",
      )
      .run(
        next.agentName ?? null,
        next.paneId ?? null,
        next.sessionId ?? null,
        next.sessionCwd ?? null,
        next.state,
        next.error ?? null,
        this.now(),
        id,
      );
  }

  /**
   * Records the outcome of a dispatch. Applies only while the task is still `dispatching`, so
   * a task closed mid-dispatch is never reopened. Returns whether the status changed.
   */
  finishDispatch(id: string, status: "dispatched" | "partial" | "failed"): boolean {
    const result = this.db
      .prepare(
        "update dispatch_tasks set status = ?, updated_at = ? where id = ? and status = 'dispatching'",
      )
      .run(status, this.now(), id);
    return result.changes === 1;
  }

  /**
   * Writes a `sending` attempt before the prompt goes out. In the same IMMEDIATE transaction
   * it refuses a closed task, a writer task that no longer owns its worktree, and a lane with
   * an unresolved attempt, so a stale caller can never send, and a prompt is never sent twice
   * on a guess.
   */
  beginAttempt(input: {
    laneId: string;
    purpose: DispatchAttempt["purpose"];
    promptSha256: string;
    /** The workflow sending it; a workflow's writer takes prompts from that workflow only. */
    workflowId?: string;
  }): DispatchAttempt {
    const begin = this.db.transaction(() => {
      const lane = this.getLane(input.laneId);
      if (!lane) throw new Error(`Unknown lane ${input.laneId}`);
      this.refuseOutsideWorkflow(lane.taskId, input.workflowId, ["writer"]);
      const task = this.getTask(lane.taskId)!;
      if (CLOSED_STATUSES.includes(task.status)) throw new TaskClosedError(task);
      if (task.access === "write") {
        const owner = this.ownerOf(task.worktreeId);
        if (owner?.taskId !== task.id) throw new NotOwnerError(task, owner);
      }
      const unresolved = this.attempts(input.laneId).find((existing) =>
        UNRESOLVED_ATTEMPT_STATES.includes(existing.state),
      );
      if (unresolved) throw new UnresolvedAttemptError(unresolved);
      const row = this.db
        .prepare("select coalesce(max(seq), 0) as seq from dispatch_attempts where lane_id = ?")
        .get(input.laneId) as { seq: number };
      const id = `att_${randomUUID()}`;
      const at = this.now();
      this.db
        .prepare(
          `insert into dispatch_attempts (id, lane_id, seq, purpose, prompt_sha256, state, created_at, updated_at)
           values (?, ?, ?, ?, ?, 'sending', ?, ?)`,
        )
        .run(id, input.laneId, row.seq + 1, input.purpose, input.promptSha256, at, at);
      return id;
    });
    return this.getAttempt(begin.immediate())!;
  }

  finishAttempt(id: string, state: Exclude<AttemptState, "sending">, evidence: string): void {
    this.db
      .prepare("update dispatch_attempts set state = ?, evidence = ?, updated_at = ? where id = ?")
      .run(state, evidence, this.now(), id);
  }

  /** Resolves an unresolved attempt from evidence the caller gathered. */
  recoverAttempt(
    id: string,
    delivered: boolean,
    evidence: string,
    options: { workflowId?: string } = {},
  ): DispatchAttempt {
    const recover = this.db.transaction(() => {
      const current = this.getAttempt(id);
      if (!current) throw new Error(`Unknown attempt ${id}`);
      this.refuseOutsideWorkflow(this.getLane(current.laneId)!.taskId, options.workflowId, [
        "writer",
        "verifier",
      ]);
      if (!UNRESOLVED_ATTEMPT_STATES.includes(current.state)) {
        throw new Error(
          `Attempt ${id} is already ${current.state}; only sending or unknown attempts are recovered.`,
        );
      }
      this.finishAttempt(id, delivered ? "sent" : "not-delivered", `recovered: ${evidence}`);
    });
    recover.immediate();
    return this.getAttempt(id)!;
  }

  /**
   * Closes a task and releases its worktree ownership. `complete` needs every attempt
   * resolved; `released` (the writer stopped) is allowed with unresolved attempts on record.
   */
  closeTask(
    id: string,
    status: "complete" | "released",
    evidence: string,
    options: { workflowId?: string } = {},
  ): DispatchTask {
    const close = this.db.transaction(() => {
      const current = this.getTask(id);
      if (!current) throw new Error(`Unknown task ${id}`);
      this.refuseOutsideWorkflow(id, options.workflowId, ["writer", "verifier"]);
      if (CLOSED_STATUSES.includes(current.status)) {
        throw new Error(`Task ${id} is already ${current.status}.`);
      }
      if (status === "complete" && current.status === "dispatching") {
        throw new Error(
          `Task ${id} is still dispatching; it cannot be completed yet. If the router stopped, release it with --stopped and evidence.`,
        );
      }
      if (status === "complete") {
        for (const planned of this.lanes(id)) {
          const unresolved = this.attempts(planned.id).find((existing) =>
            UNRESOLVED_ATTEMPT_STATES.includes(existing.state),
          );
          if (unresolved) throw new UnresolvedAttemptError(unresolved);
        }
      }
      this.db
        .prepare(
          "update dispatch_tasks set status = ?, closing_evidence = ?, updated_at = ? where id = ?",
        )
        .run(status, evidence, this.now(), id);
      this.db.prepare("delete from writer_ownership where task_id = ?").run(id);
    });
    close.immediate();
    return this.getTask(id)!;
  }

  /** Releases ownership taken by a launch that never sent a prompt. */
  releaseUnsent(id: string, evidence: string, options: { workflowId?: string } = {}): void {
    const release = this.db.transaction(() => {
      this.refuseOutsideWorkflow(id, options.workflowId, ["writer"]);
      const sent = this.lanes(id).some((planned) => this.attempts(planned.id).length > 0);
      if (sent)
        throw new Error(`Task ${id} has prompt attempts; release it explicitly with evidence.`);
      // A task someone already closed keeps its status and evidence.
      const changed = this.db
        .prepare(
          "update dispatch_tasks set status = 'failed', closing_evidence = ?, updated_at = ? where id = ? and status = 'dispatching'",
        )
        .run(evidence, this.now(), id).changes;
      if (changed === 1) this.db.prepare("delete from writer_ownership where task_id = ?").run(id);
    });
    release.immediate();
  }
}
