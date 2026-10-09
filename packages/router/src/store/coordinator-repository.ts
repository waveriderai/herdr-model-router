import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { BoundIdentity } from "../workflow/identity.js";

/**
 * `sent`: Herdr accepted the submission but no activity was observed (agent_prompt_stalled).
 * `prompted`: activity (working or blocked) was observed after the submission.
 */
export type CoordinatorState =
  "starting" | "sending" | "sent" | "prompted" | "unknown" | "failed" | "closed";

/** States that still hold the worktree's one coordinator slot. */
export const OPEN_COORDINATOR_STATES: readonly CoordinatorState[] = [
  "starting",
  "sending",
  "sent",
  "prompted",
  "unknown",
];

/** A launch still in progress in some `hmr start` process; never closed out from under it. */
export const IN_FLIGHT_COORDINATOR_STATES: readonly CoordinatorState[] = ["starting", "sending"];

/** The only state changes a coordinator record may make. `closed` and `failed` are final. */
const TRANSITIONS: Record<CoordinatorState, readonly CoordinatorState[]> = {
  starting: ["sending", "failed", "unknown", "closed"],
  sending: ["sent", "prompted", "failed", "unknown", "closed"],
  sent: ["closed"],
  prompted: ["closed"],
  unknown: ["closed"],
  failed: [],
  closed: [],
};

export interface Coordinator {
  id: string;
  worktreeId: string;
  cwd: string;
  role: string;
  descriptor: string;
  provider: string;
  model: string;
  effort: string | null;
  argv: string[];
  rulesPath: string;
  taskSha256: string;
  promptSha256: string;
  state: CoordinatorState;
  sendEvidence?: string;
  /** The pane the launch created, noted before any identity is bound. */
  paneId?: string;
  identity?: BoundIdentity;
  closingEvidence?: string;
  createdAt: string;
  updatedAt: string;
}

interface CoordinatorRow {
  id: string;
  worktree_id: string;
  cwd: string;
  role: string;
  descriptor: string;
  provider: string;
  model: string;
  effort: string | null;
  argv: string;
  rules_path: string;
  task_sha256: string;
  prompt_sha256: string;
  state: CoordinatorState;
  send_evidence: string | null;
  pane_id: string | null;
  agent_name: string | null;
  agent_kind: string | null;
  session_id: string | null;
  session_cwd: string | null;
  closing_evidence: string | null;
  created_at: string;
  updated_at: string;
}

