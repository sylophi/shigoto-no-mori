// A data-folder move that failed after the host let go of the folder:
// the app runs on without its loopback and store watch, so it says what
// failed and offers one way on, a restart, which finds everything where
// it was. The dialog has no other way out on macOS (Esc answers no
// one-button alert there). Where it can be dismissed, the app quits,
// the hurried way, so no busy prompt can keep that app running.
import { app, dialog } from "electron";
import { relaunchApp } from "./relaunch";

const RESTART = 0;
let quittingAfterFailedMove = false;

// A quit that asks about no busy work: the app it ends can't do any.
export function isQuittingAfterFailedMove(): boolean {
  return quittingAfterFailedMove;
}

export function showMoveFailed(reason: string): void {
  void dialog
    .showMessageBox({
      type: "error",
      message: "Couldn't move the data folder",
      detail: `${reason}\n\nThe data folder is still where it was. Restart the app to carry on with it there.`,
      buttons: ["Restart"],
      defaultId: RESTART,
      // No such button: a dismissal answers it, where there is one.
      cancelId: RESTART + 1,
      noLink: true,
    })
    .then(({ response }) => {
      if (response === RESTART) {
        relaunchApp();
        return;
      }
      quittingAfterFailedMove = true;
      app.quit();
    });
}
