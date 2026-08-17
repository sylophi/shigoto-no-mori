import { z } from "zod";

export const RuntimeInfoSchema = z.object({
  shigomoriRoot: z.string().min(1),
  // The root's folder basename ("shigomori-dev", or whatever a
  // hand-edited pointer file named it) so renderer copy never has to
  // parse the path.
  rootDirName: z.string().min(1),
  homedir: z.string().min(1),
  isDev: z.boolean(),
});
export type RuntimeInfo = z.infer<typeof RuntimeInfoSchema>;

// Move the state root: the picked directory becomes the new parent of
// the root folder (which keeps its name). The app relaunches right
// after a successful move -- the root is a boot-time constant -- so
// the invoke returns nothing the renderer could outlive.
export const MoveRootPayloadSchema = z.object({
  parentDir: z.string().min(1),
});
export type MoveRootPayload = z.infer<typeof MoveRootPayloadSchema>;

// Progress broadcast while `runtime:nuke` runs, driving the renderer's
// blocking overlay: reap scripts → remove worktrees (with a counter) →
// wipe the root.
export const NukeProgressSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("scripts") }),
  z.object({
    phase: z.literal("worktrees"),
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  z.object({ phase: z.literal("wipe") }),
]);
export type NukeProgress = z.infer<typeof NukeProgressSchema>;

// In-app updater state. The CLI owns the update pipeline
// (cli/updater.go), and the app mirrors its progress into this machine.
// `downloading` covers both "found an update" and "still pulling
// bytes" -- the CLI streams no byte progress, so we collapse them.
// `ready` carries the version we'll restart into. `unsupported` means
// this build has no update channel at all (dev builds): the renderer
// hides the check button rather than offering a dead one.
export const UpdaterStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unsupported") }),
  z.object({ kind: z.literal("idle") }),
  z.object({ kind: z.literal("checking") }),
  z.object({ kind: z.literal("downloading") }),
  z.object({
    kind: z.literal("ready"),
    version: z.string(),
    notes: z.string().optional(),
    // ISO 8601; null when the OS gave us an unparseable date.
    releaseDate: z.string().nullable(),
  }),
  z.object({ kind: z.literal("error"), message: z.string() }),
]);
export type UpdaterState = z.infer<typeof UpdaterStateSchema>;

// The app<->CLI bridge over the state root (the CLI has no IPC channel
// into the app): the app publishes updater.json (UpdaterStatus, written
// on boot and on every state change) so `sm update` can tell whether a
// live instance must be restarted around the bundle swap, and consumes
// updater-request.json (UpdateRequest) dropped by the CLI. Both sides
// of the bridge live in main/electron/updaterBridge.ts. The only
// reader of updater.json is the Go CLI, so UpdaterStatusSchema exists
// to pin the published shape -- cli/cmd_update.go mirrors the subset
// it needs (pid, appVersion, and the state's error kind).
export const UpdaterStatusSchema = z.object({
  pid: z.number().int().positive(),
  appVersion: z.string(),
  state: UpdaterStateSchema,
});
export type UpdaterStatus = z.infer<typeof UpdaterStatusSchema>;

export const UpdateRequestSchema = z.object({
  // The one thing the CLI ever asks of a running app: quit (confirming
  // with the user if scripts are running) and restart into the update
  // the CLI already staged. Checking needs no request -- the CLI talks
  // to the release feed itself.
  action: z.literal("install"),
  // Unix ms. Requests older than a couple of minutes are dropped as
  // leftovers of an interrupted CLI run: acting on one later would
  // restart the app under the user out of nowhere.
  requestedAt: z.number(),
});
export type UpdateRequest = z.infer<typeof UpdateRequestSchema>;

// Manifest the CLI writes beside a verified staged update
// (<root>/updates/staged/manifest.json). Mirrors cli/updater.go
// stagedManifest. The app reads it to seed "ready" at boot and to know
// whether "restart to update" has anything to restart into.
export const StagedManifestSchema = z.object({
  version: z.string().min(1),
  bundleName: z.string().min(1),
  notes: z.string().optional(),
  releaseDate: z.string().optional(),
});
export type StagedManifest = z.infer<typeof StagedManifestSchema>;

// What `sm update --stage --json` streams: phase events while the
// pipeline runs, then one result document (cli/cmd_update.go emits
// both). The app's check validates against these so drift between the
// Go and TS sides fails loudly instead of degrading to a blank state.
export const UpdateStageEventSchema = z.object({
  event: z.enum(["downloading", "verifying"]),
});
export const UpdateStageResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("up-to-date"), version: z.string() }),
  z.object({
    status: z.literal("staged"),
    version: z.string().min(1),
    installed: z.string(),
    notes: z.string().optional(),
    releaseDate: z.string().optional(),
  }),
]);
export type UpdateStageResult = z.infer<typeof UpdateStageResultSchema>;
