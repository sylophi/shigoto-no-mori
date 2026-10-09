// System notifications, for the renderer's agent notices
// (renderer/lib/agentWatch.ts). A click opens the notification's
// page the way a deep link does, so main/index.ts hands in its opener.
import { Notification } from "electron";

let open: (route: string) => void = () => {};

export function setNotificationOpener(opener: (route: string) => void): void {
  open = opener;
}

// One per worktree (its route), held until clicked, closed or replaced:
// a notification the garbage collector takes loses its click handler
// while it still sits in the Notification Center, and a worktree's
// newer news supersedes its older one there.
const live = new Map<string, Notification>();

export function showNotification(input: {
  title: string;
  body: string;
  route: string;
}): void {
  if (!Notification.isSupported()) return;
  live.get(input.route)?.close();
  const notification = new Notification({
    title: input.title,
    body: input.body,
  });
  const forget = () => {
    if (live.get(input.route) === notification) live.delete(input.route);
  };
  live.set(input.route, notification);
  notification.on("click", () => {
    forget();
    open(input.route);
  });
  notification.on("close", forget);
  notification.show();
}
