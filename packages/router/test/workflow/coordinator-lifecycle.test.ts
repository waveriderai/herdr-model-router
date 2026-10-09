import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  executeCoordinatorClose,
  executeStart,
  IN_FLIGHT_STALE_MS,
  type StartDeps,
  type StartRequest,
} from "../../src/commands/start.js";
import { shQuote } from "../../src/rules/launch-script.js";
import { CoordinatorRepository } from "../../src/store/coordinator-repository.js";
import { startWorkflow } from "../../src/workflow/service.js";
import { deps as dispatchDeps, failed, fakeHerdr, type FakeHerdr } from "../helpers/fake-herdr.js";
import { makeRepo } from "../helpers/git-repo.js";
import { BRIEF, harness } from "../helpers/workflow-harness.js";

const RULES = [
  "---",
  "description: Synthetic roles with a coordinator",
  "---",
  "coordinator: codex:gpt-6.1-sol@high",
  "writer: claude:claude-opus-5-5@high",
  "checkers: codex:gpt-6.1-sol@xhigh",
  "delegate: inherit-parent",
  "",
].join("\n");

/** A rules file in a directory whose name needs quoting in every shell. */
function hostileRules(rules = RULES): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "hmr-a2-")));
  const odd = path.join(dir, "my rules it's $(touch pwned) `x`");
  mkdirSync(odd);
  const file = path.join(odd, "pstack-models.mdc");
  writeFileSync(file, rules);
  return file;
}

function setup(options: { rules?: string; herdr?: FakeHerdr; fixedHome?: string } = {}) {
  const herdr = options.herdr ?? fakeHerdr();
  const repo = makeRepo();
  const rulesFile = hostileRules(options.rules);
  const dispatch = dispatchDeps(
    herdr,
    options.fixedHome ? { launchFixedEnv: { MODEL_ROUTER_HOME: options.fixedHome } } : {},
  );
  const coordinators = new CoordinatorRepository(dispatch.db);
  const startDeps = (
    env: Record<string, string> = { HERDR_ENV: "1" },
    onOpen?: () => void,
  ): StartDeps => ({
    cwd: repo,
    home: path.dirname(rulesFile),
    rulesFlag: rulesFile,
    env,
    openRuntime: () => {
      onOpen?.();
      return { dispatch: dispatch.deps, coordinators };
    },
  });
  const request = (patch: Partial<StartRequest> = {}): StartRequest => ({
    skillRoots: [],
    modes: [],
    dryRun: false,
    ...patch,
  });
  return { herdr, repo, rulesFile, dispatch, coordinators, startDeps, request };
}

