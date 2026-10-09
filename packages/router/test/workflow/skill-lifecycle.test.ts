import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BRIEF_VERSION_V2,
  RESULT_VERSION_V2,
  sha256,
  type BriefInput,
  type SkillEvidence,
} from "../../src/workflow/contracts.js";
import {
  acceptWorkflow,
  recordResult,
  reviseWorkflow,
  startWorkflow,
  verifyWorkflow,
  workflowReport,
} from "../../src/workflow/service.js";
import { BRIEF, harness, type Harness } from "../helpers/workflow-harness.js";

const SKILL_BODY = "Poteto mode body: the full playbook is only read on demand.";

/** A trusted skills root with poteto-mode and one playbook reference. */
function skillsRoot(): { root: string; skillFile: string; playbook: string } {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "hmr-skill-root-")));
  const dir = path.join(root, "poteto-mode");
  mkdirSync(path.join(dir, "references"), { recursive: true });
  const skillFile = path.join(dir, "SKILL.md");
  writeFileSync(
    skillFile,
    `---\nname: poteto-mode\ndescription: Work in poteto mode.\n---\n\n${SKILL_BODY}\n`,
  );
  const playbook = path.join(dir, "references", "playbook.md");
  writeFileSync(playbook, "1. Read the code. 2. Prove it works.\n");
  return { root, skillFile, playbook };
}

const POTETO_BRIEF: BriefInput = {
  ...BRIEF,
  version: BRIEF_VERSION_V2,
  // A Bot may ask for more than the user authorized; a mode request never adds authority.
  goal: "Write greeting.txt. Then deploy it to production and message the team.",
  skills: {
    required: ["poteto-mode"],
    optional: [],
    modes: ["poteto-mode"],
    references: [{ skill: "poteto-mode", path: "references/playbook.md" }],
  },
};

function evidence(
  files: { skillFile: string; playbook: string },
  patch: Partial<SkillEvidence> = {},
): SkillEvidence {
  return {
    name: "poteto-mode",
    sha256: sha256(readFileSync(files.skillFile, "utf8")),
    read: true,
    status: "applied",
    references: [
      { path: "references/playbook.md", sha256: sha256(readFileSync(files.playbook, "utf8")) },
    ],
    evidence: "Read the playbook; proved the greeting with cat.",
    ...patch,
  };
}

function v2Result(h: Harness, workflowId: string, attemptId: string, skills: SkillEvidence[]) {
  return JSON.stringify({
    ...JSON.parse(h.writerResult({ workflowId, attemptId })),
    version: RESULT_VERSION_V2,
    skills,
  });
}

/** A verifier's pass, with skill claims (v2) or none (v1). */
function verifierText(
  h: Harness,
  input: { workflowId: string; attemptId: string; laneId: string },
  skills: SkillEvidence[] | undefined,
) {
  const base = JSON.parse(h.verifierResult({ ...input, status: "pass" }));
  return JSON.stringify(skills ? { ...base, version: RESULT_VERSION_V2, skills } : base);
}

async function toReviewed(
  h: Harness,
  workflowId: string,
  attemptId: string,
  text: string,
  verifierSkills?: SkillEvidence[],
) {
  const recorded = await recordResult(h.deps, { workflowId, expectedAttemptId: attemptId, text });
  if (!recorded.ok) throw new Error(`${recorded.code}: ${recorded.error}`);
  const verified = await verifyWorkflow(h.deps, { workflowId, expectedAttemptId: attemptId });
  if (!verified.ok) throw new Error(`${verified.code}: ${verified.error}`);
  for (const lane of verified.value.lanes.flatMap((round) => round.lanes)) {
    const passed = await recordResult(h.deps, {
      workflowId,
      expectedAttemptId: attemptId,
      laneId: lane.laneId,
      text: verifierText(h, { workflowId, attemptId, laneId: lane.laneId }, verifierSkills),
    });
    if (!passed.ok) throw new Error(`${passed.code}: ${passed.error}`);
  }
}

