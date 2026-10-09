import os from "node:os";
import { parseRules, type RuleSet } from "../rules/mdc-parser.js";
import { loadPolicy, type ProjectPolicy } from "../rules/policy.js";
import { planRoute, roleNames, type PlanRefusal, type RoutePlan } from "../rules/plan.js";
import { nativeLaunch } from "../rules/native-argv.js";
import {
  findProjectRoot,
  locateRules,
  readRules,
  type RulesSource,
} from "../rules/rules-source.js";

export interface CommandResult {
  output: string;
  json: unknown;
  code: number;
}

export interface RulesLocation {
  cwd: string;
  /** The user's home, for ~/.cursor/rules. */
  home: string;
  /** --rules */
  rulesFlag?: string;
}

export interface LoadedRules {
  rules: RuleSet;
  source: RulesSource;
  policy?: ProjectPolicy;
  policySource?: string;
  projectRoot?: string;
}

export function userHome(env: NodeJS.Dict<string>): string {
  return env.HOME && env.HOME.length > 0 ? env.HOME : os.homedir();
}

/** Reads the rules file and the project policy. Files only: no process, network or state. */
export function loadRules(
  location: RulesLocation,
): { ok: true; loaded: LoadedRules } | { ok: false; error: string } {
  const located = locateRules({
    cwd: location.cwd,
    home: location.home,
    ...(location.rulesFlag ? { flag: location.rulesFlag } : {}),
  });
  if (!located.ok) return located;
  const parsed = parseRules(readRules(located.source));
  if (!parsed.ok) return { ok: false, error: `${located.source.path}: ${parsed.error}` };
  const projectRoot = findProjectRoot(location.cwd);
  const policy = loadPolicy(projectRoot);
  if (!policy.ok) return policy;
  return {
    ok: true,
    loaded: {
      rules: parsed.rules,
      source: located.source,
      ...(policy.policy ? { policy: policy.policy, policySource: policy.path } : {}),
      ...(projectRoot ? { projectRoot } : {}),
    },
  };
}

function failure(error: string, code = 2, extra: Record<string, unknown> = {}): CommandResult {
  return { output: error, json: { ok: false, error, ...extra }, code };
}

export function executeRoles(location: RulesLocation): CommandResult {
  const loaded = loadRules(location);
  if (!loaded.ok) return failure(loaded.error);
  const { rules, source } = loaded.loaded;
  const roles = [
    ...rules.roles.map((role) => ({
      names: role.names,
      line: role.line,
      lanes: role.lanes.length,
      kind: role.lanes.length > 1 ? "panel" : "single",
      selectors: role.lanes.map((lane) =>
        lane.kind === "parent" ? lane.alias : lane.descriptor.canonical,
      ),
    })),
    ...rules.invalid.map((role) => ({ names: role.names, line: role.line, error: role.error })),
  ].sort((a, b) => a.line - b.line);
  const lines = [
    `Rules: ${source.path} (${source.origin})`,
    ...roles.map((role) =>
      "error" in role
        ? `  ${role.names.join(", ")}: INVALID (${role.error})`
        : `  ${role.names.join(", ")}: ${role.selectors.join(", ")}${role.kind === "panel" ? `  [panel, ${role.lanes} lanes]` : ""}`,
    ),
  ];
  return {
    output: lines.join("\n"),
    json: { ok: true, rulesSource: source, roles },
    code: 0,
  };
}

export interface PlanRequest {
  role?: string;
  parent?: string;
  readOnly?: boolean;
}

/** The pure route preview behind `plan` and `run --dry-run` in rules mode. */
export function previewPlan(
  location: RulesLocation,
  request: PlanRequest,
): { ok: true; plan: RoutePlan; loaded: LoadedRules } | { ok: false; result: CommandResult } {
  const loaded = loadRules(location);
  if (!loaded.ok) return { ok: false, result: failure(loaded.error) };
  if (!request.role) {
    const available = roleNames(loaded.loaded.rules);
    const error =
      "No role given; the router does not guess one. Pass --role <name>" +
      ` (or --routing-mode semantic to let TypeSafe pick among these). Available roles: ${available.join(", ")}`;
    return {
      ok: false,
      result: failure(error, 2, { code: "role-required", availableRoles: available }),
    };
  }
  const plan = planRoute({
    rules: loaded.loaded.rules,
    rulesSource: loaded.loaded.source,
    role: request.role,
    cwd: location.cwd,
    ...(request.parent !== undefined ? { parent: request.parent } : {}),
    ...(loaded.loaded.policy
      ? { policy: loaded.loaded.policy, policySource: loaded.loaded.policySource }
      : {}),
    ...(request.readOnly ? { readOnly: true } : {}),
  });
  if (!plan.ok) return { ok: false, result: refusal(plan) };
  return { ok: true, plan, loaded: loaded.loaded };
}

export function refusal(plan: PlanRefusal): CommandResult {
  const { ok: _ok, ...rest } = plan;
  void _ok;
  const output =
    plan.code === "unknown-role"
      ? `${plan.error} Available roles: ${plan.availableRoles?.join(", ")}`
      : `Refused (${plan.code}): ${plan.error}`;
  return { output, json: { ok: false, ...rest }, code: 2 };
}

/** Each lane's exact native argv, or why it cannot run. */
export function laneLaunches(plan: RoutePlan) {
  return plan.lanes.map((lane) => {
    const launch = nativeLaunch(lane, plan.access);
    return launch.ok
      ? { ok: true as const, index: lane.index, kind: launch.launch.kind, argv: launch.launch.argv }
      : { ok: false as const, index: lane.index, error: launch.error };
  });
}

export function formatPlan(plan: RoutePlan, footer: string): string {
  const launches = laneLaunches(plan);
  return [
    `Role: ${plan.role}${plan.roleNames.length > 1 ? ` (names: ${plan.roleNames.join(", ")})` : ""}`,
    `Kind: ${plan.kind === "panel" ? `panel, ${plan.lanes.length} lanes, every lane runs` : "single lane"}; access: ${plan.access === "read" ? "read-only" : "writer"}`,
    `Rules: ${plan.rulesSource.path} (${plan.rulesSource.origin})`,
    `Policy: ${plan.policySource ?? "none"}`,
    `Working directory: ${plan.cwd}`,
    ...plan.lanes.flatMap((lane, position) => {
      const launch = launches[position]!;
      return [
        `Lane ${lane.index}: ${lane.descriptor} [${lane.from === "parent" ? `parent via ${lane.selector}` : "rule"}]`,
        launch.ok ? `  argv: ${launch.argv.join(" ")}` : `  cannot launch: ${launch.error}`,
        ...lane.notes.map((note) => `  note: ${note}`),
      ];
    }),
    footer,
  ].join("\n");
}

export const PREVIEW_FOOTER =
  "Preview only: no model, pane, network, credential, or router state was touched.";

export function planJson(plan: RoutePlan, extra: Record<string, unknown> = {}) {
  const launches = laneLaunches(plan);
  return { ...plan, launches, launchable: launches.every((launch) => launch.ok), ...extra };
}

export function executePlan(location: RulesLocation, request: PlanRequest): CommandResult {
  const preview = previewPlan(location, request);
  if (!preview.ok) return preview.result;
  const blocked = laneLaunches(preview.plan).some((launch) => !launch.ok);
  return {
    output: formatPlan(preview.plan, PREVIEW_FOOTER),
    json: planJson(preview.plan, { effects: [], dispatch: "not-started" }),
    code: blocked ? 2 : 0,
  };
}
