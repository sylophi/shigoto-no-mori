import { z } from "zod";
import { WorktreeScopedPayloadSchema } from "./payloads";

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

// URL-based launcher. The id encodes which provider it is so the main
// process can resolve the URL at launch time. Shared so both ends of
// the IPC compare against the same string.
export const WEB_GITHUB_ID = "web:github";

export const WebLauncherSchema = z.object({
  kind: z.literal("web"),
  id: z.string(),
  label: z.string(),
});
export type WebLauncher = z.infer<typeof WebLauncherSchema>;

export const LauncherEntrySchema = z.discriminatedUnion("kind", [
  DetectedLauncherSchema,
  CustomLauncherSchema,
  WebLauncherSchema,
]);
export type LauncherEntry = z.infer<typeof LauncherEntrySchema>;

export const LaunchPayloadSchema = WorktreeScopedPayloadSchema.extend({
  launcherId: z.string().min(1),
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
