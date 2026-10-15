import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NativeLaunch } from "./native-argv.js";

/**
 * Per-launch preparation that native argv alone cannot express (Kai 2026-10-14 8:25 PM PT,
 * AGENT-285). Every step fails closed: an error means the lane is not started.
 */
export type LaunchPrep = "claude-writer" | "grok-profiles" | "cursor-config";

export interface PrepContext {
  cwd: string;
  laneId: string;
  routerHome: string;
  /** The user's home directory (where ~/.claude, ~/.grok and ~/.cursor live). */
  home?: string;
}

export type PrepResult =
  { ok: true; argv: string[]; env: Record<string, string> } | { ok: false; error: string };

export function prepareNativeLaunch(
  launch: Pick<NativeLaunch, "argv" | "prepare">,
  ctx: PrepContext,
): PrepResult {
  const home = ctx.home ?? os.homedir();
  try {
    switch (launch.prepare) {
      case undefined:
        return { ok: true, argv: launch.argv, env: {} };
      case "claude-writer":
        return prepareClaudeWriter(launch.argv, ctx.cwd, home);
      case "grok-profiles":
        ensureGrokProfiles(home, ctx.routerHome);
        return { ok: true, argv: launch.argv, env: {} };
      case "cursor-config":
        return {
          ok: true,
          argv: launch.argv,
          env: { CURSOR_CONFIG_DIR: writeCursorConfig(home, ctx.routerHome, ctx.laneId, ctx.cwd) },
        };
    }
  } catch (error) {
    return {
      ok: false,
      error: `launch preparation (${launch.prepare}) failed: ${(error as Error).message}`,
    };
  }
}

function readJson(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

/** Hook groups from user settings whose commands are Herdr's pane-status hooks. */
export function herdrHooks(
  userSettings: Record<string, unknown> | undefined,
): Record<string, unknown[]> {
  const hooks = (userSettings?.hooks ?? {}) as Record<string, unknown[]>;
  const out: Record<string, unknown[]> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups.filter((group) =>
      JSON.stringify((group as { hooks?: unknown }).hooks ?? []).includes("/herdr-"),
    );
    if (kept.length > 0) out[event] = kept;
  }
  return out;
}

/**
 * A writer Claude loads only project and local settings (`--setting-sources project,local`),
 * so no user allow rule can approve a command the sandbox excludes. Herdr's status hooks are
 * carried over from the user settings in hmr's own `--settings`. A project or local setting
 * that lets a command run outside the sandbox refuses the launch.
 */
function prepareClaudeWriter(argv: string[], cwd: string, home: string): PrepResult {
  for (const name of ["settings.json", "settings.local.json"]) {
    const file = path.join(cwd, ".claude", name);
    const settings = readJson(file);
    const sandbox = (settings?.sandbox ?? {}) as Record<string, unknown>;
    const excluded = sandbox.excludedCommands;
    if (Array.isArray(excluded) && excluded.length > 0) {
      return {
        ok: false,
        error: `${file} sets sandbox.excludedCommands; a writer Claude could run those outside the sandbox, so it was not launched`,
      };
    }
    if (sandbox.enabled === false || sandbox.allowUnsandboxedCommands === true) {
      return { ok: false, error: `${file} weakens the sandbox; a writer Claude was not launched` };
    }
  }
  const index = argv.indexOf("--settings");
  if (index < 0 || index + 1 >= argv.length)
    return { ok: false, error: "writer Claude argv has no --settings" };
  const settings = JSON.parse(argv[index + 1]!) as Record<string, unknown>;
  const hooks = herdrHooks(readJson(path.join(home, ".claude", "settings.json")));
  const next = [...argv];
  next[index + 1] = JSON.stringify(
    Object.keys(hooks).length > 0 ? { ...settings, hooks } : settings,
  );
  return { ok: true, argv: next, env: {} };
}

export const GROK_WRITER_PROFILE = "hmr-writer";
export const GROK_READ_PROFILE = "hmr-read-only";
const BEGIN = "# >>> hmr managed (herdr-model-router AGENT-285) — do not edit inside this block";
const END = "# <<< hmr managed";

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** The managed block hmr keeps in ~/.grok/sandbox.toml. Custom profiles fail closed. */
export function grokProfilesBlock(routerHome: string): string {
  return [
    BEGIN,
    `[profiles.${GROK_WRITER_PROFILE}]`,
    'extends = "workspace"',
    `read_write = [${tomlString(path.resolve(routerHome))}]`,
    "",
    `[profiles.${GROK_READ_PROFILE}]`,
    'extends = "read-only"',
    END,
    "",
  ].join("\n");
}

