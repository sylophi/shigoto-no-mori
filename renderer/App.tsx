import { RouterProvider } from "@tanstack/react-router";
import { ErrorBoundary } from "react-error-boundary";
import { AppErrorFallback } from "@/components/AppChrome";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DevThemeHotkeys } from "@/components/DevThemeHotkeys";
import { OverlaysProvider } from "@/hooks/ui/useOverlays";
import { DoubutsuProvider } from "@/hooks/ui/useDoubutsu";
import { ThemeProvider } from "@/hooks/ui/useTheme";
import { useWatchGitRefs } from "@/hooks/git/useBranches";
import { useWatchProjectUsage } from "@/hooks/projects/useProjects";
import { useWatchPortForwards } from "@/hooks/remote/usePortForwards";
import { useWatchProjectPullRequests } from "@/hooks/projects/useProjectPullRequests";
import { useWatchWorktreePullRequests } from "@/hooks/worktrees/useWorktreePullRequest";
import { hasLocalHost } from "@/lib/localHost";
import type { AppRouter } from "./router";

// The provider tree around the router, one for both shells.
export function App({ router }: { router: AppRouter }) {
  return (
    <ThemeProvider>
      <DoubutsuProvider>
        <ErrorBoundary FallbackComponent={AppErrorFallback}>
          <OverlaysProvider>
            <TooltipProvider>
              {hasLocalHost && <LocalHostWatchers />}
              <RouterProvider router={router} />
              <DevThemeHotkeys />
            </TooltipProvider>
          </OverlaysProvider>
        </ErrorBoundary>
      </DoubutsuProvider>
    </ThemeProvider>
  );
}

// Convention: IPC broadcasts that drive query invalidations live in
// useWatch* hooks next to the queries they affect, and this is the
// single place they get called -- adding a new watcher is one import +
// one hook call here, with the actual subscribe/invalidate logic
// co-located with the query it owns. They watch this machine's
// broadcasts, which a hostless client's bridge never emits, so it
// does not mount them.
function LocalHostWatchers() {
  useWatchGitRefs();
  useWatchProjectUsage();
  useWatchPortForwards();
  useWatchWorktreePullRequests();
  useWatchProjectPullRequests();
  return null;
}
