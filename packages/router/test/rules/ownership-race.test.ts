import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/store/database.js";
import { DispatchRepository } from "../../src/store/dispatch-repository.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");

// Each child process opens its own connection to the shared database, waits for a common
// start time, then tries to take writer ownership of the same worktree.
const CHILD = `
import { openDatabase } from ${JSON.stringify(path.join(here, "../../src/store/database.ts"))};
import { DispatchRepository, OwnershipConflictError } from ${JSON.stringify(path.join(here, "../../src/store/dispatch-repository.ts"))};
const [home, worktree, startAt] = process.argv.slice(2);
const db = openDatabase({ home });
db.pragma("busy_timeout = 10000");
const store = new DispatchRepository(db);
while (Date.now() < Number(startAt)) {}
try {
  const { task } = store.createTask({
    role: "feature", kind: "single", access: "write", worktreeId: worktree, cwd: worktree,
    rulesPath: "rules.mdc",
    lanes: [{ index: 1, descriptor: "codex:gpt-6.1-sol@high", provider: "codex", model: "gpt-6.1-sol", effort: "high", argv: ["codex"] }],
  });
  process.stdout.write("acquired " + task.id);
} catch (error) {
  process.stdout.write(error instanceof OwnershipConflictError ? "conflict " + error.owner.taskId : "error " + String(error));
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

describe("writer ownership across processes", () => {
  it("lets exactly one of several racing processes own a worktree", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hmr-race-"));
    const home = path.join(dir, "home");
    openDatabase({ home }).close(); // migrate once up front
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
    const results = await Promise.all(
      Array.from({ length: 6 }, () => run(bundle, [home, "/work/race", startAt])),
    );
    const acquired = results.filter((line) => line.startsWith("acquired "));
    const conflicts = results.filter((line) => line.startsWith("conflict "));
    expect(acquired).toHaveLength(1);
    expect(conflicts).toHaveLength(5);
    const winner = acquired[0]!.slice("acquired ".length);
    expect(conflicts.every((line) => line === `conflict ${winner}`)).toBe(true);
    const db = openDatabase({ home });
    expect(new DispatchRepository(db).ownerOf("/work/race")?.taskId).toBe(winner);
    db.close();
  }, 30_000);
});
