import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandResult, HerdrClient, HerdrPaneClient } from "../../src/launch/herdr-client.js";
import type { DispatchDeps } from "../../src/rules/dispatch.js";
import { launchFilesIn } from "../../src/commands/rules-runtime.js";
import { openDatabase } from "../../src/store/database.js";
import { DispatchRepository } from "../../src/store/dispatch-repository.js";

export const ok = (stdout = ""): CommandResult => ({ ok: true, code: 0, stdout, stderr: "" });
export const failed = (stdout: string, stderr = ""): CommandResult => ({
  ok: false,
  code: 1,
  stdout,
  stderr,
});

export const HELP: Record<string, string> = {
  claude: '--model <m>\n--effort <level>\n--permission-mode <mode> (choices: "plan")',
  codex:
    "-m, --model <MODEL>\n-c, --config <k=v>\n-s, --sandbox <MODE> [possible values: read-only, workspace-write]",
  grok: "-m, --model <MODEL>\n--reasoning-effort <E>\n--permission-mode <MODE> [possible values: default, plan]",
  "cursor-agent": '--model <model>\n--mode <mode> (choices: "plan", "ask")',
};

export const KIND_BY_EXECUTABLE: Record<string, string> = {
  claude: "claude",
  codex: "codex",
  grok: "grok",
  "cursor-agent": "cursor",
};

export const SCREENS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/screens",
);
export const screen = (name: string) => readFileSync(path.join(SCREENS, `${name}.txt`), "utf8");
/** What each CLI shows at its ordinary prompt; the readiness gate must see it to prompt. */
export const READY_SCREEN: Record<string, string> = {
  claude: screen("claude-ready"),
  codex: screen("codex-ready"),
  grok: screen("grok-ready"),
  cursor: screen("cursor-ready"),
};

export interface FakePane {
  /** Detected agent kind, or undefined while nothing is detected. */
  kind?: string;
  /** What `herdr pane read` returns for this pane; undefined is an unreadable pane. */
  screen?: string;
  status: "idle" | "working" | "blocked" | "unknown";
  ready: boolean;
  name?: string;
  gone?: boolean;
  /** Native session id Herdr reports; set when the CLI starts. */
  session?: string;
  /** Working directory Herdr reports; the split cwd by default. */
  cwd?: string;
  /** Where the reported session came from (`herdr pane report-agent-session --source`). */
  sessionSource?: string;
  /** Text typed into the CLI's input box and not yet submitted. */
  input?: string;
  /**
   * How many screen reads after typing still show the input box as it was before: the CLI
   * repaints asynchronously. 0 (default) shows typed text at once.
   */
  echoLag?: number;
  /** How the CLI draws typed input (its SGR styling); plain text by default. */
  inputStyle?: (text: string) => string;
  /** Output the CLI printed above its input box, oldest first. */
  history?: string;
  /** What this Codex prints for its native `/status` command; undefined prints nothing. */
  statusCard?: string;
  /**
   * A `/status` card Codex paints over several reads instead: each read after Enter shows the
   * next frame, and the last frame stays. Takes the place of `statusCard`.
   */
  statusFrames?: string[];
  /** Which `statusFrames` frame the next read shows; set when `/status` is entered. */
  statusFrame?: number;
  /** Lines submitted with Enter that were not a slash command the fake knows. */
  submitted?: string[];
}

/** The screen Herdr shows for a pane: its history, then its screen with the typed input. */
function renderPane(pane: FakePane): string | undefined {
  if (pane.screen === undefined) return undefined;
  const style = pane.inputStyle ?? ((text: string) => text);
  const typed = pane.input
    ? pane.screen.replace(/^› .*$/m, () => `› ${style(pane.input!)}`)
    : pane.screen;
  const frames = pane.statusFrames;
  const painting =
    frames && pane.statusFrame !== undefined
      ? frames[Math.min(pane.statusFrame, frames.length - 1)]!
      : "";
  return `${pane.history ?? ""}${painting}${typed}`;
}

