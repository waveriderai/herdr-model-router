---
name: Herdr eng kick (owned by Herdr Keeper)
description: >-
  Use when launching Herdr panes on DevPro for eng work: reach DevPro by SSH,
  launch only through /hmr in named Herdr panes (never codex exec or bare
  tmux), nest under the project Space, keep panes interactive. Owned by Herdr Keeper.
---
# Herdr eng kick

Owner: Herdr Keeper (c24be89f-965d-49d5-8bf4-4d9d45452c9f) maintains this skill and audits compliance on every sweep. Bots that launch work (Engineering Lead, CoS Ops) follow it. Change requests go to Herdr Keeper.

**Name it “Herdr eng”** — never “Path A/B/C.” Chat-only handoffs are **SendToAgent**. pstack skills (incl. poteto-mode) are installed for Claude, Codex, and cursor-agent on DevPro and may be used in panes; Kai is on the Cursor Ultra plan; HMR routes coding first versions to Cursor first (AGENT-200).

Source of truth: `/Users/waverider/.codex/AGENTS.md` (2026-10-07), `wavefinder-app/scripts/CLAUDE_IMPLEMENTATION_WORKFLOW.md` and `waverider-internal/docs/policy/tiered-merge-policy.md`.

## Standing rules
1. Nest under existing project Space / worktree — never flat ticket-named Spaces.
2. One task → one worktree → one Herdr workspace. Panes only on role change.
3. **Never default `--kind cursor`.** pstack/poteto skills are available to Claude and Codex panes too.
3a. **Only `/hmr` in a named Herdr pane.** Never run `codex exec`, `claude -p`, or a bare/background tmux session as a substitute, even over SSH. If `hmr run` needs an interactive pane, open it in Herdr and read output with `herdr agent read`. Report back the pane names so they can be checked.
4. Run on DevPro, reached by SSH from the box (`ssh waverider@devpro`, see the DevPro over SSH + Herdr skill). Launch panes through `/hmr` model routing. Prefer `wf-task` / `claude-implement.mjs` + `agent-collab` over inventing a parallel lock.
5. **Interactive panes; answer blocked panes.** Panes stay interactive. When an agent is blocked or a pane must ask something, it asks in the pane; the watcher reads it with `herdr agent read` and answers via `herdr agent prompt` or send-keys. Escalate to Kai only for spend/destructive calls. BLOCKED.md is only a fallback when nobody is watching.

## Final step after Codex ACCEPT: tiered merge (AGENT-116, Kai GO 2026-10-07)
This replaces "stop at not merged". Policy: `~/projects/MultiAgent/docs/policy/tiered-merge-policy.md`.
1. `CODEX-VERDICT.md` must say **ACCEPT** and include the PR head SHA (at least 7 chars). An ACCEPT for an older head does not count.
2. In the pane, run `pr-merge-tiered --repo waveriderai/<repo> --pr <N> --verdict "$PWD/CODEX-VERDICT.md"`. It:
   - decides the severity from touched paths (`pr-tier --apply`) and leaves exactly one `sev:1`, `sev:2` or `sev:3` label;
   - for **any tier**, runs the script's own gate before any merge: every check finished, none red, the repo's required checks passing (wavefinder-app `verify` and `shell`; waverider-app `Vercel`), at least one check on a code PR, head unchanged. Only then does it run `gh pr merge --squash --match-head-commit`, using `--auto` only on a protected base. Never call `gh pr merge --auto` yourself, because gh merges CLEAN or UNSTABLE PRs immediately;
   - for every tier, no human GO is needed; it merges after ACCEPT on the head SHA and green CI.
   Note: legacy labels are normalized in the opposite direction: `tier:1` -> `sev:3`, `tier:2` -> `sev:2`, `tier:3` -> `sev:1`. An old `tier:3` PR is SEV-1 (money/auth), never the lightest level.
