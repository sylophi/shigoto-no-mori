import * as Schema from "effect/Schema";
import { defineContract, invoke } from "../contract.ts";
import { VoidSchema } from "../schemas/index.ts";

// stale: our link, at another copy. foreign: not ours, replaced only
// with force.
const CliStatusSchema = Schema.Struct({
  name: Schema.String,
  aliasName: Schema.String,
  binDir: Schema.String,
  linkPath: Schema.String,
  state: Schema.Literals(["installed", "stale", "missing", "foreign"]),
  // So the replace consent can name each file it would overwrite.
  foreignPaths: Schema.Array(Schema.String),
  onPath: Schema.Boolean,
});
export type CliStatus = typeof CliStatusSchema.Type;

// modified: our markers around content we didn't write, never touched
// (like a foreign link).
const ShellHookStateSchema = Schema.Struct({
  shell: Schema.String,
  path: Schema.String,
  state: Schema.Literals(["installed", "missing", "modified"]),
});

const ShellIntegrationStatusSchema = Schema.Struct({
  // Resolved app-side: a Finder-launched app may not have $SHELL.
  loginShell: Schema.NullOr(Schema.String),
  shells: Schema.Array(ShellHookStateSchema),
});
export type ShellIntegrationStatus = typeof ShellIntegrationStatusSchema.Type;

// The engine's doctor owns every word (`sm doctor --json` prints the
// same run with more fields); only the fields the app reads are
// declared.
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
  repaired: Schema.Array(Schema.String),
  repairFailed: Schema.Array(Schema.String),
  checks: Schema.Array(DoctorFindingSchema),
});
export type DoctorReport = typeof DoctorReportSchema.Type;

// Every call rides the grant, the status reads included: they name the
// host's home, bin dir and rc files.
const gated = {
  remote: true,
  gated: true,
  grant: "changeApp",
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
  invoke("doctor", VoidSchema, DoctorReportSchema, gated),
  invoke("doctorFix", VoidSchema, DoctorReportSchema, {
    remote: true,
    gated: true,
    grant: "changeApp",
  }),
);
