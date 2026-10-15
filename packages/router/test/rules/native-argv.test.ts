import { describe, expect, it } from "vitest";
import {
  BYPASS_FLAGS,
  missingCapabilities,
  CODEX_WRITER_PROFILE,
  codexWriterProfile,
  nativeLaunch,
  permissionProfile,
  type PermissionProfile,
} from "../../src/rules/native-argv.js";

const ROUTER_HOME = "/Users/u/Library/Application Support/model-router";
const WRITER_PROFILE = [
  'default_permissions="hmr-writer"',
  'permissions.hmr-writer.extends=":workspace"',
  `permissions.hmr-writer.filesystem={"${ROUTER_HOME}"="write"}`,
  "features.network_proxy.enabled=true",
  "permissions.hmr-writer.network.enabled=true",
  "permissions.hmr-writer.network.allow_local_binding=true",
  'permissions.hmr-writer.network.domains={"fonts.googleapis.com"="allow","fonts.gstatic.com"="allow"}',
];
const WRITER_PROFILE_ARGS = WRITER_PROFILE.flatMap((c) => ["-c", c]);

function argv(
  provider: Parameters<typeof nativeLaunch>[0]["provider"],
  model: string,
  effort: Parameters<typeof nativeLaunch>[0]["effort"],
  profile: PermissionProfile,
) {
  const built = nativeLaunch({ provider, model, effort }, profile, ROUTER_HOME);
  if (!built.ok) throw new Error(built.error);
  return built.launch;
}

const CLAUDE_READ = [
  "--permission-mode",
  "plan",
  "--allowedTools",
  "Read,Grep,Glob,WebFetch,WebSearch",
];
/** Written out, not imported: a missing key in the source must fail this test. */
const CLAUDE_WRITER_SETTINGS_JSON = expect.stringContaining(
  '"sandbox":{"enabled":true,"failIfUnavailable":true,"autoAllowBashIfSandboxed":true,"allowUnsandboxedCommands":false,',
);
const GROK_READ = [
  "--sandbox",
  expect.stringMatching(/^hmr-read-only-[0-9a-f]{8}$/),
  "--allow",
  "Read",
  "--allow",
  "Grep",
  "--allow",
  "WebFetch",
  "--allow",
  "WebSearch",
  "--deny",
  "Edit",
  "--deny",
  "Write",
  "--always-approve",
];

