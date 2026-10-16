import * as Schema from "effect/Schema";

export const RuntimeInfoSchema = Schema.Struct({
  dataDir: Schema.NonEmptyString,
  // The data dir as git spells the paths under it, its links resolved,
  // where that differs from dataDir.
  dataDirReal: Schema.optional(Schema.NonEmptyString),
  // "legacy" is a pre-2.0 folder adopted in place.
  dataDirSource: Schema.Literals(["env", "pointer", "legacy", "default"]),
  atDefaultDataDir: Schema.Boolean,
  // What a move renames the folder to.
  canonicalDataDirName: Schema.NonEmptyString,
  homedir: Schema.NonEmptyString,
});
export type RuntimeInfo = typeof RuntimeInfoSchema.Type;

// The picked directory becomes the folder's new parent; none puts it
// back at the default. The app relaunches right after.
export const MoveDataDirPayloadSchema = Schema.Struct({
  parentDir: Schema.optional(Schema.NonEmptyString),
});

export const NukeProgressSchema = Schema.Union([
  Schema.Struct({ phase: Schema.Literal("scripts") }),
  Schema.Struct({
    phase: Schema.Literal("worktrees"),
    done: Schema.Natural,
    total: Schema.Natural,
  }),
  Schema.Struct({ phase: Schema.Literal("hooks") }),
]);
export type NukeProgress = typeof NukeProgressSchema.Type;

// The files go at the next start whatever this says.
export const NukeReportSchema = Schema.Struct({
  left: Schema.Array(
    Schema.Struct({ what: Schema.String, why: Schema.String }),
  ),
});
export type NukeReport = typeof NukeReportSchema.Type;

// `downloading` also covers "found an update": the engine streams no
// byte progress. `unsupported`: no update channel (dev builds).
export const UpdaterStateSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("unsupported") }),
  Schema.Struct({ kind: Schema.Literal("idle") }),
  Schema.Struct({ kind: Schema.Literal("checking") }),
  Schema.Struct({
    kind: Schema.Literal("downloading"),
    version: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("ready"),
    version: Schema.String,
    notes: Schema.optional(Schema.String),
    // null when the OS gave an unparseable date.
    releaseDate: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("error"),
    message: Schema.String,
    // The installer's own failure (its swap or relaunch), which the
    // windows toast where a check's failure stays in Settings.
    install: Schema.optional(Schema.Boolean),
  }),
]);
export type UpdaterState = typeof UpdaterStateSchema.Type;

// updater.json, published for `sm update`, which has no IPC into the
// app: it tells whether a live instance must restart around the swap.
const UpdaterStatusSchema = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  appVersion: Schema.String,
  state: UpdaterStateSchema,
});
export type UpdaterStatus = typeof UpdaterStatusSchema.Type;

export const UpdateRequestSchema = Schema.Struct({
  // The one thing the CLI asks of a running app: quit (confirming if
  // scripts run) and restart into the update the CLI staged.
  action: Schema.Literal("install"),
  // Older than a couple of minutes is dropped: acting on a leftover would
  // restart the app out of nowhere.
  requestedAt: Schema.Finite,
});
export type UpdateRequest = typeof UpdateRequestSchema.Type;

// What a failed finish-install leaves for the next app start, the
// relaunch of the current app it falls back to among them, which shows
// it as the updater's error.
export const InstallFailureSchema = Schema.Struct({ message: Schema.String });
export type InstallFailure = typeof InstallFailureSchema.Type;

// Beside a verified staged update; seeds "ready" at boot.
export const StagedManifestSchema = Schema.Struct({
  version: Schema.NonEmptyString,
  bundleName: Schema.NonEmptyString,
  notes: Schema.optional(Schema.String),
  releaseDate: Schema.optional(Schema.String),
});
export type StagedManifest = typeof StagedManifestSchema.Type;

export const UpdateStageResultSchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("up-to-date"),
    version: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("staged"),
    version: Schema.NonEmptyString,
    installed: Schema.String,
    notes: Schema.optional(Schema.String),
    releaseDate: Schema.optional(Schema.String),
  }),
]);
