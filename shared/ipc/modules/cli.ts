import { Schema } from "effect";
import { defineContract, invoke } from "@shared/ipc/contract";

// State of the CLI symlink in the user's bin dir:
// - installed: our link, pointing at the binary this app runs
// - stale: our link, pointing at another copy (moved app, other checkout)
// - missing: nothing at the link path
// - foreign: something we didn't create; only replaced when an install
//   passes force (the Settings "Replace and install" consent)
const CliStatusSchema = Schema.Struct({
  name: Schema.String,
  aliasName: Schema.String,
  binDir: Schema.String,
  linkPath: Schema.String,
  state: Schema.Literals(["installed", "stale", "missing", "foreign"]),
  // Every link path whose occupant is foreign, so the replace consent
  // can name each file a force install would overwrite (linkPath only
  // carries the single worst one).
  foreignPaths: Schema.Array(Schema.String),
  onPath: Schema.Boolean,
});
export type CliStatus = typeof CliStatusSchema.Type;

// One shell's integration hook (the guarded eval line the CLI's
// `shell install` writes into that shell's config):
// - installed: present and recognizably ours
// - missing: not installed (or no config file at all)
// - modified: our markers with content we didn't write. The CLI never
//   touches those, mirroring the foreign-link policy above
export const ShellHookStateSchema = Schema.Struct({
  shell: Schema.String,
  path: Schema.String,
  state: Schema.Literals(["installed", "missing", "modified"]),
});
export type ShellHookState = typeof ShellHookStateSchema.Type;

const ShellIntegrationStatusSchema = Schema.Struct({
  // The user's login shell when integration supports it, else null
  // (installs target this shell, resolved app-side since a
  // Finder-launched app may not have $SHELL).
  loginShell: Schema.NullOr(Schema.String),
  shells: Schema.Array(ShellHookStateSchema),
});
export type ShellIntegrationStatus = typeof ShellIntegrationStatusSchema.Type;

// Served to a peer as well as the local window: Settings shows every
// device of the account, and a peer holding the command grant may
// manage that device's CLI links and shell hooks from there, the same
// way it may already run scripts on it. Every call rides the grant,
// the two status reads included (tagged mutating like runtime:info and
// the fs reads), because they name the host's home, bin dir and rc
// files. None of them pings viewers: links and rc hooks are no part of
// the forest state a ping re-reads, and the caller seeds its own cache
// from each reply.
const gated = { remote: true, mutating: true, movesHostState: false };

export const cliContract = defineContract("host", {
  status: invoke("cli:status", Schema.Undefined, CliStatusSchema, gated),
  install: invoke(
    "cli:install",
    Schema.Struct({ force: Schema.Boolean }),
    CliStatusSchema,
    gated,
  ),
  uninstall: invoke("cli:uninstall", Schema.Undefined, CliStatusSchema, gated),
  shellStatus: invoke(
    "cli:shellStatus",
    Schema.Undefined,
    ShellIntegrationStatusSchema,
    gated,
  ),
  shellInstall: invoke(
    "cli:shellInstall",
    Schema.Undefined,
    ShellIntegrationStatusSchema,
    gated,
  ),
  shellUninstall: invoke(
    "cli:shellUninstall",
    Schema.Undefined,
    ShellIntegrationStatusSchema,
    gated,
  ),
});
