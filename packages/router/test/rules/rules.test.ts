import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseLaneSelector, parseNativeDescriptor } from "../../src/rules/descriptor.js";
import { parseRules } from "../../src/rules/mdc-parser.js";
import { loadPolicy, parsePolicy, type ProjectPolicy } from "../../src/rules/policy.js";
import { planRoute } from "../../src/rules/plan.js";
import { findProjectRoot, locateRules } from "../../src/rules/rules-source.js";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/rules/pstack-models.mdc",
);
const text = readFileSync(FIXTURE, "utf8");
const source = { path: "fixture.mdc", origin: "flag" as const };

function rules(input = text) {
  const parsed = parseRules(input);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.rules;
}

describe("descriptors", () => {
  it("parses provider:model@effort with the exact native model id", () => {
    expect(parseNativeDescriptor("codex:gpt-6.1-sol@high")).toEqual({
      ok: true,
      descriptor: {
        provider: "codex",
        model: "gpt-6.1-sol",
        effort: "high",
        canonical: "codex:gpt-6.1-sol@high",
        notes: [],
      },
    });
    expect(parseNativeDescriptor("cursor:composer-2")).toMatchObject({
      ok: true,
      descriptor: { provider: "cursor", model: "composer-2", effort: null },
    });
  });

  it("maps the known legacy Grok selector to native grok and says what is lost", () => {
    const parsed = parseNativeDescriptor("grok-4.7-xhigh-fast");
    expect(parsed).toEqual({
      ok: true,
      descriptor: {
        provider: "grok",
        model: "grok-4.7",
        effort: "xhigh",
        canonical: "grok:grok-4.7@xhigh",
        legacySelector: "grok-4.7-xhigh-fast",
        notes: [
          "legacy Cursor selector grok-4.7-xhigh-fast mapped to native grok:grok-4.7@xhigh; Cursor's fast variant has no native grok equivalent",
        ],
      },
    });
  });

  it.each([
    ["gpt-6.1-sol", /unrecognized model descriptor/],
    ["grok-4.7-high-fast", /unrecognized model descriptor/],
    ["openai:gpt-6.1-sol@high", /unknown provider "openai"/],
    ["claude-code:claude-opus-5-5@high", /unknown provider "claude-code"/],
    ["claude:claude-opus-5-5@ultra", /claude does not support effort "ultra"/],
    ["cursor:composer-2@high", /cursor does not support effort "high"/],
    ["codex:gpt-6.1-sol@", /unrecognized model descriptor/],
    ["codex:@high", /unrecognized model descriptor/],
    ["codex:gpt 5.6@high", /unrecognized model descriptor/],
    ["codex:gpt-6.1-sol@none", /codex does not support effort "none"/],
    ["codex:$(whoami)@high", /unrecognized model descriptor/],
  ])("rejects %s", (raw, message) => {
    const parsed = parseNativeDescriptor(raw);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.error).toMatch(message);
  });

  it.each([
    "claude:opus@high",
    "claude:Opus@high",
    "claude:opusplan",
    "claude:sonnet@medium",
    "claude:haiku@low",
    "claude:fable@high",
    "claude:default",
    "codex:best@high",
    "cursor:auto",
    "claude:claude-opus-latest@high",
  ])("refuses the rolling alias %s", (raw) => {
    const parsed = parseNativeDescriptor(raw);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.error).toMatch(/rolling or automatic model alias/);
  });

  it("keeps full revision ids", () => {
    for (const raw of [
      "claude:claude-opus-5-5@high",
      "claude:claude-sonnet-5-5-20260901@medium",
      "claude:claude-fable-5-1@high",
    ]) {
      expect(parseNativeDescriptor(raw).ok).toBe(true);
    }
  });

  it("recognizes the three parent aliases only as lane selectors", () => {
    for (const alias of ["parent", "auto", "inherit-parent"]) {
      expect(parseLaneSelector(alias)).toEqual({ ok: true, lane: { kind: "parent", alias } });
      expect(parseNativeDescriptor(alias).ok).toBe(false);
    }
  });
});

