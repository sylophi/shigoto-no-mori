import type { RemoteForestItem } from "@/hooks/remote/useRemoteForests";
import type { Project } from "@shared/schemas";
import { deviceBadgeOf } from "../buildSidebarRows";
import type { SidebarDeviceBadge } from "../DeviceBadgeView";

// Somewhere a worktree can be created: this machine's project, or a
// peer's, carrying what its create runs through.
export interface CreateTarget<Api> {
  key: string;
  project: Project;
  // Absent for a local project.
  peer: { api: Api; badge: SidebarDeviceBadge } | undefined;
}

// Where the inbox's New worktree can create: this machine's projects
// that are still on disk, then those of every peer `apiOf` answers
// for. A peer that is asleep or has not granted this device control is
// left out, since its create would only be refused.
export function createTargets<Api>(
  projects: readonly Project[],
  remote: readonly RemoteForestItem[],
  apiOf: (deviceId: string) => Api | undefined,
): CreateTarget<Api>[] {
  return [
    ...projects
      .filter((project) => project.pathExists !== false)
      .map((project) => ({ key: project.id, project, peer: undefined })),
    ...remote.flatMap((item) => {
      const api = apiOf(item.deviceId);
      if (api === undefined) return [];
      return [
        {
          key: `${item.deviceId}/${item.project.id}`,
          project: item.project,
          peer: { api, badge: deviceBadgeOf(item) },
        },
      ];
    }),
  ];
}
