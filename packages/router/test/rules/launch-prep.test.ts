import {
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
  cursorDenyRules,
  ensureGrokProfiles,
  herdrHooks,
  prepareNativeLaunch,
} from "../../src/rules/launch-prep.js";
import { nativeLaunch } from "../../src/rules/native-argv.js";

function tmp(): string {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), "hmr-prep-")));
}

function launchFor(
  provider: "claude" | "grok" | "cursor" | "codex",
  profile: "writer" | "read-only",
  home: string,
) {
  const built = nativeLaunch({ provider, model: "m", effort: null }, profile, home);
  if (!built.ok) throw new Error(built.error);
  return built.launch;
}

describe("launch preparation (AGENT-285, Kai 8:25 PM PT)", () => {
  it("marks only the launches that need preparation", () => {
    const home = tmp();
    expect(launchFor("claude", "writer", home).prepare).toBe("claude-writer");
    expect(launchFor("claude", "read-only", home).prepare).toBeUndefined();
    expect(launchFor("grok", "writer", home).prepare).toBe("grok-profiles");
    expect(launchFor("grok", "read-only", home).prepare).toBe("grok-profiles");
    expect(launchFor("cursor", "writer", home).prepare).toBe("cursor-config");
    expect(launchFor("codex", "writer", home).prepare).toBeUndefined();
  });

  it("gives a writer Claude only Herdr's hooks from user settings and keeps its sandbox settings", () => {
    const home = tmp();
    const cwd = tmp();
    mkdirSync(path.join(home, ".claude"));
    writeFileSync(
      path.join(home, ".claude", "settings.json"),
      JSON.stringify({
        permissions: { allow: ["Bash(python3 *)"] },
        hooks: {
          Stop: [
            {
              hooks: [
                { type: "command", command: "bash '/h/.claude/hooks/herdr-lifecycle.sh' idle" },
              ],
            },
            { hooks: [{ type: "command", command: "/h/other.sh" }] },
          ],
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/h/gate.py" }] }],
        },
      }),
    );
    const launch = launchFor("claude", "writer", home);
    expect(launch.argv).toEqual(expect.arrayContaining(["--setting-sources", "project,local"]));
    const prep = prepareNativeLaunch(launch, { cwd, laneId: "l1", routerHome: home, home });
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    const settings = JSON.parse(prep.argv[prep.argv.indexOf("--settings") + 1]!);
    expect(Object.keys(settings.hooks)).toEqual(["Stop"]);
    expect(JSON.stringify(settings.hooks)).toContain("herdr-lifecycle.sh");
    expect(JSON.stringify(settings)).not.toContain("python3");
    expect(settings.sandbox.allowUnsandboxedCommands).toBe(false);
  });

  it.each([
    [{ sandbox: { excludedCommands: ["python3 *"] } }, /excludedCommands/],
    [{ sandbox: { enabled: false } }, /weakens the sandbox/],
    [{ sandbox: { allowUnsandboxedCommands: true } }, /weakens the sandbox/],
  ])("refuses a writer Claude when project/local settings %j", (projectSettings, error) => {
    const home = tmp();
    const cwd = tmp();
    mkdirSync(path.join(cwd, ".claude"));
    writeFileSync(
      path.join(cwd, ".claude", "settings.local.json"),
      JSON.stringify(projectSettings),
    );
    const prep = prepareNativeLaunch(launchFor("claude", "writer", home), {
      cwd,
      laneId: "l",
      routerHome: home,
      home,
    });
    expect(prep.ok).toBe(false);
    if (!prep.ok) expect(prep.error).toMatch(error);
  });

  it("keeps hmr's Grok profiles in a managed block and leaves the rest of sandbox.toml alone", () => {
    const home = tmp();
    mkdirSync(path.join(home, ".grok"));
    const file = path.join(home, ".grok", "sandbox.toml");
    writeFileSync(file, '[profiles.mine]\nextends = "strict"\n');
    ensureGrokProfiles(home, "/state/hmr");
    ensureGrokProfiles(home, "/state/hmr2");
    const text = readFileSync(file, "utf8");
    expect(text).toContain('[profiles.mine]\nextends = "strict"');
    expect(text.match(/\[profiles\.hmr-writer\]/g)).toHaveLength(1);
    expect(text).toContain('read_write = ["/state/hmr2"]');
    expect(text).toContain('[profiles.hmr-read-only]\nextends = "read-only"');
    const launch = launchFor("grok", "writer", home);
    expect(launch.argv).toEqual(
      expect.arrayContaining(["--sandbox", "hmr-writer", "--always-approve"]),
    );
  });

  it("refuses to overwrite an hmr profile the user defined by hand", () => {
    const home = tmp();
    mkdirSync(path.join(home, ".grok"));
    writeFileSync(
      path.join(home, ".grok", "sandbox.toml"),
      '[profiles.hmr-writer]\nextends = "workspace"\n',
    );
    const prep = prepareNativeLaunch(launchFor("grok", "writer", home), {
      cwd: home,
      laneId: "l",
      routerHome: home,
      home,
    });
    expect(prep.ok).toBe(false);
  });

  it("gives a Cursor writer its own 0600 config: allowlist, sandbox on, only the login record", () => {
    const home = tmp();
    const router = path.join(tmp(), "router");
    const cwd = tmp();
    mkdirSync(path.join(home, ".cursor"));
    writeFileSync(
      path.join(home, ".cursor", "cli-config.json"),
      JSON.stringify({
        version: 1,
        authInfo: { email: "e", userId: 1 },
        approvalMode: "unrestricted",
        sandbox: { mode: "disabled", networkAccess: "allowlist" },
        permissions: { allow: ["Shell(*)"], deny: [] },
        privacyCache: { x: 1 },
      }),
    );
    writeFileSync(path.join(home, ".cursor", "hooks.json"), '{"hooks":{},"version":1}');
    const prep = prepareNativeLaunch(launchFor("cursor", "writer", router), {
      cwd,
      laneId: "lane/1",
      routerHome: router,
      home,
    });
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    const dir = prep.env.CURSOR_CONFIG_DIR!;
    expect(dir.startsWith(path.join(router, "cursor-config"))).toBe(true);
    const file = path.join(dir, "cli-config.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const config = JSON.parse(readFileSync(file, "utf8"));
    expect(config.approvalMode).toBe("allowlist");
    expect(config.sandbox.mode).toBe("enabled");
    expect(config.permissions.allow).not.toContain("Shell(*)");
    expect(config.privacyCache).toBeUndefined();
    expect(config.authInfo).toEqual({ email: "e", userId: 1 });
    // The global config is untouched.
    expect(
      JSON.parse(readFileSync(path.join(home, ".cursor", "cli-config.json"), "utf8")).approvalMode,
    ).toBe("unrestricted");
  });

  it("never authorizes Cursor: no login record means no launch", () => {
    const home = tmp();
    mkdirSync(path.join(home, ".cursor"));
    writeFileSync(path.join(home, ".cursor", "cli-config.json"), "{}");
    const prep = prepareNativeLaunch(launchFor("cursor", "writer", home), {
      cwd: home,
      laneId: "l",
      routerHome: home,
      home,
    });
    expect(prep.ok).toBe(false);
    if (!prep.ok) expect(prep.error).toMatch(/not logged in/);
  });

  it("denies Cursor writes to every sibling of the worktree's ancestors, never the worktree or kept roots", () => {
    const root = tmp();
    const wt = path.join(root, "a", "wt");
    mkdirSync(wt, { recursive: true });
    mkdirSync(path.join(root, "a", "other"));
    mkdirSync(path.join(root, "keep"));
    const deny = cursorDenyRules(wt, [path.join(root, "keep")]);
    expect(deny).toContain(`Write(${path.join(root, "a", "other")}/**)`);
    expect(deny.some((rule) => rule.includes(`${wt}/`) || rule === `Write(${wt}/**)`)).toBe(false);
    expect(deny).not.toContain(`Write(${path.join(root, "keep")}/**)`);
  });

  it("keeps only Herdr hook groups", () => {
    expect(herdrHooks(undefined)).toEqual({});
    expect(herdrHooks({ hooks: { Stop: [{ hooks: [{ command: "/x/other.sh" }] }] } })).toEqual({});
  });
});

describe("startNativeAgent fails closed on preparation (AGENT-285)", () => {
  async function start(prepareLaunch?: unknown) {
    const { startNativeAgent } = await import("../../src/rules/dispatch.js");
    let splits = 0;
    const deps = {
      herdr: { splitCurrent: async () => (splits++, { ok: false, stdout: "", stderr: "" }) },
      ...(prepareLaunch ? { prepareLaunch } : {}),
    } as never;
    const launch = { ...launchFor("cursor", "writer", tmp()), executable: "/bin/cursor-agent" };
    launch.argv[0] = "/bin/cursor-agent";
    const result = await startNativeAgent({ deps, laneId: "l", cwd: tmp(), launch });
    return { result, splits };
  }

  it("never opens a pane for a launch whose preparation is missing", async () => {
    const { result, splits } = await start();
    expect(result.ok).toBe(false);
    expect(splits).toBe(0);
    if (!result.ok) expect(result.error).toMatch(/needs launch preparation \(cursor-config\)/);
  });

  it("never opens a pane when preparation fails", async () => {
    const { result, splits } = await start(() => ({ ok: false, error: "no login" }));
    expect(splits).toBe(0);
    if (!result.ok) expect(result.error).toMatch(/no login; no pane was created/);
  });
});
