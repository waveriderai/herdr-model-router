import { describe, expect, it } from "vitest";
import {
  claudeCacheWarningOpen,
  codexInPlanMode,
  codexStatusEffort,
  inputLineState,
  inputLineText,
  lastClaudeOutcome,
  newClaudeOutcome,
} from "../../src/live-effort/pane-text.js";

const RULE = "─".repeat(40);
const DIM = (text: string) => `\u001b[2m${text}\u001b[0m`;

describe("inputLineState", () => {
  it("reads an empty Claude input box", () => {
    expect(inputLineState("claude", [RULE, "❯\u00a0", RULE, "  Opus 5.5 high"].join("\n"))).toBe(
      "empty",
    );
  });

  it("reads a Claude draft, including one wrapped onto the next line", () => {
    expect(inputLineState("claude", [RULE, "❯\u00a0lets push this", RULE].join("\n"))).toBe("busy");
    expect(inputLineState("claude", [RULE, "❯\u00a0", "  wrapped text", RULE].join("\n"))).toBe(
      "busy",
    );
  });

  it("treats dim placeholder text as empty", () => {
    expect(
      inputLineState("claude", [RULE, `❯\u00a0${DIM('Try "fix lint"')}`, RULE].join("\n")),
    ).toBe("empty");
    expect(
      inputLineState("codex", `› ${DIM("Ask Codex to do anything")}\n\n  GPT-6-Astra low`),
    ).toBe("empty");
  });

  it("uses the last prompt line, not one in the transcript above", () => {
    const screen = ["❯ /rename old", "  ⎿  Session renamed", RULE, "❯\u00a0", RULE].join("\n");
    expect(inputLineState("claude", screen)).toBe("empty");
  });

  it("fails closed when no input line is on screen", () => {
    expect(inputLineState("claude", "Working…")).toBe("unknown");
    expect(inputLineState("codex", "")).toBe("unknown");
  });

  it("ignores Codex's animated Braille particles on an empty input line", () => {
    const grey = (text: string) => `\u001b[38;2;163;165;169m${text}\u001b[0m`;
    const line = `› ${DIM("Ask Codex to do anything")}   ${grey("⠂")}      ${grey("⢀")}`;
    expect(inputLineState("codex", `${line}\n\n  GPT-6-Astra low`)).toBe("empty");
    expect(inputLineState("codex", `› fix it ${grey("⠂")}`)).toBe("busy");
  });

  it("reads a Codex draft", () => {
    expect(inputLineState("codex", "› half-typed\n")).toBe("busy");
  });
});

describe("extended-color SGR parameters are data, not attributes", () => {
  const ESC = "\u001b[";
  // Codex draws a draft on a true-color background: `48;2;r;g;b`. The 2 selects RGB.
  const rgbBackground = (text: string) => `${ESC}48;2;65;69;76m${text}${ESC}0m`;

  it("keeps a draft typed on a true-color background", () => {
    const line = `› ${rgbBackground("/status")}`;
    expect(inputLineText("codex", line)).toBe("/status");
    expect(inputLineState("codex", line)).toBe("busy");
    expect(inputLineText("codex", `${ESC}48;2;65;69;76m› /status${ESC}0m`)).toBe("/status");
  });

  it("keeps a dim placeholder dim when its colors have channels 0, 2 or 22", () => {
    const placeholders = [
      `${ESC}2;38;2;0;22;0mAsk Codex to do anything${ESC}0m`,
      `${ESC}2m${ESC}38;2;22;0;2mAsk Codex to do anything${ESC}0m`,
      `${ESC}2;48;2;0;0;0;38;5;22mAsk Codex to do anything${ESC}0m`,
    ];
    for (const placeholder of placeholders) {
      expect(inputLineText("codex", `› ${placeholder}`)).toBe("");
      expect(inputLineState("codex", `› ${placeholder}`)).toBe("empty");
    }
  });

  it("applies standalone 0, 2 and 22 as reset, dim and normal intensity", () => {
    expect(inputLineText("codex", `› ${ESC}2mhint${ESC}22mtyped`)).toBe("typed");
    expect(inputLineText("codex", `› ${ESC}0;2mhint${ESC}0mtyped`)).toBe("typed");
    expect(inputLineText("codex", `› ${ESC}1;2mhint${ESC}mtyped`)).toBe("typed");
    expect(inputLineText("codex", `› ${ESC}38;2;1;2;3;2mhint${ESC}0m`)).toBe("");
  });

  it("does not read 256-color index 2 or a colon-form color as dim", () => {
    expect(inputLineText("codex", `› ${ESC}38;5;2m/status${ESC}0m`)).toBe("/status");
    // An attribute after a 256-color index is still read.
    expect(inputLineText("codex", `› ${ESC}38;5;22;2mhint${ESC}0m`)).toBe("");
    expect(inputLineText("codex", `› ${ESC}2;38;5;0;22m/status${ESC}0m`)).toBe("/status");
    expect(inputLineText("codex", `› ${ESC}58;5;2m/status${ESC}0m`)).toBe("/status");
    expect(inputLineText("codex", `› ${ESC}48:2::65:69:76m/status${ESC}0m`)).toBe("/status");
  });

  it("treats a truncated extended color as ending the line's attributes safely", () => {
    // An incomplete escape stops reading the line, as before: nothing after it is trusted.
    expect(inputLineText("codex", `› typed${ESC}48;2;65`)).toBe("typed");
    // A color cut short of its channels does not turn anything after it dim or normal.
    expect(inputLineText("codex", `› ${ESC}2m${ESC}38;2mhint${ESC}0m`)).toBe("");
  });
});

