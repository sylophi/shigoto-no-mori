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

export function relaunchApp(): void {
  requested = true;
  app.relaunch();
  app.quit();
}

export function isRelaunching(): boolean {
  return requested;
}
