import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Remaining quota per account, read from the usage collector's `usage.json` (AGENT-197:
 * `tools/usage-collector/collect.py` writes `~/hmr-usage/usage.json` every 5 minutes). A file
 * read only: no process, network, or credential. Each row is one provider window; an account's
 * remaining quota is what is left of its most-used window.
 */
const UsageFileSchema = z.object({
  updated: z.string(),
  rows: z.array(
    z.looseObject({
      provider: z.string(),
      window: z.string().nullish(),
      used_pct: z.number().nullish(),
      resets_at: z.string().nullish(),
      error: z.string().nullish(),
    }),
  ),
});

/** Readings older than this are not used: the collector runs every 5 minutes. */
export const USAGE_MAX_AGE_MINUTES = 30;

export interface AccountQuota {
  /** 0-100, what is left of the most-used window; undefined when there is no reading. */
  remainingPct?: number;
  /** The binding window, or why there is no reading. */
  detail: string;
}

export interface UsageSnapshot {
  path: string;
  updated: string;
  accounts: Record<string, AccountQuota>;
}

export type UsageRead =
  { ok: true; snapshot: UsageSnapshot } | { ok: false; path: string; reason: string };

export function defaultUsagePath(env: NodeJS.Dict<string>, home: string): string {
  return env.HMR_USAGE_FILE && env.HMR_USAGE_FILE.length > 0
    ? env.HMR_USAGE_FILE
    : path.join(home, "hmr-usage", "usage.json");
}

export function parseUsage(text: string, file: string, now: Date): UsageRead {
  let parsed;
  try {
    parsed = UsageFileSchema.safeParse(JSON.parse(text));
  } catch {
    return { ok: false, path: file, reason: "it is not JSON" };
  }
  if (!parsed.success) return { ok: false, path: file, reason: "it has no updated time and rows" };
  const updated = Date.parse(parsed.data.updated);
  if (Number.isNaN(updated))
    return { ok: false, path: file, reason: "its updated time is invalid" };
  const ageMinutes = Math.round((now.getTime() - updated) / 60_000);
  if (ageMinutes > USAGE_MAX_AGE_MINUTES) {
    return {
      ok: false,
      path: file,
      reason: `it is ${ageMinutes} minutes old (more than ${USAGE_MAX_AGE_MINUTES})`,
    };
  }
  const accounts: Record<string, AccountQuota> = {};
  for (const row of parsed.data.rows) {
    const current = accounts[row.provider];
    if (typeof row.used_pct !== "number") {
      if (!current) accounts[row.provider] = { detail: row.error ?? "no reading" };
      continue;
    }
    const remaining = Math.max(0, Math.min(100, 100 - row.used_pct));
    if (current?.remainingPct === undefined || remaining < current.remainingPct) {
      accounts[row.provider] = {
        remainingPct: remaining,
        detail: `${row.window ?? "window"} ${row.used_pct}% used`,
      };
    }
  }
  return { ok: true, snapshot: { path: file, updated: parsed.data.updated, accounts } };
}

/** Undefined when the collector has written no file there. */
export function readUsage(file: string, now: Date = new Date()): UsageRead | undefined {
  if (!existsSync(file)) return undefined;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { ok: false, path: file, reason: "it could not be read" };
  }
  return parseUsage(text, file, now);
}