export interface FakeHerdr extends HerdrClient {
  calls: string[][];
  prompts: { target: string; text: string }[];
  scripts: string[];
  panes: Map<string, FakePane>;
  pane: Pick<HerdrPaneClient, "getAgent" | "readPane" | "sendText" | "sendKeys">;
  reads: string[];
}

/**
 * A Herdr stand-in. `pane run` reads the launch script the router wrote and "starts" the
 * executable it names; `detect` can override what Herdr then reports for the pane.
 */
export function fakeHerdr(
  script: {
    detect?: (paneId: string, executable: string) => FakePane;
    /** May return a promise, to hold a prompt in flight. */
    prompt?: (target: string, count: number) => CommandResult | Promise<CommandResult> | undefined;
    /** Return false to make `herdr pane close` fail (the pane keeps running). */
    close?: (paneId: string) => boolean;
    onRename?: (paneId: string, name: string) => void;
    onGetAgent?: (target: string) => void;
    /**
     * Overrides what `herdr pane report-agent-session` does. By default Herdr stores the
     * reported id on the pane only for the provider's supported session channel.
     */
    report?: (
      paneId: string,
      input: { source: string; agent: string; sessionId: string },
    ) => CommandResult | undefined;
  } = {},
): FakeHerdr {
  const calls: string[][] = [];
  const prompts: { target: string; text: string }[] = [];
  const scripts: string[] = [];
  const reads: string[] = [];
  const panes = new Map<string, FakePane>();
  let count = 0;
  const find = (target: string) =>
    [...panes.entries()].find(
      ([id, pane]) => !pane.gone && (id === target || pane.name === target),
    );
  return {
    calls,
    prompts,
    scripts,
    panes,
    reads,
    async splitCurrent(options) {
      calls.push(["pane", "split", options?.cwd ?? ""]);
      count += 1;
      panes.set(`w1:p${count}`, {
        status: "unknown",
        ready: false,
        ...(options?.cwd ? { cwd: options.cwd } : {}),
      });
      return ok(JSON.stringify({ result: { pane: { pane_id: `w1:p${count}` } } }));
    },
    async startAgent() {
      throw new Error("rules mode must not use herdr agent start");
    },
    async runInPane(paneId, command) {
      calls.push(["pane", "run", paneId, command]);
      const scriptPath = /^\/bin\/sh '(.+)'$/.exec(command)?.[1];
      if (!scriptPath) return failed("", "unexpected command");
      const text = readFileSync(scriptPath, "utf8");
      scripts.push(text);
      // The executable is the script's first line that starts with a quoted absolute path.
      const line = text
        .split("\n")
        .find((entry) => /^\s*'\//.test(entry))!
        .trim();
      const executable = path.basename(/^'([^']+)'/.exec(line)![1]!);
      const pane = panes.get(paneId)!;
      const kind = KIND_BY_EXECUTABLE[executable]!;
      Object.assign(
        pane,
        {
          kind,
          status: "idle",
          ready: true,
          screen: READY_SCREEN[kind],
          session: `sess-${paneId}`,
        },
        script.detect?.(paneId, executable) ?? {},
      );
      return ok();
    },
    async renameAgent(target, name) {
      calls.push(["agent", "rename", target, name]);
      script.onRename?.(target, name);
      const pane = panes.get(target);
      if (!pane?.kind) return failed("", "no agent");
      pane.name = name;
      return ok();
    },
    async waitFor(input) {
      calls.push(["agent", "wait", input.target, ...(input.until ?? [])]);
      return ok(JSON.stringify({ result: { agent: { agent_status: "idle" } } }));
    },
    async prompt(input) {
      prompts.push({ target: input.target, text: input.text });
      calls.push(["agent", "prompt", input.target]);
      return (
        (await script.prompt?.(input.target, prompts.length)) ??
        ok(JSON.stringify({ result: { agent: { agent_status: "working" } } }))
      );
    },
    async reportAgentSession(input) {
      calls.push([
        "pane",
        "report-agent-session",
        input.paneId,
        input.source,
        input.agent,
        input.sessionId,
      ]);
      const overridden = script.report?.(input.paneId, input);
      if (overridden) return overridden;
      const pane = panes.get(input.paneId);
      if (!pane || pane.gone) return failed("", "pane_not_found");
      if (input.source !== `herdr:${input.agent}`) return ok();
      pane.session = input.sessionId;
      pane.sessionSource = input.source;
      return ok();
    },
    async closePane(paneId) {
      calls.push(["pane", "close", paneId]);
      if (script.close?.(paneId) === false) return failed("", "pane close failed");
      const pane = panes.get(paneId);
      if (pane) pane.gone = true;
      return ok();
    },
    pane: {
      async getAgent(target) {
        script.onGetAgent?.(target);
        const found = find(target);
        if (!found?.[1].kind) return undefined;
        const [paneId, pane] = found;
        return {
          agent: pane.kind!,
          status: pane.status,
          paneId,
          interactiveReady: pane.ready,
          ...(pane.name ? { name: pane.name } : {}),
          ...(pane.session ? { sessionId: pane.session } : {}),
          ...(pane.cwd ? { cwd: pane.cwd } : {}),
        };
      },
      async readPane(paneId) {
        reads.push(paneId);
        const pane = panes.get(paneId);
        if (!pane || pane.gone) return undefined;
        if (pane.input && (pane.echoLag ?? 0) > 0) {
          pane.echoLag! -= 1;
          // The box as it was: Codex draws its placeholder dim.
          const before = pane.screen?.replace(/^› (.*)$/m, "› \u001b[2m$1\u001b[0m");
          return renderPane({ ...pane, input: "", ...(before ? { screen: before } : {}) });
        }
        const rendered = renderPane(pane);
        if (pane.statusFrame !== undefined) pane.statusFrame += 1;
        return rendered;
      },
      async sendText(paneId, text) {
        calls.push(["pane", "send-text", paneId, text]);
        const pane = panes.get(paneId);
        if (!pane || pane.gone) return failed("", "pane_not_found");
        pane.input = `${pane.input ?? ""}${text}`;
        return ok();
      },
      async sendKeys(paneId, keys) {
        calls.push(["pane", "send-keys", paneId, ...keys]);
        const pane = panes.get(paneId);
        if (!pane || pane.gone) return failed("", "pane_not_found");
        for (const key of keys) {
          if (key !== "enter") continue;
          const line = pane.input ?? "";
          pane.input = "";
          // Codex runs `/status` locally: it prints the card and starts no model turn.
          if (pane.kind === "codex" && line === "/status") {
            if (pane.statusFrames) pane.statusFrame = 0;
            else pane.history = `${pane.history ?? ""}${pane.statusCard ?? ""}`;
          } else if (line !== "") {
            pane.submitted = [...(pane.submitted ?? []), line];
            pane.status = "working";
          }
        }
        return ok();
      },
    },
  };
}

export function deps(
  herdr: FakeHerdr,
  overrides: Partial<DispatchDeps> = {},
  /** Reuse an existing router home (another process's state) instead of a new one. */
  existingHome?: string,
) {
  const home = existingHome ?? mkdtempSync(path.join(os.tmpdir(), "hmr-dispatch-"));
  const db = openDatabase({ home });
  const probed: string[] = [];
  const value: DispatchDeps = {
    store: new DispatchRepository(db),
    herdr,
    pane: herdr.pane,
    probeHelp: async (executable) => {
      probed.push(executable);
      const help = HELP[path.basename(executable)];
      return help ? ok(help) : { ok: false, code: 1, stdout: "", stderr: "spawn ENOENT" };
    },
    resolveExecutable: (name) => (name in HELP ? `/opt/fake bin/${name}` : undefined),
    launchFiles: launchFilesIn(home),
    launchEnvNames: ["HERDR_PANE_ID", "HOME", "PATH"],
    sleep: async () => {},
    pollMs: 10,
    timeoutMs: 50,
    ...overrides,
  };
  return { deps: value, probed, home, db };
}
