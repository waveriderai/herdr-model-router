import { spawn } from "node:child_process";
import { z } from "zod";

/**
 * The optional agent-collab writer authority, driven as a separate CLI. HMR never imports or
 * modifies that tool: it runs `agent-collab <command>` with argv only, a bounded timeout, and
 * the same allowlisted environment as other Herdr calls, then accepts only the response fields
 * it needs. The owner capability goes to the CLI as its `--owner` argument (the only form the
 * CLI accepts); it is never placed in a prompt, a log, router JSON, or SQLite, and is redacted
 * from anything the CLI prints.
 */
export type CollabCall<T> =
  | { kind: "ok"; value: T }
  /** The CLI answered and changed nothing it reports as done. */
  | { kind: "refused"; code: number; error: string; outcome?: string }
  /** No trustworthy answer (timeout, crash, unreadable output): the effect is unknown. */
  | { kind: "unknown"; error: string };

export interface CollabProcessResult {
  /** null when the process did not exit on its own (timeout or spawn failure). */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

export type CollabRunner = (argv: readonly string[]) => Promise<CollabProcessResult>;

export function createCollabRunner(input: {
  env: NodeJS.Dict<string>;
  timeoutMs: number;
}): CollabRunner {
  return (argv) =>
    new Promise((resolve) => {
      const [command, ...args] = argv;
      if (!command) {
        resolve({
          code: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          spawnError: "missing command",
        });
        return;
      }
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: input.env });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, input.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ code: null, stdout, stderr, timedOut, spawnError: String(error) });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: timedOut ? null : code, stdout, stderr, timedOut });
      });
    });
}

const AcquireResponse = z.object({
  ok: z.literal(true),
  run_id: z.string().min(1),
  owner_token: z.string().regex(/^[0-9a-f]{16,128}$/),
  attempt: z.string().min(1),
});
const DispatchResponse = z.object({
  ok: z.boolean(),
  run_id: z.string().min(1),
  outcome: z.string().min(1),
  sent: z.boolean(),
  attempt: z.string().min(1).nullable().optional(),
});
const RequestChangesResponse = z.object({
  ok: z.literal(true),
  run_id: z.string().min(1),
  attempt: z.string().min(1),
});
const OkResponse = z.object({ ok: z.literal(true), run_id: z.string().min(1) });
const StatusResponse = z.object({
  run_id: z.string().min(1),
  state: z.string().min(1),
  current_attempt: z.string().nullable().optional(),
  session: z.string().nullable().optional(),
  pane: z.string().nullable().optional(),
  accepted_at: z.string().nullable().optional(),
  released_at: z.string().nullable().optional(),
  release_kind: z.string().nullable().optional(),
  attempts: z
    .array(
      z.object({
        attempt_id: z.string(),
        kind: z.string().nullable().optional(),
        /** The attempt a revision was requested from. */
        parent: z.string().nullable().optional(),
        dispatch_state: z.string().nullable().optional(),
        outcome: z.string().nullable().optional(),
        receipt_status: z.string().nullable().optional(),
        accepted_at: z.string().nullable().optional(),
      }),
    )
    .optional(),
});

export type CollabStatus = z.infer<typeof StatusResponse>;

/** `agent-collab project --worktree`: the model policy agent-collab will enforce. */
const ProjectResponse = z.object({
  worktree: z.string().min(1),
  project_id: z.string().min(1),
  model_policy: z.object({
    source: z.string().min(1),
    default: z.string().min(1),
    bounded_small_fix: z.string().min(1),
    allowed: z.array(z.string().min(1)),
  }),
});
export type CollabProject = z.infer<typeof ProjectResponse>;

/** The route contract HMR hands agent-collab for a rules-mode writer. */
export const ROUTE_CONTRACT = "hmr.rules-route/v1";

/** `agent-collab capabilities`: read-only; which route contracts and writer kinds it takes. */
const CapabilitiesResponse = z.object({
  schema: z.literal("agent-collab.capabilities/v1"),
  route_contracts: z.array(z.string().min(1)),
  writer_kinds: z.record(z.string(), z.array(z.string().min(1))),
});
export type CollabCapabilities = z.infer<typeof CapabilitiesResponse>;

