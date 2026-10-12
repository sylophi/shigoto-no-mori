// Every registered remote device's forest at once, for the sidebar's
// merged tree -- the only place a peer's forest is read, since remote
// work is meant to look local rather than live on a page of its own.
// Each peer's projects and each (device, project)'s worktrees are the
// host views the device-scoped pages read (useProjects, useWorktrees),
// streamed over the hub hop, so the two can never disagree; its pull
// request map and project config are requests, a query per (device,
// project), so the inbox can file a peer's worktree exactly as it files
// a local one (its PR tells merged from live, its config says whether
// the primary shows). A device stays in the list whether or not a
// direct session is up: its views are asked again until one is, and
// meanwhile read what they last had.
import type { RemoteForestItem } from "@shigomori/ui/lib/forest.ts";
import { useQueries } from "@tanstack/react-query";
import type { Project } from "@shigomori/contracts/schemas";
import { shigomoriConfigQueryOptions } from "@/hooks/config/useShigomoriConfig";
import { showPrimaryInInbox } from "@shigomori/ui/lib/showPrimaryInInbox.ts";
import { projectPullRequestsQueryOptions } from "@/hooks/projects/useProjectPullRequests";
import { projectsAtom } from "@/hooks/projects/useProjects";
import { deviceStatusView } from "@shigomori/ui/lib/deviceStatus.ts";
import type { RemoteDevice } from "@/lib/remote/devices";
import { combineFanOut } from "@/hooks/remote/hostForestScope";
import {
  someWorktreesAtom,
  worktreeListKey,
} from "@/hooks/worktrees/useWorktrees";
import { peerSessionAtom } from "@/lib/runtime/atoms";
import { useRegistry, useViews, viewsOf } from "@/lib/runtime/viewHooks";
import { useRemoteDevices } from "./useRemoteDevices";

// The peers' projects, each as its host streams it. A peer that has had
// a session on this page keeps its views while it has none, so its rows
// stay as the sidebar last had them (faded, as unreachable) while its
// views redial; one that never had one reads nothing.
const peersProjectsAtom = viewsOf((deviceId) => projectsAtom(deviceId));

// Whether a peer's views are read: while it can be asked, and after
// that for as long as the page lives once it had a session.
export function useViewsWanted(): (device: {
  readonly deviceId: string;
  readonly api?: unknown;
}) => boolean {
  const registry = useRegistry();
  return (device) =>
    device.api !== undefined ||
    registry.get(peerSessionAtom(device.deviceId)) > 0;
}

export interface RemoteForests {
  items: RemoteForestItem[];
  // True while any remote listing is actually fetching (isLoading, not
  // isPending: a disconnected device's disabled queries stay pending
  // forever). The web sidebar's empty state hangs on this so a slow
  // hub reads as loading, not as "no projects".
  loading: boolean;
  // The peers whose projects could not be read, by name.
  devicesFailed: readonly string[];
}

export interface RemoteForestsOptions {
  // True while the inbox shows: its per-project config read
  // (showPrimaryInInbox) is the one fact the tree never needs, so it
  // is asked for only then rather than on every device and project at
  // boot.
  inboxFacts?: boolean;
}

export interface RemoteProjectPair {
  device: RemoteDevice;
  project: Project;
}

// The projects half alone: every peer's registered projects as
// flattened (device, project) pairs, for the callers that only match a
// repo per device (the device targets behind the tab bars and the
// "Create on" pick) and have no use for the worktree, PR and config
// fan-outs the forests add on top. The forests compose this, so the
// two can never list different projects.
export function useRemoteProjects(): {
  pairs: RemoteProjectPair[];
  loading: boolean;
  // Peers whose projects could not be read, after the retries.
  failed: readonly string[];
} {
  const wanted = useViewsWanted();
  // A peer that isn't sharing lists nothing.
  const devices = useRemoteDevices().filter(
    (device) => device.status.phase !== "notSharing",
  );
  const projectViews = useViews(
    peersProjectsAtom,
    devices.map((device) => (wanted(device) ? device.deviceId : null)),
  );
  // A checkout the peer reports missing is left out, the same gate the
  // local fan-outs apply: every read on it would only throw.
  return {
    pairs: devices.flatMap((device, index) =>
      (projectViews[index]?.data ?? [])
        .filter((project) => project.pathExists !== false)
        .map((project) => ({ device, project })),
    ),
    loading: projectViews.some((view) => view.isLoading),
    failed: devices
      .filter((_, index) => projectViews[index]?.error != null)
      .map((device) => device.label),
  };
}

export function useRemoteForests(
  options: RemoteForestsOptions = {},
): RemoteForests {
  const { inboxFacts = false } = options;
  // Flattened (device, project) pairs, so the worktree fan-out is one
  // flat read whatever shape the forests have.
  const wanted = useViewsWanted();
  const { pairs, loading: projectsLoading, failed } = useRemoteProjects();
  const worktreeQueries = useViews(
    someWorktreesAtom,
    pairs.map(({ device, project }) =>
      wanted(device) ? worktreeListKey(device.deviceId, project.id) : null,
    ),
  );
  // Both served from the peer's own caches (the PR sweep's map, the
  // project.json read), so neither costs it a git or gh call. Neither
  // refetches on its own: the PR map refreshes off the peer's
  // projectPullRequestsRefreshed push (lib/hostWatch.ts), the way the
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
        deviceIcon: device.icon,
        reachable: status.reachable,
        tone: status.tone,
        project,
        worktrees: worktreeQueries[index]?.data ?? [],
        pullRequests: pullRequestQueries[index]?.data ?? {},
        showPrimaryInInbox: showPrimaryInInbox(configQueries[index]?.data),
        worktreesError: worktreeQueries[index]?.error != null,
      };
    }),
    loading:
      projectsLoading || worktreeQueries.some((query) => query.isLoading),
    devicesFailed: failed,
  };
}
