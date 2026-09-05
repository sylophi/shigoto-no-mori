// Every registered remote device's forest at once, for the sidebar's
// merged tree -- the only place a peer's forest is read, since remote
// work is meant to look local rather than live on a page of its own.
// One projects query per device and one worktrees query per (device,
// project). Both scope the SHARED local options builders to a peer
// (they derive the key registry from the device id via queryKeysFor,
// and their queryFns call that device's api instead of window.api), so
// a peer's rows land under the same keys the device-scoped worktree
// pages read and the two can never disagree. Devices stay in the list
// whether or not a direct session is up: the options gate fetching on
// the api being present, and a disconnected device serves whatever its
// last session cached -- the same staleness contract every query in the
// app has.
//
// This fan-out is always mounted, so it refetches calmly: the boot
// scoped remote host watch (lib/remote/remoteHostWatch.ts) invalidates
// a peer's rows the moment that peer pings, an open remote worktree
// page keeps its own fresher observers on the same keys, and any
// observer wanting a refetch refreshes this one's rows for free. Focus
// refetch stays on as the belt the local forest has too (a dropped
// push under backpressure would otherwise leave an always-mounted row
// stale for good), gated by the stale window below so a quick alt-tab
// does not re-list every peer.
import { useQueries } from "@tanstack/react-query";
import type { Project, Worktree } from "@shared/schemas";
import type { StatusTone } from "@/components/ui/status-dot";
import { projectsQueryOptions } from "@/hooks/projects/useProjects";
import { deviceStatusView } from "@/lib/remote/deviceStatus";
import type { RemoteDeviceApi } from "@/lib/remote/devices";
import {
  combineFanOut,
  worktreesQueryOptions,
} from "@/hooks/worktrees/useWorktrees";
import { useRemoteDevices } from "./useRemoteDevices";

// A peer's projects, scoped off the shared local builder. The base meta
// is overridden to stay silent because a peer that is merely asleep
// would otherwise toast on every disabled-to-enabled transition. The
// sidebar shows a device's rows as stale instead. Note this swallows a
// genuine listing failure too: such a device contributes zero items and
// simply reads as empty.
function remoteProjectsQueryOptions(
  deviceId: string,
  api: RemoteDeviceApi | undefined,
) {
  return {
    ...projectsQueryOptions({ deviceId, api }),
    meta: { silentError: true },
  };
}

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
  // hub reads as loading, not as "no projects".
  loading: boolean;
}

// Calm by default: the always-mounted sidebar keeps the forests fresh,
// so a page that mounts a second observer must not re-list every peer.
const CALM_REFETCH = { staleTime: 30_000, refetchOnMount: false };

export interface RemoteForestsOptions {
  // True for the sidebar itself, the one observer that keeps the
  // forests fresh: on a shell where it can unmount (the web sheet at
  // phone width) its remount must re-list.
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
      ...worktreesQueryOptions(project.id, {
        deviceId: device.deviceId,
        api: device.api,
      }),
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
