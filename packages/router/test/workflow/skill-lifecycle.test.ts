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
