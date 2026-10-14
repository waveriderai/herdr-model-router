import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isHmrTrusted, pretrust, trustDirectory } from "../../src/workspace/trust.js";

function sandbox() {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "hmr-trust-")));
  const root = path.join(home, "herdr-worktrees");
  const wt = path.join(root, "repo-agent-1");
  mkdirSync(wt, { recursive: true });
  writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ projects: {} }));
  return { home, root, wt, env: { HOME: home } };
}

describe("workspace pre-trust", () => {
  it("trusts only Herdr worktree roots and listed dirs", () => {
    const { home, root, wt, env } = sandbox();
    expect(isHmrTrusted(wt, env)).toBe(true);
    expect(isHmrTrusted(root, env)).toBe(false);
    expect(isHmrTrusted(home, env)).toBe(false);
    const other = path.join(home, "elsewhere");
    mkdirSync(other);
    expect(pretrust("cursor", other, env)).toEqual({ trusted: false, argv: [] });
    trustDirectory(other, env);
    expect(isHmrTrusted(other, env)).toBe(true);
  });

  it("uses each CLI's own trust record", () => {
    const { home, wt, env } = sandbox();
    expect(pretrust("cursor", wt, env).argv).toEqual(["--trust"]);
    pretrust("claude", wt, env);
    const claude = JSON.parse(readFileSync(path.join(home, ".claude.json"), "utf8"));
    expect(claude.projects[wt].hasTrustDialogAccepted).toBe(true);
    pretrust("codex", wt, env);
    pretrust("codex", wt, env);
    const toml = readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    expect(toml.match(/trust_level = "trusted"/g)).toHaveLength(1);
    expect(toml).toContain(`[projects.${JSON.stringify(wt)}]`);
  });
});