/** `agent-collab verify --worktree`: read-only preflight; problems make it exit non-zero. */
const VerifyResponse = z.object({
  ok: z.boolean(),
  worktree: z.string().nullable().optional(),
  project_id: z.string().nullable().optional(),
  problems: z.array(z.string()),
});

export interface AgentCollabPort {
  readonly executable: string;
  /** Read-only handshake: the route contracts and writer kinds this agent-collab accepts. */
  capabilities(): Promise<CollabCall<CollabCapabilities>>;
  /** Read-only preflight of host, Herdr, state root and the worktree's project routing. */
  verify(input: { worktree: string }): Promise<CollabCall<{ problems: string[] }>>;
  /** Read-only: the worktree's canonical identity and the model policy agent-collab enforces. */
  project(input: { worktree: string }): Promise<CollabCall<CollabProject>>;
  acquire(input: {
    worktree: string;
    agent: string;
    kind: string;
    pane: string;
    session: string;
    coordinator: string;
    briefFile: string;
    /** The frozen `hmr.rules-route/v1` file; agent-collab validates it and never re-plans. */
    routeFile: string;
  }): Promise<CollabCall<{ runId: string; ownerToken: string; attempt: string }>>;
  dispatch(input: {
    runId: string;
    owner: string;
    attempt: string;
    promptFile: string;
    timeoutMs: number;
  }): Promise<CollabCall<{ outcome: string; sent: boolean; submitted: boolean }>>;
  receipt(input: {
    runId: string;
    owner: string;
    attempt: string;
    status: "impl-complete" | "blocked" | "error";
    noteFile: string;
  }): Promise<CollabCall<null>>;
  requestChanges(input: {
    runId: string;
    owner: string;
    attempt: string;
    noteFile: string;
  }): Promise<CollabCall<{ attempt: string }>>;
  accept(input: {
    runId: string;
    owner: string;
    attempt: string;
    noteFile: string;
  }): Promise<CollabCall<null>>;
  release(input: {
    runId: string;
    owner: string;
    abort: boolean;
    noteFile: string;
  }): Promise<CollabCall<null>>;
  status(input: { runId: string }): Promise<CollabCall<CollabStatus>>;
}

function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret) out = out.split(secret).join("<owner-capability>");
  return out.trim().slice(0, 2000);
}

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

/** Codes agent-collab uses for a refusal it made before changing anything it reports. */
const REFUSAL_CODES = new Set([2, 3, 4, 5, 6, 8, 9]);
const DISPATCH_FAILED = 7;

