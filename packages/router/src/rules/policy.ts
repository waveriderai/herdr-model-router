import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { isExactDescriptor, ProviderSchema } from "./descriptor.js";
import { normalizeRoleName } from "./mdc-parser.js";

export const POLICY_RELATIVE_PATH = ".model-router/policy.json";

const ExactDescriptorSchema = z
  .string()
  .refine(isExactDescriptor, "pins must be an exact provider:model@effort descriptor");

const RoleNameSchema = z.string().min(1).transform(normalizeRoleName);

/**
 * A project's restrictions. It only narrows what the rules file selects: it cannot add
 * models, credentials, commands, environment, or permissions, and unknown keys are refused.
 */
export const ProjectPolicySchema = z.strictObject({
  version: z.literal(1),
  /** Providers lanes may run on. Omitted: every provider the rules name. */
  allowedProviders: z.array(ProviderSchema).min(1).optional(),
  /**
   * Role -> the exact descriptor its lanes must resolve to: one descriptor for every lane, or
   * one per lane in order. A mismatch refuses the plan; the pin never replaces the rule.
   */
  pins: z
    .record(
      z.string().min(1),
      z.union([ExactDescriptorSchema, z.array(ExactDescriptorSchema).min(1)]),
    )
    .optional(),
  /** Single-lane roles that may write. Omitted: every single-lane role may write. */
  writerRoles: z.array(RoleNameSchema).optional(),
});

export type ProjectPolicy = z.input<typeof ProjectPolicySchema>;

export function parsePolicy(
  text: string,
): { ok: true; policy: ProjectPolicy } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `policy is not valid JSON: ${(error as Error).message}` };
  }
  const parsed = ProjectPolicySchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: `invalid project policy: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    };
  }
  return { ok: true, policy: raw as ProjectPolicy };
}

/** Reads `<projectRoot>/.model-router/policy.json`; a missing file means no restrictions. */
export function loadPolicy(
  projectRoot: string | undefined,
):
  | { ok: true; policy: ProjectPolicy | undefined; path?: string; sha256?: string }
  | { ok: false; error: string } {
  if (!projectRoot) return { ok: true, policy: undefined };
  const file = path.join(projectRoot, POLICY_RELATIVE_PATH);
  if (!existsSync(file)) return { ok: true, policy: undefined };
  const text = readFileSync(file, "utf8");
  const parsed = parsePolicy(text);
  if (!parsed.ok) return { ok: false, error: `${file}: ${parsed.error}` };
  return {
    ok: true,
    policy: parsed.policy,
    path: file,
    sha256: createHash("sha256").update(text).digest("hex"),
  };
}
