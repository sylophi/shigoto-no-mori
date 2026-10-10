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
import type { DeviceIcon } from "@shigomori/contracts/deviceIcon";
import { useQueries } from "@tanstack/react-query";
import type {
  Project,
  PullRequest,
  Worktree,
} from "@shigomori/contracts/schemas";
import type { StatusTone } from "@shigomori/ui/primitives/status-dot.tsx";
import { shigomoriConfigQueryOptions } from "@/hooks/config/useShigomoriConfig";
import { showPrimaryInInbox } from "@/lib/showPrimaryInInbox";
import { projectPullRequestsQueryOptions } from "@/hooks/projects/useProjectPullRequests";
import { projectsAtom } from "@/hooks/projects/useProjects";
import { deviceStatusView } from "@shigomori/ui/lib/deviceStatus.ts";
import type { RemoteDevice } from "@/lib/remote/devices";
import { combineFanOut } from "@/hooks/remote/hostForestScope";
import {
  someWorktreesAtom,
  worktreeListKey,
} from "@/hooks/worktrees/useWorktrees";
import { useViews, viewsOf } from "@/lib/runtime/viewHooks";
import { useRemoteDevices } from "./useRemoteDevices";

// The peers' projects, each as its host streams it: a peer with no
// session reads nothing, and its rows stay as the sidebar last had them.
const peersProjectsAtom = viewsOf((deviceId) => projectsAtom(deviceId));

// One remote project's slice, flat because that is exactly the unit
// the row builder merges by repo identity.
export interface RemoteForestItem {
  deviceId: string;
  deviceLabel: string;
  // What the device looks like, for its badge on the rows.
  deviceIcon: DeviceIcon;
  // False when the device is not currently reachable: its rows are the
  // cache's last known state, and the tree fades them rather than
  // hiding work that still exists on that machine.
  reachable: boolean;
  // The device's connection tone, so a badge for it reads the same as
  // its chip on the account page.
  tone: StatusTone;
  project: Project;
  worktrees: readonly Worktree[];
  // Branch -> PR on that device, what its own sidebar reads for the
  // pills and the inbox's merged shelf. Empty until it lands.
  pullRequests: Record<string, PullRequest>;
  // That project's inbox opt-in for its primary checkout
  // (ShigomoriConfigSchema.showPrimaryInInbox), read off the peer so a
  // project shows its root the same way in every sidebar. Undefined
  // until the config is read, which is only while the inbox shows.
  showPrimaryInInbox: boolean | undefined;
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
} {
  // A peer that isn't sharing lists nothing.
  const devices = useRemoteDevices().filter(
    (device) => device.status.phase !== "notSharing",
  );
  const projectViews = useViews(
    peersProjectsAtom,
    devices.map((device) =>
      device.api === undefined ? null : device.deviceId,
    ),
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
  };
}

export function useRemoteForests(
  options: RemoteForestsOptions = {},
): RemoteForests {
  const { inboxFacts = false } = options;
  // Flattened (device, project) pairs, so the worktree fan-out is one
  // flat read whatever shape the forests have.
  const { pairs, loading: projectsLoading } = useRemoteProjects();
  const worktreeQueries = useViews(
    someWorktreesAtom,
    pairs.map(({ device, project }) =>
      device.api === undefined
        ? null
        : worktreeListKey(device.deviceId, project.id),
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
  };
}
