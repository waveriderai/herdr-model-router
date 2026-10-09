import {
  chmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeSync,
  constants,
} from "node:fs";
import path from "node:path";
import { findProjectRoot } from "../rules/rules-source.js";

/**
 * Private per-workflow files under the router home: briefs, results, prompts handed to a
 * backend, and the agent-collab owner capability. Directories are 0700 and files 0600. A
 * symlink anywhere on the path is refused, and nothing is ever written inside a worktree.
 */
export interface ArtifactStore {
  /**
   * Writes a new file. An existing file with the same bytes is reused; different bytes throw
   * ArtifactConflictError, since recorded artifacts are immutable.
   */
  write(workflowId: string, name: string, content: string): string;
  read(workflowId: string, name: string): string;
  remove(workflowId: string, name: string): void;
  path(workflowId: string, name: string): string;
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class ArtifactError extends Error {}

/** A recorded artifact already exists with different content; it is never overwritten. */
export class ArtifactConflictError extends ArtifactError {
  readonly code = "artifact-conflict";
}

function checkSegment(value: string, what: string): string {
  if (!SAFE_SEGMENT.test(value) || value.includes("..")) {
    throw new ArtifactError(`${what} ${JSON.stringify(value)} is not a safe file name`);
  }
  return value;
}

function refuseSymlink(target: string): void {
  let stat;
  try {
    stat = lstatSync(target);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) {
    throw new ArtifactError(`${target} is a symlink; workflow artifacts never follow links`);
  }
}

function privateDir(dir: string): void {
  refuseSymlink(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  refuseSymlink(dir);
  if (process.platform !== "win32") chmodSync(dir, 0o700);
}

/** The real path of `value`, resolving its deepest existing ancestor when it does not exist. */
function realPathOf(value: string): string {
  const absolute = path.resolve(value);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = path.dirname(absolute);
    return parent === absolute ? absolute : path.join(realPathOf(parent), path.basename(absolute));
  }
}

/** True when `candidate` is `root` or inside it, comparing real paths. */
export function isInside(candidate: string, root: string): boolean {
  const real = realPathOf;
  const relative = path.relative(real(root), real(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function artifactStoreIn(home: string): ArtifactStore {
  const base = path.join(home, "workflows");
  const dirFor = (workflowId: string) => path.join(base, checkSegment(workflowId, "workflow id"));
  const fileFor = (workflowId: string, name: string) =>
    path.join(dirFor(workflowId), checkSegment(name, "artifact name"));
  return {
    path: fileFor,
    write(workflowId, name, content) {
      privateDir(home);
      privateDir(base);
      privateDir(dirFor(workflowId));
      const file = fileFor(workflowId, name);
      // O_EXCL refuses an existing file or a planted symlink; O_NOFOLLOW refuses a link.
      let fd: number;
      try {
        fd = openSync(
          file,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // A retry after a refusal writes the same bytes: reuse the recorded file. Anything
        // else is a conflict; a recorded artifact is never replaced.
        refuseSymlink(file);
        if (readFileSync(file, "utf8") === content) return file;
        throw new ArtifactConflictError(
          `${name} is already recorded for ${workflowId} with different content; it is not replaced.`,
        );
      }
      try {
        writeSync(fd, content);
      } finally {
        closeSync(fd);
      }
      return file;
    },
    read(workflowId, name) {
      const file = fileFor(workflowId, name);
      refuseSymlink(dirFor(workflowId));
      refuseSymlink(file);
      return readFileSync(file, "utf8");
    },
    remove(workflowId, name) {
      const file = fileFor(workflowId, name);
      refuseSymlink(file);
      rmSync(file, { force: true });
    },
  };
}

/**
 * Refuses a router home inside the checkout a command writes for, compared by real path so a
 * symlink alias does not slip through. Private state there could be committed, would change
 * the worktree's content fingerprint, and would put the owner capability inside the product
 * tree. Path validation only: processes of the same user are still trusted.
 */
export function privateHomeRefusal(home: string, cwd: string): string | undefined {
  const checkout = findProjectRoot(cwd) ?? cwd;
  return isInside(home, checkout)
    ? `The router home ${home} is inside the checkout ${checkout}. Set MODEL_ROUTER_HOME to a directory outside it; nothing was created.`
    : undefined;
}
