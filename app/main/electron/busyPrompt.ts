// Native confirmation when the user tries to quit or restart-to-update
// while scripts or worktree removals are in flight on the host. The
// counts come from the host (its session's `busy`), the words from
// shared/busy.ts.
import { BrowserWindow, dialog } from "electron";
import {
  BUSY_COPY,
  type BusyAction,
  type BusyOperations,
  busyDetail,
} from "@shared/busy";

function parentWindow(): BrowserWindow | undefined {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) return w;
  }
  return undefined;
}

// Whether to go ahead: at once when nothing is running, else as the
// user answers.
export async function confirmBusyAction(
  action: BusyAction,
  busy: BusyOperations,
): Promise<boolean> {
  const detail = busyDetail(busy, action);
  if (detail === null) return true;
  const copy = BUSY_COPY[action];
  const opts = {
    type: "warning" as const,
    buttons: ["Cancel", copy.proceed],
    defaultId: 0,
    cancelId: 0,
    message: copy.message,
    detail,
  };
  const parent = parentWindow();
  const result = parent
    ? await dialog.showMessageBox(parent, opts)
    : await dialog.showMessageBox(opts);
  return result.response === 1;
}
