import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** A throwaway Git repository with one commit, an ignored build/ directory, and a.txt. */
export function makeRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hmr-rev-"));
  const run = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.invalid",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.invalid",
      },
    });
  run("init", "-q", "-b", "main");
  writeFileSync(path.join(dir, ".gitignore"), "build/\n");
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  run("add", ".");
  run("commit", "-q", "-m", "base");
  return dir;
}

export function commitAll(dir: string, message: string): void {
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
  execFileSync("git", ["add", "-A"], { cwd: dir, env });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir, env });
}

/** Runs one git command in `dir` with a fixed identity and returns stdout. */
export function gitIn(dir: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  }).toString("utf8");
}
