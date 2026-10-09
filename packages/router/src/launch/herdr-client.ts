import { spawn } from "node:child_process";

export interface CommandResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export type RunCommand = (argv: readonly string[]) => Promise<CommandResult>;

export interface HerdrClient {
  /** `cwd` starts the new pane's shell in that directory (`herdr pane split --cwd`). */
  splitCurrent(options?: { direction?: "right" | "down"; cwd?: string }): Promise<CommandResult>;
  startAgent(input: {
    name: string;
    kind: "cursor" | "claude" | "codex" | "opencode" | "grok";
    paneId: string;
    agentArgs: string[];
  }): Promise<CommandResult>;
  prompt(input: {
    target: string;
    text: string;
    wait?: boolean;
    until?: HerdrAgentState[];
    timeoutMs?: number;
  }): Promise<CommandResult>;
  waitFor(input: {
    target: string;
    until?: HerdrAgentState[];
    timeoutMs?: number;
  }): Promise<CommandResult>;
  closePane(paneId: string): Promise<CommandResult>;
  /** `herdr pane run`: types one command line into the pane's shell and presses Enter. */
  runInPane(paneId: string, command: string): Promise<CommandResult>;
  /** `herdr agent rename`: names the agent Herdr detected (target may be its pane id). */
  renameAgent(target: string, name: string): Promise<CommandResult>;
}

export function createProcessCommandAdapter(
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): RunCommand {
  // Longer than Herdr's 30s agent start timeout, so Herdr reports its own error first.
  const timeoutMs = options.timeoutMs ?? 60_000;
  return (argv) =>
    new Promise((resolve) => {
      const [command, ...args] = argv;
      if (!command) {
        resolve({ ok: false, code: 1, stdout: "", stderr: "missing command" });
        return;
      }
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: options.env });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ ok: false, code: 1, stdout, stderr: String(error) });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const exit = code ?? 1;
        resolve({ ok: exit === 0, code: exit, stdout, stderr });
      });
    });
}

export type HerdrAgentState = "idle" | "working" | "blocked" | "done" | "unknown";

function stateArgs(until: HerdrAgentState[] = [], timeoutMs?: number): string[] {
  return [
    ...until.flatMap((state) => ["--until", state]),
    ...(timeoutMs === undefined ? [] : ["--timeout", String(timeoutMs)]),
  ];
}

export function createHerdrClient(runCommand: RunCommand): HerdrClient {
  return {
    splitCurrent(options) {
      return runCommand([
        "herdr",
        "pane",
        "split",
        "--current",
        "--direction",
        options?.direction ?? "right",
        ...(options?.cwd === undefined ? [] : ["--cwd", options.cwd]),
        "--no-focus",
      ]);
    },
    startAgent(input) {
      return runCommand([
        "herdr",
        "agent",
        "start",
        input.name,
        "--kind",
        input.kind,
        "--pane",
        input.paneId,
        "--",
        ...input.agentArgs,
      ]);
    },
    prompt(input) {
      const argv = ["herdr", "agent", "prompt", input.target, input.text];
      if (input.wait !== false) {
        argv.push("--wait", ...stateArgs(input.until, input.timeoutMs));
      }
      return runCommand(argv);
    },
    waitFor(input) {
      return runCommand([
        "herdr",
        "agent",
        "wait",
        input.target,
        ...stateArgs(input.until, input.timeoutMs),
      ]);
    },
    closePane(paneId) {
      return runCommand(["herdr", "pane", "close", paneId]);
    },
    runInPane(paneId, command) {
      return runCommand(["herdr", "pane", "run", paneId, command]);
    },
    renameAgent(target, name) {
      return runCommand(["herdr", "agent", "rename", target, name]);
    },
  };
}

/** What `herdr agent get` reports about a running agent. */
export interface HerdrAgentInfo {
  agent: string;
  status: HerdrAgentState;
  paneId: string;
  /** Herdr's `interactive_ready`, when reported. */
  interactiveReady?: boolean;
  name?: string;
}

/** Controls an already-running agent pane; used by in-place effort switching. */
export interface HerdrPaneClient {
  getAgent(target: string): Promise<HerdrAgentInfo | undefined>;
  readPane(
    paneId: string,
    options: { source: "visible" | "recent"; lines: number; ansi?: boolean },
  ): Promise<string | undefined>;
  sendKeys(paneId: string, keys: readonly string[]): Promise<CommandResult>;
  sendText(paneId: string, text: string): Promise<CommandResult>;
}

const AGENT_STATES = new Set<HerdrAgentState>(["idle", "working", "blocked", "done", "unknown"]);

export function parseHerdrAgentInfo(stdout: string): HerdrAgentInfo | undefined {
  try {
    const data = JSON.parse(stdout.trim()) as {
      result?: {
        agent?: {
          agent?: unknown;
          agent_status?: unknown;
          pane_id?: unknown;
          interactive_ready?: unknown;
          name?: unknown;
        };
      };
    };
    const agent = data.result?.agent;
    if (!agent || typeof agent.agent !== "string" || typeof agent.pane_id !== "string") {
      return undefined;
    }
    const status = AGENT_STATES.has(agent.agent_status as HerdrAgentState)
      ? (agent.agent_status as HerdrAgentState)
      : "unknown";
    return {
      agent: agent.agent,
      status,
      paneId: agent.pane_id,
      ...(typeof agent.interactive_ready === "boolean"
        ? { interactiveReady: agent.interactive_ready }
        : {}),
      ...(typeof agent.name === "string" ? { name: agent.name } : {}),
    };
  } catch {
    return undefined;
  }
}

export function createHerdrPaneClient(runCommand: RunCommand): HerdrPaneClient {
  return {
    async getAgent(target) {
      const result = await runCommand(["herdr", "agent", "get", target]);
      return result.ok ? parseHerdrAgentInfo(result.stdout) : undefined;
    },
    async readPane(paneId, options) {
      const result = await runCommand([
        "herdr",
        "pane",
        "read",
        paneId,
        "--source",
        options.source,
        "--lines",
        String(options.lines),
        "--format",
        options.ansi ? "ansi" : "text",
      ]);
      return result.ok ? result.stdout : undefined;
    },
    sendKeys(paneId, keys) {
      return runCommand(["herdr", "pane", "send-keys", paneId, ...keys]);
    },
    sendText(paneId, text) {
      return runCommand(["herdr", "pane", "send-text", paneId, text]);
    },
  };
}
