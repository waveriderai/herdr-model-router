import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseNativeDescriptor, type NativeDescriptor } from "./descriptor.js";

/**
 * The same model on different accounts (config/model-accounts.json): each group lists exact
 * descriptors, at most one per provider, that run one model at one effort. A model that is in
 * no group runs only on the account the rules file names; GPT models are in none, so they stay
 * on Codex. Ids are copied from each CLI's own model list, never derived.
 */
const ModelAccountsSchema = z
  .strictObject({
    version: z.literal(1),
    verified: z.string().min(1),
    equivalents: z.array(z.array(z.string()).min(2)),
  })
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    for (const [index, group] of file.equivalents.entries()) {
      const providers = new Set<string>();
      for (const raw of group) {
        const parsed = parseNativeDescriptor(raw);
        if (!parsed.ok || parsed.descriptor.canonical !== raw) {
          ctx.addIssue({
            code: "custom",
            path: ["equivalents", index],
            message: `"${raw}" is not an exact provider:model[@effort] descriptor`,
          });
          continue;
        }
        if (providers.has(parsed.descriptor.provider) || seen.has(raw)) {
          ctx.addIssue({
            code: "custom",
            path: ["equivalents", index],
            message: `"${raw}" repeats a provider in its group or a descriptor in the file`,
          });
        }
        providers.add(parsed.descriptor.provider);
        seen.add(raw);
      }
    }
  });

export type ModelAccounts = z.infer<typeof ModelAccountsSchema>;

export function parseModelAccounts(text: string): ModelAccounts {
  return ModelAccountsSchema.parse(JSON.parse(text));
}

let cached: ModelAccounts | undefined;

function bundled(): ModelAccounts {
  cached ??= parseModelAccounts(
    readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../../config/model-accounts.json"),
      "utf8",
    ),
  );
  return cached;
}

/** Every account's descriptor for this model, the given one first, then in file order. */
export function accountsFor(
  descriptor: NativeDescriptor,
  table: ModelAccounts = bundled(),
): NativeDescriptor[] {
  const group = table.equivalents.find((entry) => entry.includes(descriptor.canonical)) ?? [];
  const others = group
    .filter((raw) => raw !== descriptor.canonical)
    .map((raw) => {
      const parsed = parseNativeDescriptor(raw);
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.descriptor;
    });
  return [descriptor, ...others];
}
