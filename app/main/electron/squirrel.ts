// A Squirrel.Windows install: <root>\Update.exe, this exe in
// <root>\app-<version>\, a folder every update replaces, and a launcher
// <root>\<exe> that starts the newest version with the arguments it was
// given. What Windows keeps a path to (the shortcuts, the scheme, the
// login item) names the launcher.
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { app, shell } from "electron";
import { removeCliLaunchers } from "@shared/cliLaunchers";
import { rendererSchemeName } from "@shared/packaging/rendererScheme.mts";
import { flavor, names } from "../flavor";
import { appPlace } from "./appPlace";

const root = path.dirname(path.dirname(process.execPath));
const exe = path.basename(process.execPath);
const updateExe = path.join(root, "Update.exe");

// The exe that starts the app: the launcher in an install, else this one.
export const launcherPath = (): string =>
  existsSync(updateExe) ? path.join(root, exe) : process.execPath;

// The Start menu shortcut Electron keeps beside Squirrel's for its
// notifications, and the COM class it names, which Windows starts the
// app by when a notification is clicked.
function removeNotificationShortcut(): void {
  const shortcut = path.join(
    app.getPath("appData"),
    "Microsoft\\Windows\\Start Menu\\Programs",
    `${names.appName}.lnk`,
  );
  if (!existsSync(shortcut)) return;
  const clsid = shell.readShortcutLink(shortcut).toastActivatorClsid;
  spawnSync("reg", [
    "delete",
    `HKCU\\Software\\Classes\\CLSID\\${clsid}`,
    "/f",
  ]);
  rmSync(shortcut);
}

// Squirrel starts the app with one of these flags as it installs,
// updates, uninstalls or retires a version, and waits for it to exit.
// True when this start is one of them.
export function handledSquirrelEvent(): boolean {
  const scheme = rendererSchemeName(flavor);
  switch (process.argv[1]) {
    case "--squirrel-install":
    case "--squirrel-updated":
      spawnSync(updateExe, [`--createShortcut=${exe}`]);
      app.setAsDefaultProtocolClient(scheme, launcherPath());
      return true;
    case "--squirrel-uninstall":
      spawnSync(updateExe, [`--removeShortcut=${exe}`]);
      removeNotificationShortcut();
      app.removeAsDefaultProtocolClient(scheme, launcherPath());
      app.setLoginItemSettings({ openAtLogin: false });
      removeCliLaunchers(appPlace());
      return true;
    case "--squirrel-obsolete":
      return true;
    default:
      return false;
  }
}
