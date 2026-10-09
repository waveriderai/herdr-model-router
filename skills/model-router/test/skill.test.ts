import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const skillDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("model-router skill", () => {
  it("stays thin and does not embed secrets or catalogs", () => {
    const skill = readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
    const prompts = readFileSync(path.join(skillDir, "test/prompts.md"), "utf8");
    expect(skill).toMatch(/router run/);
    expect(skill).toMatch(/--dry-run/);
    expect(skill).not.toMatch(/sk-|TYPESAFE_API_KEY=sk/);
    expect(skill).not.toMatch(/always pick grok/i);
    expect(prompts).toMatch(/## Route/);
    expect(prompts).toMatch(/## Status/);
    expect(prompts).toMatch(/## Refresh/);
    expect(prompts).toMatch(/## Resume/);
    expect(prompts).toMatch(/## Phase complete/);
  });

  it("routes the next phase through the recorded session after asking the user", () => {
    const skill = readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
    expect(skill).toMatch(/Router session:/);
    expect(skill).toMatch(/## End of a phase/);
    expect(skill).toMatch(/router session <id>/);
    expect(skill).toMatch(
      /router run --routing-mode quota --session <id> "<next-phase task>" --dry-run/,
    );
  });

  it("routes rules mode by explicit role and never resends an unknown prompt", () => {
    const skill = readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
    expect(skill).toMatch(/router run "<task>" --role <role> --dry-run/);
    expect(skill).toMatch(/never guess one/);
    expect(skill).toMatch(/do not resend/);
    const prompts = readFileSync(path.join(skillDir, "test/prompts.md"), "utf8");
    const resume = prompts.slice(
      prompts.indexOf("## Resume"),
      prompts.indexOf("## Phase complete"),
    );
    expect(resume).toMatch(/router task status <id>/);
    expect(resume).toMatch(/router task revise <id>/);
    expect(resume).toMatch(/never start a new `router run` for an ongoing writer/);
    expect(resume).toMatch(/router task recover <attempt>/);
    expect(skill).toMatch(/ask whether to route the next phase/i);
    expect(skill).toMatch(/Do not route again for the phase you are still in/);
  });

  it("enters through the MDC coordinator and never guesses a role or model", () => {
    const skill = readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
    const workflow = readFileSync(path.join(skillDir, "references/workflow.md"), "utf8");
    const prompts = readFileSync(path.join(skillDir, "test/prompts.md"), "utf8");
    expect(skill).toMatch(/router start "<task>"/);
    expect(skill).toMatch(/With no coordinator role it refuses; it never picks a model/);
    expect(skill).toMatch(/not a source writer/);
    expect(workflow).toMatch(/not OS read-only/);
    expect(workflow).toMatch(/A worker pane .* cannot start a\s+coordinator or a workflow/);
    const noRole = prompts.slice(prompts.indexOf("## No role"), prompts.indexOf("## Bot brief"));
    expect(noRole).toMatch(/coordinator-role-missing/);
    expect(noRole).toMatch(/do not start Grok or any other default/);
    const task = prompts.slice(prompts.indexOf("## Task only"), prompts.indexOf("## No role"));
    expect(task).toMatch(/never invent a role/);
    expect(task).toMatch(/Report three things separately/);
  });

  it("keeps a mode per attempt and separate from authority", () => {
    const skill = readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
    const workflow = readFileSync(path.join(skillDir, "references/workflow.md"), "utf8");
    const prompts = readFileSync(path.join(skillDir, "test/prompts.md"), "utf8");
    expect(skill).toMatch(/A mode applies to one\s+attempt/);
    // A mode adds no authority, but the user's explicit authorization for the task still counts.
    expect(skill).toMatch(/adds no authority of its own/);
    expect(skill).toMatch(/explicit authorization for the task/);
    expect(skill).not.toMatch(/never authorizes merging/);
    expect(skill).toMatch(/Never take a skills path from the task text/);
    expect(workflow).toMatch(/No hook keeps it on/);
    expect(workflow).toMatch(/--waive-skill <skill>/);
    expect(workflow).toMatch(/A report is the\s+worker's claim, not proof/);
    const bot = prompts.slice(
      prompts.indexOf("## Bot brief"),
      prompts.indexOf("## Mode on revision"),
    );
    expect(bot).toMatch(/does not authorize deploying or posting/);
    expect(bot).toMatch(/Do not read a skills path from the Bot message/);
    const revision = prompts.slice(
      prompts.indexOf("## Mode on revision"),
      prompts.indexOf("## Cross-provider subagent"),
    );
    expect(revision).toMatch(/never on by default for later attempts/);
    const cross = prompts.slice(prompts.indexOf("## Cross-provider subagent"));
    expect(cross).toMatch(/route[s]? Grok work through an HMR role/);
    expect(skill).toMatch(/instead of a model list of your own/);
  });
});
