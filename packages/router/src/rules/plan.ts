import type { ReasoningEffort } from "../domain/model-profile.js";
import { parseNativeDescriptor, type NativeDescriptor, type Provider } from "./descriptor.js";
import { normalizeRoleName, type RoleRule, type RuleSet } from "./mdc-parser.js";
import type { ProjectPolicy } from "./policy.js";
import type { RulesSource } from "./rules-source.js";

export type Access = "read" | "write";

export interface PlannedLane {
  /** 1-based position in the role's lane list. */
  index: number;
  descriptor: string;
  provider: Provider;
  model: string;
  effort: ReasoningEffort | null;
  /** `rule`: written in the rules file. `parent`: a parent alias resolved from --parent. */
  from: "rule" | "parent";
  /** What the rules file says for this lane, verbatim. */
  selector: string;
  notes: string[];
}

export interface RoutePlan {
  ok: true;
  /** The role name as requested (normalized). */
  role: string;
  /** All names that share this role's lanes. */
  roleNames: string[];
  /** `panel`: more than one lane. The lanes that remain all run; it is not a fallback list. */
  kind: "single" | "panel";
  access: Access;
  /**
   * Overrides the writer profile: `control` for a coordinator, `bypass` only from the explicit
   * per-run opt-in. A read-only plan never carries one.
   */
  permissions?: "control" | "bypass";
  /** Read-only globally (built-in or rules-file directive): no caller may launch it writable. */
  forcedReadOnly: boolean;
  /** The rules file lists more than one lane, even if parent-alias copies were skipped. */
  definedAsPanel: boolean;
  rulesSource: RulesSource;
  policySource?: string;
  /** SHA-256 of the policy text this plan was made from. */
  policySha256?: string;
  cwd: string;
  lanes: PlannedLane[];
  /**
   * A single-lane role's `# fallback:` order, already checked against the project policy.
   * Dispatch launches the next one only after the running model hits a quota or usage limit.
   */
  fallbacks: PlannedLane[];
  notes: string[];
}

/**
 * Roles that are read-only everywhere, whatever the rules file or a project policy says: the
 * design consultant writes specs, not code, and the review gate only judges.
 */
export const BUILTIN_READ_ONLY_ROLES = ["design consultant", "review gate"] as const;

export type PlanRefusalCode =
  | "unknown-role"
  | "invalid-rule"
  | "parent-unresolved"
  | "invalid-parent"
  | "provider-not-allowed"
  | "pin-conflict"
  | "panel-writer-conflict"
  | "readonly-writer-conflict"
  | "bypass-read-only";

export interface PlanRefusal {
  ok: false;
  code: PlanRefusalCode;
  error: string;
  role: string;
  availableRoles?: string[];
  /** The policy pin key that refused the plan. */
  pinKey?: string;
  expected?: string[];
  actual?: string[];
}

export interface PlanInput {
  rules: RuleSet;
  rulesSource: RulesSource;
  role: string;
  cwd: string;
  /** The descriptor the parent agent runs on; resolves `parent`, `auto`, `inherit-parent`. */
  parent?: string;
  policy?: ProjectPolicy;
  policySource?: string;
  policySha256?: string;
  /** Force a single-lane role to run read-only. */
  readOnly?: boolean;
  /**
   * The per-run opt-in to the CLI's full permission bypass. Never a default, and refused for
   * a read-only plan.
   */
  bypassPermissions?: boolean;
}

export function roleNames(rules: RuleSet): string[] {
  return [...rules.roles, ...rules.invalid]
    .sort((a, b) => a.line - b.line)
    .flatMap((role) => role.names);
}

function findRole(rules: RuleSet, role: string): RoleRule | { invalid: string } | undefined {
  const found = rules.roles.find((entry) => entry.names.includes(role));
  if (found) return found;
  const invalid = rules.invalid.find((entry) => entry.names.includes(role));
  return invalid ? { invalid: invalid.error } : undefined;
}

/**
 * Every policy pin whose key names this role or one of its aliases, sorted by key so the
 * outcome never depends on JSON key order. All of them must hold.
 */
