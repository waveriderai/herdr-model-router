import path from "node:path";
import { resolveHome } from "../config/config-loader.js";
import { tomlBasicString } from "./launch-script.js";
import type { ReasoningEffort } from "../domain/model-profile.js";
import type { Provider } from "./descriptor.js";
import type { Access } from "./plan.js";

/** Herdr `agent start --kind` values for each provider; `grok` is Herdr's native grok kind. */
export type HerdrKind = "grok" | "codex" | "claude" | "cursor" | "opencode";

/** Providers with a launch adapter in this file. A registry entry without one cannot launch. */
export const ADAPTED_PROVIDERS = ["grok", "codex", "claude", "cursor", "opencode"] as const;
type Adapted = (typeof ADAPTED_PROVIDERS)[number];

export function hasAdapter(provider: Provider): provider is Adapted {
  return (ADAPTED_PROVIDERS as readonly string[]).includes(provider);
}

export const HERDR_KIND: Record<Adapted, HerdrKind> = {
  grok: "grok",
  codex: "codex",
  claude: "claude",
  cursor: "cursor",
  opencode: "opencode",
};

/**
 * The executable each provider runs as. The router resolves it to an absolute path on PATH
 * and starts exactly that file. Cursor is `cursor-agent`: a bare `agent` on PATH can be
 * another vendor's CLI (the grok installer ships one).
 */
export const PROVIDER_EXECUTABLE: Record<Adapted, string> = {
  grok: "grok",
  codex: "codex",
  claude: "claude",
  cursor: "cursor-agent",
  opencode: "opencode",
};

/** The Herdr kind for a provider. Throws for a provider without an adapter (nativeLaunch gates first). */
export function herdrKindOf(provider: Provider): HerdrKind {
  if (!hasAdapter(provider)) throw new Error(`provider "${provider}" has no launch adapter`);
  return HERDR_KIND[provider];
}

/** The executable name for a provider. Throws for a provider without an adapter. */
export function executableOf(provider: Provider): string {
  if (!hasAdapter(provider)) throw new Error(`provider "${provider}" has no launch adapter`);
  return PROVIDER_EXECUTABLE[provider];
}

/**
 * Flags that skip approvals or sandboxes. The router passes one of them only for a lane with
 * the `bypass` profile, which nothing but the explicit per-run opt-in
 * (`hmr run --dangerously-bypass-permissions`) sets.
 */
export const BYPASS_FLAGS = [
  "--dangerously-skip-permissions",
  "--dangerously-bypass-approvals-and-sandbox",
  "--always-approve",
  "--yolo",
  "--force",
  "-f",
  "bypassPermissions",
  "danger-full-access",
  "--full-auto",
];

/**
 * What a launched CLI may do without asking.
 * - `read-only`: reads files and fetches from the web without a prompt; never edits.
 * - `writer`: also edits inside its own working directory (its worktree), with the CLI's
 *   sandbox on.
 * - `control`: the CLI's ordinary interactive permissions, for a coordinator.
 * - `bypass`: the CLI's own full bypass. Only the explicit per-run opt-in sets it.
 */
export type PermissionProfile = "read-only" | "writer" | "control" | "bypass";

/** The profile for a plan: its access, unless a coordinator or the per-run opt-in overrides it. */
export function permissionProfile(plan: {
  access: Access;
  permissions?: "control" | "bypass";
}): PermissionProfile {
  if (plan.access === "read") return "read-only";
  return plan.permissions ?? "writer";
}

/**
 * Claude Code settings for a writer: Bash runs in Claude's sandbox and is auto-approved while
 * it stays inside the sandbox (no prompt per command); `allowUnsandboxedCommands: false` means a
 * command can never escape the sandbox, and the writer runs in `dontAsk` mode (see
 * claudeWriterSettings), so anything outside the allow list is denied instead of prompting. `failIfUnavailable` makes Claude exit
 * at startup when the sandbox cannot start (a missing dependency, an unsupported platform);
 * without it Claude runs commands unsandboxed. The exit fails the lane's readiness check, so
 * the lane is not prompted.
 */
