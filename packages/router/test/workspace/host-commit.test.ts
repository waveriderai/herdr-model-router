import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DispatchTask, Ownership } from "../../src/store/dispatch-repository.js";
import { createGitRunner } from "../../src/workspace/git-worktree.js";
import {
  hostCommit,
  normalizeAllow,
  pathAllowed,
  type HostCommitRequest,
} from "../../src/workspace/host-commit.js";
import { cleanupTempDirs, git, tempDir } from "./git-fixtures.js";

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "Router Test",
  GIT_AUTHOR_EMAIL: "router-test@example.invalid",
  GIT_COMMITTER_NAME: "Router Test",
  GIT_COMMITTER_EMAIL: "router-test@example.invalid",
};

function repo() {
  const dir = tempDir("router-hc-");
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "Router Test");
  git(dir, "config", "user.email", "router-test@example.invalid");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(dir, "README.md"), "x\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "checkout", "-q", "-b", "feature/x");
  const head = git(dir, "rev-parse", "HEAD").trim();
  return { dir, head };
}

function store(
  task: Partial<DispatchTask> & { cwd: string },
  owner?: Ownership,
): { getTask(id: string): DispatchTask | undefined; ownerOf(): Ownership | undefined } {
  const full: DispatchTask = {
    id: "t1",
    role: "design implementation",
    kind: "single",
    access: "write",
    worktreeId: "wt1",
    rulesPath: "/r",
    status: "complete",
    createdAt: "",
    updatedAt: "",
    ...task,
  };
  return { getTask: (id) => (id === full.id ? full : undefined), ownerOf: () => owner };
}

function req(head: string, over: Partial<HostCommitRequest> = {}): HostCommitRequest {
  return {
    taskId: "t1",
    branch: "feature/x",
    expectHead: head,
    allow: ["design/"],
    message: "design: add files",
    ...over,
  };
}

afterEach(() => cleanupTempDirs());

describe("allowlist helpers", () => {
  it("rejects escapes and .git", () => {
    expect(normalizeAllow("../x")).toBeUndefined();
    expect(normalizeAllow(".git/")).toBeUndefined();
    expect(normalizeAllow("/abs")).toBeUndefined();
    expect(normalizeAllow("./design/")).toBe("design/");
    expect(pathAllowed("design/a.png", ["design/"])).toBe(true);
    expect(pathAllowed("designer/a.png", ["design/"])).toBe(false);
    expect(pathAllowed("design/.git/config", ["design/"])).toBe(false);
  });
});

describe("hostCommit", () => {
  const run = createGitRunner(env);

  it("commits only allowlisted changes on the expected head", async () => {
    const { dir, head } = repo();
    mkdirSync(path.join(dir, "design"));
    writeFileSync(path.join(dir, "design", "a.md"), "a\n");
    const result = await hostCommit(store({ cwd: dir }), run, req(head));
    expect(result).toMatchObject({ ok: true, files: ["design/a.md"], pushed: false });
    expect(git(dir, "rev-parse", "HEAD^").trim()).toBe(head);
    expect(git(dir, "status", "--porcelain")).toBe("");
  });

  it("refuses unexpected paths and leaves the index untouched", async () => {
    const { dir, head } = repo();
    mkdirSync(path.join(dir, "design"));
    writeFileSync(path.join(dir, "design", "a.md"), "a\n");
    writeFileSync(path.join(dir, "README.md"), "changed\n");
    const result = await hostCommit(store({ cwd: dir }), run, req(head));
    expect(result).toMatchObject({ ok: false, code: "unexpected-paths", files: ["README.md"] });
    expect(git(dir, "rev-parse", "HEAD").trim()).toBe(head);
  });

  it("refuses when HEAD moved (an agent-made commit)", async () => {
    const { dir, head } = repo();
    mkdirSync(path.join(dir, "design"));
    writeFileSync(path.join(dir, "design", "a.md"), "a\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "sneaky");
    writeFileSync(path.join(dir, "design", "b.md"), "b\n");
    expect(await hostCommit(store({ cwd: dir }), run, req(head))).toMatchObject({
      ok: false,
      code: "unexpected-head",
    });
  });

  it("refuses the wrong branch, a lock held by another task, and incomplete tasks", async () => {
    const { dir, head } = repo();
    mkdirSync(path.join(dir, "design"));
    writeFileSync(path.join(dir, "design", "a.md"), "a\n");
    expect(await hostCommit(store({ cwd: dir }), run, req(head, { branch: "main" }))).toMatchObject(
      { code: "wrong-branch" },
    );
    expect(
      await hostCommit(
        store({ cwd: dir }, { worktreeId: "wt1", taskId: "other", acquiredAt: "" }),
        run,
        req(head),
      ),
    ).toMatchObject({ code: "locked" });
    expect(
      await hostCommit(store({ cwd: dir, status: "dispatched" }), run, req(head)),
    ).toMatchObject({ code: "not-complete" });
    expect(await hostCommit(store({ cwd: dir, access: "read" }), run, req(head))).toMatchObject({
      code: "not-writer",
    });
  });

  it("refuses symlinks", async () => {
    const { dir, head } = repo();
    mkdirSync(path.join(dir, "design"));
    symlinkSync("/etc/hosts", path.join(dir, "design", "link"));
    expect(await hostCommit(store({ cwd: dir }), run, req(head))).toMatchObject({
      code: "symlink",
    });
  });

  it("ignores a hostile pre-commit hook", async () => {
    const { dir, head } = repo();
    const hooks = tempDir("router-hooks-");
    writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    git(dir, "config", "core.hooksPath", hooks);
    mkdirSync(path.join(dir, "design"));
    writeFileSync(path.join(dir, "design", "a.md"), "a\n");
    expect(await hostCommit(store({ cwd: dir }), run, req(head))).toMatchObject({ ok: true });
  });
});
