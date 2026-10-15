import { spawn } from "node:child_process";
import {
  constants,
  mkdtempSync,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DispatchTask } from "../store/dispatch-repository.js";
import { gitEnv } from "./git-worktree.js";

/**
 * Host-side controlled commit (AGENT-285).
 *
 * Sandboxed writer agents never get `.git` write. After a writer task is complete, the host
 * (outside the sandbox) commits for it:
 *   1. atomically re-takes the worktree lock for the task and holds it until done;
 *   2. checks the checkout is the task's own worktree, on the expected branch, at the
 *      expected HEAD;
 *   3. lists changes with every Git helper that could run worktree-controlled code turned
 *      off (hooks, fsmonitor, untracked cache) and attributes pinned to the expected HEAD's
 *      tree, so an edited .gitattributes cannot select a filter;
 *   4. refuses any changed path outside the allowlist, under `.git`, or escaping the tree;
 *   5. reads each allowed file once itself (O_NOFOLLOW, regular files only), hashes those
 *      exact bytes with `--no-filters`, and builds the tree in a temporary index starting
 *      from the expected HEAD — the real index and working tree are never staged from;
 *   6. verifies the new tree differs from HEAD only in the checked paths, with regular-file
 *      modes only (no symlinks, no gitlinks);
 *   7. `commit-tree`, then a compare-and-swap `update-ref refs/heads/<branch> <new> <old>`
 *      on the named branch, so a moved branch or checkout fails instead of being overwritten;
 *   8. optionally pushes `<sha>:refs/heads/<branch>` with no force, no tags, no submodules,
 *      and confirms with `ls-remote` that the remote branch is now that SHA.
 */
export interface HostCommitRequest {
  taskId: string;
  branch: string;
  expectHead: string;
  allow: string[];
  message: string;
  push?: boolean;
  remote?: string;
}

export interface HostCommitStore {
  getTask(id: string): DispatchTask | undefined;
  acquireCommitLock(worktreeId: string, taskId: string): boolean;
  releaseCommitLock(worktreeId: string, taskId: string): void;
}

export interface GitOut {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Runs git with argv only (no shell). `indexFile` sets GIT_INDEX_FILE for that call only. */
export type HostGit = (args: string[], cwd: string, indexFile?: string) => Promise<GitOut>;

export type HostCommitResult =
  | { ok: true; sha: string; files: string[]; pushed: boolean }
  | { ok: false; code: string; error: string; files?: string[] };

const SHA_RE = /^[0-9a-f]{40}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;
const REMOTE_RE = /^[A-Za-z0-9._-]+$/;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** Settings applied to every git call: nothing worktree-controlled may execute. */
export const HARDEN = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "protocol.ext.allow=never",
  "-c",
  "push.followTags=false",
  "-c",
  "push.recurseSubmodules=no",
  "-c",
  "submodule.recurse=false",
];

export function createHostGit(env: NodeJS.Dict<string> = process.env): HostGit {
  const base = gitEnv(env);
  return (args, cwd, indexFile) =>
    new Promise((resolve) => {
      const childEnv = { ...base, ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}) };
      const child = spawn("git", [...HARDEN, ...args], {
        cwd,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ ok: false, stdout, stderr: String(e) });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ ok: code === 0, stdout, stderr });
      });
    });
}

function refuse(code: string, error: string, files?: string[]): HostCommitResult {
  return { ok: false, code, error, ...(files ? { files } : {}) };
}

