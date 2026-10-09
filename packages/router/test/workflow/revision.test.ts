import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createGitRead,
  isAncestor,
  readCommitContent,
  readRevision,
} from "../../src/workflow/revision.js";
import { commitAll, gitIn, makeRepo } from "../helpers/git-repo.js";

const git = createGitRead(process.env);

function revision(dir: string) {
  const read = readRevision(dir, git);
  if (!read.ok) throw new Error(read.error);
  return read.revision;
}

describe("worktree revision", () => {
  it("changes on the same HEAD for unstaged, staged and untracked edits, but not ignored files", () => {
    const dir = makeRepo();
    const base = revision(dir);
    expect(base.head).toMatch(/^[0-9a-f]{40}$/);

    mkdirSync(path.join(dir, "build"));
    writeFileSync(path.join(dir, "build", "out.txt"), "ignored output\n");
    expect(revision(dir)).toEqual(base);

    writeFileSync(path.join(dir, "a.txt"), "two\n");
    const unstaged = revision(dir);
    expect(unstaged.head).toBe(base.head);
    expect(unstaged.content).not.toBe(base.content);

    execFileSync("git", ["add", "a.txt"], { cwd: dir });
    // Staging the same bytes is the same reviewable content.
    expect(revision(dir)).toEqual(unstaged);

    writeFileSync(path.join(dir, "new.txt"), "untracked\n");
    const untracked = revision(dir);
    expect(untracked.content).not.toBe(unstaged.content);

    rmSync(path.join(dir, "new.txt"));
    expect(revision(dir)).toEqual(unstaged);
  });

  it("keeps the content fingerprint across a commit of exactly the reviewed files", () => {
    const dir = makeRepo();
    const base = revision(dir);
    writeFileSync(path.join(dir, "a.txt"), "reviewed\n");
    const reviewed = revision(dir);
    commitAll(dir, "deliver");
    const delivered = revision(dir);
    expect(delivered.content).toBe(reviewed.content);
    expect(delivered.head).not.toBe(reviewed.head);
    const root = readRevision(dir, git);
    expect(root.ok && isAncestor(git, root.root, base.head, delivered.head)).toBe(true);
    expect(root.ok && isAncestor(git, root.root, delivered.head, base.head)).toBe(false);
  });

  it("refuses a directory outside Git instead of guessing", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hmr-norepo-"));
    expect(readRevision(dir, git)).toMatchObject({ ok: false });
  });

  it("fingerprints a commit's tree the way it fingerprints the working tree", () => {
    const dir = makeRepo();
    writeFileSync(path.join(dir, "a.txt"), "changed\n");
    writeFileSync(path.join(dir, "b.txt"), "new\n");
    const worktree = revision(dir);
    gitIn(dir, "add", "a.txt");
    gitIn(dir, "commit", "-q", "-m", "partial");
    const partial = readCommitContent(git, dir, "HEAD");
    expect(partial.ok && partial.content).not.toBe(worktree.content);
    commitAll(dir, "rest");
    const full = readCommitContent(git, dir, "HEAD");
    expect(full.ok && full.content).toBe(worktree.content);
    // A deletion counts the same whether it is in the working tree or committed.
    rmSync(path.join(dir, "b.txt"));
    const deleted = revision(dir);
    commitAll(dir, "delete");
    const committed = readCommitContent(git, dir, "HEAD");
    expect(committed.ok && committed.content).toBe(deleted.content);
    expect(readCommitContent(git, dir, "no-such-rev")).toMatchObject({ ok: false });
  });
});
