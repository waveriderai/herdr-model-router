import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import type { DispatchTask, Ownership } from "../store/dispatch-repository.js";
import type { GitRunner } from "./git-worktree.js";

/**
 * Host-side controlled commit (AGENT-285).
 *
 * Writer agents run sandboxed with no write access to `.git`. When a writer task is
 * complete, the host (outside the sandbox) commits its changes only after checking:
 *   1. the task is a completed writer task and no other task holds the worktree lock;
 *   2. the worktree is the task's own checkout (toplevel matches the recorded cwd);
 *   3. the branch and HEAD match what the caller expects (no agent-made commits);
 *   4. every changed path is inside the allowlist, is not under `.git`, is not a
 *      symlink, and nothing is already staged outside the allowlist.
 * It then stages exactly those paths, re-verifies the index, commits with repo hooks
 * disabled (hooks are agent-writable code that would otherwise run unsandboxed) and,
 * when asked, pushes the branch without force.
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
  ownerOf(worktreeId: string): Ownership | undefined;
}

export type HostCommitResult =
  | { ok: true; sha: string; files: string[]; pushed: boolean }
  | { ok: false; code: string; error: string; files?: string[] };

const SHA_RE = /^[0-9a-f]{40}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

function refuse(code: string, error: string, files?: string[]): HostCommitResult {
  return { ok: false, code, error, ...(files ? { files } : {}) };
}

/** Normalizes an allowlist entry; directories end with "/". Rejects escapes and `.git`. */
export function normalizeAllow(entry: string): string | undefined {
  const trimmed = entry.trim().replace(/^\.\//, "");
  if (!trimmed || path.isAbsolute(trimmed)) return undefined;
  const dir = trimmed.endsWith("/");
  const norm = path.posix.normalize(trimmed);
  const parts = norm.split("/").filter(Boolean);
  if (parts.length === 0 || parts.some((p) => p === ".." || p === "." || p === ".git")) {
    return undefined;
  }
  return parts.join("/") + (dir ? "/" : "");
}

export function pathAllowed(file: string, allow: readonly string[]): boolean {
  const parts = file.split("/");
  if (path.isAbsolute(file) || parts.some((p) => p === ".." || p === ".git" || p === "")) {
    return false;
  }
  return allow.some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry));
}

/** Parses `git status --porcelain=v1 -z -uall`; renames/copies contribute both paths. */
export function parsePorcelainZ(out: string): { paths: string[]; staged: string[] } {
  const fields = out.split("\0");
  const paths: string[] = [];
  const staged: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i];
    if (!rec || rec.length < 4) continue;
    const x = rec[0];
    const file = rec.slice(3);
    paths.push(file);
    if (x !== " " && x !== "?") staged.push(file);
    if (x === "R" || x === "C") {
      const orig = fields[++i];
      if (orig) {
        paths.push(orig);
        staged.push(orig);
      }
    }
  }
  return { paths, staged };
}

function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export async function hostCommit(
  store: HostCommitStore,
  git: GitRunner,
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
  const owner = store.ownerOf(task.worktreeId);
  if (owner && owner.taskId !== task.id) {
    return refuse("locked", `Worktree ${task.worktreeId} is locked by task ${owner.taskId}.`);
  }
  if (!BRANCH_RE.test(req.branch) || req.branch.includes("..") || req.branch.startsWith("-")) {
    return refuse("bad-branch", `Invalid branch name ${JSON.stringify(req.branch)}.`);
  }
  if (!SHA_RE.test(req.expectHead)) {
    return refuse("bad-head", "--expect-head must be a full 40-character commit SHA.");
  }
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

  const cwd = task.cwd;
  const top = await git(["rev-parse", "--show-toplevel"], cwd);
  if (!top.ok || canonical(top.stdout.trim()) !== canonical(cwd)) {
    return refuse("wrong-worktree", `${cwd} is not the top of its own git worktree.`);
  }
  const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd);
  if (!branch.ok || branch.stdout.trim() !== req.branch) {
    return refuse(
      "wrong-branch",
      `Worktree is on ${branch.stdout.trim() || "a detached HEAD"}, expected ${req.branch}.`,
    );
  }
  const head = await git(["rev-parse", "--verify", "HEAD^{commit}"], cwd);
  if (!head.ok || head.stdout.trim() !== req.expectHead) {
    return refuse(
      "unexpected-head",
      `HEAD is ${head.stdout.trim() || "unknown"}, expected ${req.expectHead}.`,
    );
  }
  const status = await git(["status", "--porcelain=v1", "-z", "-uall", "--no-renames"], cwd);
  if (!status.ok) return refuse("git-failed", `git status failed: ${status.stderr.trim()}`);
  const { paths } = parsePorcelainZ(status.stdout);
  const files = [...new Set(paths)].sort();
  if (files.length === 0) return refuse("no-changes", "No changes to commit.");
  const outside = files.filter((f) => !pathAllowed(f, allow));
  if (outside.length > 0) {
    return refuse(
      "unexpected-paths",
      `Changed paths outside the allowlist: ${outside.join(", ")}`,
      outside,
    );
  }
  const links = files.filter((f) => {
    try {
      return lstatSync(path.join(cwd, f)).isSymbolicLink();
    } catch {
      return false; // deleted file
    }
  });
  if (links.length > 0) return refuse("symlink", `Refusing symlinks: ${links.join(", ")}`, links);

  const add = await git(["add", "-A", "--", ...files.map((f) => `:(literal)${f}`)], cwd);
  if (!add.ok) return refuse("git-failed", `git add failed: ${add.stderr.trim()}`);
  const cached = await git(["diff", "--cached", "--name-only", "-z", "--no-renames"], cwd);
  const stagedNow = cached.stdout.split("\0").filter(Boolean).sort();
  if (!cached.ok || stagedNow.join("\0") !== files.join("\0")) {
    await git(["reset", "-q", "--", ...files.map((f) => `:(literal)${f}`)], cwd);
    return refuse(
      "index-mismatch",
      "Staged files did not match the checked file list; index reset.",
    );
  }
  const commit = await git(
    ["-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", req.message],
    cwd,
  );
  if (!commit.ok) return refuse("git-failed", `git commit failed: ${commit.stderr.trim()}`);
  const sha = (await git(["rev-parse", "HEAD"], cwd)).stdout.trim();
  const parent = (await git(["rev-parse", "HEAD^"], cwd)).stdout.trim();
  if (parent !== req.expectHead) {
    return refuse("unexpected-head", `New commit ${sha} does not sit on ${req.expectHead}.`);
  }
  let pushed = false;
  if (req.push) {
    const remote = req.remote ?? "origin";
    if (!/^[A-Za-z0-9._-]+$/.test(remote) || remote.startsWith("-")) {
      return refuse("bad-remote", `Invalid remote ${JSON.stringify(remote)}.`, files);
    }
    const push = await git(
      [
        "-c",
        "core.hooksPath=/dev/null",
        "push",
        "--no-verify",
        remote,
        `${sha}:refs/heads/${req.branch}`,
      ],
      cwd,
    );
    if (!push.ok) {
      return refuse(
        "push-failed",
        `Committed ${sha} but push failed: ${push.stderr.trim()}`,
        files,
      );
    }
    pushed = true;
  }
  return { ok: true, sha, files, pushed };
}