/** Normalizes an allowlist entry; directories end with "/". Rejects escapes and `.git`. */
export function normalizeAllow(entry: string): string | undefined {
  const trimmed = entry.trim().replace(/^\.\//, "");
  if (!trimmed || path.isAbsolute(trimmed)) return undefined;
  const dir = trimmed.endsWith("/");
  const parts = path.posix.normalize(trimmed).split("/").filter(Boolean);
  if (
    parts.length === 0 ||
    parts.some((p) => p === ".." || p === "." || p.toLowerCase() === ".git")
  ) {
    return undefined;
  }
  return parts.join("/") + (dir ? "/" : "");
}

export function pathAllowed(file: string, allow: readonly string[]): boolean {
  const parts = file.split("/");
  if (
    path.isAbsolute(file) ||
    file.includes("\\") ||
    parts.some((p) => p === ".." || p === "." || p === "" || p.toLowerCase() === ".git")
  ) {
    return false;
  }
  return allow.some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry));
}

/** Parses `git status --porcelain=v1 -z` (run with --no-renames). */
export function parsePorcelainZ(out: string): string[] {
  const paths: string[] = [];
  const fields = out.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i];
    if (!rec || rec.length < 4) continue;
    paths.push(rec.slice(3));
    if (rec[0] === "R" || rec[0] === "C") {
      const orig = fields[++i];
      if (orig) paths.push(orig);
    }
  }
  return paths;
}

function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

type Snapshot =
  | { kind: "file"; bytes: Buffer; exec: boolean }
  | { kind: "deleted" }
  | { kind: "bad"; why: string };

/** Reads one file without following symlinks at the leaf or in any parent directory. */
export function snapshot(root: string, rel: string): Snapshot {
  let dir = root;
  const parts = rel.split("/");
  for (const part of parts.slice(0, -1)) {
    dir = path.join(dir, part);
    try {
      const st = lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory())
        return { kind: "bad", why: `${rel}: parent is not a plain directory` };
    } catch {
      return { kind: "deleted" };
    }
  }
  const full = path.join(root, rel);
  let fd: number;
  try {
    fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "deleted" };
    return {
      kind: "bad",
      why: `${rel}: ${code === "ELOOP" ? "symlink" : `cannot open (${code})`}`,
    };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { kind: "bad", why: `${rel}: not a regular file` };
    if (st.size > MAX_FILE_BYTES)
      return { kind: "bad", why: `${rel}: larger than ${MAX_FILE_BYTES} bytes` };
    const bytes = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, bytes, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    if (off !== st.size) return { kind: "bad", why: `${rel}: changed while reading` };
    return { kind: "file", bytes, exec: (st.mode & 0o111) !== 0 };
  } finally {
    closeSync(fd);
  }
}

export async function hostCommit(
  store: HostCommitStore,
  git: HostGit,
  req: HostCommitRequest,
): Promise<HostCommitResult> {
  const task = store.getTask(req.taskId);
  if (!task) return refuse("unknown-task", `Unknown task ${req.taskId}.`);
  if (task.access !== "write") return refuse("not-writer", `Task ${task.id} is not a writer task.`);
  if (task.status !== "complete") {
    return refuse(
      "not-complete",
      `Task ${task.id} is ${task.status}; only a completed writer task can be committed.`,
    );
  }
  if (
    !BRANCH_RE.test(req.branch) ||
    req.branch.includes("..") ||
    req.branch.startsWith("-") ||
    req.branch.endsWith(".lock")
  ) {
    return refuse("bad-branch", `Invalid branch name ${JSON.stringify(req.branch)}.`);
  }
  if (!SHA_RE.test(req.expectHead))
    return refuse("bad-head", "--expect-head must be a full 40-character commit SHA.");
  const remote = req.remote ?? "origin";
  if (!REMOTE_RE.test(remote) || remote.startsWith("-"))
    return refuse("bad-remote", `Invalid remote ${JSON.stringify(remote)}.`);
  const allow: string[] = [];
  for (const entry of req.allow) {
    const norm = normalizeAllow(entry);
    if (!norm)
      return refuse(
        "bad-allow",
        `Allowlist entry ${JSON.stringify(entry)} is not a safe relative path.`,
      );
    allow.push(norm);
  }
  if (allow.length === 0) return refuse("bad-allow", "At least one --allow path is required.");
  if (!req.message.trim()) return refuse("bad-message", "A commit message is required.");

  if (!store.acquireCommitLock(task.worktreeId, task.id)) {
    return refuse(
      "locked",
      `Worktree ${task.worktreeId} is locked by another task; nothing was committed.`,
    );
  }
  try {
    return await commitLocked(git, task.cwd, req, allow, remote);
  } finally {
    store.releaseCommitLock(task.worktreeId, task.id);
  }
}

