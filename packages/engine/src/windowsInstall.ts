// A flavor's install on Windows, by Squirrel.Windows, in its own folder
// under %LOCALAPPDATA% (app/forge.config.ts): Update.exe, each version
// in a folder of its own (app-<version>) whose resources hold its
// binaries, and the bin folder the terminal command is put on PATH from
// (app/host/lib/cli/launchers.ts), which updates leave in place. Each
// launcher in it runs the newest version's command (cli-launcher/).
import { dirname, join } from "node:path";

// The install's folder, from a version's resources.
export const windowsInstallRoot = (resourcesPath: string) =>
  dirname(dirname(resourcesPath));

export const windowsCliBinDir = (resourcesPath: string) =>
  join(windowsInstallRoot(resourcesPath), "bin");
