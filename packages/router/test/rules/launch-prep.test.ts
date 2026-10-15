import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cursorDenyRules,
  cursorSandboxRefusal,
  cursorSettingsSymlink,
  cursorWorktreeInsideAllowRoot,
  ensureGrokProfiles,
  herdrHooks,
  prepareNativeLaunch,
} from "../../src/rules/launch-prep.js";
import { grokProfileNames, nativeLaunch } from "../../src/rules/native-argv.js";

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
    expect(launch.argv).toEqual(expect.arrayContaining(["--setting-sources", ""]));
    const prep = prepareNativeLaunch(launch, { cwd, laneId: "l1", routerHome: home, home });
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    const settings = JSON.parse(prep.argv[prep.argv.indexOf("--settings") + 1]!);
    expect(Object.keys(settings.hooks)).toEqual(["Stop"]);
    expect(JSON.stringify(settings.hooks)).toContain("herdr-lifecycle.sh");
    expect(JSON.stringify(settings)).not.toContain("python3");
    expect(settings.sandbox.allowUnsandboxedCommands).toBe(false);
  });

  it("ignores project and local settings: a local allow rule cannot widen a writer Claude", () => {
    const home = tmp();
    const cwd = tmp();
    mkdirSync(path.join(cwd, ".claude"));
    writeFileSync(
      path.join(cwd, ".claude", "settings.local.json"),
      JSON.stringify({ permissions: { allow: ["Write(//**)"] } }),
    );
    const launch = launchFor("claude", "writer", home);
    expect(launch.argv[launch.argv.indexOf("--setting-sources") + 1]).toBe("");
    const prep = prepareNativeLaunch(launch, { cwd, laneId: "l", routerHome: home, home });
    expect(prep.ok).toBe(true);
    if (prep.ok) expect(prep.argv.join(" ")).not.toContain("Write(//**)");
  });

  it("keeps one managed Grok block per router home and leaves the rest of sandbox.toml alone", () => {
    const home = tmp();
    mkdirSync(path.join(home, ".grok"));
    const file = path.join(home, ".grok", "sandbox.toml");
    writeFileSync(file, '[profiles.mine]\nextends = "strict"\n');
    ensureGrokProfiles(home, "/state/hmr");
    ensureGrokProfiles(home, "/state/hmr2");
    const once = readFileSync(file, "utf8");
    ensureGrokProfiles(home, "/state/hmr");
    const text = readFileSync(file, "utf8");
    expect(text).toBe(once);
    const one = grokProfileNames("/state/hmr");
    const two = grokProfileNames("/state/hmr2");
    expect(one.writer).not.toBe(two.writer);
    expect(text).toContain('[profiles.mine]\nextends = "strict"');
    expect(text.split(`[profiles.${one.writer}]`)).toHaveLength(2);
    expect(text.split(`[profiles.${two.writer}]`)).toHaveLength(2);
    expect(text).toContain('read_write = ["/state/hmr"]');
    expect(text).toContain('read_write = ["/state/hmr2"]');
    expect(text).toContain(`[profiles.${one.readOnly}]\nextends = "read-only"`);
    const launch = launchFor("grok", "writer", "/state/hmr");
    expect(launch.argv).toEqual(
      expect.arrayContaining(["--sandbox", one.writer, "--always-approve"]),
    );
  });

  it("refuses to overwrite an hmr profile the user defined by hand", () => {
    const home = tmp();
    mkdirSync(path.join(home, ".grok"));
    writeFileSync(
      path.join(home, ".grok", "sandbox.toml"),
      `[profiles.${grokProfileNames(home).writer}]\nextends = "workspace"\n`,
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
      tempDir: "/nonexistent-tmp",
      routerHome: router,
      home,
    });
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    const dir = prep.env.CURSOR_CONFIG_DIR!;
    // The config lives beside hmr's state folder, which the writer's shell may write.
    expect(
      dir.startsWith(path.join(`${realpathSync(router)}.cursor-private`, "cursor-config")),
    ).toBe(true);
    expect(dir.startsWith(realpathSync(router) + path.sep)).toBe(false);
    // The worktree's sandbox.json gives the shell exactly hmr's state folder (Kai 12:21 AM PT).
    expect(JSON.parse(readFileSync(path.join(cwd, ".cursor", "sandbox.json"), "utf8"))).toEqual({
      additionalReadwritePaths: [realpathSync(router)],
    });
    const file = path.join(dir, "cli-config.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const config = JSON.parse(readFileSync(file, "utf8"));
    expect(config.approvalMode).toBe("allowlist");
    expect(config.sandbox.mode).toBe("enabled");
    expect(config.permissions.allow).not.toContain("Shell(*)");
    expect(config.privacyCache).toBeUndefined();
    expect(config.authInfo).toEqual({ email: "e", userId: 1 });
    // The worktree's live-loaded Cursor settings are never writable (review round 7).
    for (const rule of [
      "Write(./.cursor)",
      "Write(./.cursor/**)",
      `Write(${cwd}/.cursor)`,
      `Write(${cwd}/.cursor/**)`,
    ]) {
      expect(config.permissions.deny).toContain(rule);
    }
    // The global config is untouched.
    expect(
      JSON.parse(readFileSync(path.join(home, ".cursor", "cli-config.json"), "utf8")).approvalMode,
    ).toBe("unrestricted");
  });

  it("keeps safe keys, re-accepts its own entry, and still refuses any other writable root", () => {
    const home = tmp();
    const cwd = path.join(tmp(), "wt");
    mkdirSync(path.join(cwd, ".cursor"), { recursive: true });
    mkdirSync(path.join(home, ".cursor"));
    writeFileSync(
      path.join(home, ".cursor", "cli-config.json"),
      JSON.stringify({ version: 1, authInfo: { email: "e", userId: 1 } }),
    );
    const router = path.join(home, "router");
    const sandbox = path.join(cwd, ".cursor", "sandbox.json");
    writeFileSync(sandbox, JSON.stringify({ additionalReadonlyPaths: ["/ro"] }));
    const ctx = { cwd, laneId: "l", tempDir: "/nonexistent-tmp", routerHome: router, home };
    expect(prepareNativeLaunch(launchFor("cursor", "writer", home), ctx).ok).toBe(true);
    expect(JSON.parse(readFileSync(sandbox, "utf8"))).toEqual({
      additionalReadonlyPaths: ["/ro"],
      additionalReadwritePaths: [realpathSync(router)],
    });
    // A second launch in the same worktree accepts hmr's own entry.
    expect(prepareNativeLaunch(launchFor("cursor", "writer", home), ctx).ok).toBe(true);
    // Anything beyond exactly [state folder] refuses.
    for (const paths of [
      [realpathSync(router), "/outside"],
      ["/outside"],
      [`${realpathSync(router)}/..`],
    ]) {
      writeFileSync(sandbox, JSON.stringify({ additionalReadwritePaths: paths }));
      expect(prepareNativeLaunch(launchFor("cursor", "writer", home), ctx).ok).toBe(false);
    }
  });

  it("refuses a Cursor writer whose private folder would sit inside the temp dir", () => {
    const home = tmp();
    const cwd = path.join(tmp(), "wt");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(path.join(home, ".cursor"));
    writeFileSync(
      path.join(home, ".cursor", "cli-config.json"),
      JSON.stringify({ version: 1, authInfo: { email: "e", userId: 1 } }),
    );
    const prep = prepareNativeLaunch(launchFor("cursor", "writer", home), {
      cwd,
      laneId: "l",
      tempDir: home,
      routerHome: path.join(home, "router"),
      home,
    });
    expect(prep.ok).toBe(false);
  });

  it("refuses a Cursor writer when any sandbox.json could widen its shell sandbox", () => {
    for (const where of ["home", "parent", "cwd"] as const) {
      const home = tmp();
      const parent = tmp();
      const cwd = path.join(parent, "wt");
      mkdirSync(cwd);
      mkdirSync(path.join(home, ".cursor"));
      writeFileSync(
        path.join(home, ".cursor", "cli-config.json"),
        JSON.stringify({ version: 1, authInfo: { email: "e", userId: 1 } }),
      );
      const dir = where === "home" ? home : where === "parent" ? parent : cwd;
      mkdirSync(path.join(dir, ".cursor"), { recursive: true });
      writeFileSync(
        path.join(dir, ".cursor", "sandbox.json"),
        JSON.stringify({ additionalReadwritePaths: ["/outside"] }),
      );
      const prep = prepareNativeLaunch(launchFor("cursor", "writer", home), {
        cwd,
        laneId: "l",
        tempDir: "/nonexistent-tmp",
        routerHome: path.join(home, "router"),
        home,
      });
      expect(prep.ok).toBe(false);
      if (!prep.ok) expect(prep.error).toMatch(/sandbox\.json sets additionalReadwritePaths/);
    }
  });

  it("allows a Cursor sandbox.json that only narrows, and refuses unknown keys or bad JSON", () => {
    const dir = tmp();
    const file = path.join(dir, "sandbox.json");
    expect(cursorSandboxRefusal(file)).toBeUndefined();
    writeFileSync(file, JSON.stringify({ additionalReadonlyPaths: ["/x"] }));
    expect(cursorSandboxRefusal(file)).toBeUndefined();
    writeFileSync(file, JSON.stringify({ type: "insecure_none" }));
    expect(cursorSandboxRefusal(file)).toMatch(/sets type/);
    writeFileSync(file, "{");
    expect(cursorSandboxRefusal(file)).toMatch(/not valid JSON/);
  });

  it("refuses a Cursor writer whose worktree is inside its temp or router-home allow roots", () => {
    const router = tmp();
    const outside = realpathSync(mkdtempSync(path.join(os.homedir(), ".hmr-prep-wt-")));
    try {
      const roots = ["/nonexistent-tmp", router];
      expect(cursorWorktreeInsideAllowRoot(path.join(router, "wt"), roots)).toBe(router);
      expect(cursorWorktreeInsideAllowRoot(router.toUpperCase(), roots)).toBe(router);
      expect(cursorWorktreeInsideAllowRoot(tmp(), [os.tmpdir()])).toBeDefined();
      expect(cursorWorktreeInsideAllowRoot(outside, roots)).toBeUndefined();
      // The launch itself refuses such a worktree.
      const home = tmp();
      mkdirSync(path.join(home, ".cursor"));
      writeFileSync(
        path.join(home, ".cursor", "cli-config.json"),
        JSON.stringify({ version: 1, authInfo: { email: "e", userId: 1 } }),
      );
      const prep = prepareNativeLaunch(launchFor("cursor", "writer", router), {
        cwd: path.join(router, "wt"),
        laneId: "l",
        routerHome: router,
        home,
        tempDir: "/nonexistent-tmp",
      });
      expect(prep.ok).toBe(false);
      if (!prep.ok) expect(prep.error).toMatch(/a Cursor writer may write freely/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a Cursor writer when .cursor or its settings files are symlinks", () => {
    for (const kind of ["file", "dir"] as const) {
      const home = tmp();
      const cwd = tmp();
      mkdirSync(path.join(home, ".cursor"));
      writeFileSync(
        path.join(home, ".cursor", "cli-config.json"),
        JSON.stringify({ version: 1, authInfo: { email: "e", userId: 1 } }),
      );
      writeFileSync(path.join(cwd, "sandbox-settings.json"), "{}");
      if (kind === "file") {
        mkdirSync(path.join(cwd, ".cursor"));
        symlinkSync("../sandbox-settings.json", path.join(cwd, ".cursor", "sandbox.json"));
      } else {
        mkdirSync(path.join(cwd, "real-cursor"));
        symlinkSync("real-cursor", path.join(cwd, ".cursor"));
      }
      expect(cursorSettingsSymlink(cwd)).toBeDefined();
      const prep = prepareNativeLaunch(launchFor("cursor", "writer", home), {
        cwd,
        laneId: "l",
        tempDir: "/nonexistent-tmp",
        routerHome: path.join(home, "router"),
        home,
      });
      expect(prep.ok).toBe(false);
      if (!prep.ok) expect(prep.error).toMatch(/is a symlink/);
    }
    expect(cursorSettingsSymlink(tmp())).toBeUndefined();
  });

  it("never authorizes Cursor: no login record means no launch", () => {
    const home = tmp();
    mkdirSync(path.join(home, ".cursor"));
    writeFileSync(path.join(home, ".cursor", "cli-config.json"), "{}");
    const prep = prepareNativeLaunch(launchFor("cursor", "writer", home), {
      cwd: tmp(),
      laneId: "l",
      tempDir: "/nonexistent-tmp",
      routerHome: path.join(home, "router"),
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