describe("rules parser", () => {
  it("reads frontmatter, comments, aliases, spacing and parent aliases", () => {
    const parsed = rules();
    expect(parsed.roles.map((role) => role.names)).toEqual([
      ["feature", "refactoring"],
      ["bug-fix"],
      ["legacy writer"],
      ["explorer"],
      ["judgment and prose"],
      ["hardest tasks"],
      ["synthesizer"],
      ["reviewers"],
      ["arena runners"],
      ["cursor reader"],
    ]);
    expect(parsed.roles[1]?.lanes).toEqual([
      {
        kind: "native",
        selector: "claude:claude-opus-5-5@xhigh",
        descriptor: expect.objectContaining({ canonical: "claude:claude-opus-5-5@xhigh" }),
      },
    ]);
    expect(parsed.roles[4]?.lanes).toEqual([{ kind: "parent", alias: "inherit-parent" }]);
    expect(parsed.roles[5]?.lanes).toEqual([{ kind: "parent", alias: "auto" }]);
    expect(parsed.roles[6]?.lanes).toEqual([{ kind: "parent", alias: "parent" }]);
    expect(parsed.invalid).toEqual([]);
  });

  it("keeps panel lanes in order, duplicates included", () => {
    const reviewers = rules().roles.find((role) => role.names.includes("reviewers"));
    expect(
      reviewers?.lanes.map((lane) => (lane.kind === "native" ? lane.descriptor.canonical : "")),
    ).toEqual([
      "claude:claude-opus-5-5@high",
      "codex:gpt-6.1-sol@xhigh",
      "claude:claude-opus-5-5@high",
    ]);
  });

  it("rejects a role defined twice, naming both lines", () => {
    const parsed = parseRules(
      "feature: codex:gpt-6.1-sol@high\nbug-fix, Feature: codex:gpt-6.1-sol@low\n",
    );
    expect(parsed).toEqual({
      ok: false,
      error: 'role "feature" is defined twice (lines 1 and 2)',
    });
  });

  it("rejects lines without a role separator and unclosed frontmatter", () => {
    expect(parseRules("feature codex:gpt-6.1-sol@high\n")).toEqual({
      ok: false,
      error: 'line 1: expected "role[, alias]: lane[, lane]"',
    });
    expect(parseRules("---\nalwaysApply: true\nfeature: codex:gpt-6.1-sol@high\n")).toEqual({
      ok: false,
      error: "frontmatter starting on line 1 is not closed with ---",
    });
  });

  it("keeps a malformed selector as an invalid role instead of guessing", () => {
    const parsed = parseRules(
      "feature: codex:gpt-6.1-sol@high\nweird: gpt-6.1-sol, codex:gpt-6.1-sol@high\n",
    );
    expect(parsed.ok && parsed.rules.invalid).toEqual([
      {
        line: 2,
        names: ["weird"],
        error:
          'line 2, lane 1: unrecognized model descriptor "gpt-6.1-sol"; write provider:model@effort',
      },
    ]);
  });
});

describe("policy", () => {
  it("accepts allowed providers, exact pins and writer roles", () => {
    expect(
      parsePolicy(
        JSON.stringify({
          version: 1,
          allowedProviders: ["codex", "claude"],
          pins: { feature: "codex:gpt-6.1-sol@high", reviewers: ["claude:claude-opus-5-5@high"] },
          writerRoles: ["feature"],
        }),
      ),
    ).toMatchObject({ ok: true });
  });

  it.each([
    [{ version: 1, models: { feature: "codex:gpt-6.1-sol@high" } }, /models/],
    [{ version: 1, env: { OPENAI_API_KEY: "x" } }, /env/],
    [{ version: 1, commands: ["rm -rf /"] }, /commands/],
    [{ version: 1, pins: { feature: "grok-4.7-xhigh-fast" } }, /exact provider:model@effort/],
    [{ version: 1, pins: { feature: "inherit-parent" } }, /exact provider:model@effort/],
    [{ version: 1, pins: { feature: "claude:opus@high" } }, /exact provider:model@effort/],
    [{ version: 1, allowedProviders: ["openai"] }, /allowedProviders/],
    [{ version: 2 }, /version/],
  ])("rejects %j", (raw, message) => {
    const parsed = parsePolicy(JSON.stringify(raw));
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.error).toMatch(message);
  });

  it("returns no policy when the project has none", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hmr-policy-"));
    expect(loadPolicy(dir)).toEqual({ ok: true, policy: undefined });
  });
});

