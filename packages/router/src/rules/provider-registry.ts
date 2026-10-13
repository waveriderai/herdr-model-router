import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ReasoningEffortSchema } from "../domain/model-profile.js";

/**
 * The provider registry (config/providers.json) is metadata only: ids, the agent CLI name,
 * capabilities, cost tier and fallback eligibility. It never carries launch commands, flags
 * or shell strings; how each provider is launched lives in code (native-argv.ts adapters).
 * Adding a coding agent = one registry entry + one adapter in native-argv.ts.
 */
const IdSchema = z.string().regex(/^[a-z][a-z0-9-]*$/, "provider ids are lowercase [a-z0-9-]");

export const ProviderEntrySchema = z.strictObject({
  id: IdSchema,
  displayName: z.string().min(1),
  /** The CLI name the adapter expects; a bare executable name, never a path or command line. */
  agentCli: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "agentCli is a bare executable name"),
  efforts: z.array(ReasoningEffortSchema),
  capabilities: z.array(z.enum(["code", "review", "design", "read-only-mode"])),
  costTier: z.enum(["low", "medium", "high"]),
  fallbackEligible: z.boolean(),
});

export const ProviderRegistrySchema = z
  .strictObject({
    version: z.literal(1),
    providers: z.array(ProviderEntrySchema).min(1),
  })
  .superRefine((registry, ctx) => {
    const seen = new Set<string>();
    for (const [index, entry] of registry.providers.entries()) {
      if (seen.has(entry.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["providers", index, "id"],
          message: `duplicate provider id "${entry.id}"`,
        });
      }
      seen.add(entry.id);
    }
  });

export type ProviderEntry = z.infer<typeof ProviderEntrySchema>;
export type ProviderRegistry = z.infer<typeof ProviderRegistrySchema>;

export function defaultProviderRegistryPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "../../config/providers.json");
}

export function parseProviderRegistry(text: string): ProviderRegistry {
  return ProviderRegistrySchema.parse(JSON.parse(text));
}

export function loadProviderRegistry(
  file: string = defaultProviderRegistryPath(),
): ProviderRegistry {
  return parseProviderRegistry(readFileSync(file, "utf8"));
}

let cached: ProviderRegistry | undefined;

/** The bundled registry, read once. */
export function providerRegistry(): ProviderRegistry {
  cached ??= loadProviderRegistry();
  return cached;
}

export function providerIds(): string[] {
  return providerRegistry().providers.map((entry) => entry.id);
}

export function providerEntry(id: string): ProviderEntry | undefined {
  return providerRegistry().providers.find((entry) => entry.id === id);
}
