import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureHome, loadConfig } from "../config/config-loader.js";
import type { AgentId } from "../domain/ids.js";
import {
  createHerdrClient,
  createHerdrPaneClient,
  createProcessCommandAdapter,
  type HerdrClient,
  type HerdrPaneClient,
  type RunCommand,
} from "../launch/herdr-client.js";
import type { Provider } from "../rules/descriptor.js";
import type { DispatchDeps, LaunchFiles } from "../rules/dispatch.js";
import { launchEnvNames, resolveExecutable } from "../rules/launch-script.js";
import { createLiveTypeSafeClient, type TypeSafePort } from "../semantic/typesafe-client.js";
import { openDatabase } from "../store/database.js";
import { DispatchRepository } from "../store/dispatch-repository.js";
import { userHome } from "./rules-commands.js";
import type { RulesRunDeps } from "./rules-run.js";
import { resolveCredential, resolveEnvCredential, sanitizeRuntimeEnv } from "./runtime.js";

export interface RulesRuntimeOverrides {
  createTypeSafeClient?: (apiKey: string) => TypeSafePort;
  createProcessAdapter?: (options: { env?: NodeJS.ProcessEnv; timeoutMs?: number }) => RunCommand;
  createHerdr?: (runCommand: RunCommand) => HerdrClient;
  createHerdrPane?: (runCommand: RunCommand) => HerdrPaneClient;
  readKeychain?: (service: string) => string | undefined;
}

const AGENT_PROVIDER: Partial<Record<AgentId, Provider>> = {
  "claude-code": "claude",
  codex: "codex",
  cursor: "cursor",
  opencode: "opencode",
};

/** Per-lane launch scripts under the router home, readable only by the user. */
export function launchFilesIn(home: string): LaunchFiles {
  const dir = path.join(home, "launch");
  return {
    write(laneId, content) {
      ensureHome(home);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") chmodSync(dir, 0o700);
      const file = path.join(dir, `${laneId.replace(/[^A-Za-z0-9_-]/g, "_")}.sh`);
      writeFileSync(file, content, { mode: 0o600 });
      return file;
    },
    remove(file) {
      rmSync(file, { force: true });
    },
  };
}

/**
 * Opens the store and Herdr clients for a real rules-mode launch. Herdr commands and CLI
 * probes get only the allowlisted environment. The native CLI itself is started inside its
 * new pane through `env -i` (see launch-script.ts), so provider API keys never reach it.
 */
export function openDispatchDeps(
  env: NodeJS.Dict<string>,
  overrides: RulesRuntimeOverrides = {},
): DispatchDeps & { close: () => void } {
  const home = loadConfig({ env }).home;
  const db = openDatabase({ home });
  const childEnv = sanitizeRuntimeEnv(env);
  const adapter = (overrides.createProcessAdapter ?? createProcessCommandAdapter)({
    env: childEnv,
  });
  const quick = (overrides.createProcessAdapter ?? createProcessCommandAdapter)({
    env: childEnv,
    timeoutMs: 10_000,
  });
  return {
    store: new DispatchRepository(db),
    herdr: (overrides.createHerdr ?? createHerdrClient)(adapter),
    pane: (overrides.createHerdrPane ?? createHerdrPaneClient)(quick),
    probeHelp: (executable) => quick([executable, "--help"]),
    resolveExecutable: (name) => resolveExecutable(name, env.PATH),
    launchFiles: launchFilesIn(home),
    launchEnvNames: launchEnvNames(env),
    close: () => db.close(),
  };
}

export function createRulesRunDeps(
  env: NodeJS.Dict<string>,
  cwd: string,
  rulesFlag: string | undefined,
  overrides: RulesRuntimeOverrides = {},
): RulesRunDeps {
  return {
    cwd,
    home: userHome(env),
    ...(rulesFlag ? { rulesFlag } : {}),
    env,
    // Semantic mode is the only path that looks for a TypeSafe key, and only when asked.
    createSemanticClient: () => {
      const config = loadConfig({ env });
      const key =
        resolveCredential(config.typesafe?.apiKeyRef, env, overrides.readKeychain) ??
        resolveEnvCredential("env:TYPESAFE_API_KEY", env);
      return key ? (overrides.createTypeSafeClient ?? createLiveTypeSafeClient)(key) : undefined;
    },
    openDispatch: () => openDispatchDeps(env, overrides),
    sharedProviders: () =>
      loadConfig({ env })
        .accounts.filter((account) => account.enabled && account.ownership === "shared")
        .flatMap((account) => AGENT_PROVIDER[account.agent] ?? []),
  };
}
