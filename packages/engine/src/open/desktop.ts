// What the desktop does for Open, each OS its own way: a Mac's through
// Launch Services and AppleScript (launchServices.ts), Linux's through
// its screen opener (xdg.ts), Windows' through its shell, Windows
// Terminal and PowerShell (windowsShell.ts). Each also has a launcher
// table, which says how Launchers finds the catalog's apps there.
import type { TerminalId } from "@shigomori/contracts/schemas/launchers";
import type * as Effect from "effect/Effect";
import type * as Path from "effect/Path";
import type { CatalogApp } from "../Launchers.ts";
import { byPlatform } from "../platform.ts";
import type {
  AppNotOpened,
  LaunchFailed,
  NoAppWindow,
  NoWindowsApp,
} from "./documents.ts";
import { macLaunchers, makeLaunchServices } from "./launchServices.ts";
import { makeWindowsShell, windowsLaunchers } from "./windowsShell.ts";
import { linuxLaunchers, makeXdg } from "./xdg.ts";

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
  // The terminal a terminal tool's command line runs in when none is
  // picked.
  readonly terminal: Effect.Effect<"app" | TerminalId>;
  // Opens (or brings forward) this build's installed app.
  readonly openOwnApp: Effect.Effect<
    void,
    AppNotOpened | NoAppWindow | NoWindowsApp
  >;
};

// How the catalog's apps are found: by the places an app lists for this
// desktop, tried in order, each looked for in these app folders, in
// order, or on PATH. FILE_MANAGER, as a place, is the desktop's own file
// manager, found where the desktop has one.
export type LauncherTable = {
  readonly placesOf: (app: CatalogApp) => ReadonlyArray<string>;
  readonly lookIn:
    | "PATH"
    | ((path: Path.Path, home: string) => ReadonlyArray<string>);
  readonly fileManager: boolean;
};

// This OS's desktop: how Open makes it, and its launcher table.
export const thisDesktop = () =>
  byPlatform({
    darwin: { make: makeLaunchServices, launchers: macLaunchers },
    linux: { make: makeXdg, launchers: linuxLaunchers },
    win32: { make: makeWindowsShell, launchers: windowsLaunchers },
  });
