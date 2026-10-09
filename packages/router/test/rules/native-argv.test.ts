import { describe, expect, it } from "vitest";
import { BYPASS_FLAGS, missingCapabilities, nativeLaunch } from "../../src/rules/native-argv.js";

function argv(
  provider: Parameters<typeof nativeLaunch>[0]["provider"],
  model: string,
  effort: Parameters<typeof nativeLaunch>[0]["effort"],
  access: "read" | "write",
) {
  const built = nativeLaunch({ provider, model, effort }, access);
  if (!built.ok) throw new Error(built.error);
  return built.launch;
}

describe("native argv", () => {
  it.each([
    [
      "claude",
      "claude-opus-5-5",
      "xhigh",
      "write",
      "claude",
      ["claude", "--model", "claude-opus-5-5", "--effort", "xhigh"],
    ],
    [
      "claude",
      "claude-opus-5-5",
      "high",
      "read",
      "claude",
      ["claude", "--model", "claude-opus-5-5", "--effort", "high", "--permission-mode", "plan"],
    ],
    [
      "codex",
      "gpt-6.1-sol",
      "high",
      "write",
      "codex",
      ["codex", "--model", "gpt-6.1-sol", "-c", 'model_reasoning_effort="high"'],
    ],
    [
      "codex",
      "gpt-6.1-sol",
      "xhigh",
      "read",
      "codex",
      [
        "codex",
        "--model",
        "gpt-6.1-sol",
        "-c",
        'model_reasoning_effort="xhigh"',
        "--sandbox",
        "read-only",
      ],
    ],
    [
      "grok",
      "grok-4.7",
      "xhigh",
      "write",
      "grok",
      ["grok", "--model", "grok-4.7", "--reasoning-effort", "xhigh"],
    ],
    [
      "grok",
      "grok-4.7",
      "medium",
      "read",
      "grok",
      ["grok", "--model", "grok-4.7", "--reasoning-effort", "medium", "--permission-mode", "plan"],
    ],
    ["cursor", "composer-2", null, "write", "cursor", ["cursor-agent", "--model", "composer-2"]],
    [
      "cursor",
      "composer-2",
      null,
      "read",
      "cursor",
      ["cursor-agent", "--model", "composer-2", "--mode", "plan"],
    ],
    [
      "opencode",
      "anthropic/claude-x",
      null,
      "write",
      "opencode",
      ["opencode", "--model", "anthropic/claude-x"],
    ],
  ] as const)("%s %s@%s %s", (provider, model, effort, access, kind, expected) => {
    const launch = argv(provider, model, effort, access);
    expect(launch.kind).toBe(kind);
    expect(launch.argv).toEqual(expected);
    expect(launch.argv.some((arg) => BYPASS_FLAGS.includes(arg))).toBe(false);
  });

  it("fails closed for a read-only lane on a CLI without an enforceable read-only mode", () => {
    expect(nativeLaunch({ provider: "opencode", model: "x/y", effort: null }, "read")).toEqual({
      ok: false,
      error:
        "opencode has no read-only mode the router can enforce; a read-only lane cannot run on it",
    });
  });

  it("lists the flags each argv needs from the installed CLI's help", () => {
    expect(argv("claude", "m", "high", "read").requiredHelp).toEqual([
      "--model",
      "--effort",
      "--permission-mode",
      "plan",
    ]);
    expect(argv("codex", "m", "high", "read").requiredHelp).toEqual([
      "--model",
      "-c",
      "--sandbox",
      "read-only",
    ]);
  });

  it("matches flags as whole words in help text", () => {
    const help = `Options:\n  -m, --model <MODEL>\n  --permission-mode <mode>  (choices: "acceptEdits", "plan")\n  -c, --config <key=value>`;
    expect(missingCapabilities(help, ["--model", "--permission-mode", "plan", "-c"])).toEqual([]);
    expect(missingCapabilities(help, ["--effort", "--mode", "read-only"])).toEqual([
      "--effort",
      "--mode",
      "read-only",
    ]);
  });
});
