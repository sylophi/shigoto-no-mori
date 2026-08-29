// Every registered remote device's forest at once, for the sidebar's
// merged tree. One projects query per device and one worktrees query
// per (device, project), through the same device-scoped builders the
// forest page uses, so the cache is shared and the sidebar can never
// disagree with the page. Devices stay in the list whether or not a
// direct session is up: the options gate fetching on the api being
// present, and a disconnected device serves whatever its last session
// cached -- the same staleness contract every query in the app has.
import { useQueries } from "@tanstack/react-query";
import type { Project, Worktree } from "@shared/schemas";
import {
  remoteProjectsQueryOptions,
  remoteWorktreesQueryOptions,
} from "./useRemoteForest";
import { useRemoteDevices } from "./useRemoteDevices";

export interface RemoteForestEntry {
  deviceId: string;
  deviceLabel: string;
  projects: Project[];
  worktreesByProject: Map<string, Worktree[]>;
}

export function useRemoteForests(): RemoteForestEntry[] {
  const devices = useRemoteDevices();
  const projectQueries = useQueries({
    queries: devices.map((device) =>
      remoteProjectsQueryOptions(device.deviceId, device.api),
    ),
  });
  // Flattened (device, project) pairs, so the worktree fan-out is one
  // flat useQueries whatever shape the forests have.
  const pairs = devices.flatMap((device, index) =>
    (projectQueries[index]?.data ?? []).map((project) => ({
      device,
      project,
    })),
  );
  const worktreeQueries = useQueries({
    queries: pairs.map(({ device, project }) =>
      remoteWorktreesQueryOptions(device.deviceId, device.api, project.id),
    ),
  });
  return devices.map((device, index) => {
    const worktreesByProject = new Map<string, Worktree[]>();
    pairs.forEach((pair, pairIndex) => {
      if (pair.device.deviceId !== device.deviceId) return;
      worktreesByProject.set(
        pair.project.id,
        worktreeQueries[pairIndex]?.data ?? [],
      );
    });
    return {
      deviceId: device.deviceId,
      deviceLabel: device.label,
      projects: projectQueries[index]?.data ?? [],
      worktreesByProject,
    };
  });
}
