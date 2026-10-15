import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DispatchTask } from "../../src/store/dispatch-repository.js";
import {
  createHostGit,
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

function store(task: Partial<DispatchTask> & { cwd: string }, lockedBy?: string) {
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
  let holder = lockedBy;
  const events: string[] = [];
  return {
    events,
    getTask: (id: string) => (id === full.id ? full : undefined),
    acquireCommitLock: (_w: string, t: string) => {
      if (holder) return false;
      holder = t;
      events.push("acquire");
      return true;
    },
    releaseCommitLock: (_w: string, t: string) => {
      if (holder === t) holder = undefined;
      events.push("release");
    },
  };
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
  const run = createHostGit(env);

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
    expect(await hostCommit(store({ cwd: dir }, "other"), run, req(head))).toMatchObject({
      code: "locked",
    });
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
      code: "bad-file",
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

  it("holds the lock for the whole commit and releases it", async () => {
    const { dir, head } = repo();
    mkdirSync(path.join(dir, "design"));
    writeFileSync(path.join(dir, "design", "a.md"), "a\n");
    const s = store({ cwd: dir });
    expect(await hostCommit(s, run, req(head))).toMatchObject({ ok: true });
    expect(s.events).toEqual(["acquire", "release"]);
  });

  it("never runs a configured fsmonitor or hooks on add/index updates", async () => {
    const { dir, head } = repo();
    const marker = path.join(tempDir("router-mark-"), "ran");
    const script = path.join(tempDir("router-fsm-"), "evil.sh");
    writeFileSync(script, `#!/bin/sh\ntouch ${marker}\nexit 1\n`, { mode: 0o755 });
    git(dir, "config", "core.fsmonitor", script);
    const hooks = tempDir("router-hooks2-");
    for (const h of ["post-index-change", "pre-commit", "post-commit", "reference-transaction"]) {
      writeFileSync(path.join(hooks, h), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    }
    git(dir, "config", "core.hooksPath", hooks);
    mkdirSync(path.join(dir, "design"));
    writeFileSync(path.join(dir, "design", "a.md"), "a\n");
    expect(await hostCommit(store({ cwd: dir }), run, req(head))).toMatchObject({ ok: true });
    expect(existsSync(marker)).toBe(false);
  });

  it("commits the bytes it read and leaves the worktree clean", async () => {
    const { dir, head } = repo();
    mkdirSync(path.join(dir, "design"));
    writeFileSync(path.join(dir, "design", "a.md"), "a\n");
    const r = await hostCommit(store({ cwd: dir }), run, req(head));
    expect(r.ok).toBe(true);
    expect(git(dir, "show", "HEAD:design/a.md")).toBe("a\n");
    expect(git(dir, "status", "--porcelain")).toBe("");
  });

  it("refuses when the branch no longer matches the checkout", async () => {
    const { dir, head } = repo();
    mkdirSync(path.join(dir, "design"));
    writeFileSync(path.join(dir, "design", "a.md"), "a\n");
    git(dir, "checkout", "-q", "-b", "other");
    expect(await hostCommit(store({ cwd: dir }), run, req(head))).toMatchObject({
      code: "wrong-branch",
    });
    expect(git(dir, "rev-parse", "feature/x").trim()).toBe(head);
  });

  it("pushes only the branch, no tags, and verifies the remote", async () => {
    const { dir, head } = repo();
    const bare = tempDir("router-bare-");
    git(bare, "init", "-q", "--bare");
    git(dir, "remote", "add", "origin", bare);
    git(dir, "tag", "secret-tag");
    git(dir, "config", "push.followTags", "true");
    mkdirSync(path.join(dir, "design"));
    writeFileSync(path.join(dir, "design", "a.md"), "a\n");
    const r = await hostCommit(store({ cwd: dir }), run, req(head, { push: true }));
    expect(r).toMatchObject({ ok: true, pushed: true });
    if (r.ok) expect(git(bare, "rev-parse", "refs/heads/feature/x").trim()).toBe(r.sha);
    expect(git(bare, "tag", "--list")).toBe("");
  });

  it("refuses a symlinked parent directory", async () => {
    const { dir, head } = repo();
    const outside = tempDir("router-out-");
    writeFileSync(path.join(outside, "secret.txt"), "secret\n");
    mkdirSync(path.join(dir, "design"));
    symlinkSync(outside, path.join(dir, "design", "sub"));
    const r = await hostCommit(store({ cwd: dir }), run, req(head));
    expect(r.ok).toBe(false);
    expect(git(dir, "rev-parse", "HEAD").trim()).toBe(head);
  });

  it("verifies every push URL", async () => {
    const { dir, head } = repo();
    const fetchBare = tempDir("router-fetch-");
    const pushBare = tempDir("router-push-");
    git(fetchBare, "init", "-q", "--bare");
    git(pushBare, "init", "-q", "--bare");
    git(dir, "remote", "add", "origin", fetchBare);
    git(dir, "config", "remote.origin.pushurl", pushBare);
    mkdirSync(path.join(dir, "design"));
    writeFileSync(path.join(dir, "design", "a.md"), "a\n");
    const r = await hostCommit(store({ cwd: dir }), run, req(head, { push: true }));
    expect(r).toMatchObject({ ok: true, pushed: true });
    if (r.ok) expect(git(pushBare, "rev-parse", "refs/heads/feature/x").trim()).toBe(r.sha);
  });

  it("never runs a configured clean filter", async () => {
    const { dir, head } = repo();
    const marker = path.join(tempDir("router-mark2-"), "ran");
    writeFileSync(path.join(dir, ".gitattributes"), "*.md filter=evil\n");
    git(dir, "add", ".gitattributes");
    git(dir, "commit", "-q", "-m", "attrs");
    const base = git(dir, "rev-parse", "HEAD").trim();
    git(dir, "config", "filter.evil.clean", `sh -c 'touch ${marker}; cat'`);
    git(dir, "config", "filter.evil.process", `sh -c 'touch ${marker}'`);
    rmMarker(marker);
    mkdirSync(path.join(dir, "design"));
    writeFileSync(path.join(dir, "design", "a.md"), "a\n");
    void head;
    expect(await hostCommit(store({ cwd: dir }), run, req(base))).toMatchObject({ ok: true });
    expect(existsSync(marker)).toBe(false);
  });

  it("never runs a filter selected by .git/info/attributes", async () => {
    const { dir, head } = repo();
    const marker = path.join(tempDir("router-mark3-"), "ran");
    mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
    writeFileSync(path.join(dir, ".git", "info", "attributes"), "*.md filter=evil.x\n");
    git(dir, "config", "filter.evil.x.clean", `sh -c 'touch ${marker}; cat'`);
    git(dir, "config", "filter.evil.x.process", `sh -c 'touch ${marker}'`);
    git(dir, "config", "filter.evil.x.required", "true");
    mkdirSync(path.join(dir, "design"));
    writeFileSync(path.join(dir, "design", "a.md"), "a\n");
    expect(await hostCommit(store({ cwd: dir }), run, req(head))).toMatchObject({ ok: true });
    expect(existsSync(marker)).toBe(false);
  });

  it("never runs an empty-named filter driver", async () => {
    const { dir, head } = repo();
    const marker = path.join(tempDir("router-mark4-"), "ran");
    mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
    writeFileSync(path.join(dir, ".git", "info", "attributes"), "*.md filter=\n");
    git(dir, "config", "filter..clean", `sh -c 'touch ${marker}; cat'`);
    mkdirSync(path.join(dir, "design"));
    writeFileSync(path.join(dir, "design", "a.md"), "a\n");
    expect(await hostCommit(store({ cwd: dir }), run, req(head))).toMatchObject({ ok: true });
    expect(existsSync(marker)).toBe(false);
  });
});

function rmMarker(p: string): void {
  try {
    rmSync(p);
  } catch {
    /* absent */
  }
}
