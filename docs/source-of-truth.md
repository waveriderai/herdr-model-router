# Source of truth: HMR routing rules + Herdr eng kick skill

Tracking: AGENT-278 (Kai approved 2026-10-14 as a token-cutback exception).

## Canonical files
| File | What it is | Live copy |
|---|---|---|
| `rules/pstack-models.mdc` | HMR model routing rules (roles, first-version, fallbacks, review-only) | DevPro `~/.cursor/rules/pstack-models.mdc` |
| `skills/herdr-eng-kick/SKILL.md` | Herdr engineering kick skill used by Grok Bot engineering bots | each Grok Bot account's skill store (`herdr-cursor-kick`) |

This repo is canonical for **both** Grok Bot accounts (Ops and Product). Both accounts share the same Herdr and HMR environment on DevPro. Local copies are mirrors, never edited by hand.

## How to change them
1. File or reuse a Plane ticket (`AGENT-###`).
2. Branch `agent-###-<slug>` in a worktree (workspace per project, worktree per ticket).
3. Open a PR with `AGENT-###` in the title. The Codex review gate applies (ACCEPT on the exact head SHA).
4. These paths (`skills/**`, `**/SKILL.md`, rules that change bot behavior) are on the auto-merge DENY list, so merges need Kai's approval via the CoS Ops batch.
5. After merge, sync the live copies (below) and note it on the ticket.

## DevPro sync (proposed: symlink)
After this PR merges, switch the live rules file to a symlink into the main checkout:

```sh
cd ~/projects/herdr-model-router && git pull --ff-only
cp ~/.cursor/rules/pstack-models.mdc ~/.cursor/rules/pstack-models.mdc.bak-$(date +%Y%m%d%H%M)
ln -sfn ~/projects/herdr-model-router/rules/pstack-models.mdc ~/.cursor/rules/pstack-models.mdc
hmr routing   # dry run: confirm routing is unchanged
```
Rollback: `rm ~/.cursor/rules/pstack-models.mdc && cp <backup> ~/.cursor/rules/pstack-models.mdc`.

Until then the live file is a plain file; the repo copy was taken from it on 2026-10-14.

## Skill sync
Each Grok Bot account copies `skills/herdr-eng-kick/SKILL.md` into its skill store (`herdr-cursor-kick`) after merge. Don't edit the skill in an account's store directly; open a PR instead.