describe("Codex screen", () => {
  it("reads the effort from the model-with-reasoning status item", () => {
    expect(codexStatusEffort("  GPT-6-Astra medium · ~/Code/x")).toBe("medium");
    expect(codexStatusEffort("  gpt-6-astra xhigh")).toBe("xhigh");
    expect(codexStatusEffort("  ~/Code/x")).toBeUndefined();
  });

  it("detects Plan mode from the footer", () => {
    expect(codexInPlanMode("  gpt-6-astra medium    Plan mode (shift+tab to cycle)")).toBe(true);
    expect(codexInPlanMode("  gpt-6-astra medium")).toBe(false);
    // Codex 0.156.1 drops the hint when the status line is shown.
    expect(
      codexInPlanMode("› x\n\n  GPT-6-Astra medium · ~/Code/x      Plan mode    ⚠ 7 warnings"),
    ).toBe(true);
    expect(
      codexInPlanMode("• Wrote the Plan mode notes\n› \n\n  GPT-6-Astra medium\n  footer"),
    ).toBe(false);
  });
});

describe("Claude /effort outcomes", () => {
  it("recognizes each outcome", () => {
    expect(
      lastClaudeOutcome("⎿  Set effort level to high (this session only): x")?.outcome,
    ).toEqual({
      kind: "session-only",
      level: "high",
    });
    expect(
      lastClaudeOutcome("⎿  Set effort level to high (saved as your default for new sessions)")
        ?.outcome,
    ).toEqual({ kind: "saved-default", level: "high" });
    // The dialog is read from the bottom of the screen, never from scrollback.
    expect(lastClaudeOutcome("Change effort level?")).toBeUndefined();
    expect(claudeCacheWarningOpen("work\nChange effort level?\n❯ 1. Yes, switch to high")).toBe(
      true,
    );
    expect(
      claudeCacheWarningOpen(
        ["Change effort level?", ...Array.from({ length: 14 }, (_, i) => `later ${i}`)].join("\n"),
      ),
    ).toBe(false);
    expect(lastClaudeOutcome("  ⎿  Kept effort level as medium")?.outcome).toEqual({
      kind: "kept",
      level: "medium",
    });
  });

  it("ignores an outcome that was already the latest one before the switch", () => {
    const old = "⎿  Set effort level to high (this session only): x";
    expect(newClaudeOutcome(old, `${old}\nmore output`)).toBeUndefined();
  });

  it("accepts a repeat of the same message when it is new", () => {
    const old = "⎿  Set effort level to high (this session only): x";
    expect(newClaudeOutcome(old, `${old}\n${old}`)).toEqual({
      kind: "session-only",
      level: "high",
    });
  });

  it("accepts a different latest outcome", () => {
    const before = "⎿  Set effort level to high (this session only): x";
    const after = `${before}\n⎿  Set effort level to low (this session only): x`;
    expect(newClaudeOutcome(before, after)).toEqual({ kind: "session-only", level: "low" });
  });
});
