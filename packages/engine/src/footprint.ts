// Everything of a flavor's on the machine, outside its bundle: the
// files and folders it makes, each of them its own (the flavor's names
// key every one), and what it keeps in places other flavors share. A
// nuke removes the files and folders, and the entries in shared places
// go with the host's half (the shell hook block, the agent hooks, the
// login item, the device on the hub). So nothing of one build is
// another's (flavor.test.ts), and nothing of a nuked build stays (the
// terminal's `nuke`, commands/nuke.ts).
import { join } from "node:path";
import { type Flavor, flavorNames } from "./flavor.ts";

export type FootprintPlace = {
  readonly home: string;
  // XDG_CONFIG_HOME, or ~/.config.
  readonly configHome: string;
  // Where the terminal command is linked (XDG_BIN_HOME, or ~/.local/bin).
  readonly binHome: string;
};

export type Footprint = {
  // Each a file or a folder of this flavor's alone, deleted whole, but
  // the config folder, which goes once empty: it may hold the owner's
  // own files beside the pointer.
  readonly paths: ReadonlyArray<{
    readonly id:
      | "data"
      | "userData"
      | "logs"
      | "config"
      | "preferences"
      | "command"
      | "alias"
      | "fishHook";
    readonly path: string;
  }>;
  // Kept in a place other flavors share, under this flavor's names.
  readonly keychainItem: string;
  readonly shellHookMarker: string;
  readonly agentHookBinary: string;
  // The OS's registrations: the login item and the URL scheme, by them.
  readonly bundleId: string;
  readonly scheme: string;
};

export const footprint = (flavor: Flavor, place: FootprintPlace): Footprint => {
  const names = flavorNames(flavor);
  const library = join(place.home, "Library");
  const config = join(place.configHome, names.configDir);
  return {
    paths: [
      // A pointer can move it: the one the pointer names is the
      // flavor's then, and the nuke reads it from the running build.
      { id: "data", path: join(place.home, names.dataDir) },
      {
        id: "userData",
        path: join(library, "Application Support", names.userDataDir),
      },
      { id: "logs", path: join(library, "Logs", names.appName) },
      { id: "config", path: config },
      {
        id: "preferences",
        path: join(library, "Preferences", `${names.bundleId}.plist`),
      },
      {
        id: "command",
        path: join(place.binHome, names.binaryName),
      },
      { id: "alias", path: join(place.binHome, names.alias) },
      {
        id: "fishHook",
        path: join(place.configHome, "fish", "conf.d", `${names.alias}.fish`),
      },
    ],
    keychainItem: `${names.appName} Safe Storage`,
    shellHookMarker: `# >>> ${names.alias} shell integration >>>`,
    agentHookBinary: names.binaryName,
    bundleId: names.bundleId,
    scheme: names.scheme,
  };
};

// The app started to nuke itself with no window (`<binary> nuke`): it
// takes its things off the machine and exits saying how far it got.
// The files go on a second start, the way a nuke from Settings
// finishes at the next one, so the command starts it until it says
// `finished`.
export const NUKE_SWITCH = "sm-nuke";
export const NUKE_EXIT = {
  // The files are gone: nothing is left to do.
  finished: 0,
  // The same, with something it couldn't delete, said on its output.
  finishedWithLeft: 13,
  // Files it couldn't delete, said on its output: the marker stays in
  // the app's own folder, for the next start to finish.
  marked: 14,
  // The live half ran: start it again to delete the files.
  again: 10,
  // The same, with something it couldn't take off, said on its output.
  againWithLeft: 11,
  // Another copy of the app holds the lock: quit it first.
  running: 12,
} as const;
