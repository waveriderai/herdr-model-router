import type { ReasoningEffort } from "../domain/model-profile.js";
import type { Provider } from "./descriptor.js";
import type { Access } from "./plan.js";

/** Herdr `agent start --kind` values for each provider; `grok` is Herdr's native grok kind. */
export const HERDR_KIND: Record<Provider, "grok" | "codex" | "claude" | "cursor" | "opencode"> = {
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
export const PROVIDER_EXECUTABLE: Record<Provider, string> = {
  grok: "grok",
  codex: "codex",
  claude: "claude",
  cursor: "cursor-agent",
  opencode: "opencode",
};

/** Flags that skip approvals or sandboxes. The router never passes any of them. */
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

export interface NativeLaunch {
  kind: (typeof HERDR_KIND)[Provider];
  /** argv[0] is the executable name (`PROVIDER_EXECUTABLE`); a launch swaps in its absolute path. */
  argv: string[];
  /** Flags the installed CLI's --help must list before this argv may run. */
  requiredHelp: string[];
}

/**
 * Builds the exact native argv for one lane. Read-only lanes use each CLI's own enforced
 * read-only mode; a provider without one fails closed instead of running unrestricted.
 * Every value is a separate argv element: nothing is ever passed through a shell.
 */
export function nativeLaunch(
  lane: { provider: Provider; model: string; effort: ReasoningEffort | null },
  access: Access,
): { ok: true; launch: NativeLaunch } | { ok: false; error: string } {
  const read = access === "read";
  const { model, effort } = lane;
  switch (lane.provider) {
    case "claude":
      return built("claude", [
        ["--model", model],
        effort ? ["--effort", effort] : [],
        read ? ["--permission-mode", "plan"] : [],
      ]);
    case "codex":
      return built("codex", [
        ["--model", model],
        effort ? ["-c", `model_reasoning_effort="${effort}"`] : [],
        read ? ["--sandbox", "read-only"] : [],
      ]);
    case "grok":
      return built("grok", [
        ["--model", model],
        effort ? ["--reasoning-effort", effort] : [],
        read ? ["--permission-mode", "plan"] : [],
      ]);
    case "cursor":
      return built("cursor", [["--model", model], read ? ["--mode", "plan"] : []]);
    case "opencode":
      if (read) {
        return {
          ok: false,
          error:
            "opencode has no read-only mode the router can enforce; a read-only lane cannot run on it",
        };
      }
      return built("opencode", [["--model", model]]);
  }
}

function built(provider: Provider, groups: string[][]): { ok: true; launch: NativeLaunch } {
  const args = groups.flat();
  return {
    ok: true,
    launch: {
      kind: HERDR_KIND[provider],
      argv: [PROVIDER_EXECUTABLE[provider], ...args],
      requiredHelp: [
        ...new Set(
          args
            .filter((arg) => arg.startsWith("-"))
            .concat(args.filter((arg) => arg === "plan" || arg === "read-only")),
        ),
      ],
    },
  };
}

/** The flags from `requiredHelp` that the installed CLI's help text does not mention. */
export function missingCapabilities(helpText: string, required: readonly string[]): string[] {
  return required.filter((flag) => {
    const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return !new RegExp(`(^|[\\s,"'\\[(])${escaped}(?=$|[\\s,=<"'\\])])`, "m").test(helpText);
  });
}
