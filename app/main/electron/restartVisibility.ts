// A window the user hid (Cmd-H) or minimized stays that way across a
// restart the user didn't ask for: an update install, a relaunch, a
// crash relaunch, or a logout or reboot the login item brings it back
// from. The quit leaves a marker in userData and the next boot takes
// it. A quit the user made leaves none, so opening the app by hand
// always shows it. macOS only.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, powerMonitor } from "electron";
import * as Schema from "effect/Schema";
import { errorMessageOf } from "@shigomori/contracts/errors";
import { log } from "@shared/log";
import {
  atomicWriteJsonSync,
  readJsonOrNullSync,
} from "@host/lib/util/atomicJson";

const RestartVisibilitySchema = Schema.Struct({
  hidden: Schema.Boolean,
  minimized: Schema.Boolean,
});
export type RestartVisibility = typeof RestartVisibilitySchema.Type;

function warn(what: string, error: unknown): void {
  log.warn(`[restartVisibility] ${what}: ${errorMessageOf(error)}`);
}

function markerPath(): string {
  return join(app.getPath("userData"), "restartVisibility.json");
}

// Never throws: it runs right before a quit or a crash exit, on paths
// that must carry on. Called from before-quit's update and relaunch
// path in index.ts, and from the crash relaunch in liveness.ts, which
// exits without a before-quit.
export function rememberVisibilityForRestart(): void {
  if (process.platform !== "darwin") return;
  try {
    const visibility: RestartVisibility = {
      hidden: app.isHidden(),
      minimized: BrowserWindow.getAllWindows().some((window) =>
        window.isMinimized(),
      ),
    };
    if (!visibility.hidden && !visibility.minimized) return;
    atomicWriteJsonSync(markerPath(), visibility);
  } catch (error) {
    warn("could not write the marker", error);
  }
}

// A logout or reboot the login item brings the app back from. Without
// a login item nothing does, and a hidden or minimized start on the
// user's own launch later would be wrong. macOS only: on Linux a
// shutdown listener takes a systemd inhibitor lock.
export function rememberVisibilityAtShutdown(): void {
  if (process.platform !== "darwin") return;
  powerMonitor.on("shutdown", () => {
    if (app.getLoginItemSettings().openAtLogin) rememberVisibilityForRestart();
  });
}

// Once per marker, so only the first boot after the restart applies
// it. Never throws: the boot window is created from what it returns.
export function takeRestartVisibility(): RestartVisibility | null {
  if (process.platform !== "darwin") return null;
  const path = markerPath();
  let visibility: RestartVisibility | null = null;
  try {
    visibility = readJsonOrNullSync(path, RestartVisibilitySchema);
  } catch (error) {
    warn("could not read the marker", error);
  }
  try {
    rmSync(path, { force: true });
  } catch (error) {
    warn("could not remove the marker", error);
  }
  return visibility;
}

// For a window created unshown, so it is never on screen before it
// goes away. A minimized one goes straight to the Dock, and a Dock
// click restores it. A hidden one appears when the user brings the app
// back (Dock, Cmd-Tab).
export function applyRestartVisibility(
  window: BrowserWindow,
  { hidden, minimized }: RestartVisibility,
): void {
  if (hidden) app.hide();
  if (minimized) {
    window.minimize();
    return;
  }
  app.once("did-become-active", () => {
    if (!window.isDestroyed()) window.show();
  });
}
