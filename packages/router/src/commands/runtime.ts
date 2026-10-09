import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { loadModelCatalog } from "../catalog/model-catalog.js";
import { loadConfig } from "../config/config-loader.js";
import type { RunDeps } from "./run.js";
import type { Account } from "../domain/account.js";
import { collectUsageChain } from "../collectors/collector-chain.js";
import { collectorsForAccount as defaultCollectorsForAccount } from "../collectors/registry.js";
import type { UsageCollector } from "../collectors/types.js";
import { createLiveTypeSafeClient, type TypeSafePort } from "../semantic/typesafe-client.js";
import {
  createHerdrClient,
  createHerdrPaneClient,
  createProcessCommandAdapter,
  type HerdrClient,
  type HerdrPaneClient,
  type RunCommand,
} from "../launch/herdr-client.js";
import { isHerdrEnv } from "../launch/readiness.js";
import { createCoordinatorClient, type CoordinatorClient } from "../activity/coordinator-client.js";
import { accountFingerprint } from "@agent-router/hermes-heartbeat";
import { createBrowserDashboardCollector } from "../collectors/browser/dashboard-collector.js";
import { runCommand } from "../collectors/command-runner.js";
import { openDatabase } from "../store/database.js";
import { WorkflowRepository, WriterAuthorityError } from "../store/workflow-repository.js";
import {
  DispatchRepository,
  OwnershipConflictError,
  UnresolvedAttemptError,
} from "../store/dispatch-repository.js";
import { worktreeIdentity } from "../rules/rules-source.js";
import { SessionRepository } from "../store/session-repository.js";
import { UsageRepository } from "../store/usage-repository.js";
import { ReservationRepository } from "../store/reservation-repository.js";
import { ReservationService } from "../reservations/reservation-service.js";
import { EffortChangeRepository } from "../store/effort-change-repository.js";
import { resolverEnv } from "../enrich/resolver.js";

function unavailableTypeSafe(): TypeSafePort {
  return {
    calls: [],
    async systemOne() {
      throw new Error("TypeSafe is not configured; live API calls are disabled until approved");
    },
  };
}

export function sanitizeRuntimeEnv(env: NodeJS.Dict<string>): NodeJS.Dict<string> {
  const allowed =
    /^(?:PATH|HOME|USER|LOGNAME|SHELL|TERM|TERM_PROGRAM|TERM_PROGRAM_VERSION|COLORTERM|LANG|LC_[A-Z_]+|TMPDIR|TMP|TEMP|XDG_[A-Z_]+|HERDR_[A-Z0-9_]+|CODEX_HOME|CLAUDE_CONFIG_DIR|CURSOR_TRACE_ID|SSH_AUTH_SOCK)$/;
  return Object.fromEntries(
    Object.entries(env).filter(([key, value]) => Boolean(value) && allowed.test(key)),
  );
}

/**
 * The caller variables live effort switching reads: which pane is calling, the calling
 * Claude agent's own level, and whether the caller is an agent at all. Nothing else, so no
 * secret from the caller's environment is carried on the deps.
 */
export function liveEffortCallerEnv(env: NodeJS.Dict<string>): NodeJS.Dict<string> {
  return Object.fromEntries(
    ["HERDR_PANE_ID", "CLAUDE_EFFORT", "CLAUDECODE", "CODEX_THREAD_ID", "CODEX_SANDBOX"]
      .filter((key) => Boolean(env[key]))
      .map((key) => [key, env[key]]),
  );
}

export function resolveEnvCredential(
  ref: string | undefined,
  env: NodeJS.Dict<string>,
): string | undefined {
  if (!ref) {
    return undefined;
  }
  const match = /^env:([A-Z0-9_]+)$/.exec(ref);
  if (!match) {
    return undefined;
  }
  const value = env[match[1]!];
  return value && value.length > 0 ? value : undefined;
}

export type KeychainReader = (service: string) => string | undefined;

