import type { ShigomoriConfig } from "./config.ts";

// The value a project setting takes while its key is absent from
// project.json, for the keys that have one (the rest are genuinely
// unset). The app decodes a missing key with it. The CLI's key
// registry (cli/cmd_config.go projectConfigKeys) mirrors these
// defaults, and the cli-reads proof holds the two together.
// Dependency-free (types only), so the layout math in
// shared/git/worktreeLayout.ts can import it. config.ts re-exports it.
export const PROJECT_CONFIG_DEFAULTS: Required<
  Pick<
    ShigomoriConfig,
    | "launchers"
    | "carryOver"
    | "useWorktreeInclude"
    | "worktreeLayout"
    | "showPrimaryInInbox"
  >
> = {
  launchers: [],
  carryOver: [],
  useWorktreeInclude: true,
  worktreeLayout: "managed-root",
  showPrimaryInInbox: false,
};
