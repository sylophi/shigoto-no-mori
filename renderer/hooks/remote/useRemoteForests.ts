// Every registered remote device's forest at once, for the sidebar's
// merged tree. One projects query per device and one worktrees query
// per (device, project), through the same device-scoped builders the
// forest page uses, so the cache is shared and the sidebar can never
// disagree with the page. Devices stay in the list whether or not a
// direct session is up: the options gate fetching on the api being
// present, and a disconnected device serves whatever its last session
// cached -- the same staleness contract every query in the app has.
//
// This fan-out is always mounted, so it refetches calmly: the forest
// page keeps its own fresher observers on the same keys (plus the
// useWatchRemoteHost push channel while it is open), and any observer
// wanting a refetch refreshes this one's rows for free.
import { useQueries } from "@tanstack/react-query";
import type { Project, Worktree } from "@shared/schemas";
import type { StatusTone } from "@/components/ui/status-dot";
import { deviceStatusView } from "@/lib/remote/deviceStatus";
import { combineFanOut } from "@/hooks/worktrees/useWorktrees";
import {
  remoteProjectsQueryOptions,
  remoteWorktreesQueryOptions,
} from "./useRemoteForest";
import { useRemoteDevices } from "./useRemoteDevices";

// One remote project's slice, flat because that is exactly the unit
// the row builder merges by repo identity.
export interface RemoteForestItem {
  deviceId: string;
  deviceLabel: string;
  // False when the device is not currently reachable: its rows are the
  // cache's last known state, and the tree fades them rather than
  // hiding work that still exists on that machine.
  reachable: boolean;
  // The device's connection tone, so a badge for it reads the same as
  // its chip on the devices page.
  tone: StatusTone;
  project: Project;
  worktrees: Worktree[];
  // A failed worktree listing, folded into the sidebar's coalesced
  // fan-out toast beside the local failures.
  worktreesError: boolean;
}

export interface RemoteForests {
  items: RemoteForestItem[];
  // True while any remote listing is actually fetching (isLoading, not
  // isPending: a disconnected device's disabled queries stay pending
  // forever). The web sidebar's empty state hangs on this so a slow
  // relay reads as loading, not as "no projects".
  loading: boolean;
}

const CALM_REFETCH = { staleTime: 30_000, refetchOnWindowFocus: false };

export interface RemoteForestsOptions {
  // False for a consumer whose copy is decorative (the new-worktree
  // device picker): mounting a fresh observer on a stale key would
  // otherwise kick a full re-listing of every peer's forest on page
  // open, for data the always-mounted sidebar keeps fresh anyway.
  refetchOnMount?: boolean;
}

export function useRemoteForests(
  options: RemoteForestsOptions = {},
): RemoteForests {
  const refetch = { ...CALM_REFETCH, ...options };
  const devices = useRemoteDevices();
  const projectQueries = useQueries({
    queries: devices.map((device) => ({
      ...remoteProjectsQueryOptions(device.deviceId, device.api),
      ...refetch,
    })),
    combine: combineFanOut,
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
    queries: pairs.map(({ device, project }) => ({
      ...remoteWorktreesQueryOptions(device.deviceId, device.api, project.id),
      ...refetch,
    })),
    combine: combineFanOut,
  });
  return {
    items: pairs.map(({ device, project }, index) => {
      const status = deviceStatusView(device.status);
      return {
        deviceId: device.deviceId,
        deviceLabel: device.label,
        reachable: status.reachable,
        tone: status.tone,
        project,
        worktrees: worktreeQueries[index]?.data ?? [],
        worktreesError: worktreeQueries[index]?.error != null,
      };
    }),
    loading:
      projectQueries.some((query) => query.isLoading) ||
      worktreeQueries.some((query) => query.isLoading),
  };
}
