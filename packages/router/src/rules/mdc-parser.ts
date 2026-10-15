import { parseLaneSelector, type LaneSelector } from "./descriptor.js";
import { providerIds } from "./provider-registry.js";

/**
 * One entry of a role's `# fallback:` order, in order. An entry that is not a lane selector
 * (for example `cursor Auto`) is kept with its error: older files wrote these lines as free
 * comments, so an unusable entry is skipped at run time instead of failing the role.
 */
export type FallbackEntry = { selector: string; line: number } & (
  { ok: true; lane: LaneSelector } | { ok: false; error: string }
);

export interface RoleRule {
  /** Every name on the entry's left side, normalized; all of them share `lanes`. */
  names: string[];
  /** One lane per comma-separated entry, in order. Duplicates are separate lanes. */
  lanes: LaneSelector[];
  /** Models to try, in order, when the launched model hits a quota or usage limit. */
  fallbacks: FallbackEntry[];
  line: number;
}

export interface InvalidRole {
  line: number;
  names: string[];
  error: string;
}

/**
 * Which account (provider CLI) runs a model, from `# hmr:` directives. Every field is optional:
 * without them the router picks, among the accounts able to run a lane's model, the one with
 * the most remaining quota.
 */
export interface AccountRules {
  /** `# hmr: first-version cursor`: a writer's first version runs here while it has quota. */
  firstVersion?: string;
  /** `# hmr: fix-accounts claude, grok`: `--phase fix` writers run on the one with most quota. */
  fixAccounts?: string[];
  /**
   * `# hmr: fix-accounts-for design implementation = codex`: per-role fix accounts (normalized
   * role name). For that role they replace `fix-accounts`; other roles keep the global list.
   */
  fixAccountsByRole?: Record<string, string[]>;
  /** `# hmr: review-only codex`: these accounts never run a writer (coding) lane. */
  reviewOnly: string[];
}

export interface RuleSet {
  roles: RoleRule[];
  /**
   * Role names marked read-only by `# hmr: readonly role[, role...]` directives (normalized).
   * Plain comments to older parsers, so the annotation is backward compatible.
   */
  readOnlyRoles: string[];
  accounts?: AccountRules;
  /** Entries whose lanes could not be parsed. Planning such a role fails with this error. */
  invalid: InvalidRole[];
}

export type ParseRulesResult = { ok: true; rules: RuleSet } | { ok: false; error: string };

/** `# hmr: readonly design consultant, review gate` (case-insensitive keyword). */
const HMR_DIRECTIVE = /^\s*#\s*hmr:/i;
const READONLY_BODY = /^readonly\s+(.+)$/i;
const ACCOUNT_BODY = /^(first-version|fix-accounts|review-only)\s+(.+)$/i;
const FIX_FOR_BODY = /^fix-accounts-for\s+(.+?)\s*=\s*(.+)$/i;
/**
 * `fallback: a, then b` at the start of a comment, or after a sentence in it
 * (`# UI code from the spec. fallback: a, then b`). `Gate fallback stays ...` is prose.
 */
const FALLBACK_BODY = /(?:^|[.;]\s+)fallback:\s*(.*)$/i;

/** The fallback order a comment declares, or undefined when the comment declares none. */
function fallbackSelectors(comment: string): string[] | undefined {
  const match = FALLBACK_BODY.exec(comment.trim());
  if (!match) return undefined;
  return match[1]!
    .split(/,|\s+then\s+/i)
    .map((entry) =>
      entry
        .trim()
        .replace(/^then\s+/i, "")
        .replace(/\.$/, "")
        .trim(),
    )
    .filter((entry) => entry !== "");
}

