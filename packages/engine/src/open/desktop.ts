// What the desktop does for Open, each OS its own way: a Mac's through
// Launch Services and AppleScript (launchServices.ts), Linux's through
// its screen opener (xdg.ts), Windows' through its shell, Windows
// Terminal and PowerShell (windowsShell.ts).
import type * as Effect from "effect/Effect";
import type {
  AppNotOpened,
  LaunchFailed,
  NoAppWindow,
  NoWindowsApp,
} from "./documents.ts";

export type Desktop = {
  // Opens `target` in the app found at `found`, or in a copy of it the
  // desktop knows by the same name.
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
    runnable: boolean,
  ) => Effect.Effect<void, LaunchFailed>;
  // Runs `command` in `folder` in the terminal app `chosen` names.
  // `installed` finds an installed terminal app by its id.
  readonly inTerminalApp: (
    label: string,
    command: string,
    folder: string,
    chosen: string,
    installed: (
      id: string,
    ) => Effect.Effect<{ readonly label: string } | undefined>,
  ) => Effect.Effect<void, LaunchFailed>;
  // Opens (or brings forward) this build's installed app.
  readonly openOwnApp: Effect.Effect<
    void,
    AppNotOpened | NoAppWindow | NoWindowsApp
  >;
};
