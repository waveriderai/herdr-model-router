import { chmodSync, statSync } from "node:fs";

/**
 * chmod only when the permission bits differ. A Cursor writer's sandbox may write inside hmr's
 * state folder but refuses chmod on the folder itself, even a no-op one, so an already-private
 * path must not be chmodded again (AGENT-285, Kai 2026-10-15 12:21 AM PT). No-op on Windows.
 */
export function ensureMode(file: string, mode: number): void {
  if (process.platform === "win32") return;
  if ((statSync(file).mode & 0o777) === mode) return;
  chmodSync(file, mode);
}
