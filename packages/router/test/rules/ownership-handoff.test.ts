import { describe, expect, it } from "vitest";
import { dispatchPlan } from "../../src/rules/dispatch.js";
import { parseRules } from "../../src/rules/mdc-parser.js";
import { planRoute } from "../../src/rules/plan.js";
import { DispatchRepository, type NewTask } from "../../src/store/dispatch-repository.js";
import { openDatabase } from "../../src/store/database.js";
import { deps, fakeHerdr, HELP, ok } from "../helpers/fake-herdr.js";

const WORKTREE = "/work/handoff";
const input: NewTask = {
  role: "writer",
  kind: "single",
  access: "write",
  worktreeId: WORKTREE,
  cwd: WORKTREE,
  rulesPath: "rules.mdc",
  lanes: [
    {
      index: 1,
      descriptor: "claude:claude-opus-5-5@high",
      provider: "claude",
      model: "claude-opus-5-5",
      effort: "high",
      argv: ["claude"],
    },
  ],
};

function held() {
  const herdr = fakeHerdr();
  const box = deps(herdr);
  const { task } = box.deps.store.createTask(input);
  box.deps.store.finishDispatch(task.id, "dispatched");
  box.deps.store.closeTask(task.id, "complete", "previous round checked");
  expect(box.deps.store.acquireCommitLock(WORKTREE, task.id)).toBe(true);
  const owner = box.deps.store.ownerOf(WORKTREE)!;
  return {
    ...box,
    herdr,
    holder: task,
    handoffFrom: { taskId: owner.taskId, acquiredAt: owner.acquiredAt },
  };
}

