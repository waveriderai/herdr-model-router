import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * The versioned boundary between a coordinator and its workers. A brief is what the writer
 * is asked to do; a result is what one lane reports back. Both are parsed strictly: an
 * unknown field, a wrong version, or a missing identity is refused, never repaired.
 */
export const BRIEF_VERSION = "hmr.brief/v1";
export const RESULT_VERSION = "hmr.result/v1";
/** v2 adds an explicit shared-skill request (brief) and per-lane skill evidence (result). */
export const BRIEF_VERSION_V2 = "hmr.brief/v2";
export const RESULT_VERSION_V2 = "hmr.result/v2";

const NonEmpty = z.string().trim().min(1);
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, "expected a lowercase SHA-256 hex digest");
const GitHead = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, "expected a full commit id");
/** A role name as written in the rules file; the rules file decides whether it exists. */
const RoleName = NonEmpty.max(100);
const RelativePath = NonEmpty.refine(
  (value) => !value.startsWith("/") && !value.split(/[\\/]/).includes(".."),
  "paths are relative to the worktree and never contain ..",
);

export const RevisionSchema = z.strictObject({
  head: GitHead,
  content: Sha256,
});
export type Revision = z.infer<typeof RevisionSchema>;

/** An Agent Skills name: lowercase words joined by single hyphens. */
export const SkillNameSchema = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "expected a skill name like poteto-mode")
  .max(64);
/** A reference inside a skill, relative to its directory; `..` may reach a sibling skill. */
const SkillReferencePath = NonEmpty.max(300).refine(
  (value) => !value.startsWith("/") && !value.includes("\0"),
  "skill references are relative to the skill directory",
);

/**
 * What a brief asks of the shared skills for its first attempt. Names only: where skills live
 * is the operator's trusted `--skills-root`, never a path from the brief. A mode applies to one
 * attempt; it is never a standing hook, and it grants no authority of its own.
 */
export const SkillRequestSchema = z
  .strictObject({
    required: z.array(SkillNameSchema).default([]),
    optional: z.array(SkillNameSchema).default([]),
    modes: z.array(SkillNameSchema).default([]),
    references: z
      .array(z.strictObject({ skill: SkillNameSchema, path: SkillReferencePath }))
      .default([]),
  })
  .refine((request) => request.modes.every((mode) => request.required.includes(mode)), {
    message: "every mode must also be a required skill",
  })
  .refine((request) => !request.optional.some((name) => request.required.includes(name)), {
    message: "a skill cannot be both required and optional",
  })
  .refine(
    (request) =>
      request.references.every(
        (ref) => request.required.includes(ref.skill) || request.optional.includes(ref.skill),
      ),
    { message: "a reference must belong to a requested skill" },
  )
  // A name or reference listed twice is the same request: it is resolved and prompted once.
  .transform((request) => ({
    required: [...new Set(request.required)],
    optional: [...new Set(request.optional)],
    modes: [...new Set(request.modes)],
    references: request.references.filter(
      (ref, index, all) =>
        all.findIndex((other) => other.skill === ref.skill && other.path === ref.path) === index,
    ),
  }));
export type SkillRequest = z.infer<typeof SkillRequestSchema>;

const briefFields = {
  title: NonEmpty.max(200),
  goal: NonEmpty.max(4000),
  scope: z.strictObject({
    allowed: z.array(RelativePath).min(1),
    excluded: z.array(RelativePath).default([]),
  }),
  writerRole: RoleName,
  verifierRoles: z.array(RoleName).min(1),
  acceptance: z.array(NonEmpty).min(1),
  constraints: z.array(NonEmpty).default([]),
  /**
   * `bounded-small-fix` only when the coordinator explicitly classifies the brief as one; it
   * selects a backend's small-fix model policy. Anything else is ordinary implementation.
   */
  classification: z.enum(["implementation", "bounded-small-fix"]).default("implementation"),
};

const BriefInputV1 = z.strictObject({ version: z.literal(BRIEF_VERSION), ...briefFields });
const BriefInputV2 = z.strictObject({
  version: z.literal(BRIEF_VERSION_V2),
  ...briefFields,
  skills: SkillRequestSchema,
});

/** What the coordinator writes. The router adds identity and baseline when it starts a workflow. */
export const BriefInputSchema = z.discriminatedUnion("version", [BriefInputV1, BriefInputV2]);
export type BriefInput = z.infer<typeof BriefInputSchema>;

