import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDispatchDeps } from "../../src/commands/rules-runtime.js";
import type { CommandResult, HerdrClient, HerdrPaneClient } from "../../src/launch/herdr-client.js";
import { dispatchPlan } from "../../src/rules/dispatch.js";
import {
  launchScript,
  paneCommand,
  shQuote,
  tomlBasicString,
} from "../../src/rules/launch-script.js";
import { parseRules } from "../../src/rules/mdc-parser.js";
import { planRoute } from "../../src/rules/plan.js";

const ok = (stdout = ""): CommandResult => ({ ok: true, code: 0, stdout, stderr: "" });

/** Synthetic credentials a user's shell rc might export. None may reach the native CLI. */
const SHELL_EXPORTED_SECRETS = {
  OPENAI_API_KEY: "sk-synthetic-openai",
  ANTHROPIC_API_KEY: "sk-ant-synthetic",
  ANTHROPIC_AUTH_TOKEN: "synthetic-anthropic-token",
  XAI_API_KEY: "xai-synthetic",
  CURSOR_API_KEY: "cursor-synthetic",
  GEMINI_API_KEY: "gemini-synthetic",
  TYPESAFE_API_KEY: "ts-synthetic",
  AWS_SECRET_ACCESS_KEY: "aws-synthetic",
  AWS_SESSION_TOKEN: "aws-session-synthetic",
  GOOGLE_APPLICATION_CREDENTIALS: "/tmp/synthetic-gcp.json",
  AZURE_OPENAI_API_KEY: "azure-synthetic",
  GH_TOKEN: "gh-synthetic",
};

function run(shell: string, command: string, env: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, ["-c", command], { env, stdio: "ignore" });
    child.on("error", reject);
    child.on("close", resolve);
  });
}

const SHELLS = ["/bin/sh", "/bin/bash", "/bin/zsh"].filter((shell) => existsSync(shell));

