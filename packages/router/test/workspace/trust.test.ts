import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  codexProjectTables,
  isHmrTrusted,
  pretrust,
  trustDirectory,
} from "../../src/workspace/trust.js";

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

  it("keeps a private config private", () => {
    const { home, wt, env } = sandbox();
    const file = path.join(home, ".claude.json");
    chmodSync(file, 0o600);
    pretrust("claude", wt, env);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("recognises a spaced TOML header and never duplicates it", () => {
    const { home, wt, env } = sandbox();
    mkdirSync(path.join(home, ".codex"));
    const file = path.join(home, ".codex", "config.toml");
    writeFileSync(file, `[ projects . ${JSON.stringify(wt)} ]  # mine\ntrust_level = "trusted"\n`);
    expect(codexProjectTables(readFileSync(file, "utf8"))).toEqual([wt]);
    pretrust("codex", wt, env);
    expect(readFileSync(file, "utf8").match(/trust_level/g)).toHaveLength(1);
  });

  it("never throws when the trust list cannot be read", () => {
    const { home, wt } = sandbox();
    const list = path.join(home, "list-is-a-dir");
    mkdirSync(list);
    const result = pretrust("cursor", path.join(home, "x"), { HOME: home, HMR_TRUST_LIST: list });
    expect(result.trusted).toBe(false);
    expect(pretrust("cursor", wt, { HOME: home, HMR_TRUST_LIST: list }).trusted).toBe(true);
  });
});
