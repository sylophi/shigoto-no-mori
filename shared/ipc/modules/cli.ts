import { z } from "zod";
import { invoke } from "@shared/ipc/contract";

// State of the CLI symlink in the user's bin dir:
// - installed: our link, pointing at the binary this app runs
// - stale: our link, pointing at another copy (moved app, other checkout)
// - missing: nothing at the link path
// - foreign: something we didn't create; only replaced when an install
//   passes force (the Settings "Replace and install" consent)
export const CliStatusSchema = z.object({
  // False when there's nothing to link (a dev run without a built
  // dist-cli binary). The settings section hides itself then.
  supported: z.boolean(),
  name: z.string(),
  aliasName: z.string(),
  binDir: z.string(),
  linkPath: z.string(),
  state: z.enum(["installed", "stale", "missing", "foreign"]),
  // Every link path whose occupant is foreign, so the replace consent
  // can name each file a force install would overwrite (linkPath only
  // carries the single worst one).
  foreignPaths: z.array(z.string()),
  onPath: z.boolean(),
});
export type CliStatus = z.infer<typeof CliStatusSchema>;

// One shell's integration hook (the guarded eval line the CLI's
// `shell install` writes into that shell's config):
// - installed: present and recognizably ours
// - missing: not installed (or no config file at all)
// - modified: our markers with content we didn't write. The CLI never
//   touches those, mirroring the foreign-link policy above
export const ShellHookStateSchema = z.object({
  shell: z.string(),
  path: z.string(),
  state: z.enum(["installed", "missing", "modified"]),
});
export type ShellHookState = z.infer<typeof ShellHookStateSchema>;

export const ShellIntegrationStatusSchema = z.object({
  // False when the CLI binary can't run (a dev run without a built
  // dist-cli binary).
  supported: z.boolean(),
  // The user's login shell when integration supports it, else null
  // (installs target this shell, resolved app-side since a
  // Finder-launched app may not have $SHELL).
  loginShell: z.string().nullable(),
  shells: z.array(ShellHookStateSchema),
});
export type ShellIntegrationStatus = z.infer<
  typeof ShellIntegrationStatusSchema
>;

export const cliContract = {
  status: invoke("cli:status", z.void(), CliStatusSchema),
  install: invoke(
    "cli:install",
    z.object({ force: z.boolean() }),
    CliStatusSchema,
  ),
  uninstall: invoke("cli:uninstall", z.void(), CliStatusSchema),
  shellStatus: invoke(
    "cli:shellStatus",
    z.void(),
    ShellIntegrationStatusSchema,
  ),
  shellInstall: invoke(
    "cli:shellInstall",
    z.void(),
    ShellIntegrationStatusSchema,
  ),
  shellUninstall: invoke(
    "cli:shellUninstall",
    z.void(),
    ShellIntegrationStatusSchema,
  ),
} as const;

export type CliContract = typeof cliContract;
