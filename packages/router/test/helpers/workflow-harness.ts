import { mkdtempSync, writeFileSync } from "node:fs";
import type Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import { previewPlan } from "../../src/commands/rules-commands.js";
import type { DispatchDeps } from "../../src/rules/dispatch.js";
import { WorkflowRepository } from "../../src/store/workflow-repository.js";
import type { AgentCollabPort } from "../../src/workflow/agent-collab.js";
import { artifactStoreIn } from "../../src/workflow/artifacts.js";
import { BRIEF_VERSION, RESULT_VERSION, type BriefInput } from "../../src/workflow/contracts.js";
import { createGitRead, readRevision } from "../../src/workflow/revision.js";
import type { WorkflowDeps } from "../../src/workflow/service.js";
import { deps as dispatchDeps, fakeHerdr, type FakeHerdr } from "./fake-herdr.js";
import { makeRepo } from "./git-repo.js";

export const WORKFLOW_RULES = [
  "---",
  "description: Synthetic workflow roles",
  "---",
  "writer: claude:claude-opus-5-5@high",
  "codex writer: codex:gpt-6.1-sol@high",
  "checkers: codex:gpt-6.1-sol@xhigh, claude:claude-opus-5-5@high",
  "",
].join("\n");

export const BRIEF: BriefInput = {
  version: BRIEF_VERSION,
  title: "Add a greeting",
  goal: "Write greeting.txt.",
  scope: { allowed: ["greeting.txt"], excluded: [] },
  writerRole: "writer",
  verifierRoles: ["checkers"],
  acceptance: ["greeting.txt says hello"],
  constraints: [],
  classification: "implementation",
};

export interface Harness {
  deps: WorkflowDeps;
  db: Database.Database;
  herdr: FakeHerdr;
  repo: string;
  home: string;
  /** The rules file planRole reads; tests may rewrite it. */
  rulesFile: string;
  dispatch: DispatchDeps;
  workflows: WorkflowRepository;
  revision: () => { head: string; content: string };
  writerResult: (input: { workflowId: string; attemptId: string; status?: string }) => string;
  verifierResult: (input: {
    workflowId: string;
    attemptId: string;
    laneId: string;
    status: string;
  }) => string;
}

export function harness(
  options: {
    herdr?: FakeHerdr;
    collab?: AgentCollabPort;
    callerPane?: string;
    /** Reuse another process's router home and repository (crash and restart tests). */
    home?: string;
    repo?: string;
  } = {},
): Harness {
  const herdr = options.herdr ?? fakeHerdr();
  const { deps: dispatch, home, db } = dispatchDeps(herdr, {}, options.home);
  const repo = options.repo ?? makeRepo();
  const rulesDir = mkdtempSync(path.join(os.tmpdir(), "hmr-wf-rules-"));
  const rulesFile = path.join(rulesDir, "pstack-models.mdc");
  writeFileSync(rulesFile, WORKFLOW_RULES);
  const workflows = new WorkflowRepository(db);
  const git = createGitRead(process.env);
  const deps: WorkflowDeps = {
    workflows,
    dispatch,
    artifacts: artifactStoreIn(home),
    git,
    ...(options.collab ? { collab: options.collab } : {}),
    callerEnv: options.callerPane ? { HERDR_PANE_ID: options.callerPane } : {},
    planRole: ({ role, cwd, readOnly, parent }) => {
      const preview = previewPlan(
        { cwd, home: rulesDir, rulesFlag: rulesFile },
        { role, ...(readOnly ? { readOnly } : {}), ...(parent !== undefined ? { parent } : {}) },
      );
      return preview.ok
        ? { ok: true, plan: preview.plan }
        : { ok: false, error: preview.result.output };
    },
    collabDispatchTimeoutMs: 1000,
  };
  const revision = () => {
    const read = readRevision(repo, git);
    if (!read.ok) throw new Error(read.error);
    return read.revision;
  };
  return {
    deps,
    db,
    herdr,
    repo,
    home,
    rulesFile,
    dispatch,
    workflows,
    revision,
    writerResult: ({ workflowId, attemptId, status = "impl-complete" }) =>
      JSON.stringify({
        version: RESULT_VERSION,
        workflowId,
        attemptId,
        lane: "writer",
        status,
        revision: revision(),
        changedPaths: ["greeting.txt"],
        checks: [{ command: "cat greeting.txt", result: "pass" }],
        blockers: [],
      }),
    verifierResult: ({ workflowId, attemptId, laneId, status }) =>
      JSON.stringify({
        version: RESULT_VERSION,
        workflowId,
        attemptId,
        lane: "verifier",
        verifierLaneId: laneId,
        status,
        revision: revision(),
        changedPaths: [],
        checks: [],
        blockers: status === "pass" ? [] : ["greeting is wrong"],
      }),
  };
}
