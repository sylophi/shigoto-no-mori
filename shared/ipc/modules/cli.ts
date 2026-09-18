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

// Served to a peer as well as the local window: Settings shows every
// device of the account, and a peer holding the command grant may
// manage that device's CLI links and shell hooks from there, the same
// way it may already run scripts on it. Every call rides the grant.
// The two status reads are tagged mutating like runtime:info and the
// fs reads, because they name the host's home, bin dir and rc files,
// and they opt out of the resolved-mutation ping since they move
// nothing (a ping-driven refetch of a pinging read would loop).
const gatedRead = { remote: true, mutating: true, movesHostState: false };
const command = { remote: true, mutating: true };

export const cliContract = defineContract("host", {
  status: invoke("cli:status", z.void(), CliStatusSchema, gatedRead),
  install: invoke(
    "cli:install",
    z.object({ force: z.boolean() }),
    CliStatusSchema,
    command,
  ),
  uninstall: invoke("cli:uninstall", z.void(), CliStatusSchema, command),
  shellStatus: invoke(
    "cli:shellStatus",
    z.void(),
    ShellIntegrationStatusSchema,
    gatedRead,
  ),
  shellInstall: invoke(
    "cli:shellInstall",
    z.void(),
    ShellIntegrationStatusSchema,
    command,
  ),
  shellUninstall: invoke(
    "cli:shellUninstall",
    z.void(),
    ShellIntegrationStatusSchema,
    command,
  ),
});
