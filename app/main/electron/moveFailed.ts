// A data-folder move that failed after the host let go of the folder:
// the app runs on without its loopback and store watch, so it says what
// failed and offers one way on, a restart, which finds everything where
// it was. Dismissing it (Esc) quits rather than leave that app running.
import { app, dialog } from "electron";
import { relaunchApp } from "./relaunch";

const RESTART = 0;

export function showMoveFailed(reason: string): void {
  void dialog
    .showMessageBox({
      type: "error",
      message: "Couldn't move the data folder",
      detail: `${reason}\n\nThe data folder is still where it was. Restart the app to carry on with it there.`,
      buttons: ["Restart"],
      defaultId: RESTART,
      // No button: Esc answers this, and quits.
      cancelId: RESTART + 1,
      noLink: true,
    })
    .then(({ response }) => {
      if (response === RESTART) relaunchApp();
      else app.quit();
    });
}
