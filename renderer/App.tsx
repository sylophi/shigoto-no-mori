import { useEffect } from "react";
import { RouterProvider } from "@tanstack/react-router";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorFallback } from "@/components/ErrorFallback";
import { AddProjectModal } from "@/components/AddProjectModal";
import { DevThemeHotkeys } from "@/components/DevThemeHotkeys";
import { ProjectLauncher } from "@/components/launcher/ProjectLauncher";
import { OverlaysProvider } from "@/hooks/ui/useOverlays";
import { DoubutsuProvider } from "@/hooks/ui/useDoubutsu";
import { ThemeProvider } from "@/hooks/ui/useTheme";
import { useWatchGitRefs } from "@/hooks/git/useBranches";
import { useWatchProjectUsage } from "@/hooks/projects/useProjects";
import { useWatchProjectPullRequests } from "@/hooks/projects/useProjectPullRequests";
import { useWatchWorktreePullRequests } from "@/hooks/worktrees/useWorktreePullRequest";
import { router } from "./router";

function AppErrorFallback({ error }: FallbackProps) {
  const err = error instanceof Error ? error : new Error(String(error));
  return (
    <ErrorFallback
      error={err}
      scope="app"
      action={{
        label: "Reload window",
        onClick: () => window.location.reload(),
      }}
    />
  );
}

// Convention: IPC broadcasts that drive query invalidations live in
// useWatch* hooks next to the queries they affect. App.tsx is the single
// place they get called -- adding a new watcher is one import + one hook
// call here, with the actual subscribe/invalidate logic co-located with
// the query it owns.
export function App() {
  useWatchGitRefs();
  useWatchProjectUsage();
  useWatchWorktreePullRequests();
  useWatchProjectPullRequests();

  useEffect(
    () =>
      window.api.nav.onOpenSettings(() => {
        void router.navigate({ to: "/settings" });
      }),
    [],
  );

  // Picked from the menu bar popover. Selection in this app *is* the
  // router location, so "focus the app on this worktree" is a navigate;
  // main has already raised the window by the time this arrives.
  useEffect(
    () =>
      window.api.nav.onOpenWorktree(({ projectId, worktreeId }) => {
        void router.navigate({
          to: "/projects/$projectId/worktrees/$worktreeId",
          params: { projectId, worktreeId },
        });
      }),
    [],
  );

  useEffect(
    () =>
      window.api.nav.onNewWorktree(({ projectId }) => {
        void router.navigate({
          to: "/projects/$projectId/new",
          params: { projectId },
        });
      }),
    [],
  );

  return (
    <ThemeProvider>
      <DoubutsuProvider>
        <ErrorBoundary FallbackComponent={AppErrorFallback}>
          <OverlaysProvider>
            <TooltipProvider>
              <RouterProvider router={router} />
              <ProjectLauncher />
              <AddProjectModal />
              <DevThemeHotkeys />
            </TooltipProvider>
          </OverlaysProvider>
        </ErrorBoundary>
      </DoubutsuProvider>
    </ThemeProvider>
  );
}
