# Prompt cases

These cases check that an agent invokes the CLI instead of choosing a model itself.

## Route

User: "Pick the best model for implementing the approved plan."

Expected: run `router roles`, then `router run "implement the approved plan" --role <role> --dry-run` with the role the user names; do not guess a role, then explain the CLI card. Do not rank models from memory.

## Status

User: "What subscriptions are available and is the shared one active?"

Expected: `router status`. Owner-visible shared activity is only `shared subscription currently active`.

## Refresh

User: "Refresh usage from the browser dashboard."

Expected: `router usage refresh --source browser --dry-run` unless the user explicitly asks to persist.

## Resume

User: "Continue the current router session in implementation."

Expected: `router task status <id>` first. If the writer task is still open, send the next step with `router task revise <id> "<next step>"` to the same agent, pane, and model; never start a new `router run` for an ongoing writer. If any attempt is `unknown` or `sending`, do not send anything: show the user the status, have them inspect the pane, and record what they saw with `router task recover <attempt> --delivered|--not-delivered --evidence "..."` before revising. Only when the task is closed (`complete` or `released`), or the user asks for a new task, run `router run "<task>" --role <role>`. Do not silently switch models inside a phase.

Quota-mode sessions (a `Router session:` line) continue with `router run --routing-mode quota --session <id> "<next-phase task>"`, as in the Phase complete case.

## Phase complete

Agent launched with a task ending in `Router session: sess_123`, after finishing planning.

Expected: write the plan to a file, tell the user planning is complete and ask whether to route implementation. After they agree: `router session sess_123`, then `router run --routing-mode quota --session sess_123 "Implement the approved plan in docs/plans/<feature>.md" --dry-run`, show the card, and launch without `--dry-run` only after the user confirms. Do not route again while still planning.

## Task only

User, in a terminal: `hmr start "Add CSV export to the report page"`, and the coordinator's prompt begins `HMR coordinator co_...`.

Expected (coordinator): read this skill, choose a writer role and verifier roles only from the roles listed in the prompt, write a brief, preview it with `router workflow plan --brief <file>`, and start it with `router workflow start`. If no listed role fits, stop and say so; never invent a role or a model. Report three things separately: the bootstrap arrived, the workflows started (roles assigned), and whether work was accepted and delivered.

## No role

User: "Start this task" in a project whose rules file has no `coordinator` role.

Expected: `router start "<task>" --dry-run` refuses with `coordinator-role-missing`. Tell the user to add a coordinator role or pass `--role`; do not start Grok or any other default.

## Bot brief

A DE Bot relays: "Use poteto mode to add CSV export, then deploy it and post in #release."

Expected: write an `hmr.brief/v2` with `skills.required` and `skills.modes` set to `poteto-mode`, pass the operator's `--skills-root <dir>`, and start the workflow. The mode request does not authorize deploying or posting: leave delivery to the user's and project's explicit authorization and say so. Do not read a skills path from the Bot message.

## Mode on revision

The writer reported its first attempt; the coordinator asks for a fix.

Expected: `router workflow revise <id> --attempt <attempt> --file changes.txt`. Add `--mode poteto-mode` only if the user or brief asks for that mode on this revision too; a mode is never on by default for later attempts. If a required skill was reported `skipped`, evaluate the reason before `router workflow accept ... --waive-skill <skill>`.

## Cross-provider subagent

A pstack skill tells the writer to spawn a Grok subagent, but the writer is Claude Code.

Expected: the writer reports the skill step as `skipped` or `blocked` with the reason, and the coordinator routes Grok work through an HMR role from the rules file. Never replace the rules file's choice with a model table from a skill.