/** Role names compare case-insensitively with collapsed whitespace. */
export function normalizeRoleName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Parses a pstack-models.mdc rules file: optional YAML frontmatter, `#` comments, and one
 * `role[, alias...]: lane[, lane...]` entry per line. Structural problems fail the whole file;
 * an entry with an unparseable lane is kept as invalid so other roles stay usable.
 *
 * A `# fallback: a, then b` comment belongs to the role entry above it: as the entry's own
 * trailing comment, or on a comment line before the next entry.
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
  const readOnlyRoles = new Set<string>();
  const accounts: AccountRules = { reviewOnly: [] };
  /** The entry the next `# fallback:` comment belongs to, until another entry starts. */
  let current: { role?: RoleRule; fallbackLine?: number } = {};
  const attachFallback = (selectors: string[], lineNumber: number) => {
    const role = current.role;
    if (!role) return;
    if (current.fallbackLine !== undefined) {
      roles.splice(roles.indexOf(role), 1);
      invalid.push({
        line: role.line,
        names: role.names,
        error: `line ${lineNumber}: role "${role.names[0]}" already has a fallback order on line ${current.fallbackLine}; write one fallback line per role`,
      });
      current = {};
      return;
    }
    current.fallbackLine = lineNumber;
    role.fallbacks = selectors.map((selector): FallbackEntry => {
      const parsed = parseLaneSelector(selector);
      return parsed.ok
        ? { selector, line: lineNumber, ok: true, lane: parsed.lane }
        : { selector, line: lineNumber, ok: false, error: parsed.error };
    });
  };
  for (let index = start; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    if (HMR_DIRECTIVE.test(lines[index]!)) {
      // Drop a trailing `# comment` first, so it never becomes part of a role name.
      const body = lines[index]!.replace(HMR_DIRECTIVE, "")
        .replace(/\s+#.*$/, "")
        .trim();
      const fixFor = FIX_FOR_BODY.exec(body);
      if (fixFor) {
        const role = normalizeRoleName(fixFor[1]!);
        const ids = fixFor[2]!.split(",").map((id) => id.trim().toLowerCase());
        const unknown = ids.find((id) => !providerIds().includes(id));
        if (role === "" || unknown !== undefined) {
          return {
            ok: false,
            error: `line ${lineNumber}: fix-accounts-for needs "<role> = <account>[, account]" with known accounts (${providerIds().join(", ")})`,
          };
        }
        const byRole = (accounts.fixAccountsByRole ??= {});
        if (byRole[role]) {
          return {
            ok: false,
            error: `line ${lineNumber}: fix-accounts-for "${role}" is set twice`,
          };
        }
        byRole[role] = ids;
        continue;
      }
      const account = ACCOUNT_BODY.exec(body);
      if (account) {
        const keyword = account[1]!.toLowerCase();
        const ids = account[2]!.split(",").map((id) => id.trim().toLowerCase());
        const unknown = ids.find((id) => !providerIds().includes(id));
        if (unknown !== undefined) {
          return {
            ok: false,
            error: `line ${lineNumber}: unknown account "${unknown}" in ${keyword}; use one of ${providerIds().join(", ")}`,
          };
        }
        if (keyword === "first-version") {
          if (ids.length !== 1 || accounts.firstVersion !== undefined) {
            return {
              ok: false,
              error: `line ${lineNumber}: first-version names exactly one account, once per file`,
            };
          }
          accounts.firstVersion = ids[0]!;
        } else if (keyword === "fix-accounts") {
          if (accounts.fixAccounts !== undefined) {
            return { ok: false, error: `line ${lineNumber}: fix-accounts is set twice` };
          }
          accounts.fixAccounts = ids;
        } else {
          ids.forEach((id) => accounts.reviewOnly.includes(id) || accounts.reviewOnly.push(id));
        }
        continue;
      }
      const directive = READONLY_BODY.exec(body);
      if (!directive) {
        return {
          ok: false,
          error: `line ${lineNumber}: unknown hmr directive; write "# hmr: readonly role[, role]", "# hmr: first-version <account>", "# hmr: fix-accounts <account>[, account]" or "# hmr: review-only <account>[, account]"`,
        };
      }
      const names = directive[1]!.split(",").map(normalizeRoleName);
      if (names.some((name) => name === "")) {
        return { ok: false, error: `line ${lineNumber}: empty role name in readonly directive` };
      }
      names.forEach((name) => readOnlyRoles.add(name));
      continue;
    }
    const raw = lines[index]!;
    if (raw.trim().startsWith("#")) {
      const selectors = fallbackSelectors(raw.trim().slice(1));
      if (selectors) attachFallback(selectors, lineNumber);
      continue;
    }
    const trailing = /\s+#(.*)$/.exec(raw)?.[1];
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (line === "") continue;
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
    if (error) {
      invalid.push({ line: lineNumber, names, error });
      current = {};
      continue;
    }
    const role: RoleRule = { names, lanes, fallbacks: [], line: lineNumber };
    roles.push(role);
    current = { role };
    const selectors = trailing === undefined ? undefined : fallbackSelectors(trailing);
    if (selectors) attachFallback(selectors, lineNumber);
  }
  return { ok: true, rules: { roles, invalid, readOnlyRoles: [...readOnlyRoles], accounts } };
}
