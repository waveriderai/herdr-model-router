import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import { worktreeIdentity } from "../../src/rules/rules-source.js";
import { openDatabase } from "../../src/store/database.js";
import { recoverWorkflow, workflowReport } from "../../src/workflow/service.js";
import { fakeAgentCollab } from "../helpers/fake-agent-collab.js";
import { makeRepo } from "../helpers/git-repo.js";
import { harness } from "../helpers/workflow-harness.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const helpers = path.join(here, "../helpers");
const src = path.join(here, "../../src");

/**
 * A child process that drives a real workflow (real SQLite file, fake agent-collab process)
 * up to one external mutation, and dies the moment agent-collab answered ok but before HMR's
 * local transition commits: the window between transport success and local commit.
 */
const CHILD = `
import { writeFileSync } from "node:fs";
import path from "node:path";
import { harness, BRIEF } from ${JSON.stringify(path.join(helpers, "workflow-harness.ts"))};
import { fakeAgentCollab } from ${JSON.stringify(path.join(helpers, "fake-agent-collab.ts"))};
import { worktreeIdentity } from ${JSON.stringify(path.join(src, "rules/rules-source.ts"))};
import {
  startWorkflow, recordResult, verifyWorkflow, acceptWorkflow, recordDelivery, releaseWorkflow, reviseWorkflow,
} from ${JSON.stringify(path.join(src, "workflow/service.ts"))};

async function main() {
const [home, repo, collabDir, crashAt, marker] = process.argv.slice(2);
const collab = fakeAgentCollab({ dir: collabDir });
const h = harness({ home, repo, collab: collab.port });
h.workflows.setBinding(worktreeIdentity(repo), "agent-collab");
const commit = h.workflows.commit.bind(h.workflows);
h.workflows.commit = (lease, apply) => {
  const latest = h.workflows.intents(lease.workflowId).at(-1);
  if (latest && latest.operation === crashAt && latest.state === "observed") {
    writeFileSync(marker, JSON.stringify({ workflowId: lease.workflowId }));
    process.exit(137);
  }
  return commit(lease, apply);
};
const must = (step) => { if (!step.ok) { console.error(step.code, step.error); process.exit(3); } return step.value; };
const { workflow, attempt } = must(await startWorkflow(h.deps, { brief: BRIEF, cwd: repo }));
writeFileSync(path.join(repo, "greeting.txt"), "hello\\n");
must(await recordResult(h.deps, { workflowId: workflow.id, expectedAttemptId: attempt.id, text: h.writerResult({ workflowId: workflow.id, attemptId: attempt.id }) }));
if (crashAt === "request-changes") {
  await reviseWorkflow(h.deps, { workflowId: workflow.id, expectedAttemptId: attempt.id, delta: "Change it." });
}
const verified = must(await verifyWorkflow(h.deps, { workflowId: workflow.id, expectedAttemptId: attempt.id }));
for (const lane of verified.lanes.flatMap((round) => round.lanes)) {
  must(await recordResult(h.deps, { workflowId: workflow.id, expectedAttemptId: attempt.id, laneId: lane.laneId,
    text: h.verifierResult({ workflowId: workflow.id, attemptId: attempt.id, laneId: lane.laneId, status: "pass" }) }));
}
must(await acceptWorkflow(h.deps, { workflowId: workflow.id, expectedAttemptId: attempt.id, evidence: "checks pass" }));
must(recordDelivery(h.deps, { workflowId: workflow.id, evidence: "local only", notApplicable: true }));
await releaseWorkflow(h.deps, { workflowId: workflow.id, evidence: "done", abort: false });
console.error("no crash happened");
process.exit(4);
}
main().catch((error) => { console.error(error); process.exit(5); });
`;

let bundle: string;
beforeAll(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hmr-crash-child-"));
  const entry = path.join(dir, "child.ts");
  writeFileSync(entry, CHILD);
  bundle = path.join(dir, "child.cjs");
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundle,
    // The helpers locate their fixtures (and the store its migrations) from import.meta.url,
    // which a CommonJS bundle lacks; the helpers' own location resolves both.
    define: {
      "import.meta.url": JSON.stringify(pathToFileURL(path.join(helpers, "fake-herdr.ts")).href),
    },
    external: ["better-sqlite3"],
    logLevel: "silent",
  });
}, 60_000);

function runChild(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundle, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: os.tmpdir(),
        NODE_PATH: path.join(repoRoot, "node_modules"),
      },
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

