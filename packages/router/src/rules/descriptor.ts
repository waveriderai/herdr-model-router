import { z } from "zod";
import type { ReasoningEffort } from "../domain/model-profile.js";

/** Native CLIs a lane can run on. `grok` is xAI's own grok CLI, not Cursor's Grok selector. */
export const ProviderSchema = z.enum(["grok", "codex", "claude", "cursor", "opencode"]);
export type Provider = z.infer<typeof ProviderSchema>;

/**
 * Efforts each native CLI accepts as a flag. Cursor and OpenCode have no effort flag (Cursor
 * encodes reasoning in the model id), so a descriptor for them carries no `@effort`.
 */
export const PROVIDER_EFFORTS: Record<Provider, readonly ReasoningEffort[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh", "max", "ultra"],
  grok: ["low", "medium", "high", "xhigh"],
  cursor: [],
  opencode: [],
};

export const PARENT_ALIASES = ["parent", "auto", "inherit-parent"] as const;
export type ParentAlias = (typeof PARENT_ALIASES)[number];

export interface NativeDescriptor {
  provider: Provider;
  /** The exact native model id, passed to the CLI unchanged. */
  model: string;
  effort: ReasoningEffort | null;
  /** `provider:model@effort`, or `provider:model` without an effort. */
  canonical: string;
  /** The legacy selector this descriptor was translated from, when it was one. */
  legacySelector?: string;
  notes: string[];
}

export type LaneSelector =
  | { kind: "native"; selector: string; descriptor: NativeDescriptor }
  | { kind: "parent"; alias: ParentAlias };

type Parsed<T> = { ok: true } & T;
type Failed = { ok: false; error: string };

/**
 * Legacy pstack selectors with a known native meaning. Anything not listed here, and not in
 * provider:model@effort form, is rejected rather than guessed.
 */
const LEGACY_SELECTORS: Record<
  string,
  { provider: Provider; model: string; effort: ReasoningEffort; lost: string }
> = {
  "grok-4.7-xhigh-fast": {
    provider: "grok",
    model: "grok-4.7",
    effort: "xhigh",
    lost: "Cursor's fast variant has no native grok equivalent",
  },
};

// A model id is data passed as one argv element: no spaces, quotes, or shell metacharacters.
const DESCRIPTOR = /^([a-z][a-z0-9-]*):([A-Za-z0-9][A-Za-z0-9._/-]*)(?:@([a-z]+))?$/;

/**
 * Model names that resolve to whatever the CLI currently maps them to (rolling aliases and
 * automatic pickers). A route must name the exact model, so these are refused everywhere a
 * descriptor is read: rules lanes, policy pins, and --parent.
 */
export const ROLLING_MODEL_ALIASES = [
  "default",
  "best",
  "auto",
  "fable",
  "opus",
  "sonnet",
  "haiku",
  "opusplan",
] as const;

export function isRollingAlias(model: string): boolean {
  const lowered = model.toLowerCase();
  return (
    (ROLLING_MODEL_ALIASES as readonly string[]).includes(lowered) || lowered.endsWith("-latest")
  );
}

export function canonicalDescriptor(
  provider: Provider,
  model: string,
  effort: ReasoningEffort | null,
): string {
  return effort ? `${provider}:${model}@${effort}` : `${provider}:${model}`;
}

/** Parses an exact descriptor (or a known legacy selector). Parent aliases are not descriptors. */
export function parseNativeDescriptor(
  raw: string,
): Parsed<{ descriptor: NativeDescriptor }> | Failed {
  const value = raw.trim();
  const legacy = LEGACY_SELECTORS[value];
  if (legacy) {
    const canonical = canonicalDescriptor(legacy.provider, legacy.model, legacy.effort);
    return {
      ok: true,
      descriptor: {
        provider: legacy.provider,
        model: legacy.model,
        effort: legacy.effort,
        canonical,
        legacySelector: value,
        notes: [`legacy Cursor selector ${value} mapped to native ${canonical}; ${legacy.lost}`],
      },
    };
  }
  const match = DESCRIPTOR.exec(value);
  if (!match || value.endsWith("@")) {
    return {
      ok: false,
      error: `unrecognized model descriptor "${value}"; write provider:model@effort`,
    };
  }
  const [, providerRaw, model, effortRaw] = match;
  const provider = ProviderSchema.safeParse(providerRaw);
  if (!provider.success) {
    return {
      ok: false,
      error: `unknown provider "${providerRaw}"; use one of ${ProviderSchema.options.join(", ")}`,
    };
  }
  if (isRollingAlias(model!)) {
    return {
      ok: false,
      error: `"${model}" is a rolling or automatic model alias, not an exact model id; write the full native model id (for example claude:claude-opus-5-5@high)`,
    };
  }
  let effort: ReasoningEffort | null = null;
  if (effortRaw !== undefined) {
    const supported = PROVIDER_EFFORTS[provider.data];
    if (!(supported as readonly string[]).includes(effortRaw)) {
      return {
        ok: false,
        error:
          `${provider.data} does not support effort "${effortRaw}"` +
          (supported.length > 0
            ? ` (supported: ${supported.join(", ")})`
            : `; write ${provider.data}:<exact-model-id> without @effort`),
      };
    }
    effort = effortRaw as ReasoningEffort;
  }
  return {
    ok: true,
    descriptor: {
      provider: provider.data,
      model: model!,
      effort,
      canonical: canonicalDescriptor(provider.data, model!, effort),
      notes: [],
    },
  };
}

/** Parses one lane of a rules entry: a parent alias or a descriptor. */
export function parseLaneSelector(raw: string): Parsed<{ lane: LaneSelector }> | Failed {
  const value = raw.trim();
  if ((PARENT_ALIASES as readonly string[]).includes(value)) {
    return { ok: true, lane: { kind: "parent", alias: value as ParentAlias } };
  }
  const parsed = parseNativeDescriptor(value);
  if (!parsed.ok) return parsed;
  return { ok: true, lane: { kind: "native", selector: value, descriptor: parsed.descriptor } };
}

/** Exact `provider:model[@effort]` only: what a project policy pin may name. */
export function isExactDescriptor(raw: string): boolean {
  const parsed = parseNativeDescriptor(raw);
  return (
    parsed.ok &&
    parsed.descriptor.legacySelector === undefined &&
    parsed.descriptor.canonical === raw
  );
}
