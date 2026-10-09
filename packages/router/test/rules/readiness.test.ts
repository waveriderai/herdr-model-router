import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractPaneText, screenVerdict, type ReadinessKind } from "../../src/rules/readiness.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/screens");
const screen = (name: string) => readFileSync(path.join(dir, `${name}.txt`), "utf8");

describe("screen readiness", () => {
  it.each([
    ["claude", "claude-ready"],
    ["claude", "claude-ready-narrow"],
    ["grok", "grok-ready"],
    ["cursor", "cursor-ready"],
    ["codex", "codex-ready"],
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
});
