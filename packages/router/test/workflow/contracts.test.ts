import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BRIEF_VERSION,
  canonicalJson,
  parseBriefInput,
  parseResult,
  RESULT_VERSION,
  sha256,
} from "../../src/workflow/contracts.js";

const HEAD = "a".repeat(40);
const CONTENT = "b".repeat(64);

export const BRIEF = {
  version: BRIEF_VERSION,
  title: "Add the parser",
  goal: "Parse the synthetic config format.",
  scope: { allowed: ["src/parser.ts", "test/parser.test.ts"] },
  writerRole: "feature",
  verifierRoles: ["reviewers"],
  acceptance: ["Parser tests pass"],
};

export const WRITER_RESULT = {
  version: RESULT_VERSION,
  workflowId: "wf_1",
  attemptId: "wfa_1",
  lane: "writer",
  status: "impl-complete",
  revision: { head: HEAD, content: CONTENT },
  changedPaths: ["src/parser.ts"],
  checks: [{ command: "npm test", result: "pass" }],
  blockers: [],
};

describe("workflow contracts", () => {
  it("round-trips a literal brief and fills defaults", () => {
    const parsed = parseBriefInput(JSON.stringify(BRIEF));
    expect(parsed).toEqual({
      ok: true,
      value: {
        ...BRIEF,
        scope: { ...BRIEF.scope, excluded: [] },
        constraints: [],
        classification: "implementation",
      },
    });
  });

  it("round-trips writer and verifier results", () => {
    expect(parseResult(JSON.stringify(WRITER_RESULT))).toEqual({ ok: true, value: WRITER_RESULT });
    const verifier = {
      ...WRITER_RESULT,
      lane: "verifier",
      verifierLaneId: "lane_1",
      status: "pass",
    };
    expect(parseResult(JSON.stringify(verifier))).toEqual({ ok: true, value: verifier });
  });

  it.each([
    ["a wrong version", { ...BRIEF, version: "hmr.brief/v9" }, "version"],
    ["an unknown field", { ...BRIEF, model: "anything" }, "model"],
    ["no verifier role", { ...BRIEF, verifierRoles: [] }, "verifierRoles"],
    [
      "a path outside the worktree",
      { ...BRIEF, scope: { allowed: ["../etc"] } },
      "scope.allowed.0",
    ],
    ["an absolute path", { ...BRIEF, scope: { allowed: ["/etc/passwd"] } }, "scope.allowed.0"],
  ])("refuses a brief with %s", (_label, brief, field) => {
    const parsed = parseBriefInput(JSON.stringify(brief));
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toContain(field);
  });

  it.each([
    ["a missing attempt", { ...WRITER_RESULT, attemptId: undefined }, "attemptId"],
    ["a verifier status on the writer lane", { ...WRITER_RESULT, status: "pass" }, "status"],
    [
      "a short content fingerprint",
      { ...WRITER_RESULT, revision: { head: HEAD, content: "abc" } },
      "revision.content",
    ],
    [
      "an abbreviated head",
      { ...WRITER_RESULT, revision: { head: "abc1234", content: CONTENT } },
      "revision.head",
    ],
    [
      "a verifier without its lane id",
      { ...WRITER_RESULT, lane: "verifier", status: "pass" },
      "verifierLaneId",
    ],
    ["an extra identity field", { ...WRITER_RESULT, owner: "x" }, "owner"],
  ])("refuses a result with %s", (_label, result, field) => {
    const parsed = parseResult(JSON.stringify(result));
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toContain(field);
  });

  it("refuses text that is not JSON", () => {
    expect(parseResult("impl complete!")).toMatchObject({ ok: false });
  });

  it("hashes canonical JSON independently of key order", () => {
    expect(sha256(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }))).toBe(
      sha256(canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 })),
    );
  });

  it("accepts the published examples", () => {
    const examples = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../examples/workflow",
    );
    const read = (name: string) => readFileSync(path.join(examples, name), "utf8");
    expect(parseBriefInput(read("brief.example.json"))).toMatchObject({ ok: true });
    expect(parseBriefInput(read("bot-brief.example.json"))).toMatchObject({
      ok: true,
      value: { version: "hmr.brief/v2", skills: { modes: ["poteto-mode"] } },
    });
    expect(parseResult(read("result.example.json"))).toMatchObject({
      ok: true,
      value: { lane: "writer" },
    });
    expect(parseResult(read("verifier-result.example.json"))).toMatchObject({
      ok: true,
      value: { lane: "verifier", status: "fail" },
    });
  });
});