describe("native CLI launch environment (process level)", () => {
  it.each(SHELLS)(
    "starts the absolute binary from the pane's %s with its own Herdr context and no API keys",
    async (shell) => {
      const root = mkdtempSync(path.join(os.tmpdir(), "hmr-launch-"));
      const bin = path.join(root, "bin");
      const record = path.join(root, "record.txt");
      // A project path with a space, a quote, and shell syntax that must stay literal.
      const project = path.join(root, "my proj it's $(touch pwned)");
      mkdirSync(bin);
      mkdirSync(project);
      mkdirSync(path.join(project, ".git"));
      const fake = path.join(bin, "claude");
      writeFileSync(
        fake,
        [
          "#!/bin/sh",
          `{ printf 'cwd=%s\\n' "$(pwd)"; for a in "$@"; do printf 'arg=%s\\n' "$a"; done; /usr/bin/env; } > ${shQuote(record)}`,
          "",
        ].join("\n"),
      );
      chmodSync(fake, 0o755);

      const routerEnv = {
        MODEL_ROUTER_HOME: path.join(root, "router home"),
        HOME: path.join(root, "home"),
        PATH: `${bin}:/usr/bin:/bin`,
        HERDR_ENV: "1",
        // The router's own pane; the launched CLI must get the new pane's values instead.
        HERDR_PANE_ID: "w9:p0",
        HERDR_SOCKET_PATH: path.join(root, "herdr.sock"),
        HERDR_EXTRA_CONTEXT: "router-side",
        ...SHELL_EXPORTED_SECRETS,
      };

      const prompts: string[] = [];
      const paneCommands: string[] = [];
      let renamed: string | undefined;
      const herdr: HerdrClient = {
        async splitCurrent() {
          return ok(JSON.stringify({ result: { pane: { pane_id: "w9:p1" } } }));
        },
        async startAgent() {
          throw new Error("rules mode must not use herdr agent start");
        },
        async runInPane(paneId, command) {
          paneCommands.push(command);
          // The new pane's interactive shell: its rc files exported the secrets, and Herdr
          // gave it its own pane id.
          const code = await run(shell, command, {
            HOME: routerEnv.HOME,
            PATH: routerEnv.PATH,
            TERM: "xterm-256color",
            LANG: "en_US.UTF-8",
            HERDR_ENV: "1",
            HERDR_PANE_ID: paneId,
            HERDR_SOCKET_PATH: routerEnv.HERDR_SOCKET_PATH,
            ...SHELL_EXPORTED_SECRETS,
          });
          return code === 0 ? ok() : { ok: false, code: code ?? 1, stdout: "", stderr: "" };
        },
        async renameAgent(_target, name) {
          renamed = name;
          return ok();
        },
        async waitFor() {
          return ok();
        },
        async prompt(input) {
          prompts.push(`${input.target}: ${input.text}`);
          return ok('{"agent_status":"working"}');
        },
        async closePane() {
          return ok();
        },
      };
      const pane: Pick<HerdrPaneClient, "getAgent" | "readPane"> = {
        async readPane(paneId) {
          // The pane's screen once claude is at its ordinary prompt.
          return paneId === "w9:p1" && existsSync(record)
            ? "────────────────────\n❯ \n────────────────────\n  ⏸ plan mode on (shift+tab to cycle)\n"
            : undefined;
        },
        async getAgent(target) {
          return existsSync(record)
            ? {
                agent: "claude",
                status: "idle",
                paneId: "w9:p1",
                interactiveReady: true,
                // What Herdr reports once the agent is named and its integration reported a session.
                name: renamed ?? target,
                sessionId: "sess-w9-p1",
                cwd: project,
              }
            : undefined;
        },
      };
      const opened = openDispatchDeps(routerEnv, {
        createHerdr: () => herdr,
        createHerdrPane: () => pane as HerdrPaneClient,
        createProcessAdapter: () => async (argv) =>
          argv[1] === "--help"
            ? ok('--model <m>\n--effort <level>\n--permission-mode <mode> (choices: "plan")')
            : ok(),
      });

      const rules = parseRules("bug-fix: claude:claude-opus-5-5@xhigh\n");
      if (!rules.ok) throw new Error(rules.error);
      const planned = planRoute({
        rules: rules.rules,
        rulesSource: { path: "rules.mdc", origin: "flag" },
        role: "bug-fix",
        cwd: project,
      });
      if (!planned.ok) throw new Error(planned.error);
      const result = await dispatchPlan({
        plan: planned,
        prompt: "Fix it",
        worktreeId: project,
        deps: { ...opened, sleep: async () => {}, pollMs: 5, timeoutMs: 2000 },
      });
      opened.close();
      if (!result.ok) throw new Error(result.error);

      const lines = readFileSync(record, "utf8").trim().split("\n");
      expect(lines.filter((line) => line.startsWith("arg="))).toEqual([
        "arg=--model",
        "arg=claude-opus-5-5",
        "arg=--effort",
        "arg=xhigh",
      ]);
      expect(lines[0]).toBe(`cwd=${realpathSync(project)}`);
      const env = Object.fromEntries(
        lines
          .filter((line) => !line.startsWith("arg=") && !line.startsWith("cwd="))
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      );
      expect(env).toMatchObject({
        HOME: routerEnv.HOME,
        PATH: routerEnv.PATH,
        TERM: "xterm-256color",
        LANG: "en_US.UTF-8",
        HERDR_ENV: "1",
        HERDR_PANE_ID: "w9:p1",
        HERDR_SOCKET_PATH: routerEnv.HERDR_SOCKET_PATH,
      });
      for (const name of Object.keys(SHELL_EXPORTED_SECRETS)) expect(env).not.toHaveProperty(name);
      // A HERDR_* name the router carries is passed only if the pane's shell has it.
      expect(env).not.toHaveProperty("HERDR_EXTRA_CONTEXT");
      expect(readFileSync(record, "utf8")).not.toMatch(/synthetic/);
      // No shell syntax in the path ran, the script was removed, and the prompt went once.
      expect(existsSync(path.join(root, "pwned"))).toBe(false);
      expect(existsSync(path.join(project, "pwned"))).toBe(false);
      expect(readdirSync(path.join(routerEnv.MODEL_ROUTER_HOME, "launch"))).toEqual([]);
      expect(paneCommands).toHaveLength(1);
      expect(paneCommands[0]).toMatch(/^\/bin\/sh '.+\/router home\/launch\/lane_[0-9a-f-]+\.sh'$/);
      expect(prompts).toEqual([
        `${result.lanes[0]!.agentName}: Fix it\n\n(Writer task ${result.task.id} for role "bug-fix". Revisions for this task arrive in this same session.)`,
      ]);
    },
  );
});

