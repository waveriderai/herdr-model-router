# Herdr Model Router — Herdr plugin

Runs [Herdr Model Router](../README.md) from inside Herdr: route a task to a role, check account
status and quota, browse router sessions, and resume an earlier session.

## Install

```bash
herdr plugin install waveriderai/herdr-model-router
```

The manifest lives at the repository root, so no subdirectory is needed. The plugin id is
the `id` field of `herdr-plugin.toml`; the commands below use it.

Install runs `npm ci` and builds the router workspace, which needs **Node.js 20+**
and a C/C++ toolchain (`better-sqlite3` compiles natively). If you already have
`router` on your `PATH`, the plugin uses that binary instead of the checkout's
build.

Local development:

```bash
npm ci && npm run build          # plugin link does not run build commands
herdr plugin link /path/to/herdr-model-router
herdr plugin action list --plugin waveriderai.herdr-model-router
```

## Configure

The plugin does not own configuration. The router reads your `pstack-models.mdc` rules and
project policy as documented in the [main README](../README.md), and each lane uses the agent
CLI you are logged in to. `resume-latest` uses quota mode, which also needs a TypeSafe key.

## Actions

| Action          | What it does                                                |
| --------------- | ----------------------------------------------------------- |
| `route`         | Prompt for a role and a task, launch every lane of the role |
| `status`        | Show configured accounts, optionally with live quota        |
| `sessions`      | List recent router sessions and open one in detail          |
| `resume-latest` | Route the next phase of an earlier quota-mode session       |
| `usage-refresh` | Refresh local-session quota snapshots (headless)            |

`route` uses the efforts your rules name. In quota mode (`resume-latest`), `max` and `ultra`
reasoning are unlocked only by the word "ultra" in the task that started the session; a
next-phase task inherits that choice but cannot unlock it.

Invoke one directly:

```bash
herdr plugin action invoke route --plugin waveriderai.herdr-model-router
```

## Keybindings

Add to `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+r"
type = "plugin_action"
command = "waveriderai.herdr-model-router.route"
description = "route a task"

[[keys.command]]
key = "prefix+R"
type = "plugin_action"
command = "waveriderai.herdr-model-router.status"
description = "router status"
```

## Environment overrides

| Variable               | Effect                                                                      |
| ---------------------- | --------------------------------------------------------------------------- |
| `ROUTER_BIN`           | Use a specific router executable                                            |
| `ROUTER_USAGE_SOURCE`  | `local-session` (default), `official-cli`, or `browser` for `usage-refresh` |
| `ROUTER_SESSION_LIMIT` | How many sessions the `sessions` pane lists (default 20)                    |

## Notes

- The panes are overlays: they close when you press Enter at the prompt.
- `router run` launches agents only from inside Herdr (`HERDR_ENV=1`), which
  every plugin command already has.
- Routing sends the task text to TypeSafe. See the security and privacy notes in
  the main README before routing anything sensitive.