export const CLAUDE_WRITER_SETTINGS = JSON.stringify({
  sandbox: {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    // Kai GO 2026-10-14 5:04 PM PT: Next.js font fetches and local dev/preview servers
    // (next build/start + Playwright) run inside the sandbox. allowLocalBinding is a
    // boolean in Claude Code: on macOS it allows listening on any local port and
    // connecting to any localhost port; it cannot be narrowed to specific ports.
    network: {
      allowedDomains: ["fonts.googleapis.com", "fonts.gstatic.com"],
      allowLocalBinding: true,
    },
  },
});

/**
 * Claude writer settings for one launch (Kai 2026-10-14 7:37 PM PT: skip prompts, keep the
 * worktree sandbox). `dontAsk` never prompts: a tool call not allowed below is denied. Edits
 * are allowed in the working directory and hmr's state directory only. Bash is deliberately
 * not on the allow list: a sandboxed command is approved by `autoAllowBashIfSandboxed`, while a
 * command that would run outside the sandbox (an `excludedCommands` entry from user settings)
 * matches no allow rule and is denied. The sandbox's writable paths follow these Edit rules, so
 * a write outside them fails instead of asking.
 */
export function claudeWriterSettings(routerHome: string): string {
  const base = JSON.parse(CLAUDE_WRITER_SETTINGS) as Record<string, unknown>;
  const home = `/${path.resolve(routerHome)}/**`;
  return JSON.stringify({
    permissions: {
      allow: [
        "Read",
        "Glob",
        "Grep",
        "Edit(./**)",
        "Write(./**)",
        `Edit(${home})`,
        `Write(${home})`,
      ],
    },
    ...base,
  });
}

/** Tools a read-only Claude lane may use without a prompt. Plan mode still blocks edits. */
const CLAUDE_READ_TOOLS = "Read,Grep,Glob,WebFetch,WebSearch";

/**
 * Grok permission rules. Grok accepts `--permission-mode plan` and ignores it, so read-only
 * Grok lanes use explicit rules plus Grok's OS sandbox instead. `deny` always wins in Grok.
 */
export const GROK_READ_RULES = [
  ["--allow", "Read"],
  ["--allow", "Grep"],
  ["--allow", "WebFetch"],
  ["--allow", "WebSearch"],
  ["--deny", "Edit"],
  ["--deny", "Write"],
];
/** `./**` is rooted at the session's working directory in Grok's rule matcher. */
export const GROK_WRITER_RULES = [["--allow", "Edit(./**)"]];

export interface NativeLaunch {
  kind: HerdrKind;
  /** argv[0] is the executable name (`PROVIDER_EXECUTABLE`); a launch swaps in its absolute path. */
  argv: string[];
  /** Flags and values the installed CLI's --help must list before this argv may run. */
  requiredHelp: string[];
  /**
   * Set for a Codex writer: the permission profile its `/status` card must show
   * ("Permissions: Profile <name>") before it is prompted. Codex documents that a loaded
   * `sandbox_mode` silently wins over `default_permissions`, so the launch checks the live card.
   */
  expectedPermissionProfile?: string;
  /** Per-launch preparation (see launch-prep.ts); a launch that needs one never starts without it. */
  prepare?: "claude-writer" | "grok-profiles" | "cursor-config";
}

/**
 * Builds the exact native argv for one lane. Every profile maps to flags the CLI itself
 * enforces; a provider without an enforceable mode for a profile fails closed instead of
 * running with less restriction. Every value is a separate argv element: nothing is ever
 * passed through a shell.
 */
