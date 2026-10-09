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
  /** `panel`: more than one lane. Every lane runs; it is not a fallback list. */
  kind: "single" | "panel";
  access: Access;
  rulesSource: RulesSource;
  policySource?: string;
  /** SHA-256 of the policy text this plan was made from. */
  policySha256?: string;
  cwd: string;
  lanes: PlannedLane[];
  notes: string[];
}

export type PlanRefusalCode =
  | "unknown-role"
  | "invalid-rule"
  | "parent-unresolved"
  | "invalid-parent"
  | "provider-not-allowed"
  | "pin-conflict"
  | "panel-writer-conflict";

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

  const allowed = input.policy?.allowedProviders;
  const blocked = allowed ? lanes.find((lane) => !allowed.includes(lane.provider)) : undefined;
  if (blocked) {
    return refuse(
      "provider-not-allowed",
      `project policy allows ${allowed!.join(", ")}, but lane ${blocked.index} of role "${role}" runs on ${blocked.provider}; nothing was planned`,
    );
  }

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

  const kind = lanes.length > 1 ? "panel" : "single";
  const writerRoles = input.policy?.writerRoles?.map(normalizeRoleName);
  const namedWriter = writerRoles?.some((name) => found.names.includes(name)) ?? false;
  if (kind === "panel" && namedWriter) {
    return refuse(
      "panel-writer-conflict",
      `project policy lists panel role "${role}" as a writer, but panels are read-only`,
    );
  }
  const access: Access =
    kind === "panel" || input.readOnly || (writerRoles !== undefined && !namedWriter)
      ? "read"
      : "write";

  return {
    ok: true,
    role,
    roleNames: found.names,
    kind,
    access,
    rulesSource: input.rulesSource,
    ...(input.policySource ? { policySource: input.policySource } : {}),
    ...(input.policySha256 ? { policySha256: input.policySha256 } : {}),
    cwd: input.cwd,
    lanes,
    notes: [],
  };
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
