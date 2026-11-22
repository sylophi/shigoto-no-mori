// A Velopack install: <root>\Update.exe, and this exe in <root>\current\,
// which every update replaces in place. What Windows keeps a path to
// (the scheme, the login item, the firewall's answer) names this exe.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { app, shell } from "electron";
import { removeCliLaunchers } from "@shared/cliLaunchers";
import { rendererSchemeName } from "@shared/packaging/rendererScheme.mts";
import { flavor, names } from "../flavor";
import { appPlace } from "./appPlace";

// The renderer's scheme, which the Clerk bridge (clerk.ts) registers to
// this exe alone. In a dev run that exe is Electron's own, which opens
// the app's folder given before the link.
export function registerScheme(): void {
  const scheme = rendererSchemeName(flavor);
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient(scheme);
  } else {
    app.setAsDefaultProtocolClient(scheme, process.execPath, [
      app.getAppPath(),
    ]);
  }
}

// The Start menu shortcut Electron keeps for its notifications, and the
// COM class it names, which Windows starts the app by when a
// notification is clicked.
function removeNotificationShortcut(): void {
  const shortcut = path.join(
    app.getPath("appData"),
    "Microsoft\\Windows\\Start Menu\\Programs",
    `${names.appName}.lnk`,
  );
  if (!existsSync(shortcut)) return;
  const clsid = shell.readShortcutLink(shortcut).toastActivatorClsid;
  // Without a class to name, the delete would take every class the
  // user has.
  if (clsid) {
    spawnSync("reg", [
      "delete",
      `HKCU\\Software\\Classes\\CLSID\\${clsid}`,
      "/f",
    ]);
  }
  rmSync(shortcut);
}

// A Squirrel.Windows install moved to Velopack by Squirrel's own update
// starts this first Velopack version from Squirrel's app-<version>
// folder, and only then copies Velopack's Update.exe (this version's
// Squirrel.exe) over its own. Velopack's start, once that copy is in,
// moves the install to current\ and starts the app from there. True
// when this start handed over to it.
export function movedToVelopack(): boolean {
  const folder = path.dirname(process.execPath);
  if (!app.isPackaged || !path.basename(folder).startsWith("app-")) {
    return false;
  }
  const velopack = readFileSync(path.join(folder, "Squirrel.exe"));
  const updateExe = path.join(folder, "..", "Update.exe");
  const copied = () => {
    try {
      return velopack.equals(readFileSync(updateExe));
    } catch {
      return false;
    }
  };
  for (let tries = 0; !copied(); tries++) {
    if (tries === 20) return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  spawn(updateExe, ["start"], { detached: true, stdio: "ignore" }).unref();
  return true;
}

// Velopack starts the app with one of its hooks as it installs,
// updates or uninstalls it, and waits for it to exit. It makes and
// removes the shortcuts itself. Squirrel.Windows starts the first
// Velopack version with its own as it moves the install over. True when
// this start is one of them.
export function handledInstallHook(): boolean {
  const hook = process.argv[1] ?? "";
  if (hook === "--veloapp-uninstall") {
    removeNotificationShortcut();
    app.removeAsDefaultProtocolClient(rendererSchemeName(flavor));
    app.setLoginItemSettings({ openAtLogin: false });
    removeCliLaunchers(appPlace());
  }
  return hook.startsWith("--veloapp-") || hook.startsWith("--squirrel-");
}
