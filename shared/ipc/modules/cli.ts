import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";

// State of the CLI symlink in the user's bin dir:
// - installed: our link, pointing at the binary this app runs
// - stale: our link, pointing at another copy (moved app, other checkout)
// - missing: nothing at the link path
// - foreign: something we didn't create; only replaced when an install
//   passes force (the Settings "Replace and install" consent)
const CliStatusSchema = z.object({
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

const ShellIntegrationStatusSchema = z.object({
  // The user's login shell when integration supports it, else null
  // (installs target this shell, resolved app-side since a
  // Finder-launched app may not have $SHELL).
  loginShell: z.string().nullable(),
  shells: z.array(ShellHookStateSchema),
});
export type ShellIntegrationStatus = z.infer<
  typeof ShellIntegrationStatusSchema
>;

// Local-only module: every call stays on the Electron wire (remote
// false). These edit shell rc files and CLI symlinks on the host, so they are never served to a remote peer.
export const cliContract = defineContract("host", {
  status: invoke("cli:status", z.void(), CliStatusSchema, { remote: false }),
  install: invoke(
    "cli:install",
    z.object({ force: z.boolean() }),
    CliStatusSchema,
    { remote: false },
  ),
  uninstall: invoke("cli:uninstall", z.void(), CliStatusSchema, {
    remote: false,
  }),
  shellStatus: invoke(
    "cli:shellStatus",
    z.void(),
    ShellIntegrationStatusSchema,
    { remote: false },
  ),
  shellInstall: invoke(
    "cli:shellInstall",
    z.void(),
    ShellIntegrationStatusSchema,
    { remote: false },
  ),
  shellUninstall: invoke(
    "cli:shellUninstall",
    z.void(),
    ShellIntegrationStatusSchema,
    { remote: false },
  ),
});
