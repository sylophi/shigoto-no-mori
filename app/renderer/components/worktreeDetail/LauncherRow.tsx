import { useNavigate } from "@tanstack/react-router";
import {
  useLaunch,
  useLauncherForProject,
} from "@/hooks/launchers/useLaunchers";
import { useLaunchShortcuts } from "@/hooks/launchers/useLaunchShortcuts";
import { useOverlays } from "@/hooks/ui/useOverlays";
import { useProjectNav } from "@/hooks/projects/useProjectNav";
import type { Worktree } from "@shared/schemas";
import {
  LAUNCH_TAB,
  selectSettingsTab,
} from "@/components/settings/settingsNav";
import { LauncherRowView } from "./LauncherRowView";

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

  return (
    <LauncherRowView
      entries={entries}
      loading={isLoading}
      hiddenCount={data?.hiddenCount ?? 0}
      pendingId={launch.isPending ? launch.variables?.launcherId : undefined}
      onLaunch={(entry) =>
        launch.mutate({
          projectId: worktree.projectId,
          worktreeId: worktree.id,
          launcherId: entry.id,
        })
      }
      onChooseTools={() => {
        selectSettingsTab(LAUNCH_TAB);
        void navigate({ to: "/settings" });
      }}
      onConfigureTools={() => toProjectPage("configure", worktree.projectId)}
    />
  );
}
