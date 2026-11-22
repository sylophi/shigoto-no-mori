// Makes the Windows installer and the package its updates install with
// Velopack's vpk (.config/dotnet-tools.json pins it), from the app
// `electron-forge package` laid out in out/. Both land in
// out/make/velopack/: the Setup.exe a person runs and the full .nupkg
// the updater downloads (packages/engine/src/updater/velopack.ts). The
// app installs per user into %LOCALAPPDATA%\<package id>
// (windowsInstall.ts), with shortcuts on the desktop and in a Start
// menu folder named for the publisher. The shortcuts carry the app user
// model id Electron gives an app with Update.exe beside its folder, so
// a pinned shortcut, the running app and its notifications are one
// app's. SM_FLAVOR makes a test flavor's, as for the app. Updates run
// the Update.exe an install began with, so a newer vpk's reaches only
// new installs.
//
// Run: pnpm package:windows
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_REPO_OWNER, flavorNames } from "@shigomori/engine/flavor";
import { windowsPackageId } from "@shigomori/engine/windowsInstall";
import { buildFlavor } from "../shared/packaging/buildFlavor.mts";
import { appRoot } from "./lib/appRoot.mts";

const flavor = buildFlavor(process.env);
const { appName } = flavorNames(flavor);
const { version } = JSON.parse(
  readFileSync(join(appRoot, "package.json"), "utf8"),
) as { version: string };
const id = windowsPackageId(flavor);
const noSpaces = (text: string) => text.replaceAll(/\s/g, "");

const run = (args: string[]) =>
  execFileSync("dotnet", args, { cwd: appRoot, stdio: "inherit" });

run(["tool", "restore"]);
run([
  "vpk",
  "pack",
  "--packId",
  id,
  "--packVersion",
  version,
  "--runtime",
  "win-x64",
  "--packDir",
  join(appRoot, "out", `${appName}-win32-x64`),
  "--mainExe",
  `${appName}.exe`,
  "--packTitle",
  appName,
  "--packAuthors",
  APP_REPO_OWNER,
  "--icon",
  join(appRoot, "assets", "icon.ico"),
  "--splashImage",
  join(appRoot, "assets", "installer-loading.gif"),
  "--shortcuts",
  "Desktop,StartMenu",
  "--aumid",
  `com.squirrel.${id}.${noSpaces(appName)}`,
  "--noPortable",
  "--outputDir",
  join(appRoot, "out", "make", "velopack"),
]);
