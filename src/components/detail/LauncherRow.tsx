import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useLaunch, useLauncherForProject } from "@/hooks/useLaunchers";
import { LauncherIcon } from "@/lib/launcherIcon";
import type { LauncherEntry, Worktree } from "@shared/schemas";

interface LauncherRowProps {
  worktree: Worktree;
}

export function LauncherRow({ worktree }: LauncherRowProps) {
  const { data, isLoading } = useLauncherForProject(worktree.projectId);
  const launch = useLaunch();
  const navigate = useNavigate();
  const entries = data?.entries ?? [];

  // Main owns the ⌘1..⌘9 ordering; we just signal which project is in scope
  // and dispatch on the launcherId main sends back. Splitting the unmount
  // disable into its own effect avoids a disabled flash on data refetches.
  useEffect(() => {
    void window.api.menu.setLaunchToolsEnabled(true, worktree.projectId);
  }, [data, worktree.projectId]);

  useEffect(() => {
    return () => {
      void window.api.menu.setLaunchToolsEnabled(false);
    };
  }, []);

  useEffect(() => {
    return window.api.nav.onLaunchById((launcherId) => {
      launch.mutate({
        projectId: worktree.projectId,
        worktreeId: worktree.id,
        launcherId,
      });
    });
  }, [launch, worktree.projectId, worktree.id]);

  if (isLoading) {
    return (
      <div
        className="flex flex-wrap items-center gap-2"
        aria-label="Detecting launchers"
      >
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-24" />
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          No tools detected and no custom tools configured.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void navigate({
              to: "/projects/$projectId/configure",
              params: { projectId: worktree.projectId },
            })
          }
        >
          Configure tools
        </Button>
      </div>
    );
  }

  const run = (entry: LauncherEntry) => {
    launch.mutate({
      projectId: worktree.projectId,
      worktreeId: worktree.id,
      launcherId: entry.id,
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {entries.map((entry) => {
        const pending =
          launch.isPending && launch.variables?.launcherId === entry.id;
        return (
          <Button
            key={entry.id}
            variant="outline"
            size="sm"
            onClick={() => run(entry)}
          >
            {pending ? (
              <Loader2 className="animate-spin" />
            ) : (
              <LauncherIcon entry={entry} />
            )}
            <span>{entry.label}</span>
          </Button>
        );
      })}
    </div>
  );
}
