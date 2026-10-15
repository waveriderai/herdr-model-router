import { describe, expect, it } from "vitest";
import {
  BYPASS_FLAGS,
  missingCapabilities,
  codexWritableRoots,
  nativeLaunch,
  permissionProfile,
  type PermissionProfile,
} from "../../src/rules/native-argv.js";

const ROUTER_HOME = "/Users/u/Library/Application Support/model-router";
const ROUTER_ROOTS = `sandbox_workspace_write.writable_roots=["${ROUTER_HOME}"]`;

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
const CLAUDE_WRITER_SETTINGS_JSON =
  '{"sandbox":{"enabled":true,"failIfUnavailable":true,"autoAllowBashIfSandboxed":true,"allowUnsandboxedCommands":true,"network":{"allowedDomains":["fonts.googleapis.com","fonts.gstatic.com"],"allowLocalBinding":true}}}';
const GROK_READ = [
  "--sandbox",
  "read-only",
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
        "acceptEdits",
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
        "--sandbox",
        "workspace-write",
        "--ask-for-approval",
        "on-request",
        "-c",
        ROUTER_ROOTS,
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
        "workspace",
        "--allow",
        "Edit(./**)",
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
    expect(launch.argv.some((arg) => BYPASS_FLAGS.includes(arg))).toBe(false);
  });

  it("gives a writer Codex exactly hmr's state directory as its one extra writable root", () => {
    const launch = argv("codex", "m", "high", "writer");
    expect(launch.argv).toContain("workspace-write");
    expect(launch.argv).not.toContain("danger-full-access");
    const roots = launch.argv.filter((a) => a.startsWith("sandbox_workspace_write."));
    expect(roots).toEqual([`sandbox_workspace_write.writable_roots=["${ROUTER_HOME}"]`]);
    expect(launch.argv.join(" ")).not.toMatch(/writable_roots=\["\/Users\/u\/Library"\]/);
  });

  it("adds no writable roots to read-only, control or bypass Codex lanes", () => {
    for (const profile of ["read-only", "control"] as const) {
      expect(argv("codex", "m", "high", profile).argv.join(" ")).not.toContain("writable_roots");
    }
  });

  it("uses MODEL_ROUTER_HOME exactly when set, and refuses a relative home", () => {
    expect(codexWritableRoots("/srv/hmr-home/")).toBe(
      'sandbox_workspace_write.writable_roots=["/srv/hmr-home/"]',
    );
    expect(codexWritableRoots('/a "q"/b')).toBe(
      'sandbox_workspace_write.writable_roots=["/a \\"q\\"/b"]',
    );
    expect(() => codexWritableRoots("rel/home")).toThrow(/not an absolute path/);
  });

  it("defaults the Codex writer root to resolveHome()", () => {
    const prev = process.env.MODEL_ROUTER_HOME;
    process.env.MODEL_ROUTER_HOME = "/tmp/hmr-test-home";
    try {
      const built = nativeLaunch({ provider: "codex", model: "m", effort: null }, "writer");
      if (!built.ok) throw new Error(built.error);
      expect(built.launch.argv).toContain(
        'sandbox_workspace_write.writable_roots=["/tmp/hmr-test-home"]',
      );
    } finally {
      if (prev === undefined) delete process.env.MODEL_ROUTER_HOME;
      else process.env.MODEL_ROUTER_HOME = prev;
    }
  });

  it("makes a writer Claude exit, not run unsandboxed, when its sandbox cannot start", () => {
    const launch = argv("claude", "m", "high", "writer");
    const settings = launch.argv[launch.argv.indexOf("--settings") + 1];
    expect(JSON.parse(settings ?? "")).toEqual({
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: true,
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
      if (launch.ok)
        expect(launch.launch.argv.some((arg) => BYPASS_FLAGS.includes(arg))).toBe(false);
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
      "--settings",
      "acceptEdits",
    ]);
    expect(argv("codex", "m", "high", "read-only").requiredHelp).toEqual([
      "--model",
      "-c",
      "--sandbox",
      "--search",
      "read-only",
    ]);
    expect(argv("codex", "m", "high", "writer").requiredHelp).toEqual([
      "--model",
      "-c",
      "--sandbox",
      "--ask-for-approval",
      "workspace-write",
      "on-request",
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
