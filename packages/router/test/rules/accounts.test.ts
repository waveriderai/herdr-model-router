import { describe, expect, it } from "vitest";
import { assignAccounts, LOW_QUOTA_PCT, type Phase } from "../../src/rules/accounts.js";
import { dispatchPlan } from "../../src/rules/dispatch.js";
import { parseRules, type RuleSet } from "../../src/rules/mdc-parser.js";
import { accountsFor, parseModelAccounts } from "../../src/rules/model-accounts.js";
import { parseNativeDescriptor } from "../../src/rules/descriptor.js";
import { planRoute, type PlanRefusal, type RoutePlan } from "../../src/rules/plan.js";
import type { ProjectPolicy } from "../../src/rules/policy.js";
import { defaultUsagePath, parseUsage, type UsageRead } from "../../src/rules/usage-snapshot.js";
import { deps, fakeHerdr, READY_SCREEN } from "../helpers/fake-herdr.js";

const NOW = new Date("2026-10-13T08:30:00Z");
const DIRECTIVES =
  "# hmr: first-version cursor\n# hmr: fix-accounts claude, grok\n# hmr: review-only codex\n";
const ROLES = `feature: claude:claude-opus-5-5@high
# fallback: codex:gpt-6.1-sol@high, then claude:claude-sonnet-5-5@high
bug-fix: claude:claude-sonnet-5-5@high
# fallback: grok-4.7-xhigh-fast, then codex:gpt-6.1-sol@high
explorer: grok:grok-4.7@xhigh
gpt writer: codex:gpt-6.1-sol@high
review gate: codex:gpt-6.1-sol@high
reviewers: claude:claude-opus-5-5@high, grok:grok-4.7@high
`;

/** The collector's file (AGENT-197) with one reading per account; null is an error row. */
function usage(
  used: Record<string, number | null>,
  updated = "2026-10-13T08:25:20+00:00",
): UsageRead {
  const rows = Object.entries(used).map(([provider, pct]) =>
    pct === null
      ? { provider, window: null, used_pct: null, resets_at: null, error: "CookieError: expired" }
      : { provider, plan: "Max", window: "Weekly", used_pct: pct, resets_at: null, error: null },
  );
  return parseUsage(JSON.stringify({ updated, ok: true, rows }), "/u/usage.json", NOW);
}

