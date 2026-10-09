import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BRIEF_VERSION,
  BRIEF_VERSION_V2,
  parseBriefInput,
  parseResult,
  RESULT_VERSION_V2,
  sha256,
} from "../../src/workflow/contracts.js";
import { evaluateSkillEvidence, resolveSkills, skillCatalog } from "../../src/workflow/skills.js";

/** Writes one skill directory with a SKILL.md and optional extra files. */
function skill(
  root: string,
  name: string,
  options: { description?: string; frontName?: string; files?: Record<string, string> } = {},
): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    [
      "---",
      `name: ${options.frontName ?? name}`,
      `description: ${options.description ?? `Synthetic ${name} skill.`}`,
      "---",
      "",
      `# ${name}`,
      "Body text the catalog never discloses.",
      "",
    ].join("\n"),
  );
  for (const [file, text] of Object.entries(options.files ?? {})) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

const tmp = (prefix: string) => realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));

describe("shared skill catalog (R6, R8, R15)", () => {
  it("lists valid skills by name with canonical path and digest, without their bodies", () => {
    const root = tmp("hmr-skills-");
    skill(root, "poteto-mode");
    skill(root, "tdd");
    const catalog = skillCatalog([root]);
    expect(catalog.problems).toEqual([]);
    expect(catalog.entries.map((entry) => entry.name)).toEqual(["poteto-mode", "tdd"]);
    const poteto = catalog.entries[0]!;
    const file = path.join(root, "poteto-mode", "SKILL.md");
    expect(poteto).toMatchObject({
      name: "poteto-mode",
      description: "Synthetic poteto-mode skill.",
      file,
      sha256: sha256(readFileSync(file, "utf8")),
      root,
    });
    expect(JSON.stringify(catalog)).not.toContain("Body text");
  });

  it("follows an installed link to a skill and lets the first root win a duplicate name", () => {
    const pstack = tmp("hmr-pstack-");
    const real = skill(pstack, "poteto-mode", { description: "From pstack." });
    const first = tmp("hmr-skills-a-");
    symlinkSync(real, path.join(first, "poteto-mode"));
    const second = tmp("hmr-skills-b-");
    skill(second, "poteto-mode", { description: "Shadowed copy." });
    const catalog = skillCatalog([first, second]);
    expect(catalog.entries).toHaveLength(1);
    expect(catalog.entries[0]).toMatchObject({
      description: "From pstack.",
      file: path.join(real, "SKILL.md"),
      linked: true,
    });
    expect(catalog.shadowed).toEqual([{ name: "poteto-mode", root: second }]);
  });

  it("reports a broken link and invalid metadata instead of listing them", () => {
    const root = tmp("hmr-skills-");
    symlinkSync(path.join(root, "nowhere"), path.join(root, "gone"));
    skill(root, "misnamed", { frontName: "other-name" });
    skill(root, "Bad_Name");
    skill(root, "empty-description", { description: "" });
    const catalog = skillCatalog([root]);
    expect(catalog.entries).toEqual([]);
    expect(catalog.problems.map((problem) => [problem.name, problem.code]).sort()).toEqual([
      ["Bad_Name", "invalid-metadata"],
      ["empty-description", "invalid-metadata"],
      ["gone", "broken-link"],
      ["misnamed", "invalid-metadata"],
    ]);
  });

  it("resolves required skills and declared references, including a cataloged pstack sibling", () => {
    const pstack = tmp("hmr-pstack-");
    skill(pstack, "poteto-mode", { files: { "references/playbook.md": "playbook" } });
    skill(pstack, "principle-prove-it-works");
    const root = tmp("hmr-skills-");
    symlinkSync(path.join(pstack, "poteto-mode"), path.join(root, "poteto-mode"));
    symlinkSync(
      path.join(pstack, "principle-prove-it-works"),
      path.join(root, "principle-prove-it-works"),
    );
    const resolved = resolveSkills([root], {
      required: ["poteto-mode"],
      optional: ["tdd"],
      modes: ["poteto-mode"],
      references: [
        { skill: "poteto-mode", path: "references/playbook.md" },
        { skill: "poteto-mode", path: "../principle-prove-it-works/SKILL.md" },
      ],
    });
    if (!resolved.ok) throw new Error(resolved.error);
    expect(resolved.value.unavailable).toEqual(["tdd"]);
    const poteto = resolved.value.skills[0]!;
    expect(poteto).toMatchObject({ name: "poteto-mode", required: true, mode: true });
    expect(poteto.references).toEqual([
      {
        path: "references/playbook.md",
        file: path.join(pstack, "poteto-mode", "references/playbook.md"),
        sha256: sha256("playbook"),
      },
      {
        path: "../principle-prove-it-works/SKILL.md",
        file: path.join(pstack, "principle-prove-it-works", "SKILL.md"),
        sha256: sha256(readFileSync(path.join(pstack, "principle-prove-it-works", "SKILL.md"))),
      },
    ]);
  });

  /** A pstack checkout: skills/ plus docs/ beside it, and an unrelated repo next to pstack. */
  function pstackRepo() {
    const parent = tmp("hmr-code-");
    const repo = path.join(parent, "pstack");
    skill(path.join(repo, "skills"), "poteto-mode");
    skill(path.join(repo, "skills"), "principle-prove-it-works");
    mkdirSync(path.join(repo, "docs"), { recursive: true });
    writeFileSync(path.join(repo, "docs", "harness.md"), "harness notes");
    mkdirSync(path.join(parent, "otherrepo"));
    writeFileSync(path.join(parent, "otherrepo", ".env"), "SYNTHETIC=1");
    const root = tmp("hmr-skills-");
    symlinkSync(path.join(repo, "skills", "poteto-mode"), path.join(root, "poteto-mode"));
    return { parent, repo, root };
  }
  const ref = (refPath: string) => ({
    required: ["poteto-mode"],
    optional: [],
    modes: [],
    references: [{ skill: "poteto-mode", path: refPath }],
  });

  it("does not trust a linked skill's parent: an uncataloged sibling or repository file refuses", () => {
    const { root } = pstackRepo();
    for (const refPath of [
      "../principle-prove-it-works/SKILL.md",
      "../../docs/harness.md",
      "../../../otherrepo/.env",
    ]) {
      expect(resolveSkills([root], ref(refPath))).toMatchObject({
        ok: false,
        code: "reference-untrusted",
      });
    }
  });

  it("reaches pstack docs only when the operator names the pstack repository as a root", () => {
    const { repo, root } = pstackRepo();
    // The repository root holds no skill directly; it is named only to be trusted.
    const resolved = resolveSkills([root, repo], ref("../../docs/harness.md"));
    if (!resolved.ok) throw new Error(resolved.error);
    expect(resolved.value.skills[0]!.references[0]).toMatchObject({
      file: path.join(repo, "docs", "harness.md"),
      sha256: sha256("harness notes"),
    });
    // Still nothing outside it.
    expect(resolveSkills([root, repo], ref("../../../otherrepo/.env"))).toMatchObject({
      ok: false,
      code: "reference-untrusted",
    });
  });

  it("refuses a reference that escapes through a link, before reading it", () => {
    const { parent } = pstackRepo();
    const root = tmp("hmr-skills-");
    skill(root, "poteto-mode");
    symlinkSync(path.join(parent, "otherrepo", ".env"), path.join(root, "poteto-mode", "env.md"));
    expect(
      resolveSkills([root], {
        ...ref("env.md"),
        references: [{ skill: "poteto-mode", path: "env.md" }],
      }),
    ).toMatchObject({ ok: false, code: "reference-untrusted" });
  });

  it("reports an unreadable root as a refusal, not an exception", () => {
    const root = tmp("hmr-skills-");
    const locked = path.join(root, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
      expect(skillCatalog([locked]).missingRoots).toEqual([locked]);
      expect(resolveSkills([locked], ref("x.md"))).toMatchObject({
        ok: false,
        code: "skills-root",
      });
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it("hashes SKILL.md as raw bytes, as shasum does", () => {
    const root = tmp("hmr-skills-");
    const dir = skill(root, "poteto-mode");
    const bytes = Buffer.concat([
      readFileSync(path.join(dir, "SKILL.md")),
      Buffer.from([0xff, 0xfe]),
    ]);
    writeFileSync(path.join(dir, "SKILL.md"), bytes);
    expect(skillCatalog([root]).entries[0]!.sha256).toBe(sha256(bytes));
  });

  it.each([
    ["no root given", [], { required: ["poteto-mode"] }, "skills-root-required"],
    ["a missing root", ["/nonexistent/skills"], { required: ["poteto-mode"] }, "skills-root"],
    ["a missing required skill", "root", { required: ["poteto-mode"] }, "skill-missing"],
    ["a broken required link", "broken", { required: ["poteto-mode"] }, "skill-missing"],
    [
      "a missing reference",
      "with-skill",
      {
        required: ["poteto-mode"],
        references: [{ skill: "poteto-mode", path: "references/none.md" }],
      },
      "reference-missing",
    ],
    [
      "a reference escaping the trusted sources",
      "with-skill",
      {
        required: ["poteto-mode"],
        references: [{ skill: "poteto-mode", path: "../../../etc/hosts" }],
      },
      "reference-untrusted",
    ],
  ] as const)("refuses %s", (_label, roots, request, code) => {
    const root = tmp("hmr-skills-");
    if (roots === "broken") symlinkSync(path.join(root, "nowhere"), path.join(root, "poteto-mode"));
    if (roots === "with-skill") skill(root, "poteto-mode");
    const list = typeof roots === "string" ? [root] : [...roots];
    const resolved = resolveSkills(list, {
      required: [...request.required],
      optional: [],
      modes: [],
      references: "references" in request ? [...request.references] : [],
    });
    expect(resolved).toMatchObject({ ok: false, code });
  });
});

describe("brief and result v2 skill contracts (R7, R10)", () => {
  const brief = {
    version: BRIEF_VERSION_V2,
    title: "Add the parser",
    goal: "Parse the synthetic config format.",
    scope: { allowed: ["src/parser.ts"] },
    writerRole: "feature",
    verifierRoles: ["reviewers"],
    acceptance: ["Parser tests pass"],
    skills: { required: ["poteto-mode"], modes: ["poteto-mode"] },
  };

  it("parses a v2 brief with a skill request and keeps v1 briefs unchanged", () => {
    const parsed = parseBriefInput(JSON.stringify(brief));
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        skills: { required: ["poteto-mode"], optional: [], modes: ["poteto-mode"], references: [] },
      },
    });
    const v1 = parseBriefInput(JSON.stringify({ ...brief, version: BRIEF_VERSION }));
    expect(v1).toMatchObject({ ok: false });
    const { skills: _skills, ...plain } = brief;
    void _skills;
    expect(parseBriefInput(JSON.stringify({ ...plain, version: BRIEF_VERSION }))).toMatchObject({
      ok: true,
    });
  });

  it("dedupes repeated names and refuses a skill that is both required and optional", () => {
    expect(
      parseBriefInput(
        JSON.stringify({
          ...brief,
          skills: {
            required: ["poteto-mode", "poteto-mode"],
            modes: ["poteto-mode", "poteto-mode"],
            references: [
              { skill: "poteto-mode", path: "a.md" },
              { skill: "poteto-mode", path: "a.md" },
            ],
          },
        }),
      ),
    ).toMatchObject({
      ok: true,
      value: {
        skills: {
          required: ["poteto-mode"],
          modes: ["poteto-mode"],
          references: [{ skill: "poteto-mode", path: "a.md" }],
        },
      },
    });
    expect(
      parseBriefInput(
        JSON.stringify({ ...brief, skills: { required: ["tdd"], optional: ["tdd"] } }),
      ),
    ).toMatchObject({ ok: false });
  });

  it("refuses a mode that is not a required skill, and an unknown skill field", () => {
    expect(
      parseBriefInput(
        JSON.stringify({ ...brief, skills: { required: [], optional: ["x"], modes: ["x"] } }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      parseBriefInput(JSON.stringify({ ...brief, skills: { ...brief.skills, hook: true } })),
    ).toMatchObject({ ok: false });
  });

  it("parses a v2 result's skill evidence", () => {
    const result = {
      version: RESULT_VERSION_V2,
      workflowId: "wf_1",
      attemptId: "wfa_1",
      lane: "writer",
      status: "impl-complete",
      revision: { head: "a".repeat(40), content: "b".repeat(64) },
      changedPaths: [],
      checks: [],
      blockers: [],
      skills: [
        {
          name: "poteto-mode",
          sha256: "c".repeat(64),
          read: true,
          status: "applied",
          references: [],
          evidence: "Followed the playbook steps 1-4.",
        },
      ],
    };
    expect(parseResult(JSON.stringify(result))).toMatchObject({ ok: true });
    expect(
      parseResult(JSON.stringify({ ...result, skills: [{ ...result.skills[0], status: "done" }] })),
    ).toMatchObject({ ok: false });
  });
});

describe("skill evidence is a claim the coordinator evaluates (R8, R10)", () => {
  const snapshot = {
    roots: ["/skills"],
    unavailable: [],
    skills: [
      {
        name: "poteto-mode",
        description: "d",
        file: "/skills/poteto-mode/SKILL.md",
        sha256: "c".repeat(64),
        required: true,
        mode: true,
        references: [{ path: "references/playbook.md", file: "/x", sha256: "d".repeat(64) }],
      },
    ],
  };
  const applied = {
    name: "poteto-mode",
    sha256: "c".repeat(64),
    read: true,
    status: "applied" as const,
    references: [{ path: "references/playbook.md", sha256: "d".repeat(64) }],
    evidence: "steps followed",
  };

  it("is satisfied only by matching digests, the required references and an applied status", () => {
    expect(
      evaluateSkillEvidence({ snapshot, modes: ["poteto-mode"], skills: [applied], waived: [] }),
    ).toMatchObject({ satisfied: true, problems: [] });
  });

  it.each([
    ["no skill report at all (a v1 result)", undefined, "poteto-mode: no evidence reported"],
    ["another SKILL.md digest", [{ ...applied, sha256: "e".repeat(64) }], "digest"],
    ["a missing required reference", [{ ...applied, references: [] }], "reference"],
    ["a blocked skill", [{ ...applied, status: "blocked" as const }], "blocked"],
    ["a skipped mode", [{ ...applied, status: "skipped" as const, reason: "no tool" }], "skipped"],
    ["a skill it never read", [{ ...applied, read: false }], "not read"],
  ])("is not satisfied by %s", (_label, skills, problem) => {
    const evaluated = evaluateSkillEvidence({
      snapshot,
      modes: ["poteto-mode"],
      skills,
      waived: [],
    });
    expect(evaluated.satisfied).toBe(false);
    expect(evaluated.problems.join("; ")).toContain(problem);
  });

  it("lets the coordinator waive a skip it evaluated, and nothing else", () => {
    const skipped = { ...applied, status: "skipped" as const, reason: "browser tool unavailable" };
    expect(
      evaluateSkillEvidence({
        snapshot,
        modes: ["poteto-mode"],
        skills: [skipped],
        waived: ["poteto-mode"],
      }),
    ).toMatchObject({ satisfied: true });
    expect(
      evaluateSkillEvidence({
        snapshot,
        modes: ["poteto-mode"],
        skills: [{ ...skipped, sha256: "e".repeat(64) }],
        waived: ["poteto-mode"],
      }).satisfied,
    ).toBe(false);
  });

  it("does not demand a mode on an attempt that did not request one", () => {
    expect(
      evaluateSkillEvidence({ snapshot, modes: [], skills: [applied], waived: [] }),
    ).toMatchObject({ satisfied: true });
  });

  it("needs an explicit waiver for a required skill reported not-used, and records it", () => {
    const notUsed = { ...applied, status: "not-used" as const, reason: "nothing to apply" };
    const plain = evaluateSkillEvidence({ snapshot, modes: [], skills: [notUsed], waived: [] });
    expect(plain.satisfied).toBe(false);
    expect(plain.problems.join("; ")).toContain(
      "not-used (nothing to apply) although it is required",
    );
    expect(
      evaluateSkillEvidence({ snapshot, modes: [], skills: [notUsed], waived: ["poteto-mode"] }),
    ).toMatchObject({
      satisfied: true,
      waivedClaims: [{ name: "poteto-mode", status: "not-used", reason: "nothing to apply" }],
    });
  });
});
