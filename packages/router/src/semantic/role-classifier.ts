import { choice, type ChoiceResponse } from "@typesafe-ai/sdk";
import { assertSafeState, type TypeSafePort } from "./typesafe-client.js";

export type RoleClassification =
  { ok: true; role: string; confidence: number } | { ok: false; error: string };

/**
 * Opt-in semantic mode: asks TypeSafe which of the rules file's roles fits the task. The
 * answer is a role name only. Models, efforts, panels and policy stay with the rules and the
 * project policy, so any answer outside the role list, or carrying anything but a role, is
 * refused rather than used.
 */
export async function classifyRole(input: {
  task: string;
  roles: string[];
  client: TypeSafePort;
}): Promise<RoleClassification> {
  if (input.roles.length === 0)
    return { ok: false, error: "the rules file defines no usable roles" };
  const state = { task: input.task };
  try {
    assertSafeState(state);
  } catch {
    return {
      ok: false,
      error:
        "Task text looks like it contains a credential and was not sent. Remove the secret and retry.",
    };
  }
  let result;
  try {
    result = await input.client.systemOne({
      state,
      questions: {
        role: choice(
          "Which role from the user's rules file fits this task?",
          Object.fromEntries(input.roles.map((role) => [role, `The "${role}" role.`])),
        ),
      },
    });
  } catch (error) {
    return {
      ok: false,
      error: `TypeSafe classification failed (${(error as Error).message}); nothing was routed and no other classifier or model was tried`,
    };
  }
  const answers = result.answers as Record<string, unknown>;
  const extra = Object.keys(answers).filter((key) => key !== "role");
  if (extra.length > 0) {
    return {
      ok: false,
      error: `TypeSafe returned fields beyond a role (${extra.join(", ")}); refused`,
    };
  }
  const answer = answers.role as ChoiceResponse | undefined;
  if (!answer || typeof answer.choice !== "string" || !input.roles.includes(answer.choice)) {
    return {
      ok: false,
      error: `TypeSafe chose "${String(answer?.choice)}", which is not a role in the rules file; refused`,
    };
  }
  return { ok: true, role: answer.choice, confidence: answer.confidence };
}
