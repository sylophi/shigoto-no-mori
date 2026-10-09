import * as Schema from "effect/Schema";
import { defineContract, invoke } from "../contract.ts";
import { VoidSchema } from "../schemas/index.ts";

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
const ShellHookStateSchema = Schema.Struct({
  shell: Schema.String,
  path: Schema.String,
  state: Schema.Literals(["installed", "missing", "modified"]),
});

const ShellIntegrationStatusSchema = Schema.Struct({
  // The user's login shell when integration supports it, else null
  // (installs target this shell, resolved app-side since a
  // Finder-launched app may not have $SHELL).
  loginShell: Schema.NullOr(Schema.String),
  shells: Schema.Array(ShellHookStateSchema),
});
export type ShellIntegrationStatus = typeof ShellIntegrationStatusSchema.Type;

// `sm doctor --json`: the CLI's installation and data-dir checklist,
// one finding per line. `repairable` marks what `--fix` would repair.
// The CLI owns every word of title, detail and fix. Only the fields
// the app reads are declared.
const DoctorFindingSchema = Schema.Struct({
  group: Schema.String,
  id: Schema.String,
  title: Schema.String,
  status: Schema.Literals(["ok", "warn", "fail"]),
  detail: Schema.String,
  fix: Schema.optional(Schema.String),
  repairable: Schema.optional(Schema.Boolean),
});
export type DoctorFinding = typeof DoctorFindingSchema.Type;

export const DoctorReportSchema = Schema.Struct({
  summary: Schema.Struct({
    ok: Schema.Finite,
    warn: Schema.Finite,
    fail: Schema.Finite,
  }),
  // Past-tense labels of the repairs a --fix run applied, and the
  // "couldn't <label>: <error>" line of each one that failed.
  repaired: Schema.Array(Schema.String),
  repairFailed: Schema.Array(Schema.String),
  checks: Schema.Array(DoctorFindingSchema),
});
export type DoctorReport = typeof DoctorReportSchema.Type;

// Served to a peer as well as the local window: Settings shows every
// device of the account, and a peer holding the command grant may
// manage that device's CLI links and shell hooks from there, the same
// way it may already run scripts on it. Every call rides the grant,
// the two status reads included (tagged gated like runtime:info and
// the fs reads), because they name the host's home, bin dir and rc
// files. None of them pings viewers: links and rc hooks are no part of
// the forest state a ping re-reads, and the caller seeds its own cache
// from each reply.
const gated = {
  remote: true,
  gated: true,
  grant: "changeApp",
  movesHostState: false,
} as const;

export const cliContract = defineContract(
  "cli",
  "host",
  invoke("status", VoidSchema, CliStatusSchema, gated),
  invoke(
    "install",
    Schema.Struct({ force: Schema.Boolean }),
    CliStatusSchema,
    gated,
  ),
  invoke("uninstall", VoidSchema, CliStatusSchema, gated),
  invoke("shellStatus", VoidSchema, ShellIntegrationStatusSchema, gated),
  invoke("shellInstall", VoidSchema, ShellIntegrationStatusSchema, gated),
  invoke("shellUninstall", VoidSchema, ShellIntegrationStatusSchema, gated),
  // The checklist names the host's paths, so it rides the grant like
  // the status reads. The repair run can unregister a project, which
  // is forest state, so unlike the rest it pings viewers.
  invoke("doctor", VoidSchema, DoctorReportSchema, gated),
  invoke("doctorFix", VoidSchema, DoctorReportSchema, {
    remote: true,
    gated: true,
    grant: "changeApp",
  }),
);
