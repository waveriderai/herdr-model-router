import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Account } from "../../domain/account.js";
import type { UsageSnapshot } from "../../domain/usage.js";
import { normalizeUsage } from "../normalizer.js";
import type { UsageCollector } from "../types.js";

// Written by a user's Grok status line (or a small script) as
// `{ "weekly_left": <0-100 percent remaining>, "at": <Unix seconds> }`. The router only reads this file.
export const GROK_QUOTA_MAX_AGE_MS = 15 * 60_000;
// A cache dated further ahead than this is not trusted: it would otherwise stay "fresh" forever.
export const GROK_QUOTA_MAX_CLOCK_SKEW_MS = 60_000;

const CacheSchema = z.object({
  weekly_left: z.number(),
  at: z.number().positive(),
});

export function defaultGrokQuotaCachePath(home = os.homedir()): string {
  return path.join(home, ".grok", "statusline-quota-cache.json");
}

export function createGrokStatuslineCollector(
  options: { cachePath?: string; now?: () => number } = {},
): UsageCollector {
  const cachePath = options.cachePath ?? defaultGrokQuotaCachePath();
  const now = options.now ?? Date.now;

  function unknown(account: Account): UsageSnapshot {
    const at = new Date(now()).toISOString();
    return normalizeUsage({
      accountId: account.id,
      windows: [{ kind: "weekly" }],
      collectedAt: at,
      source: "local-session",
      certainty: "unknown",
      expiresAt: at,
    });
  }

  return {
    kind: "local-session",
    async detectAccounts() {
      return [];
    },
    async collectUsage(account) {
      let cache;
      try {
        cache = CacheSchema.safeParse(JSON.parse(await readFile(cachePath, "utf8")));
      } catch {
        return unknown(account);
      }
      if (!cache.success) {
        return unknown(account);
      }
      const collectedAtMs = cache.data.at * 1000;
      const ageMs = now() - collectedAtMs;
      if (ageMs > GROK_QUOTA_MAX_AGE_MS || ageMs < -GROK_QUOTA_MAX_CLOCK_SKEW_MS) {
        return unknown(account);
      }
      const left = Math.max(0, Math.min(100, cache.data.weekly_left));
      return normalizeUsage({
        accountId: account.id,
        windows: [
          {
            kind: "weekly",
            remainingRatio: left / 100,
            usedRatio: (100 - left) / 100,
          },
        ],
        collectedAt: new Date(collectedAtMs).toISOString(),
        source: "local-session",
        certainty: "estimated",
        expiresAt: new Date(now() + 60_000).toISOString(),
      });
    },
    async listAvailableModels() {
      return [];
    },
  };
}
