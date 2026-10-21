import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult, RunCommand } from "./herdr-client.js";

/**
 * Herdr pane layout (AGENT-519; Shared rules §13, Kai 2026-10-20 t445u).
 *
 * - One Herdr workspace per project/repo; tickets with no project folder go into `agent-dev`.
 * - One tab per ticket, labelled `AGENT-123 · <slug>`; its root pane is MAIN (`MAIN · AGENT-123`,
 *   agent name `main-agent-123`), the left, full-height pane.
 * - Workers stack on the right: the first splits MAIN right (ratio 0.5), each later one splits the
 *   bottom-most worker down. Labels `W1 writer · AGENT-123`, names `w1-writer-agent-123`.
 * - Cap: MAIN + 3 workers per ticket tab; a 4th lane waits (queues) for a slot, then refuses.
 *
 * Pure planning helpers plus a small Herdr port; every Herdr call goes through `run`.
 */

export const WORKER_CAP = 3;
export const CATCH_ALL_WORKSPACE = "agent-dev";
const TICKET = /\bAGENT-([1-9][0-9]{0,5})\b/i;
const DEFAULT_QUEUE_MS = 30 * 60_000;
const DEFAULT_POLL_MS = 15_000;

export interface LayoutPane {
  paneId: string;
  tabId: string;
  label?: string;
  agent?: string;
  status: string;
}

export interface PaneLayoutPort {
  run: RunCommand;
  env: NodeJS.Dict<string>;
  sleep?: (ms: number) => Promise<void>;
  queueTimeoutMs?: number;
  pollMs?: number;
  /** Directory for the cross-process layout lock and MAIN reservations (default ~/.local/state/hmr-layout). */
  stateDir?: string;
  /** Clock for reservations (tests). */
  now?: () => number;
}

const LOCK_WAIT_MS = 60_000;
/** A MAIN placed by hmr start is reserved until its agent shows up in Herdr (or this long). */
export const MAIN_RESERVATION_MS = 10 * 60_000;

function stateDirOf(port: PaneLayoutPort): string {
  if (port.stateDir) return port.stateDir;
  const home = port.env.HOME;
  return home ? join(home, ".local", "state", "hmr-layout") : join(tmpdir(), "hmr-layout");
}

/**
 * One layout change at a time across every hmr process on the host (AGENT-519): the
 * list -> plan -> split -> label sequence for workers and the find-or-create -> reserve sequence for
 * MAIN run inside an exclusive SQLite transaction on a small lock database. SQLite's file lock is
 * held by this connection only, for as long as the section runs (no age-based breaking), and the
 * OS drops it when the holder exits or crashes, so a dead holder never blocks and a slow live one is
 * never broken into. Only the holder's own connection ends the transaction. Waiters poll without
 * blocking the event loop and give up (nothing started) after LOCK_WAIT_MS.
 */
export async function withLayoutLock<T>(
  port: PaneLayoutPort,
  fn: () => Promise<T>,
): Promise<T | { ok: false; error: string }> {
  const dir = stateDirOf(port);
  const file = join(dir, "layout-lock.sqlite");
  const sleep = port.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + LOCK_WAIT_MS;
  let db: Database.Database;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    db = new Database(file);
    db.pragma("busy_timeout = 0");
  } catch (err) {
    return { ok: false, error: `layout lock ${file}: ${(err as Error).message}` };
  }
  try {
    for (;;) {
      try {
        db.exec("BEGIN EXCLUSIVE");
        break;
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        if (code !== "SQLITE_BUSY" && code !== "SQLITE_LOCKED") {
          return { ok: false, error: `layout lock ${file}: ${(err as Error).message}` };
        }
        if (Date.now() >= deadline) {
          return {
            ok: false,
            error: `layout lock ${file} is held by another hmr launch; nothing was started`,
          };
        }
        await sleep(250);
      }
    }
    try {
      return await fn();
    } finally {
      db.exec("COMMIT");
    }
  } finally {
    db.close();
  }
}