function skillsRoot(names: string[]): string {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "hmr-a2-skills-")));
  const root = path.join(base, "skills it's");
  mkdirSync(root);
  for (const name of names) {
    mkdirSync(path.join(root, name));
    writeFileSync(
      path.join(root, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: Synthetic ${name}.\n---\nBody.\n`,
    );
  }
  return root;
}

describe("coordinator propagation (a2 item 1)", () => {
  it("gives every downstream command the exact rules file, its own parent, and quoted paths", async () => {
    const s = setup();
    const root = skillsRoot(["tdd"]);
    const result = await executeStart(
      "Add a greeting.",
      // The bootstrap --parent resolves only the coordinator's own role.
      s.request({ parent: "claude:claude-opus-5-5@low", skillRoots: [root] }),
      s.startDeps(),
    );
    expect(result.code).toBe(0);
    const prompt = s.herdr.prompts[0]!.text;
    const rules = `--rules ${shQuote(s.rulesFile)}`;
    const route = `${rules} --parent 'codex:gpt-6.1-sol@high'`;
    const skills = ` --skills-root ${shQuote(root)}`;
    expect(prompt).toContain(`hmr workflow plan --brief <file> ${route}${skills}`);
    expect(prompt).toContain(`hmr workflow start --brief <file> ${route}${skills}`);
    expect(prompt).toContain(`hmr workflow verify <id> --attempt <attempt> ${rules}`);
    expect(prompt).toContain(`hmr run --role <role> --read-only ${route} <task>`);
    // inherit-parent children resolve to the coordinator itself, not the bootstrap --parent.
    expect(prompt).toContain("- delegate -> codex:gpt-6.1-sol@high (single writer)");
    expect(prompt).not.toContain("claude-opus-5-5@low");
    expect(prompt).not.toContain("MODEL_ROUTER_HOME");
  });

  it("resolves an inherit-parent coordinator from --parent, and its children from that result", async () => {
    const s = setup({
      rules: RULES.replace("coordinator: codex:gpt-6.1-sol@high", "coordinator: inherit-parent"),
    });
    const result = await executeStart(
      "Review the parser.",
      s.request({ parent: "claude:claude-opus-5-5@high", dryRun: true }),
      s.startDeps({}),
    );
    expect(result.json).toMatchObject({
      coordinator: { descriptor: "claude:claude-opus-5-5@high" },
      commands: { route: expect.stringContaining("--parent 'claude:claude-opus-5-5@high'") },
    });
    expect((result.json as { roles: string[] }).roles).toContain(
      "- delegate -> claude:claude-opus-5-5@high (single writer)",
    );
  });

  it("keeps an explicit MODEL_ROUTER_HOME in the launch and in every downstream command", async () => {
    const home = "/tmp/router home it's";
    const s = setup({ fixedHome: home });
    const result = await executeStart(
      "Add a greeting.",
      s.request(),
      s.startDeps({ HERDR_ENV: "1", MODEL_ROUTER_HOME: home }),
    );
    expect(result.code).toBe(0);
    expect(s.herdr.prompts[0]!.text).toContain(
      `MODEL_ROUTER_HOME=${shQuote(home)} hmr workflow start --brief <file>`,
    );
    expect(s.herdr.prompts[0]!.text).toContain(
      `MODEL_ROUTER_HOME=${shQuote(home)} hmr workflow <command>`,
    );
    // The coordinator (Codex) process and its tool commands both get the same home.
    expect(s.herdr.scripts[0]).toContain(`  ${shQuote(`MODEL_ROUTER_HOME=${home}`)} \\\n`);
    expect(s.herdr.scripts[0]).toContain(
      `'-c' ${shQuote(`shell_environment_policy.set.MODEL_ROUTER_HOME="${home}"`)}`,
    );
  });

  it("refuses to launch when the rules file changed after the route was planned", async () => {
    const s = setup();
    const result = await executeStart(
      "Add a greeting.",
      s.request(),
      s.startDeps({ HERDR_ENV: "1" }, () =>
        writeFileSync(s.rulesFile, RULES.replace("codex:gpt-6.1-sol@high", "grok:grok-4.7@high")),
      ),
    );
    expect(result.json).toMatchObject({ code: "rules-changed" });
    expect(s.herdr.calls.filter((call) => call[1] === "split")).toEqual([]);
    expect(s.coordinators.list(5)).toEqual([]);
  });
});

describe("coordinator skill catalog (a2 item 2)", () => {
  it("validates --skills-root without --mode and shows its catalog to the coordinator", async () => {
    const s = setup();
    const root = skillsRoot(["poteto-mode", "principle-prove-it-works"]);
    const preview = await executeStart(
      "Fix it.",
      s.request({ skillRoots: [root], dryRun: true }),
      s.startDeps({}),
    );
    expect(preview.json).toMatchObject({
      catalog: [{ name: "poteto-mode" }, { name: "principle-prove-it-works" }],
    });
    const result = await executeStart("Fix it.", s.request({ skillRoots: [root] }), s.startDeps());
    expect(result.code).toBe(0);
    const prompt = s.herdr.prompts[0]!.text;
    expect(prompt).toContain("- principle-prove-it-works: Synthetic principle-prove-it-works.");
    expect(prompt).toContain("Choose the ones relevant to the task");
    expect(prompt).not.toContain("Mode requested by the operator");

    const missing = await executeStart(
      "Fix it.",
      s.request({ skillRoots: ["/nonexistent/skills"], dryRun: true }),
      s.startDeps({}),
    );
    expect(missing.json).toMatchObject({ code: "skills-root" });
  });
});

describe("coordinator authority and read-only tasks (a2 item 7)", () => {
  it("keeps the operator's explicit authorization and does not force a writer", async () => {
    const s = setup();
    await executeStart(
      "Merge PR 12 once CI passes; you are authorized to merge.",
      s.request(),
      s.startDeps(),
    );
    const prompt = s.herdr.prompts[0]!.text;
    expect(prompt).toContain("Do what it explicitly authorizes, within the project's own policy");
    expect(prompt).not.toMatch(/whatever the task says/);
    expect(prompt).toContain("do not start a writer workflow");
    expect(prompt).toContain("not a keyword match");
  });
});

describe("coordinator lifecycle (a2 item 4)", () => {
  it("reports a stalled submission as submitted, not received, and holds the slot", async () => {
    const herdr: FakeHerdr = fakeHerdr({
      prompt: () => {
        herdr.waitFor = async () => failed("", "timed out");
        return failed("", "agent_prompt_stalled");
      },
    });
    const s = setup({ herdr });
    const result = await executeStart("Add a greeting.", s.request(), s.startDeps());
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ delivery: "submitted-unobserved" });
    expect(result.output).toContain("not confirmation it read the task");
    expect(result.output).not.toMatch(/received|interpreted|complete/i);
    expect(s.coordinators.list(1)[0]!.state).toBe("sent");
    expect(herdr.prompts).toHaveLength(1);
  });

  it("records a thrown prompt as unknown, never resent", async () => {
    const herdr = fakeHerdr({
      prompt: () => {
        throw new Error("socket closed");
      },
    });
    const s = setup({ herdr });
    const result = await executeStart("Add a greeting.", s.request(), s.startDeps());
    expect(result.code).toBe(1);
    expect(s.coordinators.list(1)[0]!.state).toBe("unknown");
    expect(herdr.prompts).toHaveLength(1);
  });

  it("records a thrown launch step as an inspectable state instead of leaving it starting", async () => {
    const herdr = fakeHerdr({
      onRename: () => {
        throw new Error("herdr went away");
      },
    });
    const s = setup({ herdr });
    const result = await executeStart("Add a greeting.", s.request(), s.startDeps());
    expect(result.json).toMatchObject({ code: "coordinator-error" });
    // A pane exists, so the CLI may still run: unknown, slot held, nothing sent.
    expect(s.coordinators.list(1)[0]!.state).toBe("unknown");
    expect(herdr.prompts).toEqual([]);
  });

  it("never closes a launch in flight, and a closed record never reopens", async () => {
    const s = setup();
    const record = s.coordinators.create({
      id: "co_inflight",
      worktreeId: s.repo,
      cwd: s.repo,
      role: "coordinator",
      descriptor: "codex:gpt-6.1-sol@high",
      provider: "codex",
      model: "gpt-6.1-sol",
      effort: "high",
      argv: ["codex"],
      rulesPath: s.rulesFile,
      taskSha256: "a".repeat(64),
      promptSha256: "b".repeat(64),
    });
    const close = { coordinators: s.coordinators, pane: s.herdr.pane };
    expect(await executeCoordinatorClose(close, record.id, "looks stuck")).toMatchObject({
      json: { code: "coordinator-in-flight" },
    });
    expect(s.coordinators.get(record.id)!.state).toBe("starting");
    // Abandoned long ago with no pane ever created: nothing can be running from it.
    const later = { ...close, now: () => Date.parse(record.updatedAt) + IN_FLIGHT_STALE_MS + 1 };
    expect((await executeCoordinatorClose(later, record.id, "start process was killed")).code).toBe(
      0,
    );
    // The killed launch's late steps cannot reopen or rewrite it.
    expect(s.coordinators.transition(record.id, "starting", "sending")).toBe(false);
    expect(() => s.coordinators.transition(record.id, "closed", "prompted")).toThrow(
      /cannot become/,
    );
    expect(s.coordinators.get(record.id)!.state).toBe("closed");
  });

  it("closes only with positive stopped evidence, no open workflows, and not from a worker", async () => {
    const s = setup();
    await executeStart("Add a greeting.", s.request(), s.startDeps());
    const record = s.coordinators.list(1)[0]!;
    const paneId = record.identity!.paneId;
    const close = { coordinators: s.coordinators, pane: s.herdr.pane };

    s.herdr.panes.get(paneId)!.status = "working";
    expect(await executeCoordinatorClose(close, record.id, "done")).toMatchObject({
      json: { code: "coordinator-not-stopped" },
    });
    s.herdr.panes.get(paneId)!.status = "idle";

    // A workflow the coordinator started is still open.
    const h = harness({ herdr: s.herdr, home: s.dispatch.home, repo: s.repo });
    const coordinators = new CoordinatorRepository(h.db);
    const started = await startWorkflow(
      { ...h.deps, coordinators, callerEnv: { HERDR_PANE_ID: paneId } },
      { brief: BRIEF, cwd: s.repo },
    );
    if (!started.ok) throw new Error(started.error);
    expect(await executeCoordinatorClose(close, record.id, "done")).toMatchObject({
      json: { code: "coordinator-workflows-open" },
    });
    // That workflow's writer pane is a worker: it cannot close the coordinator.
    const writerPane = started.value.workflow.identity!.paneId;
    expect(
      await executeCoordinatorClose({ ...close, callerPane: writerPane }, record.id, "done"),
    ).toMatchObject({ json: { code: "worker-caller" } });
    expect(s.coordinators.get(record.id)!.state).toBe("prompted");
  });

  it("records what Herdr reported beside the operator's evidence when it closes", async () => {
    const s = setup();
    await executeStart("Add a greeting.", s.request(), s.startDeps());
    const record = s.coordinators.list(1)[0]!;
    const closed = await executeCoordinatorClose(
      { coordinators: s.coordinators, pane: s.herdr.pane },
      record.id,
      "task handed back",
    );
    expect(closed.code).toBe(0);
    expect(s.coordinators.get(record.id)!.closingEvidence).toMatch(
      /^task handed back \(Herdr reported .+ idle in pane w1:p1\)$/,
    );
    expect(s.herdr.calls.filter((call) => call[1] === "close")).toEqual([]);
  });
});