async function commitLocked(
  git: HostGit,
  cwd: string,
  req: HostCommitRequest,
  allow: string[],
  remote: string,
): Promise<HostCommitResult> {
  const ref = `refs/heads/${req.branch}`;
  const top = await git(["rev-parse", "--show-toplevel"], cwd);
  if (!top.ok || canonical(top.stdout.trim()) !== canonical(cwd)) {
    return refuse("wrong-worktree", `${cwd} is not the top of its own git worktree.`);
  }
  const root = canonical(cwd);
  const sym = await git(["symbolic-ref", "--quiet", "HEAD"], root);
  if (!sym.ok || sym.stdout.trim() !== ref) {
    return refuse(
      "wrong-branch",
      `Worktree HEAD is ${sym.stdout.trim() || "detached"}, expected ${ref}.`,
    );
  }
  const head = await git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], root);
  if (!head.ok || head.stdout.trim() !== req.expectHead) {
    return refuse(
      "unexpected-head",
      `${ref} is ${head.stdout.trim() || "unknown"}, expected ${req.expectHead}.`,
    );
  }
  const attr = `--attr-source=${req.expectHead}`;
  const status = await git(
    [attr, "status", "--porcelain=v1", "-z", "-uall", "--no-renames", "--ignore-submodules=none"],
    root,
  );
  if (!status.ok) return refuse("git-failed", `git status failed: ${status.stderr.trim()}`);
  const files = [...new Set(parsePorcelainZ(status.stdout))].sort();
  if (files.length === 0) return refuse("no-changes", "No changes to commit.");
  const outside = files.filter((f) => !pathAllowed(f, allow));
  if (outside.length > 0) {
    return refuse(
      "unexpected-paths",
      `Changed paths outside the allowlist: ${outside.join(", ")}`,
      outside,
    );
  }

  const tmp = mkdtempSync(path.join(os.tmpdir(), "hmr-host-commit-"));
  const index = path.join(tmp, "index");
  try {
    const seed = await git(["read-tree", req.expectHead], root, index);
    if (!seed.ok) return refuse("git-failed", `read-tree failed: ${seed.stderr.trim()}`);
    const expected = new Map<string, string>(); // path -> "mode sha" or "deleted"
    const bad: string[] = [];
    for (const [i, rel] of files.entries()) {
      const snap = snapshot(root, rel);
      if (snap.kind === "bad") {
        bad.push(snap.why);
        continue;
      }
      if (snap.kind === "deleted") {
        const rm = await git(["update-index", "--force-remove", "--", rel], root, index);
        if (!rm.ok)
          return refuse("git-failed", `update-index failed for ${rel}: ${rm.stderr.trim()}`);
        expected.set(rel, "deleted");
        continue;
      }
      const blobFile = path.join(tmp, `blob-${i}`);
      writeFileSync(blobFile, snap.bytes, { mode: 0o600 });
      const hashed = await git(["hash-object", "-w", "--no-filters", "--", blobFile], root);
      const sha = hashed.stdout.trim();
      if (!hashed.ok || !SHA_RE.test(sha)) {
        return refuse("git-failed", `hash-object failed for ${rel}: ${hashed.stderr.trim()}`);
      }
      const mode = snap.exec ? "100755" : "100644";
      const add = await git(
        ["update-index", "--add", "--cacheinfo", `${mode},${sha},${rel}`],
        root,
        index,
      );
      if (!add.ok)
        return refuse("git-failed", `update-index failed for ${rel}: ${add.stderr.trim()}`);
      expected.set(rel, `${mode} ${sha}`);
    }
    if (bad.length > 0) return refuse("bad-file", `Refusing: ${bad.join("; ")}`, bad);

    const tree = await git(["write-tree"], root, index);
    const treeSha = tree.stdout.trim();
    if (!tree.ok || !SHA_RE.test(treeSha))
      return refuse("git-failed", `write-tree failed: ${tree.stderr.trim()}`);

    // Bind the result: the tree differs from HEAD only in checked paths, with exactly the
    // checked blobs and regular-file modes. No symlink (120000) or gitlink (160000) survives.
    const diff = await git(
      ["diff-tree", "-r", "-z", "--no-renames", "--raw", req.expectHead, treeSha],
      root,
    );
    if (!diff.ok) return refuse("git-failed", `diff-tree failed: ${diff.stderr.trim()}`);
    const fields = diff.stdout.split("\0").filter((f) => f.length > 0);
    const seen = new Set<string>();
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const meta = (fields[i] ?? "").replace(/^:/, "").split(" ");
      const rel = fields[i + 1] ?? "";
      const [, newMode = "", , newSha = "", st = ""] = meta;
      const want = expected.get(rel);
      const got = st === "D" ? "deleted" : `${newMode} ${newSha}`;
      if (!want || want !== got || !pathAllowed(rel, allow)) {
        return refuse("tree-mismatch", `Built tree changed ${rel} unexpectedly (${got}).`, [rel]);
      }
      if (st !== "D" && newMode !== "100644" && newMode !== "100755") {
        return refuse("bad-mode", `${rel} has mode ${newMode}.`, [rel]);
      }
      seen.add(rel);
    }
    const committed = [...seen].sort();
    if (committed.length === 0)
      return refuse("no-changes", "Changes match HEAD; nothing to commit.");

    const msgFile = path.join(tmp, "message");
    writeFileSync(msgFile, req.message.endsWith("\n") ? req.message : `${req.message}\n`);
    const commit = await git(["commit-tree", treeSha, "-p", req.expectHead, "-F", msgFile], root);
    const sha = commit.stdout.trim();
    if (!commit.ok || !SHA_RE.test(sha))
      return refuse("git-failed", `commit-tree failed: ${commit.stderr.trim()}`);

    // Compare-and-swap on the named branch: fails if it moved since we checked.
    const cas = await git(
      ["update-ref", "-m", `hmr host commit for ${req.taskId}`, ref, sha, req.expectHead],
      root,
    );
    if (!cas.ok)
      return refuse(
        "ref-moved",
        `${ref} moved; commit ${sha} was not applied: ${cas.stderr.trim()}`,
      );

    // Bring the worktree's own index to the new commit (checked files already match it).
    const symAfter = await git(["symbolic-ref", "--quiet", "HEAD"], root);
    if (symAfter.ok && symAfter.stdout.trim() === ref) {
      await git(["read-tree", "--reset", sha], root);
      await git([attr, "update-index", "-q", "--refresh"], root);
    }

    let pushed = false;
    if (req.push) {
      const push = await git(
        [
          "push",
          "--no-verify",
          "--no-follow-tags",
          "--no-recurse-submodules",
          "--porcelain",
          "--",
          remote,
          `${sha}:${ref}`,
        ],
        root,
      );
      const check = await git(["ls-remote", "--", remote, ref], root);
      const remoteSha = check.stdout.trim().split(/\s+/)[0];
      if (!push.ok || !check.ok || remoteSha !== sha) {
        return refuse(
          "push-failed",
          `Committed ${sha} on ${ref}, but the remote branch is ${remoteSha || "unknown"}: ${push.stderr.trim()}`,
          committed,
        );
      }
      pushed = true;
    }
    return { ok: true, sha, files: committed, pushed };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
