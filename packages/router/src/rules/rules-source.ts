import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export const RULES_FILE = "pstack-models.mdc";

export interface RulesSource {
  path: string;
  /** `flag`: --rules. `project`: inside the project. `user`: ~/.cursor/rules. */
  origin: "flag" | "project" | "user";
  /** SHA-256 of the exact text this source was parsed from, once it has been read. */
  sha256?: string;
}

/**
 * The nearest ancestor of `cwd` holding `.git` (a directory, or a worktree's `.git` file).
 * Pure file-system walk: no git process, so previews stay free of external commands.
 */
export function findProjectRoot(cwd: string): string | undefined {
  let current = path.resolve(cwd);
  for (;;) {
    if (existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Rules lookup order, first match wins. Each candidate names where it came from. */
export function rulesCandidates(input: {
  cwd: string;
  home: string;
  flag?: string;
}): RulesSource[] {
  if (input.flag) return [{ path: path.resolve(input.cwd, input.flag), origin: "flag" }];
  const project = findProjectRoot(input.cwd);
  return [
    ...(project
      ? ([
          { path: path.join(project, ".model-router", RULES_FILE), origin: "project" },
          { path: path.join(project, ".cursor/rules", RULES_FILE), origin: "project" },
        ] as RulesSource[])
      : []),
    { path: path.join(input.home, ".cursor/rules", RULES_FILE), origin: "user" },
  ];
}

export function locateRules(input: {
  cwd: string;
  home: string;
  flag?: string;
}): { ok: true; source: RulesSource } | { ok: false; error: string } {
  const candidates = rulesCandidates(input);
  const found = candidates.find(
    (candidate) => existsSync(candidate.path) && statSync(candidate.path).isFile(),
  );
  if (found) return { ok: true, source: found };
  return {
    ok: false,
    error: input.flag
      ? `Rules file not found: ${candidates[0]!.path}`
      : `No ${RULES_FILE} found. Looked in: ${candidates.map((candidate) => candidate.path).join(", ")}. Pass --rules <path>.`,
  };
}

export function readRules(source: RulesSource): string {
  return readFileSync(source.path, "utf8");
}

/**
 * Canonical identity of the worktree that `cwd` belongs to: the real path of its checkout
 * root (each Git worktree has its own), or of `cwd` outside Git. Keys writer ownership.
 */
export function worktreeIdentity(cwd: string): string {
  return realpathSync(findProjectRoot(cwd) ?? cwd);
}