export function nativeLaunch(
  lane: { provider: Provider; model: string; effort: ReasoningEffort | null },
  profile: PermissionProfile,
  routerHome: string = resolveHome(),
): { ok: true; launch: NativeLaunch } | { ok: false; error: string } {
  const { model, effort } = lane;
  const provider = lane.provider;
  if (!hasAdapter(provider)) {
    return {
      ok: false,
      error: `provider "${provider}" is in the registry but has no launch adapter in native-argv.ts`,
    };
  }
  const pick = (byProfile: Record<PermissionProfile, Permission>): Permission => byProfile[profile];
  switch (provider) {
    case "claude":
      return withPrepare(
        profile === "writer" ? "claude-writer" : undefined,
        built(
          "claude",
          [["--model", model], effort ? ["--effort", effort] : []],
          pick({
            "read-only": {
              args: ["--permission-mode", "plan", "--allowedTools", CLAUDE_READ_TOOLS],
              values: ["plan"],
            },
            writer: {
              // Only project and local settings: no user allow rule can approve an excluded command.
              args: [
                "--permission-mode",
                "dontAsk",
                "--setting-sources",
                "project,local",
                "--settings",
                claudeWriterSettings(routerHome),
              ],
              values: ["dontAsk"],
            },
            control: NONE,
            bypass: { args: ["--dangerously-skip-permissions"] },
          }),
        ),
      );
    case "codex": {
      // Only a writer gets the extra root, so only a writer depends on the router home.
      let roots: string[] = [];
      if (profile === "writer") {
        if (!path.isAbsolute(routerHome)) {
          return {
            ok: false,
            error: `router home "${routerHome}" is not an absolute path; a Codex writer cannot be given it as a writable root`,
          };
        }
        roots = codexWriterProfile(routerHome);
      }
      // `-c` is always required: a launch also sets the pane's Herdr context with it.
      const launch = built(
        "codex",
        [["--model", model], effort ? ["-c", `model_reasoning_effort="${effort}"`] : []],
        pick({
          "read-only": {
            args: ["--sandbox", "read-only", "--ask-for-approval", "never", "--search"],
            values: ["read-only", "never"],
          },
          writer: {
            // The writer must reach hmr's own state (`hmr task status`, `hmr task complete`).
            // Only that exact directory is added; never a parent such as ~/Library or ~.
            // No `--sandbox`: that flag overrides `default_permissions`. The writer profile
            // extends Codex's built-in `:workspace` sandbox (see codexWriterProfile).
            // Kai 2026-10-14 7:37 PM PT: never prompt; anything the sandbox blocks fails.
            args: ["--ask-for-approval", "never", ...roots.flatMap((c) => ["-c", c])],
            values: ["never"],
          },
          control: NONE,
          bypass: { args: ["--dangerously-bypass-approvals-and-sandbox"] },
        }),
        ["-c"],
      );
      if (roots.length > 0) {
        launch.launch.expectedPermissionProfile = CODEX_WRITER_PROFILE;
      }
      return launch;
    }
    case "grok":
      return withPrepare(
        profile === "writer" || profile === "read-only" ? "grok-profiles" : undefined,
        built(
          "grok",
          [["--model", model], effort ? ["--reasoning-effort", effort] : []],
          pick({
            // `--always-approve` only inside an OS sandbox profile (Kai 2026-10-14 7:37 PM PT):
            // no prompts, and the sandbox still blocks writes outside the workspace.
            "read-only": {
              // hmr's custom profiles (~/.grok/sandbox.toml): Grok refuses to start when one cannot apply.
              args: ["--sandbox", "hmr-read-only", ...GROK_READ_RULES.flat(), "--always-approve"],
            },
            writer: {
              args: ["--sandbox", "hmr-writer", ...GROK_WRITER_RULES.flat(), "--always-approve"],
            },
            control: NONE,
            bypass: { args: ["--always-approve"] },
          }),
        ),
      );
    case "cursor":
      return withPrepare(
        profile === "writer" ? "cursor-config" : undefined,
        built(
          "cursor",
          [["--model", model]],
          pick({
            "read-only": { args: ["--mode", "plan"], values: ["plan"] },
            writer: { args: ["--sandbox", "enabled"], values: ["enabled"] },
            control: NONE,
            bypass: { args: ["--force"] },
          }),
        ),
      );
    case "opencode":
      if (profile === "read-only") {
        return {
          ok: false,
          error:
            "opencode has no read-only mode the router can enforce; a read-only lane cannot run on it",
        };
      }
      if (profile === "bypass") {
        return {
          ok: false,
          error: "opencode has no permission-bypass flag the router knows; it was not launched",
        };
      }
      return built("opencode", [["--model", model]], NONE);
  }
}

