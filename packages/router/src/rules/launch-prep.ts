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
  /** The temp dir a Cursor writer may write (default `os.tmpdir()`; tests override it). */
  tempDir?: string;
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
        return prepareClaudeWriter(launch.argv, ctx.claudeConfigDir ?? path.join(home, ".claude"));
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
 * Directories whose project settings a CLI started in `cwd` may load: `cwd` and each parent up
 * to the filesystem root, except the user's home itself (its config dirs are user settings).
 */
export function settingsDirs(cwd: string, home: string): string[] {
  const dirs: string[] = [];
  const homeReal = real(home) ?? path.resolve(home);
  let dir = real(cwd) ?? path.resolve(cwd);
  for (;;) {
    if (dir !== homeReal) dirs.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) return dirs;
    dir = parent;
  }
}

/**
 * A writer Claude loads no settings file (`--setting-sources ""`): user, project and local
 * allow rules, sandbox exclusions and hooks never apply, so nothing on disk can widen it.
 * Herdr's status hooks are carried over from the user settings into hmr's own `--settings`.
 */
function prepareClaudeWriter(argv: string[], claudeDir: string): PrepResult {
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

/** Keys a Cursor `sandbox.json` may set without widening a writer's shell sandbox. */
const CURSOR_SANDBOX_SAFE_KEYS = new Set(["additionalReadonlyPaths", "networkPolicy"]);

/**
 * Why a Cursor `sandbox.json` must stop a writer launch, or undefined when it is absent or
 * only narrows. Fails closed: unreadable JSON or any key not known to be safe refuses.
 */
export function cursorSandboxRefusal(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  let settings: Record<string, unknown> | undefined;
  try {
    settings = readJson(file);
  } catch {
    return `${file} is not valid JSON; a Cursor writer was not launched`;
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return `${file} is not a JSON object; a Cursor writer was not launched`;
  }
  const unsafe = Object.keys(settings).filter((key) => !CURSOR_SANDBOX_SAFE_KEYS.has(key));
  if (unsafe.length > 0) {
    return `${file} sets ${unsafe.join(", ")}, which could widen the writer's shell sandbox; a Cursor writer was not launched`;
  }
  return undefined;
}

/** `<dir>/.cursor`, or a settings file in it, when that entry is a symlink. */
export function cursorSettingsSymlink(dir: string): string | undefined {
  const cursorDir = path.join(dir, ".cursor");
  for (const entry of [
    cursorDir,
    path.join(cursorDir, "sandbox.json"),
    path.join(cursorDir, "cli.json"),
  ]) {
    try {
      if (lstatSync(entry).isSymbolicLink()) return entry;
    } catch {
      /* absent */
    }
  }
  return undefined;
}

/** The writer allow root (temp dir or router home) that contains `cwd`, if any. */
export function cursorWorktreeInsideAllowRoot(
  cwd: string,
  roots: readonly string[],
): string | undefined {
  const fold = (dir: string) => (real(dir) ?? path.resolve(dir)).toLowerCase();
  const worktree = fold(cwd);
  for (const root of roots) {
    const folded = fold(root);
    if (
      worktree === folded ||
      worktree.startsWith(folded.endsWith(path.sep) ? folded : folded + path.sep)
    ) {
      return real(root) ?? path.resolve(root);
    }
  }
  return undefined;
}

const CURSOR_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A Cursor writer's own config dir (Kai 2026-10-14 8:25 PM PT). A project `.cursor/cli.json`
 * with permissions could widen the writer, so one refuses the launch.
 */
function prepareCursorWriter(argv: string[], home: string, ctx: PrepContext): PrepResult {
  // Cursor loads `.cursor/cli.json` from the cwd and its parents; any that sets permissions
  // could merge into (and widen) the writer's allowlist.
  for (const dir of settingsDirs(ctx.cwd, home)) {
    const project = path.join(dir, ".cursor", "cli.json");
    let settings: Record<string, unknown> | undefined;
    try {
      settings = readJson(project);
    } catch {
      return { ok: false, error: `${project} is not valid JSON; a Cursor writer was not launched` };
    }
    if (settings && "permissions" in settings) {
      return {
        ok: false,
        error: `${project} sets permissions, which would merge into the writer's allowlist; a Cursor writer was not launched`,
      };
    }
  }
  // Cursor also loads `.cursor/sandbox.json` from the user's home and from the cwd and its
  // parents; one that adds writable roots or changes the sandbox type would widen the shell
  // sandbox, which CURSOR_CONFIG_DIR does not isolate. Any such file refuses the launch.
  const sandboxFiles = [
    path.join(home, ".cursor", "sandbox.json"),
    ...settingsDirs(ctx.cwd, home).map((dir) => path.join(dir, ".cursor", "sandbox.json")),
  ];
  // A symlinked `.cursor` or settings file would let the writer edit the live settings through
  // a target outside `.cursor`, past the deny rules and Cursor's protected-config check.
  for (const dir of [home, ...settingsDirs(ctx.cwd, home)]) {
    const linked = cursorSettingsSymlink(dir);
    if (linked) {
      return {
        ok: false,
        error: `${linked} is a symlink; Cursor's live settings must be real files, so a Cursor writer was not launched`,
      };
    }
  }
  for (const file of sandboxFiles) {
    const refusal = cursorSandboxRefusal(file);
    if (refusal) return { ok: false, error: refusal };
  }
  // The writer's extra allow roots (temp dir, router home) would let its native Write reach the
  // worktree's live `.cursor` settings under a case alias the deny rules miss, so a worktree
  // inside either refuses the launch (review round 8). Compared case-insensitively.
  const tempDir = ctx.tempDir ?? os.tmpdir();
  const nested = cursorWorktreeInsideAllowRoot(ctx.cwd, [tempDir, ctx.routerHome]);
  if (nested) {
    return {
      ok: false,
      error: `the worktree is inside ${nested}, which a Cursor writer may write freely; a Cursor writer was not launched`,
    };
  }
  return {
    ok: true,
    argv,
    env: {
      CURSOR_CONFIG_DIR: writeCursorConfig(home, ctx.routerHome, ctx.laneId, ctx.cwd, tempDir),
    },
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
  tempDir: string = os.tmpdir(),
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
  const tmp = real(tempDir) ?? tempDir;
  const stateHome = realpathSync(routerHome);
  const workspace = real(cwd) ?? path.resolve(cwd);
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
      // The worktree's own `.cursor` (sandbox.json, cli.json) is re-read live by Cursor and
      // could widen the shell sandbox, so the writer may never edit it (review round 7).
      deny: [
        `Write(${root})`,
        `Write(${root}/**)`,
        "Write(./.cursor)",
        "Write(./.cursor/**)",
        `Write(${workspace}/.cursor)`,
        `Write(${workspace}/.cursor/**)`,
        ...cursorDenyRules(cwd, [stateHome, tmp]),
      ],
    },
  };
  atomicWrite(path.join(dir, "cli-config.json"), JSON.stringify(config), 0o600);
  const hooks = path.join(home, ".cursor", "hooks.json");
  if (existsSync(hooks)) atomicWrite(path.join(dir, "hooks.json"), readFileSync(hooks), 0o600);
  return dir;
}
