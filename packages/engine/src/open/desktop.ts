// What the desktop does for Open, each OS its own way: a Mac's through
// Launch Services and AppleScript (launchServices.ts), Linux's through
// its screen opener (xdg.ts).
import type * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Launchers from "../Launchers.ts";
import type { LaunchFailed } from "./documents.ts";

export type Desktop = {
  // Opens `target` in the app found at `found`.
  readonly openApp: (
    label: string,
    found: string,
    target: string,
  ) => Effect.Effect<void, LaunchFailed>;
  // Starts the app found at `found` afresh, with its own arguments.
  readonly startApp: (
    label: string,
    found: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<void, LaunchFailed>;
  // Opens a file as the desktop would, a runnable one as text rather
  // than run.
  readonly openFile: (
    label: string,
    file: string,
    info: FileSystem.File.Info,
  ) => Effect.Effect<void, LaunchFailed>;
  // Runs `command` in `folder` in the terminal app `chosen` names.
  // `entries` are the launchers already read, which say whether it is
  // installed. Without them it is looked up.
  readonly inTerminalApp: (
    label: string,
    command: string,
    folder: string,
    chosen: string,
    entries?: ReadonlyArray<Launchers.Launchable>,
  ) => Effect.Effect<void, LaunchFailed>;
};