export function ensureGrokProfiles(home: string, routerHome: string): string {
  const file = path.join(home, ".grok", "sandbox.toml");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const block = grokProfilesBlock(routerHome);
  const start = current.indexOf(BEGIN);
  const end = current.indexOf(END);
  let next: string;
  if (start >= 0 && end > start) {
    next = current.slice(0, start) + block + current.slice(end + END.length).replace(/^\n/, "");
  } else {
    if (/\[profiles\.hmr-(writer|read-only)\]/.test(current)) {
      throw new Error(`${file} defines an hmr profile outside hmr's managed block`);
    }
    next = (current && !current.endsWith("\n") ? current + "\n" : current) + block;
  }
  if (next !== current) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, next);
  }
  return file;
}

/**
 * Deny rules for Cursor's own Write tool: every existing sibling of every ancestor of the
 * worktree, so writes outside are denied rather than prompted. Cursor globs have no negation,
 * and `*` crosses `/`, so a NEW file directly inside an ancestor directory is not covered.
 */
export function cursorDenyRules(worktree: string, keep: readonly string[] = []): string[] {
  const target = realpathSync(worktree);
  const keepReal = keep.filter((dir) => existsSync(dir)).map((dir) => realpathSync(dir));
  const deny: string[] = [];
  let ancestor = path.parse(target).root;
  for (const part of target.split(path.sep).filter(Boolean)) {
    let children: string[] = [];
    try {
      children = readdirSync(ancestor);
    } catch {
      children = [];
    }
    for (const child of children) {
      if (child === part) continue;
      const full = path.join(ancestor, child);
      if (keepReal.some((dir) => dir === full || dir.startsWith(full + path.sep))) continue;
      deny.push(`Write(${full}/**)`);
    }
    ancestor = path.join(ancestor, part);
  }
  return deny;
}

const CURSOR_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A per-launch Cursor config dir inside hmr's state folder: allowlist approvals, sandbox on,
 * and only the login record (`authInfo`) copied from ~/.cursor/cli-config.json. The token
 * itself stays in the OS keychain, so a refresh there is picked up; the record is re-copied
 * on every launch. The global config is never modified. Files are 0600 in a 0700 dir.
 */
export function writeCursorConfig(
  home: string,
  routerHome: string,
  laneId: string,
  cwd: string,
): string {
  const global = readJson(path.join(home, ".cursor", "cli-config.json"));
  if (!global?.authInfo) {
    throw new Error(
      "cursor-agent is not logged in (no authInfo in ~/.cursor/cli-config.json); log in yourself, hmr never authorizes",
    );
  }
  const root = path.join(routerHome, "cursor-config");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  for (const entry of readdirSync(root)) {
    const dir = path.join(root, entry);
    try {
      if (Date.now() - statSync(dir).mtimeMs > CURSOR_PRUNE_MS)
        rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  const dir = path.join(root, laneId.replace(/[^A-Za-z0-9_-]/g, "_"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const sandbox = (global.sandbox ?? {}) as Record<string, unknown>;
  const tmp = os.tmpdir();
  const config = {
    version: global.version ?? 1,
    authInfo: global.authInfo,
    approvalMode: "allowlist",
    sandbox: {
      mode: "enabled",
      ...(sandbox.networkAccess ? { networkAccess: sandbox.networkAccess } : {}),
    },
    showSandboxIntro: false,
    permissions: {
      allow: ["Write(./**)", `Write(${path.resolve(routerHome)}/**)`, `Write(${tmp}/**)`],
      deny: cursorDenyRules(cwd, [routerHome, tmp]),
    },
  };
  const file = path.join(dir, "cli-config.json");
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  chmodSync(file, 0o600);
  const hooks = path.join(home, ".cursor", "hooks.json");
  if (existsSync(hooks)) {
    writeFileSync(path.join(dir, "hooks.json"), readFileSync(hooks), { mode: 0o600 });
  }
  return dir;
}