/** The Codex permission profile hmr defines for writer lanes. */
export const CODEX_WRITER_PROFILE = "hmr-writer";

/** Hosts a Codex writer may reach through Codex's network proxy (Kai GO 2026-10-14 5:04 PM PT). */
export const CODEX_WRITER_DOMAINS = ["fonts.googleapis.com", "fonts.gstatic.com"] as const;

/**
 * The Codex `-c` overrides for a writer: a named permission profile that extends the built-in
 * `:workspace` sandbox and adds only
 *  - write access to exactly hmr's state directory (resolveHome: MODEL_ROUTER_HOME, else the
 *    per-OS default), so `hmr task status` / `hmr task complete` work;
 *  - command networking through Codex's proxy, allowlisted to the two Google Fonts hosts;
 *  - `allow_local_binding`, so dev servers can listen on and be reached at localhost.
 * Every other destination stays blocked by the proxy; the sandbox stays on.
 */
export function codexWriterProfile(routerHome: string): string[] {
  if (!path.isAbsolute(routerHome)) {
    throw new Error(`router home "${routerHome}" is not an absolute path`);
  }
  const p = `permissions.${CODEX_WRITER_PROFILE}`;
  const domains = CODEX_WRITER_DOMAINS.map((d) => `${tomlBasicString(d)}="allow"`).join(",");
  return [
    `default_permissions=${tomlBasicString(CODEX_WRITER_PROFILE)}`,
    `${p}.extends=":workspace"`,
    `${p}.filesystem={${tomlBasicString(path.normalize(routerHome))}="write"}`,
    "features.network_proxy.enabled=true",
    `${p}.network.enabled=true`,
    `${p}.network.allow_local_binding=true`,
    `${p}.network.domains={${domains}}`,
  ];
}

/** A profile's argv and the enum values in it that the CLI's --help must also list. */
interface Permission {
  args: string[];
  values?: string[];
}

const NONE: Permission = { args: [] };

function withPrepare(
  prepare: NativeLaunch["prepare"],
  result: { ok: true; launch: NativeLaunch },
): { ok: true; launch: NativeLaunch } {
  if (prepare) result.launch.prepare = prepare;
  return result;
}

function built(
  provider: Adapted,
  groups: string[][],
  permission: Permission,
  alsoRequired: string[] = [],
): { ok: true; launch: NativeLaunch } {
  const args = [...groups.flat(), ...permission.args];
  return {
    ok: true,
    launch: {
      kind: HERDR_KIND[provider],
      argv: [PROVIDER_EXECUTABLE[provider], ...args],
      requiredHelp: [
        ...new Set(
          args
            .filter((arg) => /^--?[A-Za-z]/.test(arg))
            .concat(permission.values ?? [])
            .concat(alsoRequired),
        ),
      ],
    },
  };
}

/**
 * The flags and values from `requiredHelp` that the installed CLI's help text does not
 * mention as a whole word. A value may end in `:`, as in a help line `- on-request: ...`.
 */
export function missingCapabilities(helpText: string, required: readonly string[]): string[] {
  return required.filter((flag) => {
    const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return !new RegExp(`(^|[\\s,"'\\[(])${escaped}(?=$|[\\s,=:<"'\\])])`, "m").test(helpText);
  });
}
