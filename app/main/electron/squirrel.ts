// A Squirrel.Windows install: <root>\Update.exe, this exe in
// <root>\app-<version>\, a folder every update replaces, and a stub
// <root>\<exe> that starts the newest version with the arguments it was
// given. What Windows keeps a path to (the shortcuts, the scheme, the
// login item) names the stub.
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { app, shell } from "electron";
import { APP_REPO_OWNER } from "@shigomori/engine/flavor";
import {
  windowsInstallRoot,
  windowsUpdateExe,
} from "@shigomori/engine/windowsInstall";
import { removeCliLaunchers } from "@shared/cliLaunchers";
import { rendererSchemeName } from "@shared/packaging/rendererScheme.mts";
import { flavor, names } from "../flavor";
import { appPlace } from "./appPlace";

const root = windowsInstallRoot(process.resourcesPath);
const exe = path.basename(process.execPath);
const updateExe = windowsUpdateExe(process.resourcesPath);

// The exe that starts the app: the stub in an install, else this one.
const stubPath = (): string =>
  existsSync(updateExe) ? path.join(root, exe) : process.execPath;

// The renderer's scheme, which the Clerk bridge (clerk.ts) registers to
// this exe alone, registered to what starts the app. In a dev run that
// exe is Electron's own, which opens the app's folder given before the
// link. In an install it is the stub, as this exe is in a version
// folder the next update deletes.
export function registerScheme(): void {
  const scheme = rendererSchemeName(flavor);
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient(scheme, stubPath());
  } else {
    app.setAsDefaultProtocolClient(scheme, process.execPath, [
      app.getAppPath(),
    ]);
  }
}

// Launch at login, by the stub.
export function setLoginItem(openAtLogin: boolean): void {
  app.setLoginItemSettings({ openAtLogin, path: stubPath() });
}

const startMenu = () =>
  path.join(app.getPath("appData"), "Microsoft\\Windows\\Start Menu\\Programs");

// Squirrel's shortcuts by its names for their places: the app's name,
// in a Start menu folder named for the exe's company (forge.config.ts).
const shortcuts = () => ({
  Desktop: path.join(app.getPath("desktop"), `${names.appName}.lnk`),
  StartMenu: path.join(startMenu(), APP_REPO_OWNER, `${names.appName}.lnk`),
});

// The Start menu shortcut Electron keeps beside Squirrel's for its
// notifications, and the COM class it names, which Windows starts the
// app by when a notification is clicked.
function removeNotificationShortcut(): void {
  const shortcut = path.join(startMenu(), `${names.appName}.lnk`);
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
      spawnSync(updateExe, [`--createShortcut=${exe}`]);
      registerScheme();
      return true;
    case "--squirrel-updated": {
      // Only the shortcuts still there, so one the user deleted stays
      // deleted.
      const kept = Object.entries(shortcuts())
        .filter(([, file]) => existsSync(file))
        .map(([location]) => location);
      if (kept.length > 0) {
        spawnSync(updateExe, [
          `--createShortcut=${exe}`,
          `--shortcut-locations=${kept.join(",")}`,
        ]);
      }
      registerScheme();
      return true;
    }
    case "--squirrel-uninstall":
      spawnSync(updateExe, [`--removeShortcut=${exe}`]);
      removeNotificationShortcut();
      app.removeAsDefaultProtocolClient(scheme, stubPath());
      app.setLoginItemSettings({ openAtLogin: false });
      removeCliLaunchers(appPlace());
      return true;
    case "--squirrel-obsolete":
      return true;
    default:
      return false;
  }
}
