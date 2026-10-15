import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeSync,
} from "node:fs";
import path from "node:path";

/**
 * hmr's Cursor-only private folder: the per-launch Cursor config dirs and the out-of-worktree
 * guard's ready files and log. It sits beside hmr's state folder, never inside it, because a
 * writer's sandboxed shell may write the state folder (Kai 2026-10-15 12:21 AM PT, same as
 * Codex) and must not be able to edit its own live permissions or the guard's records.
 */
export function cursorPrivateHome(routerHome: string): string {
  const resolved = path.resolve(routerHome);
  let base = resolved;
  try {
    base = realpathSync(resolved);
  } catch {
    /* not created yet */
  }
  return `${base.replace(/[\\/]+$/, "")}.cursor-private`;
}

/**
 * Creates (0700) or checks one level of hmr's Cursor private folder: it must be a real
 * directory, never a symlink, and resolve to exactly its own path, so the live config can never
 * be redirected into a root the writer's shell may write (PR #23 review 2). Throws otherwise.
 */
export function realPrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  const parent = realpathSync(path.dirname(dir));
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    realpathSync(dir) !== path.join(parent, path.basename(dir))
  ) {
    throw new Error(`${dir} is not a real directory; a Cursor writer was not launched`);
  }
  chmodSync(dir, 0o700);
}

/**
 * Writes or appends to a file directly inside a checked private dir, refusing to follow a
 * symlink at the file itself (O_NOFOLLOW), mode 0600.
 */
export function writePrivateFile(file: string, text: string, append: boolean): void {
  realPrivateDir(path.dirname(file));
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_NOFOLLOW |
    (append ? constants.O_APPEND : constants.O_TRUNC);
  const fd = openSync(file, flags, 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}