describe("plan", () => {
  const base = { rules: rules(), rulesSource: source, cwd: "/work/project" };

  it("resolves an alias to the shared lane list with literal values", () => {
    const plan = planRoute({ ...base, role: "Refactoring" });
    expect(plan).toEqual({
      ok: true,
      role: "refactoring",
      roleNames: ["feature", "refactoring"],
      kind: "single",
      access: "write",
      rulesSource: source,
      cwd: "/work/project",
      lanes: [
        {
          index: 1,
          descriptor: "codex:gpt-6.1-sol@high",
          provider: "codex",
          model: "gpt-6.1-sol",
          effort: "high",
          from: "rule",
          selector: "codex:gpt-6.1-sol@high",
          notes: [],
        },
      ],
      notes: [],
    });
  });

  it("plans every panel lane, in order, read-only", () => {
    const plan = planRoute({ ...base, role: "reviewers" });
    expect(plan.ok && plan.kind).toBe("panel");
    expect(plan.ok && plan.access).toBe("read");
    expect(plan.ok && plan.lanes.map((lane) => `${lane.index}:${lane.descriptor}`)).toEqual([
      "1:claude:claude-opus-5-5@high",
      "2:codex:gpt-6.1-sol@xhigh",
      "3:claude:claude-opus-5-5@high",
    ]);
  });

  it("resolves parent aliases only from an explicit parent descriptor", () => {
    expect(planRoute({ ...base, role: "arena runners" })).toEqual({
      ok: false,
      code: "parent-unresolved",
      error:
        'role "arena runners" uses inherit-parent; pass --parent provider:model@effort to say which model the parent runs',
      role: "arena runners",
    });
    const plan = planRoute({
      ...base,
      role: "arena runners",
      parent: "claude:claude-opus-5-5@max",
    });
    expect(plan.ok && plan.lanes.map((lane) => [lane.descriptor, lane.from])).toEqual([
      ["claude:claude-opus-5-5@max", "parent"],
      ["claude:claude-opus-5-5@max", "parent"],
      ["grok:grok-4.7@xhigh", "rule"],
    ]);
    expect(planRoute({ ...base, role: "synthesizer", parent: "gpt-6.1-sol" })).toMatchObject({
      ok: false,
      code: "invalid-parent",
    });
    expect(planRoute({ ...base, role: "synthesizer", parent: "claude:opusplan" })).toMatchObject({
      ok: false,
      code: "invalid-parent",
      error: expect.stringContaining("rolling or automatic model alias"),
    });
  });

  it("lists the available roles when the role is unknown", () => {
    const plan = planRoute({ ...base, role: "deploy" });
    expect(plan).toMatchObject({ ok: false, code: "unknown-role" });
    expect(plan.ok ? [] : plan.availableRoles).toContain("reviewers");
  });

  it("refuses a project pin that does not match the role's rule", () => {
    const policy = { version: 1 as const, pins: { feature: "codex:gpt-6.1-sol@xhigh" } };
    expect(planRoute({ ...base, role: "refactoring", policy })).toEqual({
      ok: false,
      code: "pin-conflict",
      role: "refactoring",
      error:
        'project policy pin "feature" requires codex:gpt-6.1-sol@xhigh for role "refactoring", but the rules resolve lane 1 to codex:gpt-6.1-sol@high; nothing was planned',
      pinKey: "feature",
      expected: ["codex:gpt-6.1-sol@xhigh"],
      actual: ["codex:gpt-6.1-sol@high"],
    });
    expect(
      planRoute({
        ...base,
        role: "feature",
        policy: { version: 1, pins: { feature: "codex:gpt-6.1-sol@high" } },
      }).ok,
    ).toBe(true);
  });

  it("enforces every pin on a role's aliases, whatever the JSON key order", () => {
    const good = "codex:gpt-6.1-sol@high";
    const bad = "codex:gpt-6.1-sol@xhigh";
    for (const pins of [
      { feature: good, refactoring: bad },
      { refactoring: bad, feature: good },
    ]) {
      const policy = JSON.parse(JSON.stringify({ version: 1, pins })) as ProjectPolicy;
      for (const role of ["feature", "refactoring"]) {
        expect(planRoute({ ...base, role, policy })).toMatchObject({
          ok: false,
          code: "pin-conflict",
          pinKey: "refactoring",
        });
      }
    }
    const agreeing = { version: 1 as const, pins: { refactoring: good, Feature: [good] } };
    expect(planRoute({ ...base, role: "feature", policy: agreeing }).ok).toBe(true);
    const panel = {
      version: 1 as const,
      pins: {
        reviewers: [
          "claude:claude-opus-5-5@high",
          "codex:gpt-6.1-sol@xhigh",
          "claude:claude-opus-5-5@high",
        ],
        Reviewers: "claude:claude-opus-5-5@high",
      },
    };
    expect(planRoute({ ...base, role: "reviewers", policy: panel })).toMatchObject({
      ok: false,
      pinKey: "Reviewers",
      error: expect.stringContaining("lane 2"),
    });
  });

  it("refuses a provider the project does not allow, and panel writers", () => {
    expect(
      planRoute({
        ...base,
        role: "reviewers",
        policy: { version: 1, allowedProviders: ["claude"] },
      }),
    ).toMatchObject({ ok: false, code: "provider-not-allowed" });
    expect(
      planRoute({ ...base, role: "reviewers", policy: { version: 1, writerRoles: ["reviewers"] } }),
    ).toMatchObject({ ok: false, code: "panel-writer-conflict" });
  });

  it("uses project writer roles to decide single-lane access", () => {
    const policy = { version: 1 as const, writerRoles: ["bug-fix"] };
    expect(planRoute({ ...base, role: "feature", policy })).toMatchObject({ access: "read" });
    expect(planRoute({ ...base, role: "bug-fix", policy })).toMatchObject({ access: "write" });
    expect(planRoute({ ...base, role: "bug-fix", readOnly: true })).toMatchObject({
      access: "read",
    });
  });
});

