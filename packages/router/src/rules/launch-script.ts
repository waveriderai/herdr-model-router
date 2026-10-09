import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

/**
 * Variables a native CLI keeps when the router starts it. Values are read from the new pane's
 * own shell at launch time, not from the router's process. Everything else, including every
 * provider API key and cloud credential the shell may export, is dropped by `env -i`.
 * The CLIs' own persistent login (config files, OS keychain) is untouched and stays the
 * operator's responsibility.
 */
export const LAUNCH_ENV_ALLOWLIST = [
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "COLORTERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
] as const;

/** The Herdr context every pane carries; a pane's own values identify it to Herdr. */
const HERDR_CONTEXT = [
  "HERDR_ENV",
  "HERDR_PANE_ID",
  "HERDR_TAB_ID",
  "HERDR_WORKSPACE_ID",
  "HERDR_SOCKET_PATH",
  "HERDR_BIN_PATH",
];

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Names (never values) to carry into the launched CLI: the allowlist, Herdr's context, and
 * any other `HERDR_*` name present in the router's environment.
 */
export function launchEnvNames(parentEnv: NodeJS.Dict<string>): string[] {
  const herdr = Object.keys(parentEnv).filter((name) => /^HERDR_[A-Z0-9_]+$/.test(name));
  return [...new Set([...LAUNCH_ENV_ALLOWLIST, ...HERDR_CONTEXT, ...herdr])].sort();
}

/** POSIX single quoting: the result is one literal shell word. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * A POSIX sh script that enters `cwd` and replaces itself with the CLI under `env -i`.
 * `${NAME+"NAME=$NAME"}` passes a variable only when the pane's shell has it set. The
 * executable and every argument are single-quoted; nothing from the plan is evaluated.
 */
export function launchScript(input: {
  executable: string;
  args: readonly string[];
  cwd: string;
  envNames: readonly string[];
}): string {
  for (const name of input.envNames) {
    if (!ENV_NAME.test(name)) throw new Error(`refusing unsafe environment name ${name}`);
  }
  if (!path.isAbsolute(input.executable)) {
    throw new Error(`the launch executable must be an absolute path: ${input.executable}`);
  }
  const lines = [
    "# Written by herdr-model-router for one lane launch. It starts the native CLI and nothing else.",
    `cd ${shQuote(input.cwd)} || exit 97`,
    "exec /usr/bin/env -i \\",
    ...input.envNames.map((name) => `  \${${name}+"${name}=$${name}"} \\`),
    `  ${[input.executable, ...input.args].map(shQuote).join(" ")}`,
    "",
  ];
  return lines.join("\n");
}

/**
 * The command line typed into the pane. Only the script path is interpolated, single-quoted,
 * which bash, zsh, and fish all read the same way as long as it has no quote of its own.
 */
export function paneCommand(scriptPath: string): string {
  if (!path.isAbsolute(scriptPath) || /['\n\r]/.test(scriptPath)) {
    throw new Error(`launch script path cannot be quoted safely for every shell: ${scriptPath}`);
  }
  return `/bin/sh '${scriptPath}'`;
}

/** First executable file named `name` on `searchPath`, as an absolute path. Reads only. */
export function resolveExecutable(
  name: string,
  searchPath: string | undefined,
): string | undefined {
  for (const dir of (searchPath ?? "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; keep looking.
    }
  }
  return undefined;
}
