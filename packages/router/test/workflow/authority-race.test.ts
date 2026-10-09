import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/store/database.js";
import { DispatchRepository } from "../../src/store/dispatch-repository.js";
import { WorkflowRepository } from "../../src/store/workflow-repository.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");

// Each child opens its own connection, waits for a shared start time, then either opens a
// workflow (the coordinator entrance) or creates a legacy writer task (`run`, quota-free).
const CHILD = `
import { openDatabase } from ${JSON.stringify(path.join(here, "../../src/store/database.ts"))};
import { DispatchRepository, OwnershipConflictError } from ${JSON.stringify(path.join(here, "../../src/store/dispatch-repository.ts"))};
import { WorkflowRepository, WriterAuthorityError } from ${JSON.stringify(path.join(here, "../../src/store/workflow-repository.ts"))};
const [home, worktree, startAt, entrance] = process.argv.slice(2);
const db = openDatabase({ home });
db.pragma("busy_timeout = 10000");
const rev = { head: "a".repeat(40), content: "b".repeat(64) };
while (Date.now() < Number(startAt)) {}
try {
  if (entrance === "workflow") {
    const { workflow } = new WorkflowRepository(db).createWorkflow({
      worktreeId: worktree, backend: "standalone", briefSha256: "c".repeat(64), writerRole: "writer",
      writerDescriptor: "claude:claude-opus-5-5@high", cwd: worktree, baseline: rev, promptSha256: "d".repeat(64),
    });
    process.stdout.write("won workflow " + workflow.id);
  } else {
    const { task } = new DispatchRepository(db).createTask({
      role: "writer", kind: "single", access: "write", worktreeId: worktree, cwd: worktree, rulesPath: "rules.mdc",
      lanes: [{ index: 1, descriptor: "claude:claude-opus-5-5@high", provider: "claude", model: "claude-opus-5-5", effort: "high", argv: ["claude"] }],
    });
    process.stdout.write("won task " + task.id);
  }
} catch (error) {
  const known = error instanceof OwnershipConflictError || error instanceof WriterAuthorityError;
  process.stdout.write((known ? "refused " : "error ") + String(error && error.message));
}
db.close();
`;

function run(bundle: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundle, ...args], {
      env: { PATH: process.env.PATH, NODE_PATH: path.join(repoRoot, "node_modules") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`child exited ${code}: ${err}`)),
    );
  });
}

describe("one writer authority across processes and entrances", () => {
  it("lets exactly one of racing workflow starts and legacy writer tasks hold a worktree", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hmr-authority-race-"));
    const home = path.join(dir, "home");
    openDatabase({ home }).close();
    const entry = path.join(dir, "child.ts");
    writeFileSync(entry, CHILD);
    const bundle = path.join(dir, "child.cjs");
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: bundle,
      external: ["better-sqlite3"],
      logLevel: "silent",
    });
    const startAt = String(Date.now() + 1500);
    const entrances = [
      "workflow",
      "task",
      "workflow",
      "task",
      "workflow",
      "task",
      "workflow",
      "task",
    ];
    // Legacy tasks start just after the workflow starts, so a missing cross-entrance check
    // would let one of each win; same-kind entrants still race each other at the same instant.
    const at = (entrance: string) => (entrance === "task" ? String(Number(startAt) + 50) : startAt);
    const results = await Promise.all(
      entrances.map((entrance) => run(bundle, [home, "/work/race", at(entrance), entrance])),
    );
    const winners = results.filter((line) => line.startsWith("won "));
    expect(results.filter((line) => line.startsWith("error "))).toEqual([]);
    expect(winners).toHaveLength(1);
    expect(results.filter((line) => line.startsWith("refused "))).toHaveLength(
      entrances.length - 1,
    );
    const db = openDatabase({ home });
    const workflows = new WorkflowRepository(db);
    const owner = new DispatchRepository(db).ownerOf("/work/race");
    const open = workflows.list(20).filter((workflow) => workflow.state === "starting");
    // Either one open workflow and no task ownership, or one owning task and no workflow.
    expect(Number(Boolean(owner)) + open.length).toBe(1);
    db.close();
  }, 30_000);
});