const ResolvedReference = z.strictObject({ path: NonEmpty, file: NonEmpty, sha256: Sha256 });
/** The skill sources resolved when the workflow started; bound into the brief's SHA-256. */
export const ResolvedSkillsSchema = z.strictObject({
  roots: z.array(NonEmpty),
  unavailable: z.array(SkillNameSchema),
  skills: z.array(
    z.strictObject({
      name: SkillNameSchema,
      description: NonEmpty,
      file: NonEmpty,
      sha256: Sha256,
      required: z.boolean(),
      mode: z.boolean(),
      references: z.array(ResolvedReference),
    }),
  ),
});
export type ResolvedSkills = z.infer<typeof ResolvedSkillsSchema>;

const recordFields = {
  workflowId: NonEmpty,
  baseline: RevisionSchema,
  writerDescriptor: NonEmpty,
  /** The parent descriptor that resolved `parent`, `auto` and `inherit-parent` lanes. */
  parent: NonEmpty.optional(),
};

/** The immutable brief as recorded for one workflow. Its SHA-256 is the brief identity. */
export const BriefRecordSchema = z.discriminatedUnion("version", [
  BriefInputV1.extend(recordFields),
  BriefInputV2.extend({ ...recordFields, skillSources: ResolvedSkillsSchema }),
]);
export type BriefRecord = z.infer<typeof BriefRecordSchema>;

const Check = z.strictObject({
  command: NonEmpty,
  result: z.enum(["pass", "fail", "not-run"]),
  summary: z.string().max(2000).optional(),
});

/** One lane's claim about one listed skill. A claim, not proof: the coordinator decides. */
export const SkillEvidenceSchema = z.strictObject({
  name: SkillNameSchema,
  /** SHA-256 of the SKILL.md the lane read. */
  sha256: Sha256,
  read: z.boolean(),
  status: z.enum(["applied", "not-used", "skipped", "blocked"]),
  references: z.array(z.strictObject({ path: NonEmpty, sha256: Sha256 })).default([]),
  evidence: z.string().max(4000).optional(),
  /** Why a skill was skipped or blocked (missing tool, missing reference, ...). */
  reason: z.string().max(2000).optional(),
});
export type SkillEvidence = z.infer<typeof SkillEvidenceSchema>;

const ResultBase = {
  workflowId: NonEmpty,
  attemptId: NonEmpty,
  revision: RevisionSchema,
  changedPaths: z.array(RelativePath),
  checks: z.array(Check),
  blockers: z.array(NonEmpty),
  notes: z.string().max(8000).optional(),
};
const v1 = { version: z.literal(RESULT_VERSION) };
const v2 = { version: z.literal(RESULT_VERSION_V2), skills: z.array(SkillEvidenceSchema) };
const writerLane = {
  lane: z.literal("writer"),
  status: z.enum(["impl-complete", "blocked", "failed"]),
};
const verifierLane = {
  lane: z.literal("verifier"),
  verifierLaneId: NonEmpty,
  status: z.enum(["pass", "fail", "blocked"]),
};

/** A lane's report. The writer and each verifier lane report different outcomes. */
export const ResultSchema = z.discriminatedUnion("lane", [
  z.discriminatedUnion("version", [
    z.strictObject({ ...v1, ...ResultBase, ...writerLane }),
    z.strictObject({ ...v2, ...ResultBase, ...writerLane }),
  ]),
  z.discriminatedUnion("version", [
    z.strictObject({ ...v1, ...ResultBase, ...verifierLane }),
    z.strictObject({ ...v2, ...ResultBase, ...verifierLane }),
  ]),
]);
export type WorkflowResult = z.infer<typeof ResultSchema>;
export type WriterResult = Extract<WorkflowResult, { lane: "writer" }>;
export type VerifierResult = Extract<WorkflowResult, { lane: "verifier" }>;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function describe(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
}

function parseJsonWith<T>(schema: z.ZodType<T>, text: string, what: string): Parsed<T> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `${what} is not valid JSON: ${(error as Error).message}` };
  }
  const parsed = schema.safeParse(data);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: `${what} is invalid: ${describe(parsed.error)}` };
}

export function parseBriefInput(text: string): Parsed<BriefInput> {
  return parseJsonWith(BriefInputSchema, text, "brief");
}

export function parseBriefRecord(text: string): Parsed<BriefRecord> {
  return parseJsonWith(BriefRecordSchema, text, "brief record");
}

export function parseResult(text: string): Parsed<WorkflowResult> {
  return parseJsonWith(ResultSchema, text, "result");
}

/** JSON with keys in a fixed order, so the same value always has the same SHA-256. */
export function canonicalJson(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input)
          .filter(([, entry]) => entry !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, entry]) => [key, sort(entry)]),
      );
    }
    return input;
  };
  return JSON.stringify(sort(value));
}

/** SHA-256 of a string (as UTF-8) or of raw bytes, as `shasum -a 256` prints it. */
export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sameRevision(a: Revision, b: Revision): boolean {
  return a.head === b.head && a.content === b.content;
}
