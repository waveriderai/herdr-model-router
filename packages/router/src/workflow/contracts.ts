import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * The versioned boundary between a coordinator and its workers. A brief is what the writer
 * is asked to do; a result is what one lane reports back. Both are parsed strictly: an
 * unknown field, a wrong version, or a missing identity is refused, never repaired.
 */
export const BRIEF_VERSION = "hmr.brief/v1";
export const RESULT_VERSION = "hmr.result/v1";

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

/** What the coordinator writes. The router adds identity and baseline when it starts a workflow. */
export const BriefInputSchema = z.strictObject({
  version: z.literal(BRIEF_VERSION),
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
});
export type BriefInput = z.infer<typeof BriefInputSchema>;

/** The immutable brief as recorded for one workflow. Its SHA-256 is the brief identity. */
export const BriefRecordSchema = BriefInputSchema.extend({
  workflowId: NonEmpty,
  baseline: RevisionSchema,
  writerDescriptor: NonEmpty,
  /** The parent descriptor that resolved `parent`, `auto` and `inherit-parent` lanes. */
  parent: NonEmpty.optional(),
});
export type BriefRecord = z.infer<typeof BriefRecordSchema>;

const Check = z.strictObject({
  command: NonEmpty,
  result: z.enum(["pass", "fail", "not-run"]),
  summary: z.string().max(2000).optional(),
});

const ResultBase = {
  version: z.literal(RESULT_VERSION),
  workflowId: NonEmpty,
  attemptId: NonEmpty,
  revision: RevisionSchema,
  changedPaths: z.array(RelativePath),
  checks: z.array(Check),
  blockers: z.array(NonEmpty),
  notes: z.string().max(8000).optional(),
};

/** A lane's report. The writer and each verifier lane report different outcomes. */
export const ResultSchema = z.discriminatedUnion("lane", [
  z.strictObject({
    ...ResultBase,
    lane: z.literal("writer"),
    status: z.enum(["impl-complete", "blocked", "failed"]),
  }),
  z.strictObject({
    ...ResultBase,
    lane: z.literal("verifier"),
    verifierLaneId: NonEmpty,
    status: z.enum(["pass", "fail", "blocked"]),
  }),
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

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function sameRevision(a: Revision, b: Revision): boolean {
  return a.head === b.head && a.content === b.content;
}
