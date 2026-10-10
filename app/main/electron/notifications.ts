// System notifications, for the renderer's agent notices
// (renderer/lib/agentWatch.ts), one for all the windows. A click opens the notification's
// page the way a deep link does, so main/index.ts hands in its opener.
import { BrowserWindow, Notification } from "electron";

let open: (route: string) => void = () => {};

export function setNotificationOpener(opener: (route: string) => void): void {
  open = opener;
}

// One per worktree (its route), held until clicked, closed or replaced:
// a notification the garbage collector takes loses its click handler
// while it still sits in the Notification Center, and a worktree's
// newer news supersedes its older one there.
const live = new Map<
  string,
  { readonly notification: Notification; readonly at: number }
>();
const SAME_NOTICE_MS = 5_000;

export function showNotification(input: {
  title: string;
  body: string;
  route: string;
}): void {
  if (!Notification.isSupported()) return;
  // A window asks only while it is not focused, but another may be: the
  // user is looking at the app.
  if (BrowserWindow.getFocusedWindow() !== null) return;
  // Every window watches the same agents, so each asks for the same
  // notice at about the same time: the first one shows it.
  const shown = live.get(input.route);
  if (
    shown !== undefined &&
    shown.notification.title === input.title &&
    shown.notification.body === input.body &&
    Date.now() - shown.at < SAME_NOTICE_MS
  ) {
    return;
  }
  shown?.notification.close();
  const notification = new Notification({
    title: input.title,
    body: input.body,
  });
  const forget = () => {
    if (live.get(input.route)?.notification === notification) {
      live.delete(input.route);
    }
  };
  live.set(input.route, { notification, at: Date.now() });
  notification.on("click", () => {
    forget();
    open(input.route);
  });
  notification.on("close", forget);
  notification.show();
}
