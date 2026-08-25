// Programmatic app restart (the data-folder move): renderer-initiated
// after its moveRoot invoke resolves, so the reply is guaranteed
// delivered before the window goes away -- no timing guesses. The flag
// gives index.ts's before-quit handler the same fast path an
// update-install quit takes: scripts were already reaped by the move,
// so there is nothing to prompt about, and a busy dialog here could be
// cancelled -- leaving a live app pointed at a root that no longer
// exists.
import { app } from "electron";

let requested = false;

// Record that a relaunch is in flight WITHOUT initiating the quit. The
// data-folder move (relaunchApp) quits through Electron so its reply is
// delivered first. The fatal-recovery path in liveness.ts instead exits
// hard, but it still sets this flag so if before-quit does fire it takes
// index.ts's fast reap path rather than the busy-action prompt.
export function markRelaunching(): void {
  requested = true;
}

export function relaunchApp(): void {
  markRelaunching();
  app.relaunch();
  app.quit();
}

export function isRelaunching(): boolean {
  return requested;
}