function coordinator(row: CoordinatorRow): Coordinator {
  return {
    id: row.id,
    worktreeId: row.worktree_id,
    cwd: row.cwd,
    role: row.role,
    descriptor: row.descriptor,
    provider: row.provider,
    model: row.model,
    effort: row.effort,
    argv: JSON.parse(row.argv) as string[],
    rulesPath: row.rules_path,
    taskSha256: row.task_sha256,
    promptSha256: row.prompt_sha256,
    state: row.state,
    ...(row.send_evidence === null ? {} : { sendEvidence: row.send_evidence }),
    ...(row.pane_id === null ? {} : { paneId: row.pane_id }),
    ...(row.pane_id && row.agent_name && row.agent_kind && row.session_id && row.session_cwd
      ? {
          identity: {
            agentName: row.agent_name,
            kind: row.agent_kind,
            paneId: row.pane_id,
            sessionId: row.session_id,
            cwd: row.session_cwd,
          },
        }
      : {}),
    ...(row.closing_evidence === null ? {} : { closingEvidence: row.closing_evidence }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function newCoordinatorId(): string {
  return `co_${randomUUID()}`;
}

/** A second coordinator for a worktree that already has an open one. */
export class CoordinatorOpenError extends Error {
  constructor(readonly open: Coordinator) {
    super(
      `Coordinator ${open.id} is already ${open.state} on ${open.worktreeId} (pane ${open.identity?.paneId ?? "not bound"}). ` +
        `Use it, or close its record with \`hmr coordinator close ${open.id} --evidence ...\` once you have stopped it. Nothing was started.`,
    );
  }
}

const OPEN_SQL = `state in (${OPEN_COORDINATOR_STATES.map((state) => `'${state}'`).join(", ")})`;

/**
 * Coordinator bootstraps, and which panes are workers. A coordinator holds no writer
 * ownership; the slot here only keeps one control session per worktree.
 */
export class CoordinatorRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  create(input: {
    id: string;
    worktreeId: string;
    cwd: string;
    role: string;
    descriptor: string;
    provider: string;
    model: string;
    effort: string | null;
    argv: string[];
    rulesPath: string;
    taskSha256: string;
    promptSha256: string;
  }): Coordinator {
    const { id } = input;
    const at = this.now();
    const insert = this.db.transaction(() => {
      const open = this.openFor(input.worktreeId);
      if (open) throw new CoordinatorOpenError(open);
      this.db
        .prepare(
          `insert into coordinators (id, worktree_id, cwd, role, descriptor, provider, model, effort, argv,
             rules_path, task_sha256, prompt_sha256, state, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?)`,
        )
        .run(
          id,
          input.worktreeId,
          input.cwd,
          input.role,
          input.descriptor,
          input.provider,
          input.model,
          input.effort,
          JSON.stringify(input.argv),
          input.rulesPath,
          input.taskSha256,
          input.promptSha256,
          at,
          at,
        );
    });
    insert.immediate();
    return this.get(id)!;
  }

  get(id: string): Coordinator | undefined {
    const row = this.db.prepare("select * from coordinators where id = ?").get(id) as
      CoordinatorRow | undefined;
    return row ? coordinator(row) : undefined;
  }

  list(limit: number): Coordinator[] {
    return (
      this.db
        .prepare("select * from coordinators order by created_at desc, id desc limit ?")
        .all(limit) as CoordinatorRow[]
    ).map(coordinator);
  }

  openFor(worktreeId: string): Coordinator | undefined {
    const row = this.db
      .prepare(`select * from coordinators where worktree_id = ? and ${OPEN_SQL}`)
      .get(worktreeId) as CoordinatorRow | undefined;
    return row ? coordinator(row) : undefined;
  }

  /** The open coordinator running in a pane, if any. */
  openAtPane(paneId: string): Coordinator | undefined {
    const row = this.db
      .prepare(`select * from coordinators where pane_id = ? and ${OPEN_SQL}`)
      .get(paneId) as CoordinatorRow | undefined;
    return row ? coordinator(row) : undefined;
  }

  bind(id: string, identity: BoundIdentity): void {
    this.db
      .prepare(
        "update coordinators set pane_id = ?, agent_name = ?, agent_kind = ?, session_id = ?, session_cwd = ?, updated_at = ? where id = ?",
      )
      .run(
        identity.paneId,
        identity.agentName,
        identity.kind,
        identity.sessionId,
        identity.cwd,
        this.now(),
        id,
      );
  }

  /** Records the pane a launch created before Herdr confirmed an identity in it. */
  notePane(id: string, paneId: string): void {
    this.db
      .prepare("update coordinators set pane_id = ?, updated_at = ? where id = ?")
      .run(paneId, this.now(), id);
  }

  /**
   * Moves a record from exactly `from` to `to`, atomically: it changes nothing and returns false
   * when another process moved the record first, so a late launch step never reopens or
   * overwrites a closed record and a close never lands on a record that changed under it.
   */
  transition(
    id: string,
    from: CoordinatorState,
    to: CoordinatorState,
    extra: { sendEvidence?: string; closingEvidence?: string } = {},
  ): boolean {
    if (!TRANSITIONS[from].includes(to)) {
      throw new Error(`coordinator state ${from} cannot become ${to}`);
    }
    return (
      this.db
        .prepare(
          `update coordinators set state = ?, send_evidence = coalesce(?, send_evidence),
             closing_evidence = coalesce(?, closing_evidence), updated_at = ?
           where id = ? and state = ?`,
        )
        .run(to, extra.sendEvidence ?? null, extra.closingEvidence ?? null, this.now(), id, from)
        .changes === 1
    );
  }

  /** Workflows this coordinator started that are not finished. */
  activeWorkflowsOf(coordinatorId: string): { id: string; state: string; writerRole: string }[] {
    return this.workflowsOf(coordinatorId).filter(
      (workflow) => !["released", "aborted", "failed"].includes(workflow.state),
    );
  }

  link(coordinatorId: string, workflowId: string): void {
    this.db
      .prepare(
        "insert or ignore into coordinator_workflows (coordinator_id, workflow_id, created_at) values (?, ?, ?)",
      )
      .run(coordinatorId, workflowId, this.now());
  }

  workflowsOf(coordinatorId: string): { id: string; state: string; writerRole: string }[] {
    return (
      this.db
        .prepare(
          `select w.id as id, w.state as state, w.writer_role as writerRole
             from coordinator_workflows c join workflows w on w.id = c.workflow_id
            where c.coordinator_id = ? order by c.created_at, w.id`,
        )
        .all(coordinatorId) as { id: string; state: string; writerRole: string }[]
    ).map((row) => ({ ...row }));
  }

  /**
   * Whether a pane runs a worker: a lane of an open rules-mode task, or the bound writer of an
   * open workflow. Workers may not start coordinators or workflows of their own.
   */
  workerAt(paneId: string): string | undefined {
    const lane = this.db
      .prepare(
        `select t.id as id from dispatch_lanes l join dispatch_tasks t on t.id = l.task_id
          where l.pane_id = ? and t.status not in ('complete', 'released') limit 1`,
      )
      .get(paneId) as { id: string } | undefined;
    if (lane) return `task ${lane.id}`;
    const workflow = this.db
      .prepare(
        `select id from workflows where pane_id = ? and state not in ('released', 'aborted', 'failed') limit 1`,
      )
      .get(paneId) as { id: string } | undefined;
    return workflow ? `workflow ${workflow.id}` : undefined;
  }
}
