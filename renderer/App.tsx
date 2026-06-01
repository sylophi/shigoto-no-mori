import { useEffect } from "react";
import { RouterProvider } from "@tanstack/react-router";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorFallback } from "@/components/ErrorFallback";
import { CommandPalette } from "@/components/CommandPalette";
import { CommandPaletteProvider } from "@/hooks/ui/useCommandPalette";
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
