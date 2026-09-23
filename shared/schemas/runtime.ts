import { Schema } from "effect";
import { NonNegativeInt } from "./ints";

export const RuntimeInfoSchema = Schema.Struct({
  // The data dir: where worktrees, configs and state live.
  dataDir: Schema.NonEmptyString,
  // How boot resolved it (host/lib/util/paths.ts DataDirSource).
  // "legacy" is a pre-2.0 folder adopted in place.
  dataDirSource: Schema.Literals(["env", "pointer", "legacy", "default"]),
  // Whether the data dir sits at the flavor's default location. Settings
  // offers a reset to the default when it doesn't.
  atDefaultDataDir: Schema.Boolean,
  // The flavor's own folder name (".sm" / ".smd"): what a move renames
  // the folder to.
  canonicalDataDirName: Schema.NonEmptyString,
  homedir: Schema.NonEmptyString,
});
export type RuntimeInfo = typeof RuntimeInfoSchema.Type;

// Move the data dir: the picked directory becomes the new parent of
// the data folder (which takes its canonical name). With no parent the
// folder goes back to its default location. The app relaunches right
// after a successful move (the data dir is a boot-time constant), so the
// invoke returns nothing the renderer could outlive.
export const MoveDataDirPayloadSchema = Schema.Struct({
  parentDir: Schema.optional(Schema.NonEmptyString),
});

// Progress broadcast while `runtime:nuke` runs, driving the renderer's
// blocking overlay: reap scripts → remove worktrees (with a counter) →
// wipe the data dir.
export const NukeProgressSchema = Schema.Union([
  Schema.Struct({ phase: Schema.Literal("scripts") }),
  Schema.Struct({
    phase: Schema.Literal("worktrees"),
    done: NonNegativeInt,
    total: NonNegativeInt,
  }),
  Schema.Struct({ phase: Schema.Literal("wipe") }),
]);
export type NukeProgress = typeof NukeProgressSchema.Type;

// In-app updater state. The CLI owns the update pipeline
// (cli/updater.go), and the app mirrors its progress into this machine.
// `downloading` covers both "found an update" and "still pulling
// bytes". The CLI streams no byte progress, so we collapse them.
// `ready` carries the version we'll restart into. `unsupported` means
// this build has no update channel at all (dev builds): the renderer
// hides the check button rather than offering a dead one.
export const UpdaterStateSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("unsupported") }),
  Schema.Struct({ kind: Schema.Literal("idle") }),
  Schema.Struct({ kind: Schema.Literal("checking") }),
  Schema.Struct({ kind: Schema.Literal("downloading") }),
  Schema.Struct({
    kind: Schema.Literal("ready"),
    version: Schema.String,
    notes: Schema.optional(Schema.String),
    // ISO 8601; null when the OS gave us an unparseable date.
    releaseDate: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("error"), message: Schema.String }),
]);
export type UpdaterState = typeof UpdaterStateSchema.Type;

// The app<->CLI bridge over the data dir (the CLI has no IPC channel
// into the app): the app publishes updater.json (UpdaterStatus, written
// on boot and on every state change) so `sm update` can tell whether a
// live instance must be restarted around the bundle swap, and consumes
// updater-request.json (UpdateRequest) dropped by the CLI. Both sides
// of the bridge live in main/electron/updaterBridge.ts. The only
// reader of updater.json is the Go CLI, so UpdaterStatusSchema exists
// to pin the published shape. cli/cmd_update.go mirrors the subset it
// needs (pid, appVersion, and the state's error kind).
const UpdaterStatusSchema = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  appVersion: Schema.String,
  state: UpdaterStateSchema,
});
export type UpdaterStatus = typeof UpdaterStatusSchema.Type;

export const UpdateRequestSchema = Schema.Struct({
  // The one thing the CLI ever asks of a running app: quit (confirming
  // with the user if scripts are running) and restart into the update
  // the CLI already staged. Checking needs no request, since the CLI
  // talks to the release feed itself.
  action: Schema.Literal("install"),
  // Unix ms. Requests older than a couple of minutes are dropped as
  // leftovers of an interrupted CLI run: acting on one later would
  // restart the app under the user out of nowhere.
  requestedAt: Schema.Finite,
});
export type UpdateRequest = typeof UpdateRequestSchema.Type;

// Manifest the CLI writes beside a verified staged update
// (<dataDir>/updates/staged/manifest.json). Mirrors cli/updater.go
// stagedManifest. The app reads it to seed "ready" at boot and to know
// whether "restart to update" has anything to restart into.
export const StagedManifestSchema = Schema.Struct({
  version: Schema.NonEmptyString,
  bundleName: Schema.NonEmptyString,
  notes: Schema.optional(Schema.String),
  releaseDate: Schema.optional(Schema.String),
});
export type StagedManifest = typeof StagedManifestSchema.Type;

// What `sm update --stage --json` streams: phase events while the
// pipeline runs, then one result document (cli/cmd_update.go emits
// both). The app's check validates against these so drift between the
// Go and TS sides fails loudly instead of degrading to a blank state.
export const UpdateStageEventSchema = Schema.Struct({
  event: Schema.Literals(["downloading", "verifying"]),
});
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
