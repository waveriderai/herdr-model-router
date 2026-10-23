import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  extractPaneText,
  screenVerdict,
  type ReadinessKind,
  detectSandboxFailure,
} from "../../src/rules/readiness.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/screens");
const screen = (name: string) => readFileSync(path.join(dir, `${name}.txt`), "utf8");

describe("screen readiness", () => {
  it.each([
    ["claude", "claude-ready"],
    ["claude", "claude-ready-narrow"],
    ["grok", "grok-ready"],
    ["cursor", "cursor-ready"],
    ["cursor", "cursor-ready-2026-10-14"],
    ["cursor", "cursor-ready-auto-run"],
    ["codex", "codex-ready"],
    ["codex", "codex-ready-narrow"],
    ["codex", "codex-ready-narrow-12col"],
    ["codex", "codex-ready-narrow-9col"],
    ["codex", "codex-update-banner-narrow"],
  ] as const)("%s at its ordinary prompt (%s) is ready", (kind, name) => {
    expect(screenVerdict(kind, extractPaneText(screen(name)))).toEqual({ state: "ready" });
  });

  it.each([
    ["claude", "claude-trust", "workspace trust"],
    ["claude", "claude-trust-narrow", "workspace trust"],
    ["cursor", "cursor-trust", "workspace trust"],
    ["codex", "codex-update", "update"],
    ["codex", "codex-update-narrow", "update"],
    ["claude", "claude-login", "login"],
    ["grok", "grok-login", "login"],
    ["grok", "generic-confirm", "permission or confirmation"],
  ] as const)("%s showing %s is a %s dialog, even next to a composer", (kind, name, dialog) => {
    const verdict = screenVerdict(kind, extractPaneText(screen(name)));
    expect(verdict).toMatchObject({ state: "dialog", dialog });
    expect(verdict.state === "dialog" && verdict.reason).toContain(
      "The router never answers it: open the",
    );
  });

  it("does not accept one CLI's prompt as another's", () => {
    expect(screenVerdict("cursor", screen("claude-ready")).state).toBe("not-ready");
    expect(screenVerdict("claude", screen("grok-ready")).state).toBe("not-ready");
    expect(screenVerdict("codex", screen("cursor-ready")).state).toBe("not-ready");
  });

  it("strips ANSI and OSC sequences before matching", () => {
    const ansi = screen("claude-ready")
      .split("\n")
      .map((line) => `\u001b[2m\u001b]0;title\u0007${line}\u001b[0m\r`)
      .join("\n");
    expect(screenVerdict("claude", extractPaneText(ansi))).toEqual({ state: "ready" });
    const trust = `\u001b[1mTrust\u001b[0m this \u001b[38;5;2mworkspace\u001b[0m [a]`;
    expect(screenVerdict("cursor", extractPaneText(trust))).toMatchObject({ state: "dialog" });
  });

  it("reads a JSON envelope and rejects one without text", () => {
    expect(
      screenVerdict(
        "grok",
        extractPaneText(JSON.stringify({ result: { text: screen("grok-ready") } })),
      ),
    ).toEqual({ state: "ready" });
    expect(extractPaneText(JSON.stringify({ result: { pane: "w1:p1" } }))).toBeUndefined();
  });

  it.each([undefined, "", "   \n\n", "\u001b[2J\u001b[H"])(
    "fails closed on unreadable or empty UI (%j)",
    (raw) => {
      expect(screenVerdict("claude", extractPaneText(raw))).toEqual({
        state: "not-ready",
        reason: "the pane could not be read or showed no text",
      });
    },
  );

  it("never treats text without a composer as ready, and has no evidence for opencode", () => {
    expect(screenVerdict("claude", "Loading…\n")).toMatchObject({ state: "not-ready" });
    for (const kind of ["claude", "grok", "cursor", "codex"] as ReadinessKind[]) {
      expect(screenVerdict(kind, "user@host project % ")).toMatchObject({ state: "not-ready" });
    }
    expect(screenVerdict("opencode", "anything")).toEqual({
      state: "not-ready",
      reason: "the router has no verified ready-prompt evidence for opencode",
    });
  });

  it("reads Claude's bypass footer as a mode, but its startup warning as a dialog", () => {
    const ready = screen("claude-ready");
    const bypassOn = ready.replace("⏸ plan mode on", "⏵⏵ bypass permissions on");
    expect(screenVerdict("claude", extractPaneText(bypassOn))).toEqual({ state: "ready" });
    const warning = [
      "WARNING: Claude Code running in Bypass Permissions mode",
      "❯ 1. No, exit",
      "  2. Yes, I accept",
    ].join("\n");
    expect(screenVerdict("claude", extractPaneText(warning))).toMatchObject({
      state: "dialog",
      dialog: "permission or confirmation",
    });
  });
});

