/**
 * Decides, from the text of the lane's own pane, whether a native CLI is at its ordinary
 * prompt and may receive a task. Herdr's `idle` / `interactive_ready` is not enough: CLIs show
 * first-run trust, login, update and permission dialogs that look idle, and a typed task would
 * land in that dialog's hotkeys. The screen is untrusted data: it is only matched against
 * fixed patterns, never evaluated.
 */

export type ScreenVerdict =
  | { state: "ready" }
  | { state: "dialog"; dialog: string; reason: string }
  | { state: "not-ready"; reason: string };

export type ReadinessKind = "claude" | "codex" | "grok" | "cursor" | "opencode";

/** Removes ANSI CSI/OSC/other escape sequences and control characters. */
export function sanitizeScreen(raw: string): string {
  return (
    raw
      // OSC ... BEL or ST
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
      // CSI
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      // Other two-byte escapes
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b[@-Z\\-_]/g, "")
      .replace(/\r\n?/g, "\n")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
      .normalize("NFKC")
  );
}

/**
 * The pane text from `herdr pane read` output: plain text, or a JSON envelope carrying the
 * text. Anything else (no string text, empty after cleaning) is unreadable.
 */
export function extractPaneText(stdout: string | undefined): string | undefined {
  if (stdout === undefined) return undefined;
  let text = stdout;
  const trimmed = stdout.trim();
  if (trimmed.startsWith("{")) {
    try {
      const data = JSON.parse(trimmed) as {
        result?: { text?: unknown; content?: unknown; lines?: unknown };
      };
      const result = data.result;
      if (typeof result?.text === "string") text = result.text;
      else if (typeof result?.content === "string") text = result.content;
      else if (
        Array.isArray(result?.lines) &&
        result.lines.every((line) => typeof line === "string")
      )
        text = (result.lines as string[]).join("\n");
      else return undefined;
    } catch {
      // Not JSON after all; read it as text.
    }
  }
  const clean = sanitizeScreen(text);
  return clean.trim() === "" ? undefined : clean;
}

/**
 * Lowercased text with all whitespace and box-drawing removed, so a phrase still matches when
 * a narrow pane wraps it mid-word.
 */
export function compactScreen(text: string): string {
  return text.toLowerCase().replace(/[\s─-▟]/g, "");
}

interface DialogRule {
  dialog: string;
  patterns: (string | RegExp)[];
}

/** Startup and interactive dialogs. Any match refuses the prompt, even if a composer shows. */
const DIALOG_RULES: DialogRule[] = [
  {
    dialog: "workspace trust",
    patterns: [
      "quicksafetycheck",
      "isthisaprojectyoucreated",
      "oneyoutrust",
      "trustthisfolder",
      "trustthisworkspace",
      "trustthisdirectory",
      "trustthisrepository",
      "trustingworkspace",
      "workspacetrust",
      "doyoutrust",
      "trustthefiles",
    ],
  },
  {
    dialog: "update",
    patterns: [
      /\d\.update/,
      "updatenow",
      "updateavailable",
      "newversionavailable",
      "skipthisversion",
      "skipuntilnextversion",
      "restarttoupdate",
      "updaterequired",
      "pleaseupdate",
    ],
  },
  {
    dialog: "login",
    patterns: [
      "logintocontinue",
      "signintocontinue",
      "pleaselogin",
      "pleasesignin",
      "notloggedin",
      "selectloginmethod",
      "chooseloginmethod",
      "loginmethod",
      "authenticationrequired",
      "browsertoauthenticate",
      "pasteauthenticationcode",
      "pastecodehere",
      "enteryourapikey",
      "apikeyrequired",
      "sessionexpired",
    ],
  },
  {
    dialog: "permission or confirmation",
    patterns: [
      "doyouwanttoproceed",
      "doyouwantto",
      "(y/n)",
      "[y/n]",
      "areyousure",
      "allowonce",
      "allowalways",
      "entertoconfirm",
      "pressentertocontinue",
      "pressanykey",
      "permissionrequired",
      // Claude's startup warning. Its footer "bypass permissions on" is a mode, not a dialog.
      "bypasspermissionsmode",
    ],
  },
];

/** A selection cursor on a numbered option: an interactive menu, whatever it asks. */
const NUMBERED_MENU = /^\s*[❯›>▶►]\s*\d+[.)]\s*\S/;

