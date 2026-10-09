#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { executeRun, type RunDeps } from "./commands/run.js";
import { executeEffort, type EffortDeps, type EffortRequest } from "./commands/effort.js";
import { ReasoningEffortSchema } from "./domain/model-profile.js";
import { LIVE_LEVELS, runsInsideAgent } from "./live-effort/levels.js";
import { SignalsSchema } from "./live-effort/signals.js";
import { formatStatus } from "./commands/status.js";
import { formatSession, formatSessionList } from "./commands/session.js";
import { openDatabase } from "./store/database.js";
import { SessionRepository } from "./store/session-repository.js";
import { EffortChangeRepository } from "./store/effort-change-repository.js";
import { UsageRepository } from "./store/usage-repository.js";

const { version: ROUTER_VERSION } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

const NO_SESSIONS = "No router sessions yet. Sessions are recorded when `router run` launches.\n";
import { formatAccounts } from "./commands/accounts.js";
import { usageRefresh } from "./commands/usage.js";
import { loadConfig } from "./config/config-loader.js";
import { createDefaultRunDeps } from "./commands/runtime.js";
import { formatError } from "./presentation/errors.js";
import { formatAccountQuota } from "./presentation/quota.js";
import { collectUsageChain } from "./collectors/collector-chain.js";
import { collectorsForAccount } from "./collectors/registry.js";
import type { Account } from "./domain/account.js";
import type { UsageSnapshot } from "./domain/usage.js";
import {
  executePlan,
  executeRoles,
  userHome,
  type CommandResult,
} from "./commands/rules-commands.js";
import { executeRulesRun } from "./commands/rules-run.js";
import {
  createRulesRunDeps,
  openDispatchDeps,
  type RulesRuntimeOverrides,
} from "./commands/rules-runtime.js";
import {
  executeTaskClose,
  executeTaskRecover,
  executeTaskRevise,
  executeTaskStatus,
} from "./commands/task-commands.js";

export interface CliIo {
  write(chunk: string): boolean;
}

export interface CliOptions {
  stdout?: CliIo;
  stderr?: CliIo;
  env?: NodeJS.Dict<string>;
  run?: typeof executeRun;
  runDeps?: RunDeps;
  collectUsage?: (account: Account) => Promise<UsageSnapshot>;
  createRunDeps?: typeof createDefaultRunDeps;
  effort?: typeof executeEffort;
  effortDeps?: EffortDeps;
  /** Directory rules-mode commands resolve the project and rules from. Default: cwd. */
  cwd?: string;
  /** Test seams for rules-mode launches, semantic classification, and task commands. */
  rulesOverrides?: RulesRuntimeOverrides;
}

const ROUTING_MODES = ["rules", "semantic", "quota"] as const;
type RoutingModeFlag = (typeof ROUTING_MODES)[number];

function effortDepsFrom(deps: RunDeps): EffortDeps {
  if (!deps.sessions || !deps.effortChanges) {
    throw new Error("router effort needs the router state database");
  }
  return {
    sessions: deps.sessions,
    effortChanges: deps.effortChanges,
    pane: deps.herdrPane,
    client: deps.client,
    accounts: deps.accounts,
    models: deps.models,
    usage: deps.usage,
    reservations: deps.reservations,
    env: deps.callerEnv ?? deps.env,
    liveEffortEnabled: deps.liveEffortEnabled ?? false,
  };
}

const MAX_SUB_STEP_LENGTH = 500;

/** A sub-step is one line of plain text: it may be typed into a TUI as a queued message. */
function checkedSubStep(text: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) {
    throw new Error("The sub-step must be one line of plain text, without control characters.");
  }
  if (text.trim() === "" || text.length > MAX_SUB_STEP_LENGTH) {
    throw new Error(`The sub-step must be 1 to ${MAX_SUB_STEP_LENGTH} characters.`);
  }
  return text;
}

function optionalInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`--${name} must be a whole number`);
  return Number.parseInt(value, 10);
}

