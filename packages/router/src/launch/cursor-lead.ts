/**
 * Herdr lead panes running `cursor-agent` (Kai 2026-10-14 11:18 PM PT): they get the same
 * sandboxed per-launch config as an hmr Cursor writer (allowlist approvals, sandbox on, the
 * out-of-worktree prompt guard), never the user's global "Run Everything" setting. A shim named
 * `cursor-agent`, first on PATH only inside Herdr panes, runs `hmr cursor-lead`; outside Herdr,
 * or for a launch that already has its own CURSOR_CONFIG_DIR (an hmr lane), it runs the real
 * binary unchanged. hmr's own executable lookup skips the shim directory.
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveExecutable } from "../rules/launch-script.js";

export const ZSHRC_BEGIN = "# >>> hmr cursor-agent shim (herdr-model-router AGENT-285) >>>";
export const ZSHRC_END = "# <<< hmr cursor-agent shim <<<";

export function shimDir(routerHome: string): string {
  return path.join(routerHome, "shims");
}

/** PATH without the shim directory, so hmr and the shim always find the real binary. */
export function pathWithoutShim(searchPath: string | undefined, routerHome: string): string {
  const shim = path.resolve(shimDir(routerHome));
  return (searchPath ?? "")
    .split(path.delimiter)
    .filter((dir) => dir && path.resolve(dir) !== shim)
    .join(path.delimiter);
}

export function shimScript(nodePath: string, cliPath: string): string {
  const q = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  return [
    "#!/bin/sh",
    "# hmr cursor-agent shim (AGENT-285, Kai 2026-10-14 11:18 PM PT). Managed by `hmr cursor-shim install`.",
    "# In a Herdr pane with no per-launch config, cursor-agent runs through hmr's sandboxed lead config.",
    'if [ -n "$HERDR_PANE_ID" ] && [ -z "$CURSOR_CONFIG_DIR" ]; then',
    `  exec ${q(nodePath)} ${q(cliPath)} cursor-lead -- "$@"`,
    "fi",
    `exec ${q(nodePath)} ${q(cliPath)} cursor-lead --passthrough -- "$@"`,
    "",
  ].join("\n");
}

export function zshrcBlock(dir: string): string {
  return [
    ZSHRC_BEGIN,
    `[ -n "$HERDR_PANE_ID" ] && export PATH=${JSON.stringify(dir)}:"$PATH"`,
    ZSHRC_END,
    "",
  ].join("\n");
}

/** Writes the shim and the Herdr-only PATH block in ~/.zshrc (idempotent). */
export function installCursorShim(input: {
  routerHome: string;
  home: string;
  nodePath: string;
  cliPath: string;
}): string[] {
  const dir = shimDir(input.routerHome);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const shim = path.join(dir, "cursor-agent");
  writeFileSync(shim, shimScript(input.nodePath, input.cliPath), { mode: 0o700 });
  chmodSync(shim, 0o700);
  const rc = path.join(input.home, ".zshrc");
  const current = existsSync(rc) ? readFileSync(rc, "utf8") : "";
  const block = zshrcBlock(dir);
  const start = current.indexOf(ZSHRC_BEGIN);
  const stop = current.indexOf(ZSHRC_END);
  let next: string;
  if (start >= 0 && stop > start) {
    next =
      current.slice(0, start) + block + current.slice(stop + ZSHRC_END.length).replace(/^\n/, "");
  } else {
    next = (current && !current.endsWith("\n") ? `${current}\n` : current) + block;
  }
  if (next !== current) writeFileSync(rc, next);
  return [`shim: ${shim}`, `zshrc: ${rc} (PATH block only inside Herdr panes)`];
}

export function realCursorAgent(env: NodeJS.Dict<string>, routerHome: string): string | undefined {
  return resolveExecutable("cursor-agent", pathWithoutShim(env.PATH, routerHome));
}

/** Runs a command attached to this terminal and resolves with its exit code. */
export function runAttached(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { stdio: "inherit", env });
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
    child.on("error", () => resolve(127));
  });
}

/** Flags that would loosen a lead's approvals or sandbox; the lead refuses them. */
export function loosenedCursorArgs(args: readonly string[]): string[] {
  const bad: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-f" || arg === "--force" || arg === "--yolo" || arg.startsWith("--force="))
      bad.push(arg);
    if (arg === "--sandbox" && args[i + 1] !== "enabled")
      bad.push(`${arg} ${args[i + 1] ?? ""}`.trim());
    if (arg.startsWith("--sandbox=") && arg !== "--sandbox=enabled") bad.push(arg);
  }
  return bad;
}
