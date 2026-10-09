import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sanitizeRuntimeEnv } from "../../src/commands/runtime.js";
import {
  createAgentCollab,
  createCollabRunner,
  type AgentCollabPort,
} from "../../src/workflow/agent-collab.js";

export const FAKE_OWNER = "ab".repeat(24);

/**
 * A stand-in `agent-collab` executable following the documented CLI contract: JSON on stdout,
 * exit 4 for an existing lock, 6 for a wrong owner, 7 for a dispatch that did not submit,
 * 8 for a state refusal. Its state, every argv, and the environment names it saw are kept in
 * its HOME so tests can read them. `mode.json` scripts per-command failures.
 */
const SCRIPT = String.raw`#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const dir = process.env.HOME;
const statePath = path.join(dir, "state.json");
const st = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { calls: [], runs: {}, prompts: [] };
const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const modes = fs.existsSync(path.join(dir, "mode.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "mode.json"), "utf8")) : {};
const mode = modes[cmd];
st.calls.push({ argv, envKeys: Object.keys(process.env).sort() });
const save = () => fs.writeFileSync(statePath, JSON.stringify(st));
const out = (o, code = 0) => { save(); process.stdout.write(JSON.stringify(o)); process.exit(code); };
const TOKEN = "${FAKE_OWNER}";
if (mode === "hang") { save(); setInterval(() => {}, 1000); return; }
if (mode === "refuse") { save(); process.stderr.write("lock exists for this worktree"); process.exit(4); }
const run = st.runs[opt("--run")];
const attemptOf = () => run && run.attempts.find((a) => a.attempt_id === opt("--attempt"));
const needOwner = () => { if (opt("--owner") !== TOKEN) { save(); process.stderr.write("owner mismatch"); process.exit(6); } };
const refuse = (msg) => { save(); process.stderr.write(msg); process.exit(8); };
const projectPath = path.join(dir, "project.json");
const project = fs.existsSync(projectPath) ? JSON.parse(fs.readFileSync(projectPath, "utf8")) : {};
switch (cmd) {
  case "verify": {
    const problems = project.problems || [];
    out({ ok: problems.length === 0, host: "fake", herdr_bin: "/fake/herdr", herdr_present: true, herdr_env: "1",
      root: dir, worktree: opt("--worktree"), project_id: "repo:fake", problems }, problems.length === 0 ? 0 : 3);
  }
  case "project": {
    const policy = project.model_policy || { source: "defaults", default: "claude-opus-5-5",
      bounded_small_fix: "claude-sonnet-5-5", allowed: ["claude-opus-5-5", "claude-sonnet-5-5"] };
    out({ worktree: project.worktree || opt("--worktree"), identity_kind: "repo", project_id: "repo:fake",
      configured: false, lock_mode: "internal", model_policy: policy });
  }
  case "acquire": {
    const brief = fs.readFileSync(opt("--task").slice(1), "utf8");
    st.runs.r1 = { state: "acquired", current: "a1", session: opt("--session"), pane: opt("--pane"), attempts: [{ attempt_id: "a1", kind: "implementation", parent: null, dispatch_state: null, outcome: null }], brief };
    out({ ok: true, run_id: "r1", owner_token: TOKEN, attempt: "a1", state: "acquired" });
  }
  case "dispatch": {
    needOwner();
    const a = attemptOf();
    if (!a || run.current !== a.attempt_id) refuse("not the current attempt");
    if (a.dispatch_state) refuse("attempt already dispatched");
    st.prompts.push({ attempt: a.attempt_id, prompt: fs.readFileSync(opt("--prompt").slice(1), "utf8") });
    if (mode === "precheck") out({ ok: false, run_id: "r1", outcome: "session_identity_changed", sent: false, attempt: a.attempt_id }, 7);
    a.dispatch_state = "done"; a.outcome = "submitted"; run.state = "dispatched";
    if (mode === "timeout") out({ ok: false, run_id: "r1", outcome: "timeout", sent: true, attempt: a.attempt_id }, 7);
    // A writer still working on a long task: only a wait for "working" observes it in time;
    // Herdr's default wait (idle, done, blocked) runs into the timeout.
    if (mode === "long-task") {
      const until = argv.flatMap((value, i) => (value === "--until" ? [argv[i + 1]] : []));
      if (!until.includes("working")) out({ ok: false, run_id: "r1", outcome: "timeout", sent: true, attempt: a.attempt_id }, 7);
    }
    out({ ok: true, run_id: "r1", outcome: "submitted", sent: true, attempt: a.attempt_id });
  }
  case "receipt": {
    needOwner();
    const a = attemptOf();
    if (!a || a.dispatch_state !== "done") refuse("receipt needs a dispatched attempt");
    a.receipt_status = opt("--status"); run.state = "receipt";
    out({ ok: true, run_id: "r1", attempt: a.attempt_id, receipt_status: a.receipt_status });
  }
  case "request-changes": {
    needOwner();
    const a = attemptOf();
    if (!a || !a.receipt_status) refuse("request-changes needs a receipt");
    const next = "a" + (run.attempts.length + 1);
    run.attempts.push({ attempt_id: next, kind: "revision", parent: a.attempt_id, dispatch_state: null, outcome: null });
    run.current = next; run.state = "changes_requested";
    out({ ok: true, run_id: "r1", state: "changes_requested", reviewed_attempt: a.attempt_id, attempt: next });
  }
  case "accept": {
    needOwner();
    const a = attemptOf();
    if (!a || a.receipt_status !== "impl-complete") refuse("accept needs an impl-complete receipt");
    run.state = "accepted";
    a.accepted_at = "2026-10-08T00:00:00Z"; run.accepted_at = a.accepted_at;
    out({ ok: true, run_id: "r1", state: "accepted", attempt: a.attempt_id });
  }
  case "release": {
    needOwner();
    if (!argv.includes("--abort") && run.state !== "accepted") refuse("release needs acceptance");
    run.state = "released"; run.released_at = "2026-10-08T00:00:01Z";
    out({ ok: true, run_id: "r1", state: "released", release_kind: argv.includes("--abort") ? "abort" : "normal" });
  }
  case "status": {
    out({ run_id: "r1", state: run.state, current_attempt: run.current, session: run.session, pane: run.pane,
      accepted_at: run.accepted_at || null, released_at: run.released_at || null, attempts: run.attempts });
  }
  default:
    refuse("unknown command " + cmd);
}
`;