function reservationPath(port: PaneLayoutPort, paneId: string): string {
  return join(stateDirOf(port), `main-${paneId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

/** True while another hmr start holds an unexpired reservation on this MAIN pane. */
function reserved(port: PaneLayoutPort, paneId: string): boolean {
  const now = port.now ?? Date.now;
  try {
    const r = JSON.parse(readFileSync(reservationPath(port, paneId), "utf8")) as { at?: unknown };
    return typeof r.at === "number" && now() - r.at < MAIN_RESERVATION_MS;
  } catch {
    return false;
  }
}

function reserve(port: PaneLayoutPort, paneId: string, ticket: string): void {
  const now = port.now ?? Date.now;
  writeFileSync(
    reservationPath(port, paneId),
    JSON.stringify({ at: now(), ticket, pid: process.pid }),
    {
      mode: 0o600,
    },
  );
}

function ticketInLabel(label: string | undefined): string | undefined {
  const m = label?.match(TICKET);
  return m ? `AGENT-${m[1]}` : undefined;
}

export type Placed =
  | { ok: true; paneId: string; label: string; agentName: string; ticket: string }
  | { ok: false; error: string; legacy?: true };

/** The ticket a launch belongs to: HMR_TICKET, else an AGENT-n in the cwd path. */
export function ticketOf(env: NodeJS.Dict<string>, cwd: string): string | undefined {
  const explicit = env.HMR_TICKET?.match(TICKET);
  if (explicit) return `AGENT-${explicit[1]}`;
  const fromCwd = cwd.match(TICKET);
  return fromCwd ? `AGENT-${fromCwd[1]}` : undefined;
}

/** Lane role -> the short worker label role: writer, review, or the role slug. */
export function workerRole(role: string, access: "read" | "write"): string {
  if (access === "write") return "writer";
  if (/review/i.test(role)) return "review";
  return slug(role, 12) || "worker";
}

export function slug(text: string, max: number): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

export function mainLabel(ticket: string): string {
  return `MAIN · ${ticket}`;
}
export function mainAgentName(ticket: string): string {
  return `main-${ticket.toLowerCase()}`;
}
export function tabLabel(ticket: string, tabSlug: string): string {
  return `${ticket} · ${tabSlug || "work"}`;
}
export function workerLabel(n: number, role: string, ticket: string): string {
  return `W${n} ${role} · ${ticket}`;
}
/** Herdr agent names: [a-z][a-z0-9_-]{0,31}. */
export function workerAgentName(n: number, role: string, ticket: string): string {
  const tail = `-${ticket.toLowerCase()}`;
  const head = `w${n}-`;
  const roleRoom = Math.max(1, 32 - head.length - tail.length);
  return `${head}${slug(role, roleRoom) || "w"}${tail}`.slice(0, 32);
}

function workerIndex(label: string | undefined): number | undefined {
  const m = label?.match(/^W([1-9][0-9]?) /);
  return m ? Number(m[1]) : undefined;
}

function parse(stdout: string): Record<string, unknown> | undefined {
  try {
    const data = JSON.parse(stdout.trim()) as { result?: Record<string, unknown> };
    return data.result;
  } catch {
    return undefined;
  }
}

export function parsePanes(stdout: string): LayoutPane[] | undefined {
  const panes = parse(stdout)?.panes;
  if (!Array.isArray(panes)) return undefined;
  const out: LayoutPane[] = [];
  for (const raw of panes as Record<string, unknown>[]) {
    if (typeof raw.pane_id !== "string" || typeof raw.tab_id !== "string") return undefined;
    out.push({
      paneId: raw.pane_id,
      tabId: raw.tab_id,
      ...(typeof raw.label === "string" ? { label: raw.label } : {}),
      ...(typeof raw.agent === "string" ? { agent: raw.agent } : {}),
      status: typeof raw.agent_status === "string" ? raw.agent_status : "unknown",
    });
  }
  return out;
}

/**
 * Where the next worker goes: split MAIN right (ratio 0.5) when the tab has no worker yet,
 * else split the bottom-most (highest-numbered) worker down. Returns the slot number to use.
 */
export function planWorker(
  mainPaneId: string,
  tabPanes: readonly LayoutPane[],
): { target: string; direction: "right" | "down"; ratio?: number; n: number } | { full: true } {
  const workers = tabPanes.filter((pane) => pane.paneId !== mainPaneId);
  if (workers.length >= WORKER_CAP) return { full: true };
  const used = new Set(workers.map((w) => workerIndex(w.label)).filter((n) => n !== undefined));
  let n = 1;
  while (used.has(n)) n += 1;
  if (workers.length === 0) return { target: mainPaneId, direction: "right", ratio: 0.5, n };
  const bottom = [...workers].sort(
    (a, b) => (workerIndex(a.label) ?? 0) - (workerIndex(b.label) ?? 0),
  )[workers.length - 1]!;
  return { target: bottom.paneId, direction: "down", n };
}

function herdrFailure(result: CommandResult, action: string): string {
  const text = `${result.stdout}${result.stderr}`.trim().slice(0, 300);
  return text ? `${action}: ${text}` : action;
}

async function tabPanes(port: PaneLayoutPort, workspace: string, tab: string) {
  const listed = await port.run(["herdr", "pane", "list", "--workspace", workspace]);
  if (!listed.ok)
    return { ok: false as const, error: herdrFailure(listed, "herdr pane list failed") };
  const panes = parsePanes(listed.stdout);
  if (!panes) return { ok: false as const, error: "herdr pane list returned no usable panes" };
  return { ok: true as const, panes: panes.filter((pane) => pane.tabId === tab) };
}

/**
 * Splits a new worker pane into the caller's ticket tab per §13 and labels it. The caller's
 * pane is MAIN (labelled here if it has no label yet). Without Herdr caller context or a
 * ticket, returns `legacy` so the caller keeps the old `pane split --current` behaviour.
 */
export async function placeWorker(
  port: PaneLayoutPort,
  input: { cwd: string; role: string; access: "read" | "write" },
): Promise<Placed> {
  const main = port.env.HERDR_PANE_ID;
  const tab = port.env.HERDR_TAB_ID;
  const workspace = port.env.HERDR_WORKSPACE_ID;
  const ticket = ticketOf(port.env, input.cwd);
  if (!main || !tab || !workspace || !ticket) {
    return { ok: false, legacy: true, error: "no Herdr caller context or ticket" };
  }
  // The caller's tab and MAIN must belong to this ticket: a lane for AGENT-519 started from AGENT-100's
  // MAIN must not land in AGENT-100's tab. A tab with no ticket in its label keeps the legacy split.
  const tabInfo = await json(port, ["herdr", "tab", "get", tab], "herdr tab get");
  if (!tabInfo.ok) return tabInfo;
  const tabTicket = ticketInLabel(
    (tabInfo.result.tab as { label?: unknown } | undefined)?.label as string | undefined,
  );
  if (!tabTicket)
    return { ok: false, legacy: true, error: `caller tab ${tab} is not a ticket tab` };
  if (tabTicket !== ticket) {
    return {
      ok: false,
      error: `caller tab ${tab} belongs to ${tabTicket}, not ${ticket}; start this lane from ${ticket}'s MAIN (Shared rules §13). Nothing was started.`,
    };
  }
  const sleep = port.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (port.queueTimeoutMs ?? DEFAULT_QUEUE_MS);
  for (;;) {
    const attempt = await withLayoutLock(port, () =>
      splitWorker(port, { ...input, main, tab, workspace, ticket }),
    );
    if (!("full" in attempt)) return attempt;
    if (Date.now() >= deadline) {
      return {
        ok: false,
        error: `cap reached: ticket tab ${tab} already has MAIN + ${WORKER_CAP} workers; this lane waited for a worker to finish and close, and none did. Nothing was started (Shared rules §13).`,
      };
    }
    await sleep(port.pollMs ?? DEFAULT_POLL_MS);
  }
}

