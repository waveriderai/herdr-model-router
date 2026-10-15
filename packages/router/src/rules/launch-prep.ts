import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { grokProfileNames, type NativeLaunch } from "./native-argv.js";

/**
 * Per-launch preparation that native argv alone cannot express (Kai 2026-10-14 8:25 PM PT,
 * AGENT-285). Every step fails closed: an error means the lane is not started.
 */
export type LaunchPrep = "claude-writer" | "grok-profiles" | "cursor-config";

export interface PrepContext {
  cwd: string;
  laneId: string;
  routerHome: string;
  /** The user's home directory (where ~/.grok and ~/.cursor live). */
  home?: string;
  /** Claude's config dir the launch uses (`CLAUDE_CONFIG_DIR`, else ~/.claude). */
  claudeConfigDir?: string;
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
        return prepareClaudeWriter(
          launch.argv,
          ctx.cwd,
          ctx.claudeConfigDir ?? path.join(home, ".claude"),
        );
      case "grok-profiles":
        ensureGrokProfiles(home, ctx.routerHome);
        return { ok: true, argv: launch.argv, env: {} };
      case "cursor-config":
        return prepareCursorWriter(launch.argv, home, ctx);
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
function prepareClaudeWriter(argv: string[], cwd: string, claudeDir: string): PrepResult {
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
  const hooks = herdrHooks(readJson(path.join(claudeDir, "settings.json")));
  const next = [...argv];
  next[index + 1] = JSON.stringify(
    Object.keys(hooks).length > 0 ? { ...settings, hooks } : settings,
  );
  return { ok: true, argv: next, env: {} };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function markers(tag: string): { begin: string; end: string } {
  return {
    begin: `# >>> hmr managed ${tag} (herdr-model-router AGENT-285) — do not edit inside this block`,
    end: `# <<< hmr managed ${tag}`,
  };
}

/** The managed block for one router home in ~/.grok/sandbox.toml. Custom profiles fail closed. */
export function grokProfilesBlock(routerHome: string): string {
  const names = grokProfileNames(routerHome);
  const { begin, end } = markers(names.tag);
  return [
    begin,
    `[profiles.${names.writer}]`,
    'extends = "workspace"',
    `read_write = [${tomlString(path.resolve(routerHome))}]`,
    "",
    `[profiles.${names.readOnly}]`,
    'extends = "read-only"',
    end,
    "",
  ].join("\n");
}

/** Writes a file through a temp file and rename, so a reader never sees a partial file. */
function atomicWrite(file: string, content: string | Buffer, mode?: number): void {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, content, mode === undefined ? {} : { mode });
  if (mode !== undefined) chmodSync(temp, mode);
  renameSync(temp, file);
}

/**
 * Keeps this router home's block in ~/.grok/sandbox.toml, leaving every other line alone.
 * A lost race between two homes drops a block, and Grok then refuses to start (fails closed).
 */
export function ensureGrokProfiles(home: string, routerHome: string): string {
  const file = path.join(home, ".grok", "sandbox.toml");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const names = grokProfileNames(routerHome);
  const { begin, end } = markers(names.tag);
  const block = grokProfilesBlock(routerHome);
  const start = current.indexOf(begin);
  const stop = current.indexOf(end);
  let next: string;
  if (start >= 0 && stop > start) {
    next = current.slice(0, start) + block + current.slice(stop + end.length).replace(/^\n/, "");
  } else {
    const outside = new RegExp(`\\[profiles\\.(${names.writer}|${names.readOnly})\\]`);
    if (outside.test(current)) {
      throw new Error(`${file} defines an hmr profile outside hmr's managed block`);
    }
    next = (current && !current.endsWith("\n") ? current + "\n" : current) + block;
  }
  if (next !== current) {
    mkdirSync(path.dirname(file), { recursive: true });
    atomicWrite(file, next);
  }
  return file;
}

function real(dir: string): string | undefined {
  try {
    return realpathSync(dir);
  } catch {
    return undefined;
  }
}

/**
 * Deny rules for Cursor's own Write tool covering everything outside `allowed` that exists
 * now: walking down from `/` along each allowed root, every other entry is denied both exactly
 * and with `/**`. Cursor globs have no negation and `*` crosses `/`, so a NEW entry created
 * directly inside a directory on one of those paths is the one thing this cannot cover.
 */
export function cursorDenyRules(worktree: string, keep: readonly string[] = []): string[] {
  const allowed = [worktree, ...keep].map(real).filter((dir): dir is string => dir !== undefined);
  const deny: string[] = [];
  const walk = (dir: string): void => {
    let children: string[];
    try {
      children = readdirSync(dir);
    } catch {
      return;
    }
    for (const child of children) {
      const full = path.join(dir, child);
      if (allowed.includes(full)) continue;
      if (allowed.some((root) => root.startsWith(full + path.sep))) {
        let isDir: boolean;
        try {
          isDir = lstatSync(full).isDirectory();
        } catch {
          isDir = false;
        }
        if (isDir) {
          walk(full);
          continue;
        }
      }
      deny.push(`Write(${full})`, `Write(${full}/**)`);
    }
  };
  walk(path.parse(allowed[0] ?? "/").root);
  return deny;
}

const CURSOR_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A Cursor writer's own config dir (Kai 2026-10-14 8:25 PM PT). A project `.cursor/cli.json`
 * with permissions could widen the writer, so one refuses the launch.
 */
function prepareCursorWriter(argv: string[], home: string, ctx: PrepContext): PrepResult {
  const project = path.join(ctx.cwd, ".cursor", "cli.json");
  const settings = readJson(project);
  if (settings && "permissions" in settings) {
    return {
      ok: false,
      error: `${project} sets permissions, which would merge into the writer's allowlist; a Cursor writer was not launched`,
    };
  }
  return {
    ok: true,
    argv,
    env: { CURSOR_CONFIG_DIR: writeCursorConfig(home, ctx.routerHome, ctx.laneId, ctx.cwd) },
  };
}

/**
 * A per-launch Cursor config dir inside hmr's state folder: allowlist approvals, sandbox on,
 * and only the login record (`authInfo`) copied from ~/.cursor/cli-config.json. The token
 * itself stays in the OS keychain, so a refresh there is picked up; the record is re-copied
 * on every launch. The global config is never modified. Files are 0600 in a 0700 dir. The
 * writer's own Write tool is denied the whole cursor-config tree (deny beats allow), and its
 * sandboxed shell cannot write there, so it cannot change its live permissions.
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
  mkdirSync(routerHome, { recursive: true });
  const root = path.join(realpathSync(routerHome), "cursor-config");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  for (const entry of readdirSync(root)) {
    const dir = path.join(root, entry);
    try {
      if (Date.now() - statSync(dir).mtimeMs > CURSOR_PRUNE_MS) {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      /* best effort */
    }
  }
  const dir = path.join(root, laneId.replace(/[^A-Za-z0-9_-]/g, "_"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const sandbox = (global.sandbox ?? {}) as Record<string, unknown>;
  const tmp = real(os.tmpdir()) ?? os.tmpdir();
  const stateHome = realpathSync(routerHome);
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
      allow: ["Write(./**)", `Write(${stateHome}/**)`, `Write(${tmp}/**)`],
      deny: [`Write(${root})`, `Write(${root}/**)`, ...cursorDenyRules(cwd, [stateHome, tmp])],
    },
  };
  atomicWrite(path.join(dir, "cli-config.json"), JSON.stringify(config), 0o600);
  const hooks = path.join(home, ".cursor", "hooks.json");
  if (existsSync(hooks)) atomicWrite(path.join(dir, "hooks.json"), readFileSync(hooks), 0o600);
  return dir;
}
