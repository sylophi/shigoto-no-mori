import * as Schema from "effect/Schema";
import { WorktreeScopedPayloadSchema } from "./payloads";

// Detected apps + custom commands from the per-project config, ready for
// the renderer to display in a single launcher row.

export const DetectedLauncherSchema = Schema.Struct({
  kind: Schema.Literal("detected"),
  id: Schema.String,
  label: Schema.String,
  available: Schema.Boolean,
});
export type DetectedLauncher = typeof DetectedLauncherSchema.Type;

const CustomLauncherSchema = Schema.Struct({
  kind: Schema.Literal("custom"),
  id: Schema.String,
  label: Schema.String,
});

// URL-based launcher. The id encodes which provider it is so the main
// process can resolve the URL at launch time. Shared so both ends of
// the IPC compare against the same string.
export const WEB_GITHUB_ID = "web:github";

// A launcher id is "<kind>:<id>". The parser keeps the prefixes in one
// place, rather than decoding them by hand-counted slices at each call
// site. Mirrored by cli/launchers.go.
export type LauncherKind = "app" | "custom" | "web";

export function parseLauncherId(
  launcherId: string,
): { kind: LauncherKind; id: string } | null {
  const separator = launcherId.indexOf(":");
  if (separator < 0) return null;
  const kind = launcherId.slice(0, separator);
  if (kind !== "app" && kind !== "custom" && kind !== "web") return null;
  return { kind, id: launcherId.slice(separator + 1) };
}

const WebLauncherSchema = Schema.Struct({
  kind: Schema.Literal("web"),
  id: Schema.String,
  label: Schema.String,
});

export const LauncherEntrySchema = Schema.Union([
  DetectedLauncherSchema,
  CustomLauncherSchema,
  WebLauncherSchema,
]);
export type LauncherEntry = typeof LauncherEntrySchema.Type;

export const LaunchPayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  launcherId: Schema.NonEmptyString,
});

const LaunchToolMenuEntrySchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
});
export type LaunchToolMenuEntry = typeof LaunchToolMenuEntrySchema.Type;

export const SetLaunchToolsEnabledPayloadSchema = Schema.Struct({
  enabled: Schema.Boolean,
  // When enabling, the renderer passes the exact entries it's showing so
  // ⌘1..⌘9 always mirror the visible launcher row. Omit when disabling.
  entries: Schema.optional(Schema.Array(LaunchToolMenuEntrySchema)),
});
