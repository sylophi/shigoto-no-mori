// Native confirmation when the user tries to quit or restart-to-update
// while scripts or worktree removals are in flight on the host. The
// counts come from the host (its session's `busy`), read again while the
// prompt is up (core/host/busyPrompt.ts), the words from shared/busy.ts.
import { BrowserWindow, dialog } from "electron";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  BUSY_COPY,
  type BusyAction,
  type BusyOperations,
  busyDetail,
} from "@shared/busy";
import { followBusy } from "../core/host/busyPrompt";
import { hostBusy, hostBusyAgain } from "../hostProcess";

function parentWindow(): BrowserWindow | undefined {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) return w;
  }
  return undefined;
}

// Whether to go ahead: at once when nothing is running, else as the
// user answers, or once what was running is done.
export function confirmBusyAction(action: BusyAction): Promise<boolean> {
  const copy = BUSY_COPY[action];
  const words = (busy: BusyOperations) => busyDetail(busy, action);
  return followBusy({
    detail: async () => words(await Effect.runPromise(hostBusy(true))),
    again: async () =>
      Option.map(await Effect.runPromise(hostBusyAgain()), words),
    show: async (detail, signal) => {
      const opts = {
        type: "warning" as const,
        buttons: ["Cancel", copy.proceed],
        defaultId: 0,
        cancelId: 0,
        message: copy.message,
        detail,
        signal,
      };
      const parent = parentWindow();
      const result = parent
        ? await dialog.showMessageBox(parent, opts)
        : await dialog.showMessageBox(opts);
      return result.response === 1;
    },
    every: 1000,
  });
}
