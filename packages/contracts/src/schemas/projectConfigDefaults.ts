import type { ShigomoriConfig } from "./config.ts";

// The value a project setting takes while its key is absent from the
// project's settings, for the keys that have one (the rest are genuinely
// unset). The app decodes a missing key with it. The engine's
// Config reads its defaults from here.
// Dependency-free (types only), so the layout math in
// git/worktreeLayout.ts can import it. config.ts re-exports it.
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
