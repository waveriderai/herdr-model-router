import { describe, expect, it } from "vitest";
import { staleLockEvidence } from "../../src/commands/task-commands.js";

const store = (panes: string[]) =>
  ({
    getTask: (id: string) => (id === "t1" ? { id } : undefined),
    lanes: () => panes.map((paneId) => ({ paneId })),
  }) as never;

describe("task release --stale", () => {
  it("releases only when Herdr confirms every pane is gone", async () => {
    const absent = { paneState: async () => "absent" as const };
    expect(await staleLockEvidence(store(["w1:p2"]), absent, "t1")).toMatchObject({ stale: true });
  });
  it("keeps the lock when a pane exists or Herdr cannot answer", async () => {
    for (const state of ["present", "unknown"] as const) {
      const pane = { paneState: async () => state };
      expect(await staleLockEvidence(store(["w1:p2"]), pane, "t1")).toMatchObject({
        stale: false,
      });
    }
    const failing = {
      paneState: async (): Promise<"present"> => {
        throw new Error("herdr down");
      },
    };
    expect(await staleLockEvidence(store(["w1:p2"]), failing, "t1")).toMatchObject({
      stale: false,
    });
    expect(await staleLockEvidence(store(["w1:p2"]), {}, "t1")).toMatchObject({ stale: false });
  });
});