const MUTATIONS = ["acquire", "dispatch", "receipt", "request-changes", "accept", "release"];

async function crashThenRecover(crashAt: string) {
  const home = mkdtempSync(path.join(os.tmpdir(), "hmr-crash-home-"));
  const repo = makeRepo();
  const collab = fakeAgentCollab();
  const marker = path.join(home, "crashed.json");
  // Migrated here once: the bundled child cannot read the migration files itself.
  openDatabase({ home }).close();
  const child = await runChild([home, repo, collab.dir, crashAt, marker]);
  expect(child.code, child.stderr).toBe(137);
  const { workflowId } = JSON.parse(readFileSync(marker, "utf8")) as { workflowId: string };
  // A fresh process over the same files.
  const h = harness({ home, repo, collab: collab.port });
  const before = h.workflows.intents(workflowId).at(-1)!;
  expect(before).toMatchObject({ operation: crashAt, state: "observed" });
  const mutations = () => collab.commands().filter((command) => MUTATIONS.includes(command));
  const sent = mutations();
  const recovered = await recoverWorkflow(h.deps, { workflowId });
  if (!recovered.ok) throw new Error(recovered.error);
  // Recovery only reads agent-collab's status: no mutation is repeated.
  expect(mutations()).toEqual(sent);
  expect(h.workflows.intents(workflowId).at(-1)).toMatchObject({
    operation: crashAt,
    state: "done",
  });
  expect(h.workflows.unresolvedIntent(workflowId)).toBeUndefined();
  // A second recovery finds nothing left to do.
  const again = await recoverWorkflow(h.deps, { workflowId });
  expect(again.ok && again.value.reconciled).toBeUndefined();
  expect(mutations()).toEqual(sent);
  return { h, workflowId, collab, recovered: recovered.value };
}

describe("a process that dies after agent-collab answered ok, before the local commit", () => {
  it("recovers an acquire: the run is recorded and the first prompt can be resumed once", async () => {
    const { h, workflowId } = await crashThenRecover("acquire");
    const workflow = h.workflows.get(workflowId)!;
    expect(workflow).toMatchObject({ state: "starting", externalRunId: "r1" });
    expect(h.workflows.currentAttempt(workflowId)).toMatchObject({
      backendAttempt: "a1",
      sendState: "pending",
    });
    expect(workflowReport(h.deps, workflowId)!.next[0]).toContain("--resume");
  }, 60_000);

  it("recovers a dispatch as delivered", async () => {
    const { h, workflowId, collab } = await crashThenRecover("dispatch");
    expect(h.workflows.get(workflowId)!.state).toBe("dispatched");
    expect(h.workflows.currentAttempt(workflowId)!.sendState).toBe("sent");
    expect(collab.state().prompts).toHaveLength(1);
  }, 60_000);

  it("recovers a receipt", async () => {
    const { h, workflowId, collab } = await crashThenRecover("receipt");
    expect(h.workflows.get(workflowId)!.state).toBe("receipt");
    expect(h.workflows.currentAttempt(workflowId)!.result?.status).toBe("impl-complete");
    expect(collab.commands().filter((command) => command === "receipt")).toHaveLength(1);
  }, 60_000);

  it("recovers a request-changes as the revision opened from the reviewed attempt", async () => {
    const { h, workflowId } = await crashThenRecover("request-changes");
    expect(h.workflows.get(workflowId)!.state).toBe("revision");
    expect(h.workflows.currentAttempt(workflowId)).toMatchObject({
      purpose: "revision",
      backendAttempt: "a2",
      sendState: "pending",
    });
  }, 60_000);

  it("recovers an accept with its evidence", async () => {
    const { h, workflowId } = await crashThenRecover("accept");
    expect(h.workflows.get(workflowId)!).toMatchObject({
      state: "accepted",
      accepted: { evidence: "checks pass" },
    });
  }, 60_000);

  it("recovers a release, so the worktree is not stuck behind a released run", async () => {
    const { h, workflowId, collab } = await crashThenRecover("release");
    expect(h.workflows.get(workflowId)!.state).toBe("released");
    expect(collab.state().runs.r1!.state).toBe("released");
    // Rebinding is refused while any workflow is open: it succeeds, so the worktree is free.
    expect(() => h.workflows.setBinding(worktreeIdentity(h.repo), "standalone")).not.toThrow();
  }, 60_000);
});