describe("launch script quoting", () => {
  it("quotes every value and refuses unsafe names and paths", () => {
    const text = launchScript({
      executable: "/opt/x y/claude",
      args: ["--model", "a'b", "$(id)", "`id`", 'model_reasoning_effort="high"'],
      cwd: "/w/it's",
      envNames: ["HOME", "HERDR_PANE_ID"],
    });
    expect(text.split("\n")).toEqual([
      "# Written by herdr-model-router for one lane launch. It starts the native CLI and nothing else.",
      "cd '/w/it'\\''s' || exit 97",
      "exec /usr/bin/env -i \\",
      '  ${HOME+"HOME=$HOME"} \\',
      '  ${HERDR_PANE_ID+"HERDR_PANE_ID=$HERDR_PANE_ID"} \\',
      `  '/opt/x y/claude' '--model' 'a'\\''b' '$(id)' '\`id\`' 'model_reasoning_effort="high"'`,
      "",
    ]);
    expect(() =>
      launchScript({ executable: "/x", args: [], cwd: "/w", envNames: ["A;rm"] }),
    ).toThrow(/unsafe environment name/);
    expect(() => launchScript({ executable: "claude", args: [], cwd: "/w", envNames: [] })).toThrow(
      /absolute path/,
    );
    expect(paneCommand("/a b/c.sh")).toBe("/bin/sh '/a b/c.sh'");
    expect(() => paneCommand("/a'b/c.sh")).toThrow(/cannot be quoted safely/);
  });
});

describe("Codex tool-command context (process level)", () => {
  /** Runs one launch script in `shell` with the pane's own environment; returns what codex saw. */
  async function launchCodex(shell: string, paneEnv: Record<string, string>) {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "hmr-codex-ctx-")));
    const record = path.join(root, "record.txt");
    const fake = path.join(root, "codex");
    writeFileSync(
      fake,
      `#!/bin/sh\n{ for a in "$@"; do printf 'arg=%s\\n' "$a"; done; /usr/bin/env; } > ${shQuote(record)}\n`,
    );
    chmodSync(fake, 0o755);
    const script = path.join(root, "launch.sh");
    const routerHome = path.join(root, 'router home "q" \\b');
    writeFileSync(
      script,
      launchScript({
        executable: fake,
        args: ["--model", "gpt-6.1-sol", "-c", 'model_reasoning_effort="high"'],
        cwd: root,
        envNames: ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HOME", "PATH"],
        fixedEnv: { MODEL_ROUTER_HOME: routerHome },
        codexContext: ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "MODEL_ROUTER_HOME"],
      }),
    );
    const code = await run(shell, paneCommand(script), { PATH: "/usr/bin:/bin", ...paneEnv });
    const lines = existsSync(record) ? readFileSync(record, "utf8").trim().split("\n") : [];
    return {
      code,
      routerHome,
      args: lines.filter((line) => line.startsWith("arg=")).map((line) => line.slice(4)),
      env: lines.filter((line) => !line.startsWith("arg=")),
    };
  }

  it.each(SHELLS)(
    "sets the new pane's own Herdr values and the router home for codex's tools from %s",
    async (shell) => {
      const seen = await launchCodex(shell, {
        HERDR_ENV: "1",
        HERDR_PANE_ID: "w9:p1",
        HERDR_SOCKET_PATH: "/tmp/herdr dir/herdr.sock",
        OPENAI_API_KEY: "sk-synthetic-openai",
      });
      expect(seen.code).toBe(0);
      expect(seen.args).toEqual([
        "-c",
        'shell_environment_policy.set.HERDR_ENV="1"',
        "-c",
        'shell_environment_policy.set.HERDR_PANE_ID="w9:p1"',
        "-c",
        'shell_environment_policy.set.HERDR_SOCKET_PATH="/tmp/herdr dir/herdr.sock"',
        "-c",
        `shell_environment_policy.set.MODEL_ROUTER_HOME=${tomlBasicString(seen.routerHome)}`,
        "--model",
        "gpt-6.1-sol",
        "-c",
        'model_reasoning_effort="high"',
      ]);
      // The process itself has the same values, and no API key.
      expect(seen.env).toEqual(
        expect.arrayContaining(["HERDR_PANE_ID=w9:p1", `MODEL_ROUTER_HOME=${seen.routerHome}`]),
      );
      expect(seen.env.join("\n")).not.toContain("sk-synthetic");
    },
  );

  it("passes nothing for a Herdr value the pane does not have, and invents none", async () => {
    const seen = await launchCodex("/bin/sh", { HERDR_ENV: "1", HERDR_PANE_ID: "w9:p1" });
    expect(seen.code).toBe(0);
    expect(seen.args.join(" ")).not.toContain("HERDR_SOCKET_PATH");
  });

  it("stops the launch when a pane value cannot be written as a plain TOML string", async () => {
    const seen = await launchCodex("/bin/sh", {
      HERDR_ENV: "1",
      HERDR_PANE_ID: 'w9:p1" model="other',
    });
    expect(seen.code).toBe(96);
    expect(seen.args).toEqual([]);
  });

  it("escapes a fixed value as a TOML basic string", () => {
    expect(tomlBasicString('a"b\\c\nd')).toBe('"a\\"b\\\\c\\u000Ad"');
  });
});