/** Runs under the layout lock: list the tab, plan the slot, split, label. `full` means queue and retry. */
async function splitWorker(
  port: PaneLayoutPort,
  input: {
    cwd: string;
    role: string;
    access: "read" | "write";
    main: string;
    tab: string;
    workspace: string;
    ticket: string;
  },
): Promise<Placed | { full: true }> {
  const { main, tab, workspace, ticket } = input;
  const listed = await tabPanes(port, workspace, tab);
  if (!listed.ok) return listed;
  const panes = listed.panes;
  const callerMain = panes.find((pane) => pane.paneId === main);
  const mainTicket = ticketInLabel(callerMain?.label);
  if (mainTicket && mainTicket !== ticket) {
    return {
      ok: false,
      error: `caller pane ${main} is MAIN of ${mainTicket}, not ${ticket}. Nothing was started.`,
    };
  }
  const plan = planWorker(main, panes);
  if ("full" in plan) return plan;
  const mainPane = panes.find((pane) => pane.paneId === main);
  if (mainPane && !mainPane.label) {
    // Best effort: a MAIN label never blocks a launch.
    await port.run(["herdr", "pane", "rename", main, mainLabel(ticket)]);
  }
  const split = await port.run([
    "herdr",
    "pane",
    "split",
    plan.target,
    "--direction",
    plan.direction,
    ...(plan.ratio === undefined ? [] : ["--ratio", String(plan.ratio)]),
    "--cwd",
    input.cwd,
    "--no-focus",
  ]);
  if (!split.ok) return { ok: false, error: herdrFailure(split, "herdr pane split failed") };
  const pane = (parse(split.stdout)?.pane as { pane_id?: unknown } | undefined)?.pane_id;
  if (typeof pane !== "string" || !pane) {
    return { ok: false, error: "herdr pane split did not return a pane id" };
  }
  const role = workerRole(input.role, input.access);
  const label = workerLabel(plan.n, role, ticket);
  await port.run(["herdr", "pane", "rename", pane, label]);
  return {
    ok: true,
    paneId: pane,
    label,
    agentName: workerAgentName(plan.n, role, ticket),
    ticket,
  };
}

