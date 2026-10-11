import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createGrokStatuslineCollector,
  defaultGrokQuotaCachePath,
} from "../../src/collectors/grok/grok-statusline-collector.js";
import { personal } from "../cli/fixtures.js";

const nowMs = Date.parse("2026-09-17T10:00:00.000Z");

const grokAccount = {
  ...personal,
  agent: "grok" as const,
  provider: "grok" as typeof personal.provider,
  enabledModels: ["grok:grok-4.6"] as unknown as typeof personal.enabledModels,
};

function cacheFile(contents: unknown): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-quota-"));
  const file = path.join(dir, "statusline-quota-cache.json");
  writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  return file;
}

function collector(cachePath: string, now = nowMs) {
  return createGrokStatuslineCollector({ cachePath, now: () => now });
}

describe("grok status line quota collector", () => {
  it("reads ~/.grok/statusline-quota-cache.json by default", () => {
    expect(defaultGrokQuotaCachePath("/home/u")).toBe(
      path.join("/home/u", ".grok", "statusline-quota-cache.json"),
    );
  });

  it("parses a fresh weekly_left cache as estimated local-session usage", async () => {
    const cachePath = cacheFile({ weekly_left: 40, at: 1_789_644_000 });
    const snapshot = await createGrokStatuslineCollector({
      cachePath,
      now: () => 1_789_644_000 * 1000 + 60_000,
    }).collectUsage(grokAccount);
    expect(snapshot.certainty).toBe("estimated");
    expect(snapshot.source).toBe("local-session");
    expect(snapshot.windows[0]).toMatchObject({
      kind: "weekly",
      remainingRatio: 0.4,
    });
  });

  it("returns unknown when the cache is older than 15 minutes", async () => {
    const at = (nowMs - 16 * 60_000) / 1000;
    const snapshot = await collector(cacheFile({ weekly_left: 40, at })).collectUsage(grokAccount);
    expect(snapshot.certainty).toBe("unknown");
    expect(snapshot.source).toBe("local-session");
  });

  it("returns unknown when the cache is dated more than 60 seconds in the future", async () => {
    const at = (nowMs + 61_000) / 1000;
    const snapshot = await collector(cacheFile({ weekly_left: 40, at })).collectUsage(grokAccount);
    expect(snapshot.certainty).toBe("unknown");
    expect(snapshot.source).toBe("local-session");
  });

  it("tolerates up to 60 seconds of clock skew", async () => {
    const at = (nowMs + 60_000) / 1000;
    const snapshot = await collector(cacheFile({ weekly_left: 40, at })).collectUsage(grokAccount);
    expect(snapshot.certainty).toBe("estimated");
    expect(snapshot.windows[0]).toMatchObject({ kind: "weekly", remainingRatio: 0.4 });
  });

  it("returns unknown when the cache is missing or malformed", async () => {
    const missing = await collector(path.join(os.tmpdir(), "missing-grok-quota.json")).collectUsage(
      grokAccount,
    );
    const garbled = await collector(cacheFile("{not json")).collectUsage(grokAccount);
    const wrongShape = await collector(cacheFile({ left: 40 })).collectUsage(grokAccount);
    for (const snapshot of [missing, garbled, wrongShape]) {
      expect(snapshot.certainty).toBe("unknown");
      expect(snapshot.source).toBe("local-session");
    }
  });
});
