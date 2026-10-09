import { mkdirSync, mkdtempSync, statSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactConflictError, artifactStoreIn, isInside } from "../../src/workflow/artifacts.js";

describe("private workflow artifacts", () => {
  it("writes user-only files under the router home and never replaces one", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "hmr-art-"));
    const store = artifactStoreIn(home);
    const file = store.write("wf_1", "brief.json", "{}");
    expect(file).toBe(path.join(home, "workflows", "wf_1", "brief.json"));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(store.read("wf_1", "brief.json")).toBe("{}");
    // The same bytes are reused on retry; different bytes are a conflict, never an overwrite.
    expect(store.write("wf_1", "brief.json", "{}")).toBe(file);
    expect(() => store.write("wf_1", "brief.json", "changed")).toThrow(ArtifactConflictError);
    expect(store.read("wf_1", "brief.json")).toBe("{}");
  });

  it("refuses symlinked directories and files, and unsafe names", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "hmr-art-"));
    const elsewhere = mkdtempSync(path.join(os.tmpdir(), "hmr-elsewhere-"));
    mkdirSync(path.join(home, "workflows"), { recursive: true });
    symlinkSync(elsewhere, path.join(home, "workflows", "wf_link"));
    const store = artifactStoreIn(home);
    expect(() => store.write("wf_link", "brief.json", "{}")).toThrow(/symlink/);
    store.write("wf_2", "real.json", "{}");
    symlinkSync(
      path.join(elsewhere, "target"),
      path.join(home, "workflows", "wf_2", "linked.json"),
    );
    expect(() => store.write("wf_2", "linked.json", "{}")).toThrow();
    expect(() => store.read("wf_2", "linked.json")).toThrow(/symlink/);
    expect(() => store.write("../escape", "x", "{}")).toThrow(/safe file name/);
    expect(() => store.write("wf_3", "../../x", "{}")).toThrow(/safe file name/);
  });

  it("keeps artifacts outside the worktree", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "hmr-art-"));
    const worktree = mkdtempSync(path.join(os.tmpdir(), "hmr-wt-"));
    const file = artifactStoreIn(home).write("wf_4", "result.json", "{}");
    expect(isInside(file, worktree)).toBe(false);
    expect(isInside(path.join(worktree, "src", "x.ts"), worktree)).toBe(true);
  });
});
