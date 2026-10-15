/**
 * Herdr lead panes running `cursor-agent` (Kai 2026-10-14 11:18 PM PT): they get the same
 * sandboxed per-launch config as an hmr Cursor writer (allowlist approvals, sandbox on, the
 * out-of-worktree prompt guard), never the user's global "Run Everything" setting. A shim named
 * `cursor-agent`, first on PATH only inside Herdr panes, runs `hmr cursor-lead`; outside Herdr,
 * or for a launch that already has its own CURSOR_CONFIG_DIR (an hmr lane), it runs the real
 * binary unchanged. hmr's own executable lookup skips the shim directory.
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * Arguments a lead may pass, by allowlist (review round 10): `--model <id>` / `--model=<id>`,
 * `--resume` / `--resume=<id>`, `--continue`, and positional prompt text. Anything else that
 * starts with `-` (combined short flags such as `-pf`, `--workspace`, `--add-dir`, `--force`,
 * `--sandbox`, ...) is refused, since it could loosen approvals or move the workspace past the
 * checks hmr ran on the pane's cwd.
 */
export function disallowedCursorLeadArgs(args: readonly string[]): string[] {
  const bad: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("-")) continue;
    if (arg === "--model") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) bad.push(arg);
      else i++;
      continue;
    }
    if (/^--model=[^\s]+$/.test(arg)) continue;
    if (arg === "--resume" || /^--resume=[A-Za-z0-9_-]+$/.test(arg)) continue;
    if (arg === "--continue") continue;
    bad.push(arg);
  }
  return bad;
}

/**
 * Runs the lead's cursor-agent only under a live guard (review round 10): the guard starts
 * first; if it is not ready within `readyMs` after Cursor starts, or exits at any point while
 * Cursor runs, Cursor is stopped and the lead fails.
 */
export async function runGuardedLead(input: {
  real: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  guardArgs: readonly string[];
  guardEnv: NodeJS.ProcessEnv;
  readyFile: string;
  stderr: { write(text: string): unknown };
  readyMs?: number;
  nodePath?: string;
}): Promise<number> {
  rmSync(input.readyFile, { force: true });
  const guard = spawn(input.nodePath ?? process.execPath, input.guardArgs, {
    stdio: "ignore",
    env: input.guardEnv,
  });
  let guardExited = false;
  const agent = spawn(input.real, input.args, { stdio: "inherit", env: input.env });
  const stop = (why: string) => {
    if (agent.exitCode === null && agent.signalCode === null) {
      input.stderr.write(`\nhmr cursor-lead: ${why}; cursor-agent was stopped\n`);
      agent.kill("SIGTERM");
    }
  };
  guard.on("exit", () => {
    guardExited = true;
    stop("hmr's out-of-worktree guard exited");
  });
  guard.on("error", () => {
    guardExited = true;
    stop("hmr's out-of-worktree guard did not start");
  });
  const readyMs = input.readyMs ?? 60_000;
  const timer = setInterval(() => {
    if (existsSync(input.readyFile)) clearInterval(timer);
  }, 250);
  const deadline = setTimeout(() => {
    clearInterval(timer);
    if (!existsSync(input.readyFile)) stop("hmr's out-of-worktree guard was not ready in time");
  }, readyMs);
  const code = await new Promise<number>((resolve) => {
    agent.on("exit", (exit, signal) => resolve(exit ?? (signal ? 128 : 1)));
    agent.on("error", () => resolve(127));
  });
  clearTimeout(deadline);
  clearInterval(timer);
  if (!guardExited) guard.kill("SIGTERM");
  return existsSync(input.readyFile) && !guardExited ? code : code === 0 ? 2 : code;
}