/** Reads a generic password from the macOS login Keychain by service name. */
export function readMacKeychain(service: string): string | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }
  try {
    const value = execFileSync("security", ["find-generic-password", "-s", service, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Resolves `env:NAME` from the environment or `keychain:NAME` from the Keychain. */
export function resolveCredential(
  ref: string | undefined,
  env: NodeJS.Dict<string>,
  readKeychain: KeychainReader = readMacKeychain,
): string | undefined {
  const keychain = ref ? /^keychain:([A-Za-z0-9._-]+)$/.exec(ref) : null;
  return keychain ? readKeychain(keychain[1]!) : resolveEnvCredential(ref, env);
}

export interface RuntimeOverrides {
  createTypeSafeClient?: (apiKey: string) => TypeSafePort;
  createProcessAdapter?: (options?: { env?: NodeJS.ProcessEnv }) => RunCommand;
  createHerdr?: (runCommand: RunCommand) => HerdrClient;
  createHerdrPane?: (runCommand: RunCommand) => HerdrPaneClient;
  collectorsForAccount?: (account: Account) => UsageCollector[];
  activityClient?: CoordinatorClient;
  fetchImpl?: typeof fetch;
  runCommand?: typeof runCommand;
  fetchDashboardHtml?: (provider: Account["provider"]) => Promise<string>;
  sessions?: RunDeps["sessions"];
  readKeychain?: KeychainReader;
  /** Default `"local"`: only `local-session` collectors. `"full"`: official, local, and browser. */
  usageMode?: "local" | "full";
}

function filterCollectors(
  collectors: UsageCollector[],
  usageMode: "local" | "full",
): UsageCollector[] {
  if (usageMode === "full") {
    return collectors;
  }
  return collectors.filter((collector) => collector.kind === "local-session");
}

function defaultActivityClient(
  env: NodeJS.Dict<string>,
  fetchImpl?: typeof fetch,
): CoordinatorClient {
  const config = loadConfig({ env });
  const token = resolveCredential(config.coordinator?.readerCredentialRef, env);
  const fingerprintSecret = env.HEARTBEAT_FINGERPRINT_SECRET;
  if (!config.coordinator?.url || !token || !fingerprintSecret) {
    return {
      async status() {
        return "unreachable";
      },
    };
  }
  const inner = createCoordinatorClient({
    baseUrl: config.coordinator.url,
    readerToken: token,
    fetchImpl,
  });
  return {
    async status(accountId: string) {
      return inner.status(accountFingerprint(accountId, fingerprintSecret));
    },
  };
}

/**
 * Quota mode's writer authority over the router database: an early refusal for a launch
 * directory, and the atomic acquisition that holds the worktree for the writer's lifetime.
 * Both follow the same binding, open-workflow, and ownership rules as rules-mode writers and
 * workflows, through the same writer-task ownership row.
 */
export function createWriterGates(
  db: Database.Database,
  herdrPane: Pick<HerdrPaneClient, "getAgent"> | undefined,
): Pick<RunDeps, "writerGate" | "writerAuthority"> {
  const workflows = new WorkflowRepository(db);
  const store = new DispatchRepository(db);
  const worktreeOf = (cwd: string) => {
    try {
      return worktreeIdentity(cwd);
    } catch {
      return undefined;
    }
  };
  return {
    writerGate: (cwd, continuing) => {
      const worktreeId = worktreeOf(cwd);
      return worktreeId
        ? workflows.legacyWriterRefusal(worktreeId, continuing)?.message
        : undefined;
    },
    writerAuthority: {
      worktreeOf,
      async acquire({ target, continuing, role, descriptor }) {
        let cwd: string;
        if ("paneId" in target) {
          // The caller's directory says nothing about where a continued pane writes.
          const owned = workflows.writerPaneRefusal(target.paneId, continuing);
          if (owned) return { ok: false, error: owned.message };
          const live = await herdrPane?.getAgent(target.paneId).catch(() => undefined);
          if (!live?.cwd) {
            return {
              ok: false,
              error: `Cannot read the working directory of pane ${target.paneId}, so its worktree's writer authority is unknown; nothing was sent.`,
            };
          }
          cwd = live.cwd;
        } else {
          cwd = target.cwd;
        }
        const worktreeId = worktreeOf(cwd);
        if (!worktreeId) {
          return { ok: false, error: `Directory ${cwd} cannot be resolved; nothing was sent.` };
        }
        if (continuing && store.ownershipOfTask(continuing)?.worktreeId === worktreeId) {
          const lane = store.lanes(continuing)[0];
          if (lane)
            return { ok: true, taskId: continuing, laneId: lane.id, worktreeId, continued: true };
        }
        try {
          const { task, lanes } = store.createTask({
            role,
            kind: "single",
            access: "write",
            worktreeId,
            cwd,
            rulesPath: "quota-mode",
            lanes: [
              {
                index: 1,
                descriptor: `quota:${descriptor.provider}/${descriptor.model}@${descriptor.effort}`,
                provider: descriptor.provider,
                model: descriptor.model,
                effort: descriptor.effort,
                argv: [],
              },
            ],
          });
          return { ok: true, taskId: task.id, laneId: lanes[0]!.id, worktreeId, continued: false };
        } catch (error) {
          if (error instanceof WriterAuthorityError || error instanceof OwnershipConflictError) {
            return { ok: false, error: error.message };
          }
          throw error;
        }
      },
      recordHandoff(taskId, laneId, handoff) {
        store.updateLane(laneId, {
          ...(handoff.paneId ? { paneId: handoff.paneId } : {}),
          ...(handoff.agentName ? { agentName: handoff.agentName } : {}),
          state: handoff.outcome === "not-sent" ? "failed" : "prompted",
          ...(handoff.outcome === "sent" ? {} : { error: handoff.evidence }),
        });
        if (handoff.outcome !== "not-sent") {
          // The handoff itself, as an attempt: `task status` shows it and `task recover`
          // records what the pane shows. An unknown attempt also keeps `task complete` closed.
          try {
            const attempt = store.beginAttempt({
              laneId,
              purpose: "initial",
              promptSha256: handoff.promptSha256,
            });
            store.finishAttempt(
              attempt.id,
              handoff.outcome === "sent" ? "sent" : "unknown",
              handoff.evidence,
            );
          } catch (error) {
            // An earlier handoff of this chain is still unresolved: its evidence stays on
            // record, this one on the lane; the worktree stays held either way.
            if (!(error instanceof UnresolvedAttemptError)) throw error;
          }
        }
        store.finishDispatch(taskId, handoff.outcome === "sent" ? "dispatched" : "failed");
      },
      rollback(taskId, evidence) {
        store.releaseUnsent(taskId, evidence);
      },
    },
  };
}

export async function createDefaultRunDeps(
  env: NodeJS.Dict<string>,
  overrides: RuntimeOverrides = {},
): Promise<RunDeps> {
  const config = loadConfig({ env });
  const catalog = loadModelCatalog();
  const resolveCollectors =
    overrides.collectorsForAccount ??
    ((account: Account) =>
      defaultCollectorsForAccount(account, {
        runCommand: overrides.runCommand,
        browserCollector: createBrowserDashboardCollector({
          approvedBridge: env.MODEL_ROUTER_BROWSER_BRIDGE === "1",
          fetchHtml: overrides.fetchDashboardHtml,
        }),
      }));
  const usageMode = overrides.usageMode ?? "local";
  const snapshots = await Promise.all(
    config.accounts.map((account) =>
      collectUsageChain(account, filterCollectors(resolveCollectors(account), usageMode)),
    ),
  );
  const usage: RunDeps["usage"] = Object.fromEntries(
    config.accounts.map((account, index) => [account.id, snapshots[index]!]),
  );
  const db = openDatabase({ home: config.home });
  const usageRepo = new UsageRepository(db);
  for (const snapshot of snapshots) {
    if (snapshot.certainty !== "unknown") {
      usageRepo.save(snapshot);
    }
  }
  // The configured reference (for example keychain:model-router-typesafe) works in every
  // pane without exporting the key; TYPESAFE_API_KEY remains a fallback.
  const apiKeyRef = config.typesafe?.apiKeyRef;
  const apiKey =
    resolveCredential(apiKeyRef, env, overrides.readKeychain) ??
    resolveEnvCredential("env:TYPESAFE_API_KEY", env);
  const createTypeSafe = overrides.createTypeSafeClient ?? createLiveTypeSafeClient;
  const client = apiKey ? createTypeSafe(apiKey) : unavailableTypeSafe();
  const checked = [
    ...(apiKeyRef && apiKeyRef !== "env:TYPESAFE_API_KEY" ? [apiKeyRef] : []),
    "TYPESAFE_API_KEY",
  ];
  const typesafeKeyHint = apiKey
    ? undefined
    : `No TypeSafe API key found (checked ${checked.join(" and ")}). Store it once with: ` +
      'security add-generic-password -a "$USER" -s model-router-typesafe -w';
  let herdr: HerdrClient | undefined;
  let herdrPane: HerdrPaneClient | undefined;
  if (isHerdrEnv(env)) {
    const adapter = (overrides.createProcessAdapter ?? createProcessCommandAdapter)({
      env: sanitizeRuntimeEnv(env),
    });
    herdr = (overrides.createHerdr ?? createHerdrClient)(adapter);
    // Pane reads and keystrokes are quick; a short per-call limit keeps a hung Herdr call
    // inside the lock TTLs, which assume each call returns within seconds.
    const paneAdapter = (overrides.createProcessAdapter ?? createProcessCommandAdapter)({
      env: sanitizeRuntimeEnv(env),
      timeoutMs: 5_000,
    });
    herdrPane = (overrides.createHerdrPane ?? createHerdrPaneClient)(paneAdapter);
  }
  return {
    typesafeKeyHint,
    sessions: overrides.sessions ?? new SessionRepository(db),
    reservations: new ReservationService(Date.now, new ReservationRepository(db)),
    accounts: config.accounts,
    models: catalog.models.filter((model) =>
      config.accounts.some((account) => account.enabledModels.includes(model.id)),
    ),
    usage,
    client,
    env: sanitizeRuntimeEnv(env),
    enrichEnv: resolverEnv(env),
    herdr,
    herdrPane,
    effortChanges: new EffortChangeRepository(db),
    liveEffortEnabled: config.liveEffort?.enabled ?? false,
    callerEnv: liveEffortCallerEnv(env),
    activityClient: overrides.activityClient ?? defaultActivityClient(env, overrides.fetchImpl),
    runCommand: overrides.runCommand,
    enrichmentEnabled: config.enrichment?.enabled ?? true,
    cwd: process.cwd(),
    ...createWriterGates(db, herdrPane),
    // Router state, not the user's checkout, so a worktree is never nested inside the repo.
    worktreeRoot: path.join(config.home, "worktrees"),
  };
}
