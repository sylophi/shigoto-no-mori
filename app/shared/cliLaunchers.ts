// The install's bin folder on the user's PATH on Windows (nativefs
// user-path), for Settings (host/lib/cli/launchers.ts) and for the
// uninstall (main/electron/squirrel.ts), which can only wait on it
// synchronously.
import { execFile, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { promisify } from "node:util";
import { windowsCliBinDir } from "@shigomori/engine/windowsInstall";
import {
  type AppPlace,
  nativefsPath,
} from "@shared/packaging/bundledBinary.mts";

const run = promisify(execFile);

const userPathArgs = (place: AppPlace, verb: "has" | "add" | "remove") => [
  "user-path",
  verb,
  windowsCliBinDir(place.resourcesPath),
];

export const onUserPath = async (place: AppPlace) =>
  (await run(nativefsPath(place), userPathArgs(place, "has"))).stdout.trim() ===
  "true";

export const addToUserPath = (place: AppPlace) =>
  run(nativefsPath(place), userPathArgs(place, "add"));

export function removeCliLaunchers(place: AppPlace): void {
  const binDir = windowsCliBinDir(place.resourcesPath);
  const edit = spawnSync(nativefsPath(place), userPathArgs(place, "remove"));
  // Kept while PATH still names it, so Settings still shows it installed.
  if (edit.status !== 0) return;
  // A launcher a terminal is running stays until the install's folder
  // goes with the uninstall.
  try {
    rmSync(binDir, { recursive: true, force: true });
  } catch {}
}
