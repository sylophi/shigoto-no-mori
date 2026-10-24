import { defaultStringifySearch } from "@tanstack/react-router";
import { fillRoutePath, WORKTREE_ROUTE_PATHS } from "@/lib/routePaths";
import type { RendererApi } from "@/lib/runtime/pageApi";
import { notifyError } from "@/lib/toast";

// Another window of the app on a worktree's page, on whichever device
// it lives (main/electron/windows.ts). Desktop only: a browser tab is
// already one of as many as the user opens.
export function openWorktreeInNewWindow(
  api: WindowApi,
  target: WorktreeTarget,
): void {
  openWindow(api, fillRoutePath(WORKTREE_ROUTE_PATHS.detail, target));
}

// The terminals window's tabs: its script consoles, as their slots'
// params, and the tab picked.
export type TerminalsSearch = {
  readonly scripts?: readonly string[];
  readonly tab?: string;
};

// A worktree's terminals in a window of their own (TerminalsWindow).
export function openTerminalsInNewWindow(
  api: WindowApi,
  target: WorktreeTarget,
  tabs: TerminalsSearch,
): void {
  openWindow(
    api,
    fillRoutePath(WORKTREE_ROUTE_PATHS.terminals, target) +
      defaultStringifySearch(tabs),
  );
}

type WindowApi = Pick<RendererApi, "window" | "run">;

type WorktreeTarget = {
  readonly deviceId: string;
  readonly projectId: string;
  readonly worktreeId: string;
};

function openWindow(api: WindowApi, route: string): void {
  api
    .run(api.window.open({ route }))
    .catch((err: unknown) => notifyError("Couldn't open a new window", err));
}
