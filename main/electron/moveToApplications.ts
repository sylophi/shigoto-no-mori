// First-launch offer to move the bundle into Applications. A packaged
// app started from anywhere else can't install its own updates: the
// quarantine flag on a download makes macOS run it from a read-only
// App Translocation mount, and the updater resolves the bundle to swap
// from its own executable (cli/updater.go), so the swap fails against
// that mount for as long as the app stays where it landed.
//
// So ask once, at launch, while fixing it is one click. A decline is
// remembered in state.json: the offer is a one-time nudge, not a
// recurring nag.
import { app, dialog } from "electron";
import { readKey, writeKey } from "../lib/config/store";
import { isTranslocated } from "./cliInstall";

const OFFERED_KEY = "moveToApplicationsOffered";

let moving = false;

// A successful move relaunches the moved copy and terminates this one.
// index.ts's before-quit reaper has nothing to do on that path (this is
// a first launch, so no scripts are running) and must not stall the
// handoff or prompt about it, so it takes the same fast path an
// update-install quit takes.
export function isMovingToApplications(): boolean {
  return moving;
}

function offerDetail(): string {
  if (isTranslocated()) {
    return (
      "macOS is running this app from a temporary location (App " +
      "Translocation), so updates can't install. Moving it to " +
      "Applications fixes that."
    );
  }
  return (
    "Updates can only install when the app lives in Applications. " +
    "Moving it now takes a second."
  );
}

// Written for every answer, including a store that can't be written to:
// whatever happens, the user has now been asked, and each outcome
// leaves them with something they can act on themselves. Swallows its
// own failure so a bad config store can't turn into an unhandled
// rejection on the boot path.
function markOffered(): void {
  try {
    writeKey(OFFERED_KEY, true);
  } catch {
    // Best effort. Worst case the user is asked again next launch.
  }
}

// Returns true when this instance is on its way out: the app has been
// moved and the copy in Applications is relaunching, so the caller
// should stop booting.
export async function offerMoveToApplications(): Promise<boolean> {
  // A dev run's bundle is build output inside a checkout, where moving
  // it would break the checkout and mean nothing for updates.
  if (!app.isPackaged) return false;

  // Nothing in this block may reject: it runs on the boot path before
  // any window exists, so an uncaught rejection here (a location check
  // that throws, a dialog that throws, a store that can't be read or
  // written) would leave the app with no window and nothing on screen
  // to explain why.
  try {
    if (app.isInApplicationsFolder()) return false;
    if (readKey(OFFERED_KEY, false)) return false;

    const { response } = await dialog.showMessageBox({
      type: "question",
      buttons: ["Not Now", "Move to Applications"],
      defaultId: 1,
      cancelId: 0,
      message: "Move Shigoto no Mori to Applications?",
      detail: offerDetail(),
    });
    markOffered();
    if (response !== 1) return false;

    moving = true;
    let conflict: "exists" | "existsAndRunning" | null = null;
    try {
      // Decline the default conflict handling. It would trash the copy
      // already in Applications (or silently focus it and quit us), and
      // neither is something to do to a user who only agreed to a move.
      const moved = app.moveToApplicationsFolder({
        conflictHandler: (conflictType) => {
          conflict = conflictType;
          return false;
        },
      });
      if (moved) return true;
    } catch (err) {
      moving = false;
      dialog.showErrorBox(
        "Shigoto no Mori couldn't be moved to Applications",
        `${err instanceof Error ? err.message : String(err)}\n\n` +
          "Drag the app to your Applications folder in Finder and open " +
          "it from there, otherwise updates won't be able to install.",
      );
      return false;
    }
    moving = false;
    if (conflict !== null) {
      dialog.showErrorBox(
        "Shigoto no Mori is already in Applications",
        "This copy was left where it is. Open the one in Applications " +
          "and drag this copy to the Trash.",
      );
    }
    // A false return with no conflict is the user cancelling the macOS
    // authorization prompt, which they just saw and dismissed. Nothing to
    // report back to them.
    return false;
  } catch {
    // The location check or the dialog failed, or the store couldn't
    // be read from or written to. Nothing left to offer this launch;
    // mark it offered (best effort) and let boot continue.
    moving = false;
    markOffered();
    return false;
  }
}