function rules(text = DIRECTIVES + ROLES): RuleSet {
  const parsed = parseRules(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.rules;
}

function place(
  role: string,
  options: {
    used?: Record<string, number | null>;
    phase?: Phase;
    text?: string;
    policy?: ProjectPolicy;
    readOnly?: boolean;
  } = {},
): RoutePlan | PlanRefusal {
  const set = rules(options.text);
  const plan = planRoute({
    rules: set,
    rulesSource: { path: "/rules/pstack-models.mdc", origin: "flag" },
    role,
    cwd: "/work/project",
    ...(options.policy ? { policy: options.policy, policySource: "/p.json" } : {}),
    ...(options.readOnly ? { readOnly: true } : {}),
  });
  if (!plan.ok) throw new Error(plan.error);
  return assignAccounts(plan, {
    ...(set.accounts ? { accounts: set.accounts } : {}),
    phase: options.phase ?? "first",
    usage: options.used ? usage(options.used) : undefined,
    ...(options.policy ? { policy: options.policy } : {}),
  });
}

const route = (plan: RoutePlan | PlanRefusal) => {
  if (!plan.ok) throw new Error(plan.error);
  return [plan.lanes.map((lane) => lane.descriptor), plan.fallbacks.map((lane) => lane.descriptor)];
};

describe("usage collector snapshot (AGENT-197 usage.json)", () => {
  it("keeps what is left of each account's most-used window", () => {
    const read = parseUsage(
      JSON.stringify({
        updated: "2026-10-13T08:25:20+00:00",
        ok: false,
        rows: [
          { provider: "claude", window: "Session", used_pct: 1, error: null },
          { provider: "claude", window: "Weekly", used_pct: 23, error: null },
          { provider: "cursor", window: "Total", used_pct: 0, error: null },
          { provider: "grok", window: null, used_pct: null, error: "TimeoutExpired: 120s" },
        ],
      }),
      "/u/usage.json",
      NOW,
    );
    expect(read).toEqual({
      ok: true,
      snapshot: {
        path: "/u/usage.json",
        updated: "2026-10-13T08:25:20+00:00",
        accounts: {
          claude: { remainingPct: 77, detail: "Weekly 23% used" },
          cursor: { remainingPct: 100, detail: "Total 0% used" },
          grok: { detail: "TimeoutExpired: 120s" },
        },
      },
    });
  });

  it("refuses a stale or malformed file instead of using its numbers", () => {
    expect(usage({ claude: 10 }, "2026-10-13T07:00:00Z")).toEqual({
      ok: false,
      path: "/u/usage.json",
      reason: "it is 90 minutes old (more than 30)",
    });
    expect(parseUsage("{", "/u/usage.json", NOW)).toMatchObject({ reason: "it is not JSON" });
    expect(parseUsage('{"rows": []}', "/u/usage.json", NOW)).toMatchObject({ ok: false });
  });

  it("reads ~/hmr-usage/usage.json unless HMR_USAGE_FILE names another file", () => {
    expect(defaultUsagePath({}, "/Users/kai")).toBe("/Users/kai/hmr-usage/usage.json");
    expect(defaultUsagePath({ HMR_USAGE_FILE: "/srv/usage.json" }, "/Users/kai")).toBe(
      "/srv/usage.json",
    );
  });
});

describe("model accounts table", () => {
  const descriptor = (raw: string) => {
    const parsed = parseNativeDescriptor(raw);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.descriptor;
  };

  it("runs Claude models on Claude Code or Cursor, Grok models on grok or Cursor, GPT on Codex only", () => {
    const ids = (raw: string) => accountsFor(descriptor(raw)).map((entry) => entry.canonical);
    expect(ids("claude:claude-opus-5-5@high")).toEqual([
      "claude:claude-opus-5-5@high",
      "cursor:claude-opus-5-5-high",
    ]);
    expect(ids("cursor:claude-sonnet-5-5-max")).toEqual([
      "cursor:claude-sonnet-5-5-max",
      "claude:claude-sonnet-5-5@max",
    ]);
    expect(ids("grok-4.7-xhigh-fast")).toEqual(["grok:grok-4.7@xhigh", "cursor:grok-4.7-xhigh"]);
    expect(ids("codex:gpt-6.1-sol@high")).toEqual(["codex:gpt-6.1-sol@high"]);
    expect(ids("codex:gpt-6-astra@high")).toEqual(["codex:gpt-6-astra@high"]);
    // No effort, no exact Cursor id: the model stays where the rules file put it.
    expect(ids("claude:claude-opus-5-5")).toEqual(["claude:claude-opus-5-5"]);
  });

  it("rejects a table entry that is not an exact descriptor or repeats a provider", () => {
    const table = (equivalents: string[][]) =>
      JSON.stringify({ version: 1, verified: "test", equivalents });
    expect(() => parseModelAccounts(table([["claude:opus@high", "cursor:opus-high"]]))).toThrow(
      /rolling or automatic|not an exact/,
    );
    expect(() => parseModelAccounts(table([["cursor:a-high", "cursor:b-high"]]))).toThrow(
      /repeats a provider/,
    );
  });
});

describe("account directives in the rules file", () => {
  it("reads first-version, fix-accounts and review-only", () => {
    expect(rules().accounts).toEqual({
      firstVersion: "cursor",
      fixAccounts: ["claude", "grok"],
      reviewOnly: ["codex"],
    });
    expect(rules(ROLES).accounts).toEqual({ reviewOnly: [] });
  });

  it("fails the file on an unknown account or a repeated first-version", () => {
    expect(parseRules("# hmr: first-version cursr\n")).toEqual({
      ok: false,
      error:
        'line 1: unknown account "cursr" in first-version; use one of claude, codex, grok, cursor, opencode',
    });
    expect(parseRules("# hmr: first-version cursor\n# hmr: first-version claude\n")).toMatchObject({
      ok: false,
      error: expect.stringContaining("once per file"),
    });
  });
});

describe("account choice: the model first, then the account", () => {
  it("without directives, runs each model on the account with the most remaining quota", () => {
    const text = ROLES;
    expect(route(place("feature", { text, used: { claude: 20, cursor: 60 } }))).toEqual([
      ["claude:claude-opus-5-5@high"],
      [
        "cursor:claude-opus-5-5-high",
        "codex:gpt-6.1-sol@high",
        "claude:claude-sonnet-5-5@high",
        "cursor:claude-sonnet-5-5-high",
      ],
    ]);
    const swapped = place("feature", { text, used: { claude: 90, cursor: 10 } });
    expect(route(swapped)[0]).toEqual(["cursor:claude-opus-5-5-high"]);
    expect(swapped.ok && swapped.lanes[0]!.notes).toEqual([
      "account: cursor:claude-opus-5-5-high instead of claude:claude-opus-5-5@high; the account with the most remaining quota (Claude Code 10% left, Cursor agent 90% left)",
    ]);
    expect(swapped.ok && swapped.notes).toEqual([
      "usage: /u/usage.json as of 2026-10-13T08:25:20+00:00",
    ]);
    // An account with no reading ranks below every account with one.
    expect(route(place("explorer", { text, used: { grok: 95, cursor: null } }))[0]).toEqual([
      "grok:grok-4.7@xhigh",
    ]);
    // No usage file: the rules file's own account, and no notes about accounts.
    const offline = place("feature", { text });
    expect(route(offline)[0]).toEqual(["claude:claude-opus-5-5@high"]);
    expect(offline.ok && offline.lanes[0]!.notes).toEqual([]);
  });

  it("gives a writer's first version to the first-version account until it runs low", () => {
    expect(route(place("feature", { used: { claude: 0, cursor: 50 } }))).toEqual([
      ["cursor:claude-opus-5-5-high"],
      [
        "claude:claude-opus-5-5@high",
        "claude:claude-sonnet-5-5@high",
        "cursor:claude-sonnet-5-5-high",
      ],
    ]);
    // No reading for it is not low: the first version still goes there.
    expect(route(place("feature"))[0]).toEqual(["cursor:claude-opus-5-5-high"]);
    const low = place("feature", { used: { claude: 40, cursor: 100 - LOW_QUOTA_PCT + 1 } });
    expect(route(low)[0]).toEqual(["claude:claude-opus-5-5@high"]);
    expect(low.ok && low.lanes[0]!.notes[0]).toBe(
      "account: Claude Code 60% left; Cursor agent 19% left is below 20%, so the first version goes to the account with the most remaining quota",
    );
    // A read-only run of the role is not a first version.
    expect(route(place("feature", { readOnly: true, used: { claude: 0, cursor: 50 } }))[0]).toEqual(
      ["claude:claude-opus-5-5@high"],
    );
  });

  it("routes one role's fixes to its own fix accounts (fix-accounts-for), others unchanged", () => {
    const text =
      "# hmr: first-version cursor\n# hmr: fix-accounts claude, grok\n" +
      "# hmr: fix-accounts-for design implementation = codex\n" +
      "design implementation: codex:gpt-6.1-sol@high\n# fallback: claude:claude-sonnet-5-5@high\n" +
      ROLES;
    expect(
      route(
        place("design implementation", { text, phase: "fix", used: { claude: 0, codex: 90 } }),
      )[0],
    ).toEqual(["codex:gpt-6.1-sol@high"]);
    expect(
      route(place("feature", { text, phase: "fix", used: { claude: 10, codex: 0 } }))[0],
    ).toEqual(["claude:claude-opus-5-5@high"]);
    // A role whose order no fix account can run is refused, not silently re-routed.
    const only = text.replace("= codex", "= grok");
    expect(place("design implementation", { text: only, phase: "fix" })).toMatchObject({
      ok: false,
    });
  });

  it("never reads inherited properties as a role's fix accounts", () => {
    const text =
      "# hmr: fix-accounts claude, grok\n# hmr: fix-accounts-for design implementation = codex\n" +
      "constructor: claude:claude-sonnet-5-5@high\n" +
      ROLES;
    expect(route(place("constructor", { text, phase: "fix" }))[0]).toEqual([
      "claude:claude-sonnet-5-5@high",
    ]);
    expect(parseRules("# hmr: fix-accounts-for constructor = codex\n" + ROLES).ok).toBe(true);
  });

  it("rejects malformed or duplicate fix-accounts-for lines", () => {
    for (const bad of [
      "# hmr: fix-accounts-for design implementation codex\n",
      "# hmr: fix-accounts-for design implementation = nope\n",
      "# hmr: fix-accounts-for x = codex\n# hmr: fix-accounts-for x = claude\n",
    ]) {
      expect(parseRules(bad + ROLES).ok).toBe(false);
    }
  });

  it("sends a fix after review to Claude Code or grok, whichever has more quota", () => {
    // bug-fix lists a Grok model in its fallback order, so grok can take the fix.
    expect(route(place("bug-fix", { phase: "fix", used: { claude: 70, grok: 10 } }))).toEqual([
      ["grok:grok-4.7@xhigh"],
      ["claude:claude-sonnet-5-5@high"],
    ]);
    expect(route(place("bug-fix", { phase: "fix", used: { claude: 10, grok: 70 } }))).toEqual([
      ["claude:claude-sonnet-5-5@high"],
      ["grok:grok-4.7@xhigh"],
    ]);
    // feature has no Grok model: its fix stays on Claude Code even when grok has more quota.
    expect(route(place("feature", { phase: "fix", used: { claude: 90, grok: 0 } }))).toEqual([
      ["claude:claude-opus-5-5@high"],
      ["claude:claude-sonnet-5-5@high"],
    ]);
  });

  it("refuses a fix that no fix account can take instead of handing it to another writer", () => {
    const cursorOnly = `${DIRECTIVES}cursor writer: cursor:claude-opus-5-5-high\n`;
    const refusal = {
      ok: false,
      code: "no-fix-account",
      role: "cursor writer",
      error:
        '--phase fix runs only on the fix accounts (# hmr: fix-accounts claude, grok), and none of them can run a model in role "cursor writer"\'s order under the rules and project policy; nothing was planned',
    };
    // The project policy allows Cursor only, so neither Claude Code nor grok can take the fix.
    expect(
      place("cursor writer", {
        text: cursorOnly,
        phase: "fix",
        policy: { allowedProviders: ["cursor"] },
        used: { claude: 0, grok: 0, cursor: 0 },
      }),
    ).toEqual(refusal);
    // A pin on a non-fix account is refused the same way.
    expect(
      place("cursor writer", {
        text: cursorOnly,
        phase: "fix",
        policy: { pins: { "cursor writer": "cursor:claude-opus-5-5-high" } },
      }),
    ).toEqual(refusal);
    // Without the policy, the same role's fix goes to Claude Code.
    expect(route(place("cursor writer", { text: cursorOnly, phase: "fix" }))[0]).toEqual([
      "claude:claude-opus-5-5@high",
    ]);
    // A first version is not a fix: Cursor still takes it under the Cursor-only policy.
    expect(
      route(
        place("cursor writer", { text: cursorOnly, policy: { allowedProviders: ["cursor"] } }),
      )[0],
    ).toEqual(["cursor:claude-opus-5-5-high"]);
  });

  it("never gives a writer lane to a review-only account", () => {
    const feature = place("feature", { used: {} });
    expect(feature.ok && feature.notes).toContain(
      "fallback codex:gpt-6.1-sol@high skipped: codex is review-only in the rules file and no other account runs that model",
    );
    expect(place("gpt writer")).toEqual({
      ok: false,
      code: "review-only-account",
      role: "gpt writer",
      error:
        'codex is review-only in the rules file (# hmr: review-only), and writer role "gpt writer" resolves to codex:gpt-6.1-sol@high, which no other account runs; nothing was planned',
    });
    // Reviews and other read-only work may still run there.
    expect(route(place("review gate"))[0]).toEqual(["codex:gpt-6.1-sol@high"]);
    expect(route(place("gpt writer", { readOnly: true }))[0]).toEqual(["codex:gpt-6.1-sol@high"]);
  });

  it("keeps a pinned role on its pinned descriptors and leaves cursor out when policy forbids it", () => {
    const pinned = place("feature", {
      policy: { pins: { feature: "claude:claude-opus-5-5@high" } },
      used: { claude: 99, cursor: 0 },
    });
    expect(route(pinned)[0]).toEqual(["claude:claude-opus-5-5@high"]);
    expect(pinned.ok && pinned.notes).toContain(
      "account choice skipped: a project policy pin fixes this role's descriptors",
    );
    const allowed = place("feature", {
      policy: { allowedProviders: ["claude", "codex"] },
      used: { claude: 50, cursor: 0 },
    });
    expect(route(allowed)).toEqual([
      ["claude:claude-opus-5-5@high"],
      ["claude:claude-sonnet-5-5@high"],
    ]);
  });

  it("places each panel lane on its own best account and gives a panel no fallback order", () => {
    expect(route(place("reviewers", { used: { claude: 90, cursor: 0, grok: 0 } }))).toEqual([
      ["cursor:claude-opus-5-5-high", "grok:grok-4.7@high"],
      [],
    ]);
  });
});

describe("account choice and quota fallback together", () => {
  it("starts the first version on Cursor and moves the same model to Claude Code when Cursor hits its limit", async () => {
    const plan = place("feature", { used: { claude: 30, cursor: 0 } });
    if (!plan.ok) throw new Error(plan.error);
    const herdr = fakeHerdr({
      detect: (_pane, executable) =>
        executable === "cursor-agent"
          ? { screen: `You've hit your usage limit for this cycle.\n${READY_SCREEN.cursor}` }
          : {},
    });
    const { deps: d } = deps(herdr);
    const result = await dispatchPlan({
      plan,
      prompt: "Write the first version",
      worktreeId: "/work/project",
      deps: d,
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.lanes[0]).toMatchObject({
      descriptor: "claude:claude-opus-5-5@high",
      state: "prompted",
      skipped: [
        {
          descriptor: "cursor:claude-opus-5-5-high",
          reason: 'cursor reported a quota or usage-limit error ("hit your limit")',
        },
      ],
    });
    expect(herdr.scripts[0]).toContain(
      "'/opt/fake bin/cursor-agent' '--model' 'claude-opus-5-5-high'",
    );
    expect(herdr.prompts).toHaveLength(1);
  });
});
