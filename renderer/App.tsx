import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorFallback } from "@/components/ErrorFallback";
import { CommandPalette } from "@/components/CommandPalette";
import { CommandPaletteProvider } from "@/hooks/ui/useCommandPalette";
import { ThemeProvider } from "@/hooks/ui/useTheme";
import { invalidateBranchState } from "@/hooks/git/useBranches";
import { invalidateProjectPullRequests } from "@/hooks/projects/useProjectPullRequests";
import { invalidateAllWorktreePullRequests } from "@/hooks/worktrees/useWorktreePullRequest";
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

export function App() {
  const queryClient = useQueryClient();

  useEffect(
    () =>
      window.api.nav.onOpenSettings(() => {
        void router.navigate({ to: "/settings" });
      }),
    [],
  );

  useEffect(
    () =>
      window.api.git.onRefsRefreshed(({ projectId }) => {
        invalidateBranchState(queryClient, projectId);
        // Refs moving usually means PR state moved too (merge landed,
        // head pushed). Sidebar dots wait for the sweep instead.
        invalidateAllWorktreePullRequests(queryClient);
      }),
    [queryClient],
  );

  useEffect(
    () =>
      window.api.window.onFocused(() => {
        invalidateAllWorktreePullRequests(queryClient);
      }),
    [queryClient],
  );

  useEffect(
    () =>
      window.api.githubCli.onProjectPullRequestsRefreshed(({ projectId }) => {
        invalidateProjectPullRequests(queryClient, projectId);
      }),
    [queryClient],
  );

  return (
    <ThemeProvider>
      <ErrorBoundary FallbackComponent={AppErrorFallback}>
        <CommandPaletteProvider>
          <TooltipProvider>
            <RouterProvider router={router} />
            <CommandPalette />
          </TooltipProvider>
        </CommandPaletteProvider>
      </ErrorBoundary>
    </ThemeProvider>
  );
}
