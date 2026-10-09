import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  sha256,
  SkillNameSchema,
  type ResolvedSkills,
  type SkillEvidence,
  type SkillRequest,
} from "./contracts.js";

/**
 * Shared skills, the Agent Skills way: a catalog of name, description and location, read from
 * roots the operator chose, with each SKILL.md read in full only by the agent that uses it.
 * Nothing here runs a process, opens the network, or reads a credential store: listing is a
 * directory read plus each SKILL.md's frontmatter and digest.
 */
export interface SkillEntry {
  name: string;
  description: string;
  /** Canonical skill directory (a link is followed to where it really lives). */
  dir: string;
  /** Canonical SKILL.md. */
  file: string;
  sha256: string;
  /** The trusted root it was found under, canonical. */
  root: string;
  linked: boolean;
}

export interface SkillProblem {
  name: string;
  root: string;
  code: "broken-link" | "invalid-metadata" | "unreadable";
  detail: string;
}

export interface SkillCatalog {
  roots: string[];
  entries: SkillEntry[];
  problems: SkillProblem[];
  /** A later root's skill hidden by an earlier root's skill of the same name. */
  shadowed: { name: string; root: string }[];
  /** Roots that are not a directory, or that could not be listed. */
  missingRoots: string[];
}

/** The `name` and `description` scalars of a SKILL.md frontmatter block, or why not. */
function frontmatter(text: string): { name?: string; description?: string } | undefined {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) return undefined;
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    fields[match[1]!] = match[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return { ...fields };
}

function canonicalDir(dir: string): string | undefined {
  try {
    const real = realpathSync(dir);
    return statSync(real).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}

export function skillCatalog(roots: readonly string[]): SkillCatalog {
  const catalog: SkillCatalog = {
    roots: [],
    entries: [],
    problems: [],
    shadowed: [],
    missingRoots: [],
  };
  const seen = new Set<string>();
  for (const given of roots) {
    const root = canonicalDir(given);
    if (!root) {
      catalog.missingRoots.push(given);
      continue;
    }
    let names: string[];
    try {
      names = readdirSync(root).sort();
    } catch {
      catalog.missingRoots.push(given);
      continue;
    }
    catalog.roots.push(root);
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const at = path.join(root, name);
      let linked: boolean;
      try {
        linked = lstatSync(at).isSymbolicLink();
      } catch {
        continue; // Gone since the directory was listed.
      }
      const dir = canonicalDir(at);
      if (!dir) {
        if (linked) {
          catalog.problems.push({
            name,
            root,
            code: "broken-link",
            detail: `${at} links to a missing directory`,
          });
        }
        continue;
      }
      const file = path.join(dir, "SKILL.md");
      let bytes: Buffer;
      try {
        bytes = readFileSync(file);
      } catch {
        continue; // Not a skill directory.
      }
      const text = bytes.toString("utf8");
      const meta = frontmatter(text);
      const validName = SkillNameSchema.safeParse(name).success;
      const description = meta?.description ?? "";
      if (!meta || !validName || meta.name !== name || !description || description.length > 1024) {
        catalog.problems.push({
          name,
          root,
          code: "invalid-metadata",
          detail: !meta
            ? `${file} has no frontmatter`
            : !validName
              ? `"${name}" is not a valid skill name`
              : meta.name !== name
                ? `${file} names "${meta.name ?? ""}", not its directory "${name}"`
                : `${file} needs a description of 1-1024 characters`,
        });
        continue;
      }
      if (seen.has(name)) {
        catalog.shadowed.push({ name, root });
        continue;
      }
      seen.add(name);
      catalog.entries.push({ name, description, dir, file, sha256: sha256(bytes), root, linked });
    }
  }
  return catalog;
}

export type CatalogStep =
  | { ok: true; catalog: SkillCatalog }
  | { ok: false; code: "skills-root-required" | "skills-root"; error: string };

/** The catalog of the operator's roots; every root must be a readable directory. */
export function openCatalog(roots: readonly string[]): CatalogStep {
  if (roots.length === 0) {
    return {
      ok: false,
      code: "skills-root-required",
      error:
        "Shared skills were requested, but no --skills-root was given. HMR reads skills only from roots the operator names.",
    };
  }
  const catalog = skillCatalog(roots);
  if (catalog.missingRoots.length > 0) {
    return {
      ok: false,
      code: "skills-root",
      error: `Skills root ${catalog.missingRoots.join(", ")} is not a readable directory.`,
    };
  }
  return { ok: true, catalog };
}

export type SkillsStep =
  | { ok: true; value: ResolvedSkills }
  | {
      ok: false;
      code:
        | "skills-root-required"
        | "skills-root"
        | "skill-missing"
        | "reference-missing"
        | "reference-untrusted";
      error: string;
    };