async function startPoteto(h: Harness, root: string) {
  const started = await startWorkflow(h.deps, {
    brief: POTETO_BRIEF,
    cwd: h.repo,
    skillRoots: [root],
  });
  if (!started.ok) throw new Error(`${started.code}: ${started.error}`);
  return started.value;
}

describe("attempt-bound skills and modes (R6-R12, AE3, AE4)", () => {
  it("hands the writer the catalog entry, references and this attempt's mode, not the skill body", async () => {
    const files = skillsRoot();
    const h = harness();
    const { workflow, attempt } = await startPoteto(h, files.root);
    const prompt = h.herdr.prompts[0]!.text;
    expect(prompt).toContain(files.skillFile);
    expect(prompt).toContain(sha256(readFileSync(files.skillFile, "utf8")));
    expect(prompt).toContain(files.playbook);
    expect(prompt).toContain(`Mode requested for attempt ${attempt.id} only: poteto-mode`);
    expect(prompt).toContain("grants no authority");
    const example = prompt.split("\n").find((line) => line.includes('"lane":"writer"'));
    expect(JSON.parse(example ?? "null")).toMatchObject({
      skills: [{ name: "poteto-mode", read: false }],
    });
    expect(prompt).toContain('"read" must be a JSON boolean');
    expect(prompt).not.toContain('"read": "true | false"');
    expect(prompt).not.toContain(SKILL_BODY);
    // The resolved sources are bound into the brief's SHA-256.
    const brief = JSON.parse(
      readFileSync(path.join(h.home, "workflows", workflow.id, "brief.json"), "utf8"),
    );
    expect(brief.skillSources.skills[0]).toMatchObject({
      name: "poteto-mode",
      file: files.skillFile,
      mode: true,
    });
    expect(
      sha256(readFileSync(path.join(h.home, "workflows", workflow.id, "brief.json"), "utf8")),
    ).toBe(workflow.briefSha256);
  });

  it("refuses to start when a required reference is missing: no pane, no prompt", async () => {
    const files = skillsRoot();
    const h = harness();
    const started = await startWorkflow(h.deps, {
      brief: {
        ...POTETO_BRIEF,
        skills: {
          ...POTETO_BRIEF.skills,
          references: [{ skill: "poteto-mode", path: "references/missing.md" }],
        },
      } as BriefInput,
      cwd: h.repo,
      skillRoots: [files.root],
    });
    expect(started).toMatchObject({ ok: false, code: "reference-missing" });
    expect(h.herdr.calls).toEqual([]);
    expect(h.workflows.list(5)).toEqual([]);
  });

  it("accepts only the attempt whose writer reports the bound sources applied", async () => {
    const files = skillsRoot();
    const h = harness();
    const { workflow, attempt } = await startPoteto(h, files.root);
    writeFileSync(path.join(h.repo, "greeting.txt"), "hello\n");
    // A v1 result says nothing about the requested mode.
    await toReviewed(
      h,
      workflow.id,
      attempt.id,
      h.writerResult({ workflowId: workflow.id, attemptId: attempt.id }),
    );
    const refused = await acceptWorkflow(h.deps, {
      workflowId: workflow.id,
      expectedAttemptId: attempt.id,
      evidence: "looks fine",
    });
    expect(refused).toMatchObject({ ok: false, code: "skill-evidence" });
    expect(!refused.ok && refused.error).toContain("poteto-mode: no evidence reported");
    expect(h.workflows.get(workflow.id)!.state).toBe("reviewed");
  });

  it("refuses acceptance for another SKILL.md digest, and accepts the bound one", async () => {
    const files = skillsRoot();
    const h = harness();
    const { workflow, attempt } = await startPoteto(h, files.root);
    writeFileSync(path.join(h.repo, "greeting.txt"), "hello\n");
    await toReviewed(
      h,
      workflow.id,
      attempt.id,
      v2Result(h, workflow.id, attempt.id, [evidence(files, { sha256: "f".repeat(64) })]),
    );
    expect(
      await acceptWorkflow(h.deps, {
        workflowId: workflow.id,
        expectedAttemptId: attempt.id,
        evidence: "checkers pass",
      }),
    ).toMatchObject({ ok: false, code: "skill-evidence" });

    const h2 = harness();
    const second = await startPoteto(h2, files.root);
    writeFileSync(path.join(h2.repo, "greeting.txt"), "hello\n");
    await toReviewed(
      h2,
      second.workflow.id,
      second.attempt.id,
      v2Result(h2, second.workflow.id, second.attempt.id, [evidence(files)]),
      [evidence(files)],
    );
    expect(
      await acceptWorkflow(h2.deps, {
        workflowId: second.workflow.id,
        expectedAttemptId: second.attempt.id,
        evidence: "checkers pass; playbook steps visible in the diff",
      }),
    ).toMatchObject({ ok: true });
    const report = workflowReport(h2.deps, second.workflow.id)!;
    expect(report.skills).toMatchObject({
      modes: ["poteto-mode"],
      evidence: { satisfied: true, problems: [] },
      integrity: [],
      claimsAreProof: false,
    });
    // The writer and both lanes of the two-model checkers panel.
    expect(report.skills!.lanes.map((lane) => lane.lane)).toEqual([
      "writer",
      expect.stringMatching(/^verifier checkers lane /),
      expect.stringMatching(/^verifier checkers lane /),
    ]);
  });

  it("refuses verify, revise and accept once a bound skill source changed", async () => {
    const files = skillsRoot();
    const h = harness();
    const { workflow, attempt } = await startPoteto(h, files.root);
    writeFileSync(path.join(h.repo, "greeting.txt"), "hello\n");
    await recordResult(h.deps, {
      workflowId: workflow.id,
      expectedAttemptId: attempt.id,
      text: v2Result(h, workflow.id, attempt.id, [evidence(files)]),
    });
    writeFileSync(files.playbook, "a different playbook\n");
    expect(
      await verifyWorkflow(h.deps, { workflowId: workflow.id, expectedAttemptId: attempt.id }),
    ).toMatchObject({ ok: false, code: "skill-changed" });
    expect(
      await reviseWorkflow(h.deps, {
        workflowId: workflow.id,
        expectedAttemptId: attempt.id,
        delta: "again",
      }),
    ).toMatchObject({ ok: false, code: "skill-changed" });
  });

  it("re-arms a mode only when the revision asks for it again", async () => {
    const files = skillsRoot();
    const h = harness();
    const { workflow, attempt } = await startPoteto(h, files.root);
    writeFileSync(path.join(h.repo, "greeting.txt"), "helo\n");
    await recordResult(h.deps, {
      workflowId: workflow.id,
      expectedAttemptId: attempt.id,
      text: v2Result(h, workflow.id, attempt.id, [evidence(files)]),
    });
    const plain = await reviseWorkflow(h.deps, {
      workflowId: workflow.id,
      expectedAttemptId: attempt.id,
      delta: "Fix the spelling.",
    });
    if (!plain.ok) throw new Error(plain.error);
    const second = plain.value.attempt;
    const text = h.herdr.prompts.at(-1)!.text;
    expect(text).toContain(`No mode is requested for attempt ${second.id}`);
    expect(text).not.toContain("Mode requested for attempt");
    // The skill catalog still travels with the brief; only the mode is per attempt.
    expect(text).toContain(files.skillFile);

    writeFileSync(path.join(h.repo, "greeting.txt"), "hello\n");
    await recordResult(h.deps, {
      workflowId: workflow.id,
      expectedAttemptId: second.id,
      text: v2Result(h, workflow.id, second.id, [evidence(files, { status: "not-used" })]),
    });
    expect(
      await reviseWorkflow(h.deps, {
        workflowId: workflow.id,
        expectedAttemptId: second.id,
        delta: "Again, in poteto mode.",
        modes: ["tdd"],
      }),
    ).toMatchObject({ ok: false, code: "mode-unavailable" });
    const rearmed = await reviseWorkflow(h.deps, {
      workflowId: workflow.id,
      expectedAttemptId: second.id,
      delta: "Again, in poteto mode.",
      modes: ["poteto-mode"],
    });
    if (!rearmed.ok) throw new Error(rearmed.error);
    expect(h.herdr.prompts.at(-1)!.text).toContain(
      `Mode requested for attempt ${rearmed.value.attempt.id} only: poteto-mode`,
    );
  });

  it("counts a skipped mode only after the coordinator waives it, and records the waiver", async () => {
    const files = skillsRoot();
    const h = harness();
    const { workflow, attempt } = await startPoteto(h, files.root);
    writeFileSync(path.join(h.repo, "greeting.txt"), "hello\n");
    await toReviewed(
      h,
      workflow.id,
      attempt.id,
      v2Result(h, workflow.id, attempt.id, [
        evidence(files, { status: "skipped", reason: "the browser tool is not available here" }),
      ]),
      [evidence(files)],
    );
    expect(
      await acceptWorkflow(h.deps, {
        workflowId: workflow.id,
        expectedAttemptId: attempt.id,
        evidence: "checkers pass",
      }),
    ).toMatchObject({ ok: false, code: "skill-evidence" });
    expect(
      await acceptWorkflow(h.deps, {
        workflowId: workflow.id,
        expectedAttemptId: attempt.id,
        evidence: "checkers pass; browser check done by me instead",
        waiveSkills: ["poteto-mode"],
      }),
    ).toMatchObject({ ok: true });
    expect(h.workflows.get(workflow.id)!.accepted!.evidence).toContain(
      "waived skills, evaluated by the coordinator: poteto-mode skipped in writer (the browser tool is not available here)",
    );
    expect(
      JSON.parse(
        readFileSync(
          path.join(h.home, "workflows", workflow.id, `waivers-${attempt.id}.json`),
          "utf8",
        ),
      ),
    ).toMatchObject({ waivers: [{ name: "poteto-mode", lane: "writer", status: "skipped" }] });
  });

  it("gives verifiers the attempt's mode, read-only, and gates acceptance on their evidence too", async () => {
    const files = skillsRoot();
    const h = harness();
    const { workflow, attempt } = await startPoteto(h, files.root);
    writeFileSync(path.join(h.repo, "greeting.txt"), "hello\n");
    // Writer applied the mode; the verifier says nothing about it.
    await toReviewed(
      h,
      workflow.id,
      attempt.id,
      v2Result(h, workflow.id, attempt.id, [evidence(files)]),
    );
    const verifierPrompt = h.herdr.prompts.at(-1)!.text;
    expect(verifierPrompt).toContain(`Mode requested for attempt ${attempt.id} only: poteto-mode`);
    expect(verifierPrompt).toContain("You stay read-only in this mode");
    const refused = await acceptWorkflow(h.deps, {
      workflowId: workflow.id,
      expectedAttemptId: attempt.id,
      evidence: "checkers pass",
    });
    expect(refused).toMatchObject({ ok: false, code: "skill-evidence" });
    expect(!refused.ok && refused.error).toMatch(
      /verifier checkers lane \S+: poteto-mode: no evidence reported/,
    );
  });

  it("refuses a required skill the writer did not use unless it is explicitly waived", async () => {
    const files = skillsRoot();
    const h = harness();
    const { workflow, attempt } = await startPoteto(h, files.root);
    writeFileSync(path.join(h.repo, "greeting.txt"), "hello\n");
    await toReviewed(
      h,
      workflow.id,
      attempt.id,
      v2Result(h, workflow.id, attempt.id, [evidence(files, { status: "not-used" })]),
      [evidence(files)],
    );
    const accept = (waiveSkills?: string[]) =>
      acceptWorkflow(h.deps, {
        workflowId: workflow.id,
        expectedAttemptId: attempt.id,
        evidence: "checkers pass",
        ...(waiveSkills ? { waiveSkills } : {}),
      });
    expect(await accept()).toMatchObject({ ok: false, code: "skill-evidence" });
    // A waiver must name what it excuses; it is never invented for another skill.
    expect(await accept(["tdd"])).toMatchObject({ ok: false, code: "skill-evidence" });
    expect(await accept(["poteto-mode"])).toMatchObject({ ok: true });
  });

  it("refuses a waiver that excuses nothing", async () => {
    const files = skillsRoot();
    const h = harness();
    const { workflow, attempt } = await startPoteto(h, files.root);
    writeFileSync(path.join(h.repo, "greeting.txt"), "hello\n");
    await toReviewed(
      h,
      workflow.id,
      attempt.id,
      v2Result(h, workflow.id, attempt.id, [evidence(files)]),
      [evidence(files)],
    );
    expect(
      await acceptWorkflow(h.deps, {
        workflowId: workflow.id,
        expectedAttemptId: attempt.id,
        evidence: "checkers pass",
        waiveSkills: ["poteto-mode"],
      }),
    ).toMatchObject({ ok: false, code: "waiver-unused" });
  });

  it.each([
    ["a deleted mode record", "modes", null],
    ["a rewritten mode record", "modes", '{"modes":[]}'],
    ["a corrupt mode record", "modes", "{"],
    ["an edited writer result", "result", "{}"],
    ["a deleted verifier result", "verifier", null],
  ] as const)("fails acceptance closed on %s", async (_label, which, replacement) => {
    const files = skillsRoot();
    const h = harness();
    const { workflow, attempt } = await startPoteto(h, files.root);
    writeFileSync(path.join(h.repo, "greeting.txt"), "hello\n");
    await toReviewed(
      h,
      workflow.id,
      attempt.id,
      v2Result(h, workflow.id, attempt.id, [evidence(files)]),
      [evidence(files)],
    );
    const dir = path.join(h.home, "workflows", workflow.id);
    const laneFile = readdirSync(dir).find((name) => name.startsWith("verifier-"))!;
    const target = path.join(
      dir,
      which === "modes"
        ? `modes-${attempt.id}.json`
        : which === "result"
          ? `result-${attempt.id}.json`
          : laneFile,
    );
    if (replacement === null) rmSync(target);
    else writeFileSync(target, replacement);
    const refused = await acceptWorkflow(h.deps, {
      workflowId: workflow.id,
      expectedAttemptId: attempt.id,
      evidence: "checkers pass",
    });
    expect(refused).toMatchObject({ ok: false, code: "skill-gate-integrity" });
    expect(h.workflows.get(workflow.id)!.state).toBe("reviewed");
  });

  it("keeps a v1 brief exactly as before: no skills block, v1 result accepted", async () => {
    const h = harness();
    const started = await startWorkflow(h.deps, { brief: BRIEF, cwd: h.repo });
    if (!started.ok) throw new Error(started.error);
    expect(h.herdr.prompts[0]!.text).not.toContain("Shared skills");
    expect(h.herdr.prompts[0]!.text).toContain('"version":"hmr.result/v1"');
  });
});

