import { realpathSync } from "node:fs";
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
