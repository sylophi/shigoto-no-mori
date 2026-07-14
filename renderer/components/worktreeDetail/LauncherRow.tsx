import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useLaunch,
  useLauncherForProject,
} from "@/hooks/launchers/useLaunchers";
import { LauncherIcon } from "@/components/LauncherIcon";
import type { LauncherEntry, Worktree } from "@shared/schemas";

interface LauncherRowProps {
  worktree: Worktree;
}

export function LauncherRow({ worktree }: LauncherRowProps) {
  const { data, isLoading } = useLauncherForProject(worktree.projectId);
  const launch = useLaunch();
  const navigate = useNavigate();
  const entries = data?.entries ?? [];

  // The visible row is the single source of truth for ⌘1..⌘9 ordering:
  // we ship exactly what we're rendering up to main, so the menu can never
  // shuffle out from under the buttons. Splitting the unmount disable into
  // its own effect avoids a disabled flash on data refetches.
  useEffect(() => {
    if (!data) return;
    const menuEntries = data.entries.map((e) => ({
      id: e.id,
      label: e.label,
    }));
    void window.api.menu.setLaunchToolsEnabled(true, menuEntries);
  }, [data]);

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

  // Everything the user could launch is switched off in Settings -- point
  // there rather than at project Configure, which has no visibility toggles.
  if (entries.length === 0 && (data?.hiddenCount ?? 0) > 0) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Every launch tool is hidden.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void navigate({ to: "/settings" })}
        >
          Choose tools
        </Button>
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