describe("atomic writer ownership handoff", () => {
  it("replaces the exact completed holder with the new task", () => {
    const box = held();
    const observerDb = openDatabase({ home: box.home });
    const observer = new DispatchRepository(observerDb);
    try {
      const observed: unknown[] = [];
      box.db.function("observe_handoff", () => {
        observed.push({ inTransaction: box.db.inTransaction, owner: observer.ownerOf(WORKTREE) });
        return 0;
      });
      box.db.exec(`
        create trigger observe_delete after delete on writer_ownership begin select observe_handoff(); end;
        create trigger observe_insert after insert on writer_ownership begin select observe_handoff(); end;
      `);
      const before = box.deps.store.ownerOf(WORKTREE);
      const next = box.deps.store.createTask({ ...input, handoffFrom: box.handoffFrom });
      expect(observed).toEqual([
        { inTransaction: true, owner: before },
        { inTransaction: true, owner: before },
      ]);
      expect(box.deps.store.ownerOf(WORKTREE)?.taskId).toBe(next.task.id);
      expect(observer.ownerOf(WORKTREE)?.taskId).toBe(next.task.id);
      expect(box.deps.store.ownershipOfTask(box.holder.id)).toBeUndefined();
      expect(box.deps.store.getTask(box.holder.id)?.status).toBe("complete");
    } finally {
      observerDb.close();
      box.db.close();
    }
  });

  it("keeps the ordinary ownership refusal without a handoff token", () => {
    const box = held();
    try {
      const before = box.deps.store.ownerOf(WORKTREE);
      expect(() => box.deps.store.createTask(input)).toThrow("is owned by writer task");
      expect(box.deps.store.ownerOf(WORKTREE)).toEqual(before);
      expect(box.deps.store.listTasks(100)).toHaveLength(1);
    } finally {
      box.db.close();
    }
  });

  it.each([{ access: "read" as const }, { workflowId: "workflow-caller" }])(
    "refuses a direct repository handoff to a non-standalone writer (%j)",
    (extra) => {
      const box = held();
      try {
        expect(() =>
          box.deps.store.createTask({ ...input, ...extra, handoffFrom: box.handoffFrom }),
        ).toThrow("only a standalone writer");
        expect(box.deps.store.ownerOf(WORKTREE)?.taskId).toBe(box.holder.id);
        expect(box.deps.store.listTasks(100)).toHaveLength(1);
      } finally {
        box.db.close();
      }
    },
  );

  it.each([
    "missing",
    "owner",
    "timestamp",
    "new-writer",
    "incomplete",
    "released",
    "wrong-worktree",
    "reader",
    "workflow",
    "binding",
  ])("refuses %s before launching or prompting any lane", async (change) => {
    const box = held();
    try {
      switch (change) {
        case "missing":
          box.deps.store.releaseCommitLock(WORKTREE, box.holder.id);
          break;
        case "owner": {
          box.deps.store.releaseCommitLock(WORKTREE, box.holder.id);
          box.deps.store.createTask(input);
          break;
        }
        case "timestamp":
          box.db
            .prepare("update writer_ownership set acquired_at = ? where worktree_id = ?")
            .run("different-acquisition", WORKTREE);
          break;
        case "new-writer": {
          box.deps.store.releaseCommitLock(WORKTREE, box.holder.id);
          const next = box.deps.store.createTask(input).task;
          box.deps.store.finishDispatch(next.id, "dispatched");
          box.deps.store.closeTask(next.id, "complete", "competitor finished");
          box.db
            .prepare("insert into writer_ownership values (?, ?, ?)")
            .run(WORKTREE, box.holder.id, box.handoffFrom.acquiredAt);
          break;
        }
        case "incomplete":
          box.db
            .prepare("update dispatch_tasks set status = 'dispatched' where id = ?")
            .run(box.holder.id);
          break;
        case "released":
          box.db
            .prepare("update dispatch_tasks set status = 'released' where id = ?")
            .run(box.holder.id);
          break;
        case "wrong-worktree":
          box.db
            .prepare("update dispatch_tasks set worktree_id = ? where id = ?")
            .run("/work/elsewhere", box.holder.id);
          break;
        case "reader":
          box.db
            .prepare("update dispatch_tasks set access = 'read' where id = ?")
            .run(box.holder.id);
          break;
        case "workflow":
          box.db
            .prepare(
              `insert into workflows (id, worktree_id, backend, state, brief_sha256, writer_role, writer_descriptor, cwd, baseline_head, baseline_content, created_at, updated_at) values ('workflow-competitor', ?, 'standalone', 'starting', 'brief', 'writer', 'claude:claude-opus-5-5@high', ?, 'head', 'content', 'now', 'now')`,
            )
            .run(WORKTREE, WORKTREE);
          break;
        case "binding":
          box.db
            .prepare("insert into worktree_bindings values (?, 'agent-collab', 'now')")
            .run(WORKTREE);
          break;
      }
      const before = box.deps.store.ownerOf(WORKTREE);
      const tasks = box.deps.store.listTasks(100);
      const parsed = parseRules("writer: claude:claude-opus-5-5@high\n");
      if (!parsed.ok) throw new Error(parsed.error);
      const plan = planRoute({
        rules: parsed.rules,
        rulesSource: { path: "rules.mdc", origin: "flag" },
        cwd: WORKTREE,
        role: "writer",
      });
      if (!plan.ok) throw new Error(plan.error);
      const result = await dispatchPlan({
        plan,
        prompt: "Fix the reviewed change",
        worktreeId: WORKTREE,
        handoffFrom: box.handoffFrom,
        deps: box.deps,
      });
      expect(result).toMatchObject({ ok: false, code: "ownership-handoff-refused" });
      expect(box.herdr.prompts).toEqual([]);
      expect(box.herdr.calls).toEqual([]);
      expect(box.deps.store.ownerOf(WORKTREE)).toEqual(before);
      expect(box.deps.store.listTasks(100)).toEqual(tasks);
    } finally {
      box.db.close();
    }
  });

  it("rolls back the holder deletion if recording the new lanes fails", () => {
    const box = held();
    try {
      const before = box.deps.store.ownerOf(WORKTREE);
      box.db.exec(
        "create trigger fail_lane before insert on dispatch_lanes begin select raise(abort, 'lane failure'); end",
      );
      expect(() => box.deps.store.createTask({ ...input, handoffFrom: box.handoffFrom })).toThrow(
        "lane failure",
      );
      expect(box.deps.store.ownerOf(WORKTREE)).toEqual(before);
      expect(box.deps.store.listTasks(100)).toHaveLength(1);
    } finally {
      box.db.close();
    }
  });

  it("refuses when a competitor takes and completes the worktree during the asynchronous launch preflight", async () => {
    const box = held();
    try {
      box.deps.probeHelp = async () => {
        box.deps.store.releaseCommitLock(WORKTREE, box.holder.id);
        const competitor = box.deps.store.createTask(input).task;
        box.deps.store.finishDispatch(competitor.id, "dispatched");
        box.deps.store.closeTask(competitor.id, "complete", "competitor finished during preflight");
        return ok(HELP.claude);
      };
      const parsed = parseRules("writer: claude:claude-opus-5-5@high\n");
      if (!parsed.ok) throw new Error(parsed.error);
      const plan = planRoute({
        rules: parsed.rules,
        rulesSource: { path: "rules.mdc", origin: "flag" },
        cwd: WORKTREE,
        role: "writer",
      });
      if (!plan.ok) throw new Error(plan.error);
      const result = await dispatchPlan({
        plan,
        prompt: "Fix it",
        worktreeId: WORKTREE,
        handoffFrom: box.handoffFrom,
        deps: box.deps,
      });
      expect(result).toMatchObject({ ok: false, code: "ownership-handoff-refused" });
      expect(box.herdr.prompts).toEqual([]);
      expect(box.herdr.calls).toEqual([]);
      expect(box.deps.store.ownerOf(WORKTREE)).toBeUndefined();
      expect(box.deps.store.listTasks(100)).toHaveLength(2);
      expect(box.deps.store.listTasks(100).every((task) => task.status === "complete")).toBe(true);
    } finally {
      box.db.close();
    }
  });
});
