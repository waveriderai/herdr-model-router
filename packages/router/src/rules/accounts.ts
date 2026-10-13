import { parseNativeDescriptor, type NativeDescriptor } from "./descriptor.js";
import { normalizeRoleName, type AccountRules } from "./mdc-parser.js";
import { accountsFor } from "./model-accounts.js";
import type { PlannedLane, PlanRefusal, RoutePlan } from "./plan.js";
import type { ProjectPolicy } from "./policy.js";
import { providerEntry } from "./provider-registry.js";
import type { UsageRead } from "./usage-snapshot.js";

/** `first`: a writer's first version of a ticket. `fix`: a writer's fix after review. */
export type Phase = "first" | "fix";
export const PHASES: readonly Phase[] = ["first", "fix"];

/**
 * Below this much remaining quota an account is low, and a first version leaves it for the
 * account with the most remaining quota. It matches the collector's 80%-used alert.
 */
export const LOW_QUOTA_PCT = 20;

export interface AccountInput {
  accounts?: AccountRules;
  phase: Phase;
  /** The collector's snapshot; undefined when it has written no file. */
  usage: UsageRead | undefined;
  policy?: ProjectPolicy;
}

/**
 * Picks the account (provider CLI) for each lane after the model is chosen. Pure: the usage
 * snapshot is read by the caller. Among the accounts that can run a lane's model
 * (config/model-accounts.json), and that the project policy allows:
 *
 * - a writer never runs on a `review-only` account; if no other account runs its model, the
 *   plan is refused;
 * - a writer's first version runs on the `first-version` account unless it is low;
 * - a `--phase fix` writer runs on the `fix-accounts` entry with the most remaining quota,
 *   using the first model in the role's order that account can run;
 * - otherwise the account with the most remaining quota; with no reading, the one the rules
 *   file names.
 *
 * A single lane's fallback order becomes the other accounts for its model, then the role's
 * `# fallback:` models, each on its accounts by remaining quota.
 */
