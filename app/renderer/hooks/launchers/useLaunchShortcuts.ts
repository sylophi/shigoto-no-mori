import { useEffect } from "react";
import type { LauncherEntry } from "@shared/schemas";
import { useLaunch } from "./useLaunchers";

interface LaunchTarget {
  projectId: string;
  id: string;
}

// ⌘1..⌘9 launch `target`'s tools while the caller holds them: the
// worktree page's launch row, or the palette for the worktree it has
// highlighted. The accelerators are the native menu's (main/electron/
// menu.ts), so one holder at a time. The caller ships exactly the
// entries it shows, in order, so a digit can't land on a tool other
// than the one drawn beside it. Undefined `target` lets go. Enabling
// rides the entries and letting go its own effect, so a refetch
// doesn't flash the menu off.
export function useLaunchShortcuts(
  target: LaunchTarget | undefined,
  entries: readonly LauncherEntry[] | undefined,
  onLaunch?: () => void,
) {
  const { mutate: launch } = useLaunch();
  const held = target !== undefined && entries !== undefined;

  useEffect(() => {
    if (!held) return;
    const menuEntries = entries.map((e) => ({ id: e.id, label: e.label }));
    void window.api.menu.setLaunchToolsEnabled(true, menuEntries);
  }, [held, entries]);

  useEffect(() => {
    if (!held) return;
    return () => {
      void window.api.menu.setLaunchToolsEnabled(false);
    };
  }, [held]);

  const projectId = target?.projectId;
  const worktreeId = target?.id;
  useEffect(() => {
    if (projectId === undefined || worktreeId === undefined) return;
    return window.api.nav.onLaunchById((launcherId) => {
      launch({ projectId, worktreeId, launcherId });
      onLaunch?.();
    });
  }, [launch, projectId, worktreeId, onLaunch]);
}