export function createProgram(options: CliOptions = {}): Command & { exitCode?: number } {
  const stdout: CliIo = options.stdout ?? {
    write(chunk: string) {
      process.stdout.write(chunk);
      return true;
    },
  };
  const stderr: CliIo = options.stderr ?? {
    write(chunk: string) {
      process.stderr.write(chunk);
      return true;
    },
  };
  const env = options.env ?? process.env;
  const program = new Command() as Command & { exitCode?: number };
  program
    .name("router")
    .description(
      "Herdr Model Router: route a task to a role's models from your pstack-models.mdc rules (alias: hmr)",
    )
    .version(ROUTER_VERSION);
  program.configureOutput({
    writeOut: (chunk) => {
      stdout.write(chunk);
    },
    writeErr: (chunk) => {
      stderr.write(chunk);
    },
  });
  program.exitOverride();
  const cwd = options.cwd ?? process.cwd();
  const emit = (result: CommandResult, json: boolean | undefined) => {
    (result.code === 0 || json ? stdout : stderr).write(
      `${json ? JSON.stringify(result.json) : result.output}\n`,
    );
    program.exitCode = result.code;
  };
  const guarded = (action: () => CommandResult | Promise<CommandResult>, json?: boolean) =>
    Promise.resolve()
      .then(action)
      .then((result) => emit(result, json))
      .catch((error: unknown) => {
        stderr.write(`${formatError(error)}\n`);
        program.exitCode = 1;
      });
  program
    .command("roles")
    .alias("list")
    .description("List the roles in the rules file (reads files only)")
    .option("--rules <path>", "Rules file to read instead of the project or user default")
    .option("--json", "Emit JSON", false)
    .action((flags: { rules?: string; json?: boolean }) =>
      guarded(
        () =>
          executeRoles({
            cwd,
            home: userHome(env),
            ...(flags.rules ? { rulesFlag: flags.rules } : {}),
          }),
        flags.json,
      ),
    );
  program
    .command("plan")
    .alias("preview")
    .description("Show the lanes, models and native argv a role would launch (reads files only)")
    .requiredOption("--role <name>", "Role from the rules file")
    .option(
      "--parent <descriptor>",
      "provider:model@effort the parent runs; resolves parent aliases",
    )
    .option("--rules <path>", "Rules file to read instead of the project or user default")
    .option("--read-only", "Plan a single-lane role as read-only", false)
    .option("--json", "Emit JSON", false)
    .action(
      (flags: {
        role: string;
        parent?: string;
        rules?: string;
        readOnly?: boolean;
        json?: boolean;
      }) =>
        guarded(
          () =>
            executePlan(
              { cwd, home: userHome(env), ...(flags.rules ? { rulesFlag: flags.rules } : {}) },
              {
                role: flags.role,
                ...(flags.parent !== undefined ? { parent: flags.parent } : {}),
                ...(flags.readOnly ? { readOnly: true } : {}),
              },
            ),
          flags.json,
        ),
    );
  program
    .command("run")
    .argument("<task>")
    .option("--role <name>", "Role from the rules file (required unless --routing-mode semantic)")
    .option(
      "--routing-mode <mode>",
      "rules (default, offline rules file), semantic (TypeSafe picks a role; API-billed), quota (legacy TypeSafe quota ranking; API-billed)",
    )
    .option(
      "--parent <descriptor>",
      "provider:model@effort the parent runs; resolves parent aliases",
    )
    .option("--rules <path>", "Rules file to read instead of the project or user default")
    .option("--read-only", "Run a single-lane role read-only", false)
    .option("--dry-run", "Print the route without launching", false)
    .option("--json", "Emit JSON for plugins", false)
    .option("--session <id>", "Route the next phase of an earlier router session (quota mode)")
    .option(
      "--usage",
      "Also run official CLI/API and browser quota collectors (slower; quota mode)",
      false,
    )
    .option("--no-enrich", "Skip pull request size resolution (quota mode)")
    .option(
      "--worktree",
      "Launch in a new Git worktree and branch from the committed HEAD (quota mode; needs a clean checkout)",
      false,
    )
    .action(
      async (
        task: string,
        flags: {
          dryRun?: boolean;
          json?: boolean;
          usage?: boolean;
          session?: string;
          enrich?: boolean;
          worktree?: boolean;
          role?: string;
          routingMode?: string;
          parent?: string;
          rules?: string;
          readOnly?: boolean;
        },
      ) => {
        const mode = (flags.routingMode ?? "rules") as RoutingModeFlag;
        if (!ROUTING_MODES.includes(mode)) {
          stderr.write(`--routing-mode must be one of ${ROUTING_MODES.join(", ")}\n`);
          program.exitCode = 2;
          return;
        }
        if (mode !== "quota") {
          const quotaOnly = [
            flags.session ? "--session" : undefined,
            flags.worktree ? "--worktree" : undefined,
            flags.usage ? "--usage" : undefined,
            flags.enrich === false ? "--no-enrich" : undefined,
          ].filter(Boolean);
          if (quotaOnly.length > 0) {
            stderr.write(`${quotaOnly.join(", ")} need --routing-mode quota\n`);
            program.exitCode = 2;
            return;
          }
          await guarded(
            () =>
              executeRulesRun(
                task,
                {
                  mode,
                  dryRun: Boolean(flags.dryRun),
                  ...(flags.role ? { role: flags.role } : {}),
                  ...(flags.parent !== undefined ? { parent: flags.parent } : {}),
                  ...(flags.readOnly ? { readOnly: true } : {}),
                },
                createRulesRunDeps(env, cwd, flags.rules, options.rulesOverrides),
              ),
            flags.json,
          );
          return;
        }
        if (flags.role || flags.parent !== undefined || flags.rules || flags.readOnly) {
          stderr.write(
            "--role, --parent, --rules and --read-only apply to rules and semantic modes\n",
          );
          program.exitCode = 2;
          return;
        }
        try {
          const result = await (options.run ?? executeRun)(
            task,
            {
              ...(flags.session
                ? {
                    dryRun: Boolean(flags.dryRun),
                    previousSessionId: flags.session,
                    noEnrich: flags.enrich === false,
                  }
                : { dryRun: Boolean(flags.dryRun), noEnrich: flags.enrich === false }),
              ...(flags.worktree ? { worktree: true } : {}),
            },
            options.runDeps ??
              (await (options.createRunDeps ?? createDefaultRunDeps)(env, {
                usageMode: flags.usage ? "full" : "local",
              })),
          );
          stdout.write(`${flags.json ? JSON.stringify(result.json) : result.output}\n`);
          program.exitCode = result.code;
        } catch (error) {
          stderr.write(`${formatError(error)}\n`);
          program.exitCode = 1;
        }
      },
    );
  program
    .command("effort")
    .description(
      "Change the reasoning effort of a running Opus 5.5 or GPT 6 Astra pane. " +
        'Agent: router effort --session <id> "<sub-step>" [signals]. User: router effort <id> <level>.',
    )
    .argument("<first>", "The sub-step (with --session), or the session id")
    .argument("[level]", "The level to switch to (manual override, without --session)")
    .option(
      "--session <id>",
      "Session whose pane to switch; TypeSafe picks the level for the sub-step",
    )
    .option("--step-kind <kind>", "explore, edit, debug, verify, or refactor")
    .option("--consecutive-failures <n>", "Failed attempts in a row at this sub-step")
    .option("--tests-failing", "Tests are currently failing", false)
    .option("--files-touched <n>", "Files changed so far in this phase")
    .option("--diff-lines <n>", "Lines changed so far in this phase")
    .option("--blocked", "The agent is stuck on this sub-step", false)
    .option("--json", "Emit JSON for plugins", false)
    .action(
      async (
        first: string,
        level: string | undefined,
        flags: {
          session?: string;
          stepKind?: string;
          consecutiveFailures?: string;
          testsFailing?: boolean;
          filesTouched?: string;
          diffLines?: string;
          blocked?: boolean;
          json?: boolean;
        },
      ) => {
        try {
          let sessionId: string;
          let request: EffortRequest;
          if (flags.session) {
            if (level !== undefined) {
              throw new Error("Pass either --session <id> with a sub-step, or <id> <level>.");
            }
            sessionId = flags.session;
            request = {
              kind: "agent",
              subStep: checkedSubStep(first),
              signals: SignalsSchema.parse({
                ...(flags.stepKind ? { stepKind: flags.stepKind } : {}),
                ...(flags.consecutiveFailures !== undefined
                  ? {
                      consecutiveFailures: optionalInt(
                        flags.consecutiveFailures,
                        "consecutive-failures",
                      ),
                    }
                  : {}),
                ...(flags.testsFailing ? { testsFailing: true } : {}),
                ...(flags.filesTouched !== undefined
                  ? { filesTouched: optionalInt(flags.filesTouched, "files-touched") }
                  : {}),
                ...(flags.diffLines !== undefined
                  ? { diffLines: optionalInt(flags.diffLines, "diff-lines") }
                  : {}),
                ...(flags.blocked ? { blocked: true } : {}),
              }),
            };
          } else {
            if (runsInsideAgent(env)) {
              throw new Error(
                "The manual form is for you, not an agent: run it yourself in a terminal pane that is not running an agent. " +
                  'Agents use router effort --session <id> "<sub-step>".',
              );
            }
            const parsed = ReasoningEffortSchema.safeParse(level);
            if (!parsed.success) {
              throw new Error(
                `Pass a level: router effort <id> <${LIVE_LEVELS.join("|")}>, or use --session <id> "<sub-step>".`,
              );
            }
            sessionId = first;
            request = { kind: "manual", level: parsed.data };
          }
          const deps =
            options.effortDeps ??
            effortDepsFrom(
              options.runDeps ?? (await (options.createRunDeps ?? createDefaultRunDeps)(env)),
            );
          const result = await (options.effort ?? executeEffort)(sessionId, request, deps);
          stdout.write(`${flags.json ? JSON.stringify(result.json) : result.output}\n`);
          program.exitCode = result.code;
        } catch (error) {
          stderr.write(`${formatError(error)}\n`);
          program.exitCode = 1;
        }
      },
    );
  const task = program
    .command("task")
    .description("Inspect and close rules-mode tasks; revise a writer in its own pane");
  const withStore =
    (
      action: (deps: ReturnType<typeof openDispatchDeps>) => CommandResult | Promise<CommandResult>,
    ) =>
    async () => {
      const deps = openDispatchDeps(env, options.rulesOverrides);
      try {
        return await action(deps);
      } finally {
        deps.close();
      }
    };
  task
    .command("status")
    .argument("[id]", "Task id (omit to list recent tasks)")
    .option("--limit <n>", "How many tasks the list shows", "20")
    .option("--json", "Emit JSON", false)
    .action((id: string | undefined, flags: { limit: string; json?: boolean }) =>
      guarded(
        withStore((deps) =>
          executeTaskStatus(deps.store, id, Math.max(1, Number.parseInt(flags.limit, 10) || 20)),
        ),
        flags.json,
      ),
    );
  task
    .command("revise")
    .argument("<id>", "Writer task id")
    .argument("<text>", "Revision to send to the task's original agent and pane")
    .option("--json", "Emit JSON", false)
    .action((id: string, text: string, flags: { json?: boolean }) =>
      guarded(
        withStore((deps) => executeTaskRevise(deps, id, text)),
        flags.json,
      ),
    );
  task
    .command("complete")
    .argument("<id>", "Task id")
    .requiredOption("--evidence <text>", "What shows the work is finished")
    .option("--json", "Emit JSON", false)
    .action((id: string, flags: { evidence: string; json?: boolean }) =>
      guarded(
        withStore((deps) =>
          executeTaskClose(deps.store, id, { status: "complete", evidence: flags.evidence }),
        ),
        flags.json,
      ),
    );
  task
    .command("release")
    .argument("<id>", "Task id")
    .option("--stopped", "Confirm the writer has stopped", false)
    .requiredOption("--evidence <text>", "What shows the writer stopped")
    .option("--json", "Emit JSON", false)
    .action((id: string, flags: { stopped?: boolean; evidence: string; json?: boolean }) =>
      guarded(
        withStore((deps) =>
          executeTaskClose(deps.store, id, {
            status: "released",
            evidence: flags.evidence,
            stopped: Boolean(flags.stopped),
          }),
        ),
        flags.json,
      ),
    );
  task
    .command("recover")
    .argument("<attempt>", "Attempt id left sending or unknown")
    .option("--delivered", "The pane shows the prompt arrived", false)
    .option("--not-delivered", "The pane shows the prompt never arrived", false)
    .requiredOption("--evidence <text>", "What you saw in the pane")
    .option("--json", "Emit JSON", false)
    .action(
      (
        attempt: string,
        flags: { delivered?: boolean; notDelivered?: boolean; evidence: string; json?: boolean },
      ) =>
        guarded(
          withStore((deps) => executeTaskRecover(deps.store, attempt, flags)),
          flags.json,
        ),
    );
  program
    .command("status")
    .option("--usage", "Show each account's quota (slower)", false)
    .action(async (flags: { usage?: boolean }) => {
      try {
        const config = loadConfig({ env });
        if (!flags.usage) {
          stdout.write(`${formatStatus({ accounts: config.accounts })}\n`);
          return;
        }
        const collect =
          options.collectUsage ??
          ((account: Account) => collectUsageChain(account, collectorsForAccount(account)));
        const snapshots = await Promise.all(config.accounts.map((account) => collect(account)));
        const quota = Object.fromEntries(
          config.accounts.map((account, index) => [
            account.id,
            formatAccountQuota(snapshots[index]!),
          ]),
        );
        stdout.write(`${formatStatus({ accounts: config.accounts, quota })}\n`);
      } catch (error) {
        stderr.write(`${formatError(error)}\n`);
        program.exitCode = 1;
      }
    });
  program
    .command("session")
    .argument("[id]", "Session id (defaults to the latest session)")
    .option("--list", "List recent sessions, newest first", false)
    .option("--limit <n>", "How many sessions --list shows", "20")
    .option("--json", "Emit JSON for plugins", false)
    .action((id: string | undefined, flags: { list?: boolean; limit: string; json?: boolean }) => {
      let db;
      try {
        db = openDatabase({ home: loadConfig({ env }).home });
        const sessions = new SessionRepository(db);
        if (flags.list) {
          const limit = Math.max(1, Number.parseInt(flags.limit, 10) || 20);
          const listed = sessions.list(limit);
          if (flags.json) {
            stdout.write(`${JSON.stringify(listed)}\n`);
          } else {
            stdout.write(listed.length > 0 ? `${formatSessionList(listed)}\n` : NO_SESSIONS);
          }
          return;
        }
        const session = id ? sessions.get(id) : sessions.latest();
        if (!session) {
          if (id) {
            stderr.write(`Session not found: ${id}\n`);
            program.exitCode = 1;
          } else {
            stdout.write(flags.json ? "null\n" : NO_SESSIONS);
          }
          return;
        }
        const effortChanges = new EffortChangeRepository(db).listForSession(session.id);
        stdout.write(
          `${
            flags.json
              ? JSON.stringify({ ...session, effortChanges })
              : formatSession(session, effortChanges)
          }\n`,
        );
      } catch (error) {
        stderr.write(`${formatError(error)}\n`);
        program.exitCode = 1;
      } finally {
        db?.close();
      }
    });
  program.command("accounts").action(() => {
    try {
      const config = loadConfig({ env });
      stdout.write(`${formatAccounts(config.accounts)}\n`);
    } catch (error) {
      stderr.write(`${formatError(error)}\n`);
      program.exitCode = 1;
    }
  });
  program
    .command("usage")
    .command("refresh")
    .option("--source <source>", "local-session|official-cli|browser", "local-session")
    .option("--dry-run", "Do not persist", false)
    .action(async (flags: { source?: string; dryRun?: boolean }) => {
      const source =
        flags.source === "official-cli" || flags.source === "browser"
          ? flags.source
          : "local-session";
      const config = loadConfig({ env });
      const db = openDatabase({ home: config.home });
      try {
        const repo = new UsageRepository(db);
        const printed = await usageRefresh({
          source,
          dryRun: Boolean(flags.dryRun),
          accounts: config.accounts,
          collect: (account) => {
            const collectors = collectorsForAccount(account).filter((collector) =>
              source === "browser"
                ? collector.kind === "browser-dashboard"
                : collector.kind === source,
            );
            return collectUsageChain(account, collectors);
          },
          persist: (snapshot) => {
            repo.save(snapshot);
          },
        });
        stdout.write(`${printed}\n`);
      } catch (error) {
        stderr.write(`${formatError(error)}\n`);
        program.exitCode = 1;
      } finally {
        db.close();
      }
    });
  return program;
}

export async function runCli(argv: string[], options: CliOptions = {}): Promise<number> {
  const program = createProgram(options);
  // `hmr` is the same CLI under a shorter, non-conflicting name.
  if (argv[1] && path.basename(argv[1]).replace(/\.js$/, "") === "hmr") program.name("hmr");
  try {
    await program.parseAsync(argv);
  } catch (error) {
    // exitOverride turns --help, --version, and usage errors into thrown CommanderErrors.
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    throw error;
  }
  return program.exitCode ?? 0;
}

// npm link and global installs start the CLI through a symlink, so compare real paths.
export function isEntrypoint(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) {
    return false;
  }
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  process.exitCode = await runCli(process.argv);
}