export function assignAccounts(plan: RoutePlan, input: AccountInput): RoutePlan | PlanRefusal {
  const rules = input.accounts ?? { reviewOnly: [] };
  const writer = plan.access === "write";
  const reviewOnly = writer ? rules.reviewOnly : [];
  const allowed = input.policy?.allowedProviders;
  const snapshot = input.usage?.ok ? input.usage.snapshot : undefined;
  const remaining = (account: string) => snapshot?.accounts[account]?.remainingPct;
  const label = (account: string) => {
    const name = providerEntry(account)?.displayName ?? account;
    const left = remaining(account);
    return left === undefined ? `${name} no reading` : `${name} ${left}% left`;
  };
  const byQuota = <T>(items: T[], account: (item: T) => string): T[] =>
    items
      .map((item, order) => ({ item, order, left: remaining(account(item)) }))
      .sort((a, b) =>
        a.left === b.left
          ? a.order - b.order
          : a.left === undefined
            ? 1
            : b.left === undefined
              ? -1
              : b.left - a.left,
      )
      .map(({ item }) => item);
  const candidates = (descriptor: NativeDescriptor) =>
    accountsFor(descriptor).filter(
      (option) =>
        (!allowed || allowed.includes(option.provider)) && !reviewOnly.includes(option.provider),
    );
  const pinned = Object.keys(input.policy?.pins ?? {}).some((key) =>
    plan.roleNames.includes(normalizeRoleName(key)),
  );
  const notes = [...plan.notes];
  if (!writer && input.phase === "fix") notes.push("--phase fix applies to writer roles only");

  const lanes: PlannedLane[] = [];
  let fallbacks = plan.fallbacks;
  let considered = false;
  for (const lane of plan.lanes) {
    const own = descriptorOf(lane);
    const options = pinned
      ? [own].filter((option) => !reviewOnly.includes(option.provider))
      : candidates(own);
    if (options.length === 0) {
      return {
        ok: false,
        code: "review-only-account",
        role: plan.role,
        error: `${own.provider} is review-only in the rules file (# hmr: review-only), and writer role "${plan.role}" resolves to ${own.canonical}, which no other account runs; nothing was planned`,
      };
    }
    if (pinned) {
      lanes.push(lane);
      continue;
    }
    if (options.length > 1) considered = true;
    let chosen = options[0]!;
    let reason: string | undefined;
    let fixOptions: NativeDescriptor[] = [];
    if (writer && plan.lanes.length === 1 && input.phase === "fix" && rules.fixAccounts) {
      const order = [own, ...plan.fallbacks.map(descriptorOf)];
      fixOptions = byQuota(
        rules.fixAccounts.flatMap((account) => {
          const found = order
            .flatMap((model) => candidates(model))
            .find((option) => option.provider === account);
          return found ? [found] : [];
        }),
        (option) => option.provider,
      );
      if (fixOptions.length > 0) {
        considered = true;
        chosen = fixOptions[0]!;
        reason = `fix after review goes to the fix account with the most remaining quota (${fixOptions.map((option) => label(option.provider)).join(", ")})`;
      } else {
        notes.push(
          `no model in role "${plan.role}"'s order runs on a fix account (${rules.fixAccounts.join(", ")}); the account with the most remaining quota is used`,
        );
      }
    }
    if (!reason && writer && input.phase === "first" && rules.firstVersion) {
      const first = options.find((option) => option.provider === rules.firstVersion);
      const left = remaining(rules.firstVersion);
      if (first && (left === undefined || left >= LOW_QUOTA_PCT)) {
        chosen = first;
        reason = `first version goes to ${label(rules.firstVersion)}`;
      } else if (first) {
        // Never blocks on the first-version account: the most remaining quota wins instead.
        chosen = byQuota(options, (option) => option.provider)[0]!;
        reason = `${label(rules.firstVersion)} is below ${LOW_QUOTA_PCT}%, so the first version goes to the account with the most remaining quota`;
      }
    }
    if (!reason && snapshot) {
      chosen = byQuota(options, (option) => option.provider)[0]!;
      reason = "the account with the most remaining quota";
    }
    lanes.push(
      chosen.canonical === lane.descriptor
        ? options.length > 1 && reason
          ? { ...lane, notes: [...lane.notes, `account: ${label(chosen.provider)}; ${reason}`] }
          : lane
        : {
            ...lane,
            descriptor: chosen.canonical,
            provider: chosen.provider,
            model: chosen.model,
            effort: chosen.effort,
            notes: [
              ...lane.notes,
              ...chosen.notes,
              `account: ${chosen.canonical} instead of ${lane.descriptor}; ${reason} (${options.map((option) => label(option.provider)).join(", ")})`,
            ],
          },
    );
    if (plan.lanes.length !== 1) continue;
    // The quota fallback order: the same model elsewhere, then the role's fallback models.
    const restrict = (option: NativeDescriptor) =>
      fixOptions.length === 0 || rules.fixAccounts!.includes(option.provider);
    const order: { option: NativeDescriptor; from: PlannedLane }[] = [
      ...fixOptions.map((option) => ({ option, from: lane })),
      ...byQuota(options, (option) => option.provider).map((option) => ({ option, from: lane })),
    ];
    for (const fallback of plan.fallbacks) {
      const found = byQuota(candidates(descriptorOf(fallback)), (option) => option.provider);
      if (found.length === 0) {
        notes.push(
          `fallback ${fallback.descriptor} skipped: ${fallback.provider} is review-only in the rules file and no other account runs that model`,
        );
      }
      order.push(...found.map((option) => ({ option, from: fallback })));
    }
    const seen = new Set([chosen.canonical]);
    fallbacks = [];
    for (const { option, from } of order) {
      if (seen.has(option.canonical) || !restrict(option)) continue;
      seen.add(option.canonical);
      fallbacks.push(
        option.canonical === from.descriptor
          ? from
          : {
              ...from,
              descriptor: option.canonical,
              provider: option.provider,
              model: option.model,
              effort: option.effort,
              notes: [...from.notes, ...option.notes, `same model as ${from.descriptor}`],
            },
      );
    }
  }
  if (considered && input.usage !== undefined) {
    notes.push(
      input.usage.ok
        ? `usage: ${input.usage.snapshot.path} as of ${input.usage.snapshot.updated}`
        : `usage: ${input.usage.path} not used (${input.usage.reason}); accounts chosen without quota numbers`,
    );
  }
  if (pinned && plan.lanes.length > 0) {
    notes.push("account choice skipped: a project policy pin fixes this role's descriptors");
  }
  return { ...plan, lanes, fallbacks, notes };
}

function descriptorOf(lane: PlannedLane): NativeDescriptor {
  const parsed = parseNativeDescriptor(lane.descriptor);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.descriptor;
}
