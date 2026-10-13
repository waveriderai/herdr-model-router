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
 * What the native CLIs print when an account is out of quota or past its usage limit, in
 * compact form (see compactScreen). Each is an exhausted limit, never a warning such as
 * "approaching usage limit", and never a context-window limit.
 */
const QUOTA_PATTERNS: { label: string; pattern: string | RegExp }[] = [
  // Claude Code: "Claude usage limit reached", "5-hour limit reached ∙ resets 3pm".
  { label: "limit reached", pattern: /(?:usage|hour|daily|weekly|monthly|session)limitreached/ },
  // Claude Code "You've hit your limit"; Codex and Cursor "You've hit your usage limit".
  { label: "hit your limit", pattern: /hityour(?:usage|rate)?limit/ },
  // OpenAI and xAI API errors surfaced by Codex and grok.
  { label: "quota exceeded", pattern: /quotaexceeded|exceededyourcurrentquota|insufficient_quota/ },
  { label: "rate limit exceeded", pattern: "ratelimitexceeded" },
  { label: "out of credits", pattern: /(?:outof|runoutof|nomore)credits/ },
  // Codex after its own retries: "exceeded retry limit, last status: 429 Too Many Requests".
  { label: "HTTP 429 after retries", pattern: "laststatus:429" },
];

/**
 * The CLI's own quota or usage-limit message on this screen, as a short label, if any. `sent`
 * is the prompt the router typed: the pane echoes it, so its text is removed first and a task
 * that merely mentions a usage limit is not mistaken for one.
 */
export function detectQuota(text: string, sent?: string): string | undefined {
  let compact = compactScreen(text);
  if (sent) {
    const echoes = [sent, ...sent.split("\n")]
      .map(compactScreen)
      .filter((echo) => echo.length >= 6)
      .sort((a, b) => b.length - a.length);
    for (const echo of echoes) compact = compact.split(echo).join(" ");
  }
  return QUOTA_PATTERNS.find(({ pattern }) =>
    typeof pattern === "string" ? compact.includes(pattern) : pattern.test(compact),
  )?.label;
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
