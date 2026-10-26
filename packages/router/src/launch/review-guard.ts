import path from "node:path";
import type { RunCommand } from "./herdr-client.js";

/**
 * AGENT-519 (Kai t447u): the hard Codex review-gate round counter. Before any `review gate` /
 * `design review gate` lane starts, `review-rounds take --repo R --pr N --sha HEAD` must pass:
 * at most 3 rounds per PR across all head SHAs, more only with an EL/Kai override recorded in
 * review-rounds' logged overrides file. Fails closed: no PR, no HEAD, or no review-rounds tool
 * starts nothing.
 *
 * PR identity: HMR_PR=<repo>#<n> (or waveriderai/<repo>#<n>), else the checkout's branch looked
 * up with `gh pr list --head`.
 */
const PR = /^(?:waveriderai\/)?([A-Za-z0-9][A-Za-z0-9._-]{0,99})#([1-9][0-9]{0,6})$/;
const ORIGIN = /github\.com[:/]waveriderai\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;

export function createReviewGuard(run: RunCommand, env: NodeJS.Dict<string>) {
  const tool = env.HMR_REVIEW_ROUNDS || path.join(env.HOME ?? "", ".local/bin/review-rounds");
  return async (input: { role: string; cwd: string }) => {
    const head = await run(["git", "-C", input.cwd, "rev-parse", "HEAD"]);
    const sha = head.stdout.trim();
    if (!head.ok || !/^[0-9a-f]{40}$/.test(sha)) {
      return { ok: false as const, error: `review gate: cannot read HEAD in ${input.cwd}` };
    }
    let repo: string | undefined;
    let pr: string | undefined;
    const explicit = env.HMR_PR?.trim().match(PR);
    if (explicit) {
      repo = explicit[1];
      pr = explicit[2];
    } else {
      const origin = await run(["git", "-C", input.cwd, "remote", "get-url", "origin"]);
      const branch = await run(["git", "-C", input.cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
      repo = origin.ok ? origin.stdout.trim().match(ORIGIN)?.[1] : undefined;
      const name = branch.ok ? branch.stdout.trim() : "";
      if (repo && name && name !== "HEAD") {
        const found = await run([
          "gh",
          "pr",
          "list",
          "-R",
          `waveriderai/${repo}`,
          "--head",
          name,
          "--state",
          "open",
          "--json",
          "number",
          "--jq",
          ".[0].number",
        ]);
        const n = found.ok ? found.stdout.trim() : "";
        if (/^[1-9][0-9]{0,6}$/.test(n)) pr = n;
      }
    }
    if (!repo || !pr) {
      return {
        ok: false as const,
        error:
          "review gate needs its PR for the round cap: set HMR_PR=<repo>#<n> (a detached review worktree has no branch to look up)",
      };
    }
    const taken = await run([
      tool,
      "take",
      "--repo",
      repo,
      "--pr",
      pr,
      "--sha",
      sha,
      "--role",
      input.role,
    ]);
    if (!taken.ok) {
      const why = `${taken.stderr}${taken.stdout}`.trim().slice(0, 600) || `exit ${taken.code}`;
      return { ok: false as const, error: `review-rounds refused ${repo}#${pr}: ${why}` };
    }
    return { ok: true as const, note: taken.stdout.trim() };
  };
}