3. Severity policy: SEV-1 (money, auth, secrets, PII, DB schema), SEV-2 (pipelines), SEV-3 (frontend, docs, tests): all auto-merge and auto-deploy after independent review ACCEPT on the head SHA plus green CI; roll forward on breakage.
4. There is no design/CDO gate (design bots removed 2026-10-12). Small UI fixes match the existing look; anything needing a redesign gets a `needs-design` Plane label and goes to the other account. Design ownership lives with the Product account's CDO; the Codex design-consultant model in HMR is available to both accounts for specs.
5. A non-zero exit means the PR did not merge. Post a Plane comment and ping CoS Dev Ops (63d74e01). Never force a merge, never use admin bypass, never edit protection.
6. When you kick panes, include this step in the brief so the pane runs it itself. A pane must not stop at "not merged" for any tier.

## Gate fallback when Codex is out (AGENT-162, Kai GO 2026-10-08 2:18 PM PT; revised 2026-10-11)
Applies to all severities. A fallback ACCEPT never overrides a Codex REJECT for the same head.
1. Someone has to mark Codex as unavailable explicitly: `~/projects/MultiAgent/scripts/codex-unavailable.sh set --reason "<why>" [--until <UTC>]`. This writes `~/.config/pr-merge-tiered/CODEX_UNAVAILABLE` (mode 600, at most 7 days, ends at the recorded reset). It is never inferred from errors. Check it with `status`, remove it with `clear`. Don't set it while Codex has budget.
2. Fall back to an independent **Claude** reviewer (`claude-sonnet-5-5`, or `claude-opus-5-5` for SEV-1) or a **Grok** reviewer, run in Herdr via `/hmr` with an exact model, never Auto. The reviewer must not be the pane/agent that wrote the code. It writes `GATE-VERDICT.md` next to `CODEX-VERDICT.md` with: first word ACCEPT, the head SHA, a line `gate: claude` or `gate: grok`, and a line `model: <id>`.
3. **Cursor (`cursor-agent`) is first for coding first versions** (AGENT-200, Kai is on the Ultra plan). HMR picks it via `# hmr: first-version cursor` in pstack-models.mdc and falls back to the account with the most quota; fixes go to claude/grok, and codex is review-only. Exception (Kai 2026-10-14): for design work, **Codex `gpt-6.1-sol@xhigh` writes the design doc/spec/PRD only, never code** (role `design consultant`, `# hmr: readonly design consultant`; fallback `gpt-6.1-sol@high`, then Claude Opus 5.5); **Cursor implements** (`design implementation`, Cursor-first); **Codex reviews**.
4. Run `pr-merge-tiered` as usual. It re-checks the marker and verdicts right before merging and records the gate (`gate: codex …` or `gate: <claude|grok> <model> (codex unavailable: …)`) in the merge body and a PR comment. Copy that gate line into Plane.

## Role → model (reference; HMR resolves the exact route from the MDC role table)
| Role | Kind | Model |
|---|---|---|
| Scheduler / coordinator (no code) | grok | `grok-4.7@high` |
| Coord / accept | codex | `gpt-6.1-sol` |
| Major product/architecture only | codex | `gpt-6-astra` |
| Implement: feature, refactoring, new product | claude | `claude-opus-5-5@high` |
| Implement: bug-fix, ops maintenance | claude | `claude-sonnet-5-5@high` |
| Design consultant (spec, no code; mandatory for visual/UX) | codex | `gpt-6.1-sol@xhigh` (read-only, design docs/specs/PRDs, no code) |
| Design implementation (UI from spec) | cursor first | `claude-sonnet-5-5-high` (Cursor), then Claude, then Cursor `composer-2.5` |
| Small fix / docs | claude | `claude-sonnet-5-5@low` |
| Verify after writer stops | claude | `claude-sonnet-5-5` |

## Launch
Default: `/hmr` in Herdr (HMR rules-route `hmr.rules-route/v1`). HMR checks `agent-collab capabilities`, resolves provider/model/effort, waits for the CLI to be ready, then `agent-collab acquire ... --coordinator hmr:<workflow> --route @route.json`. If a receipt says the CLI did not become ready, read the pane, fix it, relaunch via `/hmr`.
Manual fallback only if HMR is down:
```bash
wf-task <workstream> <task> codex   # or claude
herdr agent start impl --kind claude --pane <id> -- --model claude-opus-5-5
```

SendToAgent (ops/tiny): Grok chat handoff — skips Herdr.