export interface FakeCollab {
  port: AgentCollabPort;
  dir: string;
  setMode: (modes: Record<string, string>) => void;
  /** Scripts `project`/`verify`: a model policy, a reported worktree, or preflight problems. */
  setProject: (project: {
    model_policy?: {
      source: string;
      default: string;
      bounded_small_fix: string;
      allowed: string[];
    };
    worktree?: string;
    problems?: string[];
  }) => void;
  state: () => {
    calls: { argv: string[]; envKeys: string[] }[];
    runs: Record<string, { state: string; brief: string; attempts: { attempt_id: string }[] }>;
    prompts: { attempt: string; prompt: string }[];
  };
  commands: () => string[];
}

export function fakeAgentCollab(
  options: {
    timeoutMs?: number;
    /** Reuse another process's fake agent-collab state directory (crash and restart tests). */
    dir?: string;
  } = {},
): FakeCollab {
  const dir = options.dir ?? mkdtempSync(path.join(os.tmpdir(), "hmr-fake-collab-"));
  const executable = path.join(dir, "agent-collab");
  if (!options.dir) {
    writeFileSync(executable, SCRIPT);
    chmodSync(executable, 0o755);
  }
  // The parent environment has provider keys; the adapter must only pass the allowlist.
  const parentEnv = {
    PATH: process.env.PATH,
    HOME: dir,
    HERDR_ENV: "1",
    OPENAI_API_KEY: "sk-canary-openai",
    TYPESAFE_API_KEY: "ts-canary",
    ANTHROPIC_API_KEY: "sk-ant-canary",
  };
  const port = createAgentCollab({
    executable,
    run: createCollabRunner({
      env: sanitizeRuntimeEnv(parentEnv),
      timeoutMs: options.timeoutMs ?? 10_000,
    }),
  });
  const state = () => {
    const file = path.join(dir, "state.json");
    return existsSync(file)
      ? JSON.parse(readFileSync(file, "utf8"))
      : { calls: [], runs: {}, prompts: [] };
  };
  return {
    port,
    dir,
    setMode: (modes) => writeFileSync(path.join(dir, "mode.json"), JSON.stringify(modes)),
    setProject: (project) => writeFileSync(path.join(dir, "project.json"), JSON.stringify(project)),
    state,
    // The read-only preflight is listed separately; `commands` are the calls that matter here.
    commands: () =>
      state()
        .calls.map((call: { argv: string[] }) => call.argv[0]!)
        .filter((command: string) => command !== "verify" && command !== "project"),
  };
}
