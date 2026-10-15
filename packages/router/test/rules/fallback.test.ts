import { describe, expect, it } from "vitest";
import { formatLaneOutcome } from "../../src/commands/rules-run.js";
import { executeTaskStatus } from "../../src/commands/task-commands.js";
import { dispatchPlan, reviseTask } from "../../src/rules/dispatch.js";
import { parseRules, type RuleSet } from "../../src/rules/mdc-parser.js";
import { planRoute, type RoutePlan } from "../../src/rules/plan.js";
import { detectQuota } from "../../src/rules/readiness.js";
import { deps, fakeHerdr, READY_SCREEN, screen, type FakeHerdr } from "../helpers/fake-herdr.js";

const RULES = `---
description: Synthetic fallback rules for tests
---
# Header prose: delete a line to fall back to the skill default. fallback: not a role's
feature, refactoring: claude:claude-opus-5-5@high
# fallback: codex:gpt-6.1-sol@high, then grok:grok-4.7@high
explorer: grok:grok-4.7@medium  # fallback: cursor Auto, then claude:claude-sonnet-5-5@high
design consultant: codex:gpt-6.1-sol@high
# Visual and UX decisions; no code.
# fallback: claude:claude-sonnet-5-5@high, then cursor Auto
design implementation: claude:claude-sonnet-5-5@high
# UI code from the spec. fallback: codex:gpt-6.1-sol@high then claude:claude-sonnet-5-5@high.
review gate: codex:gpt-6.1-sol@high
# All SEV levels. Gate fallback stays per the merge policy.
reviewers: claude:claude-opus-5-5@high, codex:gpt-6.1-sol@high
# fallback: grok:grok-4.7@high
writer twice: claude:claude-opus-5-5@high
# fallback: codex:gpt-6.1-sol@high, then claude:claude-opus-5-5@high, then inherit-parent
`;

