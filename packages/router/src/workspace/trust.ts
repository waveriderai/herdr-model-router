/**
 * Pre-trusting workspaces HMR or Herdr created, so a new worktree does not open on a CLI's
 * "trust this folder?" dialog. The router never answers a dialog; it uses each CLI's own
 * documented trust record instead:
 * - Cursor: `cursor-agent --trust` (added to the launch argv);
 * - Claude Code: `projects[<dir>].hasTrustDialogAccepted` in ~/.claude.json;
 * - Codex: `[projects."<dir>"] trust_level = "trusted"` in ~/.codex/config.toml.
 * Only directories in the HMR trust list (`hmr trust <dir>`, or a worktree HMR created) or
 * under a Herdr worktree root (HMR_TRUSTED_WORKTREE_ROOTS, default ~/herdr-worktrees) count.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { parse as parseToml } from "smol-toml";
import path from "node:path";

type Env = NodeJS.Dict<string>;

function home(env: Env): string {
  return env.HOME ?? os.homedir();
}

function canonical(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

export function trustListPath(env: Env = process.env): string {
  return env.HMR_TRUST_LIST ?? path.join(home(env), ".config", "hmr", "trusted-dirs");
}

export function trustedRoots(env: Env = process.env): string[] {
  const raw = env.HMR_TRUSTED_WORKTREE_ROOTS ?? path.join(home(env), "herdr-worktrees");
  return raw
    .split(":")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(canonical);
}

function listed(env: Env): string[] {
  const file = trustListPath(env);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function within(dir: string, root: string): boolean {
  const rel = path.relative(root, dir);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** True when HMR may pre-trust this directory for a CLI. */
export function isHmrTrusted(dir: string, env: Env = process.env): boolean {
  const target = canonical(dir);
  return (
    trustedRoots(env).some((root) => within(target, root) && target !== root) ||
    listed(env).some((entry) => within(target, entry))
  );
}

/** Adds a directory to the HMR trust list (idempotent). */
export function addToTrustList(dir: string, env: Env = process.env): string {
  const target = canonical(dir);
  if (!listed(env).includes(target)) {
    const file = trustListPath(env);
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${target}\n`);
  }
  return target;
}

const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** An exclusive sibling lock file, so two HMR processes never interleave one config update. */
function withFileLock<T>(file: string, action: () => T): T {
  const lock = `${file}.hmr.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx", 0o600));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
      } catch {
        // Gone already: retry.
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${lock}`, { cause: error });
      sleepSync(50);
    }
  }
  try {
    return action();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // Already removed.
    }
  }
}

/**
 * Read-modify-write under the lock: the temp file is created exclusively with the original
 * file's mode (0600 when new), and the update is abandoned if the file changed between the
 * read and the rename. Residual risk, stated plainly: a native CLI does not take this lock, so
 * a CLI write landing in the microseconds between the last check and the rename is lost. The
 * CLIs replace these files the same way themselves, and the entry HMR adds is idempotent, so
 * the next launch re-adds it.
 */
function updateFile(file: string, change: (text: string) => string | undefined): boolean {
  return withFileLock(file, () => {
    const exists = existsSync(file);
    const before = exists ? readFileSync(file, "utf8") : "";
    const next = change(before);
    if (next === undefined) return false;
    const mode = exists ? statSync(file).mode & 0o777 : 0o600;
    const tmp = `${file}.hmr-${process.pid}-${Date.now()}.tmp`;
    const fd = openSync(tmp, "wx", mode);
    try {
      writeFileSync(fd, next);
      fchmodSync(fd, mode);
    } finally {
      closeSync(fd);
    }
    const now = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (now !== before) {
      unlinkSync(tmp);
      throw new Error(`${file} changed while HMR was updating it; nothing was written`);
    }
    renameSync(tmp, file);
    return true;
  });
}

/** Claude Code's own trust record. Leaves the file alone when it already trusts the dir. */
export function trustForClaude(dir: string, env: Env = process.env): boolean {
  const file = path.join(home(env), ".claude.json");
  if (!existsSync(file)) return false;
  return updateFile(file, (text) => {
    const data = JSON.parse(text) as { projects?: Record<string, Record<string, unknown>> };
    const projects = (data.projects ??= {});
    const entry = (projects[dir] ??= {});
    if (entry.hasTrustDialogAccepted === true) return undefined;
    entry.hasTrustDialogAccepted = true;
    return `${JSON.stringify(data, null, 2)}\n`;
  });
}

/** True when the parsed Codex config already has a `projects` entry for the dir. */
export function codexHasProject(text: string, dir: string): boolean {
  const data = parseToml(text) as { projects?: Record<string, unknown> };
  return Boolean(data.projects && Object.prototype.hasOwnProperty.call(data.projects, dir));
}

/**
 * Codex's own trust record. The config is parsed as TOML: an existing entry for the dir in
 * any legal spelling is left alone, a config that does not parse is never touched, and the
 * new text must parse with the dir trusted before it replaces the file.
 */
export function trustForCodex(dir: string, env: Env = process.env): boolean {
  const codexHome = env.CODEX_HOME ?? path.join(home(env), ".codex");
  const file = path.join(codexHome, "config.toml");
  mkdirSync(codexHome, { recursive: true });
  return updateFile(file, (text) => {
    if (codexHasProject(text, dir)) return undefined;
    const sep = text === "" || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    const next = `${text}${sep}[projects.${JSON.stringify(dir)}]\ntrust_level = "trusted"\n`;
    const parsed = parseToml(next) as { projects?: Record<string, { trust_level?: unknown }> };
    if (parsed.projects?.[dir]?.trust_level !== "trusted") {
      throw new Error("the updated Codex config did not trust the directory; nothing was written");
    }
    return next;
  });
}

/** Writes the trust record for one CLI kind, when HMR may trust the dir. Never throws. */
export function pretrust(
  kind: string,
  dir: string,
  env: Env = process.env,
): { trusted: boolean; argv: string[]; note?: string } {
  try {
    if (!isHmrTrusted(dir, env)) return { trusted: false, argv: [] };
    const target = canonical(dir);
    if (kind === "cursor") return { trusted: true, argv: ["--trust"] };
    if (kind === "claude") trustForClaude(target, env);
    if (kind === "codex") trustForCodex(target, env);
    return { trusted: true, argv: [] };
  } catch (error) {
    return { trusted: false, argv: [], note: `pre-trust for ${kind} failed: ${String(error)}` };
  }
}

/** `hmr trust <dir>`: list the dir and write every CLI's trust record now. */
export function trustDirectory(dir: string, env: Env = process.env): string[] {
  const target = addToTrustList(dir, env);
  const done = [`listed ${target}`];
  try {
    if (trustForClaude(target, env)) done.push("claude: trusted");
  } catch (error) {
    done.push(`claude: failed (${String(error)})`);
  }
  try {
    if (trustForCodex(target, env)) done.push("codex: trusted");
  } catch (error) {
    done.push(`codex: failed (${String(error)})`);
  }
  done.push("cursor: --trust at launch");
  return done;
}
