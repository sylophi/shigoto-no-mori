// Programmatic app restart (the data-folder move): renderer-initiated
// after its moveDataDir invoke resolves, so the reply is guaranteed
// delivered before the window goes away, with no timing guesses. A move
// asked for by another device has no renderer here to acknowledge it,
// so that one restarts a beat after answering (relaunchAppUnattended).
// The flag gives index.ts's before-quit handler the same fast path an
// update-install quit takes: scripts were already reaped by the move,
// so there is nothing to prompt about, and a busy dialog here could be
// cancelled, leaving a live app pointed at a data dir that no longer
// exists.
import { writeFileSync } from "node:fs";
import { app } from "electron";
import { DEV_RELAUNCH_FILE_ENV } from "@shared/packaging/appName.mts";
import { restoreUpdateEndpointOverrides } from "./updateEndpoints";

let requested = false;

// Under `pnpm dev` a relaunch cannot be app.relaunch(): forge exits
// with Electron and takes the vite server with it, and the detached
// copy would open on a dead renderer. The dev launcher
// (scripts/dev-electron.mts) hands over a marker path instead, and
// restarts forge when the app quits with the marker present.
const devRelaunchMarker = process.env[DEV_RELAUNCH_FILE_ENV];

// Record that a relaunch is in flight WITHOUT initiating the quit. The
// data-folder move (relaunchApp) quits through Electron so its reply is
// delivered first. The fatal-recovery path in liveness.ts instead exits
// hard, but it still sets this flag so if before-quit does fire it takes
// index.ts's fast reap path rather than the busy-action prompt.
function markRelaunching(): void {
  requested = true;
}

// Arrange for the app to start again once this process is gone, by
// whichever mechanism this run has. Does not quit: the data-folder
// move quits through Electron (relaunchApp), the fatal-recovery path
// in liveness.ts exits hard on its own.
export function scheduleRelaunch(): void {
  markRelaunching();
  if (devRelaunchMarker !== undefined) {
    try {
      writeFileSync(devRelaunchMarker, "");
      return;
    } catch (error) {
      // A marker that cannot be written must not strand the app on a
      // data dir that has already moved: the plain relaunch is the
      // one that loses the vite server, not the one that loses data.
      console.warn(`[relaunch] could not write the dev marker: ${error}`);
    }
  }
  restoreUpdateEndpointOverrides();
  app.relaunch();
}

export function relaunchApp(): void {
  scheduleRelaunch();
  app.quit();
}

// How long a quit asked for by another device waits after its handler
// resolved. A peer's invoke is answered when the handler resolves, and
// quit tears the direct listener down before a queued frame can leave,
// so the quit trails the reply and the caller sees success instead of
// a dropped session. Shared with the updater's unattended install.
export const UNATTENDED_QUIT_DELAY_MS = 500;

// The relaunch is arranged at once and only the quit waits: a quit
// from this machine's own user inside the gap then still comes back
// up, as the peer was told it would, and takes before-quit's fast path.
export function relaunchAppUnattended(): void {
  if (requested) return;
  scheduleRelaunch();
  setTimeout(() => app.quit(), UNATTENDED_QUIT_DELAY_MS);
}

export function isRelaunching(): boolean {
  return requested;
}
