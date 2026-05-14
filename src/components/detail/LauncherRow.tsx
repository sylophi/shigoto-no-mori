import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useLaunch, useLauncherForProject } from "@/hooks/useLaunchers";
import { useSelection } from "@/hooks/useSelection";
import { LauncherIcon } from "@/lib/launcherIcon";
import type { LauncherEntry, Worktree } from "@shared/schemas";

interface LauncherRowProps {
  worktree: Worktree;
}

export function LauncherRow({ worktree }: LauncherRowProps) {
  const { data, isLoading } = useLauncherForProject(worktree.projectId);
  const launch = useLaunch();
  const { beginConfigureProject } = useSelection();

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

  const entries = data?.entries ?? [];
  if (entries.length === 0) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          No tools detected and no custom tools configured.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => beginConfigureProject(worktree.projectId)}
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
    <div className="space-y-2">
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
      {launch.error && (
        <div className="text-xs text-destructive">{launch.error.message}</div>
      )}
    </div>
  );
}
