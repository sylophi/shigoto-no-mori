import { useEffect } from "react";
import { Layers, Loader2 } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useLaunchSet } from "@/hooks/launchers/useLaunchSet";
import {
  useLaunch,
  useLauncherForProject,
} from "@/hooks/launchers/useLaunchers";
import { useShigomoriConfig } from "@/hooks/config/useShigomoriConfig";
import { LauncherIcon } from "@/components/LauncherIcon";
import {
  launchSetIdFromMenuId,
  launchSetMenuId,
  type LauncherEntry,
  type LaunchSet,
  type Worktree,
} from "@shared/schemas";

interface LauncherRowProps {
  worktree: Worktree;
}

// Sets with no members are dropped on save, but a config edited by hand
// can still carry one, and an empty pill would launch nothing.
function usableSets(sets: LaunchSet[] | undefined): LaunchSet[] {
  return (sets ?? []).filter((s) => s.launcherIds.length > 0);
}

export function LauncherRow({ worktree }: LauncherRowProps) {
  const { data, isLoading } = useLauncherForProject(worktree.projectId);
  const { data: config } = useShigomoriConfig(worktree.projectId);
  const launch = useLaunch();
  const launchSet = useLaunchSet();
  const navigate = useNavigate();
  const entries = data?.entries ?? [];
  const launchSets = config?.launchSets;
  const sets = usableSets(launchSets);

  const runSet = (set: LaunchSet) => {
    launchSet.mutate({
      projectId: worktree.projectId,
      worktreeId: worktree.id,
      set,
      labelFor: (id) => data?.entries.find((e) => e.id === id)?.label,
    });
  };

  // The visible row is the single source of truth for ⌘1..⌘9 ordering:
  // we ship exactly what we're rendering up to main, so the menu can never
  // shuffle out from under the buttons. Set pills come last so adding one
  // never renumbers a shortcut the user already has in their fingers --
  // they take whatever slots the launchers leave. Splitting the unmount
  // disable into its own effect avoids a disabled flash on data refetches.
  useEffect(() => {
    if (!data) return;
    const menuEntries = [
      ...data.entries.map((e) => ({ id: e.id, label: e.label })),
      ...usableSets(launchSets).map((s) => ({
        id: launchSetMenuId(s.id),
        label: s.label,
      })),
    ];
    void window.api.menu.setLaunchToolsEnabled(true, menuEntries);
  }, [data, launchSets]);

  useEffect(() => {
    return () => {
      void window.api.menu.setLaunchToolsEnabled(false);
    };
  }, []);

  useEffect(() => {
    return window.api.nav.onLaunchById((menuId) => {
      const setId = launchSetIdFromMenuId(menuId);
      if (setId !== null) {
        // A set the config lost between building the menu and the
        // keystroke simply does nothing -- there's no command to run.
        const set = usableSets(launchSets).find((s) => s.id === setId);
        if (set) {
          launchSet.mutate({
            projectId: worktree.projectId,
            worktreeId: worktree.id,
            set,
            labelFor: (id) => data?.entries.find((e) => e.id === id)?.label,
          });
        }
        return;
      }
      launch.mutate({
        projectId: worktree.projectId,
        worktreeId: worktree.id,
        launcherId: menuId,
      });
    });
  }, [data, launch, launchSet, launchSets, worktree.projectId, worktree.id]);

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

      {sets.map((set) => {
        const pending =
          launchSet.isPending && launchSet.variables?.set.id === set.id;
        const members = set.launcherIds
          .map((id) => entries.find((e) => e.id === id)?.label ?? id)
          .join(", ");
        return (
          <Button
            key={set.id}
            variant="outline"
            size="sm"
            onClick={() => runSet(set)}
            title={`Launch ${members}`}
          >
            {pending ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Layers aria-hidden className="text-muted-foreground" />
            )}
            <span>{set.label}</span>
          </Button>
        );
      })}
    </div>
  );
}