describe("native argv", () => {
  it.each([
    [
      "claude",
      "claude-opus-5-5",
      "xhigh",
      "writer",
      "claude",
      [
        "claude",
        "--model",
        "claude-opus-5-5",
        "--effort",
        "xhigh",
        "--permission-mode",
        "dontAsk",
        "--setting-sources",
        "",
        "--settings",
        CLAUDE_WRITER_SETTINGS_JSON,
      ],
    ],
    [
      "claude",
      "claude-opus-5-5",
      "high",
      "read-only",
      "claude",
      ["claude", "--model", "claude-opus-5-5", "--effort", "high", ...CLAUDE_READ],
    ],
    [
      "codex",
      "gpt-6.1-sol",
      "high",
      "writer",
      "codex",
      [
        "codex",
        "--model",
        "gpt-6.1-sol",
        "-c",
        'model_reasoning_effort="high"',
        "--ask-for-approval",
        "never",
        ...WRITER_PROFILE_ARGS,
      ],
    ],
    [
      "codex",
      "gpt-6.1-sol",
      "xhigh",
      "read-only",
      "codex",
      [
        "codex",
        "--model",
        "gpt-6.1-sol",
        "-c",
        'model_reasoning_effort="xhigh"',
        "--sandbox",
        "read-only",
        "--ask-for-approval",
        "never",
        "--search",
      ],
    ],
    [
      "grok",
      "grok-4.7",
      "xhigh",
      "writer",
      "grok",
      [
        "grok",
        "--model",
        "grok-4.7",
        "--reasoning-effort",
        "xhigh",
        "--sandbox",
        expect.stringMatching(/^hmr-writer-[0-9a-f]{8}$/),
        "--allow",
        "Edit(./**)",
        "--always-approve",
      ],
    ],
    [
      "grok",
      "grok-4.7",
      "medium",
      "read-only",
      "grok",
      ["grok", "--model", "grok-4.7", "--reasoning-effort", "medium", ...GROK_READ],
    ],
    [
      "cursor",
      "composer-2",
      null,
      "writer",
      "cursor",
      ["cursor-agent", "--model", "composer-2", "--sandbox", "enabled"],
    ],
    [
      "cursor",
      "composer-2",
      null,
      "read-only",
      "cursor",
      ["cursor-agent", "--model", "composer-2", "--mode", "plan"],
    ],
    [
      "opencode",
      "anthropic/claude-x",
      null,
      "writer",
      "opencode",
      ["opencode", "--model", "anthropic/claude-x"],
    ],
  ] as const)("%s %s@%s %s", (provider, model, effort, profile, kind, expected) => {
    const launch = argv(provider, model, effort, profile);
    expect(launch.kind).toBe(kind);
    expect(launch.argv).toEqual(expected);
    // Grok's --always-approve is allowed only together with an OS sandbox profile.
    const bypass = launch.argv.filter((arg) => BYPASS_FLAGS.includes(arg));
    expect(
      bypass.length === 0 ||
        (bypass[0] === "--always-approve" && launch.argv.includes("--sandbox")),
    ).toBe(true);
  });

  it("gives a writer Codex the hmr-writer profile: :workspace + hmr home + fonts + local binding", () => {
    const launch = argv("codex", "m", "high", "writer");
    // `--sandbox` would override default_permissions, so a writer must not pass it.
    expect(launch.argv).not.toContain("--sandbox");
    expect(launch.argv).not.toContain("danger-full-access");
    expect(launch.argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(launch.argv.join(" ")).not.toContain("network_access");
    expect(launch.argv.join(" ")).not.toContain("sandbox_mode");
    expect(launch.argv.join(" ")).not.toMatch(/"\*"/);
    expect(launch.argv.join(" ")).not.toContain("dangerously_allow");
    const overrides = launch.argv.filter((_, i) => launch.argv[i - 1] === "-c").slice(1);
    expect(overrides).toEqual(WRITER_PROFILE);
    expect(CODEX_WRITER_PROFILE).toBe("hmr-writer");
    expect(launch.expectedPermissionProfile).toBe("hmr-writer");
    expect(argv("codex", "m", "high", "read-only").expectedPermissionProfile).toBeUndefined();
  });

  it("gives read-only and control Codex lanes no writer profile", () => {
    for (const profile of ["read-only", "control"] as const) {
      const joined = argv("codex", "m", "high", profile).argv.join(" ");
      expect(joined).not.toContain("hmr-writer");
      expect(joined).not.toContain("network_proxy");
    }
    expect(argv("codex", "m", "high", "read-only").argv).toContain("--sandbox");
  });

  it("uses MODEL_ROUTER_HOME exactly when set, TOML-escapes it, and refuses a relative home", () => {
    expect(codexWriterProfile("/srv/hmr-home/")[2]).toBe(
      'permissions.hmr-writer.filesystem={"/srv/hmr-home/"="write"}',
    );
    expect(codexWriterProfile('/a "q"/b')[2]).toBe(
      'permissions.hmr-writer.filesystem={"/a \\"q\\"/b"="write"}',
    );
    expect(codexWriterProfile("/a\u007fb")[2]).toBe(
      'permissions.hmr-writer.filesystem={"/a\\u007Fb"="write"}',
    );
    expect(() => codexWriterProfile("rel/home")).toThrow(/not an absolute path/);
  });

  it("refuses a Codex writer with a relative home but leaves the other Codex profiles alone", () => {
    const lane = { provider: "codex" as const, model: "m", effort: null };
    const writer = nativeLaunch(lane, "writer", "../hmr-state");
    expect(writer.ok).toBe(false);
    if (!writer.ok) expect(writer.error).toMatch(/not an absolute path/);
    for (const profile of ["read-only", "control", "bypass"] as const) {
      const built = nativeLaunch(lane, profile, "../hmr-state");
      expect(built.ok).toBe(true);
      if (built.ok) expect(built.launch.argv.join(" ")).not.toContain("hmr-writer");
    }
  });

  it("defaults the Codex writer root to resolveHome()", () => {
    const prev = process.env.MODEL_ROUTER_HOME;
    process.env.MODEL_ROUTER_HOME = "/tmp/hmr-test-home";
    try {
      const built = nativeLaunch({ provider: "codex", model: "m", effort: null }, "writer");
      if (!built.ok) throw new Error(built.error);
      expect(built.launch.argv).toContain(
        'permissions.hmr-writer.filesystem={"/tmp/hmr-test-home"="write"}',
      );
    } finally {
      if (prev === undefined) delete process.env.MODEL_ROUTER_HOME;
      else process.env.MODEL_ROUTER_HOME = prev;
    }
  });

  it("makes a writer Claude exit, not run unsandboxed, when its sandbox cannot start", () => {
    const launch = argv("claude", "m", "high", "writer");
    const settings = launch.argv[launch.argv.indexOf("--settings") + 1];
    const parsed = JSON.parse(settings ?? "") as { permissions: { allow: string[] } };
    // dontAsk: nothing prompts; only these tools run, Edit/Write only in the worktree and hmr home.
    expect(parsed.permissions.allow).not.toContain("Bash");
    expect(parsed.permissions.allow.slice(0, 4)).toEqual(["Read", "Glob", "Grep", "Edit(./**)"]);
    expect(parsed.permissions.allow.some((rule) => rule.startsWith("Write("))).toBe(false);
    expect(parsed.permissions.allow.some((rule) => rule === "Edit(//**)")).toBe(false);
    expect({ sandbox: (parsed as unknown as { sandbox: unknown }).sandbox }).toEqual({
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        network: {
          allowedDomains: ["fonts.googleapis.com", "fonts.gstatic.com"],
          allowLocalBinding: true,
        },
      },
    });
  });

  it("allows a writer Claude only the Google Fonts hosts and local binding, nothing broader (Kai 2026-10-14)", () => {
    const launch = argv("claude", "m", "high", "writer");
    const settings = JSON.parse(launch.argv[launch.argv.indexOf("--settings") + 1] ?? "");
    expect(settings.sandbox.network.allowedDomains).toEqual([
      "fonts.googleapis.com",
      "fonts.gstatic.com",
    ]);
    expect(settings.sandbox.network.allowedDomains.some((d: string) => d.includes("*"))).toBe(
      false,
    );
    expect(settings.sandbox.network.allowLocalBinding).toBe(true);
    expect(settings.sandbox.filesystem).toBeUndefined();
    expect(settings.sandbox.network.allowAllUnixSockets).toBeUndefined();
    expect(settings.sandbox.enabled).toBe(true);
    expect(settings.sandbox.failIfUnavailable).toBe(true);
  });

  it("gives read-only Claude lanes no writer network settings", () => {
    const launch = argv("claude", "m", "high", "read-only");
    expect(launch.argv.join(" ")).not.toContain("allowLocalBinding");
    expect(launch.argv.join(" ")).not.toContain("fonts.googleapis.com");
  });

  it("gives a read-only Grok lane enforced rules, never the plan mode Grok ignores", () => {
    const launch = argv("grok", "grok-4.7", "high", "read-only");
    expect(launch.argv).not.toContain("--permission-mode");
    expect(launch.argv).not.toContain("plan");
    expect(launch.requiredHelp).toEqual([
      "--model",
      "--reasoning-effort",
      "--sandbox",
      "--allow",
      "--deny",
      "--always-approve",
    ]);
  });

  it("launches a coordinator with the CLI's ordinary permissions only", () => {
    expect(argv("claude", "m", "high", "control").argv).toEqual([
      "claude",
      "--model",
      "m",
      "--effort",
      "high",
    ]);
    expect(argv("codex", "m", null, "control").argv).toEqual(["codex", "--model", "m"]);
    expect(argv("grok", "m", null, "control").argv).toEqual(["grok", "--model", "m"]);
    expect(argv("cursor", "m", null, "control").argv).toEqual(["cursor-agent", "--model", "m"]);
  });

  it.each([
    ["claude", "--dangerously-skip-permissions"],
    ["codex", "--dangerously-bypass-approvals-and-sandbox"],
    ["grok", "--always-approve"],
    ["cursor", "--force"],
  ] as const)("passes %s's full bypass only for the bypass profile", (provider, flag) => {
    const bypass = argv(provider, "m", null, "bypass");
    expect(bypass.argv.filter((arg) => BYPASS_FLAGS.includes(arg))).toEqual([flag]);
    expect(bypass.requiredHelp).toContain(flag);
    // The bypass replaces the writer's own permission flags instead of mixing with them.
    expect(bypass.argv).not.toContain("--sandbox");
    expect(bypass.argv).not.toContain("--permission-mode");
    for (const profile of ["read-only", "writer", "control"] as const) {
      const launch = nativeLaunch({ provider, model: "m", effort: null }, profile);
      if (!launch.ok) continue;
      const flags = launch.launch.argv.filter((arg) => BYPASS_FLAGS.includes(arg));
      if (provider === "grok" && profile !== "control") {
        // Kai 2026-10-14 7:37 PM PT: Grok auto-approves only inside an OS sandbox profile.
        expect(flags).toEqual(["--always-approve"]);
        expect(launch.launch.argv).toContain("--sandbox");
      } else {
        expect(flags).toEqual([]);
      }
    }
  });

  it("fails closed for a read-only lane on a CLI without an enforceable read-only mode", () => {
    expect(nativeLaunch({ provider: "opencode", model: "x/y", effort: null }, "read-only")).toEqual(
      {
        ok: false,
        error:
          "opencode has no read-only mode the router can enforce; a read-only lane cannot run on it",
      },
    );
  });

  it("refuses a bypass on a CLI without a known bypass flag", () => {
    expect(nativeLaunch({ provider: "opencode", model: "x/y", effort: null }, "bypass")).toEqual({
      ok: false,
      error: "opencode has no permission-bypass flag the router knows; it was not launched",
    });
  });

  it("derives the profile from a plan's access and override", () => {
    expect(permissionProfile({ access: "read" })).toBe("read-only");
    expect(permissionProfile({ access: "read", permissions: "bypass" })).toBe("read-only");
    expect(permissionProfile({ access: "write" })).toBe("writer");
    expect(permissionProfile({ access: "write", permissions: "control" })).toBe("control");
    expect(permissionProfile({ access: "write", permissions: "bypass" })).toBe("bypass");
  });

  it("lists the flags and values each argv needs from the installed CLI's help", () => {
    expect(argv("claude", "m", "high", "read-only").requiredHelp).toEqual([
      "--model",
      "--effort",
      "--permission-mode",
      "--allowedTools",
      "plan",
    ]);
    expect(argv("claude", "m", "high", "writer").requiredHelp).toEqual([
      "--model",
      "--effort",
      "--permission-mode",
      "--setting-sources",
      "--settings",
      "dontAsk",
    ]);
    expect(argv("codex", "m", "high", "read-only").requiredHelp).toEqual([
      "--model",
      "-c",
      "--sandbox",
      "--ask-for-approval",
      "--search",
      "read-only",
      "never",
    ]);
    expect(argv("codex", "m", "high", "writer").requiredHelp).toEqual([
      "--model",
      "-c",
      "--ask-for-approval",
      "never",
    ]);
  });

  it("matches flags and values as whole words in help text", () => {
    const help = `Options:\n  -m, --model <MODEL>\n  --permission-mode <mode>  (choices: "acceptEdits", "plan")\n  -c, --config <key=value>\n  - on-request: The model decides`;
    expect(
      missingCapabilities(help, ["--model", "--permission-mode", "plan", "-c", "on-request"]),
    ).toEqual([]);
    expect(missingCapabilities(help, ["--effort", "--mode", "read-only", "request"])).toEqual([
      "--effort",
      "--mode",
      "read-only",
      "request",
    ]);
  });
});
