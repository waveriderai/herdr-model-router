import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadModelCatalog } from "../../src/catalog/model-catalog.js";
import { collectUsageChain } from "../../src/collectors/collector-chain.js";
import { collectorsForAccount } from "../../src/collectors/registry.js";
import { executeRun } from "../../src/commands/run.js";
import { AccountSchema } from "../../src/domain/account.js";
import { createHerdrClient } from "../../src/launch/herdr-client.js";
import { fakeTypeSafe } from "./fixtures.js";

const grokAccount = AccountSchema.parse({
  id: "acct_personal_grok",
  label: "personal grok",
  provider: "grok",
  agent: "grok",
  ownership: "personal",
  collectorPreference: ["local-session"],
  enabledModels: ["grok:grok-4.7", "grok:grok-4.7-build-fast", "grok:grok-4.6", "grok:grok-4.5"],
  enabled: true,
});

function freshGrokCache(weeklyLeft: number, nowMs: number): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-route-"));
  const file = path.join(dir, "statusline-quota-cache.json");
  writeFileSync(file, JSON.stringify({ weekly_left: weeklyLeft, at: Math.floor(nowMs / 1000) }));
  return file;
}

describe("quota mode with a native grok account", () => {
  it("selects the grok account on a fresh cache and launches the grok CLI", async () => {
    const now = new Date();
    const usage = await collectUsageChain(
      grokAccount,
      collectorsForAccount(grokAccount, {
        grokQuotaCachePath: freshGrokCache(70, now.getTime()),
      }),
    );
    expect(usage.certainty).toBe("estimated");

    const calls: string[][] = [];
    const herdr = createHerdrClient(async (argv) => {
      calls.push([...argv]);
      return { ok: true, code: 0, stdout: "w1:p9\n", stderr: "" };
    });
    const result = await executeRun(
      "Implement the approved plan.",
      { dryRun: false },
      {
        accounts: [grokAccount],
        models: loadModelCatalog().models,
        usage: { [grokAccount.id]: usage },
        client: fakeTypeSafe({ family: "implementation", phase: "implementation" }),
        env: { HERDR_ENV: "1" },
        now,
        herdr,
      },
    );

    expect(result.code).toBe(0);
    expect(result.output).toContain("acct_personal_grok");
    expect(result.output).toContain("weekly 70% left");
    const start = calls.find((argv) => argv[1] === "agent" && argv[2] === "start");
    expect(start?.slice(4, 6)).toEqual(["--kind", "grok"]);
    // Herdr's `--kind grok` supplies the executable; the native grok flags follow `--`.
    const args = start!.slice(start!.indexOf("--") + 1);
    expect(args[0]).toBe("--model");
    expect(grokAccount.enabledModels.map((id) => id.replace(/^grok:/, ""))).toContain(args[1]);
    expect(args.slice(2, 3)).toEqual(args.length > 2 ? ["--reasoning-effort"] : []);
  });
});
