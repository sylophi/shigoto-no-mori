// The launch tools for the worktree (LauncherRowView), the keymap's
// launch tools (⌘1..⌘9) included.
import { useNavigate } from "@tanstack/react-router";
import { selectSettingsTab } from "@/components/settings/settingsNav";
import { LAUNCH_TAB } from "@shigomori/ui/views/settings/settingsSections.ts";
import {
  useLaunch,
  useLauncherForProject,
} from "@/hooks/launchers/useLaunchers";
import { useLaunchShortcuts } from "@/hooks/launchers/useLaunchShortcuts";
import { useProjectNav } from "@/hooks/projects/useProjectNav";
import { useKeymap } from "@/hooks/ui/useKeymap";
import { useOverlays } from "@/hooks/ui/useOverlays";
import type { Worktree } from "@shigomori/contracts/schemas";
import { LauncherRowView } from "@shigomori/ui/views/worktreeDetail/LauncherRowView.tsx";

export function LauncherRow({ worktree }: { worktree: Worktree }) {
  const { data, isLoading } = useLauncherForProject(worktree.projectId);
  const launch = useLaunch();
  const navigate = useNavigate();
  const { toProjectPage } = useProjectNav();
  const keymap = useKeymap();

  // The visible row is the single source of truth for the launch tools'
  // order. The palette takes them for its highlighted worktree while it
  // is up.
  const { paletteOpen } = useOverlays();
  useLaunchShortcuts(paletteOpen ? undefined : worktree, data?.entries);

  return (
    <LauncherRowView
      entries={isLoading ? undefined : (data?.entries ?? [])}
      allHidden={(data?.hiddenCount ?? 0) > 0}
      pendingId={launch.isPending ? launch.variables?.launcherId : undefined}
      keys={data?.entries.map(
        (_, i) => keymap.get(`launchTool${i + 1}`)?.label,
      )}
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
      onConfigure={() => toProjectPage("configure", worktree.projectId)}
    />
  );
}
