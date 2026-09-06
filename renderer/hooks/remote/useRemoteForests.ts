// Every registered remote device's forest at once, for the sidebar's
// merged tree -- the only place a peer's forest is read, since remote
// work is meant to look local rather than live on a page of its own.
// One projects query per device, then one worktrees, one pull-request
// map and one project-config query per (device, project) -- the same
// three reads the local sidebar makes per project, so the inbox can
// file a peer's worktree exactly as it files a local one (its PR tells
// merged from live, its config says whether the primary shows). All
// scope the SHARED local options builders to a peer
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
import type { Project, PullRequest, Worktree } from "@shared/schemas";
import type { StatusTone } from "@/components/ui/status-dot";
import { shigomoriConfigQueryOptions } from "@/hooks/config/useShigomoriConfig";
import { projectPullRequestsQueryOptions } from "@/hooks/projects/useProjectPullRequests";
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
  // Branch -> PR on that device, what its own sidebar reads for the
  // pills and the inbox's merged shelf. Empty until it lands.
  pullRequests: Record<string, PullRequest>;
  // That project's inbox opt-in for its primary checkout
  // (ShigomoriConfigSchema.showPrimaryInInbox), read off the peer so a
  // project shows its root the same way in every sidebar.
  showPrimaryInInbox: boolean;
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
  // forests fresh: on a shell where it can unmount (the phone layout's
  // forest page) its remount must re-list.
  refetchOnMount?: boolean;
  // True while the inbox shows: its per-project config read
  // (showPrimaryInInbox) is the one fact the tree never needs, so it
  // is asked for only then rather than on every device and project at
  // boot.
  inboxFacts?: boolean;
}

export function useRemoteForests(
  options: RemoteForestsOptions = {},
): RemoteForests {
  const { inboxFacts = false, ...overrides } = options;
  const refetch = { ...CALM_REFETCH, ...overrides };
  const devices = useRemoteDevices();
  const projectQueries = useQueries({
    queries: devices.map((device) => ({
      ...remoteProjectsQueryOptions(device.deviceId, device.api),
      ...refetch,
    })),
    combine: combineFanOut,
  });
  // Flattened (device, project) pairs, so the worktree fan-out is one
  // flat useQueries whatever shape the forests have. A checkout the
  // peer reports missing is left out, the same gate the local fan-outs
  // apply: every read on it would only throw.
  const pairs = devices.flatMap((device, index) =>
    (projectQueries[index]?.data ?? [])
      .filter((project) => project.pathExists !== false)
      .map((project) => ({ device, project })),
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
  // Both served from the peer's own caches (the PR sweep's map, the
  // project.json read), so neither costs it a git or gh call. Neither
  // refetches on its own: the PR map refreshes off the peer's
  // projectPullRequestsRefreshed push (remoteHostWatch), the way the
  // local map does off the local wire, and the config only ever changes
  // through a Configure save, which invalidates it.
  const pullRequestQueries = useQueries({
    queries: pairs.map(({ device, project }) => ({
      ...projectPullRequestsQueryOptions(project.id, {
        deviceId: device.deviceId,
        api: device.api,
      }),
      meta: { silentError: true },
    })),
    combine: combineFanOut,
  });
  const configQueries = useQueries({
    queries: pairs.map(({ device, project }) => ({
      ...shigomoriConfigQueryOptions(project.id, {
        deviceId: device.deviceId,
        api: device.api,
      }),
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      meta: { silentError: true },
      ...(inboxFacts ? {} : { enabled: false }),
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
        pullRequests: pullRequestQueries[index]?.data ?? {},
        showPrimaryInInbox:
          configQueries[index]?.data?.showPrimaryInInbox === true,
        worktreesError: worktreeQueries[index]?.error != null,
      };
    }),
    loading:
      projectQueries.some((query) => query.isLoading) ||
      worktreeQueries.some((query) => query.isLoading),
  };
}
