import { describe, expect, it } from "vitest";
import { parseRules } from "../../src/rules/mdc-parser.js";
import { parsePolicy, type ProjectPolicy } from "../../src/rules/policy.js";
import { planRoute } from "../../src/rules/plan.js";

const RULES = [
  "feature: codex:gpt-6.1-sol@high",
  "bug-fix, hotfix: claude:claude-sonnet-5-5@high",
  "reviewers: claude:claude-opus-5-5@high, codex:gpt-6.1-sol@high",
  "review gate: codex:gpt-6.1-sol@high",
  "",
].join("\n");
const source = { path: "fixture.mdc", origin: "flag" as const };

function rules(text: string) {
  const parsed = parseRules(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.rules;
}

function plan(
  text: string,
  role: string,
  extra: { readOnly?: boolean; bypassPermissions?: boolean; policy?: ProjectPolicy } = {},
) {
  return planRoute({ rules: rules(text), rulesSource: source, cwd: "/work", role, ...extra });
}

describe("bypass-permissions directive", () => {
  it("lists opted-in roles by normalized name and is absent by default", () => {
    expect(rules(RULES).bypassRoles).toBeUndefined();
    const opted = rules(`# hmr: bypass-permissions Bug-Fix,  review   gate # why\n${RULES}`);
    expect(opted.bypassRoles).toEqual(["bug-fix", "review gate"]);
  });

  it("refuses a role that is also readonly, and an empty name", () => {
    expect(
      parseRules(`# hmr: readonly bug-fix\n# hmr: bypass-permissions bug-fix\n${RULES}`),
    ).toEqual({
      ok: false,
      error:
        'role "bug-fix" is both readonly and bypass-permissions; a permission bypass applies only to a writer',
    });
    expect(parseRules(`# hmr: bypass-permissions bug-fix,\n${RULES}`)).toEqual({
      ok: false,
      error: "line 1: empty role name in bypass-permissions directive",
    });
  });

  it("refuses a panel role", () => {
    expect(parseRules(`# hmr: bypass-permissions reviewers\n${RULES}`)).toEqual({
      ok: false,
      error:
        'line 4: panel role "reviewers" is listed in bypass-permissions; a panel is read-only, and a permission bypass applies only to a writer',
    });
  });
});

describe("planning a permission bypass", () => {
  const opted = `# hmr: bypass-permissions bug-fix\n${RULES}`;

  it("keeps the ordinary writer profile with no flag and no opt-in", () => {
    const planned = plan(RULES, "bug-fix");
    expect(planned.ok && planned.access).toBe("write");
    expect(planned).not.toHaveProperty("permissions");
    expect(planned).not.toHaveProperty("bypassFrom");
  });

  it("bypasses a writer with the per-run flag, and says it came from the flag", () => {
    expect(plan(RULES, "bug-fix", { bypassPermissions: true })).toMatchObject({
      ok: true,
      access: "write",
      permissions: "bypass",
      bypassFrom: "flag",
    });
  });

  it("bypasses an opted-in writer under any of its names without the flag", () => {
    const planned = plan(opted, "hotfix");
    expect(planned).toMatchObject({ permissions: "bypass", bypassFrom: "rules" });
    expect(planned.ok && planned.notes).toContain(
      "permission bypass opted in by the rules file (bypass-permissions): the CLI skips its approvals and sandbox",
    );
    // The flag wins the label when both ask.
    expect(plan(opted, "bug-fix", { bypassPermissions: true })).toMatchObject({
      bypassFrom: "flag",
    });
    // Only the roles listed are opted in.
    expect(plan(opted, "feature")).not.toHaveProperty("permissions");
  });

  it("refuses the flag for every read-only plan", () => {
    for (const [role, readOnly] of [
      ["reviewers", false],
      ["review gate", false],
      ["bug-fix", true],
    ] as const) {
      expect(plan(RULES, role, { readOnly, bypassPermissions: true })).toMatchObject({
        ok: false,
        code: "bypass-read-only",
      });
    }
  });

  describe("refuses a rules opt-in on a role that runs read-only", () => {
    const refusal = (because: string, role = "bug-fix") => ({
      ok: false,
      code: "bypass-read-only",
      error: `the rules file's "# hmr: bypass-permissions" line opts role "${role}" into a permission bypass, but ${because}, and a permission bypass applies only to a writer; remove the role from that line. Nothing was planned`,
    });

    it("a panel", () => {
      // The parser refuses this file; a rule set built some other way still never bypasses.
      const panel = { ...rules(RULES), bypassRoles: ["reviewers"] };
      expect(
        planRoute({ rules: panel, rulesSource: source, cwd: "/work", role: "reviewers" }),
      ).toMatchObject(refusal("it is a panel", "reviewers"));
    });

    it("a built-in read-only role", () => {
      expect(plan(`# hmr: bypass-permissions review gate\n${RULES}`, "review gate")).toMatchObject(
        refusal("it is read-only globally", "review gate"),
      );
    });

    it("a role the rules file makes read-only under another of its names", () => {
      expect(plan(`# hmr: readonly hotfix\n${opted}`, "bug-fix")).toMatchObject(
        refusal("it is read-only globally"),
      );
    });

    it("a role the project policy does not list as a writer", () => {
      expect(
        plan(opted, "bug-fix", { policy: { version: 1, writerRoles: ["feature"] } }),
      ).toMatchObject(refusal("project policy does not list it as a writer"));
    });

    it("a plan asked for read-only", () => {
      expect(plan(opted, "bug-fix", { readOnly: true })).toMatchObject(
        refusal("it was asked for read-only"),
      );
    });
  });

  it("lets a project policy forbid a bypass; the rules opt-in cannot override it", () => {
    const policy: ProjectPolicy = { version: 1, forbidBypassPermissions: true };
    expect(plan(RULES, "bug-fix", { bypassPermissions: true, policy })).toMatchObject({
      ok: false,
      code: "bypass-forbidden",
      error:
        'project policy forbids a permission bypass (forbidBypassPermissions); role "bug-fix" was not planned',
    });
    const planned = plan(opted, "bug-fix", { policy });
    expect(planned.ok && planned.access).toBe("write");
    expect(planned).not.toHaveProperty("permissions");
    expect(planned.ok && planned.notes.join("\n")).toContain("project policy forbids one");
    // `false` adds nothing.
    expect(
      plan(opted, "bug-fix", { policy: { version: 1, forbidBypassPermissions: false } }),
    ).toMatchObject({ permissions: "bypass", bypassFrom: "rules" });
  });

  it("accepts forbidBypassPermissions only as a boolean", () => {
    expect(
      parsePolicy(JSON.stringify({ version: 1, forbidBypassPermissions: true })),
    ).toMatchObject({ ok: true });
    const parsed = parsePolicy(JSON.stringify({ version: 1, forbidBypassPermissions: "yes" }));
    expect(parsed.ok ? "" : parsed.error).toMatch(/forbidBypassPermissions/);
  });
});