function rules(text = RULES): RuleSet {
  const parsed = parseRules(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.rules;
}

function plan(role: string, extra: Partial<Parameters<typeof planRoute>[0]> = {}): RoutePlan {
  const result = planRoute({
    rules: rules(),
    rulesSource: { path: "/rules/pstack-models.mdc", origin: "flag" },
    role,
    cwd: "/work/project",
    ...extra,
  });
  if (!result.ok) throw new Error(result.error);
  return result;
}

const fallbackSelectors = (set: RuleSet, role: string) =>
  set.roles
    .find((entry) => entry.names.includes(role))!
    .fallbacks.map((entry) => (entry.ok ? entry.selector : `!${entry.selector}`));

describe("fallback order in the rules file", () => {
  it("attaches each `# fallback:` comment to the role entry above it", () => {
    const set = rules();
    expect(fallbackSelectors(set, "refactoring")).toEqual([
      "codex:gpt-6.1-sol@high",
      "grok:grok-4.7@high",
    ]);
    // A trailing comment on the role line itself; an unusable entry is kept, marked.
    expect(fallbackSelectors(set, "explorer")).toEqual([
      "!cursor Auto",
      "claude:claude-sonnet-5-5@high",
    ]);
    // After another comment line, and after a sentence inside a comment.
    expect(fallbackSelectors(set, "design consultant")).toEqual([
      "claude:claude-sonnet-5-5@high",
      "!cursor Auto",
    ]);
    expect(fallbackSelectors(set, "design implementation")).toEqual([
      "codex:gpt-6.1-sol@high",
      "claude:claude-sonnet-5-5@high",
    ]);
    // Prose that mentions a fallback without `fallback:` declares none.
    expect(fallbackSelectors(set, "review gate")).toEqual([]);
    const explorer = set.roles.find((entry) => entry.names.includes("explorer"))!;
    expect(explorer.fallbacks[0]).toMatchObject({
      ok: false,
      line: 7,
      error: 'unrecognized model descriptor "cursor Auto"; write provider:model@effort',
    });
    expect(explorer.lanes).toHaveLength(1);
    expect(set.invalid).toEqual([]);
  });

  it("ignores a fallback comment before the first role, and one after an invalid entry", () => {
    const set = rules(
      "# fallback: codex:gpt-6.1-sol@high\nbroken: nope\n# fallback: codex:gpt-6.1-sol@high\nok: claude:claude-opus-5-5@high\n",
    );
    expect(set.roles.map((role) => [role.names, role.fallbacks])).toEqual([[["ok"], []]]);
    expect(set.invalid.map((role) => role.names)).toEqual([["broken"]]);
  });

  it("marks a role with two fallback lines invalid instead of guessing which one counts", () => {
    const set = rules(
      "solo: claude:claude-opus-5-5@high  # fallback: codex:gpt-6.1-sol@high\n# fallback: grok:grok-4.7@high\nother: codex:gpt-6.1-sol@high\n",
    );
    expect(set.roles.map((role) => role.names)).toEqual([["other"]]);
    expect(set.invalid).toEqual([
      {
        line: 1,
        names: ["solo"],
        error:
          'line 2: role "solo" already has a fallback order on line 1; write one fallback line per role',
      },
    ]);
  });
});

describe("fallback order in a plan", () => {
  it("plans a single lane's fallbacks and notes every entry it drops", () => {
    const explorer = plan("explorer");
    expect(explorer.fallbacks.map((lane) => [lane.index, lane.descriptor])).toEqual([
      [1, "claude:claude-sonnet-5-5@high"],
    ]);
    expect(explorer.notes).toEqual([
      'fallback 1 (cursor Auto) skipped: unrecognized model descriptor "cursor Auto"; write provider:model@effort',
    ]);
    const twice = plan("writer twice");
    expect(twice.fallbacks.map((lane) => lane.descriptor)).toEqual(["codex:gpt-6.1-sol@high"]);
    expect(twice.notes).toEqual([
      "fallback 2 (claude:claude-opus-5-5@high) skipped: claude:claude-opus-5-5@high is already earlier in this role's order",
      "fallback 3 (inherit-parent) skipped: inherit-parent needs --parent provider:model@effort",
    ]);
    const withParent = plan("writer twice", { parent: "grok:grok-4.7@high" });
    expect(withParent.fallbacks.map((lane) => [lane.descriptor, lane.from])).toEqual([
      ["codex:gpt-6.1-sol@high", "rule"],
      ["grok:grok-4.7@high", "parent"],
    ]);
  });

  it("applies the project policy to fallbacks and never gives a panel one", () => {
    const allowed = plan("feature", {
      policy: { allowedProviders: ["claude", "grok"] },
      policySource: "/work/project/.herdr/policy.json",
    });
    expect(allowed.fallbacks.map((lane) => lane.descriptor)).toEqual(["grok:grok-4.7@high"]);
    expect(allowed.notes).toEqual([
      "fallback 1 (codex:gpt-6.1-sol@high) skipped: project policy allows claude, grok, not codex",
    ]);
    const pinned = plan("feature", {
      policy: { pins: { feature: "claude:claude-opus-5-5@high" } },
      policySource: "/work/project/.herdr/policy.json",
    });
    expect(pinned.fallbacks).toEqual([]);
    expect(pinned.notes[0]).toBe(
      'fallback 1 (codex:gpt-6.1-sol@high) skipped: project policy pin "feature" requires claude:claude-opus-5-5@high',
    );
    const panel = plan("reviewers");
    expect(panel.fallbacks).toEqual([]);
    expect(panel.notes).toContain(
      'the fallback order on line 16 is ignored: role "reviewers" is a panel, and every panel lane already runs',
    );
  });
});

/** What a pane shows above its first prompt: the CLI's banner, as it was before the prompt. */
const BANNER = "  Welcome to the CLI\n  cwd: /work/project\n\n";
const after = (kind: string, sent: string) => ({ sent, kind, before: BANNER });

/** The composer Cursor draws again when a turn ends (its banner is not repeated). */
const CURSOR_COMPOSER = "  → Add a follow-up\n  Plan (shift+tab to cycle)\n";

describe("quota detection", () => {
  it("recognizes each CLI's exhausted-limit message, wrapped or not", () => {
    expect(detectQuota("⏺ Claude usage limit reached. Your limit will reset at 5pm")).toBe(
      "limit reached",
    );
    expect(detectQuota("5-hour limit reached ∙ resets 3pm")).toBe("limit reached");
    expect(detectQuota("You've hit your limit · resets 3pm")).toBe("hit your limit");
    expect(
      detectQuota(
        "■ You've hit your usage\n  limit. Upgrade to Pro, or try again in 4 days 12 hours.",
      ),
    ).toBe("hit your limit");
    expect(detectQuota("stream error: exceeded retry limit, last status: 429 Too Many")).toBe(
      "HTTP 429 after retries",
    );
    expect(detectQuota("Error: Rate limit exceeded. Please retry later.")).toBe(
      "rate limit exceeded",
    );
    expect(detectQuota("You exceeded your current quota, please check your plan")).toBe(
      "quota exceeded",
    );
    expect(detectQuota("You have run out of credits")).toBe("out of credits");
  });

  it("ignores warnings, context limits, and the echo of the prompt the router sent", () => {
    expect(detectQuota("Approaching usage limit · resets at 3pm")).toBeUndefined();
    expect(detectQuota("Context limit reached · /compact or /clear to continue")).toBeUndefined();
    expect(detectQuota(READY_SCREEN.claude!)).toBeUndefined();
    const sent = "When Codex says You've hit your usage limit, switch models.\nAdd tests.";
    const codex = after("codex", sent);
    // The pane wraps and indents the echoed prompt.
    const echoed =
      "› When Codex says You've hit your\n  usage limit, switch models.\n  Add tests.\n";
    expect(detectQuota(`${BANNER}${echoed}`, codex)).toBeUndefined();
    expect(
      detectQuota(
        `${BANNER}${echoed}\n■ You've hit your usage\n  limit. Try again in 2 hours.`,
        codex,
      ),
    ).toBe("hit your limit");
    // A long prompt that Claude Code collapses still anchors the check.
    expect(
      detectQuota(
        `${BANNER}> [Pasted text #1 +40 lines]\n  ⎿  Claude usage limit reached.`,
        after("claude", "x\n".repeat(40)),
      ),
    ).toBe("limit reached");
    // No echo of the prompt on screen: never read as a quota error.
    expect(detectQuota(`${BANNER}■ You've hit your usage limit.`, codex)).toBeUndefined();
  });

  it("after a prompt, reads only the CLI's own error line, first after the echo", () => {
    const sent = "Handle provider errors in the client.";
    const claude = after("claude", sent);
    // Codex's case: a writer runs a tool, then its short summary starts with the phrase.
    const shortSummary = [
      `> ${sent}`,
      "",
      "⏺ Write(src/client.ts)",
      "  ⎿  Wrote 20 lines to src/client.ts",
      "⏺ Rate limit exceeded is now handled with retries.",
    ].join("\n");
    expect(detectQuota(`${BANNER}${shortSummary}`, claude)).toBeUndefined();
    // Even the model's first line, with no tool call, is model output (⏺), not a CLI error.
    expect(
      detectQuota(`${BANNER}> ${sent}\n⏺ Rate limit exceeded is now handled.`, claude),
    ).toBeUndefined();
    // A tool result that prints the phrase follows its tool call, never the echo itself.
    expect(
      detectQuota(`${BANNER}> ${sent}\n⏺ Bash(curl api)\n  ⎿  Rate limit exceeded`, claude),
    ).toBeUndefined();
    // Codex model output is `•`; only `■` is Codex's own error.
    expect(
      detectQuota(
        `${BANNER}› ${sent}\n• You've hit your usage limit is handled now.`,
        after("codex", sent),
      ),
    ).toBeUndefined();
    // The CLI's own error, first after the echo, is.
    expect(detectQuota(`${BANNER}> ${sent}\n  ⎿  You've hit your limit · resets 3pm`, claude)).toBe(
      "hit your limit",
    );
    // A CLI with neither an error line nor a composer rule is never read after a prompt.
    expect(
      detectQuota(`${BANNER}> ${sent}\nError: Rate limit exceeded\n> `, after("opencode", sent)),
    ).toBeUndefined();
  });

  it("reads grok's and Cursor's own quota message when it is the whole turn", () => {
    const sent = "Handle provider errors in the client.";
    const grok = after("grok", sent);
    const cursor = after("cursor", sent);
    const grokTurn = (turn: string) => `${BANNER}> ${sent}\n\n${turn}\n${READY_SCREEN.grok}`;
    const cursorTurn = (turn: string) => `${BANNER}> ${sent}\n\n${turn}\n\n${CURSOR_COMPOSER}`;
    expect(detectQuota(grokTurn("Error: Rate limit exceeded for grok-4.7."), grok)).toBe(
      "rate limit exceeded",
    );
    expect(detectQuota(grokTurn("Rate limit exceeded (429). Try again in 30 seconds."), grok)).toBe(
      "rate limit exceeded",
    );
    expect(
      detectQuota(
        cursorTurn("  You've hit your usage limit\n  Switch to Auto or upgrade to continue."),
        cursor,
      ),
    ).toBe("hit your limit");
    expect(detectQuota(cursorTurn("  You've hit your usage limit for this cycle."), cursor)).toBe(
      "hit your limit",
    );
    expect(
      detectQuota(
        grokTurn("You've hit your usage limit. Upgrade to Pro, or try again in 4 days 12 hours."),
        grok,
      ),
    ).toBe("hit your limit");
    for (const message of [
      "You've hit your limit · resets 3pm (America/Los_Angeles)",
      "Rate limit exceeded. Try again at 5pm (UTC+2).",
      "Rate limit exceeded. Resets Oct 14 at 9am PT.",
    ]) {
      expect(detectQuota(grokTurn(message), grok)).toBeDefined();
    }
    // Advice is read whole: anything after it is the model's text.
    for (const [turn, opts] of [
      [cursorTurn, cursor],
      [grokTurn, grok],
    ] as const) {
      for (const summary of [
        "Rate limit exceeded. Try again later is now shown with a countdown.",
        "Rate limit exceeded. Retry later now works.",
        "Rate limit exceeded. Try again in 3 retries is the new policy.",
        "You've hit your usage limit for everyone is handled.",
        // Parentheses hold only a time zone, never the model's words.
        "Rate limit exceeded. Try again later (now shown with a countdown).",
        "Rate limit exceeded. Try again later (and/or retry).",
        "Rate limit exceeded. Retry after marketing.",
      ]) {
        expect(detectQuota(turn(summary), opts)).toBeUndefined();
      }
    }
    // The review gate's case: a normal one-line summary that starts with the phrase.
    expect(detectQuota(grokTurn("Rate limit exceeded is now retried."), grok)).toBeUndefined();
    expect(
      detectQuota(cursorTurn("  Rate limit exceeded is now retried."), cursor),
    ).toBeUndefined();
    expect(
      detectQuota(cursorTurn("  You've hit your usage limit handling is in place."), cursor),
    ).toBeUndefined();
    expect(
      detectQuota(grokTurn("Rate limit exceeded. Now retried with backoff."), grok),
    ).toBeUndefined();
    // The model ran first (a tool call, or more output than a message): not a quota error.
    expect(
      detectQuota(cursorTurn("  ⬢ Read src/client.ts\n  You've hit your usage limit"), cursor),
    ).toBeUndefined();
    // The message must open the turn, and the composer must be back.
    expect(
      detectQuota(grokTurn("Done. The client handles:\nRate limit exceeded"), grok),
    ).toBeUndefined();
    expect(detectQuota(`${BANNER}> ${sent}\n\nError: Rate limit exceeded`, grok)).toBeUndefined();
  });

  it("anchors on the pane's echo of the prompt, never on a later line that quotes it", () => {
    const sent = "Handle provider errors in the client.";
    // The review gate's reproduction: the writer finished, and its summary quotes the task and
    // then the error it now handles.
    const summary = `> ${sent}\nYou've hit your usage limit.`;
    expect(
      detectQuota(
        `${BANNER}> ${sent}\n\n  Updated src/client.ts.\n${summary}\n\n${CURSOR_COMPOSER}`,
        after("cursor", sent),
      ),
    ).toBeUndefined();
    expect(
      detectQuota(
        `${BANNER}> ${sent}\n\nUpdated src/client.ts.\n${summary}\n\n${READY_SCREEN.grok}`,
        after("grok", sent),
      ),
    ).toBeUndefined();
    // Even a quote followed by a line that looks like the CLI's own error.
    expect(
      detectQuota(
        `${BANNER}> ${sent}\n⏺ Updated src/client.ts.\n  > ${sent}\n  ⎿  You've hit your limit`,
        after("claude", sent),
      ),
    ).toBeUndefined();
    expect(
      detectQuota(
        `${BANNER}› ${sent}\n• Updated src/client.ts.\n› ${sent}\n■ You've hit your usage limit.`,
        after("codex", sent),
      ),
    ).toBeUndefined();
    // A quote of part of the prompt is not its echo either.
    expect(
      detectQuota(
        `${BANNER}> errors in the client.\n\nError: Rate limit exceeded\n${READY_SCREEN.grok}`,
        after("grok", sent),
      ),
    ).toBeUndefined();
  });

  it("makes no quota decision once the real echo has scrolled off the screen", () => {
    const sent = "Handle provider errors in the client.";
    // The review gate's case: the writer's output pushed the banner and the real echo off the
    // pane; its summary quotes the whole prompt and then a quota message.
    const scrolled = (kind: string, error: string, composer: string) =>
      [
        "  backoff.ts: added jittered retries",
        "  client.ts: wraps provider calls",
        `> ${sent}`,
        error,
        "",
        composer,
      ].join("\n");
    expect(
      detectQuota(
        scrolled("cursor", "  You've hit your usage limit.", CURSOR_COMPOSER),
        after("cursor", sent),
      ),
    ).toBeUndefined();
    expect(
      detectQuota(
        scrolled("grok", "Error: Rate limit exceeded", READY_SCREEN.grok!),
        after("grok", sent),
      ),
    ).toBeUndefined();
    expect(
      detectQuota(scrolled("claude", "  ⎿  You've hit your limit", ""), after("claude", sent)),
    ).toBeUndefined();
    // The quoted prompt as the very first line of the screen, with nothing above it, either.
    expect(
      detectQuota(
        `> ${sent}\n\nError: Rate limit exceeded\n${READY_SCREEN.grok}`,
        after("grok", sent),
      ),
    ).toBeUndefined();
  });

  it("does not mistake a writer that finished and quotes a quota error for one", () => {
    const sent = "Handle provider errors in the client.";
    const finished = [
      "> Handle provider errors in the client.",
      "",
      "⏺ Read(src/client.ts)",
      "  ⎿  Read 120 lines",
      "⏺ Update(src/client.ts)",
      "  ⎿  Updated src/client.ts with 14 additions",
      "⏺ Done. The client now retries when the API answers:",
      "",
      "  Rate limit exceeded",
      "",
      "  You've hit your usage limit",
      "",
    ].join("\n");
    expect(detectQuota(`${BANNER}${finished}`, after("claude", sent))).toBeUndefined();
    // Quoted in prose, even right after the prompt, it does not start a line.
    expect(
      detectQuota(
        `${BANNER}> ${sent}\n⏺ Retries now cover "Rate limit exceeded" replies.`,
        after("claude", sent),
      ),
    ).toBeUndefined();
  });
});

const QUOTA = {
  claude: "  ⎿  You've hit your limit · resets 3pm (America/Los_Angeles)\n",
  codex: "■ You've hit your usage limit. Upgrade to Pro, or try again in 2 hours.\n",
  grok: "Error: Rate limit exceeded for grok-4.7.\n",
  cursor: "  You've hit your usage limit\n  Switch to Auto or upgrade to continue.\n",
};

/** A Cursor first version that falls back to Claude Code. */
const CURSOR_RULES = `${RULES}first version: cursor:claude-opus-5-5-high
# fallback: claude:claude-opus-5-5@high
`;

/** A grok fix that falls back to Claude Code. */
const GROK_RULES = `${RULES}fix: grok:grok-4.7@high
# fallback: claude:claude-opus-5-5@high
`;

/**
 * After a prompt to a pane whose CLI is in `limited`, that CLI ends its turn on its own
 * quota message; the pane echoes the prompt above it, as a real pane does.
 */
function quotaAfterPrompt(
  herdr: () => FakeHerdr,
  limited: string[],
  messages: Record<string, string> = QUOTA,
) {
  return (target: string) => {
    const pane = [...herdr().panes.values()].find((entry) => entry.name === target);
    if (pane?.kind && limited.includes(pane.kind)) {
      const sent = herdr().prompts.at(-1)!.text;
      // The screen it showed before the prompt scrolls up above the echo.
      pane.history = `${pane.history ?? ""}${pane.screen ?? ""}> ${sent}\n\n${messages[pane.kind]}`;
      if (pane.kind === "cursor") pane.screen = CURSOR_COMPOSER;
      pane.status = "idle";
    }
    return undefined;
  };
}

describe("dispatch follows the fallback order on a quota or usage limit", () => {
  it("closes a writer that hit its limit after the prompt and hands the task to the next model", async () => {
    const herdr: FakeHerdr = fakeHerdr({ prompt: quotaAfterPrompt(() => herdr, ["claude"]) });
    const { deps: d } = deps(herdr);
    const result = await dispatchPlan({
      plan: plan("feature"),
      prompt: "Fix the crash",
      worktreeId: "/work/project",
      deps: d,
    });
    if (!result.ok) throw new Error(result.error);
    const lane = result.lanes[0]!;
    expect(lane).toMatchObject({
      descriptor: "codex:gpt-6.1-sol@high",
      state: "prompted",
      paneId: "w1:p2",
      attempt: { state: "working" },
      skipped: [
        {
          descriptor: "claude:claude-opus-5-5@high",
          reason: 'claude reported a quota or usage-limit error ("hit your limit")',
        },
      ],
    });
    expect(lane.argv[0]).toBe("/opt/fake bin/codex");
    expect(result.task).toMatchObject({ access: "write", status: "dispatched" });
    // The same writer text went to both models; the limited pane was closed first.
    expect(herdr.prompts.map((prompt) => prompt.text)).toEqual([
      expect.stringContaining("Fix the crash"),
      expect.stringContaining("Fix the crash"),
    ]);
    expect(herdr.prompts[0]!.text).toBe(herdr.prompts[1]!.text);
    const order = herdr.calls.map((call) => call.slice(0, 3).join(" "));
    expect(order.indexOf("pane close w1:p1")).toBeLessThan(
      order.indexOf("pane split /work/project", 1),
    );
    // The task keeps its worktree; the lane records what it skipped and on which attempt.
    expect(d.store.ownerOf("/work/project")?.taskId).toBe(result.task.id);
    const stored = d.store.getLane(lane.laneId)!;
    const [first, second] = d.store.attempts(lane.laneId);
    expect(stored).toMatchObject({
      descriptor: "codex:gpt-6.1-sol@high",
      provider: "codex",
      paneId: "w1:p2",
      sessionId: "sess-w1:p2",
      skipped: [
        {
          descriptor: "claude:claude-opus-5-5@high",
          reason: 'claude reported a quota or usage-limit error ("hit your limit")',
          paneId: "w1:p1",
          attemptId: first!.id,
        },
      ],
    });
    expect(second?.state).toBe("working");
    expect(formatLaneOutcome(lane).split("\n")).toEqual([
      'Lane 1 skipped claude:claude-opus-5-5@high: claude reported a quota or usage-limit error ("hit your limit")',
      `Lane 1 [${lane.laneId}] codex:gpt-6.1-sol@high prompted pane w1:p2 agent ${lane.agentName} attempt ${second!.id}: working (herdr agent prompt --wait observed working)`,
    ]);
    const status = executeTaskStatus(d.store, result.task.id);
    expect(status.output).toContain(
      `  skipped claude:claude-opus-5-5@high: claude reported a quota or usage-limit error ("hit your limit") (attempt ${first!.id})`,
    );
    // A revision goes to the model that took over, in its own pane.
    const pane = herdr.panes.get("w1:p2")!;
    pane.status = "idle";
    const revised = await reviseTask({ taskId: result.task.id, text: "Also add a test", deps: d });
    expect(revised.ok && revised.lane.paneId).toBe("w1:p2");
    expect(herdr.prompts.at(-1)).toEqual({ target: lane.agentName, text: "Also add a test" });
  });

  it("skips a model whose screen shows its limit at startup, and a fallback whose CLI is missing", async () => {
    const herdr = fakeHerdr({
      detect: (_pane, executable) =>
        executable === "claude"
          ? { screen: `You've hit your limit · resets 3pm\n${READY_SCREEN.claude}` }
          : {},
    });
    const { deps: d } = deps(herdr, {
      resolveExecutable: (name) => (name === "codex" ? undefined : `/opt/fake bin/${name}`),
    });
    const result = await dispatchPlan({
      plan: plan("feature"),
      prompt: "Fix it",
      worktreeId: "/work/project",
      deps: d,
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.lanes[0]).toMatchObject({
      descriptor: "grok:grok-4.7@high",
      state: "prompted",
      skipped: [
        {
          descriptor: "claude:claude-opus-5-5@high",
          reason: 'claude reported a quota or usage-limit error ("hit your limit")',
        },
        {
          descriptor: "codex:gpt-6.1-sol@high",
          reason: "`codex` is not on PATH; the codex CLI is missing.",
        },
      ],
    });
    // The limited CLI was never named or prompted.
    expect(herdr.calls.filter((call) => call[1] === "rename").map((call) => call[2])).toEqual([
      "w1:p2",
    ]);
    expect(herdr.prompts).toHaveLength(1);
    expect(d.store.getLane(result.lanes[0]!.laneId)?.skipped?.[0]).toMatchObject({
      paneId: "w1:p1",
    });
    expect(d.store.getLane(result.lanes[0]!.laneId)?.skipped?.[0]?.attemptId).toBeUndefined();
  });

  it("falls back when a CLI fails to start on a dialog, and prints the reason (AGENT-285)", async () => {
    const herdr = fakeHerdr({
      detect: (_pane, executable) =>
        executable === "claude" ? { screen: screen("claude-trust") } : {},
    });
    const { deps: d } = deps(herdr);
    const result = await dispatchPlan({
      plan: plan("feature"),
      prompt: "Fix it",
      worktreeId: "/work/project",
      deps: d,
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.lanes[0]).toMatchObject({
      descriptor: "codex:gpt-6.1-sol@high",
      state: "prompted",
      skipped: [
        {
          descriptor: "claude:claude-opus-5-5@high",
          reason: "claude failed to start: workspace trust dialog",
        },
      ],
    });
    // The dialog was never answered and the stuck CLI never prompted.
    expect(herdr.prompts).toHaveLength(1);
  });

  it("stops with a clear error and releases the worktree when every model hits its limit", async () => {
    const herdr: FakeHerdr = fakeHerdr({
      prompt: quotaAfterPrompt(() => herdr, ["claude", "codex"]),
      // Here grok shows its limit on its startup screen, before any prompt.
      detect: (_pane, executable) =>
        executable === "grok" ? { screen: `${QUOTA.grok}${READY_SCREEN.grok}` } : {},
    });
    const { deps: d } = deps(herdr);
    const result = await dispatchPlan({
      plan: plan("feature"),
      prompt: "Fix it",
      worktreeId: "/work/project",
      deps: d,
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.lanes[0]).toMatchObject({ state: "failed", descriptor: "grok:grok-4.7@high" });
    expect(result.lanes[0]?.paneId).toBeUndefined();
    expect(result.lanes[0]?.attempt).toBeUndefined();
    expect(result.lanes[0]?.error).toBe(
      'every model in the fallback order for role "feature" hit a quota or usage limit or could not be launched: ' +
        'claude:claude-opus-5-5@high (claude reported a quota or usage-limit error ("hit your limit")); ' +
        'codex:gpt-6.1-sol@high (codex reported a quota or usage-limit error ("hit your limit")); ' +
        'grok:grok-4.7@high (grok reported a quota or usage-limit error ("rate limit exceeded")). ' +
        "Nothing else is tried, and no API key is used.",
    );
    expect(herdr.calls.filter((call) => call[1] === "close").map((call) => call[2])).toEqual([
      "w1:p1",
      "w1:p2",
      "w1:p3",
    ]);
    // No writer is left running, so the worktree is free again, with the evidence on record.
    expect(result.task).toMatchObject({
      status: "released",
      closingEvidence: expect.stringContaining("hit a quota or usage limit"),
    });
    expect(d.store.ownerOf("/work/project")).toBeUndefined();
  });

  it("does not launch a fallback while the limited pane may still run", async () => {
    const herdr: FakeHerdr = fakeHerdr({
      prompt: quotaAfterPrompt(() => herdr, ["claude"]),
      close: () => false,
    });
    const { deps: d } = deps(herdr);
    const result = await dispatchPlan({
      plan: plan("feature"),
      prompt: "Fix it",
      worktreeId: "/work/project",
      deps: d,
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.lanes[0]).toMatchObject({
      state: "failed",
      paneId: "w1:p1",
      descriptor: "claude:claude-opus-5-5@high",
      error: expect.stringContaining("Closing pane w1:p1 was not confirmed"),
    });
    expect(herdr.calls.filter((call) => call[1] === "split")).toHaveLength(1);
    expect(d.store.ownerOf("/work/project")?.taskId).toBe(result.task.id);
  });

  it("keeps a writer that finished normally and quotes a quota error in its summary", async () => {
    const herdr: FakeHerdr = fakeHerdr({
      prompt: (target) => {
        const pane = [...herdr.panes.values()].find((entry) => entry.name === target)!;
        pane.history = [
          pane.screen,
          // The review gate's reproduction: a tool call, then a short summary.
          `> ${herdr.prompts.at(-1)!.text}`,
          "",
          "⏺ Write(src/client.ts)",
          "  ⎿  Wrote 20 lines to src/client.ts",
          "⏺ Rate limit exceeded is now handled with retries.",
          "",
        ].join("\n");
        pane.status = "idle";
        return undefined;
      },
    });
    const { deps: d } = deps(herdr);
    const result = await dispatchPlan({
      plan: plan("feature"),
      prompt: "Retry provider errors",
      worktreeId: "/work/project",
      deps: d,
    });
    expect(result.ok && result.lanes[0]).toMatchObject({
      descriptor: "claude:claude-opus-5-5@high",
      state: "prompted",
      paneId: "w1:p1",
    });
    expect(result.ok && result.lanes[0]?.skipped).toBeUndefined();
    // The prompt went out once, and the finished writer's pane was not closed.
    expect(herdr.prompts).toHaveLength(1);
    expect(herdr.calls.filter((call) => call[1] === "close")).toEqual([]);
  });

  it("leaves a lane alone when its prompt only mentions a usage limit, or it has no fallback order", async () => {
    const herdr: FakeHerdr = fakeHerdr({
      prompt: (target) => {
        const pane = [...herdr.panes.values()].find((entry) => entry.name === target)!;
        // The pane echoes the task, which talks about usage limits, and the turn goes on.
        pane.history = `${pane.screen}> ${herdr.prompts.at(-1)!.text}\n`;
        return undefined;
      },
    });
    const { deps: d } = deps(herdr);
    const result = await dispatchPlan({
      plan: plan("feature"),
      prompt: "Retry when Codex prints You've hit your usage limit",
      worktreeId: "/work/project",
      deps: d,
    });
    expect(result.ok && result.lanes[0]).toMatchObject({
      descriptor: "claude:claude-opus-5-5@high",
      state: "prompted",
    });
    expect(result.ok && result.lanes[0]?.skipped).toBeUndefined();

    const gate: FakeHerdr = fakeHerdr({ prompt: quotaAfterPrompt(() => gate, ["codex"]) });
    const reads = deps(gate);
    const review = await dispatchPlan({
      plan: plan("review gate"),
      prompt: "Review it",
      worktreeId: "/work/project",
      deps: reads.deps,
    });
    // Without a fallback order the router does not watch the pane after the prompt.
    expect(review.ok && review.lanes[0]).toMatchObject({ state: "prompted" });
    expect(gate.calls.filter((call) => call[1] === "close")).toEqual([]);
  });

  it("starts hmr's pane guard for a Cursor writer, and closes the pane unprompted if it cannot", async () => {
    const started: unknown[] = [];
    const herdr: FakeHerdr = fakeHerdr();
    const { deps: d } = deps(herdr, {
      startCursorGuard: (input: unknown) => (started.push(input), { ok: true }),
    } as never);
    const ok = await dispatchPlan({
      plan: plan("first version", { rules: rules(CURSOR_RULES) }),
      prompt: "Fix the crash",
      worktreeId: "/work/project",
      deps: d,
    });
    if (!ok.ok) throw new Error(ok.error);
    expect(started).toEqual([
      {
        paneId: "w1:p1",
        worktree: "/work/project",
        laneId: expect.any(String),
        configDir: "/fake/cursor-config/lane",
      },
    ]);

    const failing: FakeHerdr = fakeHerdr();
    const { deps: f } = deps(failing, {
      startCursorGuard: () => ({ ok: false, error: "guard did not start" }),
    } as never);
    const result = await dispatchPlan({
      plan: plan("first version", { rules: rules(CURSOR_RULES) }),
      prompt: "Fix the crash",
      worktreeId: "/work/project",
      deps: f,
    });
    expect(failing.calls.some((call) => call[1] === "close" && call[2] === "w1:p1")).toBe(true);
    expect(JSON.stringify(result)).toMatch(/guard did not start; no prompt was sent/);
    // The Cursor pane was never prompted; the target is a pane id or that lane's agent name.
    expect(failing.prompts.some((p) => p.target === "w1:p1" || p.target.includes("cursor"))).toBe(
      false,
    );
  });

  it("hands a Cursor first version that hit its limit after the prompt to the next model", async () => {
    const herdr: FakeHerdr = fakeHerdr({ prompt: quotaAfterPrompt(() => herdr, ["cursor"]) });
    const { deps: d } = deps(herdr);
    const result = await dispatchPlan({
      plan: plan("first version", { rules: rules(CURSOR_RULES) }),
      prompt: "Fix the crash",
      worktreeId: "/work/project",
      deps: d,
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.lanes[0]).toMatchObject({
      descriptor: "claude:claude-opus-5-5@high",
      state: "prompted",
      paneId: "w1:p2",
      skipped: [
        {
          descriptor: "cursor:claude-opus-5-5-high",
          reason: 'cursor reported a quota or usage-limit error ("hit your limit")',
        },
      ],
    });
    expect(herdr.calls.filter((call) => call[1] === "close").map((call) => call[2])).toEqual([
      "w1:p1",
    ]);
    expect(herdr.prompts).toHaveLength(2);
    expect(result.task).toMatchObject({ access: "write", status: "dispatched" });
    expect(d.store.getLane(result.lanes[0]!.laneId)?.skipped?.[0]).toMatchObject({
      paneId: "w1:p1",
      attemptId: expect.any(String),
    });
  });

  it("hands a grok writer that hit its limit after the prompt to the next model", async () => {
    const herdr: FakeHerdr = fakeHerdr({ prompt: quotaAfterPrompt(() => herdr, ["grok"]) });
    const { deps: d } = deps(herdr);
    const result = await dispatchPlan({
      plan: plan("fix", { rules: rules(GROK_RULES) }),
      prompt: "Address the review",
      worktreeId: "/work/project",
      deps: d,
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.lanes[0]).toMatchObject({
      descriptor: "claude:claude-opus-5-5@high",
      state: "prompted",
      skipped: [
        {
          descriptor: "grok:grok-4.7@high",
          reason: 'grok reported a quota or usage-limit error ("rate limit exceeded")',
        },
      ],
    });
    expect(herdr.calls.filter((call) => call[1] === "close").map((call) => call[2])).toEqual([
      "w1:p1",
    ]);
  });

  it("keeps a Cursor writer whose summary quotes the task and then a quota error", async () => {
    const herdr: FakeHerdr = fakeHerdr({
      prompt: (target) => {
        const pane = [...herdr.panes.values()].find((entry) => entry.name === target)!;
        const sent = herdr.prompts.at(-1)!.text;
        pane.history = [
          pane.screen,
          `> ${sent}`,
          "",
          "  Updated src/client.ts. As asked:",
          `> ${sent}`,
          "You've hit your usage limit.",
          "",
        ].join("\n");
        pane.screen = CURSOR_COMPOSER;
        pane.status = "idle";
        return undefined;
      },
    });
    const { deps: d } = deps(herdr);
    const result = await dispatchPlan({
      plan: plan("first version", { rules: rules(CURSOR_RULES) }),
      prompt: "Handle provider errors in the client.",
      worktreeId: "/work/project",
      deps: d,
    });
    expect(result.ok && result.lanes[0]).toMatchObject({
      descriptor: "cursor:claude-opus-5-5-high",
      state: "prompted",
      paneId: "w1:p1",
    });
    expect(result.ok && result.lanes[0]?.skipped).toBeUndefined();
    expect(herdr.prompts).toHaveLength(1);
    expect(herdr.calls.filter((call) => call[1] === "close")).toEqual([]);
  });

  it.each([
    ["cursor", "Rate limit exceeded is now retried."],
    ["cursor", "Rate limit exceeded. Try again later is now shown with a countdown."],
    ["grok", "Rate limit exceeded is now retried."],
    ["grok", "Rate limit exceeded. Try again later is now shown with a countdown."],
    ["cursor", "Rate limit exceeded. Try again later (now shown with a countdown)."],
    ["grok", "Rate limit exceeded. Try again later (now shown with a countdown)."],
  ])("keeps a %s writer whose whole turn is the summary %j", async (kind, summary) => {
    const herdr: FakeHerdr = fakeHerdr({
      prompt: (target) => {
        const pane = [...herdr.panes.values()].find((entry) => entry.name === target)!;
        const sent = herdr.prompts.at(-1)!.text;
        pane.history = `${pane.screen}> ${sent}\n\n  ${summary}\n\n`;
        if (kind === "cursor") pane.screen = CURSOR_COMPOSER;
        pane.status = "idle";
        return undefined;
      },
    });
    const { deps: d } = deps(herdr);
    const role = kind === "cursor" ? "first version" : "fix";
    const result = await dispatchPlan({
      plan: plan(role, { rules: rules(kind === "cursor" ? CURSOR_RULES : GROK_RULES) }),
      prompt: "Retry provider errors.",
      worktreeId: "/work/project",
      deps: d,
    });
    expect(result.ok && result.lanes[0]).toMatchObject({
      descriptor: kind === "cursor" ? "cursor:claude-opus-5-5-high" : "grok:grok-4.7@high",
      state: "prompted",
      paneId: "w1:p1",
    });
    expect(result.ok && result.lanes[0]?.skipped).toBeUndefined();
    // The prompt went out once, and the finished writer's pane was not closed.
    expect(herdr.prompts).toHaveLength(1);
    expect(herdr.calls.filter((call) => call[1] === "close")).toEqual([]);
  });

  it("hands a Cursor writer that hit its limit for this cycle after the prompt to the next model", async () => {
    // The message from the account-choice fixture, now after the prompt.
    const herdr: FakeHerdr = fakeHerdr({
      prompt: quotaAfterPrompt(() => herdr, ["cursor"], {
        cursor: "  You've hit your usage limit for this cycle.\n",
      }),
    });
    const { deps: d } = deps(herdr);
    const result = await dispatchPlan({
      plan: plan("first version", { rules: rules(CURSOR_RULES) }),
      prompt: "Write the first version",
      worktreeId: "/work/project",
      deps: d,
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.lanes[0]).toMatchObject({
      descriptor: "claude:claude-opus-5-5@high",
      state: "prompted",
      paneId: "w1:p2",
      skipped: [
        {
          descriptor: "cursor:claude-opus-5-5-high",
          reason: 'cursor reported a quota or usage-limit error ("hit your limit")',
        },
      ],
    });
    expect(herdr.calls.filter((call) => call[1] === "close").map((call) => call[2])).toEqual([
      "w1:p1",
    ]);
    expect(herdr.prompts).toHaveLength(2);
    expect(herdr.prompts[0]!.text).toBe(herdr.prompts[1]!.text);
  });

  it("keeps a writer whose real echo scrolled off while its summary quotes the prompt", async () => {
    const herdr: FakeHerdr = fakeHerdr({
      prompt: (target) => {
        const pane = [...herdr.panes.values()].find((entry) => entry.name === target)!;
        const sent = herdr.prompts.at(-1)!.text;
        // Only the end of a long turn is on screen: no banner, no real echo.
        pane.history = [
          "  backoff.ts: added jittered retries",
          "  client.ts: wraps provider calls",
          `> ${sent}`,
          "  You've hit your usage limit.",
          "",
        ].join("\n");
        pane.screen = CURSOR_COMPOSER;
        pane.status = "idle";
        return undefined;
      },
    });
    const { deps: d } = deps(herdr);
    const result = await dispatchPlan({
      plan: plan("first version", { rules: rules(CURSOR_RULES) }),
      prompt: "Handle provider errors in the client.",
      worktreeId: "/work/project",
      deps: d,
    });
    expect(result.ok && result.lanes[0]).toMatchObject({
      descriptor: "cursor:claude-opus-5-5-high",
      state: "prompted",
    });
    expect(result.ok && result.lanes[0]?.skipped).toBeUndefined();
    expect(herdr.prompts).toHaveLength(1);
    expect(herdr.calls.filter((call) => call[1] === "close")).toEqual([]);
  });
});
