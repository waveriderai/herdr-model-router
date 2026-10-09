import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import type { Revision } from "./contracts.js";

/**
 * Runs one read-only git command without a shell and returns stdout, or throws. Git gets
 * only PATH and HOME, so a caller's GIT_DIR or GIT_WORK_TREE cannot point it elsewhere.
 */
export type GitRead = (args: readonly string[], cwd: string, input?: Buffer) => Buffer;

export function createGitRead(env: NodeJS.Dict<string>): GitRead {
  const childEnv = Object.fromEntries(
    (["PATH", "HOME"] as const).flatMap((key) => (env[key] ? [[key, env[key]]] : [])),
  );
  return (args, cwd, input) =>
    execFileSync("git", args, {
      cwd,
      env: childEnv,
      ...(input ? { input } : {}),
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
      timeout: 60_000,
    });
}

function nulList(output: Buffer): string[] {
  return output
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry.length > 0);
}

/** One path's line in the content fingerprint; undefined for a path that does not exist. */
function fileEntry(root: string, relative: string): string | undefined {
  const absolute = path.join(root, relative);
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch {
    // A deleted file is simply absent, as it is from a commit that removes it.
    return undefined;
  }
  if (stat.isSymbolicLink()) return `${relative}\0link\0${readlinkSync(absolute)}`;
  if (stat.isDirectory()) return `${relative}\0dir`;
  const digest = createHash("sha256").update(readFileSync(absolute)).digest("hex");
  return `${relative}\0file\0${stat.mode & 0o111 ? "x" : "-"}\0${digest}`;
}

export type RevisionResult =
  { ok: true; root: string; revision: Revision } | { ok: false; error: string };

/**
 * The reviewable state of a worktree: its HEAD, plus one fingerprint over the bytes of every
 * tracked and non-ignored untracked file. Staged, unstaged and untracked edits all change it
 * on the same HEAD; ignored files never do. The fingerprint does not depend on HEAD or the
 * index, so committing exactly the accepted files keeps it, and delivery can check that.
 * Reads only.
 */
export function readRevision(cwd: string, git: GitRead): RevisionResult {
  let root: string;
  let head: string;
  let listed: Buffer;
  try {
    root = git(["rev-parse", "--show-toplevel"], cwd).toString("utf8").trim();
    head = git(["rev-parse", "--verify", "HEAD"], root).toString("utf8").trim();
    listed = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], root);
  } catch (error) {
    return {
      ok: false,
      error: `cannot read the Git revision of ${cwd}: ${(error as Error).message.split("\n")[0]}`,
    };
  }
  const paths = [...new Set(nulList(listed))].sort();
  const hash = createHash("sha256");
  for (const relative of paths) {
    const entry = fileEntry(root, relative);
    if (entry !== undefined) hash.update(`${entry}\n`);
  }
  return { ok: true, root, revision: { head, content: hash.digest("hex") } };
}

/** Whether `ancestor` is reachable from `descendant`. A failed lookup is `false`, never a guess. */
export function isAncestor(
  git: GitRead,
  root: string,
  ancestor: string,
  descendant: string,
): boolean {
  try {
    git(["merge-base", "--is-ancestor", ancestor, descendant], root);
    return true;
  } catch {
    return false;
  }
}

/**
 * The same content fingerprint, computed from a commit's tree instead of the working tree:
 * what a delivery commit actually contains. Files that are dirty or untracked in the working
 * tree but absent from the commit do not count. Reads Git objects only.
 */
export function readCommitContent(
  git: GitRead,
  root: string,
  commit: string,
): { ok: true; head: string; content: string } | { ok: false; error: string } {
  let head: string;
  let listed: Buffer;
  try {
    head = git(["rev-parse", "--verify", `${commit}^{commit}`], root)
      .toString("utf8")
      .trim();
    listed = git(["ls-tree", "-r", "-z", "--full-tree", head], root);
  } catch (error) {
    return {
      ok: false,
      error: `cannot read commit ${commit}: ${(error as Error).message.split("\n")[0]}`,
    };
  }
  const entries = nulList(listed).map((line) => {
    const tab = line.indexOf("\t");
    const [mode, type, sha] = line.slice(0, tab).split(" ");
    return { mode: mode!, type: type!, sha: sha!, path: line.slice(tab + 1) };
  });
  const blobs = entries.filter((entry) => entry.type === "blob");
  const contents = new Map<string, Buffer>();
  if (blobs.length > 0) {
    const out = git(
      ["cat-file", "--batch"],
      root,
      Buffer.from(blobs.map((blob) => `${blob.sha}\n`).join("")),
    );
    let at = 0;
    for (const blob of blobs) {
      const headerEnd = out.indexOf(0x0a, at);
      const size = Number(out.subarray(at, headerEnd).toString("utf8").split(" ")[2]);
      contents.set(blob.sha, out.subarray(headerEnd + 1, headerEnd + 1 + size));
      at = headerEnd + 1 + size + 1;
    }
  }
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )) {
    const bytes = contents.get(entry.sha);
    const line =
      entry.mode === "120000"
        ? `${entry.path}\0link\0${bytes!.toString("utf8")}`
        : entry.type === "commit"
          ? `${entry.path}\0dir`
          : `${entry.path}\0file\0${entry.mode === "100755" ? "x" : "-"}\0${createHash("sha256").update(bytes!).digest("hex")}`;
    hash.update(`${line}\n`);
  }
  return { ok: true, head, content: hash.digest("hex") };
}
