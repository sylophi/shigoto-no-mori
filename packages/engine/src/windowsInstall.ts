// A flavor's install on Windows, by Squirrel.Windows, in its own folder
// under %LOCALAPPDATA% (app/forge.config.ts): Update.exe, each version
// in a folder of its own (app-<version>) whose resources hold its
// binaries, and the bin folder the terminal command is put on PATH from
// (app/host/lib/cli/launchers.ts), which updates leave in place. Each
// launcher in it runs the newest version's command (cli-launcher/).
import { dirname, join } from "node:path";
import { type Flavor, flavorNames } from "./flavor.ts";

// The install's folder, from a version's resources.
export const windowsInstallRoot = (resourcesPath: string) =>
  dirname(dirname(resourcesPath));

export const windowsCliBinDir = (resourcesPath: string) =>
  join(windowsInstallRoot(resourcesPath), "bin");

// Squirrel's, which makes a folder an install.
export const windowsUpdateExe = (resourcesPath: string) =>
  join(windowsInstallRoot(resourcesPath), "Update.exe");

// The package's id, which names the install's folder, without the
// hyphen Squirrel refuses.
export const squirrelPackageId = (flavor: Flavor) =>
  flavorNames(flavor).configDir.replaceAll("-", "_");

// The version a package carries, which names its app-<version> folder.
// Squirrel's launcher, the CLI's and Squirrel's own updates rank a
// prerelease label as text and NuGet takes no dots in one, so each
// number in it is padded: 3.0.0-beta.10 is 3.0.0-beta0010, above
// 3.0.0-beta0009.
export const squirrelVersion = (version: string) => {
  const dash = version.indexOf("-");
  if (dash < 0) return version;
  const label = version
    .slice(dash + 1)
    .replace(/\d+/g, (n) => n.padStart(4, "0"))
    .replaceAll(".", "");
  return `${version.slice(0, dash)}-${label}`;
};

// A full package's file name, which Squirrel reads its version from.
export const squirrelPackageFile = (flavor: Flavor, version: string) =>
  `${squirrelPackageId(flavor)}-${squirrelVersion(version)}-full.nupkg`;
