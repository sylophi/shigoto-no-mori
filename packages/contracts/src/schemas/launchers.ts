import * as Schema from "effect/Schema";
import { WorktreeScopedPayloadSchema } from "./payloads.ts";

// Detected apps + custom commands from the per-project config, ready for
// the renderer to display in a single launcher row.

export const DetectedLauncherSchema = Schema.Struct({
  kind: Schema.Literal("detected"),
  id: Schema.String,
  label: Schema.String,
  available: Schema.Boolean,
  // A tool the editor setting can name (catalog entries only).
  editor: Schema.optional(Schema.Boolean),
});
export type DetectedLauncher = typeof DetectedLauncherSchema.Type;

const CustomLauncherSchema = Schema.Struct({
  kind: Schema.Literal("custom"),
  id: Schema.String,
  label: Schema.String,
});

// URL-based launcher. The id encodes which provider it is so the host
// can resolve the URL at launch time. Shared so both ends of
// the IPC compare against the same string.
export const WEB_GITHUB_ID = "web:github";

// A launcher id is "<kind>:<id>". Builder and parser live together so
// the prefixes exist once, rather than being decoded by hand-counted
// slices at each call site.
export type LauncherKind = "app" | "custom" | "web";

export function launcherIdFor(kind: LauncherKind, id: string): string {
  return `${kind}:${id}`;
}

export function parseLauncherId(
  launcherId: string,
): { kind: LauncherKind; id: string } | null {
  const separator = launcherId.indexOf(":");
  if (separator < 0) return null;
  const kind = launcherId.slice(0, separator);
  if (kind !== "app" && kind !== "custom" && kind !== "web") return null;
  return { kind, id: launcherId.slice(separator + 1) };
}

// The terminal apps terminal tools can open in, as launcher catalog ids,
// in the order Settings lists them.
export const TERMINAL_IDS = ["terminal", "iterm", "ghostty", "cmux"] as const;

// The device setting `terminal`: the worktree's terminal drawer in the
// app, or one of the terminal apps.
export const TERMINAL_CHOICES = ["app", ...TERMINAL_IDS] as const;
export type TerminalChoice = (typeof TERMINAL_CHOICES)[number];

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

// The app terminal a launch or an opened file runs in, when the
// `terminal` setting picks the app's.
export const LaunchedSchema = Schema.Struct({
  terminalId: Schema.optional(Schema.String),
});
export type Launched = typeof LaunchedSchema.Type;

// A file to open in the editor, relative to the worktree's root.
export const OpenFilePayloadSchema = Schema.Struct({
  ...WorktreeScopedPayloadSchema.fields,
  path: Schema.NonEmptyString,
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

// The keys of the menu's actions (newWindow, addProject, settings,
// launchTool1..9) as the calling window binds them, as Electron
// accelerators. An action left out has none.
export const SetMenuChordsPayloadSchema = Schema.Struct({
  chords: Schema.Record(Schema.String, Schema.String),
});