describe("detectSandboxFailure (fail closed)", () => {
  it("flags a CLI that started without its sandbox", () => {
    expect(detectSandboxFailure("warning: Sandbox not supported on this platform\n> ")).toMatch(
      /not supported/,
    );
    expect(detectSandboxFailure("Sandbox could not be applied: seatbelt error")).toMatch(
      /could not be applied/,
    );
  });
  it("ignores ordinary screens", () => {
    expect(detectSandboxFailure("grok  workspace sandbox\n> ")).toBeUndefined();
    expect(detectSandboxFailure(undefined)).toBeUndefined();
  });
});

describe("cursor readiness in allowlist mode (AGENT-285)", () => {
  it("accepts the fresh composer with no run-mode footer", () => {
    const screen =
      "  Cursor Agent\n  v2026.10.14-0f9edde\n  → Plan, search, build anything\n  Composer 2.5\n  ~/wt · main\n";
    expect(screenVerdict("cursor", screen).state).toBe("ready");
  });
  it("does not accept the placeholder text inside other output", () => {
    expect(screenVerdict("cursor", "  echo → Plan, search, build anything later\n").state).toBe(
      "not-ready",
    );
  });
});

describe("claude readiness in a narrow pane under dontAsk (AGENT-285)", () => {
  it("accepts the composer when the footer is cut to the mode name", () => {
    const rule = "─".repeat(29);
    const screen = `           Claude Code\n${rule}\n❯ Try "fix lint errors"\n${rule}\n  ⏵⏵ don't ask on      · ←…\n`;
    expect(screenVerdict("claude", screen).state).toBe("ready");
  });
});

describe("codex readiness in a narrow Herdr split (AGENT-285)", () => {
  it("accepts the composer when the footer is cut", () => {
    for (const footer of ["  ? for  ⚠ 2 · f2", "  ? fo…", "  ? for"]) {
      const screen = `› Ask Codex to do\n\n  GPT-6.1-Sol xhi…\n${footer}\n`;
      expect(screenVerdict("codex", screen).state).toBe("ready");
      // Through the production path, which NFKC-normalizes "…" to "..." (PR #25 review).
      expect(screenVerdict("codex", extractPaneText(screen)).state).toBe("ready");
    }
  });

  it("never takes a wrapped numbered menu with a cut footer for the composer (PR #25 review 2)", () => {
    for (const menu of [
      "› 1.\n   Choose\n   model\n  ? fo…\n",
      "› 2)\n  ? for  ⚠ 2 · f2\n",
      "›\n  ? for\n",
    ]) {
      expect(screenVerdict("codex", extractPaneText(menu)).state).not.toBe("ready");
    }
  });

  it("still needs the composer line and a footer", () => {
    expect(screenVerdict("codex", "  GPT-6.1-Sol xhi…\n  ? for  ⚠ 2 · f2\n").state).not.toBe(
      "ready",
    );
    expect(screenVerdict("codex", "› Ask Codex to do\n\n  GPT-6.1-Sol xhi…\n").state).not.toBe(
      "ready",
    );
  });
});

describe("codex readiness with a cut footer or an update banner (AGENT-231)", () => {
  it("accepts a footer cut to its warning count only below the composer", () => {
    expect(screenVerdict("codex", extractPaneText("› Ask Co\n\n  GPT-6.…\n  ?  ⚠ 2\n")).state).toBe(
      "ready",
    );
    expect(screenVerdict("codex", extractPaneText("› Ask\n\n  GPT…\n  ⚠ 2\n")).state).toBe("ready");
  });

  it.each([
    ["a bare ?", "› Ask Co\n\n  GPT-6.…\n  ?\n"],
    ["a footer above the composer", "  ?  ⚠ 2\n› Ask Co\n"],
    ["no composer", "  GPT-6.…\n  ?  ⚠ 2\n"],
    ["a numbered menu", "› 1.\n  ?  ⚠ 2\n"],
    ["a ? line with other text", "› Ask Co\n  ?  x 2\n"],
  ])("does not take %s for a ready composer", (_name, text) => {
    expect(screenVerdict("codex", extractPaneText(text)).state).not.toBe("ready");
  });

  it("is ready behind Codex's non-blocking update banner in a wide pane", () => {
    const rule = "─".repeat(60);
    const wide = [
      `╭${rule}╮`,
      "│ ✨ Update available! 0.163.0 -> 0.164.0                                   │",
      "│ Run npm install -g @openai/codex to update.                                │",
      "│ See full release notes: https://github.com/openai/codex/releases/latest    │",
      `╰${rule}╯`,
      "",
      "› Ask Codex to do anything",
      "",
      "  ? for shortcuts",
    ].join("\n");
    expect(screenVerdict("codex", extractPaneText(wide))).toEqual({ state: "ready" });
  });
});
