import { z } from "zod";

export const RuntimeInfoSchema = z.object({
  shigomoriRoot: z.string().min(1),
  homedir: z.string().min(1),
  isDev: z.boolean(),
});
export type RuntimeInfo = z.infer<typeof RuntimeInfoSchema>;

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

// In-app updater state. `downloading` covers both "found an update" and
// "still pulling bytes" -- macOS's autoUpdater doesn't expose progress,
// so we collapse them. `ready` carries the version we'll restart into.
// `unsupported` means this build has no update channel at all (dev
// builds, and the portable Windows zip): the renderer hides the check
// button rather than offering a dead one.
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
