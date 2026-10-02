// The tree's two levels: the list of projects, and one project on its
// own. Picking a project off the list leaves the tree showing that
// project alone, its worktrees under its name, and Projects (the
// toolbar's way back) returns to the list. So there is always one thing
// to look at: which project, or what is in this one.
//
// The open project is kept by group key (projectGroupKey), one per
// repo, so narrowed to a peer that also holds the repo the same project
// stays open. A module store rather than sidebar state, like the device
// filter: the phone layout unmounts the forest between its tabs, and
// coming back should find the same project open. Session-only, since
// the project of the page on screen opens on its own (below).
import { useEffect } from "react";
import { useParams } from "@tanstack/react-router";
import type { Project } from "@shared/schemas";
import type { RemoteForestItem } from "@/hooks/remote/useRemoteForests";
import { rowDeviceId } from "@/lib/routePaths";
import { createExternalStore, useExternalStore } from "@/store/externalStore";
import { projectGroupKey } from "./buildSidebarRows";

const store = createExternalStore<{
  // Null on the list.
  key: string | null;
  // The page whose project was last opened for it, so each page is
  // followed once. Beside the key rather than in a component, so a
  // forest that remounts under the same page does not follow it again.
  followed: string | null;
}>({ key: null, followed: null });

// Null goes back to the list.
export function setOpenProject(groupKey: string | null): void {
  const { key, followed } = store.get();
  if (key !== groupKey) store.publish({ key: groupKey, followed });
}

// The open project, following the page on screen: the project a page
// belongs to opens on its own, wherever the page was opened from (⌘K,
// the inbox, a web link). Once per page, so going back to the list,
// or into another project, while the page stays up is not undone.
//
// The answer is worked out in render and the store catches up after, so
// a web page that loads on a worktree paints inside its project rather
// than on the list for a frame. Whoever is mounted while a page is up
// has to call this for the follow to happen: the forest itself on a
// wide layout, and the phone layout's keepalive (AppShell), where the
// forest is a tab that a worktree's page replaces.
export function useOpenProject(
  projects: readonly Project[],
  remote: readonly RemoteForestItem[],
): {
  openKey: string | null;
  // The group key of the project the page on screen belongs to.
  // Undefined off a project's pages, and until the project is listed.
  onScreenKey: string | undefined;
} {
  const { key, followed } = useExternalStore(store);
  // One selected value per param, so stepping through a worktree's
  // commits or consoles re-renders nobody here.
  const deviceId = useParams({ strict: false, select: (p) => p.deviceId });
  const projectId = useParams({ strict: false, select: (p) => p.projectId });
  const worktreeId = useParams({ strict: false, select: (p) => p.worktreeId });
  const page =
    deviceId === undefined || projectId === undefined
      ? null
      : `${deviceId}:${projectId}:${worktreeId ?? ""}`;
  const onScreenKey = groupKeyOnScreen(deviceId, projectId, projects, remote);
  // Waits, render after render, for the page's project to be listed.
  const following =
    page !== null && page !== followed && onScreenKey !== undefined;
  useEffect(() => {
    if (following) store.publish({ key: onScreenKey, followed: page });
    // Off the project's pages, the next visit to one is a new page.
    else if (page === null && followed !== null) {
      store.publish({ key, followed: null });
    }
  });
  return { openKey: following ? onScreenKey : key, onScreenKey };
}

function groupKeyOnScreen(
  deviceId: string | undefined,
  projectId: string | undefined,
  projects: readonly Project[],
  remote: readonly RemoteForestItem[],
): string | undefined {
  if (deviceId === undefined || projectId === undefined) return undefined;
  const peer = rowDeviceId(deviceId);
  if (peer === undefined) {
    const project = projects.find((p) => p.id === projectId);
    return project && projectGroupKey(project, undefined);
  }
  const item = remote.find(
    (i) => i.deviceId === peer && i.project.id === projectId,
  );
  return item && projectGroupKey(item.project, peer);
}
