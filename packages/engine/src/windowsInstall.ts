// A flavor's install on Windows, by Velopack, in its own folder under
// %LOCALAPPDATA% (app/scripts/package-windows.mts): Update.exe, the app
// in current\, which every update replaces in place, and the bin folder
// the terminal command is put on PATH from (app/host/lib/cli/launchers.ts),
// which updates leave alone. Each launcher in it runs current's command
// (cli-launcher/).
import { dirname, join } from "node:path";
import { type Flavor, flavorNames } from "./flavor.ts";

// The install's folder, from the app's resources.
export const windowsInstallRoot = (resourcesPath: string) =>
  dirname(dirname(resourcesPath));

export const windowsCliBinDir = (resourcesPath: string) =>
  join(windowsInstallRoot(resourcesPath), "bin");

// Velopack's, which makes a folder an install.
export const windowsUpdateExe = (resourcesPath: string) =>
  join(windowsInstallRoot(resourcesPath), "Update.exe");

// The package's id, which names the install's folder. Without a hyphen,
// as the Squirrel.Windows installs Velopack took over named theirs.
export const windowsPackageId = (flavor: Flavor) =>
  flavorNames(flavor).configDir.replaceAll("-", "_");
