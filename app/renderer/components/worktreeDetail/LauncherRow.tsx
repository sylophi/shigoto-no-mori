import { Loader2 } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useLaunch,
  useLauncherForProject,
} from "@/hooks/launchers/useLaunchers";
import { LauncherIconView } from "@/components/shared/LauncherIconView";
import { useLaunchShortcuts } from "@/hooks/launchers/useLaunchShortcuts";
import { useOverlays } from "@/hooks/ui/useOverlays";
import { useProjectNav } from "@/hooks/projects/useProjectNav";
import type { LauncherEntry, Worktree } from "@shigomori/contracts/schemas";
import {
  LAUNCH_TAB,
  selectSettingsTab,
} from "@/components/settings/settingsNav";

interface LauncherRowProps {
  worktree: Worktree;
}

export function LauncherRow({ worktree }: LauncherRowProps) {
  const { data, isLoading } = useLauncherForProject(worktree.projectId);
  const launch = useLaunch();
  const navigate = useNavigate();
  const { toProjectPage } = useProjectNav();
  const entries = data?.entries ?? [];

  // The visible row is the single source of truth for ⌘1..⌘9 ordering.
  // The palette takes them for its highlighted worktree while it is up.
  const { paletteOpen } = useOverlays();
  useLaunchShortcuts(paletteOpen ? undefined : worktree, data?.entries);

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

  // Everything the user could launch is switched off in Settings, so point
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
          onClick={() => {
            selectSettingsTab(LAUNCH_TAB);
            void navigate({ to: "/settings" });
          }}
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
          onClick={() => toProjectPage("configure", worktree.projectId)}
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
              <LauncherIconView entry={entry} />
            )}
            <span>{entry.label}</span>
          </Button>
        );
      })}
    </div>
  );
}