function pinsFor(
  policy: ProjectPolicy | undefined,
  names: string[],
): { key: string; pin: string[] }[] {
  if (!policy?.pins) return [];
  return Object.entries(policy.pins)
    .filter(([key]) => names.includes(normalizeRoleName(key)))
    .map(([key, value]) => ({ key, pin: Array.isArray(value) ? value : [value] }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Resolves a role to its full lane list, then applies the project's restrictions. Pure: it
 * reads nothing and starts nothing, so `roles`, `plan` and `run --dry-run` share it.
 */
export function planRoute(input: PlanInput): RoutePlan | PlanRefusal {
  const role = normalizeRoleName(input.role);
  const refuse = (
    code: PlanRefusalCode,
    error: string,
    extra: Partial<PlanRefusal> = {},
  ): PlanRefusal => ({ ok: false, code, error, role, ...extra });
  const found = findRole(input.rules, role);
  if (!found) {
    return refuse("unknown-role", `Unknown role "${role}".`, {
      availableRoles: roleNames(input.rules),
    });
  }
  if ("invalid" in found) return refuse("invalid-rule", found.invalid);

  let parent: NativeDescriptor | undefined;
  if (input.parent !== undefined) {
    const parsed = parseNativeDescriptor(input.parent);
    if (!parsed.ok) return refuse("invalid-parent", `--parent: ${parsed.error}`);
    parent = parsed.descriptor;
  }

  const lanes: PlannedLane[] = [];
  for (const [position, lane] of found.lanes.entries()) {
    if (lane.kind === "parent") {
      if (!parent) {
        return refuse(
          "parent-unresolved",
          `role "${role}" uses ${lane.alias}; pass --parent provider:model@effort to say which model the parent runs`,
        );
      }
      lanes.push(toLane(position, parent, "parent", lane.alias));
    } else {
      lanes.push(toLane(position, lane.descriptor, "rule", lane.selector));
    }
  }

  // A parent alias that copies a model already in the panel adds no reviewer.
  // The signal of a panel is a different model. A selector written twice still
  // runs twice: only alias lanes are dropped, and the rules file is not rewritten.
  const collapseNotes: string[] = [];
  const ruleDescriptors = new Set(
    lanes.filter((lane) => lane.from === "rule").map((lane) => lane.descriptor),
  );
  const seen = new Set(ruleDescriptors);
  const launched: PlannedLane[] = [];
  for (const lane of lanes) {
    if (lane.from === "parent" && seen.has(lane.descriptor)) {
      collapseNotes.push(
        `skipped ${lane.selector} (${lane.descriptor}): that model is already in this panel`,
      );
      continue;
    }
    if (lane.from === "parent") seen.add(lane.descriptor);
    launched.push({ ...lane, index: launched.length + 1 });
  }

  const allowed = input.policy?.allowedProviders;
  const blocked = allowed ? lanes.find((lane) => !allowed.includes(lane.provider)) : undefined;
  if (blocked) {
    return refuse(
      "provider-not-allowed",
      `project policy allows ${allowed!.join(", ")}, but lane ${blocked.index} of role "${role}" runs on ${blocked.provider}; nothing was planned`,
    );
  }

  // Policy checks run on every resolved lane, before dedupe: a skipped copy changes nothing a
  // pin or allowedProviders already approved.
  const actual = lanes.map((lane) => lane.descriptor);
  for (const { key, pin } of pinsFor(input.policy, found.names)) {
    const expected = pin.length === 1 ? lanes.map(() => pin[0]!) : pin;
    const mismatch =
      expected.length !== actual.length
        ? 0
        : actual.findIndex((descriptor, index) => descriptor !== expected[index]);
    if (expected.length !== actual.length || mismatch >= 0) {
      return refuse(
        "pin-conflict",
        expected.length !== actual.length
          ? `project policy pin "${key}" requires ${expected.length} lanes for role "${role}", but the rules resolve ${actual.length}; nothing was planned`
          : `project policy pin "${key}" requires ${expected[mismatch]} for role "${role}", but the rules resolve lane ${mismatch + 1} to ${actual[mismatch]}; nothing was planned`,
        { pinKey: key, expected: pin, actual },
      );
    }
  }

  // The role is a panel when the rules file lists more than one lane, even if
  // alias copies were dropped. A collapsed panel stays read-only.
  const definedAsPanel = lanes.length > 1;
  const kind = launched.length > 1 ? "panel" : "single";
  const writerRoles = input.policy?.writerRoles?.map(normalizeRoleName);
  const namedWriter = writerRoles?.some((name) => found.names.includes(name)) ?? false;
  if (definedAsPanel && namedWriter) {
    return refuse(
      "panel-writer-conflict",
      `project policy lists panel role "${role}" as a writer, but panels are read-only`,
    );
  }
  const globalReadOnly = [...BUILTIN_READ_ONLY_ROLES, ...(input.rules.readOnlyRoles ?? [])];
  const forcedReadOnly = found.names.some((name) => globalReadOnly.includes(name));
  // A project policy only tightens: it cannot make a globally read-only role a writer.
  if (forcedReadOnly && namedWriter) {
    return refuse(
      "readonly-writer-conflict",
      `project policy lists role "${role}" as a writer, but it is read-only globally (rules file or built-in); a policy can only tighten access`,
    );
  }
  const access: Access =
    definedAsPanel ||
    forcedReadOnly ||
    input.readOnly ||
    (writerRoles !== undefined && !namedWriter)
      ? "read"
      : "write";
  if (input.bypassPermissions && access === "read") {
    return refuse(
      "bypass-read-only",
      `role "${role}" runs read-only here, and a permission bypass applies only to a writer; nothing was planned`,
    );
  }
  const notes = forcedReadOnly ? [`role "${role}" is read-only globally`] : [];
  if (input.bypassPermissions) {
    notes.push("permission bypass opted in for this run: the CLI skips its approvals and sandbox");
  }
  const fallbacks = planFallbacks({
    found,
    role,
    lanes: launched,
    parent,
    allowed,
    pins: pinsFor(input.policy, found.names),
    notes,
  });

  return {
    ok: true,
    role,
    roleNames: found.names,
    kind,
    access,
    ...(input.bypassPermissions ? { permissions: "bypass" as const } : {}),
    forcedReadOnly,
    definedAsPanel,
    rulesSource: input.rulesSource,
    ...(input.policySource ? { policySource: input.policySource } : {}),
    ...(input.policySha256 ? { policySha256: input.policySha256 } : {}),
    cwd: input.cwd,
    lanes: launched,
    fallbacks,
    notes: [...notes, ...collapseNotes],
  };
}

/**
 * The role's fallback order as launchable lanes. An entry is dropped, with a note saying why,
 * when it cannot be launched, the project policy would refuse it, or it repeats a model
 * already in the order. A panel runs every lane already, so it has no fallback order.
 */
function planFallbacks(input: {
  found: RoleRule;
  role: string;
  lanes: PlannedLane[];
  parent: NativeDescriptor | undefined;
  allowed: string[] | undefined;
  pins: { key: string; pin: string[] }[];
  notes: string[];
}): PlannedLane[] {
  const entries = input.found.fallbacks ?? [];
  if (entries.length === 0) return [];
  if (input.lanes.length !== 1) {
    input.notes.push(
      `the fallback order on line ${entries[0]!.line} is ignored: role "${input.role}" is a panel, and every panel lane already runs`,
    );
    return [];
  }
  const fallbacks: PlannedLane[] = [];
  const seen = new Set([input.lanes[0]!.descriptor]);
  for (const [position, entry] of entries.entries()) {
    const skip = (why: string) =>
      input.notes.push(`fallback ${position + 1} (${entry.selector}) skipped: ${why}`);
    if (!entry.ok) {
      skip(entry.error);
      continue;
    }
    let descriptor: NativeDescriptor;
    let from: PlannedLane["from"] = "rule";
    if (entry.lane.kind === "parent") {
      if (!input.parent) {
        skip(`${entry.lane.alias} needs --parent provider:model@effort`);
        continue;
      }
      descriptor = input.parent;
      from = "parent";
    } else {
      descriptor = entry.lane.descriptor;
    }
    if (seen.has(descriptor.canonical)) {
      skip(`${descriptor.canonical} is already earlier in this role's order`);
      continue;
    }
    if (input.allowed && !input.allowed.includes(descriptor.provider)) {
      skip(`project policy allows ${input.allowed.join(", ")}, not ${descriptor.provider}`);
      continue;
    }
    const pinned = input.pins.find(({ pin }) => !pin.includes(descriptor.canonical));
    if (pinned) {
      skip(`project policy pin "${pinned.key}" requires ${pinned.pin.join(", ")}`);
      continue;
    }
    seen.add(descriptor.canonical);
    fallbacks.push(toLane(0, descriptor, from, entry.selector));
  }
  return fallbacks;
}

function toLane(
  position: number,
  descriptor: NativeDescriptor,
  from: "rule" | "parent",
  selector: string,
): PlannedLane {
  return {
    index: position + 1,
    descriptor: descriptor.canonical,
    provider: descriptor.provider,
    model: descriptor.model,
    effort: descriptor.effort,
    from,
    selector,
    notes: [...descriptor.notes],
  };
}
