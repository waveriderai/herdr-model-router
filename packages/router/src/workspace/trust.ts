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
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
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

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.hmr-${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** Claude Code's own trust record. Leaves the file alone when it already trusts the dir. */
export function trustForClaude(dir: string, env: Env = process.env): boolean {
  const file = path.join(home(env), ".claude.json");
  if (!existsSync(file)) return false;
  const data = JSON.parse(readFileSync(file, "utf8")) as {
    projects?: Record<string, Record<string, unknown>>;
  };
  const projects = (data.projects ??= {});
  const entry = (projects[dir] ??= {});
  if (entry.hasTrustDialogAccepted === true) return false;
  entry.hasTrustDialogAccepted = true;
  writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
  return true;
}

/** Codex's own trust record. Appends a project table only when none exists for the dir. */
export function trustForCodex(dir: string, env: Env = process.env): boolean {
  const codexHome = env.CODEX_HOME ?? path.join(home(env), ".codex");
  const file = path.join(codexHome, "config.toml");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const header = `[projects.${JSON.stringify(dir)}]`;
  if (text.includes(header) || text.includes(`[projects.'${dir}']`)) return false;
  mkdirSync(codexHome, { recursive: true });
  const sep = text === "" || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  writeAtomic(file, `${text}${sep}${header}\ntrust_level = "trusted"\n`);
  return true;
}

/** Writes the trust record for one CLI kind, when HMR may trust the dir. Never throws. */
export function pretrust(
  kind: string,
  dir: string,
  env: Env = process.env,
): { trusted: boolean; argv: string[]; note?: string } {
  if (!isHmrTrusted(dir, env)) return { trusted: false, argv: [] };
  const target = canonical(dir);
  try {
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