export function detectDialog(text: string): { dialog: string; evidence: string } | undefined {
  const compact = compactScreen(text);
  for (const rule of DIALOG_RULES) {
    for (const pattern of rule.patterns) {
      const hit = typeof pattern === "string" ? compact.includes(pattern) : pattern.test(compact);
      if (hit) return { dialog: rule.dialog, evidence: String(pattern) };
    }
  }
  const menu = text.split("\n").find((line) => NUMBERED_MENU.test(line));
  return menu ? { dialog: "interactive menu", evidence: "numbered selection" } : undefined;
}

/**
 * The line a native CLI prints when its account is out of quota or past its usage limit,
 * matched from the start of a screen line (after the CLI's error glyph or `Error:` prefix),
 * lowercased with spaces collapsed. Each is an exhausted limit, never a warning such as
 * "approaching usage limit", and never a context-window limit.
 */
const QUOTA_LINES: { label: string; pattern: RegExp }[] = [
  // Claude Code: "Claude usage limit reached", "5-hour limit reached ∙ resets 3pm".
  {
    label: "limit reached",
    pattern:
      /^(?:claude )?(?:usage|\d+-hour|session|daily|weekly|opus weekly|monthly) limit reached\b/,
  },
  // Claude Code "You've hit your limit"; Codex and Cursor "You've hit your usage limit".
  { label: "hit your limit", pattern: /^you'?ve hit your (?:usage |rate )?limit\b/ },
  // OpenAI and xAI API errors surfaced by Codex and grok.
  {
    label: "quota exceeded",
    pattern: /^(?:quota exceeded|you exceeded your current quota|insufficient_quota)\b/,
  },
  { label: "rate limit exceeded", pattern: /^rate limit exceeded\b/ },
  { label: "out of credits", pattern: /^(?:you have )?(?:run out of|no more|out of) credits\b/ },
  // Codex after its own retries.
  {
    label: "HTTP 429 after retries",
    pattern: /^stream error: exceeded retry limit, last status: 429\b/,
  },
];

/** A CLI's error glyph, box border, or `Error:` prefix in front of its message. */
const ERROR_PREFIX = /^[\s■⎿⏺●✗✘×!›>│┃|]*(?:(?:api )?error:\s*)?/i;

function quotaLine(line: string, next = ""): string | undefined {
  const normalize = (value: string) =>
    value
      .replace(/[\u2018\u2019]/g, "'")
      .replace(ERROR_PREFIX, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const alone = normalize(line);
  if (alone === "") return undefined;
  // A narrow pane wraps the message: also read it joined with the next line.
  const joined = `${alone} ${next.replace(/\s+/g, " ").trim().toLowerCase()}`;
  return QUOTA_LINES.find(({ pattern }) => pattern.test(alone) || pattern.test(joined))?.label;
}

/** The line where the pane echoes what was typed: `> `, `› ` or `❯ `, maybe inside a box. */
const INPUT_MARKER = /^\s*(?:│\s*)?[>›❯]\s?/;
/** Lines a CLI draws for the model's turn or its own events: never a continued prompt echo. */
const OUTPUT_MARKER = /^\s*[⏺●•■⎿]/;

/**
 * Where each CLI prints its own error, as opposed to the model's output. Codex draws an error
 * event as `■ <message>` (model messages and tool calls start with `•`). Claude Code attaches
 * an API error to the user's message as `⎿ <message>` (model text and tool calls start with
 * `⏺`, and a tool result's `⎿` only ever follows a tool call). The grok CLI and Cursor agent
 * have no verified error line, so a quota error after a prompt is never read from them.
 */
const ERROR_MARKER: Partial<Record<string, RegExp>> = {
  codex: /^\s*■\s+/,
  claude: /^\s*⎿\s+/,
};

/**
 * The CLI's own quota or usage-limit error on this screen, as a short label, if any.
 *
 * Without `after` (a new pane, before any prompt, so no model output exists yet) any line may
 * carry it. After a prompt, the evidence must show the model never ran: the first line after
 * the pane's echo of the prompt (or Claude Code's `[Pasted text #N]` placeholder) is that
 * CLI's own error line, carrying the quota message. Any model output first, a CLI without a
 * verified error line, or a screen without the echo is never read as a quota error.
 */
export function detectQuota(
  text: string,
  after?: { sent: string; kind: string },
): string | undefined {
  const lines = text.split("\n");
  if (!after) {
    for (const [index, line] of lines.entries()) {
      const label = quotaLine(line, lines[index + 1]);
      if (label) return label;
    }
    return undefined;
  }
  const marker = ERROR_MARKER[after.kind];
  if (!marker) return undefined;
  const prompt = compactScreen(after.sent);
  const echoed = (content: string) => {
    const compact = compactScreen(content);
    return /^\[pastedtext#\d+/.test(compact) || (compact.length >= 6 && prompt.includes(compact));
  };
  let anchor = -1;
  lines.forEach((line, index) => {
    const input = INPUT_MARKER.exec(line);
    if (!input) return;
    const content = line.slice(input[0].length);
    const compact = compactScreen(content);
    // The echo's first line may be short ("Fix it"): it must then open the prompt.
    if (echoed(content) || (compact !== "" && prompt.startsWith(compact))) anchor = index;
  });
  if (anchor < 0) return undefined;
  let next = anchor + 1;
  // Skip blank lines and the wrapped rest of the echo.
  while (
    next < lines.length &&
    (lines[next]!.trim() === "" || (!OUTPUT_MARKER.test(lines[next]!) && echoed(lines[next]!)))
  ) {
    next += 1;
  }
  const first = lines[next];
  if (first === undefined || !marker.test(first)) return undefined;
  return quotaLine(first.replace(marker, ""), lines[next + 1]);
}

export function quotaReason(kind: string, label: string): string {
  return `${kind} reported a quota or usage-limit error ("${label}")`;
}

const RULE_LINE = /^\s*─{8,}\s*$/;

/**
 * Positive evidence that the CLI shows its ordinary prompt. Each check is specific to the
 * CLI's own composer; a CLI without one here is never considered ready.
 */
const COMPOSER: Record<ReadinessKind, ((lines: string[], compact: string) => boolean) | undefined> =
  {
    // `❯` input line between two horizontal rules, plus the mode or shortcuts footer.
    claude: (lines, compact) =>
      (compact.includes("shift+tabtocycle") || compact.includes("?forshortcuts")) &&
      (lines.some(
        (line, index) =>
          /^\s*[❯>](\s|$)/.test(line) &&
          RULE_LINE.test(lines[index - 1] ?? "") &&
          RULE_LINE.test(lines[index + 1] ?? ""),
      ) ||
        lines.some((line) => /^\s*│\s*>(\s|$)/.test(line))),
    // `│ ❯ │` input box, plus its shortcuts hint or model footer.
    grok: (lines, compact) =>
      lines.some((line) => /│\s*❯/.test(line)) &&
      (compact.includes("ctrl+.:shortcuts") || compact.includes("grok")),
    // `→` input line, plus the mode footer.
    cursor: (lines, compact) =>
      lines.some((line) => /^\s*→(\s|$)/.test(line)) && compact.includes("shift+tabtocycle"),
    // `›` input line (not a numbered menu), plus the composer footer.
    codex: (lines, compact) =>
      lines.some((line) => /^\s*›(\s|$)/.test(line) && !NUMBERED_MENU.test(line)) &&
      /(contextleft|forshortcuts|⏎send)/.test(compact),
    // No verified composer evidence for OpenCode: never ready.
    opencode: undefined,
  };

export function hasReadinessEvidence(kind: string): kind is ReadinessKind {
  return kind in COMPOSER && COMPOSER[kind as ReadinessKind] !== undefined;
}

/** The verdict for one screen of the lane's pane. */
export function screenVerdict(kind: ReadinessKind, text: string | undefined): ScreenVerdict {
  if (text === undefined) {
    return { state: "not-ready", reason: "the pane could not be read or showed no text" };
  }
  const dialog = detectDialog(text);
  if (dialog) {
    return {
      state: "dialog",
      dialog: dialog.dialog,
      reason: `${kind} is showing ${/^[aeiou]/.test(dialog.dialog) ? "an" : "a"} ${dialog.dialog} dialog. The router never answers it: open the ${kind} CLI yourself in this directory, finish that step, then route again`,
    };
  }
  const composer = COMPOSER[kind];
  if (!composer) {
    return {
      state: "not-ready",
      reason: `the router has no verified ready-prompt evidence for ${kind}`,
    };
  }
  const lines = text.split("\n");
  return composer(lines, compactScreen(text))
    ? { state: "ready" }
    : { state: "not-ready", reason: `no ordinary ${kind} input prompt is visible` };
}
