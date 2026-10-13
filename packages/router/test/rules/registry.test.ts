import { describe, expect, it } from "vitest";
import { parseNativeDescriptor } from "../../src/rules/descriptor.js";
import { formatPlan } from "../../src/commands/rules-commands.js";
import { parseRules } from "../../src/rules/mdc-parser.js";
import { ADAPTED_PROVIDERS, nativeLaunch, permissionProfile } from "../../src/rules/native-argv.js";
import { BUILTIN_READ_ONLY_ROLES, planRoute } from "../../src/rules/plan.js";
import { parseProviderRegistry, providerRegistry } from "../../src/rules/provider-registry.js";
import type { RulesSource } from "../../src/rules/rules-source.js";

const source = { kind: "explicit", path: "/tmp/pstack-models.mdc" } as unknown as RulesSource;

function plan(text: string, role: string, extra: Record<string, unknown> = {}) {
  const parsed = parseRules(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return planRoute({ rules: parsed.rules, rulesSource: source, role, cwd: "/tmp", ...extra });
}

describe("provider registry", () => {
  it("bundles the five existing providers, each with a launch adapter", () => {
    const ids = providerRegistry().providers.map((entry) => entry.id);
    expect(ids.sort()).toEqual(["claude", "codex", "cursor", "grok", "opencode"]);
    for (const id of ids) expect(ADAPTED_PROVIDERS as readonly string[]).toContain(id);
  });

  it("holds metadata only: no launch commands, flags or shell strings", () => {
    const text = JSON.stringify(providerRegistry());
    expect(text).not.toMatch(/--|\$\(|`|;|&&|\|\||\s\//);
    for (const entry of providerRegistry().providers) {
      expect(entry.agentCli).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    }
  });

  it("refuses unknown keys, command-like agentCli values and duplicate ids", () => {
    const base = {
      id: "newagent",
      displayName: "New",
      agentCli: "newagent",
      efforts: [],
      capabilities: ["code"],
      costTier: "low",
      fallbackEligible: false,
    };
    const ok = (providers: unknown[]) => () =>
      parseProviderRegistry(JSON.stringify({ version: 1, providers }));
    expect(ok([base])).not.toThrow();
    expect(ok([{ ...base, launch: "newagent --yolo" }])).toThrow();
    expect(ok([{ ...base, agentCli: "sh -c newagent" }])).toThrow();
    expect(ok([{ ...base, agentCli: "/usr/bin/newagent" }])).toThrow();
    expect(ok([base, base])).toThrow(/duplicate/);
  });

  it("keeps descriptor parsing and effort validation as before", () => {
    expect(parseNativeDescriptor("codex:gpt-6.1-sol@high").ok).toBe(true);
    expect(parseNativeDescriptor("cursor:composer-2@high").ok).toBe(false);
    const unknown = parseNativeDescriptor("acme:model-1");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toContain("claude, codex, grok, cursor, opencode");
  });

  it("fails closed for a provider without an adapter", () => {
    const result = nativeLaunch({ provider: "acme", model: "m", effort: null }, "writer");
    expect(result.ok).toBe(false);
  });
});

describe("read-only roles", () => {
  const rules = [
    "# hmr: readonly coordinator, Arch Reviewer",
    "design consultant: codex:gpt-6.1-sol@high",
    "review gate: codex:gpt-6.1-sol@high",
    "coordinator: grok:grok-4.7@high",
    "arch reviewer, arch: claude:claude-opus-5-5@high",
    "bug-fix: claude:claude-sonnet-5-5@high",
  ].join("\n");

  it("parses the readonly directive as normalized names, invisible to role entries", () => {
    const parsed = parseRules(rules);
    expect(parsed.ok && parsed.rules.readOnlyRoles).toEqual(["coordinator", "arch reviewer"]);
    expect(parsed.ok && parsed.rules.roles.length).toBe(5);
  });

  it("forces the design consultant and review gate read-only with no annotation", () => {
    expect(BUILTIN_READ_ONLY_ROLES).toEqual(["design consultant", "review gate"]);
    for (const role of BUILTIN_READ_ONLY_ROLES) {
      const result = plan(`${role}: codex:gpt-6.1-sol@high`, role);
      expect(result.ok && result.access).toBe("read");
    }
  });

  it("forces annotated roles read-only, through any alias", () => {
    for (const role of ["coordinator", "arch"]) {
      const result = plan(rules, role);
      expect(result.ok && result.access).toBe("read");
    }
    const writer = plan(rules, "bug-fix");
    expect(writer.ok && writer.access).toBe("write");
  });

  it("refuses a project policy that tries to make a read-only role a writer", () => {
    const result = plan(rules, "review gate", {
      policy: { version: 1, writerRoles: ["review gate"] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("readonly-writer-conflict");
  });

  it("lets a project policy tighten a writer to read-only", () => {
    const result = plan(rules, "bug-fix", { policy: { version: 1, writerRoles: [] } });
    expect(result.ok && result.access).toBe("read");
  });

  it("keeps --read-only behaving as before", () => {
    const result = plan(rules, "bug-fix", { readOnly: true });
    expect(result.ok && result.access).toBe("read");
  });

  it("launches a forced read-only codex lane with the read-only sandbox", () => {
    const result = plan(rules, "design consultant");
    if (!result.ok) throw new Error(result.error);
    const launch = nativeLaunch(result.lanes[0]!, permissionProfile(result));
    expect(launch.ok && launch.launch.argv).toEqual(
      expect.arrayContaining(["--sandbox", "read-only"]),
    );
  });

  it("ignores a trailing comment on the directive and refuses unknown directives", () => {
    const parsed = parseRules(
      "# hmr: readonly auditor # inspection only\nauditor: codex:gpt-6.1-sol@high",
    );
    expect(parsed.ok && parsed.rules.readOnlyRoles).toEqual(["auditor"]);
    const result = plan(
      "# hmr: readonly auditor # note\nauditor: codex:gpt-6.1-sol@high",
      "auditor",
    );
    expect(result.ok && result.access).toBe("read");
    expect(parseRules("# hmr: writable auditor").ok).toBe(false);
  });

  it("marks globally read-only plans so callers cannot launch them writable", () => {
    const result = plan(rules, "review gate");
    expect(result.ok && result.forcedReadOnly).toBe(true);
    const writer = plan(rules, "bug-fix", { readOnly: true });
    expect(writer.ok && writer.forcedReadOnly).toBe(false);
  });

  it("keeps a collapsed panel read-only and a forced role read-only after parent dedupe", () => {
    const text =
      "review gate: inherit-parent, codex:gpt-6.1-sol@high\ncopies: inherit-parent, grok:grok-4.7@high\n";
    const gate = plan(text, "review gate", { parent: "codex:gpt-6.1-sol@high" });
    expect(gate.ok && [gate.kind, gate.access, gate.forcedReadOnly]).toEqual([
      "single",
      "read",
      true,
    ]);
    expect(gate.ok && gate.notes).toEqual([
      'role "review gate" is read-only globally',
      "skipped inherit-parent (codex:gpt-6.1-sol@high): that model is already in this panel",
    ]);
    const copies = plan(text, "copies", { parent: "grok:grok-4.7@high" });
    expect(copies.ok && [copies.kind, copies.access]).toEqual(["single", "read"]);
    const writer = plan(text, "copies", {
      parent: "grok:grok-4.7@high",
      policy: { version: 1, writerRoles: ["copies"] },
    });
    expect(!writer.ok && writer.code).toBe("panel-writer-conflict");
  });

  it("prints each plan note once", () => {
    const result = plan("review gate: codex:gpt-6.1-sol@high", "review gate");
    if (!result.ok) throw new Error(result.error);
    const out = formatPlan(result, "footer");
    expect(out.match(/read-only globally/g)).toHaveLength(1);
  });

  it("checks pins and allowed providers against every resolved lane, before dedupe", () => {
    const text = "reviewers: inherit-parent, codex:gpt-6.1-sol@high\n";
    const pinned = plan(text, "reviewers", {
      parent: "codex:gpt-6.1-sol@high",
      policy: {
        version: 1,
        pins: { reviewers: ["codex:gpt-6.1-sol@high", "codex:gpt-6.1-sol@high"] },
      },
    });
    expect(pinned.ok && pinned.lanes.length).toBe(1);
    const blocked = plan(text, "reviewers", {
      parent: "codex:gpt-6.1-sol@high",
      policy: { version: 1, allowedProviders: ["claude"] },
    });
    expect(!blocked.ok && blocked.code).toBe("provider-not-allowed");
  });

  it("marks a collapsed panel as defined as a panel", () => {
    const result = plan("coordinator: inherit-parent, codex:gpt-6.1-sol@high\n", "coordinator", {
      parent: "codex:gpt-6.1-sol@high",
    });
    expect(result.ok && [result.kind, result.definedAsPanel, result.access]).toEqual([
      "single",
      true,
      "read",
    ]);
  });
});
