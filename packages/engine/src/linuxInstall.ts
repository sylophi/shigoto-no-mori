// A flavor's install on Linux, in the app's own folder (footprint.ts
// appFolders' userData): each version in a folder of its own under
// versions/, `current` linking the one that runs, and the systemd user
// unit that runs its host. A process runs from its version's folder to
// its end, so `current` moving on (an install or an update) changes
// nothing that runs, and the next start is the new version. The
// terminal command links to `current`'s, so it moves on with it.
import { basename, dirname, join } from "node:path";
import { type Flavor, flavorNames } from "./flavor.ts";
import type { FootprintPlace } from "./footprint.ts";

export type LinuxInstall = {
  readonly versions: string;
  readonly current: string;
  readonly unitName: string;
  readonly unit: string;
};

export const linuxInstall = (
  flavor: Flavor,
  place: Pick<FootprintPlace, "dataHome" | "configHome">,
): LinuxInstall => {
  const root = join(place.dataHome, flavorNames(flavor).configDir);
  const unitName = `${flavorNames(flavor).configDir}.service`;
  return {
    versions: join(root, "versions"),
    current: join(root, "current"),
    unitName,
    unit: join(place.configHome, "systemd", "user", unitName),
  };
};

// The version a file of the install is from (its real path, a binary's
// beside the host), or undefined for one from anywhere else.
export const installedVersionOf = (
  install: LinuxInstall,
  realPath: string,
): string | undefined => {
  const folder = dirname(realPath);
  return dirname(folder) === install.versions ? basename(folder) : undefined;
};

// `current`, from the folder of one of the install's versions.
export const currentOf = (versionFolder: string) =>
  join(dirname(dirname(versionFolder)), "current");

// What a version's folder holds that the unit and the command run.
export const HOST_RUNTIME = "node";
export const HOST_BUNDLE = "host.cjs";

// A version as a release ships it: one folder of this name in a gzipped
// tarball named for it too, which updateFeed.ts pickRelease finds by
// its platform and arch.
export const linuxPackageName = (flavor: Flavor, version: string) =>
  `${flavorNames(flavor).configDir}-linux-x64-${version}`;

// How a host that couldn't start exits (a store it can't open), which
// starting it again won't fix.
export const CANT_START_EXIT = 3;

// The host the unit runs is `current`'s, at boot (with the user's
// lingering on) and again whenever it exits but for a stop or
// CANT_START_EXIT. A stop signals it alone: its quit stops what it
// started, and what is left once it is done goes after it. The stop
// waits as long as the app's quit does, with its kill's grace
// (main/hostProcess.ts).
export const unitText = (flavor: Flavor, install: LinuxInstall) => `[Unit]
Description=${flavorNames(flavor).appName}

[Service]
ExecStart="${join(install.current, HOST_RUNTIME)}" "${join(install.current, HOST_BUNDLE)}"
Restart=always
RestartSec=2
RestartPreventExitStatus=${CANT_START_EXIT}
KillMode=mixed
TimeoutStopSec=20

[Install]
WantedBy=default.target
`;