export function createAgentCollab(input: {
  executable: string;
  run: CollabRunner;
}): AgentCollabPort {
  const { executable, run } = input;
  async function call<T>(
    argv: string[],
    schema: z.ZodType<T>,
    secrets: readonly string[],
  ): Promise<CollabCall<T> & { raw?: unknown }> {
    const result = await run([executable, ...argv]);
    if (result.spawnError) {
      return {
        kind: "unknown",
        error: `agent-collab could not run: ${redact(result.spawnError, secrets)}`,
      };
    }
    if (result.timedOut || result.code === null) {
      return {
        kind: "unknown",
        error: "agent-collab did not answer within its timeout; its effect is unknown",
      };
    }
    const data = parseJson(result.stdout);
    if (result.code === 0) {
      const parsed = schema.safeParse(data);
      return parsed.success
        ? { kind: "ok", value: parsed.data }
        : {
            kind: "unknown",
            error: "agent-collab exited 0 with a response HMR does not recognise",
          };
    }
    const message = redact(
      `${result.stderr}\n${typeof data === "object" ? "" : result.stdout}`,
      secrets,
    );
    if (REFUSAL_CODES.has(result.code)) {
      return {
        kind: "refused",
        code: result.code,
        error: message || `agent-collab refused (exit ${result.code})`,
        raw: data,
      };
    }
    return { kind: "unknown", error: `agent-collab exited ${result.code}: ${message}`, raw: data };
  }
  const strip = <T>(value: CollabCall<T> & { raw?: unknown }): CollabCall<T> => {
    const { raw: _raw, ...rest } = value;
    void _raw;
    return rest as CollabCall<T>;
  };
  return {
    executable,
    async capabilities() {
      return strip(await call(["capabilities"], CapabilitiesResponse, []));
    },
    async verify(args) {
      const out = await call(["verify", "--worktree", args.worktree], VerifyResponse, []);
      if (out.kind === "ok") return { kind: "ok", value: { problems: out.value.problems } };
      // Problems exit non-zero with the same JSON: report them as the refusal reason.
      const parsed = VerifyResponse.safeParse(out.raw);
      if (out.kind === "refused" && parsed.success && parsed.data.problems.length > 0) {
        return { kind: "refused", code: out.code, error: parsed.data.problems.join("; ") };
      }
      return strip(out);
    },
    async project(args) {
      return strip(await call(["project", "--worktree", args.worktree], ProjectResponse, []));
    },
    async acquire(args) {
      const out = await call(
        [
          "acquire",
          "--worktree",
          args.worktree,
          "--agent",
          args.agent,
          "--kind",
          args.kind,
          "--pane",
          args.pane,
          "--session",
          args.session,
          "--coordinator",
          args.coordinator,
          "--task",
          `@${args.briefFile}`,
          "--route",
          `@${args.routeFile}`,
        ],
        AcquireResponse,
        [],
      );
      return out.kind === "ok"
        ? {
            kind: "ok",
            value: {
              runId: out.value.run_id,
              ownerToken: out.value.owner_token,
              attempt: out.value.attempt,
            },
          }
        : strip(out);
    },
    async dispatch(args) {
      const out = await call(
        [
          "dispatch",
          "--run",
          args.runId,
          "--owner",
          args.owner,
          "--attempt",
          args.attempt,
          "--prompt",
          `@${args.promptFile}`,
          // Wait only for evidence that the writer took the prompt (working, or blocked on a
          // question), not for the task to finish: Herdr's default would match idle or done.
          "--wait",
          "--until",
          "working",
          "--until",
          "blocked",
          "--timeout-ms",
          String(args.timeoutMs),
        ],
        DispatchResponse,
        [args.owner],
      );
      if (out.kind === "ok") {
        return {
          kind: "ok",
          value: {
            outcome: out.value.outcome,
            sent: out.value.sent,
            submitted: out.value.outcome === "submitted",
          },
        };
      }
      // A dispatch that ran but did not submit still prints its JSON (exit 7).
      if (out.kind === "unknown" && "raw" in out) {
        const parsed = DispatchResponse.safeParse(out.raw);
        if (parsed.success && parsed.data.sent === false) {
          return {
            kind: "refused",
            code: DISPATCH_FAILED,
            error: `agent-collab precheck refused: ${parsed.data.outcome}`,
            outcome: parsed.data.outcome,
          };
        }
        if (parsed.success) {
          return {
            kind: "unknown",
            error: `prompt submission outcome ${parsed.data.outcome}; it may have reached the writer`,
          };
        }
      }
      return strip(out);
    },
    async receipt(args) {
      const out = await call(
        [
          "receipt",
          "--run",
          args.runId,
          "--owner",
          args.owner,
          "--attempt",
          args.attempt,
          "--status",
          args.status,
          "--note",
          `@${args.noteFile}`,
        ],
        OkResponse,
        [args.owner],
      );
      return out.kind === "ok" ? { kind: "ok", value: null } : strip(out);
    },
    async requestChanges(args) {
      const out = await call(
        [
          "request-changes",
          "--run",
          args.runId,
          "--owner",
          args.owner,
          "--attempt",
          args.attempt,
          "--note",
          `@${args.noteFile}`,
        ],
        RequestChangesResponse,
        [args.owner],
      );
      return out.kind === "ok" ? { kind: "ok", value: { attempt: out.value.attempt } } : strip(out);
    },
    async accept(args) {
      const out = await call(
        [
          "accept",
          "--run",
          args.runId,
          "--owner",
          args.owner,
          "--attempt",
          args.attempt,
          "--note",
          `@${args.noteFile}`,
        ],
        OkResponse,
        [args.owner],
      );
      return out.kind === "ok" ? { kind: "ok", value: null } : strip(out);
    },
    async release(args) {
      const out = await call(
        [
          "release",
          "--run",
          args.runId,
          "--owner",
          args.owner,
          ...(args.abort ? ["--abort"] : []),
          "--note",
          `@${args.noteFile}`,
        ],
        OkResponse,
        [args.owner],
      );
      return out.kind === "ok" ? { kind: "ok", value: null } : strip(out);
    },
    async status(args) {
      const out = await call(["status", "--run", args.runId], StatusResponse, []);
      return strip(out);
    },
  };
}
