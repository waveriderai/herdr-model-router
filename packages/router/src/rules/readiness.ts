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
    // Only text of an interactive prompt. Codex 0.164.0 prints a non-blocking "Update
    // available!" banner into history above its normal composer, so a bare "update available"
    // or "new version available" notice is not a dialog (AGENT-231). A numbered update menu is
    // still caught by `\d.update` and by NUMBERED_MENU.
    dialog: "update",
    patterns: [
      /\d\.update/,
      "updatenow",
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
const OUTPUT_MARKER = /^\s*[⏺●•■⎿⬢]/;
/** Claude Code's placeholder for a long pasted prompt. */
const PASTED = /^\[pastedtext#\d+/;

/**
 * Where each CLI prints its own error, as opposed to the model's output. Codex draws an error
 * event as `■ <message>` (model messages and tool calls start with `•`). Claude Code attaches
 * an API error to the user's message as `⎿ <message>` (model text and tool calls start with
 * `⏺`, and a tool result's `⎿` only ever follows a tool call).
 */
const ERROR_MARKER: Partial<Record<string, RegExp>> = {
  codex: /^\s*■\s+/,
  claude: /^\s*⎿\s+/,
};

/**
 * The grok CLI and the Cursor agent have no error glyph of their own. For them the turn must
 * be the CLI's error message and nothing else: it sits alone between the echo of the prompt
 * and the composer the CLI draws again once the turn ends (grok's token line or `│ ❯ │` box,
 * Cursor's `→` line), in at most this many lines, and reads as {@link BARE_QUOTA_MESSAGE}.
 */
const COMPOSER_START: Partial<Record<string, RegExp>> = {
  grok: /^\s*(?:[\d.]+[KM]? \/ [\d.]+[KM]?\b|╭)|│\s*❯/,
  cursor: /^\s*(?:[│┌]\s*)?→/,
};
const MAX_BARE_MESSAGE_LINES = 3;

/** A time zone: an IANA name (`America/Los_Angeles`), UTC or GMT with an offset, or `PT`. */
const ZONE = String.raw`(?:(?:africa|america|antarctica|asia|atlantic|australia|europe|indian|pacific|etc)(?:/[a-z_+-]+)+|(?:utc|gmt)(?:[+-]\d{1,2}(?::?\d{2})?)?|[+-]\d{1,2}(?::?\d{2})?|[pmce][sd]?t)`;

/**
 * One word of when a limit resets: `3pm`, `4 days`, `tomorrow`, `Oct 14`, or a time zone,
 * bare or in parentheses (`(America/Los_Angeles)`). Nothing else may stand in parentheses.
 */
const TIME_WORD = String.raw`(?:\d[\d:./]*(?:\s?(?:am|pm)|[dhms]\b)?|am|pm|today|tomorrow|tonight|later|soon|midnight|noon|(?:mon|tues|wednes|thurs|fri|satur|sun)day|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?|days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|weeks?|a few|a moment|an? (?:hour|minute|day|week)|${ZONE}|\(${ZONE}\))`;
const TIMES = String.raw`${TIME_WORD}(?:(?:\s*,\s*|\s+(?:(?:and|at|on)\s+)?)${TIME_WORD})*`;

/**
 * The CLI's own advice after a quota message, each item whole: when the limit resets, to try
 * again or retry (with only a time after it), to upgrade, to switch models, or to check the
 * plan. Nothing else may follow, so a summary such as `Try again later is now shown with a
 * countdown.` is not advice.
 */
const ADVICE = [
  String.raw`(?:your )?(?:limit |usage |quota )?(?:will )?resets?(?: (?:at|in|on|after))? ${TIMES}`,
  String.raw`(?:please )?(?:try again|retry)(?:(?: (?:in|at|after|on))? ${TIMES})?`,
  String.raw`upgrade(?: to (?:pro|ultra|max|plus|team|a higher plan|a paid plan|continue))?(?: (?:for|to get) (?:more|higher) (?:usage|limits))?(?: to continue)?`,
  String.raw`switch to (?:auto|a different model|another model)(?: to continue)?`,
  String.raw`get cursor pro(?: for more agent usage)?`,
  String.raw`(?:please )?check your plan(?: and billing details)?`,
].join("|");

/** What a limit is for: a model id (with a digit or a dash), or the current period. */
const QUALIFIER = String.raw`(?: for (?:model )?(?:[\w.@:/]*[\d-][\w.@:/-]*|(?:this|the current|the) (?:cycle|month|week|day|period|billing (?:cycle|period))))?`;

/**
 * A whole quota error as a CLI prints it, lowercased with its lines joined: an optional
 * `Error:` prefix, the exhausted-limit phrase, an optional {@link QUALIFIER} and HTTP 429,
 * then only whole items of {@link ADVICE}. A sentence that merely starts with the phrase,
 * such as a writer's summary "Rate limit exceeded is now retried.", is not one.
 */
const BARE_QUOTA_MESSAGE = new RegExp(
  String.raw`^(?:error:\s*)?` +
    String.raw`(?:(?:usage|\d+-hour|session|daily|weekly|monthly) limit reached` +
    String.raw`|you'?ve hit your (?:usage |rate )?limit` +
    String.raw`|quota exceeded|you exceeded your current quota|insufficient_quota` +
    String.raw`|rate limit exceeded` +
    String.raw`|(?:you have )?(?:run out of|no more|out of) credits)` +
    QUALIFIER +
    String.raw`(?:\s*\(?(?:http |status )?429\)?)?` +
    String.raw`(?:(?:\s*[.!]\s*|\s*[·∙,;-]\s*|\s+)(?:or\s+)?(?:${ADVICE}))*` +
    String.raw`\s*[.!]?$`,
);

/**
 * The index of the last line of the pane's echo of `sent`, or undefined when the screen does
 * not show it where the real echo must be. The echo is an input line that opens the prompt and
 * goes on to its whole text (or Claude Code's `[Pasted text #N]` placeholder), and every line
 * above it was already on the pane's screen just before the prompt (`before`), with at least
 * one of them showing. A line that quotes the prompt in the model's output has output above it,
 * and once the real echo scrolls off, nothing on the screen is taken as the echo.
 */
function promptEchoEnd(lines: string[], sent: string, before: string): number | undefined {
  const prompt = compactScreen(sent);
  if (prompt === "") return undefined;
  const earlier = new Set(before.split("\n").map(compactScreen));
  let above = 0;
  for (const [index, line] of lines.entries()) {
    const compact = compactScreen(line);
    const input = INPUT_MARKER.exec(line);
    if (input && above > 0) {
      const content = compactScreen(line.slice(input[0].length));
      if (PASTED.test(content)) return index;
      if (content !== "" && prompt.startsWith(content)) {
        let echo = content;
        let end = index;
        for (let next = index + 1; next < lines.length; next += 1) {
          const more = compactScreen(lines[next]!);
          if (more === "") continue;
          if (OUTPUT_MARKER.test(lines[next]!) || !prompt.startsWith(echo + more)) break;
          echo += more;
          end = next;
        }
        if (echo === prompt) return end;
      }
    }
    if (compact === "") continue;
    // Anything above the echo that was not on the screen before the prompt is model output.
    if (!earlier.has(compact)) return undefined;
    above += 1;
  }
  return undefined;
}

/**
 * The CLI's own quota or usage-limit error on this screen, as a short label, if any.
 *
 * Without `after` (a new pane, before any prompt, so no model output exists yet) any line may
 * carry it. After a prompt, the evidence must show the model never ran, counted from the
 * pane's echo of the prompt below the screen it showed before (`after.before`): for Codex and
 * Claude Code the first line after the echo is that CLI's own error line carrying the message;
 * for grok and Cursor the whole turn is the CLI's quota message, alone before the composer.
 * Any model output first, a screen without the echo where it belongs, or a CLI with neither
 * rule is never read as a quota error.
 */
export function detectQuota(
  text: string,
  after?: { sent: string; kind: string; before: string },
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
  const composer = COMPOSER_START[after.kind];
  if (!marker && !composer) return undefined;
  const echoEnd = promptEchoEnd(lines, after.sent, after.before);
  if (echoEnd === undefined) return undefined;
  const rest = lines.slice(echoEnd + 1);
  if (marker) {
    const next = rest.findIndex((line) => line.trim() !== "");
    const first = rest[next];
    if (first === undefined || !marker.test(first)) return undefined;
    return quotaLine(first.replace(marker, ""), rest[next + 1]);
  }
  const stop = rest.findIndex((line) => composer!.test(line));
  if (stop < 0) return undefined;
  const turn = rest.slice(0, stop).filter((line) => compactScreen(line) !== "");
  if (
    turn.length === 0 ||
    turn.length > MAX_BARE_MESSAGE_LINES ||
    turn.some((line) => OUTPUT_MARKER.test(line) || INPUT_MARKER.test(line))
  ) {
    return undefined;
  }
  const message = turn
    .map((line) =>
      line
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .join(" ")
    .toLowerCase();
  return BARE_QUOTA_MESSAGE.test(message) ? quotaLine(turn[0]!, turn[1]) : undefined;
}

export function quotaReason(kind: string, label: string): string {
  return `${kind} reported a quota or usage-limit error ("${label}")`;
}

/** A composer line with placeholder or typed text; never a numbered menu option ("› 1."). */
const CODEX_COMPOSER_LINE = /^\s*›\s+(?!\d+\s*[.)])\S/;
/** A footer cut to its warning count: "?  ⚠ 2" at 12 columns, "⚠ 2" at 9 (AGENT-231). */
const CODEX_WARNING_FOOTER = /^\s*(?:\?\s+)?⚠\s*\d+\s*$/;

/** The warning-count footer is below the composer line, as the footer always is. */
function hasWarningFooterBelowComposer(lines: string[]): boolean {
  const composer = lines.findIndex((line) => CODEX_COMPOSER_LINE.test(line));
  return composer >= 0 && lines.slice(composer + 1).some((line) => CODEX_WARNING_FOOTER.test(line));
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
      // A narrow pane cuts the writer's footer to "⏵⏵ don't ask on · ←…" (AGENT-285).
      (compact.includes("shift+tabtocycle") ||
        compact.includes("?forshortcuts") ||
        compact.includes("⏵⏵don'taskon")) &&
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
    // `→` input line, plus the mode footer. cursor-agent 2026.10.14 dropped "shift+tab to
    // cycle": its composer reads "→ Plan, search, build anything" over a status bar naming the
    // run mode ("Run Everything" or "Auto-run"). Either footer counts.
    cursor: (lines, compact) =>
      lines.some((line) => /^\s*→(\s|$)/.test(line)) &&
      (compact.includes("shift+tabtocycle") ||
        compact.includes("runeverything") ||
        compact.includes("auto-run") ||
        // Allowlist mode (hmr's per-launch writer config, AGENT-285) shows no run-mode footer;
        // the fresh composer's own placeholder is the evidence there.
        /^\s*→\s+plan, search, build anything\s*$/im.test(lines.join("\n"))),
    // `›` input line (not a numbered menu), plus the composer footer.
    codex: (lines, compact) =>
      lines.some((line) => /^\s*›(\s|$)/.test(line) && !NUMBERED_MENU.test(line)) &&
      (/(contextleft|forshortcuts|⏎send)/.test(compact) ||
        // A narrow Herdr split cuts the footer to "? for  ⚠ 2 · f2" or "? fo…" (NFKC: "? fo...") (AGENT-285),
        // the same way Claude's narrow footer is accepted above.
        (lines.some((line) => /^\s*\?\s+f(?:or?)?(?:\s|…|\.\.\.|$)/.test(line)) &&
          // With only a cut footer, the composer line must carry placeholder or typed text and
          // never start like a menu option ("› 1." even when its text wrapped away; PR #25 review 2).
          lines.some((line) => CODEX_COMPOSER_LINE.test(line))) ||
        hasWarningFooterBelowComposer(lines)),
    // No verified composer evidence for OpenCode: never ready.
    opencode: undefined,
  };

export function hasReadinessEvidence(kind: string): kind is ReadinessKind {
  return kind in COMPOSER && COMPOSER[kind as ReadinessKind] !== undefined;
}

/**
 * A CLI warning that its OS sandbox did not apply. Grok logs such a warning and keeps running
 * without enforcement, so a lane that shows one must never be prompted (fail closed).
 */
export function detectSandboxFailure(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const match =
    /sandbox (?:is )?(?:not supported|could not be applied|unavailable|failed to apply)[^\n]*/i.exec(
      sanitizeScreen(text),
    );
  return match?.[0].trim();
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
