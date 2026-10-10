import { fillRoutePath, WORKTREE_ROUTE_PATHS } from "@/lib/routePaths";
import { notifyError } from "@/lib/toast";

// Another window of the app on a worktree's page, on whichever device
// it lives (main/electron/windows.ts). Desktop only: a browser tab is
// already one of as many as the user opens.
export function openWorktreeInNewWindow(target: {
  readonly deviceId: string;
  readonly projectId: string;
  readonly worktreeId: string;
}): void {
  window.api.window
    .open({ route: fillRoutePath(WORKTREE_ROUTE_PATHS.detail, target) })
    .catch((err: unknown) => notifyError("Couldn't open a new window", err));
}
