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

// `sm doctor --json`: the CLI's installation and data-dir checklist,
// one finding per line. `repairable` marks what `--fix` would repair.
// The CLI owns every word of title, detail and fix. Only the fields
// the app reads are declared.
const DoctorFindingSchema = z.object({
  group: z.string(),
  id: z.string(),
  title: z.string(),
  status: z.enum(["ok", "warn", "fail"]),
  detail: z.string(),
  fix: z.string().optional(),
  repairable: z.boolean().optional(),
});
export type DoctorFinding = z.infer<typeof DoctorFindingSchema>;

export const DoctorReportSchema = z.object({
  summary: z.object({ ok: z.number(), warn: z.number(), fail: z.number() }),
  // Past-tense labels of the repairs a --fix run applied, and the
  // "couldn't <label>: <error>" line of each one that failed.
  repaired: z.array(z.string()),
  repairFailed: z.array(z.string()),
  checks: z.array(DoctorFindingSchema),
});
export type DoctorReport = z.infer<typeof DoctorReportSchema>;

// Served to a peer as well as the local window: Settings shows every
// device of the account, and a peer holding the command grant may
// manage that device's CLI links and shell hooks from there, the same
// way it may already run scripts on it. Every call rides the grant,
// the two status reads included (tagged gated like runtime:info and
// the fs reads), because they name the host's home, bin dir and rc
// files. None of them pings viewers: links and rc hooks are no part of
// the forest state a ping re-reads, and the caller seeds its own cache
// from each reply.
const gated = { remote: true, gated: true, movesHostState: false };

export const cliContract = defineContract("host", {
  status: invoke("cli:status", z.void(), CliStatusSchema, gated),
  install: invoke(
    "cli:install",
    z.object({ force: z.boolean() }),
    CliStatusSchema,
    gated,
  ),
  uninstall: invoke("cli:uninstall", z.void(), CliStatusSchema, gated),
  shellStatus: invoke(
    "cli:shellStatus",
    z.void(),
    ShellIntegrationStatusSchema,
    gated,
  ),
  shellInstall: invoke(
    "cli:shellInstall",
    z.void(),
    ShellIntegrationStatusSchema,
    gated,
  ),
  shellUninstall: invoke(
    "cli:shellUninstall",
    z.void(),
    ShellIntegrationStatusSchema,
    gated,
  ),
  // The checklist names the host's paths, so it rides the grant like
  // the status reads. The repair run can unregister a project, which
  // is forest state, so unlike the rest it pings viewers.
  doctor: invoke("cli:doctor", z.void(), DoctorReportSchema, gated),
  doctorFix: invoke("cli:doctorFix", z.void(), DoctorReportSchema, {
    remote: true,
    gated: true,
  }),
});
