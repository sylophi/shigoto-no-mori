// Every checkout of a repo on every device, by branch: which worktree,
// where, holds each branch of a stack. This machine's checkout is
// matched by repo identity like the sidebar's merged tree does, and
// the peers' come off the always-mounted forests, so the page adds no
// listing of its own. The local project is read through the local
// registry directly rather than the host scope: under a peer's page
// the scope IS that peer, and its worktrees already arrive with the
// forests.
import { useQuery } from "@tanstack/react-query";
import type { Worktree } from "@shared/schemas";
import type { SidebarDeviceBadge } from "@/components/sidebar/DeviceBadge";
import { deviceBadgeOf } from "@/components/sidebar/buildSidebarRows";
import {
  projectsQueryOptions,
  useProjects,
} from "@/hooks/projects/useProjects";
import { useRemoteForests } from "@/hooks/remote/useRemoteForests";
import { worktreesQueryOptions } from "@/hooks/worktrees/useWorktrees";
import { hasLocalHost } from "@/lib/localHost";
import { localDeviceId } from "@/lib/queryKeys";

export interface BranchHolder {
  deviceId: string;
  projectId: string;
  worktree: Worktree;
  // Null for this machine, which wears no badge.
  badge: SidebarDeviceBadge | null;
}

const LOCAL_SCOPE = { deviceId: localDeviceId, api: window.api };

// `projectId` is the page's project under the current host scope.
export function useWorktreesByBranch(
  projectId: string,
): ReadonlyMap<string, BranchHolder[]> {
  const { data: scopedProjects } = useProjects();
  const identity =
    scopedProjects?.find((project) => project.id === projectId)?.identity ??
    null;
  const { data: localProjects } = useQuery({
    ...projectsQueryOptions(LOCAL_SCOPE),
    enabled: hasLocalHost,
  });
  const localProject =
    localProjects?.find(
      (candidate) =>
        candidate.pathExists !== false &&
        (candidate.id === projectId ||
          (identity !== null && candidate.identity === identity)),
    ) ?? null;
  const { data: localWorktrees } = useQuery(
    worktreesQueryOptions(localProject?.id ?? null, LOCAL_SCOPE),
  );
  const { items } = useRemoteForests();

  const byBranch = new Map<string, BranchHolder[]>();
  const add = (holder: BranchHolder) => {
    if (holder.worktree.detached) return;
    const list = byBranch.get(holder.worktree.branch);
    if (list) list.push(holder);
    else byBranch.set(holder.worktree.branch, [holder]);
  };
  if (localProject) {
    for (const worktree of localWorktrees ?? []) {
      add({
        deviceId: localDeviceId,
        projectId: localProject.id,
        worktree,
        badge: null,
      });
    }
  }
  for (const item of items) {
    const same =
      item.project.id === projectId ||
      (identity !== null && item.project.identity === identity);
    if (!same) continue;
    const badge = deviceBadgeOf(item);
    for (const worktree of item.worktrees) {
      add({
        deviceId: item.deviceId,
        projectId: item.project.id,
        worktree,
        badge,
      });
    }
  }
  return byBranch;
}
