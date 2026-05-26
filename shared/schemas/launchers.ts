import { z } from "zod";

// Detected apps + custom commands from the per-project config, ready for
// the renderer to display in a single launcher row.

export const DetectedLauncherSchema = z.object({
  kind: z.literal("detected"),
  id: z.string(),
  label: z.string(),
  available: z.boolean(),
});
export type DetectedLauncher = z.infer<typeof DetectedLauncherSchema>;

export const CustomLauncherSchema = z.object({
  kind: z.literal("custom"),
  id: z.string(),
  label: z.string(),
});
export type CustomLauncher = z.infer<typeof CustomLauncherSchema>;

export const LauncherEntrySchema = z.discriminatedUnion("kind", [
  DetectedLauncherSchema,
  CustomLauncherSchema,
]);
export type LauncherEntry = z.infer<typeof LauncherEntrySchema>;

export const LaunchPayloadSchema = z.object({
  projectId: z.string(),
  worktreeId: z.string(),
  launcherId: z.string(),
});

export const LaunchToolMenuEntrySchema = z.object({
  id: z.string(),
  label: z.string(),
});
export type LaunchToolMenuEntry = z.infer<typeof LaunchToolMenuEntrySchema>;

export const SetLaunchToolsEnabledPayloadSchema = z.object({
  enabled: z.boolean(),
  // When enabling, the renderer passes the exact entries it's showing so
  // ⌘1..⌘9 always mirror the visible launcher row. Omit when disabling.
  entries: z.array(LaunchToolMenuEntrySchema).optional(),
});
