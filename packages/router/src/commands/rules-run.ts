import { isHerdrEnv } from "../launch/readiness.js";
import type { Provider } from "../rules/descriptor.js";
import { dispatchPlan, type DispatchDeps, type LaneOutcome } from "../rules/dispatch.js";
import { worktreeIdentity } from "../rules/rules-source.js";
import { classifyRole } from "../semantic/role-classifier.js";
import type { TypeSafePort } from "../semantic/typesafe-client.js";
import {
  formatPlan,
  loadRules,
  planJson,
  PREVIEW_FOOTER,
  previewPlan,
  type CommandResult,
  type RulesLocation,
} from "./rules-commands.js";

export type RoutingMode = "rules" | "semantic";

export interface RulesRunRequest {
  mode: RoutingMode;
  role?: string;
  parent?: string;
  readOnly?: boolean;
  dryRun: boolean;
}

export interface RulesRunDeps extends RulesLocation {
  env: NodeJS.Dict<string>;
  /** Only called in semantic mode without an explicit role. Undefined: no key configured. */
  createSemanticClient?: () => TypeSafePort | undefined;
  /** Only called for a real launch, after the plan and every gate passed. */
  openDispatch?: () => DispatchDeps & { close?: () => void };
  /** A refusal when the router home is inside the target checkout; checked before any state. */
  privateHomeRefusal?: () => string | undefined;
  /** Providers with a configured shared account; rules mode refuses to launch on them. */
  sharedProviders?: () => Provider[];
}

function refused(error: string, extra: Record<string, unknown> = {}, code = 2): CommandResult {
  return { output: error, json: { ok: false, error, ...extra }, code };
}

/**
 * `run` in rules or semantic mode. Rules mode reads the rules file and project policy and
 * nothing else until a real launch; a dry run stops at the plan.
 */
export async function executeRulesRun(
  task: string,
  request: RulesRunRequest,
  deps: RulesRunDeps,
): Promise<CommandResult> {
  let role = request.role;
  const notes: string[] = [];
  const effects: string[] = [];
  if (request.mode === "semantic") {
    if (role) {
      notes.push("explicit --role given; the TypeSafe classifier was not called");
    } else {
      const loaded = loadRules(deps);
      if (!loaded.ok) return refused(loaded.error);
      const client = deps.createSemanticClient?.();
      if (!client) {
        return refused(
          "--routing-mode semantic needs a TypeSafe key (config typesafe.apiKeyRef or TYPESAFE_API_KEY). Nothing was routed; pass --role to route from the rules file.",
          { code: "typesafe-unavailable" },
        );
      }
      const roles = loaded.loaded.rules.roles.flatMap((entry) => entry.names);
      effects.push("typesafe-classification");
      const classified = await classifyRole({ task, roles, client });
      if (!classified.ok)
        return refused(classified.error, { code: "classification-refused", effects });
      role = classified.role;
      notes.push(
        `role "${role}" chosen by TypeSafe semantic classification (confidence ${classified.confidence.toFixed(2)})`,
      );
    }
  }
  const preview = previewPlan(deps, {
    ...(role ? { role } : {}),
    ...(request.parent !== undefined ? { parent: request.parent } : {}),
    ...(request.readOnly ? { readOnly: true } : {}),
  });
  if (!preview.ok) return preview.result;
  const plan = { ...preview.plan, notes: [...preview.plan.notes, ...notes] };
  const noteLines = plan.notes.map((note) => `Note: ${note}`);
  if (request.dryRun) {
    const footer =
      effects.length > 0
        ? "Dry run: TypeSafe was called once to classify the role; no model, pane, credential store, or router state was touched."
        : PREVIEW_FOOTER;
    return {
      output: [formatPlan(plan, footer), ...noteLines].join("\n"),
      json: planJson(plan, { dryRun: true, effects, dispatch: "not-started" }),
      code: 0,
    };
  }
  if (!isHerdrEnv(deps.env)) {
    return refused("HERDR_ENV=1 is required to launch; run inside a Herdr pane, or add --dry-run.");
  }
  const shared = deps.sharedProviders?.() ?? [];
  const sharedLane = plan.lanes.find((lane) => shared.includes(lane.provider));
  if (sharedLane) {
    return refused(
      `lane ${sharedLane.index} runs on ${sharedLane.provider}, which has a shared account in config.json. Rules mode does not hold shared-quota reservations, so it does not launch on shared accounts; use --routing-mode quota for those.`,
      { code: "shared-account-gate" },
    );
  }
  if (!deps.openDispatch) return refused("launching is not available in this build");
  const insideCheckout = deps.privateHomeRefusal?.();
  if (insideCheckout) return refused(insideCheckout, { code: "private-home" });
  const dispatch = deps.openDispatch();
  try {
    const result = await dispatchPlan({
      plan,
      prompt: task,
      worktreeId: worktreeIdentity(plan.cwd),
      deps: dispatch,
    });
    if (!result.ok) {
      return refused(result.error, {
        code: result.code,
        ...(result.owner ? { owner: result.owner } : {}),
      });
    }
    const delivered = result.lanes.filter((lane) =>
      ["sent", "working", "blocked"].includes(lane.attempt?.state ?? ""),
    ).length;
    const summary =
      delivered === result.lanes.length
        ? `Prompt delivered to all ${result.lanes.length} lane(s). This is dispatch, not completion: the task completes only with \`task complete ${result.task.id} --evidence ...\`.`
        : `Prompt delivered to ${delivered} of ${result.lanes.length} lane(s); the others are listed above. Not every lane succeeded.`;
    return {
      output: [
        formatPlan(plan, `Task: ${result.task.id} (${result.task.status})`),
        ...noteLines,
        ...result.lanes.map(formatLaneOutcome),
        summary,
      ].join("\n"),
      json: planJson(plan, {
        dryRun: false,
        effects: [...effects, "herdr-dispatch", "router-state"],
        task: result.task,
        laneOutcomes: result.lanes,
        delivered,
      }),
      code: delivered === result.lanes.length ? 0 : 1,
    };
  } finally {
    dispatch.close?.();
  }
}

export function formatLaneOutcome(lane: LaneOutcome): string {
  const where = lane.paneId ? ` pane ${lane.paneId}` : "";
  const agent = lane.agentName ? ` agent ${lane.agentName}` : "";
  const attempt = lane.attempt
    ? ` attempt ${lane.attempt.id}: ${lane.attempt.state}${lane.attempt.evidence ? ` (${lane.attempt.evidence})` : ""}`
    : "";
  return `Lane ${lane.index} [${lane.laneId}] ${lane.state}${where}${agent}${attempt}${lane.error ? ` error: ${lane.error}` : ""}`;
}