describe("rules source", () => {
  function tree() {
    const root = mkdtempSync(path.join(os.tmpdir(), "hmr-src-"));
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    mkdirSync(path.join(project, ".git"), { recursive: true });
    mkdirSync(path.join(project, "sub/dir"), { recursive: true });
    mkdirSync(path.join(home, ".cursor/rules"), { recursive: true });
    writeFileSync(path.join(home, ".cursor/rules/pstack-models.mdc"), "x: auto\n");
    return { root, home, project };
  }

  it("prefers --rules, then the project file, then the user file", () => {
    const { home, project } = tree();
    const cwd = path.join(project, "sub/dir");
    expect(findProjectRoot(cwd)).toBe(project);
    expect(locateRules({ cwd, home })).toEqual({
      ok: true,
      source: { path: path.join(home, ".cursor/rules/pstack-models.mdc"), origin: "user" },
    });
    mkdirSync(path.join(project, ".cursor/rules"), { recursive: true });
    writeFileSync(path.join(project, ".cursor/rules/pstack-models.mdc"), "x: auto\n");
    expect(locateRules({ cwd, home })).toMatchObject({ source: { origin: "project" } });
    mkdirSync(path.join(project, ".model-router"), { recursive: true });
    writeFileSync(path.join(project, ".model-router/pstack-models.mdc"), "x: auto\n");
    expect(locateRules({ cwd, home })).toEqual({
      ok: true,
      source: { path: path.join(project, ".model-router/pstack-models.mdc"), origin: "project" },
    });
    writeFileSync(path.join(cwd, "custom.mdc"), "x: auto\n");
    expect(locateRules({ cwd, home, flag: "custom.mdc" })).toEqual({
      ok: true,
      source: { path: path.join(cwd, "custom.mdc"), origin: "flag" },
    });
  });

  it("says where it looked when no rules file exists", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "hmr-none-"));
    const located = locateRules({ cwd: root, home: root });
    expect(located.ok).toBe(false);
    expect(located.ok ? "" : located.error).toMatch(/No pstack-models\.mdc found/);
  });
});
