// Taking the terminal command off PATH on Windows, for Settings
// (host/lib/cli/launchers.ts) and for the uninstall
// (main/electron/squirrel.ts), which can only wait on it synchronously.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { windowsCliBinDir } from "@shigomori/engine/windowsInstall";
import {
  type AppPlace,
  bundledBinaryPath,
} from "@shared/packaging/bundledBinary.mts";
import {
  NATIVEFS_BINARY_NAME,
  NATIVEFS_DIST_DIR,
} from "@shared/packaging/goHelpersDist.mts";

export function removeCliLaunchers(place: AppPlace): void {
  const binDir = windowsCliBinDir(place.resourcesPath);
  const edit = spawnSync(
    bundledBinaryPath(place, NATIVEFS_DIST_DIR, NATIVEFS_BINARY_NAME),
    ["user-path", "remove", binDir],
  );
  // Kept while PATH still names it, so Settings still shows it installed.
  if (edit.status !== 0) return;
  // A launcher a terminal is running stays until the install's folder
  // goes with the uninstall.
  try {
    rmSync(binDir, { recursive: true, force: true });
  } catch {}
}
