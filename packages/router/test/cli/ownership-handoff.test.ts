import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { openDatabase } from "../../src/store/database.js";
import { DispatchRepository } from "../../src/store/dispatch-repository.js";
import { worktreeIdentity } from "../../src/rules/rules-source.js";
import { fakeHerdr, HELP, ok } from "../helpers/fake-herdr.js";

function sandbox() {
  const root = mkdtempSync(path.join(os.tmpdir(), "hmr-handoff-cli-"));
  const project = path.join(root, "project");
  const home = path.join(root, "router-home");
  const bin = path.join(root, "bin");
  const rules = path.join(root, "rules.mdc");
  mkdirSync(path.join(project, ".git"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(path.join(bin, "claude"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(
    rules,
    "writer: claude:claude-opus-5-5@high\nreaders: claude:claude-opus-5-5@high, claude:claude-opus-5-5@high\n",
  );
  const db = openDatabase({ home });
  const store = new DispatchRepository(db);
  const worktreeId = worktreeIdentity(project);
  const { task } = store.createTask({
    role: "writer",
    kind: "single",
    access: "write",
    worktreeId,
    cwd: project,
    rulesPath: rules,
    lanes: [],
  });
  store.finishDispatch(task.id, "dispatched");
  store.closeTask(task.id, "complete", "previous round complete");
  expect(store.acquireCommitLock(worktreeId, task.id)).toBe(true);
  const holder = store.ownerOf(worktreeId)!;
  const token = `${holder.taskId}@${holder.acquiredAt}`;
  const herdr = fakeHerdr();
  const probes: string[][] = [];
  async function cli(args: string[]) {
    let out = "";
    let err = "";
    const code = await runCli(
      ["node", "router", "run", "Fix the reviewed change", "--rules", rules, "--json", ...args],
      {
        cwd: project,
        env: { HOME: path.join(root, "user"), MODEL_ROUTER_HOME: home, PATH: bin, HERDR_ENV: "1" },
        stdout: {
          write: (text) => {
            out += text;
            return true;
          },
        },
        stderr: {
          write: (text) => {
            err += text;
            return true;
          },
        },
        rulesOverrides: {
          createProcessAdapter: () => async (argv) => {
            probes.push(argv);
            return ok(HELP.claude);
          },
          createHerdr: () => herdr,
          createHerdrPane: () => herdr.pane,
          readKeychain: () => {
            throw new Error("must not read credentials");
          },
        },
      },
    );
    return { code, out, err };
  }
  return { db, store, holder, token, herdr, probes, cli, worktreeId };
}

describe("run --handoff-from CLI contract", () => {
  it.each(["rules", "semantic"])(
    "parses and transfers a matching hold in %s mode before sending the new writer prompt",
    async (mode) => {
      const box = sandbox();
      try {
        const result = await box.cli([
          "--routing-mode",
          mode,
          "--role",
          "writer",
          "--phase",
          "fix",
          "--handoff-from",
          box.token,
        ]);
        expect(result.code, result.err).toBe(0);
        const json = JSON.parse(result.out);
        expect(json).toMatchObject({
          ok: true,
          delivered: 1,
          task: { access: "write", status: "dispatched" },
        });
        expect(box.store.ownerOf(box.worktreeId)?.taskId).toBe(json.task.id);
        expect(box.store.ownershipOfTask(box.holder.taskId)).toBeUndefined();
        expect(box.herdr.prompts).toHaveLength(1);
      } finally {
        box.db.close();
      }
    },
  );

  it("returns the stable JSON refusal code and preserves a changed acquisition without prompting", async () => {
    const box = sandbox();
    try {
      box.db
        .prepare("update writer_ownership set acquired_at = 'reacquired' where worktree_id = ?")
        .run(box.worktreeId);
      const before = box.store.ownerOf(box.worktreeId);
      const result = await box.cli(["--role", "writer", "--handoff-from", box.token]);
      expect(result.code).toBe(2);
      expect(JSON.parse(result.out)).toMatchObject({
        ok: false,
        code: "ownership-handoff-refused",
        error: expect.any(String),
      });
      expect(box.herdr.calls).toEqual([]);
      expect(box.herdr.prompts).toEqual([]);
      expect(box.store.ownerOf(box.worktreeId)).toEqual(before);
      expect(box.store.listTasks(100)).toHaveLength(1);
    } finally {
      box.db.close();
    }
  });

  it.each(["", "task-only", "@time", "task@", "task@time@extra", "task@with space", "task@time\n"])(
    "refuses malformed token %j before any process or database change",
    async (token) => {
      const box = sandbox();
      try {
        const result = await box.cli(["--role", "writer", "--handoff-from", token]);
        expect(result.code).toBe(2);
        expect(JSON.parse(result.out)).toMatchObject({
          ok: false,
          code: "ownership-handoff-invalid",
        });
        expect(box.probes).toEqual([]);
        expect(box.herdr.calls).toEqual([]);
        expect(box.store.ownerOf(box.worktreeId)).toEqual(box.holder);
      } finally {
        box.db.close();
      }
    },
  );

  it("accepts a dry run without checking or transferring ownership", async () => {
    const box = sandbox();
    try {
      const result = await box.cli([
        "--role",
        "writer",
        "--handoff-from",
        "missing@acquisition",
        "--dry-run",
      ]);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.out)).toMatchObject({
        ok: true,
        dryRun: true,
        dispatch: "not-started",
        effects: [],
      });
      expect(box.probes).toEqual([]);
      expect(box.herdr.calls).toEqual([]);
      expect(box.store.ownerOf(box.worktreeId)).toEqual(box.holder);
    } finally {
      box.db.close();
    }
  });

  it.each([
    ["--role", "readers"],
    ["--role", "writer", "--read-only"],
    ["--routing-mode", "quota"],
  ])("refuses a handoff outside a rules or semantic writer (%j)", async (...args) => {
    const box = sandbox();
    try {
      const result = await box.cli([...args, "--handoff-from", box.token, "--dry-run"]);
      expect(result.code).toBe(2);
      expect(JSON.parse(result.out)).toMatchObject({
        ok: false,
        code: "ownership-handoff-invalid",
      });
      expect(box.probes).toEqual([]);
      expect(box.herdr.calls).toEqual([]);
      expect(box.store.ownerOf(box.worktreeId)).toEqual(box.holder);
    } finally {
      box.db.close();
    }
  });
});