function within(file: string, base: string): boolean {
  const relative = path.relative(base, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Where a declared reference may live: inside an operator root, inside the skill's own real
 * directory, or inside another cataloged skill's real directory. A linked skill's target
 * parent is not trusted by itself: a pstack sibling is reachable only when it is cataloged
 * too, and a file elsewhere in the pstack repository (its docs, say) only when the operator
 * names that repository as a root of its own, which may hold no skills directly.
 */
function trustedBases(catalog: SkillCatalog, entry: SkillEntry): string[] {
  return [...new Set([...catalog.roots, entry.dir, ...catalog.entries.map((other) => other.dir)])];
}

/**
 * Resolves a brief's skill request against the operator's roots. A required skill or a declared
 * reference that is missing, unreadable, or outside the trusted sources refuses; an optional
 * skill that is missing is reported unavailable. Containment is checked on the path as written
 * and again after links are followed, both before anything is read.
 */
export function resolveSkills(roots: readonly string[], request: SkillRequest): SkillsStep {
  const names = [...new Set([...request.required, ...request.optional])];
  if (names.length === 0) return { ok: true, value: { roots: [], unavailable: [], skills: [] } };
  const opened = openCatalog(roots);
  if (!opened.ok) return opened;
  const { catalog } = opened;
  const resolved: ResolvedSkills = { roots: catalog.roots, unavailable: [], skills: [] };
  for (const name of names) {
    const required = request.required.includes(name);
    const entry = catalog.entries.find((candidate) => candidate.name === name);
    if (!entry) {
      if (!required) {
        resolved.unavailable.push(name);
        continue;
      }
      const problem = catalog.problems.find((candidate) => candidate.name === name);
      return {
        ok: false,
        code: "skill-missing",
        error: `Required skill ${name} is not available${problem ? `: ${problem.detail}` : ` under ${catalog.roots.join(", ")}`}. Nothing was started; the skill is not reported as enabled.`,
      };
    }
    const references = [];
    const bases = trustedBases(catalog, entry);
    const trusted = (file: string) => bases.some((base) => within(file, base));
    for (const ref of request.references.filter((candidate) => candidate.skill === name)) {
      const untrusted = {
        ok: false as const,
        code: "reference-untrusted" as const,
        error: `Skill ${name} reference ${ref.path} resolves outside the trusted skill sources.`,
      };
      // Checked as written and again after links are followed.
      if (!trusted(path.resolve(entry.dir, ref.path))) return untrusted;
      let file: string;
      try {
        file = realpathSync(path.resolve(entry.dir, ref.path));
      } catch {
        return {
          ok: false,
          code: "reference-missing",
          error: `Skill ${name} reference ${ref.path} does not exist.`,
        };
      }
      if (!trusted(file)) return untrusted;
      try {
        references.push({ path: ref.path, file, sha256: sha256(readFileSync(file)) });
      } catch {
        return {
          ok: false,
          code: "reference-missing",
          error: `Skill ${name} reference ${ref.path} is not a readable file.`,
        };
      }
    }
    resolved.skills.push({
      name,
      description: entry.description,
      file: entry.file,
      sha256: entry.sha256,
      required,
      mode: request.modes.includes(name),
      references,
    });
  }
  return { ok: true, value: resolved };
}

/**
 * Re-reads every resolved skill and reference. A changed or missing source means the skills the
 * brief was bound to are no longer what an agent would read: the caller refuses.
 */
export function skillSourcesChanged(snapshot: ResolvedSkills): string[] {
  const changed: string[] = [];
  const digest = (file: string) => {
    try {
      return sha256(readFileSync(file));
    } catch {
      return undefined;
    }
  };
  for (const skill of snapshot.skills) {
    if (digest(skill.file) !== skill.sha256) changed.push(`${skill.name} (${skill.file})`);
    for (const ref of skill.references) {
      if (digest(ref.file) !== ref.sha256) changed.push(`${skill.name} reference ${ref.path}`);
    }
  }
  return changed;
}

/**
 * Whether one lane's skill claims meet what its attempt asked. Claims are not proof: this only
 * checks that the lane says it read the exact sources and applied each requested mode. A
 * required skill or mode the lane did not apply (skipped, blocked, or not used) counts only
 * when the coordinator explicitly waives that skill after evaluating the reason; a waiver
 * never covers a wrong SKILL.md digest or a missing report. Applied claims must report every
 * bound reference. Waiving a skipped skill records that the whole skill was not applied,
 * including reference reads it could not perform; it does not claim those reads happened.
 */
export function evaluateSkillEvidence(input: {
  snapshot: ResolvedSkills;
  modes: readonly string[];
  skills: readonly SkillEvidence[] | undefined;
  waived: readonly string[];
}): {
  satisfied: boolean;
  problems: string[];
  /** Skills this lane did not apply that a waiver covered, with what the lane reported. */
  waivedClaims: { name: string; status: string; reason?: string }[];
} {
  const problems: string[] = [];
  const waivedClaims: { name: string; status: string; reason?: string }[] = [];
  for (const skill of input.snapshot.skills) {
    const mode = input.modes.includes(skill.name);
    if (!skill.required && !mode) continue;
    const claim = input.skills?.find((entry) => entry.name === skill.name);
    if (!claim) {
      problems.push(`${skill.name}: no evidence reported`);
      continue;
    }
    if (claim.sha256 !== skill.sha256) {
      problems.push(`${skill.name}: reported SKILL.md digest is not the bound source`);
      continue;
    }
    if (claim.status !== "applied") {
      if (input.waived.includes(skill.name)) {
        waivedClaims.push({
          name: skill.name,
          status: claim.status,
          ...(claim.reason ? { reason: claim.reason } : {}),
        });
      } else {
        problems.push(
          `${skill.name}: ${claim.status}${claim.reason ? ` (${claim.reason})` : ""}${mode ? " although it is this attempt's mode" : " although it is required"}; the coordinator has not waived it`,
        );
      }
      continue;
    }
    if (!claim.read) {
      problems.push(`${skill.name}: reported applied but not read`);
      continue;
    }
    for (const ref of skill.references) {
      const read = claim.references.find((entry) => entry.path === ref.path);
      if (!read || read.sha256 !== ref.sha256) {
        problems.push(
          `${skill.name}: required reference ${ref.path} not reported at its bound digest`,
        );
      }
    }
  }
  return { satisfied: problems.length === 0, problems, waivedClaims };
}
