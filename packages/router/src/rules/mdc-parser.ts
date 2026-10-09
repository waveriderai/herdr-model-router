import { parseLaneSelector, type LaneSelector } from "./descriptor.js";

export interface RoleRule {
  /** Every name on the entry's left side, normalized; all of them share `lanes`. */
  names: string[];
  /** One lane per comma-separated entry, in order. Duplicates are separate lanes. */
  lanes: LaneSelector[];
  line: number;
}

export interface InvalidRole {
  line: number;
  names: string[];
  error: string;
}

export interface RuleSet {
  roles: RoleRule[];
  /** Entries whose lanes could not be parsed. Planning such a role fails with this error. */
  invalid: InvalidRole[];
}

export type ParseRulesResult = { ok: true; rules: RuleSet } | { ok: false; error: string };

/** Role names compare case-insensitively with collapsed whitespace. */
export function normalizeRoleName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Parses a pstack-models.mdc rules file: optional YAML frontmatter, `#` comments, and one
 * `role[, alias...]: lane[, lane...]` entry per line. Structural problems fail the whole file;
 * an entry with an unparseable lane is kept as invalid so other roles stay usable.
 */
export function parseRules(text: string): ParseRulesResult {
  const lines = text.split(/\r?\n/);
  let start = 0;
  const firstContent = lines.findIndex((line) => line.trim() !== "");
  if (firstContent >= 0 && lines[firstContent]!.trim() === "---") {
    const end = lines.findIndex((line, index) => index > firstContent && line.trim() === "---");
    if (end < 0) {
      return {
        ok: false,
        error: `frontmatter starting on line ${firstContent + 1} is not closed with ---`,
      };
    }
    start = end + 1;
  }
  const roles: RoleRule[] = [];
  const invalid: InvalidRole[] = [];
  const definedAt = new Map<string, number>();
  for (let index = start; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index]!.replace(/\s+#.*$/, "").trim();
    if (line === "" || line.startsWith("#")) continue;
    // The separator is the first colon followed by whitespace; descriptors use `provider:model`.
    const entry = /^([^:]+?):\s+(.+)$/.exec(line);
    if (!entry) {
      return { ok: false, error: `line ${lineNumber}: expected "role[, alias]: lane[, lane]"` };
    }
    const names = entry[1]!.split(",").map(normalizeRoleName);
    const lanesRaw = entry[2]!.split(",").map((lane) => lane.trim());
    if (names.some((name) => name === "") || lanesRaw.some((lane) => lane === "")) {
      return { ok: false, error: `line ${lineNumber}: empty role name or lane` };
    }
    for (const name of names) {
      const earlier = definedAt.get(name);
      if (earlier !== undefined) {
        return {
          ok: false,
          error: `role "${name}" is defined twice (lines ${earlier} and ${lineNumber})`,
        };
      }
      definedAt.set(name, lineNumber);
    }
    const lanes: LaneSelector[] = [];
    let error: string | undefined;
    lanesRaw.forEach((raw, laneIndex) => {
      if (error) return;
      const parsed = parseLaneSelector(raw);
      if (parsed.ok) lanes.push(parsed.lane);
      else error = `line ${lineNumber}, lane ${laneIndex + 1}: ${parsed.error}`;
    });
    if (error) invalid.push({ line: lineNumber, names, error });
    else roles.push({ names, lanes, line: lineNumber });
  }
  return { ok: true, rules: { roles, invalid } };
}