/**
 * Closes worker panes whose agent is idle or done (or gone), never MAIN. Returns the panes it
 * closed. Used after a verifier's result is recorded and on workflow release.
 */
export async function closeFinished(
  port: PaneLayoutPort,
  paneIds: readonly string[],
): Promise<string[]> {
  const closed: string[] = [];
  const main = port.env.HERDR_PANE_ID;
  for (const paneId of new Set(paneIds)) {
    if (!paneId || paneId === main) continue;
    // Herdr has no compare-and-close, so the pane is read twice: the second read happens right
    // before the close and must show the same finished state and the same revision/state sequence.
    // Any change in between (the agent picked up new work) skips the close. MAIN is never closed,
    // also when this caller is not MAIN: a pane labelled `MAIN ·` is skipped.
    const first = await finishedState(port, paneId);
    if (!first) continue;
    const second = await finishedState(port, paneId);
    if (!second || second !== first) continue;
    const res = await port.run(["herdr", "pane", "close", paneId]);
    if (res.ok) closed.push(paneId);
  }
  return closed;
}

/** A fingerprint of a finished, non-MAIN pane, or undefined when it must not be closed. */
async function finishedState(port: PaneLayoutPort, paneId: string): Promise<string | undefined> {
  const got = await port.run(["herdr", "pane", "get", paneId]);
  if (!got.ok) return undefined;
  const pane = parse(got.stdout)?.pane as
    | {
        agent_status?: unknown;
        agent?: unknown;
        label?: unknown;
        revision?: unknown;
        state_change_seq?: unknown;
      }
    | undefined;
  if (!pane) return undefined;
  if (typeof pane.label === "string" && pane.label.startsWith("MAIN ·")) return undefined;
  const status = typeof pane.agent_status === "string" ? pane.agent_status : "unknown";
  if (typeof pane.agent === "string" && status !== "idle" && status !== "done") return undefined;
  if (typeof pane.agent !== "string" && status !== "unknown") return undefined;
  return JSON.stringify([
    status,
    pane.agent ?? null,
    pane.revision ?? null,
    pane.state_change_seq ?? null,
  ]);
}

export interface MainPlace {
  /** Optional repo/project name; default: the git checkout's main repo folder name. */
  project?: string;
  /** Tab slug; default from HMR_TICKET_SLUG or the cwd's last path segment. */
  tabSlug?: string;
  /** Whether ~/projects/<name> exists (injected for tests). */
  projectExists?: (name: string) => boolean;
}

async function json(port: PaneLayoutPort, argv: string[], what: string) {
  const res = await port.run(argv);
  if (!res.ok) return { ok: false as const, error: herdrFailure(res, `${what} failed`) };
  const result = parse(res.stdout);
  return result
    ? { ok: true as const, result }
    : { ok: false as const, error: `${what} returned no result` };
}

/** Default: ~/projects/<name> exists under the port's HOME (no HOME: no project, so agent-dev). */
function defaultProjectExists(port: PaneLayoutPort): (name: string) => boolean {
  const home = port.env.HOME;
  return (name) => Boolean(home) && existsSync(join(home as string, "projects", name));
}