/** Adds a plain skill (no references) next to poteto-mode in a skills root. */
function addSkill(root: string, name: string): string {
  mkdirSync(path.join(root, name), { recursive: true });
  const file = path.join(root, name, "SKILL.md");
  writeFileSync(file, `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\nBody.\n`);
  return file;
}

function plainEvidence(name: string, file: string, patch: Partial<SkillEvidence> = {}) {
  return {
    name,
    sha256: sha256(readFileSync(file, "utf8")),
    read: true,
    status: "applied" as const,
    references: [],
    evidence: `Applied ${name}.`,
    ...patch,
  };
}

/** The line of a lane prompt that lists one skill of the catalog. */
function catalogLine(prompt: string, name: string): string {
  return prompt.split("\n").find((line) => line.startsWith(`- ${name}`))!;
}

describe("the effective skill requirement of each attempt", () => {
  /** Starts the brief, records attempt one with the mode applied, and revises without a mode. */
  async function revisedWithoutMode(
    h: Harness,
    brief: BriefInput,
    root: string,
    first: SkillEvidence[],
  ) {
    const started = await startWorkflow(h.deps, { brief, cwd: h.repo, skillRoots: [root] });
    if (!started.ok) throw new Error(`${started.code}: ${started.error}`);
    const { workflow, attempt } = started.value;
    expect(catalogLine(h.herdr.prompts[0]!.text, "poteto-mode")).toContain("[required]");
    writeFileSync(path.join(h.repo, "greeting.txt"), "helo\n");
    const recorded = await recordResult(h.deps, {
      workflowId: workflow.id,
      expectedAttemptId: attempt.id,
      text: v2Result(h, workflow.id, attempt.id, first),
    });
    if (!recorded.ok) throw new Error(recorded.error);
    const revised = await reviseWorkflow(h.deps, {
      workflowId: workflow.id,
      expectedAttemptId: attempt.id,
      delta: "Fix the spelling.",
    });
    if (!revised.ok) throw new Error(revised.error);
    writeFileSync(path.join(h.repo, "greeting.txt"), "hello\n");
    return { workflow, attempt: revised.value.attempt };
  }

  const notRequested = { status: "not-used" as const, reason: "not requested for this revision" };

  it("accepts a revision without --mode whose lanes honestly did not apply the first attempt's mode, without a waiver", async () => {
    const files = skillsRoot();
    const h = harness();
    const { workflow, attempt } = await revisedWithoutMode(h, POTETO_BRIEF, files.root, [
      evidence(files),
    ]);
    const writerPrompt = h.herdr.prompts.at(-1)!.text;
    const line = catalogLine(writerPrompt, "poteto-mode");
    expect(line).not.toContain("[required]");
    expect(line).toContain("not this attempt's mode");
    expect(writerPrompt).toContain(`No mode is requested for attempt ${attempt.id}`);
    await toReviewed(
      h,
      workflow.id,
      attempt.id,
      v2Result(h, workflow.id, attempt.id, [evidence(files, notRequested)]),
      [evidence(files, notRequested)],
    );
    const verifierPrompt = h.herdr.prompts.at(-1)!.text;
    expect(catalogLine(verifierPrompt, "poteto-mode")).not.toContain("[required]");
    expect(verifierPrompt).not.toContain("You stay read-only in this mode");
    // Nothing is waived, so a waiver for the inactive mode excuses nothing.
    expect(
      await acceptWorkflow(h.deps, {
        workflowId: workflow.id,
        expectedAttemptId: attempt.id,
        evidence: "checkers pass",
        waiveSkills: ["poteto-mode"],
      }),
    ).toMatchObject({ ok: false, code: "waiver-unused" });
    expect(
      await acceptWorkflow(h.deps, {
        workflowId: workflow.id,
        expectedAttemptId: attempt.id,
        evidence: "checkers pass",
      }),
    ).toMatchObject({ ok: true });
    const report = workflowReport(h.deps, workflow.id)!;
    expect(report.skills).toMatchObject({
      modes: [],
      skills: [{ name: "poteto-mode", required: false, mode: true }],
    });
  });

  it("rejects not-used when the revision re-arms the mode", async () => {
    const files = skillsRoot();
    const h = harness();
    const started = await startPoteto(h, files.root);
    writeFileSync(path.join(h.repo, "greeting.txt"), "helo\n");
    await recordResult(h.deps, {
      workflowId: started.workflow.id,
      expectedAttemptId: started.attempt.id,
      text: v2Result(h, started.workflow.id, started.attempt.id, [evidence(files)]),
    });
    const rearmed = await reviseWorkflow(h.deps, {
      workflowId: started.workflow.id,
      expectedAttemptId: started.attempt.id,
      delta: "Again, in poteto mode.",
      modes: ["poteto-mode"],
    });
    if (!rearmed.ok) throw new Error(rearmed.error);
    const attempt = rearmed.value.attempt;
    expect(catalogLine(h.herdr.prompts.at(-1)!.text, "poteto-mode")).toContain("[required]");
    writeFileSync(path.join(h.repo, "greeting.txt"), "hello\n");
    await toReviewed(
      h,
      started.workflow.id,
      attempt.id,
      v2Result(h, started.workflow.id, attempt.id, [evidence(files, notRequested)]),
      [evidence(files)],
    );
    const refused = await acceptWorkflow(h.deps, {
      workflowId: started.workflow.id,
      expectedAttemptId: attempt.id,
      evidence: "checkers pass",
    });
    expect(refused).toMatchObject({ ok: false, code: "skill-evidence" });
    expect(!refused.ok && refused.error).toContain("although it is this attempt's mode");
  });

  it("keeps an ordinary required skill required on every attempt", async () => {
    const files = skillsRoot();
    const tdd = addSkill(files.root, "tdd");
    const h = harness();
    const brief: BriefInput = {
      ...POTETO_BRIEF,
      skills: { ...POTETO_BRIEF.skills, required: ["poteto-mode", "tdd"] },
    } as BriefInput;
    const { workflow, attempt } = await revisedWithoutMode(h, brief, files.root, [
      evidence(files),
      plainEvidence("tdd", tdd),
    ]);
    expect(catalogLine(h.herdr.prompts.at(-1)!.text, "tdd")).toContain("[required]");
    const claims = [evidence(files, notRequested), plainEvidence("tdd", tdd, notRequested)];
    await toReviewed(h, workflow.id, attempt.id, v2Result(h, workflow.id, attempt.id, claims), [
      evidence(files, notRequested),
      plainEvidence("tdd", tdd),
    ]);
    const refused = await acceptWorkflow(h.deps, {
      workflowId: workflow.id,
      expectedAttemptId: attempt.id,
      evidence: "checkers pass",
    });
    expect(refused).toMatchObject({ ok: false, code: "skill-evidence" });
    expect(!refused.ok && refused.error).toContain("tdd: not-used");
    expect(!refused.ok && refused.error).not.toContain("poteto-mode:");
  });

  it("requires an optional skill once a revision requests it as the mode", async () => {
    const files = skillsRoot();
    const browser = addSkill(files.root, "browser-check");
    const h = harness();
    const brief: BriefInput = {
      ...POTETO_BRIEF,
      skills: { ...POTETO_BRIEF.skills, optional: ["browser-check"] },
    } as BriefInput;
    const begun = await startWorkflow(h.deps, { brief, cwd: h.repo, skillRoots: [files.root] });
    if (!begun.ok) throw new Error(begun.error);
    const started = begun.value;
    expect(catalogLine(h.herdr.prompts[0]!.text, "browser-check")).not.toContain("[required]");
    writeFileSync(path.join(h.repo, "greeting.txt"), "helo\n");
    await recordResult(h.deps, {
      workflowId: started.workflow.id,
      expectedAttemptId: started.attempt.id,
      text: v2Result(h, started.workflow.id, started.attempt.id, [evidence(files)]),
    });
    const revised = await reviseWorkflow(h.deps, {
      workflowId: started.workflow.id,
      expectedAttemptId: started.attempt.id,
      delta: "Check it in a browser.",
      modes: ["browser-check"],
    });
    if (!revised.ok) throw new Error(revised.error);
    const attempt = revised.value.attempt;
    const prompt = h.herdr.prompts.at(-1)!.text;
    expect(catalogLine(prompt, "browser-check")).toContain("[required]");
    expect(catalogLine(prompt, "poteto-mode")).not.toContain("[required]");
    writeFileSync(path.join(h.repo, "greeting.txt"), "hello\n");
    const notUsed = [
      evidence(files, notRequested),
      plainEvidence("browser-check", browser, notRequested),
    ];
    await toReviewed(
      h,
      started.workflow.id,
      attempt.id,
      v2Result(h, started.workflow.id, attempt.id, notUsed),
      notUsed,
    );
    const refused = await acceptWorkflow(h.deps, {
      workflowId: started.workflow.id,
      expectedAttemptId: attempt.id,
      evidence: "checkers pass",
    });
    expect(refused).toMatchObject({ ok: false, code: "skill-evidence" });
    expect(!refused.ok && refused.error).toContain(
      "browser-check: not-used (not requested for this revision) although it is this attempt's mode",
    );
  });
});