/** The project workspace label for a checkout: its repo folder name when ~/projects/<name> exists, else agent-dev. */
export async function projectOf(
  port: PaneLayoutPort,
  cwd: string,
  place: MainPlace,
): Promise<string> {
  if (place.project) return place.project;
  const common = await port.run([
    "git",
    "-C",
    cwd,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const dir = common.ok ? common.stdout.trim().replace(/\/\.git\/?$/, "") : "";
  const name = dir.split("/").filter(Boolean).pop() ?? "";
  return name &&
    /^[A-Za-z0-9._-]{1,64}$/.test(name) &&
    (place.projectExists ?? defaultProjectExists(port))(name)
    ? name
    : CATCH_ALL_WORKSPACE;
}

/**
 * Finds or creates the ticket tab for a coordinator (MAIN): the project workspace (created if
 * missing; its first tab is reused as the ticket tab so no bare shell is left), then the tab
 * labelled `AGENT-n · ...` (created if missing). Refuses when that tab's MAIN already runs an
 * agent: one MAIN per ticket.
 */
export async function placeMain(
  port: PaneLayoutPort,
  input: { cwd: string } & MainPlace,
): Promise<Placed> {
  const ticket = ticketOf(port.env, input.cwd);
  if (!ticket) return { ok: false, legacy: true, error: "no ticket (set HMR_TICKET=AGENT-n)" };
  return withLayoutLock(port, () => placeMainLocked(port, input, ticket));
}

async function placeMainLocked(
  port: PaneLayoutPort,
  input: { cwd: string } & MainPlace,
  ticket: string,
): Promise<Placed> {
  const project = await projectOf(port, input.cwd, input);
  const wantTab = tabLabel(
    ticket,
    slug(
      input.tabSlug ?? port.env.HMR_TICKET_SLUG ?? input.cwd.split("/").filter(Boolean).pop() ?? "",
      24,
    ).replace(new RegExp(`^${ticket.toLowerCase()}-?`), "") || "work",
  );
  const listed = await json(port, ["herdr", "workspace", "list"], "herdr workspace list");
  if (!listed.ok) return listed;
  const workspaces = (listed.result.workspaces ?? []) as {
    workspace_id?: string;
    label?: string;
  }[];
  let ws = workspaces.find((w) => w.label === project)?.workspace_id;
  let root: string | undefined;
  if (!ws) {
    const created = await json(
      port,
      ["herdr", "workspace", "create", "--cwd", input.cwd, "--label", project, "--no-focus"],
      "herdr workspace create",
    );
    if (!created.ok) return created;
    ws = (created.result.workspace as { workspace_id?: string } | undefined)?.workspace_id;
    const tab = (created.result.tab as { tab_id?: string } | undefined)?.tab_id;
    root = (created.result.root_pane as { pane_id?: string } | undefined)?.pane_id;
    if (!ws || !tab || !root) return { ok: false, error: "herdr workspace create returned no ids" };
    await port.run(["herdr", "tab", "rename", tab, wantTab]);
  } else {
    const tabs = await json(port, ["herdr", "tab", "list", "--workspace", ws], "herdr tab list");
    if (!tabs.ok) return tabs;
    const found = ((tabs.result.tabs ?? []) as { tab_id?: string; label?: string }[]).find(
      (t) => t.label === ticket || t.label?.startsWith(`${ticket} ·`),
    );
    if (found?.tab_id) {
      const panes = await tabPanes(port, ws, found.tab_id);
      if (!panes.ok) return panes;
      const main = panes.panes.find((p) => p.label?.startsWith("MAIN ·")) ?? panes.panes[0];
      if (main?.agent || (main && reserved(port, main.paneId))) {
        return {
          ok: false,
          error: `ticket ${ticket} already has a MAIN agent in tab ${found.tab_id} (pane ${main.paneId}); one MAIN per ticket tab (Shared rules §13).`,
        };
      }
      root = main?.paneId;
    }
    if (!root) {
      const created = await json(
        port,
        [
          "herdr",
          "tab",
          "create",
          "--workspace",
          ws,
          "--cwd",
          input.cwd,
          "--label",
          wantTab,
          "--no-focus",
        ],
        "herdr tab create",
      );
      if (!created.ok) return created;
      root = (created.result.root_pane as { pane_id?: string } | undefined)?.pane_id;
      if (!root) return { ok: false, error: "herdr tab create returned no root pane" };
    }
  }
  const label = mainLabel(ticket);
  await port.run(["herdr", "pane", "rename", root, label]);
  // Reserved until the coordinator's agent shows in Herdr: a concurrent hmr start for the same ticket
  // (another worktree) sees the reservation under the lock and refuses instead of reusing this pane.
  try {
    reserve(port, root, ticket);
  } catch (err) {
    return { ok: false, error: `could not reserve MAIN ${root}: ${(err as Error).message}` };
  }
  return { ok: true, paneId: root, label, agentName: mainAgentName(ticket), ticket };
}
